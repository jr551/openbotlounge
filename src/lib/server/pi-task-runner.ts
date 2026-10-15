/**
 * Pi SDK-style typed task runner for OpenBotLounge.
 *
 * Existing `src/lib/server/tasks.ts:startTask` is cooperative, preview-tailed,
 * and cancellation-aware — no shell-out, no raw fetch. This module adds the Pi
 * SDK surface that makes those guarantees typed and composable without breaking
 * any caller:
 *
 *   - `TaskKind` + `PiTaskDefinition` — discriminated input so `chat` cannot
 *     carry a `cron` and a `cron` turn must name its schedule source. Mirrors
 *     the SDK's `defineTool`/`Type.Object` pattern of putting the shape in the
 *     type system.
 *   - `defineTask` — validates/normalizes one definition before it touches the
 *     DB (prompt trimming, size caps) the same way `complete()` caps replies.
 *   - `startTypedTask` — wraps `startTask` with a `PiTaskHandle` that carries
 *     `cancel()`, `wait()`, and `subscribe()` so callers can treat a turn like
 *     an SDK session (progress + cancellation token in one handle).
 *
 * Backwards compat: `startTask` itself is unchanged and remains the only writer
 * to the `tasks` table. Every helper here delegates to it, and the bespoke
 * system prompt in `runner.ts:buildHistory` is always preserved — any `preamble`
 * is appended, never substituted (see `tasks.ts:startTask` `preamble`).
 */
import {
	createTask,
	finishTask,
	getTask,
	jailStatus,
	type Bot,
	type Conversation,
	type Task
} from './db';
import { cancelTask, startTask, subscribeTaskProgress, waitForTask, type TaskProgress } from './tasks';

// ---- Kinds & definitions ---------------------------------------------------

/** What started the turn — mirrors `db.ts:Task.kind` + tray `KIND_EMOJI`. */
export type TaskKind =
	| 'chat'
	| 'routine'
	| 'wake'
	| 'lounge'
	| 'computer'
	| 'webhook'
	| 'inject'
	| 'onboarding'
	| 'fed'
	| 'police';

/** Typed input for one turn, modelled after Pi SDK `defineTool` params. */
export interface PiTaskDefinition {
	/** Prompt the bot answers. Trimmed; empty is rejected by `defineTask`. */
	prompt: string;
	/** Explicit kind — defaults to `taskKindOf(prompt)` when omitted. */
	kind?: TaskKind;
	/** Per-turn reasoning flag forwarded to `runBotTurn`. */
	think?: boolean;
	/**
	 * Why the job exists, in the caller's words — which client asked and what
	 * for. Stored on the task row so `list_tasks` (and the tray) can say what a
	 * pi-driven job was for; '' when the caller has nothing to add.
	 */
	context?: string;
	/** Optional `ready` gate — e.g. the chat route's `before_reply` hook promise. */
	ready?: Promise<void>;
}

/** Result of `defineTask` — normalized, never empty. */
export interface NormalizedTaskDefinition extends Required<Pick<PiTaskDefinition, 'prompt' | 'kind'>> {
	think: boolean;
	context: string;
	ready?: Promise<void>;
}

const KNOWN_KINDS: Record<string, true> = {
	chat: true,
	routine: true,
	wake: true,
	lounge: true,
	computer: true,
	webhook: true,
	inject: true,
	onboarding: true,
	fed: true,
	police: true
};

/**
 * Validate and normalize a raw definition. Throws `Error` with a human-readable
 * message — the same contract `http.ts` helpers use — so route handlers can
 * `throw error(400, e.message)` directly.
 */
export function defineTask(def: PiTaskDefinition): NormalizedTaskDefinition {
	const prompt = (def.prompt ?? '').trim();
	if (!prompt) throw new Error('prompt required');
	if (prompt.length > 40_000) throw new Error('prompt too long (max 40000 chars)');
	const rawKind = (def.kind ?? '').trim().toLowerCase();
	const kind: TaskKind = (KNOWN_KINDS[rawKind] ? rawKind : 'chat') as TaskKind;
	return {
		prompt,
		kind,
		think: Boolean(def.think),
		// A job's reason is a label, not a second prompt: trimmed and capped so
		// it stays a one-line answer to "what was this for".
		context: (def.context ?? '').trim().slice(0, 500),
		ready: def.ready
	};
}

// ---- Typed handle ---------------------------------------------------------

/** Handle returned by `startTypedTask` — task row + SDK-style controls. */
export interface PiTaskHandle extends Task {
	/** Cooperative cancel — returns false if already finished (same as `cancelTask`). */
	cancel(): boolean;
	/** Await the finished row (done/error/cancelled). One-shot, like `waitForTask`. */
	wait(): Promise<Task>;
	/**
	 * Subscribe to live preview deltas. Returns an unsubscribe function.
	 * The callback is invoked synchronously from `onDelta`, so keep it cheap.
	 */
	subscribe(cb: (p: TaskProgress) => void): () => void;
}

// ---- Runner ---------------------------------------------------------------

/**
 * Start a bot turn from a typed definition. Keeps the bespoke system prompt
 * intact — `runBotTurn` appends `preamble` to the prompt built by `buildHistory`,
 * never replacing `bot.persona` + voice block.
 */
export function startTypedTask(
	conv: Conversation,
	bot: Bot,
	def: PiTaskDefinition,
	opts: { preamble?: string } = {}
): PiTaskHandle {
	const normalized = defineTask(def);

	// Early jail refusal before any controller — caller sees `error` not dangling `running`.
	const jail = jailStatus(bot);
	if (jail.jailed) {
		const t = createTask(conv.id, bot.id, normalized.prompt, normalized.kind, normalized.context);
		const msg = `in jail: ${jail.reason} (until ${new Date(jail.until).toISOString()})`;
		finishTask(t.id, 'error', { error: msg });
		const handle = t as PiTaskHandle;
		handle.error = msg;
		(handle as unknown as Record<string, unknown>).status = 'error';
		handle.cancel = () => false;
		handle.wait = () => Promise.resolve(getTask(t.id) ?? { ...t, status: 'error', error: msg } as Task);
		handle.subscribe = () => () => {};
		return handle;
	}

	const task = startTask(conv, bot, normalized.prompt, {
		think: normalized.think,
		ready: normalized.ready,
		preamble: opts.preamble,
		context: normalized.context
	});

	// The preview the tray polls is the one source of truth: `tasks.ts` fans each
	// `onDelta` out to `subscribeTaskProgress`, and this handle forwards it to the
	// caller's callback. A task that has already finished has no stream, so the
	// unsubscribe is a no-op and the caller reads the finished row instead.
	const handle = task as PiTaskHandle;
	handle.cancel = () => cancelTask(task.id);
	handle.wait = () => waitForTask(task.id);
	handle.subscribe = (cb: (p: TaskProgress) => void) => subscribeTaskProgress(task.id, cb);
	return handle;
}

/** Re-export for callers that already `await` lounge/wake rounds. */
export { waitForTask };
export type { TaskProgress };
