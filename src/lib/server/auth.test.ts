import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from './config';

// auth.ts derives its signing secret at import time; pin it before importing
// so tests can forge correctly-signed cookies with arbitrary timestamps.
const orig = { password: config.password, sessionSecret: config.sessionSecret };
config.sessionSecret = 'test-secret';
const auth = await import('./auth');

const PASSWORD = 's3cret-pw';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A correctly-signed cookie value for an arbitrary timestamp. */
function forge(ts: string): string {
	const sig = createHmac('sha256', 'test-secret').update(ts).digest('hex');
	return `${ts}.${sig}`;
}

afterAll(() => {
	Object.assign(config, orig);
});

describe('gate disabled', () => {
	it('treats every request as authenticated when no password is configured', () => {
		config.password = '';
		expect(auth.authEnabled()).toBe(false);
		// If the gate stayed on, every request would bounce to the login page.
		expect(auth.validSession(undefined)).toBe(true);
	});
});

describe('gate enabled', () => {
	it('rejects requests with no session cookie', () => {
		config.password = PASSWORD;
		expect(auth.authEnabled()).toBe(true);
		expect(auth.validSession(undefined)).toBe(false);
		expect(auth.validSession('')).toBe(false);
	});

	it('accepts the cookie it issues', () => {
		config.password = PASSWORD;
		const cookie = auth.sessionCookie();
		expect(auth.validSession(cookie.value)).toBe(true);
	});

	it('rejects a cookie whose signature was tampered with', () => {
		config.password = PASSWORD;
		const { value } = auth.sessionCookie();
		const tampered = value.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
		expect(auth.validSession(tampered)).toBe(false);
		// A cookie with no signature separator at all must not parse.
		expect(auth.validSession('not-a-cookie')).toBe(false);
	});

	it('rejects correctly-signed cookies with malformed or out-of-window timestamps', () => {
		config.password = PASSWORD;
		// These are properly signed, so only the timestamp check can reject them.
		expect(auth.validSession(forge('not-a-timestamp'))).toBe(false);
		expect(auth.validSession(forge(String(Date.now() - 31 * DAY_MS)))).toBe(false);
		expect(auth.validSession(forge(String(Date.now() + DAY_MS)))).toBe(false);
	});

	it('issues an httpOnly cookie whose value does not contain the password', () => {
		config.password = PASSWORD;
		const cookie = auth.sessionCookie();
		expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax' });
		expect(cookie.options.maxAge).toBeGreaterThan(0);
		expect(cookie.value).not.toContain(PASSWORD);
	});

	it('checkPassword accepts the exact password and rejects others without throwing', () => {
		config.password = PASSWORD;
		expect(auth.checkPassword(PASSWORD)).toBe(true);
		expect(auth.checkPassword('s3cret-pX')).toBe(false);
		// timingSafeEqual throws on a length mismatch; a missing length guard
		// would turn a wrong password into a 500.
		expect(auth.checkPassword('x')).toBe(false);
		expect(auth.checkPassword(PASSWORD + '-longer')).toBe(false);
	});

	it('clearedSessionCookie expires the session cookie', () => {
		const cleared = auth.clearedSessionCookie();
		expect(cleared.name).toBe(auth.sessionCookie().name);
		expect(cleared.value).toBe('');
		expect(cleared.options.maxAge).toBe(0);
	});
});

describe('cookie security', () => {
	it('marks the session cookie secure only over TLS', async () => {
		expect((auth.sessionCookie(true).options as { secure: boolean }).secure).toBe(true);
		expect((auth.sessionCookie(false).options as { secure: boolean }).secure).toBe(false);
		// The default install is plain HTTP, so an unconditional secure flag
		// would make signing in impossible.
		expect((auth.sessionCookie().options as { secure: boolean }).secure).toBe(false);
	});

	it('clears with the same attributes it set, so a TLS session really ends', async () => {
		expect((auth.clearedSessionCookie(true).options as { secure: boolean }).secure).toBe(true);
		expect((auth.clearedSessionCookie().options as { secure: boolean }).secure).toBe(false);
	});
});
