import { createHash, randomBytes } from 'node:crypto';
import { classifyNetworkError } from './provider-connect';

/**
 * OpenRouter's own sign-in, as it documents it:
 * https://openrouter.ai/docs/guides/overview/auth/oauth
 *
 * It is a plain PKCE code flow with no client registration and no client
 * secret, which is why it is the one provider in the catalogue this app can
 * sign into on the user's behalf. The code_verifier never leaves the server:
 * it is kept in the HttpOnly cookie set when the flow starts and read back when
 * OpenRouter redirects to the callback.
 */
const AUTHORIZE_ENDPOINT = 'https://openrouter.ai/auth';
const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/auth/keys';

const EXCHANGE_TIMEOUT_MS = 20_000;

/** Cookie carrying one in-flight flow; short-lived, HttpOnly, path-scoped. */
export const FLOW_COOKIE = 'obl_oauth_flow';
export const FLOW_COOKIE_PATH = '/api/providers/oauth';

interface OAuthFlow {
	verifier: string;
	/** The model the provider config will be saved with. */
	model: string;
}

interface ExchangeResult {
	key: string;
	error: string;
}

/** The flow as a cookie value: base64url JSON, so quoting and escaping are moot. */
export function encodeFlow(flow: OAuthFlow): string {
	return Buffer.from(JSON.stringify(flow)).toString('base64url');
}

export function decodeFlow(value: string): OAuthFlow | null {
	let parsed: Partial<OAuthFlow>;
	try {
		parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<OAuthFlow>;
	} catch {
		return null;
	}
	if (typeof parsed?.verifier !== 'string' || !parsed.verifier) return null;
	return {
		verifier: parsed.verifier,
		model: typeof parsed.model === 'string' ? parsed.model : ''
	};
}

/**
 * A fresh flow: a 32-byte verifier (base64url, inside RFC 7636's 43–128
 * characters) and the URL the browser is sent to. The challenge is its
 * base64url SHA-256, so only whoever holds the verifier can redeem the code.
 */
export function beginFlow(opts: { callbackUrl: string; model: string }): {
	authorizeUrl: string;
	flow: OAuthFlow;
} {
	const verifier = randomBytes(32).toString('base64url');
	const query = new URLSearchParams({
		callback_url: opts.callbackUrl,
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256'
	});
	return {
		authorizeUrl: `${AUTHORIZE_ENDPOINT}?${query}`,
		flow: { verifier, model: opts.model }
	};
}

/**
 * Swap the one-time code for the key OpenRouter issues this user. The verifier
 * is the only proof required, so there is no secret embedded in the app and
 * nothing for the frontend to hold. `fetchImpl` is a seam for tests.
 */
export async function exchangeCode(
	code: string,
	verifier: string,
	fetchImpl: typeof fetch = fetch
): Promise<ExchangeResult> {
	try {
		const res = await fetchImpl(KEY_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
			signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
		});
		const body = (await res.json().catch(() => null)) as { key?: unknown; error?: unknown } | null;
		const key = typeof body?.key === 'string' ? body.key.trim() : '';
		if (key) return { key, error: '' };
		const said = typeof body?.error === 'string' ? body.error : '';
		return {
			key: '',
			error: `OpenRouter did not issue a key (HTTP ${res.status})${said ? `: ${said}` : '.'}`
		};
	} catch (err) {
		return { key: '', error: classifyNetworkError(err, 'openrouter.ai') };
	}
}

/* ------------------------------------------------------------------ *
 * OpenAI sign-in ("Sign in with ChatGPT"), the same flow the Codex CLI
 * and opencode implement against auth.openai.com.
 *
 * The browser-authorize variant of this flow redirects to a localhost
 * listener on a fixed port, which a server-side app cannot offer, so
 * this uses the device-code variant instead: the app asks for a user
 * code, the human types it at auth.openai.com/codex/device, and the app
 * polls until OpenAI hands back an authorization code plus the PKCE
 * pair to redeem it.
 *
 * The client id below is the public first-party one Codex and opencode
 * embed; OpenAI issues no per-app registration for this flow. The
 * tokens it returns are scoped to the ChatGPT Codex backend
 * (chatgpt.com/backend-api/codex), not api.openai.com - llm.ts routes
 * calls for this sign-in accordingly.
 * ------------------------------------------------------------------ */

