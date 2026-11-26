import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';
// Kept out of src/routes on purpose: SvelteKit reserves '+' filenames, so a
// test beside the route would break `npm run build`.
import { POST } from '../../routes/api/providers/check/+server';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ default: { lookup: lookupMock } }));

/** A public literal, so these tests never depend on real DNS. */
const PUBLIC = 'http://93.184.216.34/v1';

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

function request(body: unknown): Request {
	return new Request('http://test/api/providers/check', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function post(body: unknown): Promise<Response | { status: number }> {
	try {
		return await POST({ request: request(body) } as Parameters<typeof POST>[0]);
	} catch (e) {
		return e as { status: number };
	}
}

async function result(body: unknown): Promise<{ ok: boolean; message: string }> {
	const res = (await post(body)) as Response;
	expect(res.status).toBe(200);
	return (await res.json()) as { ok: boolean; message: string };
}

afterEach(() => {
	vi.unstubAllGlobals();
	lookupMock.mockReset();
});

describe('POST /api/providers/check', () => {
	it('asks for the endpoint and model it cannot guess', async () => {
		expect((await post({ model: 'm' })).status).toBe(400);
		expect((await post({ base_url: PUBLIC })).status).toBe(400);
		expect((await post({ base_url: 'file:///etc/passwd', model: 'm' })).status).toBe(400);
	});

	it('accepts a model from the provider listing without making a completion call', async () => {
		const fetchSpy = stubFetch(() => json(200, JSON.stringify({ data: [{ id: 'model-a' }] })));
		const body = await result({ base_url: PUBLIC, model: 'model-a', api_key: 'sk-check-key-1234' });

		expect(body.ok).toBe(true);
		expect(body.message).toContain('model-a');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init = {}] = fetchSpy.mock.calls[0];
		expect(String(url)).toBe(`${PUBLIC}/models`);
		expect(init.method ?? 'GET').toBe('GET');
		expect(init.redirect).toBe('manual');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-check-key-1234');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('reports a model missing from an otherwise readable listing', async () => {
		const fetchSpy = stubFetch(() => json(200, JSON.stringify({ data: [{ id: 'model-a' }] })));
		const body = await result({ base_url: PUBLIC, model: 'model-b' });

		expect(body.ok).toBe(false);
		expect(body.message).toMatch(/not in its model list/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('falls back to a completion when the listing response is not a model list', async () => {
		const fetchSpy = stubFetch((url) =>
			url.endsWith('/models')
				? json(200, '<html>sign in</html>', 'text/html')
				: json(200, JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
		);
		const body = await result({ base_url: PUBLIC, model: 'model-a' });

		expect(body.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const [url, init = {}] = fetchSpy.mock.calls[1];
		expect(url).toBe(`${PUBLIC}/chat/completions`);
		expect(init.method).toBe('POST');
		expect(init.redirect).toBe('manual');
		expect(JSON.parse(String(init.body))).toMatchObject({
			model: 'model-a',
			max_tokens: 1,
			stream: false
		});
	});

	it('does not mistake an arbitrary HTTP 200 response for a completion', async () => {
		stubFetch((url) =>
			url.endsWith('/models')
				? json(404, 'not found')
				: json(200, '<html>catch-all page</html>', 'text/html')
		);
		const body = await result({ base_url: PUBLIC, model: 'model-a' });

		expect(body.ok).toBe(false);
		expect(body.message).toMatch(/not an OpenAI-style completion/);
	});

	it.each([
		[401, /rejected the key/],
		[404, /model was not found/],
		[429, /rate-limited/],
		[500, /HTTP 500/]
	])('reports completion HTTP %i without echoing the response or key', async (status, message) => {
		stubFetch((url) =>
			url.endsWith('/models')
				? json(404, 'not found')
				: json(status, JSON.stringify({ error: { message: 'sk-check-secret-9999 target-secret' } }))
		);
		const body = await result({ base_url: PUBLIC, model: 'model-a', api_key: 'sk-check-secret-9999' });

		expect(body.ok).toBe(false);
		expect(body.message).toMatch(message);
		expect(body.message).not.toContain('sk-check-secret-9999');
		expect(body.message).not.toContain('target-secret');
	});

	it('refuses a private destination by default and permits it only after the operator opts in', async () => {
		const fetchSpy = stubFetch(() => json(200, JSON.stringify({ data: [{ id: 'model-a' }] })));
		const body = await result({ base_url: 'http://127.0.0.1:11434/v1', model: 'model-a' });
		expect(body.ok).toBe(false);
		expect(body.message).toMatch(/private|link-local/);
		expect(fetchSpy).not.toHaveBeenCalled();

		const previous = config.providerTestAllowPrivate;
		try {
			config.providerTestAllowPrivate = true;
			const allowed = await result({ base_url: 'http://127.0.0.1:11434/v1', model: 'model-a' });
			expect(allowed.ok).toBe(true);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			config.providerTestAllowPrivate = previous;
		}
	});

	it('refuses a hostname that resolves to loopback', async () => {
		const fetchSpy = stubFetch(() => json(200, JSON.stringify({ data: [{ id: 'model-a' }] })));
		lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

		const body = await result({ base_url: 'http://localhost/v1', model: 'model-a' });
		expect(body.ok).toBe(false);
		expect(body.message).toMatch(/private|link-local/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('does not follow a redirect from either probe', async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const body = await result({ base_url: PUBLIC, model: 'model-a' });

		expect(body.ok).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect((fetchSpy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
	});
});
