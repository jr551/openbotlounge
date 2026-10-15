import {
	addTaskTokens,
	createTask,
	finishTask,
	getTask,
	jailStatus,
	listActivitiesInWindow,
	logActivity,
	setTaskPreview,
	type Bot,
	type Conversation,
	type Task
} from './db';
import { runBotTurn } from './runner';
import { TurnEventEmitter, type TurnEvent } from './events';
// tasks -> police -> tasks is a cycle; noteRateLimitError is a hoisted
// declaration, so the import resolves before either side calls it.
import { noteRateLimitError } from './police';

/**
 * Turns run as background tasks, not as part of the HTTP request that started
 * them. That is what lets the user send a new message while an earlier one is
 * still working: the old task keeps going, a new one starts, and the task tray
 * shows both. A dropped connection can no longer cost us a reply either.
 */

/** Abort handles for the tasks this process is running. */
const controllers = new Map<string, AbortController>();

/**
 * False once shutdown has started: no new turns may begin, because a turn
 * started while the process is draining would outlive the drain and hold the
 * event loop open past systemd's stop timeout.
 */
let accepting = true;

/**
 * Live lifecycle streams for the tasks this process is running, keyed by task
 * id. A task that has finished has no entry: a late subscriber reads the
 * finished row from the DB instead of waiting on a stream that will not speak.
 */
const eventStreams = new Map<string, TurnEventEmitter>();

/** One live preview delta, as the tray's sliding tail sees it. */
export interface TaskProgress {
	taskId: string;
	/** Sliding tail of the reply (≤400 chars, same limit as `PREVIEW_LIMIT`). */
	preview: string;
	/** Full delta that produced the tail, for consumers that want to stream. */
	delta: string;
}

/**
 * Live preview listeners per task, fed from the same `onDelta` that writes the
 * tray preview - one source of truth, not a second channel that could drift.
 */
const previewListeners = new Map<string, Set<(progress: TaskProgress) => void>>();

/**
 * The steer callback of each live turn, keyed by task id. It answers from the
 * moment the task starts, holding anything that arrives before `runBotTurn`
 * offers its own channel (see `startTask`), and it stops answering the moment
 * the turn settles - so a message queued here reaches the model before its next
 * provider call, or not at all, and the caller starts a fresh task instead.
 */
const steerHandlers = new Map<string, (text: string, origin?: Conversation) => boolean>();

/**
 * Feed a mid-task message into a running turn. True means the turn accepted
 * it and the model will see it; false means the turn is not live (or not yet
 * steerable), and the caller should start a task for it the usual way.
 *
 * `origin` is the conversation the human sent the message in, when that is not
 * the turn's own - a correction aimed at work running in another room. A steer
 * the turn never gets to take (it died while it was still being built) is run
 * as its own task there rather than thrown away, so the answer lands in the
 * room the human is reading.
 */
export function steerTask(taskId: string, text: string, origin?: Conversation): boolean {
	return steerHandlers.get(taskId)?.(text, origin) === true;
}

/**
 * Listeners told about every task this process starts. A live consumer - the
 * SSE stream - attaches to a task the moment it exists rather than polling the
 * tasks table for one to appear, which is the difference between seeing the
 * first word and joining mid-sentence.
 */
const startListeners = new Set<(task: Task) => void>();

/**
 * Subscribe to the start of every task this process runs. Returns an
 * unsubscribe function. Only tasks that actually start a turn are announced: a
 * jailed bot's refusal is finished inside `startTask` and never streams.
 */
export function subscribeTaskStarts(listener: (task: Task) => void): () => void {
	startListeners.add(listener);
	return () => startListeners.delete(listener);
}

/**
 * Subscribe to one task's lifecycle events. Returns an unsubscribe function.
 * A task that has already finished has no stream, so the returned function is
 * a no-op and the caller falls back to the row it can read from the DB.
 */
export function subscribeTaskEvents(taskId: string, listener: (event: TurnEvent) => void): () => void {
	const emitter = eventStreams.get(taskId);
	if (!emitter) return () => {};
	return emitter.subscribe(listener);
}

/**
 * Subscribe to one task's live preview deltas. Returns an unsubscribe function.
 * A task that has already finished has no listener set, so the returned
 * function is a no-op and the caller reads the finished row from the DB.
 */
export function subscribeTaskProgress(
	taskId: string,
	listener: (progress: TaskProgress) => void
): () => void {
	const set = previewListeners.get(taskId);
	if (!set) return () => {};
	set.add(listener);
	return () => {
		const current = previewListeners.get(taskId);
		if (!current) return;
		current.delete(listener);
		if (!current.size) previewListeners.delete(taskId);
	};
}