const OPENAI_ISSUER = 'https://auth.openai.com';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Where the human types the code; also the redirect_uri the code is bound to. */
const OPENAI_DEVICE_URL = `${OPENAI_ISSUER}/codex/device`;
const OPENAI_DEVICE_CALLBACK = `${OPENAI_ISSUER}/deviceauth/callback`;

/** How long one device flow may sit unanswered before status reports it dead. */
const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;

export interface DeviceFlow {
	id: string;
	deviceAuthId: string;
	userCode: string;
	verificationUrl: string;
	/** Seconds OpenAI asked us to wait between polls. */
	interval: number;
	/** The model the provider config will be saved with. */
	model: string;
	createdAt: number;
}

/** Flows in flight, keyed by the id handed to the page. In-memory is enough:
 * a restart simply asks the user to start again, and nothing secret is lost. */
const deviceFlows = new Map<string, DeviceFlow>();

/** Forget flows that can no longer complete, so the map cannot grow forever. */
function sweepDeviceFlows(): void {
	const now = Date.now();
	for (const [id, flow] of deviceFlows) {
		if (now - flow.createdAt > DEVICE_FLOW_TTL_MS) deviceFlows.delete(id);
	}
}

export function getDeviceFlow(id: string): DeviceFlow | undefined {
	const flow = deviceFlows.get(id);
	if (flow && Date.now() - flow.createdAt > DEVICE_FLOW_TTL_MS) {
		deviceFlows.delete(id);
		return undefined;
	}
	return flow;
}

export function dropDeviceFlow(id: string): void {
	deviceFlows.delete(id);
}

/**
 * Ask OpenAI for a user code. The answer the page needs is the code itself and
 * the URL to type it at; the poll handle stays server-side in the flow.
 */
export async function beginDeviceFlow(opts: {
	model: string;
	fetchImpl?: typeof fetch;
}): Promise<{ flow?: DeviceFlow; error: string }> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	sweepDeviceFlows();
	try {
		const res = await fetchImpl(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
			signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
		});
		const body = (await res.json().catch(() => null)) as {
			device_auth_id?: unknown;
			user_code?: unknown;
			usercode?: unknown;
			interval?: unknown;
		} | null;
		const deviceAuthId = typeof body?.device_auth_id === 'string' ? body.device_auth_id : '';
		const userCode =
			typeof body?.user_code === 'string'
				? body.user_code
				: typeof body?.usercode === 'string'
					? body.usercode
					: '';
		if (!res.ok || !deviceAuthId || !userCode) {
			return {
				error: `OpenAI did not issue a device code (HTTP ${res.status}). ` +
					'Device sign-in may be unavailable; an API key still works.'
			};
		}
		const interval = Number(body?.interval);
		const flow: DeviceFlow = {
			id: randomBytes(16).toString('base64url'),
			deviceAuthId,
			userCode,
			verificationUrl: OPENAI_DEVICE_URL,
			interval: Number.isFinite(interval) && interval >= 1 ? interval : 5,
			model: opts.model,
			createdAt: Date.now()
		};
		deviceFlows.set(flow.id, flow);
		return { flow, error: '' };
	} catch (err) {
		return { error: classifyNetworkError(err, 'auth.openai.com') };
	}
}

export interface DevicePollResult {
	/** 'pending' keeps the page polling; the other two end the flow. */
	status: 'pending' | 'connected' | 'failed';
	/** Set on 'connected': the tokens and account the provider config is stored with. */
	tokens?: {
		accessToken: string;
		refreshToken: string;
		accountId: string;
		expiresAt: number;
	};
	error?: string;
}

/** The account id is a JWT claim, not a separate API call. */
function accountIdFromJwt(token: string): string {
	const parts = token.split('.');
	if (parts.length !== 3) return '';
	try {
		const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
			chatgpt_account_id?: unknown;
			'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown };
			organizations?: { id?: unknown }[];
		};
		const direct = claims.chatgpt_account_id;
		if (typeof direct === 'string' && direct) return direct;
		const nested = claims['https://api.openai.com/auth']?.chatgpt_account_id;
		if (typeof nested === 'string' && nested) return nested;
		const org = claims.organizations?.[0]?.id;
		return typeof org === 'string' ? org : '';
	} catch {
		return '';
	}
}

