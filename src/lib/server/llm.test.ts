import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { zstdDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from './config';
import { listSettings, setSetting } from './db';
import { complete, listModels, streamChat, type ChatMessage, type StreamResult } from './llm';

/**
 * A fake OpenAI-compatible provider: a real HTTP server on 127.0.0.1 that
 * answers /chat/completions with raw SSE bytes. The everyday mock provider in
 * this app only ever returns text, so streamed tool_calls have never been
 * parsed from real bytes - that is what this exercises.
 *
 * Responses are queued as arrays of chunks; the server writes each chunk as a
 * separate socket write, so a caller can split a frame mid-JSON and prove the
 * parser buffers rather than trusting TCP framing.
 */
class FakeProvider {
	baseUrl = '';
	readonly requests: {
		model?: string;
		messages?: ChatMessage[];
		tools?: unknown[];
		headers?: Record<string, string>;
		path?: string;
	}[] = [];
	private queued: string[][] = [];
	private server: http.Server | null = null;

	queue(...responses: string[][]): void {
		this.queued.push(...responses);
	}

	reset(): void {
		this.queued = [];
		this.requests.length = 0;
	}

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				// The Codex adapter compresses its request bodies; the plain
				// completions adapter does not.
				const buf = Buffer.concat(chunks);
				const raw =
					req.headers['content-encoding'] === 'zstd'
						? zstdDecompressSync(buf).toString('utf8')
						: buf.toString('utf8');
				const parsed = JSON.parse(raw || '{}');
				parsed.headers = req.headers;
				parsed.path = req.url;
				this.requests.push(parsed);
				const next = this.queued.shift();
				if (!next) {
					res.writeHead(500, { 'content-type': 'text/plain' });
					res.end('fake provider: no queued response');
					return;
				}
				res.writeHead(200, {
					'content-type': 'text/event-stream',
					connection: 'close'
				});
				for (const chunk of next) res.write(chunk);
				res.end();
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		const { port } = this.server!.address() as AddressInfo;
		this.baseUrl = `http://127.0.0.1:${port}/v1`;
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = null;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}
}

let provider: FakeProvider;

beforeAll(async () => {
	provider = new FakeProvider();
	await provider.start();
	setSetting('provider_base_url', provider.baseUrl);
	setSetting('provider_api_key', '');
	setSetting('provider_oauth', '');
});

afterAll(async () => {
	await provider.stop();
});