/** Resolves with the finished row for every task this process completes. */
const doneWaiters = new Map<string, (task: Task) => void>();

/**
 * Await a task this process started. The scheduler needs the turn's end, not
 * just its start - a lounge round seats the second bot only after the first
 * has answered, and a wake's loop guard reads the reply it produced.
 */
export function waitForTask(id: string): Promise<Task> {
	// A jailed bot's task is finished inside startTask, before a caller could
	// register the wait - resolve those immediately rather than hang forever.
	const existing = getTask(id);
	if (existing && existing.status !== 'running') return Promise.resolve(existing);
	const { promise, resolve } = Promise.withResolvers<Task>();
	doneWaiters.set(id, resolve);
	return promise;
}

/** Plain language for what stopped a turn early. */
const STOP_REASON: Record<string, string> = {
	jailed: 'it is in jail',
	turns: 'it used up its turns',
	tokens: 'it used up its token budget',
	time: 'it ran out of time',
	tools: 'the tools stopped it',
	truncated: 'the reply was cut off mid-stream'
};
/**
 * The rows a turn writes about itself when it stops, rather than about the work
 * it was doing: the budget line, the silence sentinel and a cut-off reply. A
 * stopped task's error names the newest activity that is not one of these,
 * because that is the work in progress.
 */
const TURN_STOP_KINDS: Record<string, true> = {
	budget: true,
	silent: true,
	error: true
};

/**
 * What the bot was doing when its turn ran out, in its own log's words: the
 * newest activity of this task that is not the turn talking about its own stop.
 * Collapsed to one bounded line, because it lands in a task row the tray shows.
 * Empty when the task logged no work at all.
 */
function workInProgress(botId: string, since: number): string {
	const acts = listActivitiesInWindow(botId, since, Date.now());
	for (let i = acts.length - 1; i >= 0; i--) {
		if (TURN_STOP_KINDS[acts[i].kind]) continue;
		const flat = acts[i].detail.replace(/\s+/g, ' ').trim();
		return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
	}
	return '';
}
/**
 * How much live output a task keeps for the tray. The reader only ever sees the
 * newest lines, and a turn can stream for megabytes, so this is a sliding tail
 * rather than a growing copy of everything the model has said. Matches the tail
 * `setTaskPreview` stores.
 */
const PREVIEW_LIMIT = 400;

