import dns from 'node:dns/promises';
import net from 'node:net';
import { redactCredentials } from './llm';

/**
 * What one "Test connection" press found. `status` is the HTTP status when the
 * provider answered at all, and 0 when the request never got a reply.
 */
interface ProbeResult {
	ok: boolean;
	status: number;
	message: string;
}

/** How long one connection test may take before it is reported as a timeout. */
const PROBE_TIMEOUT_MS = 15_000;

/** A key never reaches the client, not even inside an error it caused. */
function redact(text: string, apiKey: string): string {
	let out = redactCredentials(text);
	if (apiKey.length >= 8) out = out.split(apiKey).join('[redacted]');
	return out.replace(/\s+/g, ' ').trim();
}

/**
 * Walk the error chain Node builds around a failed fetch — undici nests the
 * real errno inside `cause`, and wraps it in an AggregateError when a host
 * resolves to more than one address — to reach the code and message that
 * actually explain the failure.
 */
function fetchFailure(err: unknown): { code: string; detail: string } {
	let code = '';
	let detail = '';
	let node: unknown = err;
	for (let depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
		const current = node as {
			code?: unknown;
			message?: unknown;
			errors?: unknown;
			cause?: unknown;
		};
		if (!code && typeof current.code === 'string') code = current.code;
		if (typeof current.message === 'string' && current.message) detail = current.message;
		const first = Array.isArray(current.errors) ? current.errors[0] : undefined;
		node = first ?? current.cause;
	}
	return { code, detail };
}

const NETWORK_REASONS: Record<string, string> = {
	ENOTFOUND: 'the host name did not resolve (DNS)',
	EAI_AGAIN: 'the DNS lookup timed out',
	ECONNREFUSED: 'the connection was refused — is something listening there?',
	ECONNRESET: 'the connection was reset',
	EHOSTUNREACH: 'the host is unreachable',
	ENETUNREACH: 'the network is unreachable',
	ETIMEDOUT: 'the connection timed out',
	UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
	UND_ERR_HEADERS_TIMEOUT: 'the provider took too long to answer',
	UND_ERR_BODY_TIMEOUT: 'the provider took too long to finish its answer',
	EPROTO: 'the TLS handshake failed',
	CERT_HAS_EXPIRED: 'the TLS certificate has expired',
	DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed',
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate could not be verified'
};

/** A readable reason for a fetch that never got an answer. */
export function classifyNetworkError(err: unknown, host: string, apiKey = ''): string {
	const { code, detail: raw } = fetchFailure(err);
	if (NETWORK_REASONS[code]) return `Could not reach ${host}: ${NETWORK_REASONS[code]}.`;
	const name = (err as { name?: string })?.name ?? '';
	if (name === 'TimeoutError' || name === 'AbortError') {
		return `Could not reach ${host}: the request timed out.`;
	}
	if (/bad port/i.test(raw)) {
		return `Could not reach ${host}: that port is not allowed for HTTP requests.`;
	}
	const detail = redact(raw, apiKey);
	return `Could not reach ${host}${code ? ` (${code})` : ''}${detail ? `: ${detail.slice(0, 160)}` : '.'}`;
}

/** The assistant text out of an OpenAI-style completion, or '' for anything else. */
function completionText(raw: string): string {
	try {
		const content = (JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] })
			?.choices?.[0]?.message?.content;
		return typeof content === 'string' ? content.trim() : '';
	} catch {
		return '';
	}
}

/** Prompt for the one request a connection test makes. */
const PROBE_PROMPT = 'Reply with the single word: ready';

/**
 * Whether an IPv4 address is one a provider could never be: loopback, RFC1918,
 * link-local (the cloud metadata service), CGNAT, multicast, the unspecified
 * and broadcast addresses, and the reserved/documentation ranges. The inverse
 * of egress-proxy.mjs's publicV4, kept in step with it. An address that does
 * not parse is treated as private - refuse rather than guess.
 */
export function isPrivateAddress(ip: string): boolean {
	const s = ip.toLowerCase();
	if (s.includes(':')) return isPrivateV6(s);
	const p = s.split('.').map(Number);
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = p;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local, cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a >= 224) return true; // multicast, reserved, broadcast
	if (a === 192 && b === 0) return true; // IETF assignments
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarks
	if (a === 198 && b === 51) return true; // documentation
	if (a === 203 && b === 0) return true; // documentation
	return false;
}

