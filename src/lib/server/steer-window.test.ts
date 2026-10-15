import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createBot,
	createConversation,
	deleteBot,
	deleteConversation,
	getTask,
	listTasks
} from './db';
import type { Bot, Conversation } from './db';
import { runBotTurn } from './runner';
import type { BotTurnResult } from './runner';
import { startTask, steerTask, waitForTask } from './tasks';

// The steer window is the time between a task's row existing and its turn
// offering a channel: the member hooks a caller waits on, the runtime, the
// session. `runBotTurn` is what takes that time, so it is the thing this file
// controls - the machinery around it (the channel, the hold, the fallback) is
// real here and in the routes. A real turn against a live provider is covered
// in `runner.tool-loop.test.ts`.
vi.mock('./runner', () => ({ runBotTurn: vi.fn() }));

let bot: Bot;
let roommate: Bot;
let conv: Conversation;
/** A second room the same bot answers in: what a routine or a webhook leaves. */
let home: Conversation;

/** A clean finish, so a test is only about what happened to the steer. */
function silentTurn(): BotTurnResult {
	return { text: '', message: null, aborted: false, stoppedBy: '', silent: true };
}

beforeEach(() => {
	vi.mocked(runBotTurn).mockReset();
	const tag = Math.random().toString(16).slice(2, 8);
	bot = createBot({ name: `SteerProbe${tag}`, persona: '', avatar: '', color: '', model: '', badge: '' });
	roommate = createBot({ name: `Roommate${tag}`, persona: '', avatar: '', color: '', model: '', badge: '' });
	conv = createConversation([bot.id], 'direct');
	home = createConversation([bot.id, roommate.id], 'group');
});

afterEach(() => {
	deleteConversation(conv.id);
	deleteConversation(home.id);
	deleteBot(bot.id);
	deleteBot(roommate.id);
});

describe('The steer window', () => {
	it('holds a steer until the turn can take it, then queues it ahead of the first call', async () => {
		const building = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const taken: string[] = [];
		vi.mocked(runBotTurn).mockImplementation(async (_conv, _bot, opts?) => {
			building.resolve();
			// The session is being built: there is no channel to queue onto yet.
			await release.promise;
			opts?.onSteerable?.((text, onRead) => {
				taken.push(text);
				// The loop handed it to the model, so the caller is done with it.
				onRead();
				return true;
			});
			return silentTurn();
		});

		const task = startTask(conv, bot, 'tidy the folder');
		await building.promise;
		// The row already reads running, so a correction sent now is taken rather
		// than refused into a second task beside the work.
		expect(steerTask(task.id, 'the blue one')).toBe(true);
		release.resolve();
		await waitForTask(task.id);

		expect(taken).toEqual(['the blue one']);
		// The turn's own channel took it: nothing else was started for it.
		expect(listTasks({ conversationId: conv.id }).map((t) => t.prompt)).toEqual(['tidy the folder']);
	});

	it('answers a steer the run queued but never read', async () => {
		const offered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.mocked(runBotTurn).mockImplementation(async (_conv, _bot, opts?) => {
			// The queue takes the message, and this run then ends without the loop
			// ever handing it to the model - which is what a budget stop does, since
			// it skips the drain. The "queued" the caller was told has to be made
			// good by something, or the message exists nowhere at all.
			opts?.onSteerable?.(() => true);
			offered.resolve();
			await finish.promise;
			return { ...silentTurn(), stoppedBy: 'time' };
		});

		const task = startTask(conv, bot, 'tidy the folder');
		await offered.promise;
		expect(steerTask(task.id, 'the blue one', home)).toBe(true);
		finish.resolve();
		await waitForTask(task.id);

		// Queued and never read: it runs as its own task, in the room the human
		// sent it from, rather than being dropped on a promise.
		expect(listTasks({ conversationId: home.id }).map((t) => t.prompt)).toEqual(['the blue one']);
	});

	it('refuses once the turn is dead, and runs what it held as its own task', async () => {
		// The turn dies while it is still being built and never offers a channel.
		vi.mocked(runBotTurn).mockImplementation(async () => {
			throw new Error('session build failed');
		});

		const task = startTask(conv, bot, 'tidy the folder');
		// Sent while the build was failing. The caller is told it was taken - so
		// it must not be thrown away with the turn that never read it.
		expect(steerTask(task.id, 'the blue one', home)).toBe(true);
		await waitForTask(task.id);

		expect(getTask(task.id)?.status).toBe('error');
		// It runs as its own task, in the conversation the human sent it from.
		expect(listTasks({ conversationId: home.id }).map((t) => t.prompt)).toEqual(['the blue one']);
		// And the dead turn answers "refused" from here on, so the next message
		// takes the normal path instead of vanishing into a finished task.
		expect(steerTask(task.id, 'the green one')).toBe(false);
	});

	it('starts the held steer where the human is reading when there is no origin room', async () => {
		vi.mocked(runBotTurn).mockImplementation(async () => {
			throw new Error('session build failed');
		});

		const task = startTask(conv, bot, 'tidy the folder');
		// A steer from the turn's own room carries no origin: it is answered in
		// that room, which is where the human already is.
		expect(steerTask(task.id, 'the blue one')).toBe(true);
		await waitForTask(task.id);

		expect(listTasks({ conversationId: conv.id }).map((t) => t.prompt).sort()).toEqual([
			'the blue one',
			'tidy the folder'
		]);
	});
});

describe('The steer channel after the turn has one of its own', () => {
	it('refuses what the turn refuses, so the caller answers with a task', async () => {
		const offered = Promise.withResolvers<void>();
		vi.mocked(runBotTurn).mockImplementation(async (_conv, _bot, opts?) => {
			// The run is settled as far as the turn is concerned.
			opts?.onSteerable?.(() => false);
			offered.resolve();
			return silentTurn();
		});

		const task = startTask(conv, bot, 'a short one');
		await offered.promise;

		expect(steerTask(task.id, 'too late')).toBe(false);
		await waitForTask(task.id);
		expect(listTasks({ conversationId: conv.id }).map((t) => t.prompt)).toEqual(['a short one']);
	});
});
