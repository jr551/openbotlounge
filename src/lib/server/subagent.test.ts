import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResult, ToolCall } from './llm';
import { streamChat } from './llm';
import { createBot, createConversation, getTask, listTasks, type Bot, type Conversation } from './db';
import { runSubagent, type SubagentOpts } from './subagent';
import { BOT_TOOLS } from './tools';
import { cancelTask } from './tasks';

// The model is faked: each mockImplementationOnce is one step of the helper's
// loop, and what the tests assert is what the loop fed it and which tool
// calls it let through.
vi.mock('./llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

// tools.ts reaches the machine module through the dispatch; the helper's
// read-only set never calls it, so a factory mock keeps the desktop out of
// the load order entirely.
vi.mock('./machine', () => ({
	machineExec: vi.fn(async () => 'machine output'),
	shellExec: vi.fn(async () => 'shell output'),
	machineScreenshot: vi.fn(async () => 'base64png'),
	desktopInput: vi.fn(async () => {}),
	captureShot: vi.fn(async () => 'shot.png'),
	navigateBrowser: vi.fn(async () => ''),
	setupDesktop: vi.fn(async () => 'desktop set up'),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(async () => 'running'),
	machineStatus: vi.fn(async () => ({ state: 'running' })),
	machineTier: vi.fn(() => 'full')
}));

vi.mock('./police', () => ({
	policeModel: vi.fn(() => 'police-model')
}));

/** A streamChat stand-in: yields each delta, then returns the result. */
function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

/** A streamChat stand-in that hangs until the call's signal aborts it. */
function hangingStream(signal?: AbortSignal): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		const { promise, reject } = Promise.withResolvers<never>();
		signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
		await promise;
		return { text: '', toolCalls: [] };
	})();
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

let bot: Bot;
let conv: Conversation;

beforeAll(() => {
	bot = createBot({ name: 'HelperBot', persona: '', avatar: '', color: '', model: '', badge: '' });
	conv = createConversation([bot.id], 'direct');
});

beforeEach(() => {
	vi.clearAllMocks();
});

/** Spawn a helper for the shared bot in the shared room. */
function spawn(task: string, extra: Partial<SubagentOpts> = {}) {
	return runSubagent({
		botId: bot.id,
		botName: bot.name,
		task,
		model: 'm1',
		conversationId: conv.id,
		...extra
	});
}

