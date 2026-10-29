import { describe, expect, it } from 'vitest';
import { boolField, isCrossOrigin, numField, readJson, requestIsSecure, strField } from './http';
import { config } from './config';

// SvelteKit's error() throws a plain HttpError object (not an Error), so
// toThrow() can't see it - catch it and check the status directly.
async function expect400(fn: () => unknown | Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		expect(e).toMatchObject({ status: 400 });
		return;
	}
	expect.unreachable('expected a 400 error to be thrown');
}

function jsonRequest(body: string): Request {
	return new Request('http://test.local/api', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body
	});
}

describe('readJson', () => {
	it('returns a parsed JSON object', async () => {
		const body = await readJson(jsonRequest('{"name":"x","n":1}'));
		expect(body).toEqual({ name: 'x', n: 1 });
	});

	it('rejects malformed JSON with a 400 instead of an opaque 500', async () => {
		await expect400(() => readJson(jsonRequest('{not json')));
	});

	it('rejects JSON that is not an object: null, string, number, array', async () => {
		// Each shape needs its own guard: a missing null/typeof/Array.isArray
		// check would let the value through to routes that then crash on it.
		for (const raw of ['null', '"hi"', '42', '[1,2]']) {
			await expect400(() => readJson(jsonRequest(raw)));
		}
	});
});

describe('strField', () => {
	it('returns the string value, and undefined for missing or null', () => {
		expect(strField({ k: 'abc' }, 'k', 10)).toBe('abc');
		expect(strField({}, 'k', 10)).toBeUndefined();
		expect(strField({ k: null }, 'k', 10)).toBeUndefined();
	});

	it('rejects non-string values with a 400 instead of coercing them', async () => {
		// Coercion is the bug this guards: String({}) stored "[object Object]"
		// as a bot's name.
		for (const v of [42, { a: 1 }, ['x'], true]) {
			await expect400(() => strField({ k: v }, 'k', 10));
		}
	});

	it('rejects over-long input rather than silently truncating it', async () => {
		// Cutting the tail off stores something the caller never sent - the end
		// of a message, the middle of a base64 image - while answering success.
		await expect400(() => strField({ k: 'ab😀cd' }, 'k', 3));
		// A value at the limit is still fine, and an emoji at the boundary is
		// counted as one character, not two code units.
		expect(strField({ k: 'ab😀' }, 'k', 3)).toBe('ab😀');
	});
});

describe('numField', () => {
	it('returns a finite number, undefined when absent', () => {
		expect(numField({ k: 5 }, 'k')).toBe(5);
		expect(numField({ k: 0 }, 'k')).toBe(0);
		expect(numField({}, 'k')).toBeUndefined();
		expect(numField({ k: null }, 'k')).toBeUndefined();
	});

	it('rejects anything that is not a number rather than coercing it', async () => {
		// `true` used to become 1 and `"5"` used to become 5, storing a value
		// the caller never sent.
		for (const v of ['42', true, false, { a: 1 }, ['5']]) {
			await expect400(() => numField({ k: v }, 'k'));
		}
	});

	it('rejects non-numeric strings, NaN and Infinity with a 400', async () => {
		// Without the isFinite guard, NaN/Infinity would be stored and poison
		// later arithmetic.
		for (const v of ['abc', NaN, Infinity, -Infinity]) {
			await expect400(() => numField({ k: v }, 'k'));
		}
	});
});

describe('boolField', () => {
	it('returns real booleans, undefined when absent', () => {
		expect(boolField({ k: true }, 'k')).toBe(true);
		expect(boolField({ k: false }, 'k')).toBe(false);
		expect(boolField({}, 'k')).toBeUndefined();
		expect(boolField({ k: null }, 'k')).toBeUndefined();
	});

	it('rejects truthy/falsy non-booleans with a 400', async () => {
		// A truthiness check would silently accept 'yes'/1 and store the wrong type.
		for (const v of ['true', 'yes', 1, 0, 'false']) {
			await expect400(() => boolField({ k: v }, 'k'));
		}
	});
});

describe('isCrossOrigin', () => {
	it('allows a request from the same host', () => {
		expect(isCrossOrigin('http://192.168.1.25:3000', '192.168.1.25:3000')).toBe(false);
		// the scheme the browser used must not matter: adapter-node reports https
		expect(isCrossOrigin('https://chat.example.com', 'chat.example.com')).toBe(false);
	});

	it('refuses a request from any other host', () => {
		expect(isCrossOrigin('http://evil.example', '192.168.1.25:3000')).toBe(true);
		expect(isCrossOrigin('http://192.168.1.25:3000.evil.example', '192.168.1.25:3000')).toBe(true);
		// a same-host-but-different-port origin is a different site
		expect(isCrossOrigin('http://192.168.1.25:9999', '192.168.1.25:3000')).toBe(true);
	});

	it('refuses an opaque origin and anything unparseable', () => {
		expect(isCrossOrigin('null', '192.168.1.25:3000')).toBe(true);
		expect(isCrossOrigin('not a url', '192.168.1.25:3000')).toBe(true);
	});

	it('allows callers that send no Origin at all, because webhooks do not', () => {
		expect(isCrossOrigin(undefined, '192.168.1.25:3000')).toBe(false);
		expect(isCrossOrigin(null, '192.168.1.25:3000')).toBe(false);
		expect(isCrossOrigin('', '192.168.1.25:3000')).toBe(false);
	});
});

describe('requestIsSecure', () => {
	it('ignores x-forwarded-proto unless TRUST_PROXY is enabled', () => {
		const previous = config.trustProxy;
		config.trustProxy = false;
		try {
			const req = new Request('http://192.168.1.1/login', {
				headers: { 'x-forwarded-proto': 'https' }
			});
			expect(requestIsSecure(req)).toBe(false);
		} finally {
			config.trustProxy = previous;
		}
	});

	it('honours x-forwarded-proto when TRUST_PROXY is enabled', () => {
		const previous = config.trustProxy;
		config.trustProxy = true;
		try {
			const req = new Request('http://192.168.1.1/login', {
				headers: { 'x-forwarded-proto': 'https, http' }
			});
			expect(requestIsSecure(req)).toBe(true);
		} finally {
			config.trustProxy = previous;
		}
	});

	it('falls back to Origin when proxy trust is off', () => {
		const previous = config.trustProxy;
		config.trustProxy = false;
		try {
			expect(
				requestIsSecure(new Request('http://x/', { headers: { origin: 'https://x' } }))
			).toBe(true);
		} finally {
			config.trustProxy = previous;
		}
	});
});
