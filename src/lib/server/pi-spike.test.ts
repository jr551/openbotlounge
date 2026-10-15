/**
 * SPIKE proof for adopting the pi SDK (@earendil-works/pi-coding-agent).
 *
 * Goal 1 - provider seam: a real ModelRuntime + createAgentSession pointed at
 *   the app's configured endpoint shape. No live provider exists in this
 *   environment, so the endpoint is a local HTTP server speaking the two wire
 *   protocols the app supports: OpenAI chat/completions (arbitrary
 *   LLM_BASE_URL + key) and the Codex responses API (OAuth access token).
 *   What is proven: registerProvider accepts the app's baseUrl/key, the
 *   request reaches the configured URL with the right auth headers, and one
 *   session.prompt() completes a streamed reply.
 *
 * Goal 2 - tool seam: three app tools (shell_exec, remember, send_message)
 *   wrapped as pi defineTool customTools delegating to the real executeTool,
 *   driven end-to-end by a scripted faux model against the real DB.
 */
import { createServer, type Server } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { addMessage, createBot, createConversation, listMemories, listMessages, setSetting } from './db';
import {
	createLoungeSession,
	loungeRuntime,
	loungeTools,
	registerLoungeProvider,
	LOUNGE_PROVIDER_ID
} from './pi-bridge';
import { BOT_TOOLS, COMPUTER_TOOLS, type ToolContext } from './tools';
import { shellExec } from './machine';

// shell_exec reaches the bot's machine; the tests stand in for it. The point
// under test is that pi's tool dispatch reaches executeTool, not the sandbox.
vi.mock('./machine', () => ({
	machineExec: vi.fn(async () => 'machine output'),
	shellExec: vi.fn(async () => 'shell output'),
	machineScreenshot: vi.fn(async () => 'base64png'),
	desktopInput: vi.fn(async () => {}),
	captureShot: vi.fn(async () => 'shot.png'),
	navigateBrowser: vi.fn(async () => {}),
	setupDesktop: vi.fn(async () => 'desktop set up'),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(async () => 'running'),
	machineStatus: vi.fn(async () => ({
		state: 'running',
		url: '',
		vncPort: 0,
		desktop: 'off',
		screen: 'off',
		lastActive: 0,
		hasThumbnail: false
	})),
	exportCookies: vi.fn(async () => []),
	importCookies: vi.fn(async () => 0),
	machineTier: vi.fn(() => 'full'),
	normalizeSite: vi.fn((s: string) => s.trim().toLowerCase()),
	readPointer: vi.fn(async () => ({ x: 0, y: 0, w: 1280, h: 1024 })),
	clampRegion: vi.fn(),
	IDLE_MINUTES: 9
}));

/** A JWT-shaped access token carrying a ChatGPT account id, as Codex OAuth issues. */
function fakeCodexToken(accountId: string): string {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
	return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`;
}

interface SeenRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

/** An SSE endpoint that records the request and streams one canned reply. */
async function sseServer(
	path: string,
	events: Record<string, unknown>[]
): Promise<{ server: Server; url: string; seen: SeenRequest[] }> {
	const seen: SeenRequest[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			let body = Buffer.concat(chunks);
			if (req.headers['content-encoding'] === 'zstd') body = zstdDecompressSync(body);
			seen.push({
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: body.toString('utf8')
			});
			if (!req.url?.startsWith(path)) {
				res.writeHead(404).end('not found');
				return;
			}
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
			res.write('data: [DONE]\n\n');
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${port}`, seen };
}

/** Collect the assistant text a session produces, via the event stream. */
function watchText(session: { subscribe: (l: (e: { type: string; message?: unknown }) => void) => () => void }) {
	const texts: string[] = [];
	session.subscribe((e) => {
		if (e.type === 'message_end') {
			const msg = e.message as { role?: string; content?: Array<{ type: string; text?: string }> };
			if (msg?.role === 'assistant') {
				texts.push((msg.content ?? []).map((c) => c.text ?? '').join(''));
			}
		}
	});
	return texts;
}