describe('runSubagent', () => {
	it('answers a task with no tool calls', async () => {
		vi.mocked(streamChat).mockImplementationOnce(() =>
			fakeStream([], { text: 'the answer is 42', toolCalls: [] })
		);

		const report = await spawn('what is the answer');

		expect(report).toBe('the answer is 42');
		// The helper's brief is its own: one system prompt, one focused user
		// message - none of the parent's history.
		const call = vi.mocked(streamChat).mock.calls[0][0];
		expect(call.messages).toHaveLength(2);
		expect(call.messages[0].role).toBe('system');
		expect(call.messages[1]).toEqual({ role: 'user', content: 'what is the answer' });
	});

	it('appends the context the parent pasted into the brief', async () => {
		vi.mocked(streamChat).mockImplementationOnce(() =>
			fakeStream([], { text: 'done', toolCalls: [] })
		);

		await spawn('summarise it', { context: 'the file says hello' });

		const call = vi.mocked(streamChat).mock.calls[0][0];
		expect(call.messages[1].content).toBe('summarise it\n\nContext:\nthe file says hello');
	});

	it('records the run as a task row the tray can open', async () => {
		vi.mocked(streamChat).mockImplementationOnce(() =>
			fakeStream([], { text: 'the report', toolCalls: [] })
		);

		const report = await spawn('look it up', { context: 'the brief' });

		expect(report).toBe('the report');
		const rows = listTasks({ botId: bot.id }).filter((t) => t.prompt === 'look it up');
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.status).toBe('done');
		expect(row.prompt).toBe('look it up');
		expect(row.context).toBe('the brief');
		// The report is the preview the detail view shows.
		expect(row.preview).toBe('the report');
	});

	it('lands a stopped helper as a cancelled task', async () => {
		vi.mocked(streamChat).mockImplementation((opts) => hangingStream(opts.signal));

		const pending = spawn('hang');
		// The tray's stop button is cancelTask on the row: it must reach the run.
		const row = listTasks({ botId: bot.id }).find((t) => t.prompt === 'hang');
		expect(row).toBeDefined();
		expect(cancelTask(row!.id)).toBe(true);

		expect(await pending).toBe('The helper was cancelled.');
		expect(getTask(row!.id)?.status).toBe('cancelled');
	});

	it('runs a read-only tool call and feeds the result back', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('r1', 'recall', {})]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'nothing stored', toolCalls: [] }));

		const report = await spawn('check my memories');

		expect(report).toBe('nothing stored');
		// The second call carries the tool result the first asked for.
		const stepTwo = vi.mocked(streamChat).mock.calls[1][0];
		expect(stepTwo.messages).toContainEqual(
			expect.objectContaining({ role: 'tool', tool_call_id: 'r1' })
		);
	});

	it('refuses a tool outside the read-only set even when the model names it', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'send_message', { bot_name: 'x', message: 'hi' })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'cannot reach out', toolCalls: [] }));

		const report = await spawn('tell x hi');

		expect(report).toBe('cannot reach out');
		const stepTwo = vi.mocked(streamChat).mock.calls[1][0];
		expect(stepTwo.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 's1',
			content: 'error: helpers cannot use send_message - your tools are read-only'
		});
	});

	it('only advertises the read-only tools to the model', async () => {
		vi.mocked(streamChat).mockImplementationOnce(() =>
			fakeStream([], { text: 'ok', toolCalls: [] })
		);

		await spawn('t');

		const offered = (vi.mocked(streamChat).mock.calls[0][0].tools ?? []).map(
			(t) => t.function.name
		);
		expect(offered).toContain('read_file');
		expect(offered).toContain('deepwiki');
		for (const banned of [
			'send_message',
			'use_computer',
			'spawn_agent',
			'schedule_task',
			'remember',
			'shell_exec'
		]) {
			expect(offered).not.toContain(banned);
		}
		// Every advertised name is one BOT_TOOLS actually defines.
		const known = new Set(BOT_TOOLS.map((t) => t.function.name));
		for (const name of offered) expect(known.has(name)).toBe(true);
	});

	it('refuses a fifth helper while four are alive', async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				await gate;
				return { text: 'done', toolCalls: [] };
			})()
		);

		const running = [spawn('cap'), spawn('cap'), spawn('cap'), spawn('cap')];
		const fifth = await spawn('cap');
		expect(fifth).toMatch(/already have 4 helpers running/);

		release();
		const reports = await Promise.all(running);
		expect(reports).toEqual(['done', 'done', 'done', 'done']);
		// The counter is released: the next spawn runs again.
		const sixth = await spawn('cap');
		expect(sixth).toBe('done');
	});

	it('creates no task row for a refused spawn', async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				await gate;
				return { text: 'done', toolCalls: [] };
			})()
		);

		const running = [spawn('cap-test'), spawn('cap-test'), spawn('cap-test'), spawn('cap-test')];
		await spawn('cap-test'); // refused: over the cap
		release();
		await Promise.all(running);

		const rows = listTasks({ botId: bot.id }).filter((t) => t.prompt === 'cap-test');
		expect(rows).toHaveLength(4);
	});

	it('dies at its lifetime with whatever it had said so far', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], { text: 'found part of it', toolCalls: [toolCall('g1', 'recall', {})] })
			)
			.mockImplementation((opts) => hangingStream(opts.signal));

		const report = await spawn('keep digging', { maxLifeMs: 30 });

		expect(report).toMatch(/ran out of its five minutes/);
		expect(report).toMatch(/found part of it/);
	});

	it('reports a cancellation as cancelled, not timed out', async () => {
		vi.mocked(streamChat).mockImplementation((opts) => hangingStream(opts.signal));
		const controller = new AbortController();

		const pending = spawn('t', { signal: controller.signal });
		controller.abort();

		expect(await pending).toBe('The helper was cancelled.');
	});

	it('turns a provider failure into a report, never a throw', async () => {
		vi.mocked(streamChat).mockImplementationOnce(() =>
			(async function* (): AsyncGenerator<string, StreamResult> {
				throw new Error('Provider 500: internal server error');
			})()
		);

		const report = await spawn('t');
		expect(report).toMatch(/helper failed: Provider 500/);
	});
});
