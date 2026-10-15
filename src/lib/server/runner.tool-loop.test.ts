import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';
import {
	createBot,
	createConversation,
	createPlugin,
	setSetting,
	listMemories,
	listMessages,
	listNotes,
	type Bot,
	type Conversation,
} from './db';
import { runBotTurn } from './runner';
import { createSecret } from './secrets';

vi.mock('./plugins', async (importOriginal) => ({
	// Only the plugin tool runner is stubbed: a real plugin runs inside a
	// sandbox, and what this file tests is what the loop does with the result.
	...(await importOriginal<typeof import('./plugins')>()),
	executePlugin: vi.fn(async () => 'the key is sk-live-plugin-secret-42')
}));
// The turn reads the bot's personality file through a throwaway container;
// the tests have no docker, so the drive reads as empty.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));


/**
 * The tool loop has only ever been tested against a stubbed `streamChat`, and
 * the app's everyday provider is a mock that never emits tool calls. These
 * tests point the real runner at a real HTTP provider on 127.0.0.1 serving
 * real SSE bytes, so the loop runs against accumulated streamed tool_calls
 * exactly as it would in production.
 *
 * The tools used here (`remember`, `share_note`) take effect in the local
 * database and need no sandbox, so the loop can be observed end to end.
 */
class FakeProvider {
	baseUrl = '';
	readonly requests: { model?: string; messages: ChatMessage[]; tools?: unknown[] }[] = [];
	private waiters: { n: number; resolve: () => void }[] = [];
	private queued: string[][] = [];
	private server: http.Server | null = null;

	queue(...responses: string[][]): void {
		this.queued.push(...responses);
	}

	reset(): void {
		this.queued = [];
		this.requests.length = 0;
	}

