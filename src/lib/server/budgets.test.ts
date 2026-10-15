import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResult, ToolCall } from './llm';
import { streamChat } from './llm';
import { machineExec } from './machine';
import { config } from './config';
import {
	createBot,
	createConversation,
	getTask,
	listActivities,
	listMessages,
	type Bot,
	type Conversation
} from './db';
import { runBotTurn } from './runner';
import { startTask } from './tasks';

vi.mock('./llm', async (importOriginal) => ({
	// The real estimateUsage stays: the runner falls back to it for a stubbed
	// stream that reports no usage, so it must not be an empty vi.fn().
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

vi.mock('./machine', () => ({
	machineExec: vi.fn(),
	shellExec: vi.fn(),
	machineScreenshot: vi.fn(),
	captureShot: vi.fn(),
	navigateBrowser: vi.fn(),
	setupDesktop: vi.fn(),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(),
	reapIdleMachines: vi.fn(),
	machineStatus: vi.fn()
}));

// The turn reads the bot's personality file through a throwaway container;
// the tests have no docker, so the drive reads as empty.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));

/** A streamChat stand-in: yields each delta, then returns the result. */
function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** A stream that burns a step forever: text plus a tool call, every time. */
function alwaysToolCall(text: string) {
	return () =>
		fakeStream([text], { text, toolCalls: [toolCall('t', 'list_files', {})] });
}

function budgetLines(botId: string): string[] {
	return listActivities(botId)
		.filter((a) => a.kind === 'budget')
		.map((a) => a.detail);
}

const defaults = {
	maxTurnsPerTask: config.maxTurnsPerTask,
	maxTokensPerTask: config.maxTokensPerTask,
	taskTimeoutMs: config.taskTimeoutMs
};

let seq = 0;
function makeBot(name: string): Bot {
	return createBot({
		name: `${name}${++seq}`,
		persona: 'test persona',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

describe('turn budgets', () => {
	let bot: Bot;
	let conv: Conversation;

	beforeEach(() => {
		config.maxTurnsPerTask = defaults.maxTurnsPerTask;
		config.maxTokensPerTask = defaults.maxTokensPerTask;
		config.taskTimeoutMs = defaults.taskTimeoutMs;
		vi.mocked(streamChat).mockReset();
		vi.mocked(machineExec).mockReset().mockResolvedValue('out');
		bot = makeBot('Budget');
		conv = createConversation([bot.id], 'direct');
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('stops at config.maxTurnsPerTask while the model keeps calling tools', async () => {
		config.maxTurnsPerTask = 3;
		vi.mocked(streamChat).mockImplementation(alwaysToolCall('x'));

		const res = await runBotTurn(conv, bot);

		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(3);
		expect(res.stoppedBy).toBe('turns');
		// The work done so far is still saved, one paragraph per step, and the
		// stored reply ends on the stop marker rather than a progress note.
		expect(res.text).toBe('x\n\nx\n\nx\n\n[stopped: out of turns]');
		expect(listMessages(conv.id)[0]).toMatchObject({
			content: 'x\n\nx\n\nx\n\n[stopped: out of turns]',
			bot_id: bot.id
		});
		expect(budgetLines(bot.id)).toContain('Stopped early: turns');
	});

	it('stops once streamed characters blow config.maxTokensPerTask, saving the text', async () => {
		config.maxTokensPerTask = 100; // 400 streamed characters.
		const chunks = ['a'.repeat(300), 'b'.repeat(300)];
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(chunks, { text: chunks.join(''), toolCalls: [toolCall('t', 'list_files', {})] })
		);

		const res = await runBotTurn(conv, bot);

		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1);
		expect(res.stoppedBy).toBe('tokens');
		expect(res.text).toBe(chunks.join('') + '\n\n[stopped: token budget]');
		const msgs = listMessages(conv.id);
		expect(msgs[0]).toMatchObject({
			role: 'assistant',
			content: chunks.join('') + '\n\n[stopped: token budget]',
			bot_id: bot.id
		});
		expect(res.message?.id).toBe(msgs[0].id);
		expect(budgetLines(bot.id)).toContain('Stopped early: tokens');
	});

	it('stops when the turn outlives config.taskTimeoutMs', async () => {
		config.taskTimeoutMs = 1_000;
		vi.useFakeTimers();
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				yield 'slow';
				// The clock moves on while the provider thinks.
				vi.setSystemTime(Date.now() + 5_000);
				return {
					text: 'slow',
					toolCalls: [toolCall('t', 'list_files', {})]
				};
			})()
		);

		const res = await runBotTurn(conv, bot);

		expect(res.stoppedBy).toBe('time');
		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1);
		expect(res.text).toBe('slow\n\n[stopped: out of time]');
		expect(listMessages(conv.id)[0]).toMatchObject({ content: 'slow\n\n[stopped: out of time]' });
		expect(budgetLines(bot.id)).toContain('Stopped early: time');
	});

	it('reports no stop for a short turn that ends on its own', async () => {
		vi.mocked(streamChat).mockImplementation(() => fakeStream(['hi'], { text: 'hi', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.stoppedBy).toBe('');
		expect(budgetLines(bot.id)).toEqual([]);
	});

	it('counts tool-call arguments and results toward the token budget', async () => {
		// 100 tokens ≈ 400 characters; the reply text alone is tiny, but the
		// tool call's arguments and its result push the turn past the ceiling.
		config.maxTokensPerTask = 100;
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['x'], {
				text: 'x',
				toolCalls: [toolCall('t', 'share_note', { content: 'n'.repeat(500) })]
			})
		);

		const res = await runBotTurn(conv, bot);

		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1);
		expect(res.stoppedBy).toBe('tokens');
		expect(budgetLines(bot.id)).toContain('Stopped early: tokens');
	});

	it('stops mid-step when the turn outlives config.taskTimeoutMs', async () => {
		// A step that never answers is cut off by the turn's own clock rather
		// than running to the provider timeout. The deadline is the code's own
		// AbortSignal.timeout, which fake timers cannot drive, so the budget is
		// set to 1ms and the mock ends when the signal actually fires.
		config.taskTimeoutMs = 1;
		vi.mocked(streamChat).mockImplementation((opts) =>
			(async function* (): AsyncGenerator<string, StreamResult> {
				yield 'partial';
				await new Promise((_resolve, reject) => {
					opts.signal?.addEventListener('abort', () =>
						reject(new Error('The operation was aborted'))
					);
				});
				return { text: 'partial', toolCalls: [] };
			})()
		);

		const res = await runBotTurn(conv, bot);

		expect(res.stoppedBy).toBe('time');
		expect(res.text).toBe('partial\n\n[stopped: out of time]');
		expect(budgetLines(bot.id)).toContain('Stopped early: time');
		config.taskTimeoutMs = defaults.taskTimeoutMs;
	});
});

describe('tasks with budgets', () => {
	beforeEach(() => {
		// The turn-budget tests above leave maxTokensPerTask and taskTimeoutMs
		// wherever their last case put them; a task test that inherits a
		// 100-token ceiling stops after one step and reads as a flake.
		config.maxTurnsPerTask = 2;
		config.maxTokensPerTask = defaults.maxTokensPerTask;
		config.taskTimeoutMs = defaults.taskTimeoutMs;
		vi.mocked(streamChat).mockReset();
		vi.mocked(machineExec).mockReset().mockResolvedValue('out');
	});
	afterEach(() => {
		config.maxTurnsPerTask = defaults.maxTurnsPerTask;
		config.maxTokensPerTask = defaults.maxTokensPerTask;
		config.taskTimeoutMs = defaults.taskTimeoutMs;
	});

	it('finishes a budget-stopped task as done and logs the reason', async () => {
		const bot = makeBot('TaskBudget');
		const conv = createConversation([bot.id], 'direct');
		vi.mocked(streamChat).mockImplementation(alwaysToolCall('work '));

		const task = startTask(conv, bot, 'do the thing');

		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('done'));

		const finished = getTask(task.id);
		expect(finished?.message_id).toBeTruthy();
		const saved = listMessages(conv.id)[0];
		expect(saved).toMatchObject({ content: 'work work \n\n[stopped: out of turns]', bot_id: bot.id });
		expect(finished?.message_id).toBe(saved.id);

		const lines = budgetLines(bot.id);
		// The turn records the stop, and the task ties it to the prompt.
		expect(lines).toContain('Stopped early: turns');
		expect(lines).toContain('Task stopped early (turns): do the thing');
	});
});