describe('pi spike - provider seam', () => {
	it('streams one prompt through an arbitrary OpenAI-compatible baseUrl + key', async () => {
		const { server, url, seen } = await sseServer('/v1/chat/completions', [
			{ choices: [{ delta: { content: 'hello ' } }] },
			{ choices: [{ delta: { content: 'from pi' } }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] }
		]);
		try {
			const runtime = await loungeRuntime();
			// The app's config shape: a base URL and a bearer key, nothing else.
			const { model, kind } = registerLoungeProvider(runtime, {
				baseUrl: `${url}/v1`,
				apiKey: 'spike-key-123',
				model: 'spike-model'
			});
			expect(kind).toBe('openai');
			const { session } = await createLoungeSession({
				model,
				modelRuntime: runtime,
				systemPrompt: 'You are a spike bot.'
			});
			const texts = watchText(session);
			await session.prompt('say hi');
			session.dispose();

			expect(seen).toHaveLength(1);
			expect(seen[0].url).toBe('/v1/chat/completions');
			expect(seen[0].headers.authorization).toBe('Bearer spike-key-123');
			const sent = JSON.parse(seen[0].body);
			expect(sent.model).toBe('spike-model');
			expect(sent.stream).toBe(true);
			expect(texts.join('')).toBe('hello from pi');
		} finally {
			server.close();
		}
	});

	it('maps the Codex OAuth sign-in onto the openai-codex-responses api', async () => {
		const accountId = 'acct-spike-42';
		const { server, url, seen } = await sseServer('/codex/responses', [
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: { type: 'message', role: 'assistant', content: [] }
			},
			{ type: 'response.output_text.delta', output_index: 0, delta: 'codex says hi' },
			{
				type: 'response.completed',
				response: { status: 'completed', model: 'gpt-spike', usage: { input_tokens: 10, output_tokens: 4 } }
			}
		]);
		try {
			// The app's OAuth state: access token in provider_api_key, refresh
			// metadata in provider_oauth - exactly what the OAuth route writes.
			setSetting('provider_api_key', fakeCodexToken(accountId));
			setSetting(
				'provider_oauth',
				JSON.stringify({ refresh_token: 'rt', account_id: accountId, expires_at: Date.now() + 3_600_000 })
			);
			const runtime = await loungeRuntime();
			const { model, kind } = registerLoungeProvider(runtime, {
				baseUrl: `${url}/codex`,
				model: 'gpt-spike'
			});
			expect(kind).toBe('codex');
			const { session } = await createLoungeSession({
				model,
				modelRuntime: runtime,
				systemPrompt: 'You are a spike bot.',
				// The Codex adapter defaults to 'auto' (websocket first); the mock
				// speaks SSE only, and the app's own implementation is SSE-only too.
				transport: 'sse'
			});
			const texts = watchText(session);
			await session.prompt('say hi');
			session.dispose();

			expect(seen).toHaveLength(1);
			expect(seen[0].url).toBe('/codex/responses');
			// The adapter derives the account header from the JWT itself - the
			// same value llm.ts sends from OAuthSession.account_id.
			expect(seen[0].headers['chatgpt-account-id']).toBe(accountId);
			expect(seen[0].headers.authorization).toMatch(/^Bearer eyJ/);
			expect(seen[0].headers['openai-beta']).toBe('responses=experimental');
			const sent = JSON.parse(seen[0].body);
			expect(sent.store).toBe(false);
			expect(sent.stream).toBe(true);
			expect(texts.join('')).toBe('codex says hi');
		} finally {
			server.close();
		}
	});
});

describe('pi spike - tool seam', () => {
	let botId = '';
	let targetId = '';
	let convId = '';

	beforeAll(() => {
		botId = createBot({ name: 'SpikeBot', persona: '', avatar: '🤖', color: '#fff', model: '', badge: '' }).id;
		targetId = createBot({ name: 'RelayPal', persona: '', avatar: '🦊', color: '#f00', model: '', badge: '' }).id;
		convId = createConversation([botId, targetId], 'group').id;
	});

	it('runs one bot turn through createAgentSession with real tool dispatch', async () => {
		// The relay the runner injects: write the line into the pair room and
		// answer for the target (the real relay would run the target's turn).
		const relay = vi.fn(async (targetBotId: string, text: string) => {
			addMessage(convId, 'user', text, botId, '', 0, 'relay', '', targetBotId);
			return 'RelayPal says hi back';
		});
		const ctx: ToolContext = {
			senderBotId: botId,
			senderBotName: 'SpikeBot',
			conversationId: convId,
			depth: 0,
			relay
		};

		// A scripted model: three tool calls across two model calls, then text.
		const faux = fauxProvider({ provider: 'faux-spike' });
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall('remember', { key: 'spike-fact', value: 'pi drove this' }),
				fauxToolCall('shell_exec', { command: 'echo hi', machine: 'shell' })
			]),
			fauxAssistantMessage([fauxToolCall('send_message', { bot_name: 'RelayPal', message: 'hello pal' })]),
			fauxAssistantMessage([fauxText('done: remembered, shelled, relayed')])
		]);

		const runtime = await loungeRuntime();
		runtime.registerNativeProvider(faux.provider);
		const { session } = await createLoungeSession({
			model: faux.getModel(),
			modelRuntime: runtime,
			systemPrompt: 'You are SpikeBot, a lounge bot.',
			customTools: loungeTools(
				ctx,
				// shell_exec lives in the computer catalogue, the other two in BOT_TOOLS.
				[...BOT_TOOLS, ...COMPUTER_TOOLS].filter((t) =>
					['remember', 'shell_exec', 'send_message'].includes(t.function.name)
				)
			)
		});
		const events: string[] = [];
		session.subscribe((e) => {
			if (e.type === 'tool_execution_start') events.push(`start:${e.toolName}`);
			if (e.type === 'tool_execution_end') {
				events.push(`end:${e.toolName}:${e.isError ? 'err' : 'ok'}`);
			}
		});
		const texts = watchText(session);
		await session.prompt('remember a fact, run echo hi, message RelayPal, then report');
		session.dispose();

		// The model's three calls all dispatched through executeTool for real.
		expect(events).toEqual([
			'start:remember',
			'end:remember:ok',
			'start:shell_exec',
			'end:shell_exec:ok',
			'start:send_message',
			'end:send_message:ok'
		]);
		// remember wrote to the real DB.
		expect(listMemories(botId).map((m) => `${m.key}=${m.value}`)).toContain('spike-fact=pi drove this');
		// shell_exec reached the machine layer with the parsed args.
		expect(vi.mocked(shellExec)).toHaveBeenCalledWith(botId, 'echo hi', expect.anything());
		// send_message went through the injected relay and logged the row.
		expect(relay).toHaveBeenCalledWith(targetId, 'hello pal');
		expect(listMessages(convId).some((m) => m.kind === 'relay' && m.content === 'hello pal')).toBe(true);
		// The final assistant text came back through the session.
		expect(texts.join('')).toContain('done: remembered, shelled, relayed');
	});
});