/**
 * One poll of the device-token endpoint. OpenAI answers 403/404 until the
 * human has typed the code, then 200 with an authorization code and the PKCE
 * pair to exchange it with - the verifier comes from OpenAI, not from us.
 */
export async function pollDeviceFlow(
	flow: DeviceFlow,
	fetchImpl: typeof fetch = fetch
): Promise<DevicePollResult> {
	try {
		const res = await fetchImpl(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }),
			signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
		});
		if (res.status === 403 || res.status === 404) return { status: 'pending' };
		if (!res.ok) {
			return { status: 'failed', error: `OpenAI refused the device code (HTTP ${res.status}).` };
		}
		const body = (await res.json().catch(() => null)) as {
			authorization_code?: unknown;
			code_verifier?: unknown;
		} | null;
		const code = typeof body?.authorization_code === 'string' ? body.authorization_code : '';
		const verifier = typeof body?.code_verifier === 'string' ? body.code_verifier : '';
		if (!code || !verifier) {
			return { status: 'failed', error: 'OpenAI answered without a code to redeem.' };
		}
		return exchangeDeviceCode(code, verifier, fetchImpl);
	} catch (err) {
		return { status: 'failed', error: classifyNetworkError(err, 'auth.openai.com') };
	}
}

/** Swap the device-issued authorization code for the token set. */
async function exchangeDeviceCode(
	code: string,
	verifier: string,
	fetchImpl: typeof fetch
): Promise<DevicePollResult> {
	const res = await fetchImpl(`${OPENAI_ISSUER}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: OPENAI_DEVICE_CALLBACK,
			client_id: OPENAI_CLIENT_ID,
			code_verifier: verifier
		}).toString(),
		signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
	}).catch(() => null);
	if (!res) return { status: 'failed', error: 'The token exchange could not reach OpenAI.' };
	const body = (await res.json().catch(() => null)) as {
		id_token?: unknown;
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	} | null;
	const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
	const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
	if (!res.ok || !accessToken || !refreshToken) {
		return { status: 'failed', error: `OpenAI did not issue tokens (HTTP ${res.status}).` };
	}
	const idToken = typeof body?.id_token === 'string' ? body.id_token : '';
	const expiresIn = Number(body?.expires_in);
	return {
		status: 'connected',
		tokens: {
			accessToken,
			refreshToken,
			accountId: accountIdFromJwt(idToken) || accountIdFromJwt(accessToken),
			expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000
		}
	};
}

/**
 * Mint a fresh access token from a stored refresh token. OpenAI rotates the
 * refresh token on most refreshes, so callers persist whatever comes back.
 * Returns '' when the session is dead and the user must sign in again.
 */
export async function refreshOpenAiTokens(
	refreshToken: string,
	fetchImpl: typeof fetch = fetch
): Promise<{
	accessToken: string;
	refreshToken: string;
	accountId: string;
	expiresAt: number;
} | null> {
	try {
		const res = await fetchImpl(`${OPENAI_ISSUER}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: OPENAI_CLIENT_ID,
				grant_type: 'refresh_token',
				refresh_token: refreshToken
			}),
			signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
		});
		if (!res.ok) return null;
		const body = (await res.json().catch(() => null)) as {
			id_token?: unknown;
			access_token?: unknown;
			refresh_token?: unknown;
			expires_in?: unknown;
		} | null;
		const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
		if (!accessToken) return null;
		const idToken = typeof body?.id_token === 'string' ? body.id_token : '';
		const expiresIn = Number(body?.expires_in);
		return {
			accessToken,
			refreshToken:
				typeof body?.refresh_token === 'string' && body.refresh_token
					? body.refresh_token
					: refreshToken,
			accountId: accountIdFromJwt(idToken) || accountIdFromJwt(accessToken),
			expiresAt:
				Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000
		};
	} catch {
		return null;
	}
}
