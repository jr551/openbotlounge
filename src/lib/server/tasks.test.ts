import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamOptions, StreamResult, ToolCall } from './llm';
import { streamChat } from './llm';
import { machineExec } from './machine';
import {
	createBot,
	createConversation,
	createTask,
	db,
	deleteBot,
	deleteConversation,
	failStaleTasks,
	finishTask,
	getBot,
	jailBot,
	getTask,
	listActivities,
	listMessages,
	setTaskPreview,
	type Bot,
	type Conversation
} from './db';
import { cancelTask, startTask, subscribeTaskEvents, waitForTask } from './tasks';
import { startTypedTask, type TaskProgress } from './pi-task-runner';
import type { TurnEvent } from './events';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { DELETE } from '../../routes/api/tasks/[id]/+server';

// The turn machinery is real here (runner + tools); only the provider, the
// sandbox and the preview write are stand-ins. `spy: true` keeps the db real
// while making the preview calls observable.
vi.mock('./llm', async (importOriginal) => ({
	// The real estimateUsage stays: the runner falls back to it for a stubbed
	// stream that reports no usage, so it must not be an empty vi.fn().
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

vi.mock('./machine', () => ({
	captureShot: vi.fn(),
	machineExec: vi.fn(),
	shellExec: vi.fn(),
	machineScreenshot: vi.fn(),
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

vi.mock('./db', { spy: true });

/** A provider stand-in: yields each delta, then returns the assembled result. */
function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

/**
 * A provider stand-in that yields `deltas` and then blocks until the turn is
 * aborted, the way a socket reading a live stream behaves.
 */
function abortableStream(deltas: string[], opts: StreamOptions): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) {
			yield d;
			await stopSignal(opts);
		}
		if (opts.signal?.aborted) throw new Error('provider aborted');
		return { text: deltas.join(''), toolCalls: [] };
	})();
}

/** A provider stand-in that produces nothing until the turn is stopped. */
function silentUntilAborted(opts: StreamOptions): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		await stopSignal(opts);
		throw new Error('aborted before any output');
	})();
}

