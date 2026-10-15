import { error } from '@sveltejs/kit';

/**
 * Parse a JSON request body. `request.json()` throws on a missing or malformed
 * body, which SvelteKit surfaces as an opaque 500 - every API route should
 * reject that input with a 400 instead.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON body');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw error(400, 'JSON body must be an object');
	}
	return body as Record<string, unknown>;
}

/**
 * Read an optional string field, rejecting non-string values rather than
 * coercing them (`String({})` would silently store "[object Object]").
 * Over-long input is rejected too: cutting the tail off silently loses whatever
 * the caller sent - the end of a message, the middle of a base64 image - while
 * answering success for data that was never stored.
 */
export function strField(body: Record<string, unknown>, key: string, max: number): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw error(400, `${key} must be a string`);
	// Control characters other than the whitespace a message legitimately
	// carries break downstream consumers: a NUL in a command string makes
	// Node's spawn throw, and C1s render as nothing while still being there.
	if (/[\0-\b\v\f\x0e-\x1f\x7f-\x9f]/.test(value)) {
		throw error(400, `${key} contains control characters`);
	}
	if ([...value].length > max) throw error(400, `${key} must be ${max} characters or fewer`);
	return value;
}

/**
 * Read an optional finite number field. Only a real number is accepted:
 * coercing would turn `true` into 1 and `"5"` into 5, storing something the
 * caller never asked for while answering success.
 */
export function numField(body: Record<string, unknown>, key: string): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw error(400, `${key} must be a number`);
	}
	return value;
}

/**
 * Read an optional endpoint field. Only a scheme a provider call can actually
 * reach is accepted - `new URL` would happily take `file:` or `ftp:` - and the
 * trailing slashes come off, since the path is appended to it.
 */
export function baseUrlField(
	body: Record<string, unknown>,
	key: string,
	max: number
): string | undefined {
	const raw = strField(body, key, max);
	if (raw === undefined) return undefined;
	const value = raw.trim().replace(/\/+$/, '');
	let parsed: URL | undefined;
	try {
		parsed = new URL(value);
	} catch {
		parsed = undefined;
	}
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		throw error(400, `${key} must be an http(s) URL`);
	}
	return value;
}

/** Read an optional boolean field, accepting only real booleans. */
export function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'boolean') throw error(400, `${key} must be a boolean`);
	return value;
}

/**
 * Whether a request carries an Origin naming a different host than ours.
 *
 * SvelteKit's built-in CSRF check cannot be used on this app: adapter-node
 * assumes a request is https unless ORIGIN or PROTOCOL_HEADER is set, so on a
 * plain-HTTP LAN install it compares the browser's `http://` Origin against an
 * `https://` one and refuses every form POST, the login included.
 *
 * The host is what actually tells another site apart from this one, and the
 * browser sets it from the URL it is posting to - a page on evil.example sends
 * `Origin: http://evil.example` no matter what it aims at. An absent Origin
 * means a non-browser caller (a webhook, curl, another service) and is allowed.
 */
export function isCrossOrigin(origin: string | null | undefined, host: string): boolean {
	if (!origin) return false;
	// Sandboxed iframes and some redirect chains send the literal string "null".
	if (origin === 'null' || !host) return true;
	try {
		return new URL(origin).host !== host;
	} catch {
		return true;
	}
}

/**
 * Whether the request really arrived over TLS.
 *
 * `event.url.protocol` cannot answer this: adapter-node assumes https unless
 * ORIGIN or PROTOCOL_HEADER is set, so on a plain-HTTP install it reports
 * `https:` for a request that came in over http, and a Secure cookie would then
 * never be sent back - the login would silently never take.
 *
 * So ask for positive evidence instead: a proxy's x-forwarded-proto, or the
 * scheme the browser itself used in Origin. Absent both, assume plain http,
 * which is what a direct LAN install is.
 */
export function requestIsSecure(request: Request): boolean {
	const forwarded = request.headers.get('x-forwarded-proto');
	if (forwarded) return forwarded.split(',')[0].trim().toLowerCase() === 'https';
	return (request.headers.get('origin') ?? '').startsWith('https://');
}