/** One chat-completion delta frame, framed exactly as a provider sends it. */
function delta(d: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`;
}

// A clean end is a finish_reason frame followed by [DONE]: the pi adapter
// treats a stream that ends without finish_reason as a failure, the way a
// dropped socket reads.
const DONE = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

/** Split raw SSE into TCP-sized chunks, deliberately cutting mid-frame. */
function chunk(raw: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < raw.length; i += size) out.push(raw.slice(i, i + size));
	return out;
}

/** Drain the generator the way the runner does, keeping every yielded delta. */
async function drain(
	gen: AsyncGenerator<string, StreamResult>
): Promise<{ deltas: string[]; result: StreamResult }> {
	const deltas: string[] = [];
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return { deltas, result: value };
		deltas.push(value);
	}
}

function ask(question: string): Promise<{ deltas: string[]; result: StreamResult }> {
	return drain(
		streamChat({
			model: 'test-model',
			messages: [{ role: 'user', content: question }]
		})
	);
}

describe('streamChat tool_calls over real SSE', () => {
	it('accumulates one tool call split across indexed deltas', async () => {
		// The provider streams a single call the way OpenAI does: the name first,
		// then the arguments in fragments. Each frame is written as several socket
		// chunks so the boundary can fall inside a JSON token.
		const raw =
			delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell_exec' } }] }) +
			delta({ tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] }) +
			delta({ tool_calls: [{ index: 0, function: { arguments: 'and":"echo hi"}' } }] }) +
			DONE;
		provider.reset();
		provider.queue(chunk(raw, 17));

		const { deltas, result } = await ask('run a command');

		expect(deltas).toEqual([]);
		expect(result.text).toBe('');
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].id).toBe('call_1');
		expect(result.toolCalls[0].type).toBe('function');
		expect(result.toolCalls[0].function.name).toBe('shell_exec');
		// The point: the fragments were reassembled into parseable JSON.
		expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
			command: 'echo hi'
		});
	});

	it('keeps two tool calls apart when their deltas interleave by index', async () => {
		const raw =
			delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'remember' } }] }) +
			delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'share_note' } }] }) +
			delta({ tool_calls: [{ index: 0, function: { arguments: '{"key":' } }] }) +
			delta({ tool_calls: [{ index: 1, function: { arguments: '{"content":' } }] }) +
			delta({ tool_calls: [{ index: 0, function: { arguments: '"k","value":"v"}' } }] }) +
			delta({ tool_calls: [{ index: 1, function: { arguments: '"hi"}' } }] }) +
			DONE;
		provider.reset();
		provider.queue(chunk(raw, 23));

		const { result } = await ask('do two things');

		expect(result.toolCalls).toHaveLength(2);
		// Ordered by index, not by arrival.
		expect(result.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
		expect(result.toolCalls.map((c) => c.function.name)).toEqual([
			'remember',
			'share_note'
		]);
		expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
			key: 'k',
			value: 'v'
		});
		expect(JSON.parse(result.toolCalls[1].function.arguments)).toEqual({ content: 'hi' });
	});

	it('yields content in order, including a delta carrying content and a tool call', async () => {
		const raw =
			delta({ content: 'Be' }) +
			delta({
				content: 'fore',
				tool_calls: [
					{ index: 0, id: 'c1', function: { name: 'remember', arguments: '{"key":' } }
				]
			}) +
			delta({ content: ' after' }) +
			delta({ tool_calls: [{ index: 0, function: { arguments: '"k","value":"v"}' } }] }) +
			DONE;
		provider.reset();
		provider.queue(chunk(raw, 13));

		const { deltas, result } = await ask('mixed');

		expect(deltas).toEqual(['Be', 'fore', ' after']);
		expect(result.text).toBe('Before after');
		expect(result.toolCalls).toHaveLength(1);
		expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
			key: 'k',
			value: 'v'
		});
	});

	it('still returns accumulated calls when the stream ends without [DONE]', async () => {
		// A truncated stream is not a clean finish, but the calls that did arrive
		// must not be thrown away.
		const raw =
			delta({ content: 'partial' }) +
			delta({ tool_calls: [{ index: 0, id: 't9', function: { name: 'remember', arguments: '{}' } }] }) +
			'\n';
		provider.reset();
		provider.queue(chunk(raw, 31));

		const { result } = await ask('truncate');

		expect(result.text).toBe('partial');
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].id).toBe('t9');
		expect(result.toolCalls[0].function.name).toBe('remember');
	});

	it('strips narrated <tool_call> markup from the reply text', async () => {
		// The gateway/free route strips `tools` upstream, so the model narrates
		// calls as text. The markup is hallucination, not a real call - it must
		// not survive into the reply, and no tool call may be fabricated from it.
		const raw =
			delta({ content: '<tool_call>bash\n<tool_call>bash -c "echo hi > /tmp/t.txt"\n<tool_call>echo done >> /tmp/log.txt' }) +
			DONE;
		provider.reset();
		provider.queue(chunk(raw, 19));

		const { result } = await drain(
			streamChat({
				model: 'test-model',
				messages: [{ role: 'user', content: 'make a file' }],
				tools: [
					{
						type: 'function',
						function: {
							name: 'shell_exec',
							description: 'run a shell command',
							parameters: { type: 'object', properties: { command: { type: 'string' } } }
						}
					}
				]
			})
		);

		expect(result.toolCalls).toHaveLength(0);
		expect(result.text).toBe('');
	});

	it('keeps the text after a narrated <tool_call> closer', async () => {
		const raw =
			delta({ content: '<tool_call>computer open the settings page</tool_call>All set.' }) +
			DONE;
		provider.reset();
		provider.queue(chunk(raw, 23));

		const { result } = await ask('x');

		expect(result.toolCalls).toHaveLength(0);
		expect(result.text).toBe('All set.');
	});
});

describe('the served model on a chat stream', () => {
	/** One chunk that names the model the provider routed the alias to. */
	const named = (extra: Record<string, unknown>): string =>
		`data: ${JSON.stringify({ model: 'poolside/laguna-s-2.1:free', ...extra })}\n\n`;

	it('reports the model the provider says it served, not the alias asked for', async () => {
		const raw =
			named({ choices: [{ index: 0, delta: { content: 'hi' } }] }) +
			named({
				choices: [{ index: 0, delta: {} }],
				usage: { prompt_tokens: 3, completion_tokens: 1 }
			}) +
			DONE;
		provider.reset();
		provider.queue(chunk(raw, 19));

		const { result } = await ask('hello');

		expect(result.text).toBe('hi');
		expect(result.servedModel).toBe('poolside/laguna-s-2.1:free');
	});

	it('keeps the served model when the stream is cut off before [DONE]', async () => {
		// The first chunk names it, so a reply the wire cut short is still priced.
		const raw = named({ choices: [{ index: 0, delta: { content: 'half' } }] });
		provider.reset();
		provider.queue(chunk(raw, 13));

		const { result } = await ask('hello');

		expect(result.truncated).toBe(true);
		expect(result.servedModel).toBe('poolside/laguna-s-2.1:free');
	});

	it('leaves the served model unset when the provider names none', async () => {
		provider.reset();
		provider.queue(chunk(delta({ content: 'hi' }) + DONE, 11));

		const { result } = await ask('hello');

		expect(result.servedModel).toBeUndefined();
	});
});

describe('redactCredentials', () => {
	it('removes the configured provider key if a provider echoes it back', async () => {
		const { config } = await import('./config');
		const before = config.apiKey;
		config.apiKey = 'sk-test-secret-key-1234567890';
		try {
			const { redactCredentials } = await import('./llm');
			const out = redactCredentials('bad request: Authorization: Bearer sk-test-secret-key-1234567890');
			expect(out).not.toContain('sk-test-secret-key-1234567890');
			expect(out).toContain('[redacted]');
		} finally {
			config.apiKey = before;
		}
	});

	it('scrubs a bearer token it does not recognise', async () => {
		const { redactCredentials } = await import('./llm');
		expect(redactCredentials('quota exceeded for Bearer abcdef1234567890xyz')).toBe(
			'quota exceeded for Bearer [redacted]'
		);
	});

	it('leaves an ordinary error message readable', async () => {
		const { redactCredentials } = await import('./llm');
		expect(redactCredentials('model not found')).toBe('model not found');
	});
});

/* ------------------------------------------------------------------ *
 * The OAuth path: a provider config whose `provider_oauth` setting holds a
 * session calls
 * the ChatGPT Codex backend's /responses endpoint instead of
 * /chat/completions. The same fake server stands in for it - the adapter
 * is what differs, not the wire.
 * ------------------------------------------------------------------ */

/** One Responses-API event frame, framed exactly as the backend sends it. */
function event(type: string, data: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ type, ...data })}\n\n`;
}