function stopSignal(opts: StreamOptions): Promise<void> {
	return new Promise<void>((resolve) => {
		if (!opts.signal || opts.signal.aborted) resolve();
		else opts.signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** The newest activity row, by insertion: what the tray's status/hat reads. */
function newestActivity(botId: string): string {
	const row = db
		.prepare('SELECT kind FROM activities WHERE bot_id = ? ORDER BY rowid DESC LIMIT 1')
		.get(botId) as { kind: string } | undefined;
	return row?.kind ?? '';
}

/** Call the stop route the same way the client does. */
async function deleteTask(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
	try {
		const res = (await DELETE({ params: { id } } as Parameters<typeof DELETE>[0])) as Response;
		return { status: res.status, body: await res.json() };
	} catch (e) {
		const thrown = e as { status: number; body?: unknown };
		return { status: thrown.status, body: (thrown.body ?? {}) as Record<string, unknown> };
	}
}

let bot: Bot;
let conv: Conversation;
let seq = 0;

beforeEach(() => {
	vi.mocked(streamChat).mockReset();
	vi.mocked(machineExec).mockReset().mockResolvedValue('out');
	vi.mocked(setTaskPreview).mockClear();
	bot = createBot({
		name: `TaskProbe${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
	conv = createConversation([bot.id], 'direct');
});

afterEach(() => {
	db.prepare('DELETE FROM activities WHERE bot_id = ?').run(bot.id);
	deleteConversation(conv.id);
	deleteBot(bot.id);
});

describe('task statuses', () => {
	it('starts running straight from the insert - there is no queued/pending stage', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['Hel', 'lo'], { text: 'Hello', toolCalls: [] })
		);

		const task = startTask(conv, bot, 'say hello');

		// The tray polls this row: it must be visible as running immediately.
		expect(task.status).toBe('running');
		expect(getTask(task.id)).toMatchObject({
			status: 'running',
			preview: '',
			error: '',
			message_id: '',
			finished_at: 0
		});

		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('done'));
		const row = getTask(task.id)!;
		const saved = listMessages(conv.id)[0];
		expect(saved).toMatchObject({ role: 'assistant', content: 'Hello', bot_id: bot.id });
		expect(row.message_id).toBe(saved.id);
		expect(row.error).toBe('');
		expect(row.finished_at).toBeGreaterThan(0);
		// The preview is the live tail of the reply that landed.
		expect(row.preview).toBe('Hello');
	});

	it('records a failed provider call as error, with the reason and no message', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				throw new Error('Provider 500: upstream is down');
			})()
		);

		const task = startTask(conv, bot, 'will fail');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('error'));

		const row = getTask(task.id)!;
		expect(row.error).toBe('Provider 500: upstream is down');
		expect(row.message_id).toBe('');
		expect(row.finished_at).toBeGreaterThan(0);
		expect(listMessages(conv.id)).toEqual([]);
		expect(listActivities(bot.id).map((a) => a.detail)).toContain(
			'Task failed: Provider 500: upstream is down'
		);
	});

	it('keeps a reason when the provider throws something that is not an Error', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				throw 'upstream exploded';
			})()
		);

		const task = startTask(conv, bot, 'will fail oddly');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('error'));

		const row = getTask(task.id)!;
		// An empty error leaves the tray showing a failed task with no explanation.
		expect(row.error).toBe('upstream exploded');
		expect(listActivities(bot.id).map((a) => a.detail)).toContain('Task failed: upstream exploded');
	});

	it('errors a turn that produced nothing instead of leaving it running', async () => {
		vi.mocked(streamChat).mockImplementation(() => fakeStream([], { text: '', toolCalls: [] }));

		const task = startTask(conv, bot, 'silent one');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('error'));

		expect(getTask(task.id)).toMatchObject({
			error: 'the model returned nothing',
			message_id: '',
			finished_at: expect.any(Number)
		});
		expect(listMessages(conv.id)).toEqual([]);
	});

	it('finishes a wake the bot answered with the silence sentinel', async () => {
		// '(silent)' is a real answer - the bot looked and had nothing to say -
		// so the task is done, not an error, and nothing lands in the transcript.
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['(silent)'], { text: '(silent)', toolCalls: [] })
		);

		const task = startTask(conv, bot, 'a wake with nothing to say');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('done'));

		expect(getTask(task.id)).toMatchObject({ error: '', message_id: '' });
		expect(listMessages(conv.id)).toEqual([]);
	});
});

describe('cancelling a task', () => {
	it('stops it at the next provider call, keeping and recording the partial reply', async () => {
		vi.mocked(streamChat).mockImplementation((opts) => abortableStream(['Half a '], opts));

		const task = startTask(conv, bot, 'write an essay');
		// The reader saw this much, so it is what the cancelled task points at.
		await vi.waitFor(() => expect(getTask(task.id)?.preview).toBe('Half a '));

		expect(cancelTask(task.id)).toBe(true);
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('cancelled'));

		const row = getTask(task.id)!;
		const saved = listMessages(conv.id)[0];
		expect(saved).toMatchObject({ role: 'assistant', content: 'Half a ', bot_id: bot.id });
		expect(row.message_id).toBe(saved.id);
		expect(row.error).toBe('');
		expect(row.finished_at).toBeGreaterThan(0);
		expect(listActivities(bot.id).map((a) => a.detail)).toContain('Cancelled: write an essay');
	});

	it('cancels a turn that had not written anything yet, with nothing to point at', async () => {
		vi.mocked(streamChat).mockImplementation((opts) => silentUntilAborted(opts));

		const task = startTask(conv, bot, 'never gets going');
		expect(cancelTask(task.id)).toBe(true);
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('cancelled'));

		expect(getTask(task.id)).toMatchObject({ message_id: '', preview: '', error: '' });
		expect(listMessages(conv.id)).toEqual([]);
	});

	it('only leaves running once the turn itself has stopped, so a stop is not instant', async () => {
		// The abort is cooperative: the runner only sees it at the next provider
		// call, so a turn sitting in a tool call stays running after the delete.
		let release = () => {};
		vi.mocked(machineExec).mockImplementation(
			() => new Promise<string>((resolve) => (release = () => resolve('out')))
		);
		let step = 0;
		vi.mocked(streamChat).mockImplementation((opts) => {
			step++;
			if (step === 1)
				return fakeStream(['let me look'], {
					text: 'let me look',
					toolCalls: [toolCall('t1', 'use_computer', { task: 'look' })]
				});
			if (step === 2)
				return fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'shell_exec', { command: 'sleep 5' })]
				});
			return abortableStream([], opts);
		});

		const task = startTask(conv, bot, 'poke around');
		await vi.waitFor(() => expect(getTask(task.id)!.preview).toBe('let me look'));

		expect(cancelTask(task.id)).toBe(true);
		expect(getTask(task.id)?.status).toBe('running');

		release();
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('cancelled'));
		// Found by what it says: the thread also carries the event lines for the
		// tools this turn ran, and one of those can be the newest row.
		const partial = listMessages(conv.id).find((m) => m.content.includes('let me look'));
		expect(getTask(task.id)!.message_id).toBe(partial?.id);
	});

	it('is a no-op for a finished task, and for an unknown id it creates nothing', async () => {
		vi.mocked(streamChat).mockImplementation(() => fakeStream(['ok'], { text: 'ok', toolCalls: [] }));

		const task = startTask(conv, bot, 'quick one');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('done'));
		const before = getTask(task.id)!;

		expect(cancelTask(task.id)).toBe(false);
		expect(getTask(task.id)).toEqual(before);

		expect(cancelTask('no-such-task')).toBe(false);
		expect(getTask('no-such-task')).toBeUndefined();
	});
});

describe('DELETE /api/tasks/:id', () => {
	it('404s an unknown id without creating a row', async () => {
		expect(await deleteTask('no-such-task')).toMatchObject({ status: 404 });
		expect(getTask('no-such-task')).toBeUndefined();
	});

	it('reports a finished task as not cancellable, and leaves it alone', async () => {
		vi.mocked(streamChat).mockImplementation(() => fakeStream(['ok'], { text: 'ok', toolCalls: [] }));

		const task = startTask(conv, bot, 'quick one');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('done'));
		const before = getTask(task.id)!;

		const res = await deleteTask(task.id);
		expect(res).toMatchObject({ status: 200, body: { ok: false, status: 'done' } });
		expect(getTask(task.id)).toEqual(before);
	});

	it('accepts the stop while the row is still running, and lands it as cancelled', async () => {
		vi.mocked(streamChat).mockImplementation((opts) => abortableStream(['half'], opts));

		const task = startTask(conv, bot, 'stop me');
		await vi.waitFor(() => expect(getTask(task.id)!.preview).toBe('half'));

		const res = await deleteTask(task.id);
		// The reply reports the cancel, not the pre-cancel row: the row is
		// stamped 'cancelled' by the task's own finally, which has not run yet.
		expect(res).toMatchObject({ status: 200, body: { ok: true, status: 'cancelled' } });
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('cancelled'));
	});
});

describe('task previews', () => {
	it('keeps a bounded tail of the stream, never handing the db the whole output', async () => {
		const chunk = 'x'.repeat(500);
		const chunks = Array.from({ length: 10 }, (_, i) => (i === 9 ? `${chunk}END` : chunk));
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(chunks, { text: chunks.join(''), toolCalls: [] })
		);

		const task = startTask(conv, bot, 'write a lot');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('done'));

		// What the tray reads is the newest output, not the oldest 400 characters.
		const stored = getTask(task.id)!.preview;
		expect(stored.length).toBeLessThanOrEqual(400);
		expect(stored.endsWith('END')).toBe(true);

		// And nothing unbounded is ever carried along for the ride: the same
		// guard that keeps the row small keeps the task's own buffer small.
		const written = vi.mocked(setTaskPreview).mock.calls.map(([, preview]) => preview.length);
		expect(written.length).toBeGreaterThan(1);
		expect(Math.max(...written)).toBeLessThanOrEqual(400);
	});
});

describe('stale tasks at boot', () => {
	it('marks a leftover running task as interrupted and leaves finished ones untouched', () => {
		const interrupted = createTask(conv.id, bot.id, 'killed mid-turn');
		const done = createTask(conv.id, bot.id, 'finished fine');
		finishTask(done.id, 'done', { messageId: 'message-1' });
		const errored = createTask(conv.id, bot.id, 'failed already');
		finishTask(errored.id, 'error', { error: 'boom' });
		const doneBefore = getTask(done.id)!;
		const erroredBefore = getTask(errored.id)!;

		failStaleTasks();

		expect(getTask(interrupted.id)).toMatchObject({ status: 'error', error: 'interrupted' });
		expect(getTask(interrupted.id)!.finished_at).toBeGreaterThan(0);
		expect(getTask(done.id)).toEqual(doneBefore);
		expect(getTask(errored.id)).toEqual(erroredBefore);
	});
});

describe('progress fields', () => {
	it('a done task reports the finished turn, not the tool it ran on the way', async () => {
		let step = 0;
		vi.mocked(streamChat).mockImplementation(() => {
			step++;
			if (step === 1)
				return fakeStream(['let me look'], {
					text: 'let me look',
					toolCalls: [toolCall('t1', 'use_computer', { task: 'look' })]
				});
			if (step === 2)
				return fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'shell_exec', { command: 'ls' })]
				});
			if (step === 3) return fakeStream([], { text: 'a report', toolCalls: [] });
			return fakeStream([' done'], { text: ' done', toolCalls: [] });
		});

		const task = startTask(conv, bot, 'look around');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('done'));

		const row = getTask(task.id)!;
		// Fields the tray shows agree with the status they are shown under.
		expect(row.error).toBe('');
		expect(row.finished_at).toBeGreaterThan(0);
		const saved = listMessages(conv.id).find((m) => m.content === 'let me look done')!;
		expect(saved.content).toBe('let me look done');
		expect(row.message_id).toBe(saved.id);
		// The shell/typing activity the tool logged is not the bot's newest state.
		expect(listActivities(bot.id).map((a) => a.kind)).toContain('shell');
		expect(newestActivity(bot.id)).toBe('replied');
	});

	it('a cancelled task reports the stop, not the tool it was running', async () => {
		vi.mocked(streamChat).mockImplementation((opts) => abortableStream(['half'], opts));

		const task = startTask(conv, bot, 'stop me');
		await vi.waitFor(() => expect(getTask(task.id)!.preview).toBe('half'));
		cancelTask(task.id);
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('cancelled'));

		const row = getTask(task.id)!;
		expect(row.error).toBe('');
		// The stopped task points at the partial it kept, not at a tool result.
		const kept = listMessages(conv.id).find((m) => m.content.includes('half'));
		expect(row.message_id).toBe(kept?.id);
		expect(newestActivity(bot.id)).toBe('task');
	});
});

describe('a turn stopped by a budget with nothing to show', () => {
	// "the model returned nothing" used to be the message for every empty result,
	// including one the app's own turn budget stopped - which points the reader at
	// the model when the limit is ours.
	it('says which budget stopped it instead of blaming the model', async () => {
		vi.doMock('$lib/server/runner', () => ({
			runBotTurn: vi.fn(async () => ({ text: '', message: null, aborted: false, stoppedBy: 'turns' }))
		}));
		vi.resetModules();
		const { startTask } = await import('./tasks');
		const { getTask } = await import('./db');
		const { createBot, createConversation } = await import('./db');
		const bot = createBot({ name: 'b', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');

		const task = startTask(conv, bot, 'do many things');
		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('error'));
		expect(getTask(task.id)?.error).toContain('used up its turns');
		vi.doUnmock('$lib/server/runner');
	});

	it('names the work in progress, not the turn\'s own stop line', async () => {
		// The real runner writes its stop line before the task row is finished,
		// so the newest activity at that point is the turn talking about itself.
		// The error must name the work underneath it. The mock parks the turn so
		// the test can write the same rows the runner would, in the same order.
		const parked = Promise.withResolvers<void>();
		vi.doMock('$lib/server/runner', () => ({
			runBotTurn: vi.fn(async () => {
				await parked.promise;
				return { text: '', message: null, aborted: false, stoppedBy: 'time', silent: false };
			})
		}));
		// The runner is swapped for this one case, so the module has to be
		// loaded after the mock: a static import would already hold the real one.
		vi.resetModules();
		const { startTask } = await import('./tasks');
		const { createBot, createConversation, getTask, logActivity } = await import('./db');
		const bot = createBot({ name: 'b', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');

		const task = startTask(conv, bot, 'draw something');
		// The work the turn was doing when its clock ran out, as the machine logs
		// it: a multi-line command, collapsed to one line in the error.
		logActivity(bot.id, 'exec', 'export DISPLAY=:1\ngimp -i --batch-interpreter python-fu-eval');
		// Then the rows the runner writes as it stops, newest last.
		logActivity(bot.id, 'budget', 'Stopped early: time');
		logActivity(bot.id, 'silent', 'Chose not to reply');
		parked.resolve();

		await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('error'));
		expect(getTask(task.id)?.error).toBe(
			'stopped before it replied (it ran out of time while export DISPLAY=:1 gimp -i --batch-interpreter python-fu-eval)'
		);
		vi.doUnmock('$lib/server/runner');
	});
});

describe('a jailed bot', () => {
	it('does not get a running task: the refusal is the task, with the reason', async () => {
		const bot = createBot({ name: 'DoingTime', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		jailBot(bot.id, Date.now() + 60_000, 'said it talked to somebody it did not');

		const task = startTask(conv, getBot(bot.id)!, 'do a thing');

		// It lands as an error carrying the police's reason rather than as a turn
		// that quietly does nothing, so the tray says why nothing happened.
		const row = getTask(task.id)!;
		expect(row.status).toBe('error');
		expect(row.error).toContain('in jail: said it talked to somebody it did not');
		expect(vi.mocked(streamChat)).not.toHaveBeenCalled();
		// And the officer's own log records the refusal.
		expect(listActivities(bot.id).some((a) => a.detail.includes('Task refused'))).toBe(true);
	});
});

describe('the typed turn event stream', () => {
	it('fans turn_start, message_end and agent_end to a subscriber', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['Hi'], { text: 'Hi', toolCalls: [] })
		);

		const task = startTask(conv, bot, 'say hi');
		const events: TurnEvent[] = [];
		subscribeTaskEvents(task.id, (e) => events.push(e));
		await waitForTask(task.id);

		expect(events.map((e) => e.type)).toEqual(['turn_start', 'message_end', 'agent_end']);
		expect(events[0]).toMatchObject({ taskId: task.id, botId: bot.id, conversationId: conv.id });
		expect(events[1]).toMatchObject({ text: 'Hi' });
		expect(events[2]).toMatchObject({ stoppedBy: '', aborted: false });
	});

	it('brackets a tool call with tool_execution_start and tool_execution_end', async () => {
		let step = 0;
		vi.mocked(streamChat).mockImplementation(() => {
			step++;
			if (step === 1)
				return fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'shell_exec', { command: 'ls' })]
				});
			return fakeStream(['done'], { text: 'done', toolCalls: [] });
		});

		const task = startTask(conv, bot, 'look around');
		const events: TurnEvent[] = [];
		subscribeTaskEvents(task.id, (e) => events.push(e));
		await waitForTask(task.id);

		expect(events.map((e) => e.type)).toEqual([
			'turn_start',
			'tool_execution_start',
			'tool_execution_end',
			'message_end',
			'agent_end'
		]);
		expect(events[1]).toMatchObject({ callId: 's1', name: 'shell_exec' });
		expect(events[2]).toMatchObject({ callId: 's1', name: 'shell_exec' });
	});
});

describe('the typed task handle', () => {
	it('delivers live progress to a subscriber instead of collecting it silently', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['Hel', 'lo'], { text: 'Hello', toolCalls: [] })
		);

		const handle = startTypedTask(conv, bot, { prompt: 'say hello', kind: 'chat' });
		const seen: TaskProgress[] = [];
		handle.subscribe((p) => seen.push(p));

		await handle.wait();

		// The callback the old code collected and never called now fires per delta.
		expect(seen.map((p) => p.delta)).toEqual(['Hel', 'lo']);
		expect(seen.at(-1)?.preview).toBe('Hello');
		expect(seen.every((p) => p.taskId === handle.id)).toBe(true);
	});
});