/** Start a bot's reply in the background. Returns the task id immediately. */
export function startTask(
	conv: Conversation,
	bot: Bot,
	prompt: string,
	opts: {
		think?: boolean;
		ready?: Promise<void>;
		preamble?: string;
		model?: string;
		context?: string;
		/** Run the turn with no tools - a rewrite, like a regenerate, must not re-fire side-effects. */
		noTools?: boolean;
	} = {}
): Task {
	const task = createTask(conv.id, bot.id, prompt, undefined, opts.context);
	// A task asked for while the process is shutting down never runs: it lands
	// cancelled, like a jailed bot's refusal, rather than starting work the
	// drain would have to abort a moment later.
	if (!accepting) {
		finishTask(task.id, 'cancelled', { messageId: '' });
		logActivity(bot.id, 'task', `Cancelled at shutdown: ${prompt.slice(0, 60)}`);
		return task;
	}
	// A jailed bot does not get a running task: it lands as an error carrying the
	// police's reason, which is what the tray shows, and no turn is started at
	// all. The turn loop checks this too - this is the earlier, cheaper refusal.
	const jail = jailStatus(bot);
	if (jail.jailed) {
		finishTask(task.id, 'error', {
			error: `in jail: ${jail.reason} (until ${new Date(jail.until).toISOString()})`
		});
		logActivity(bot.id, 'jail', `Task refused: ${prompt.slice(0, 60)}`);
		return task;
	}
	const controller = new AbortController();
	controllers.set(task.id, controller);
	// The stream and the preview listeners exist before the turn starts, so a
	// caller that subscribes the instant `startTask` returns cannot miss the
	// first event.
	const emitter = new TurnEventEmitter();
	eventStreams.set(task.id, emitter);
	previewListeners.set(task.id, new Set());
	// Announced before the turn's first delta, so a live consumer attaches in
	// time to see the whole reply rather than joining at its tail.
	for (const listener of startListeners) {
		try {
			listener(task);
		} catch {
			// A subscriber's failure is its own; the turn carries on.
		}
	}

	// The steer channel opens now, before the turn has one of its own. The
	// member hooks may be waited on and the session takes real work to build; a
	// correction sent in that window used to be refused, and refusing it here
	// means losing the race to a second task started beside the work in flight.
	// It is held instead, handed to the turn the moment `runBotTurn` offers its
	// channel, and it stays on the unread list until the loop reports the model
	// reading it - so a message the turn never takes, and one it queues and then
	// ends without reading (a budget stop skips the drain), are both answered
	// below rather than acknowledged and dropped.
	/** Steers this task accepted that no provider call has read yet. */
	const unreadSteers: { text: string; origin?: Conversation }[] = [];
	/** One steer read: the caller no longer has to answer it itself. */
	const readSteer = (entry: { text: string; origin?: Conversation }) => {
		const at = unreadSteers.indexOf(entry);
		if (at >= 0) unreadSteers.splice(at, 1);
	};
	let liveSteer: ((text: string, onRead: () => void) => boolean) | undefined;
	steerHandlers.set(task.id, (text, origin) => {
		const entry = { text, origin };
		// Recorded before the hand-off, so a message the turn queues and never
		// reads is still on the list the finally falls back on.
		unreadSteers.push(entry);
		// The steer is in the log the moment it is offered, so the tray can
		// show the human's correction beside the work it is steering.
		logActivity(bot.id, 'steer', `Steered: ${text.slice(0, 120)}`);
		if (!liveSteer) return true;
		if (liveSteer(text, () => readSteer(entry))) return true;
		// The turn refused it: not taken, so the caller starts a task of its own.
		readSteer(entry);
		return false;
	});

	void (async () => {
		let preview = '';
		try {
			// Whatever the caller had to finish first - the chat route's member
			// hooks rewrite the user's message in place, and this turn would
			// otherwise read the text the user typed rather than the hook's.
			// Raced against the abort: a hook can hold for the whole plugin
			// timeout, and a cancel issued while it runs must not be ignored.
			if (opts.ready) {
				const aborted = await Promise.race([
					opts.ready.then(() => false),
					new Promise<true>((resolve) => {
						if (controller.signal.aborted) resolve(true);
						else controller.signal.addEventListener('abort', () => resolve(true), { once: true });
					})
				]);
				if (aborted) {
					finishTask(task.id, 'cancelled', { messageId: '' });
					logActivity(bot.id, 'task', `Cancelled: ${prompt.slice(0, 60)}`);
					return;
				}
			}
			const result = await runBotTurn(conv, bot, {
				// The turn knows which task it is, so a tool cannot cancel the row it
				// is running inside.
				taskId: task.id,
				signal: controller.signal,
				think: opts.think,
				preamble: opts.preamble,
				model: opts.model,
				noTools: opts.noTools,
				// The turn's steer channel: while its session is mid-run this
				// queues a message for the model's next step; once the run settles
				// it refuses, and steerTask's caller falls back to a fresh task.
				// Anything held from before the session existed goes on now, in
				// order, ahead of the loop's first provider call.
				onSteerable: (steer) => {
					liveSteer = steer;
					for (const entry of [...unreadSteers]) {
						steer(entry.text, () => readSteer(entry));
					}
				},
				onUsage: (usage) =>
					addTaskTokens(
						task.id,
						usage.input,
						usage.output,
						{
							read: usage.cacheRead,
							write: usage.cacheWrite,
							reported: usage.cacheReported
						},
						usage.cost
					),
				onEvent: (event) => emitter.emit(event),
				onDelta: (delta) => {
					// The runner keeps the full reply to persist; this copy is only
					// for the tray, so it holds the newest lines and nothing more.
					preview = (preview + delta).slice(-PREVIEW_LIMIT);
					setTaskPreview(task.id, preview);
					// The same tail the tray polls, handed to in-process subscribers
					// so they do not have to poll for it.
					const listeners = previewListeners.get(task.id);
					if (listeners) {
						for (const listener of listeners) {
							try {
								listener({ taskId: task.id, preview, delta });
							} catch {
								// A subscriber's failure is its own; the turn carries on.
							}
						}
					}
				}
			});
			if (result.aborted) {
				// Stopping keeps whatever the model had already written - the reader
				// saw it - so the task points at that message rather than at nothing.
				// A stop that lands before the model wrote anything has no partial
				// to point at, and the empty id is that: nothing was written, so
				// nothing was dropped.
				finishTask(task.id, 'cancelled', { messageId: result.message?.id });
				logActivity(bot.id, 'task', `Cancelled: ${prompt.slice(0, 60)}`);
			} else if (result.message) {
				finishTask(task.id, 'done', { messageId: result.message.id });
				// A budget-stopped turn still counts as done: the reply landed.
				// The turn logs its own line; this one ties the stop to the ask.
				if (result.stoppedBy) {
					logActivity(
						bot.id,
						'budget',
						`Task stopped early (${result.stoppedBy}): ${prompt.slice(0, 60)}`
					);
				}
			} else if (result.silent) {
				// The sentinel is an answer: the bot looked at the wake and chose
				// not to speak. That is a finished task, not an empty reply.
				finishTask(task.id, 'done', {});
			} else if (result.stoppedBy) {
				// Nothing to show because a budget stopped the turn, not because the
				// model said nothing. Blaming the model here sends the reader looking
				// in the wrong place. What the reader does need is what the bot was
				// doing when it ran out, so the error names the work in progress -
				// "it ran out of time while <the last thing it was doing>". Jail is
				// not a budget, and its reason is already the whole story.
				const why = STOP_REASON[result.stoppedBy] ?? result.stoppedBy;
				const doing =
					result.stoppedBy === 'jailed' ? '' : workInProgress(bot.id, task.created_at);
				const reason = `stopped before it replied (${why}${doing ? ` while ${doing}` : ''})`;
				finishTask(task.id, 'error', { error: reason });
				noteRateLimitError(reason);
			} else {
				// Completed with nothing to persist - surface it rather than
				// leaving a task that looks eternally running.
				finishTask(task.id, 'error', { error: 'the model returned nothing' });
				logActivity(bot.id, 'error', 'Task failed: the model returned nothing');
			}
		} catch (e) {
			// Not everything thrown is an Error: an empty reason would leave the
			// tray showing a failed task with nothing to explain it.
			const reason = e instanceof Error ? e.message : String(e);
			finishTask(task.id, 'error', { error: reason });
			logActivity(bot.id, 'error', `Task failed: ${reason}`);
			noteRateLimitError(reason);
		} finally {
			steerHandlers.delete(task.id);
			controllers.delete(task.id);
			// The stream is over: drop it so a late subscriber reads the finished
			// row from the DB rather than waiting on an emitter that will not speak.
			eventStreams.delete(task.id);
			previewListeners.delete(task.id);
			// Every steer still unread was reported as taken, so it has to be
			// answered: the turn died before it could take it, or the run ended
			// with it still queued. It runs as its own task, in the conversation
			// the human sent it from when that is not this turn's own. Started
			// before the waiting subscriber is released, so whoever is watching
			// sees the work that continues rather than a finished row and silence.
			for (const { text, origin } of unreadSteers.splice(0)) {
				startTask(origin ?? conv, bot, text, { context: `steer the turn in "${conv.title}"` });
			}
			// Whoever was waiting on this task gets the finished row; the wait is
			// one-shot, so the entry goes with it.
			const waiter = doneWaiters.get(task.id);
			doneWaiters.delete(task.id);
			if (waiter) waiter(getTask(task.id) ?? task);
		}
	})();

	return task;
}

