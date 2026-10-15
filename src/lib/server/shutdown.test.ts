import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createBot,
	createConversation,
	getTask,
	type Bot,
	type Conversation
} from './db';
import { startTask, stopAllTasks } from './tasks';
import { startScheduler, stopScheduler } from './scheduler';
import { runBotTurn } from './runner';
import { reapIdleMachines } from './machine';

/**
 * The two halves of a clean `systemctl stop`: the scheduler's interval is the
 * handle that used to hold the event loop open until SIGKILL, and a running
 * turn's provider socket is the other. stopAllTasks is one-way by design - the
 * process is leaving - so it lives in its own file: per-file isolation keeps
 * the refused-start state from leaking into suites that still start tasks.
 */
vi.mock('./runner', () => ({
	runBotTurn: vi.fn(async () => ({ text: 'ok', message: null, aborted: false, stoppedBy: '' }))
}));

// The tick reaps Docker sandboxes; no container is reachable from a unit test.
vi.mock('./machine', () => ({
	reapIdleMachines: vi.fn(async () => {})
}));
vi.mock('./llm', () => ({
	complete: vi.fn(async () => 'NO')
}));

function scene(name: string): { bot: Bot; conv: Conversation } {
	const bot = createBot({ name, persona: '', avatar: '', color: '', model: '', badge: '' });
	const conv = createConversation([bot.id], 'direct');
	return { bot, conv };
}

afterEach(() => {
	stopScheduler();
	vi.useRealTimers();
});

describe('stopScheduler', () => {
	it('clears the interval so the loop can empty, and the scheduler can restart', async () => {
		vi.useFakeTimers();
		const reap = vi.mocked(reapIdleMachines);
		startScheduler();
		await vi.advanceTimersByTimeAsync(0);
		expect(reap).toHaveBeenCalledTimes(1);

		stopScheduler();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reap).toHaveBeenCalledTimes(1);

		startScheduler();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(reap).toHaveBeenCalledTimes(3);
	});
});

describe('stopAllTasks', () => {
	it('aborts a running turn, waits for its final row, and refuses new work', async () => {
		// A turn whose provider stream stays open until aborted - the shape a
		// live reply has when the stop signal lands.
		vi.mocked(runBotTurn).mockImplementation(async (_conv, _bot, opts) => {
			await new Promise<void>((resolve) => {
				if (opts?.signal?.aborted) return resolve();
				opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
			});
			return { text: '', message: null, aborted: true, stoppedBy: '', silent: false };
		});
		const { bot, conv } = scene('Longwinded');
		const task = startTask(conv, bot, 'tell me everything');
		// The turn body runs synchronously up to the provider call, so the turn
		// is already inside runBotTurn when startTask returns.
		expect(runBotTurn).toHaveBeenCalledTimes(1);

		await stopAllTasks(5_000);

		expect(getTask(task.id)?.status).toBe('cancelled');
		const late = startTask(conv, bot, 'one more thing');
		expect(getTask(late.id)?.status).toBe('cancelled');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('returns at once when nothing is running', async () => {
		await expect(stopAllTasks(5_000)).resolves.toBeUndefined();
	});
});