/**
 * The OAuth session the Codex tests run under. Set inside the describe so the
 * plain-completion tests above and the cache tests below still see key auth.
 */
/** A JWT-shaped access token carrying a ChatGPT account id, as Codex OAuth issues. */
function fakeCodexToken(accountId: string): string {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
	return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`;
}

function useOauthSession(): void {
	// expires_at far in the future keeps the call off the refresh path, which
	// is exercised separately with a stubbed fetch.
	setSetting('provider_api_key', fakeCodexToken('acct-123'));
	setSetting(
		'provider_oauth',
		JSON.stringify({
			refresh_token: 'oauth-refresh-token',
			account_id: 'acct-123',
			expires_at: Date.now() + 3_600_000
		})
	);
}

function askOauth(messages: ChatMessage[], tools?: Parameters<typeof streamChat>[0]['tools']) {
	return drain(streamChat({ model: 'gpt-test', messages, tools }));
}

describe('streamChat against the Codex responses backend', () => {
	beforeAll(useOauthSession);
	afterAll(() => setSetting('provider_oauth', ''));
	it('posts Responses-shaped input with the account header, not chat completions', async () => {
		provider.reset();
		provider.queue([
			event('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }),
			event('response.output_text.delta', { output_index: 0, delta: 'hi' }),
			event('response.completed', {
				response: { usage: { input_tokens: 10, output_tokens: 2 } }
			})
		]);
		const { deltas, result } = await askOauth([
			{ role: 'system', content: 'be brief' },
			{ role: 'user', content: 'hello' }
		]);
		expect(deltas).toEqual(['hi']);
		expect(result.text).toBe('hi');
		expect(result.usage).toEqual({
			input: 10,
			output: 2,
			source: 'provider',
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 0,
			cacheReported: false
		});

		const sent = provider.requests[0];
		expect(sent.path).toBe('/v1/codex/responses');
		expect(sent.headers?.['chatgpt-account-id']).toBe('acct-123');
		expect(sent.headers?.authorization).toBe(`Bearer ${fakeCodexToken('acct-123')}`);
		const body = sent as unknown as {
			instructions: string;
			input: { type: string; role?: string }[];
			store: boolean;
			stream: boolean;
		};
		expect(body.instructions).toBe('be brief');
		expect(body.store).toBe(false);
		expect(body.stream).toBe(true);
		expect(body.input).toEqual([
			{
				role: 'user',
				content: [{ type: 'input_text', text: 'hello' }]
			}
		]);
	});
	it('reports the served model the response object names', async () => {
		// The codex adapter never sets responseModel, so streamChat reads the
		// model name off the response.created/completed frames itself -
		// served_model drives cost accounting and police pricing research.
		provider.reset();
		provider.queue([
			event('response.created', { response: { model: 'gpt-5.5-codex' } }),
			event('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }),
			event('response.output_text.delta', { output_index: 0, delta: 'hi' }),
			event('response.completed', {
				response: { model: 'gpt-5.5-codex', usage: { input_tokens: 1, output_tokens: 1 } }
			})
		]);

		const { result } = await askOauth([{ role: 'user', content: 'hello' }]);

		expect(result.text).toBe('hi');
		expect(result.servedModel).toBe('gpt-5.5-codex');
	});

	it('maps tool definitions out and function_call items back', async () => {
		provider.reset();
		provider.queue([
			event('response.output_item.done', {
				item: {
					type: 'function_call',
					id: 'fc_9',
					call_id: 'call_9',
					name: 'ping',
					arguments: '{"x":1}'
				}
			}),
			event('response.completed', { response: {} })
		]);
		const { result } = await askOauth(
			[{ role: 'user', content: 'use the tool' }],
			[
				{
					type: 'function',
					function: { name: 'ping', description: 'pong', parameters: { type: 'object' } }
				}
			]
		);
		expect(result.toolCalls).toEqual([
			{ id: 'call_9|fc_9', type: 'function', function: { name: 'ping', arguments: '{"x":1}' } }
		]);
		const sent = provider.requests[0] as unknown as { tools: Record<string, unknown>[] };
		expect(sent.tools).toEqual([
			{
				type: 'function',
				name: 'ping',
				description: 'pong',
				parameters: { type: 'object' },
				strict: null
			}
		]);
	});

	it('sends tool results and prior calls as function_call items', async () => {
		provider.reset();
		provider.queue([event('response.completed', { response: {} })]);
		await askOauth([
			{ role: 'user', content: 'go' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }
				]
			},
			{ role: 'tool', content: 'pong', tool_call_id: 'call_1' }
		]);
		const sent = provider.requests[0] as unknown as { input: Record<string, unknown>[] };
		expect(sent.input).toEqual([
			{
				role: 'user',
				content: [{ type: 'input_text', text: 'go' }]
			},
			{ type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{}' },
			{ type: 'function_call_output', call_id: 'call_1', output: 'pong' }
		]);
	});

	it('reads the reply off the output_item.done frame when no deltas streamed', async () => {
		provider.reset();
		provider.queue([
			event('response.output_item.done', {
				output_index: 0,
				item: {
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'whole answer' }]
				}
			}),
			event('response.completed', { response: {} })
		]);

		const { result } = await askOauth([{ role: 'user', content: 'q' }]);
		expect(result.text).toBe('whole answer');
		expect(result.truncated).toBeUndefined();
	});

	it('flags a stream that ends without a completed frame as truncated', async () => {
		provider.reset();
		provider.queue([
			event('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }),
			event('response.output_text.delta', { output_index: 0, delta: 'partial' })
		]);
		const { result } = await askOauth([{ role: 'user', content: 'q' }]);
		expect(result.text).toBe('partial');
		expect(result.truncated).toBe(true);
	});

	it('refreshes an expired access token before the call and persists the rotation', async () => {
		const savedKey = listSettings().provider_api_key ?? '';
		const savedOauth = listSettings().provider_oauth ?? '';
		setSetting('provider_api_key', fakeCodexToken('acct-123'));
		setSetting(
			'provider_oauth',
			JSON.stringify({
				refresh_token: 'old-refresh-token',
				account_id: 'acct-123',
				expires_at: Date.now() - 1000
			})
		);
		try {
			const realFetch = globalThis.fetch;
			const refreshCalls: string[] = [];
			vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === 'https://auth.openai.com/oauth/token') {
					refreshCalls.push(String(init?.body));
					return new Response(
						JSON.stringify({
							// The codex adapter derives the account header from the
							// token itself, so the rotated token must be a real JWT shape.
							access_token: fakeCodexToken('acct-123'),
							refresh_token: 'new-refresh-token',
							expires_in: 3600
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					);
				}
				return realFetch(input, init);
			});
			try {
				provider.reset();
				provider.queue([event('response.completed', { response: {} })]);
				await drain(
					streamChat({
						model: 'gpt-test',
						messages: [{ role: 'user', content: 'q' }]
					})
				);
			} finally {
				vi.unstubAllGlobals();
			}
			expect(refreshCalls).toHaveLength(1);
			expect(refreshCalls[0]).toContain('old-refresh-token');
			expect(provider.requests[0].headers?.authorization).toBe(
				`Bearer ${fakeCodexToken('acct-123')}`
			);
			const stored = listSettings();
			expect(stored.provider_api_key).toBe(fakeCodexToken('acct-123'));
			expect(stored.provider_oauth).toContain('new-refresh-token');
		} finally {
			setSetting('provider_api_key', savedKey);
			setSetting('provider_oauth', savedOauth);
		}
	});
});

/* ------------------------------------------------------------------ *
 * Cache counters. Providers report them in different shapes; each real
 * shape is fed through the same stream path the runner uses, and a
 * provider that says nothing must yield zeros flagged as unreported -
 * never an invented number.
 * ------------------------------------------------------------------ */

/** One chat-completions usage frame plus [DONE], as a provider sends it. */
function usageFrame(usage: Record<string, unknown>): string[] {
	return [
		delta({ content: 'ok' }),
		`data: ${JSON.stringify({ choices: [], usage })}\n\n`,
		DONE
	];
}

describe('cache counters in TokenUsage', () => {
	it('reads OpenAI-style prompt_tokens_details.cached_tokens', async () => {
		provider.reset();
		provider.queue(
			usageFrame({
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_tokens_details: { cached_tokens: 80 }
			})
		);
		const { result } = await ask('q');
		expect(result.usage).toMatchObject({
			input: 100,
			cacheRead: 80,
			cacheWrite: 0,
			// The uncached share of the prompt is the miss.
			cacheMiss: 20,
			cacheReported: true,
			source: 'provider'
		});
	});

	it('reads DeepSeek hit/miss split', async () => {
		provider.reset();
		provider.queue(
			usageFrame({
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_cache_hit_tokens: 64,
				prompt_cache_miss_tokens: 36
			})
		);
		const { result } = await ask('q');
		expect(result.usage).toMatchObject({
			cacheRead: 64,
			cacheMiss: 36,
			cacheReported: true
		});
	});

	it('does not read Anthropic-shaped passthrough fields', async () => {
		// The adapter only reads the documented OpenAI/DeepSeek shapes; a
		// provider that answers with Anthropic's cache fields reports as
		// unreported rather than guessing.
		provider.reset();
		provider.queue(
			usageFrame({
				prompt_tokens: 100,
				completion_tokens: 5,
				cache_read_input_tokens: 70,
				cache_creation_input_tokens: 20
			})
		);
		const { result } = await ask('q');
		expect(result.usage).toMatchObject({
			input: 100,
			cacheRead: 0,
			cacheWrite: 0,
			cacheReported: false
		});
	});

	it('flags a provider that reports usage but no cache fields as unreported', async () => {
		provider.reset();
		provider.queue(usageFrame({ prompt_tokens: 100, completion_tokens: 5 }));
		const { result } = await ask('q');
		expect(result.usage).toMatchObject({
			source: 'provider',
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 0,
			cacheReported: false
		});
	});

	it('flags a provider that reports nothing as estimated and cache-free', async () => {
		provider.reset();
		provider.queue([delta({ content: 'ok' }), DONE]);
		const { result } = await ask('q');
		expect(result.usage).toMatchObject({
			source: 'estimated',
			cacheRead: 0,
			cacheReported: false
		});
	});

	it('reads Responses-style input_tokens_details.cached_tokens', async () => {
		// The Responses adapter only runs while an OAuth session is configured.
		useOauthSession();
		try {
			provider.reset();
			provider.queue([
				event('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }),
				event('response.output_text.delta', { output_index: 0, delta: 'ok' }),
				event('response.completed', {
					response: {
						usage: {
							input_tokens: 100,
							output_tokens: 5,
							input_tokens_details: { cached_tokens: 55 }
						}
					}
				})
			]);
			const { result } = await askOauth([{ role: 'user', content: 'q' }]);
			expect(result.usage).toMatchObject({
				input: 100,
				cacheRead: 55,
				cacheReported: true,
				source: 'provider'
			});
		} finally {
			setSetting('provider_oauth', '');
		}
	});
});

/* ------------------------------------------------------------------ *
 * Mid-stream failures. A provider that dies after the headers arrived
 * is a failure the reader sees, so it is retried under the same policy
 * as a failed request - but only while nothing has been yielded, because
 * a retry after a delta would replay text the reader has already seen.
 * ------------------------------------------------------------------ */

/** A Response whose SSE body delivers `frames` and then dies the way a dropped
 * socket does: the reader rejects instead of the stream ending cleanly. */
function dyingStream(frames: string[], error: Error): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < frames.length) {
				controller.enqueue(encoder.encode(frames[i++]));
				return;
			}
			controller.error(error);
		}
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A Response whose SSE body delivers `frames` and then ends cleanly. */
function sseStream(frames: string[]): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < frames.length) controller.enqueue(encoder.encode(frames[i++]));
			else controller.close();
		}
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('mid-stream failures are retried under the provider retry policy', () => {
	let savedInterval: number;

	beforeAll(() => {
		// The chat path, not the Codex one, and a retry interval short enough
		// that a test does not spend the real five seconds waiting.
		setSetting('provider_oauth', '');
		savedInterval = config.llmRetryIntervalMs;
		config.llmRetryIntervalMs = 1;
	});

	afterAll(() => {
		config.llmRetryIntervalMs = savedInterval;
	});

	it('retries a stream that dies before any delta, and returns the retry', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			if (calls === 1) return dyingStream([], new Error('socket hang up'));
			return sseStream([delta({ content: 'hello' }), DONE]);
		});
		try {
			const { deltas, result } = await ask('q');
			expect(deltas).toEqual(['hello']);
			expect(result.text).toBe('hello');
			expect(result.truncated).toBeUndefined();
			expect(calls).toBe(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('does not retry a stream that dies after a delta, and reports it truncated', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			return dyingStream([delta({ content: 'partial' })], new Error('socket hang up'));
		});
		try {
			const { deltas, result } = await ask('q');
			expect(deltas).toEqual(['partial']);
			expect(result.text).toBe('partial');
			expect(result.truncated).toBe(true);
			expect(calls).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('does not retry a caller abort mid-stream', async () => {
		let calls = 0;
		const ac = new AbortController();
		vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
			const signal = init?.signal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const fail = () => controller.error(new DOMException('aborted', 'AbortError'));
					if (signal?.aborted) fail();
					else signal?.addEventListener('abort', fail);
				}
			});
			calls++;
			return new Response(body, { status: 200 });
		});
		try {
			const gen = streamChat({
				model: 'test-model',
				messages: [{ role: 'user', content: 'q' }],
				signal: ac.signal
			});
			const pending = gen.next();
			await vi.waitFor(() => expect(calls).toBe(1));
			ac.abort();
			await expect(pending).rejects.toThrow();
			expect(calls).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('retries a Codex responses stream that dies before any delta', async () => {
		useOauthSession();
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			if (calls === 1) return dyingStream([], new Error('socket hang up'));
			return sseStream([
				event('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }),
				event('response.output_text.delta', { output_index: 0, delta: 'hi' }),
				event('response.completed', { response: {} })
			]);
		});
		try {
			const { deltas, result } = await askOauth([{ role: 'user', content: 'q' }]);
			expect(deltas).toEqual(['hi']);
			expect(result.text).toBe('hi');
			expect(result.truncated).toBeUndefined();
			expect(calls).toBe(2);
		} finally {
			vi.unstubAllGlobals();
			setSetting('provider_oauth', '');
		}
	});
});

describe('complete() against a reasoning model that burns its budget', () => {
	/** A non-streamed chat-completion body, the shape complete() reads. */
	function jsonResponse(content: string, finishReason: string): string {
		return JSON.stringify({
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content },
					finish_reason: finishReason
				}
			]
		});
	}

	it('retries once without the effort knob when reasoning eats the whole cap', async () => {
		// The live bug: a reasoning model spent max_tokens on hidden
		// reasoning_content and answered 'length' with empty content, which the
		// police read as 'unreviewed'. The retry asks without reasoning_effort.
		provider.reset();
		provider.queue(
			[jsonResponse('', 'length')],
			[jsonResponse('APPROVED - it reads args.city', 'stop')]
		);

		const text = await complete(
			'test-model',
			[{ role: 'user', content: 'review this' }],
			{ effort: 'high', maxTokens: 200 }
		);

		expect(text).toBe('APPROVED - it reads args.city');
		expect(provider.requests).toHaveLength(2);
		expect(provider.requests[0]).toMatchObject({ reasoning_effort: 'high' });
		expect((provider.requests[1] as Record<string, unknown>).reasoning_effort).toBeUndefined();
	});

	it('returns a truncated-but-nonempty answer rather than paying for a retry', async () => {
		provider.reset();
		provider.queue([jsonResponse('a partial answer', 'length')]);

		const text = await complete(
			'test-model',
			[{ role: 'user', content: 'review this' }],
			{ effort: 'high', maxTokens: 200 }
		);

		expect(text).toBe('a partial answer');
		expect(provider.requests).toHaveLength(1);
	});
});

describe('listModels under a provider that cannot answer', () => {
	// /models is a plain GET the fake provider does not serve, so fetch is
	// stubbed: what is under test is the sharing, the bound and the cache.
	it('lets a bounded caller give up while the shared fetch runs on', async () => {
		const { promise: slow, resolve: answer } = Promise.withResolvers<Response>();
		vi.stubGlobal('fetch', vi.fn(() => slow));
		try {
			const bounded = listModels(AbortSignal.timeout(20));
			const unbounded = listModels();
			await expect(bounded).rejects.toThrow();
			// The shared fetch was not cancelled with the bounded caller.
			answer(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }));
			await expect(unbounded).resolves.toContain('m1');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('serves the last good list when the provider stops answering', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'fresh-model' }] }), { status: 200 }))
		);
		try {
			await expect(listModels()).resolves.toContain('fresh-model');
			vi.mocked(fetch).mockRejectedValueOnce(new Error('connection refused'));
			await expect(listModels()).resolves.toContain('fresh-model');
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
