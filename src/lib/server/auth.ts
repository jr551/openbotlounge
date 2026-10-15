import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config';

/**
 * The session cookie's name. Exported because the websocket relay has to read
 * it off a raw upgrade request, where there is no cookie jar to ask.
 */
export const SESSION_COOKIE = 'obl_session';
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

// Per-boot random secret when SESSION_SECRET is unset: sessions invalidate on restart.
const secret = config.sessionSecret || randomBytes(32).toString('hex');

function sign(value: string): string {
	return createHmac('sha256', secret).update(value).digest('hex');
}

export function authEnabled(): boolean {
	return config.password.length > 0;
}

export function checkPassword(candidate: string): boolean {
	const a = Buffer.from(candidate);
	const b = Buffer.from(config.password);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookie(secure = false): {
	name: string;
	value: string;
	options: Record<string, unknown>;
} {
	const ts = Date.now().toString();
	return {
		name: SESSION_COOKIE,
		value: `${ts}.${sign(ts)}`,
		options: {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			// Only mark it secure when the request actually arrived over TLS.
			// The default install is plain HTTP on a LAN, where a secure cookie
			// would never be sent back and signing in would be impossible.
			secure,
			maxAge: MAX_AGE_S
		}
	};
}

export function validSession(value: string | undefined): boolean {
	if (!authEnabled()) return true;
	if (!value) return false;
	const dot = value.lastIndexOf('.');
	if (dot === -1) return false;
	const ts = value.slice(0, dot);
	const sig = value.slice(dot + 1);
	const expected = sign(ts);
	if (sig.length !== expected.length) return false;
	if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
	const age = Date.now() - Number(ts);
	return Number.isFinite(age) && age >= 0 && age < MAX_AGE_S * 1000;
}

/** The cookie to send when clearing a session: same attributes, empty and expired. */
export function clearedSessionCookie(secure = false): {
	name: string;
	value: string;
	options: Record<string, unknown>;
} {
	return {
		name: SESSION_COOKIE,
		value: '',
		options: { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 0 }
	};
}
