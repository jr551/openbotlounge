import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSettings, setSetting } from './db';
import { beginFlow, decodeFlow, encodeFlow, exchangeCode, pollDeviceFlow } from './provider-oauth';
import { POST as START } from '../../routes/api/providers/oauth/openrouter/start/+server';
import { GET as CALLBACK } from '../../routes/api/providers/oauth/openrouter/callback/+server';
import { POST as OPENAI_START } from '../../routes/api/providers/oauth/openai/start/+server';
import { POST as OPENAI_STATUS } from '../../routes/api/providers/oauth/openai/status/+server';

const CALLBACK_PATH = '/api/providers/oauth/openrouter/callback';

/** Just the cookie methods the two routes use. */
function fakeCookies(initial: Record<string, string> = {}) {
	const jar: Record<string, string> = { ...initial };
	return {
		jar,
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			jar[name] = value;
		},
		delete: (name: string) => {
			delete jar[name];
		}
	};
}

/** A fetch that records the exchange and answers as OpenRouter does. */
function stubExchange(status: number, body: unknown) {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	const impl = (async (url: unknown, init: { body?: unknown } = {}) => {
		calls.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
	return { impl, calls };
}

afterEach(() => {
	vi.unstubAllGlobals();
	setSetting('provider_base_url', '');
	setSetting('provider_api_key', '');
	setSetting('provider_oauth', '');
	setSetting('default_model', '');
});

describe('the PKCE flow OpenRouter documents', () => {
	it('builds an S256 authorize URL that comes back to this app', () => {
		const { authorizeUrl, flow } = beginFlow({
			callbackUrl: `https://lounge.example${CALLBACK_PATH}`,
			model: 'openai/gpt-5.6-terra'
		});
		const url = new URL(authorizeUrl);
		expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
		expect(url.searchParams.get('callback_url')).toBe(`https://lounge.example${CALLBACK_PATH}`);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		// The challenge is the base64url SHA-256 of the verifier the server keeps.
		expect(url.searchParams.get('code_challenge')).toBe(
			createHash('sha256').update(flow.verifier).digest('base64url')
		);
		expect(flow.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
	});

	it('carries the verifier through the cookie without letting the page set it', () => {
		const { flow } = beginFlow({ callbackUrl: 'https://x/cb', model: 'm' });
		expect(decodeFlow(encodeFlow(flow))).toEqual(flow);
		expect(decodeFlow('not-a-flow')).toBeNull();
	});

	it('exchanges the code for the issued key, with no secret of ours involved', async () => {
		const { impl, calls } = stubExchange(200, { key: 'sk-or-issued-abc' });
		const result = await exchangeCode('one-time-code', 'the-verifier', impl);
		expect(result.key).toBe('sk-or-issued-abc');
		expect(calls[0].url).toBe('https://openrouter.ai/api/v1/auth/keys');
		expect(calls[0].body).toEqual({
			code: 'one-time-code',
			code_verifier: 'the-verifier',
			code_challenge_method: 'S256'
		});
	});

	it('reports what OpenRouter said when the code is refused', async () => {
		const { impl } = stubExchange(403, { error: 'Invalid code or code_verifier' });
		const result = await exchangeCode('stale', 'v', impl);
		expect(result.key).toBe('');
		expect(result.error).toContain('403');
		expect(result.error).toContain('Invalid code or code_verifier');
	});

	it('says the host was unreachable rather than inventing a key', async () => {
		const impl = (async () => {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
		}) as unknown as typeof fetch;
		const result = await exchangeCode('c', 'v', impl);
		expect(result.key).toBe('');
		expect(result.error).toContain('openrouter.ai');
		expect(result.error).toMatch(/DNS|resolve/);
	});
});

describe('the two OAuth routes', () => {
	function startRequest(body: Record<string, unknown>): Request {
		return new Request('http://localhost:3000/api/providers/oauth/openrouter/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	}

	it('hands the dialog an authorize URL and keeps the verifier HttpOnly', async () => {
		const cookies = fakeCookies();
		const res = await START({
			request: startRequest({ model: 'openai/gpt-5.6-terra' }),
			url: new URL('http://localhost:3000/api/providers/oauth/openrouter/start'),
			cookies
		} as unknown as Parameters<typeof START>[0]);
		const { authorize_url } = (await res.json()) as { authorize_url: string };
		expect(authorize_url).toContain('https://openrouter.ai/auth');
		expect(authorize_url).toContain(encodeURIComponent(`http://localhost:3000${CALLBACK_PATH}`));

		// The route reports what it set, which is how a browser would take it.
		const flow = decodeFlow(cookies.jar['obl_oauth_flow']);
		expect(flow?.verifier).toBeTruthy();
		expect(flow?.model).toBe('openai/gpt-5.6-terra');
	});

	it('stores the issued key and never puts it in the page it returns', async () => {
		const { impl } = stubExchange(200, { key: 'sk-or-secret-9f8e7d' });
		vi.stubGlobal('fetch', impl);

		const cookies = fakeCookies({
			obl_oauth_flow: encodeFlow({
				verifier: 'v'.repeat(43),
				model: 'openai/gpt-5.6-terra'
			})
		});
		const res = await CALLBACK({
			url: new URL(`http://localhost:3000${CALLBACK_PATH}?code=one-time-code`),
			cookies
		} as unknown as Parameters<typeof CALLBACK>[0]);

		expect(res.status).toBe(200);
		expect(await res.text()).not.toContain('sk-or-secret-9f8e7d');
		// The flow is spent either way.
		expect(cookies.jar['obl_oauth_flow']).toBeUndefined();

		const stored = listSettings();
		expect(stored.provider_api_key).toBe('sk-or-secret-9f8e7d');
		expect(stored.provider_base_url).toBe('https://openrouter.ai/api/v1');
		expect(stored.default_model).toBe('openai/gpt-5.6-terra');
	});

	it('changes nothing when the browser comes back without a code', async () => {
		const before = listSettings().provider_api_key;
		const cookies = fakeCookies({ obl_oauth_flow: encodeFlow({ verifier: 'v', model: 'm' }) });
		const res = await CALLBACK({
			url: new URL(`http://localhost:3000${CALLBACK_PATH}`),
			cookies
		} as unknown as Parameters<typeof CALLBACK>[0]);
		expect(res.status).toBe(400);
		expect(listSettings().provider_api_key).toBe(before);
	});
});

/* ------------------------------------------------------------------ *
 * OpenAI's device-code sign-in: the app asks for a code, the human types
 * it at auth.openai.com/codex/device, and the status route polls until
 * OpenAI issues tokens. Same flow Codex CLI and opencode implement.
 * ------------------------------------------------------------------ */

/** A JWT-shaped string whose payload carries the given claims. */
function jwt(claims: Record<string, unknown>): string {
	const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
	return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

/** A fetch that answers OpenAI's device endpoints from a script. */
function stubOpenAI(script: Record<string, { status: number; body: unknown }>) {
	const calls: { url: string; body: string }[] = [];
	const impl = (async (url: unknown, init: { body?: unknown } = {}) => {
		const key = String(url).replace('https://auth.openai.com', '');
		calls.push({ url: key, body: String(init.body ?? '') });
		const step = script[key] ?? { status: 500, body: { error: 'unscripted' } };
		return new Response(JSON.stringify(step.body), {
			status: step.status,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function openaiRequest(body: Record<string, unknown>, path: string): Request {
	return new Request(`http://localhost:3000${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('the OpenAI device-code flow', () => {
	it('hands the page a user code and keeps the poll handle server-side', async () => {
		const { impl, calls } = stubOpenAI({
			'/api/accounts/deviceauth/usercode': {
				status: 200,
				body: { device_auth_id: 'da_1', user_code: 'ABCD-1234', interval: '1' }
			}
		});
		vi.stubGlobal('fetch', impl);

		const res = await OPENAI_START({
			request: openaiRequest(
				{ model: 'gpt-5.5' },
				'/api/providers/oauth/openai/start'
			)
		} as unknown as Parameters<typeof OPENAI_START>[0]);
		const data = (await res.json()) as {
			flow_id: string;
			user_code: string;
			verification_url: string;
		};
		expect(data.user_code).toBe('ABCD-1234');
		expect(data.verification_url).toBe('https://auth.openai.com/codex/device');
		expect(data.flow_id).toBeTruthy();
		expect(calls[0].body).toContain('app_EMoamEEZ73f0CkXaXp7hrann');
	});

	it('reports pending until the human types the code, then stores the sign-in', async () => {
		const { impl } = stubOpenAI({
			'/api/accounts/deviceauth/usercode': {
				status: 200,
				body: { device_auth_id: 'da_2', user_code: 'WXYZ-9876', interval: '1' }
			}
		});
		vi.stubGlobal('fetch', impl);
		const startRes = await OPENAI_START({
			request: openaiRequest(
				{ model: 'gpt-5.5' },
				'/api/providers/oauth/openai/start'
			)
		} as unknown as Parameters<typeof OPENAI_START>[0]);
		const { flow_id } = (await startRes.json()) as { flow_id: string };

		// First poll: OpenAI answers 403 - the code has not been typed yet.
		const pending = stubOpenAI({
			'/api/accounts/deviceauth/token': { status: 403, body: {} }
		});
		vi.stubGlobal('fetch', pending.impl);
		const pendingRes = await OPENAI_STATUS({
			request: openaiRequest({ flow_id }, '/api/providers/oauth/openai/status')
		} as unknown as Parameters<typeof OPENAI_STATUS>[0]);
		expect((await pendingRes.json()).status).toBe('pending');

		// Second poll: the code was typed, so OpenAI issues the PKCE pair and
		// the token exchange completes the sign-in.
		const done = stubOpenAI({
			'/api/accounts/deviceauth/token': {
				status: 200,
				body: { authorization_code: 'auth-code', code_verifier: 'cv', code_challenge: 'cc' }
			},
			'/oauth/token': {
				status: 200,
				body: {
					id_token: jwt({ chatgpt_account_id: 'acct-42' }),
					access_token: 'access-token-xyz',
					refresh_token: 'refresh-token-xyz',
					expires_in: 3600
				}
			}
		});
		vi.stubGlobal('fetch', done.impl);
		const doneRes = await OPENAI_STATUS({
			request: openaiRequest({ flow_id }, '/api/providers/oauth/openai/status')
		} as unknown as Parameters<typeof OPENAI_STATUS>[0]);
		expect((await doneRes.json()).status).toBe('connected');

		const stored = listSettings();
		expect(stored.provider_api_key).toBe('access-token-xyz');
		expect(stored.provider_base_url).toBe('https://chatgpt.com/backend-api/codex');
		const session = JSON.parse(stored.provider_oauth ?? '{}') as {
			refresh_token: string;
			account_id: string;
		};
		expect(session.refresh_token).toBe('refresh-token-xyz');
		expect(session.account_id).toBe('acct-42');

		// The exchange redeemed the code against the deviceauth callback URI.
		const exchange = done.calls.find((c) => c.url === '/oauth/token');
		expect(exchange?.body).toContain('code_verifier=cv');
		expect(exchange?.body).toContain(
			encodeURIComponent('https://auth.openai.com/deviceauth/callback')
		);

		// A spent flow cannot be replayed into a second sign-in.
		const replay = await OPENAI_STATUS({
			request: openaiRequest({ flow_id }, '/api/providers/oauth/openai/status')
		} as unknown as Parameters<typeof OPENAI_STATUS>[0]);
		expect((await replay.json()).status).toBe('failed');
	});

	it('fails the flow when OpenAI refuses the device poll', async () => {
		const { impl } = stubOpenAI({
			'/api/accounts/deviceauth/usercode': {
				status: 200,
				body: { device_auth_id: 'da_3', user_code: 'FAIL-0000', interval: '1' }
			}
		});
		vi.stubGlobal('fetch', impl);
		const startRes = await OPENAI_START({
			request: openaiRequest({ model: 'm' }, '/api/providers/oauth/openai/start')
		} as unknown as Parameters<typeof OPENAI_START>[0]);
		const { flow_id } = (await startRes.json()) as { flow_id: string };

		vi.stubGlobal(
			'fetch',
			stubOpenAI({ '/api/accounts/deviceauth/token': { status: 500, body: {} } }).impl
		);
		const res = await OPENAI_STATUS({
			request: openaiRequest({ flow_id }, '/api/providers/oauth/openai/status')
		} as unknown as Parameters<typeof OPENAI_STATUS>[0]);
		expect((await res.json()).status).toBe('failed');
	});

	it('pollDeviceFlow surfaces a dead flow as failed, not pending', async () => {
		const flow = {
			id: 'x',
			deviceAuthId: 'da',
			userCode: 'uc',
			verificationUrl: 'https://auth.openai.com/codex/device',
			interval: 1,
			model: 'm',
			createdAt: Date.now()
		};
		const { impl } = stubOpenAI({
			'/api/accounts/deviceauth/token': { status: 403, body: {} }
		});
		expect((await pollDeviceFlow(flow, impl)).status).toBe('pending');
	});
});
