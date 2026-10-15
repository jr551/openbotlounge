import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrivateAddress, probeProvider } from './provider-connect';
import { config } from './config';
// Kept out of src/routes on purpose: SvelteKit reserves '+' filenames, so a
// test beside the route would break `npm run build`.
import { POST } from '../../routes/api/providers/test/+server';

// The guard resolves a host name before it decides; the tests answer that
// lookup themselves so nothing here touches DNS.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ default: { lookup: lookupMock } }));

/** A public address literal, so the guard passes without a lookup. */
const PUBLIC = 'http://93.184.216.34/v1';

/** Stub the outbound fetch and hand back the spy, so calls can be inspected. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		return handler(url, init ?? {});
	});
	vi.stubGlobal('fetch', fn);
	return fn;
}

function json(status: number, body: string, contentType = 'application/json'): Response {
	return new Response(body, { status, headers: { 'content-type': contentType } });
}

afterEach(() => {
	vi.unstubAllGlobals();
	lookupMock.mockReset();
});

describe('isPrivateAddress', () => {
	it('refuses loopback, LAN, link-local and the other reserved ranges', () => {
		for (const ip of [
			'127.0.0.1',
			'127.1.2.3',
			'0.0.0.0',
			'10.0.0.1',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'169.254.169.254',
			'100.64.0.1',
			'224.0.0.1',
			'255.255.255.255',
			'198.18.0.1',
			'203.0.113.5',
			'::1',
			'::',
			'fe80::1',
			'fd00::1',
			'ff02::1',
			'::ffff:127.0.0.1',
			'::ffff:7f00:1',
			'::ffff:169.254.169.254',
			'2001:db8::1'
		]) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
	});

	it('accepts a public address', () => {
		for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
			expect(isPrivateAddress(ip), ip).toBe(false);
		}
	});
});

describe('the private-address guard', () => {
	it('refuses a private or link-local literal without probing it', async () => {
		const fetchSpy = stubFetch(() => json(200, '{}'));
		// `localhost` is the one name here; it resolves to loopback.
		lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		for (const baseUrl of [
			'http://127.0.0.1/v1',
			'http://localhost/v1',
			'http://0.0.0.0/v1',
			'http://127.1/v1',
			'http://2130706433/v1',
			'http://0x7f000001/v1',
			'http://[::ffff:127.0.0.1]/v1',
			'http://169.254.169.254/latest',
			'http://[fe80::1]/v1'
		]) {
			const result = await probeProvider({ baseUrl, apiKey: 'sk-x', model: 'm' });
			expect(result.ok, baseUrl).toBe(false);
			expect(result.status, baseUrl).toBe(0);
			expect(result.message, baseUrl).toMatch(/private|link-local/);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('refuses a name that resolves to a private address', async () => {
		const fetchSpy = stubFetch(() => json(200, '{}'));
		lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		for (const baseUrl of ['http://localtest.me/v1', 'http://127.0.0.1.nip.io/v1']) {
			const result = await probeProvider({ baseUrl, apiKey: 'sk-x', model: 'm' });
			expect(result.ok, baseUrl).toBe(false);
			expect(result.message, baseUrl).toMatch(/private|link-local/);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('refuses a name when any one of its answers is private', async () => {
		stubFetch(() => json(200, '{}'));
		lookupMock.mockResolvedValue([
			{ address: '93.184.216.34', family: 4 },
			{ address: '10.0.0.5', family: 4 }
		]);
		const result = await probeProvider({ baseUrl: 'http://mixed.example/v1', apiKey: 'sk-x', model: 'm' });
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/private|link-local/);
	});

	it('lets a public host through to the request', async () => {
		const fetchSpy = stubFetch(() =>
			json(200, JSON.stringify({ choices: [{ message: { content: 'ready' } }] }))
		);
		const result = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-x', model: 'm' });
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('probes a private address only when allowPrivate is set', async () => {
		const fetchSpy = stubFetch(() =>
			json(200, JSON.stringify({ choices: [{ message: { content: 'ready' } }] }))
		);
		const result = await probeProvider({
			baseUrl: 'http://127.0.0.1:11434/v1',
			apiKey: 'sk-x',
			model: 'm',
			allowPrivate: true
		});
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe('a connection test against a working endpoint', () => {
	it('reports success without repeating what the model said', async () => {
		const fetchSpy = stubFetch(() =>
			json(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ready' } }] }))
		);
		const result = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-good-key-0001', model: 'test-model' });
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		// The reply is target-controlled text; the open endpoint must not relay it.
		expect(result.message).not.toContain('ready');
		// The key really was used; otherwise "it works" would prove nothing.
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-good-key-0001');
	});
});

describe('a connection test that fails', () => {
	it('names a rejected key without repeating it', async () => {
		stubFetch(() => json(401, JSON.stringify({ error: { message: 'Invalid API key: sk-wrong-key-9999' } })));
		const result = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-wrong-key-9999', model: 'm' });
		expect(result.ok).toBe(false);
		expect(result.status).toBe(401);
		expect(result.message).toContain('rejected the key');
		expect(result.message).not.toContain('sk-wrong-key-9999');
	});

	it('explains a refused connection instead of blaming the key', async () => {
		stubFetch(() => {
			throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), { code: 'ECONNREFUSED' });
		});
		const result = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-good-key-0001', model: 'm' });
		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect(result.message).toContain('93.184.216.34');
		expect(result.message).toMatch(/refused|unreachable|timed out/);
	});

	it('reports a host name that does not resolve, naming the host', async () => {
		lookupMock.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
		stubFetch(() => {
			throw Object.assign(new Error('getaddrinfo ENOTFOUND no-such-provider.invalid'), {
				code: 'ENOTFOUND'
			});
		});
		const result = await probeProvider({
			baseUrl: 'http://no-such-provider.invalid/v1',
			apiKey: 'sk-x',
			model: 'm'
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect(result.message).toContain('no-such-provider.invalid');
	});

	it('does not echo the endpoint body back, on failure or on success', async () => {
		stubFetch(() => json(500, JSON.stringify({ error: { message: 'BOOM top-secret-1234' } })));
		const failed = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-x', model: 'm' });
		expect(failed.status).toBe(500);
		expect(failed.message).toContain('500');
		expect(failed.message).not.toContain('BOOM');
		expect(failed.message).not.toContain('top-secret-1234');

		stubFetch(() => json(200, 'NOT-JSON-BODY-MARKER', 'text/plain'));
		const garbled = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-x', model: 'm' });
		expect(garbled.ok).toBe(false);
		expect(garbled.message).not.toContain('NOT-JSON-BODY-MARKER');
	});

	it('points at the base URL when the path is wrong', async () => {
		stubFetch(() => json(404, '<html>not found</html>', 'text/html'));
		const result = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-x', model: 'm' });
		expect(result.ok).toBe(false);
		expect(result.status).toBe(404);
		expect(result.message).toContain('/v1/chat/completions');
		expect(result.message).toContain('404');
	});

	it('refuses a base URL that is not http(s)', async () => {
		const result = await probeProvider({ baseUrl: 'file:///etc/passwd', apiKey: 'sk-x', model: 'm' });
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/http/);
	});

	it('reports a redirect instead of following it', async () => {
		// A followed redirect would bounce the probe past the address guard.
		const fetchSpy = stubFetch(
			() => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
		);
		const result = await probeProvider({ baseUrl: PUBLIC, apiKey: 'sk-x', model: 'm' });
		expect(result.ok).toBe(false);
		expect(result.status).toBe(302);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect((fetchSpy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
	});
});

describe('POST /api/providers/test', () => {
	function request(body: unknown): Request {
		return new Request('http://test/api/providers/test', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	}

	async function post(body: unknown): Promise<Response | { status: number; body?: { message?: string } }> {
		try {
			return await POST({ request: request(body) } as Parameters<typeof POST>[0]);
		} catch (e) {
			const err = e as { status: number; body?: { message?: string } };
			return err;
		}
	}

	it('answers with the probe result and never echoes the key', async () => {
		stubFetch(() => json(401, JSON.stringify({ error: { message: 'bad key sk-route-key-1234' } })));
		const res = (await post({
			base_url: PUBLIC,
			model: 'test-model',
			api_key: 'sk-route-key-1234'
		})) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; status: number; message: string };
		expect(body.ok).toBe(false);
		expect(body.status).toBe(401);
		expect(body.message).not.toContain('sk-route-key-1234');
		expect(body.message).toContain('rejected the key');
	});

	it('asks for the two fields it cannot guess', async () => {
		const missing = (await post({ model: 'm' })) as { status: number };
		expect(missing.status).toBe(400);
		const noModel = (await post({ base_url: PUBLIC })) as { status: number };
		expect(noModel.status).toBe(400);
	});

	it('refuses a base_url that is not http(s), and never probes a private one', async () => {
		const notUrl = (await post({ base_url: 'file:///etc/passwd', model: 'm' })) as {
			status: number;
		};
		expect(notUrl.status).toBe(400);

		const res = (await post({ base_url: 'http://169.254.169.254/latest', model: 'm' })) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; message: string };
		expect(body.ok).toBe(false);
		expect(body.message).toMatch(/private|link-local/);
	});

	it('probes a local server only when PROVIDER_TEST_ALLOW_PRIVATE is on', async () => {
		const fetchSpy = stubFetch(() =>
			json(200, JSON.stringify({ choices: [{ message: { content: 'ready' } }] }))
		);
		const previous = config.providerTestAllowPrivate;
		try {
			config.providerTestAllowPrivate = true;
			const res = (await post({ base_url: 'http://127.0.0.1:11434/v1', model: 'm' })) as Response;
			const body = (await res.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			config.providerTestAllowPrivate = previous;
		}
	});
});