/**
 * Stop accepting work and abort every running turn, then wait for their final
 * writes - bounded by `drainMs`. A turn's provider socket or retry sleep is a
 * live handle, so without the abort the process would not exit until the turn
 * hit its own ceiling (minutes), and systemd would SIGKILL it first.
 */
export async function stopAllTasks(drainMs: number): Promise<void> {
	accepting = false;
	for (const controller of controllers.values()) controller.abort();
	const drained = Promise.allSettled([...controllers.keys()].map((id) => waitForTask(id)));
	const { promise: expired, resolve: expire } = Promise.withResolvers<null>();
	const deadline = setTimeout(() => expire(null), drainMs);
	await Promise.race([drained, expired]);
	clearTimeout(deadline);
}

/** Stop a running task. Returns false when it had already finished. */
export function cancelTask(id: string): boolean {
	const controller = controllers.get(id);
	if (!controller) return false;
	controller.abort();
	return true;
}

/**
 * Register a running task's abort handle; returns the untrack call for the
 * run's finally. Sub-agent runs are tasks too - created by the spawn_agent
 * tool rather than startTask - and registering their controller is what lets
 * the tray's stop button and the shutdown drain reach them.
 */
export function trackTask(id: string, controller: AbortController): () => void {
	controllers.set(id, controller);
	return () => controllers.delete(id);
}

/**
 * Resolve anyone waiting on a task that finished outside a startTask turn -
 * a sub-agent's row is finished by the helper loop, not the task runner, and
 * the shutdown drain waits on every tracked controller.
 */
export function settleTask(id: string): void {
	const waiter = doneWaiters.get(id);
	doneWaiters.delete(id);
	const row = getTask(id);
	if (waiter && row) waiter(row);
}