	/** Resolves once the nth request has arrived - a signal, not a sleep. */
	async requestSeen(n: number): Promise<void> {
		if (this.requests.length >= n) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.waiters.push({ n, resolve });
		return promise;
	}

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				this.requests.push(JSON.parse(body || '{}'));
				for (const w of this.waiters) {
					if (this.requests.length >= w.n) w.resolve();
				}
				this.waiters = this.waiters.filter((w) => this.requests.length < w.n);
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

interface ChatMessage {
	role: string;
	content: string;
	tool_calls?: unknown;
	tool_call_id?: string;
}

function delta(d: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`;
}

// A clean end is a finish_reason frame followed by [DONE]: the pi adapter
// treats a stream that ends without finish_reason as a failure.
const DONE = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

/** Split raw SSE into TCP-sized chunks, cutting mid-frame. */
function chunk(raw: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < raw.length; i += size) out.push(raw.slice(i, i + size));
	return out;
}

/**
 * One streamed step that asks for a tool: the call arrives fragmented the way a
 * real provider sends it.
 */
function toolStep(id: string, name: string, args: string, content = ''): string[] {
	const raw =
		(content ? delta({ content }) : '') +
		delta({ tool_calls: [{ index: 0, id, function: { name } }] }) +
		delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 7) } }] }) +
		delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(7) } }] }) +
		DONE;
	return chunk(raw, 19);
}

/** One streamed step that answers in plain text. */
function textStep(text: string): string[] {
	return chunk(delta({ content: text }) + DONE, 11);
}

let provider: FakeProvider;
let bot: Bot;
let conv: Conversation;
let savedTurns: number;

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

beforeEach(() => {
	provider.reset();
	bot = createBot({
		name: `LoopBot${Date.now()}${Math.random().toString(16).slice(2, 8)}`,
		persona: 'test persona',
		avatar: '',
		color: '',
		model: 'test-model',
		badge: ''
	});
	conv = createConversation([bot.id], 'direct');
	savedTurns = config.maxTurnsPerTask;
});

afterEach(() => {
	config.maxTurnsPerTask = savedTurns;
});

describe('runBotTurn against a real SSE provider', () => {
	it('runs a streamed tool call, feeds the result back, and persists the reply', async () => {
		provider.queue(
			toolStep('call_1', 'remember', '{"key":"favourite","value":"tea"}'),
			textStep('Noted it.')
		);

		const res = await runBotTurn(conv, bot);

		// The tool really ran: its effect is in the database.
		expect(listMemories(bot.id)).toContainEqual(
			expect.objectContaining({ bot_id: bot.id, key: 'favourite', value: 'tea' })
		);
		// The bot's tools were advertised to the provider.
		expect(provider.requests[0].tools?.length).toBeGreaterThan(0);
		// Two round-trips: the tool step, then the answer.
		expect(provider.requests).toHaveLength(2);

		// The second request carried the tool output back to the model.
		const second = provider.requests[1].messages;
		expect(second).toContainEqual({
			role: 'assistant',
			content: null,
			tool_calls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'remember', arguments: '{"key":"favourite","value":"tea"}' }
				}
			]
		});
		expect(provider.requests[1].messages.filter((m) => m.role === 'tool')).toEqual([
			{ role: 'tool', tool_call_id: 'call_1', content: 'remembered' }
		]);

		// The model's follow-up text is what the conversation ends up holding.
		expect(res.text).toBe('Noted it.');
		expect(res.stoppedBy).toBe('');
		expect(listMessages(conv.id)).toContainEqual(
			expect.objectContaining({ role: 'assistant', content: 'Noted it.', bot_id: bot.id })
		);
		expect(res.message?.content).toBe('Noted it.');
	});

	it('masks a secret a plugin result quotes, the way shell output is masked', async () => {
		// The plugin ran inside the bot's machine, where its secrets live; the
		// stubbed result stands in for one that read them.
		createSecret(bot.id, 'plugin-key', 'sk-live-plugin-secret-42');
		// The tool only reaches executePlugin when it is in the turn's
		// allowlist, which pluginToolsFor builds from real plugin rows.
		createPlugin({
			name: 'leaky',
			description: 'quotes a secret',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: 'return "x";',
			author_bot_id: bot.id,
			scope: 'bot',
			enabled: 1
		});
		provider.queue(toolStep('p1', 'plugin_leaky', '{}'), textStep('done'));

		await runBotTurn(conv, bot);

		expect(provider.requests[1].messages.filter((m) => m.role === 'tool')).toEqual([
			{ role: 'tool', tool_call_id: 'p1', content: 'the key is [secret:plugin-key]' }
		]);
	});

	it('runs a second tool kind too (share_note), observable in the conversation', async () => {
		provider.queue(
			toolStep('n1', 'share_note', '{"content":"bots only"}'),
			textStep('Pinned.')
		);

		const res = await runBotTurn(conv, bot);

		expect(listNotes(conv.id)).toContainEqual(
			expect.objectContaining({ conversation_id: conv.id, bot_id: bot.id, content: 'bots only' })
		);
		expect(provider.requests[1].messages.filter((m) => m.role === 'tool')).toEqual([
			{ role: 'tool', tool_call_id: 'n1', content: 'noted' }
		]);
		expect(res.text).toBe('Pinned.');
	});

	it('hands a malformed-argument failure back as the tool result and finishes', async () => {
		// Valid SSE, but the tool's argument string is not valid JSON.
		provider.queue(
			toolStep('bad1', 'remember', '{"key": "oops"'),
			textStep('Sorry, retrying plainly.')
		);

		const res = await runBotTurn(conv, bot);

		// The adapter salvages the truncated JSON, so what reaches the model is
		// pi's schema validation of the parsed arguments, not a parse error.
		const toolMsgs = provider.requests[1].messages.filter((m) => m.role === 'tool');
		expect(toolMsgs).toHaveLength(1);
		expect(toolMsgs[0].tool_call_id).toBe('bad1');
		expect(toolMsgs[0].content).toContain('Validation failed');
		// Nothing was written by the failed call.
		expect(listMemories(bot.id)).toEqual([]);
		expect(res.text).toBe('Sorry, retrying plainly.');
		expect(listMessages(conv.id)).toContainEqual(
			expect.objectContaining({ role: 'assistant', content: 'Sorry, retrying plainly.' })
		);
	});

	it('hands an unknown-tool failure back as the tool result and finishes', async () => {
		provider.queue(
			toolStep('u1', 'warp_drive', '{"speed":"9"}'),
			textStep('No such tool.')
		);

		const res = await runBotTurn(conv, bot);

		expect(provider.requests[1].messages.filter((m) => m.role === 'tool')).toEqual([
			{ role: 'tool', tool_call_id: 'u1', content: 'Tool warp_drive not found' }
		]);
		expect(res.text).toBe('No such tool.');
		expect(res.aborted).toBe(false);
	});

	it('stops at maxTurnsPerTask when the model asks for a tool every step', async () => {
		config.maxTurnsPerTask = 2;
		provider.queue(
			toolStep('t1', 'remember', '{"key":"a","value":"1"}', 'working'),
			toolStep('t2', 'remember', '{"key":"b","value":"2"}', 'working'),
			toolStep('t3', 'remember', '{"key":"c","value":"3"}', 'working')
		);

		const res = await runBotTurn(conv, bot);

		expect(provider.requests).toHaveLength(2);
		expect(res.stoppedBy).toBe('turns');
		// The work the model did before the cap is kept, not discarded - one
		// paragraph per step - and the stored reply ends on the stop marker.
		expect(res.text).toBe('working\n\nworking\n\n[stopped: out of turns]');
		expect(listMessages(conv.id)).toContainEqual(
			expect.objectContaining({ role: 'assistant', content: 'working\n\nworking\n\n[stopped: out of turns]' })
		);
	});

	it('delivers a steered message to the model before the next provider call', async () => {
		provider.queue(
			toolStep('s1', 'remember', '{"key":"colour","value":"red"}'),
			textStep('Switched to blue.')
		);

		let steer: ((text: string, onRead: () => void) => boolean) | undefined;
		let reads = 0;
		const turn = runBotTurn(conv, bot, { onSteerable: (s) => (steer = s) });
		// The steer lands while the first provider call is in flight, the way a
		// mid-task message does: queued now, delivered after this step's tool
		// calls, read by the model on a later call.
		await provider.requestSeen(1);
		expect(steer?.('use the blue one', () => (reads += 1))).toBe(true);

		const res = await turn;

		// A call after the first carried the human's mid-task message - either
		// inside the loop or through the drain that runs a late steer.
		const later = provider.requests.slice(1).flatMap((r) => r.messages);
		expect(later).toContainEqual(
			expect.objectContaining({
				role: 'user',
				content: expect.arrayContaining([
					expect.objectContaining({ text: expect.stringContaining('use the blue one') })
				])
			})
		);
		expect(res.text).toBe('Switched to blue.');
		// The model was handed it, so the caller is told exactly once: a run that
		// ended without reading it would leave the callback uncalled, and the
		// caller would answer the message itself.
		expect(reads).toBe(1);
		// Once the run has settled the channel refuses: a later message starts
		// its own turn instead of queueing onto a dead one.
		expect(steer?.('too late', () => (reads += 1))).toBe(false);
	});
});