/** Whether an IPv6 address is private: anything but global unicast. */
function isPrivateV6(ip: string): boolean {
	if (ip === '::' || ip === '::1') return true;
	if (/^fe[89ab]/.test(ip)) return true; // link-local
	if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local
	if (ip.startsWith('ff')) return true; // multicast
	if (ip.startsWith('::ffff:')) {
		// An IPv4-mapped address: URL writes it as two hex groups, but a dotted
		// tail is accepted too. Either way the embedded IPv4 decides.
		const rest = ip.slice(7);
		if (rest.includes('.')) return isPrivateAddress(rest);
		const groups = rest.split(':');
		if (groups.length !== 2) return true;
		const hi = parseInt(groups[0], 16);
		const lo = parseInt(groups[1], 16);
		if (!Number.isFinite(hi) || !Number.isFinite(lo)) return true;
		return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	if (ip.startsWith('2001:db8')) return true; // documentation
	return false;
}

/**
 * Whether a host names a private or link-local destination. A literal address
 * is classified directly; a name is resolved and every answer must be public,
 * so a name that points at loopback or the metadata service is refused too. A
 * name that does not resolve is left to fetch to report as a DNS failure.
 */
export async function isPrivateHost(host: string): Promise<boolean> {
	if (!host) return true;
	if (net.isIP(host)) return isPrivateAddress(host);
	try {
		const answers = await dns.lookup(host, { all: true, verbatim: true });
		return answers.length > 0 && answers.some((a) => isPrivateAddress(a.address));
	} catch {
		return false;
	}
}


/**
 * One small chat request to the endpoint, for the settings "Test connection"
 * button. It answers the question the form cannot: does this base URL, key and
 * model actually work together, and if not, which of the three is wrong. Only
 * the outcome is reported - the endpoint is unauthenticated, so nothing the
 * target says is repeated back, and the key never is either.
 */
export async function probeProvider(opts: {
	baseUrl: string;
	apiKey: string;
	model: string;
	/**
	 * Skip the private-address refusal. Only the human's Test-connection route
	 * sets this, and only from PROVIDER_TEST_ALLOW_PRIVATE; no bot-facing path
	 * may pass it, or the probe becomes an SSRF again.
	 */
	allowPrivate?: boolean;
}): Promise<ProbeResult> {
	const bad = (message: string): ProbeResult => ({ ok: false, status: 0, message });

	let endpoint: URL;
	try {
		endpoint = new URL(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`);
	} catch {
		return bad('That base URL is not a valid http(s) URL.');
	}
	if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
		return bad('The base URL must start with http:// or https://.');
	}
	// The probe runs in this process, so an address that is not a provider the
	// user meant to reach turns the "Test connection" button into a probe of
	// the metadata service, a LAN box, or the app itself. A literal address is
	// classified directly; a name is resolved first, so a DNS name pointing at
	// loopback or link-local is refused too. URL normalizes the odd IPv4 forms
	// (127.1, 2130706433, 0x7f000001) before this runs, so they arrive dotted.
	// A self-hosted install whose provider is a local model server opts out.
	const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!opts.allowPrivate && (await isPrivateHost(host))) {
		return bad(
			'That is a private or link-local address, not a provider endpoint. ' +
				'Set PROVIDER_TEST_ALLOW_PRIVATE=true to test a local model server.'
		);
	}

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers,
			// A redirect is answered, not followed: following would let a public
			// URL bounce the probe past the link-local check above.
			redirect: 'manual',
			body: JSON.stringify({
				model: opts.model,
				messages: [{ role: 'user', content: PROBE_PROMPT }],
				max_tokens: 16,
				stream: false
			}),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
	} catch (err) {
		return { ok: false, status: 0, message: classifyNetworkError(err, endpoint.host, opts.apiKey) };
	}

	// The body is read to spot a completion, never echoed back: an endpoint that
	// is not what the user thought can put anything at all in it.
	const raw = (await res.text().catch(() => '')).slice(0, 2000);

	if (res.ok) {
		if (completionText(raw)) {
			// The reply itself is not repeated: the endpoint is unauthenticated,
			// so anything the target says stays on the server.
			return { ok: true, status: res.status, message: `Reached ${endpoint.host}; ${opts.model} answered with a completion.` };
		}
		return {
			ok: false,
			status: res.status,
			message: `Reached ${endpoint.host}, but the reply was not an OpenAI-style completion. Check that the base URL points at an OpenAI-compatible server.`
		};
	}

	if (res.status === 401 || res.status === 403) {
		return {
			ok: false,
			status: res.status,
			message: `The provider rejected the key (HTTP ${res.status}). Check the API key.`
		};
	}
	if (res.status === 404) {
		return {
			ok: false,
			status: res.status,
			message: `Reached ${endpoint.host}, but ${endpoint.pathname} answered 404 — check the base URL's path.`
		};
	}
	if (res.status === 429) {
		return {
			ok: false,
			status: res.status,
			message: `The provider rate-limited the request (HTTP 429). Try again shortly.`
		};
	}
	return {
		ok: false,
		status: res.status,
		message: `The provider answered HTTP ${res.status}. Check the model name and the base URL, then try again.`
	};
}
