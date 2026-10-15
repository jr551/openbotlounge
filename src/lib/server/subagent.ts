import { addBotTokens, addTaskTokens, createTask, finishTask, logActivity, logEvent, setTaskPreview } from './db';
import { streamChat, estimateUsage, type ChatMessage, type StreamResult } from './llm';
import { BOT_TOOLS, executeTool, toolResultForContext, type ToolContext } from './tools';
import { redactSecrets } from './secrets';
import { settleTask, trackTask } from './tasks';

/**
 * A short-lived helper a bot spawns to fan work out.
 *
 * Where the computer operator (computer-agent.ts) exists to keep raw shell and
 * browser output out of the reply's context, this one exists to parallelise:
 * a bot that needs three things looked up calls spawn_agent three times in one
 * reply and the helpers run at once, each on its own focused brief.
 *
 * The helper gets none of the parent's history - only the task and whatever
 * context the parent chose to paste into the call - and a read-only slice of
 * the toolbox: it can look things up (files, memories, history, the staff
 * board, DeepWiki, its task list) but cannot message anyone, schedule
 * anything, drive the machine, or change any state. It dies after five
 * minutes regardless, and a helper cannot spawn helpers of its own.
 */

/** A helper's hard lifetime: five minutes from spawn, whatever it is doing. */
const MAX_LIFE_MS = 5 * 60_000;

/** Hard ceiling on helper steps, independent of the reply's own budget. */
const MAX_STEPS = 10;

/** How many helpers one bot may have alive at once. */
const MAX_CONCURRENT = 4;

/** The read-only tools a helper may call; everything else is refused. */
const SUBAGENT_TOOL_NAMES: Record<string, true> = {
	recall: true,
	search_history: true,
	list_files: true,
	read_file: true,
	read_lines: true,
	grep_files: true,
	read_output: true,
	deepwiki: true,
	company_profiles: true,
	my_tasks: true,
	my_plugins: true,
	list_secrets: true
};


/** Helpers currently alive, per bot id. */
const inFlight = new Map<string, number>();

/** Drain a streamChat generator, returning its assembled result. */
async function drain(gen: AsyncGenerator<string, StreamResult>): Promise<StreamResult> {
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return value;
	}
}

export interface SubagentOpts {
	botId: string;
	botName: string;
	/** What the helper is to find out or do, in the bot's own words. */
	task: string;
	/** The focused context the bot pasted in; the helper sees nothing else. */
	context?: string;
	model: string;
	signal?: AbortSignal;
	/** Relay depth of the parent turn, carried into the tool context. */
	depth?: number;
	/**
	 * The conversation the helper was spawned in. Progress notes post here as
	 * events - visible in the thread, never an unread or a ping - and the run's
	 * task row hangs off it.
	 */
	conversationId: string;
	/** Lifetime override in ms; the five-minute ceiling unless a test says otherwise. */
	maxLifeMs?: number;
}

/**
 * Run one spawned helper and return its report. Never throws - a failure
 * comes back as text so the bot can say what went wrong rather than the turn
 * dying on a tool error.
 */
export async function runSubagent(opts: SubagentOpts): Promise<string> {
	const task = opts.task.trim();
	if (!task) return 'error: describe what the helper should do';

	const running = inFlight.get(opts.botId) ?? 0;
	if (running >= MAX_CONCURRENT) {
		return `error: you already have ${MAX_CONCURRENT} helpers running - wait for one to report back`;
	}
	inFlight.set(opts.botId, running + 1);

	// The run is a task row like any other background work: the tray lists it
	// while it runs and the detail view opens it after, with the helper's
	// activities read off the same bot log a turn's task would show.
	const row = createTask(opts.conversationId, opts.botId, task, 'subagent', opts.context);
	logActivity(opts.botId, 'subagent', `Spawned a helper: ${task.slice(0, 120)}`);
	logEvent(opts.conversationId, opts.botId, 'subagent', `Spawned a helper: ${task.slice(0, 120)}`);

	// The helper's own clock: five minutes and it dies, whatever it was doing.
	// The parent turn's signal still reaches it - a cancelled reply cancels
	// the helpers it spawned - and the tray's stop button lands on the
	// controller, so all three are combined and which one fired is what the
	// report distinguishes.
	const deadline = AbortSignal.timeout(opts.maxLifeMs ?? MAX_LIFE_MS);
	const controller = new AbortController();
	const untrack = trackTask(row.id, controller);
	const signal = AbortSignal.any(
		[opts.signal, controller.signal].filter((s): s is AbortSignal => !!s).concat(deadline)
	);
	const cancelled = () => !!(opts.signal?.aborted || controller.signal.aborted);

	const brief =
		`You are a helper ${opts.botName} spawned for one task. You have a few ` +
		'read-only tools - you can look things up but cannot message anyone, ' +
		'schedule anything, or change any state. You die five minutes after ' +
		'spawn, so work directly: look up what you need, then answer.\n\n' +
		'Reply with a short report: the answer the bot needs, no preamble. If ' +
		'you cannot find it, say what you tried in one line.';
	const user = opts.context?.trim()
		? `${task}\n\nContext:\n${opts.context.trim()}`
		: task;
	const messages: ChatMessage[] = [
		{ role: 'system', content: brief },
		{ role: 'user', content: user }
	];

	// The helper's tool context: no relay, no runComputer, no spawnAgent - it
	// cannot reach back into the chat or fan out further.
	const ctx: ToolContext = {
		senderBotId: opts.botId,
		senderBotName: opts.botName,
		conversationId: opts.conversationId,
		depth: opts.depth ?? 0,
		signal,
		model: opts.model
	};

	// Resolved inside the run rather than at module init: tools.ts sits in an
	// import cycle (tools -> tasks -> runner -> here), so a top-level read of
	// BOT_TOOLS can see it half-built.
	const tools = BOT_TOOLS.filter((t) => SUBAGENT_TOOL_NAMES[t.function.name]);

	let tokensIn = 0;
	let tokensOut = 0;
	let steps = 0;
	/** The last thing the helper said, kept so a timeout can hand back a partial answer. */
	let partial = '';
	/** The tray's sliding tail of the run: what the helper is doing, newest last. */
	let preview = '';
	const note = (line: string) => {
		preview = (preview + line).slice(-400);
		setTaskPreview(row.id, preview);
	};

	const timedOut = (report: string) =>
		`The helper ran out of its five minutes${report ? `; before that it said: ${report}` : '.'}`;

	// Every way out lands the task row first: the report is the preview the
	// detail view shows, and a run that died early is an error row rather than
	// a finished one.
	const finish = (report: string, failed = false): string => {
		setTaskPreview(row.id, report);
		finishTask(
			row.id,
			cancelled() ? 'cancelled' : failed ? 'error' : 'done',
			{ error: failed ? report : '' }
		);
		return report;
	};

	try {
		for (;;) {
			if (cancelled()) return finish('The helper was cancelled.');
			if (deadline.aborted) return finish(timedOut(partial), true);
			if (steps >= MAX_STEPS) {
				return finish(
					`The helper hit its ${MAX_STEPS}-step limit without finishing` +
						(partial ? `; before that it said: ${partial}` : '.'),
					true
				);
			}
			steps++;

			let result: StreamResult;
			try {
				result = await drain(
					streamChat({
						model: opts.model,
						messages,
						signal,
						tools
					})
				);
			} catch (e) {
				if (cancelled()) return finish('The helper was cancelled.');
				if (deadline.aborted) return finish(timedOut(partial), true);
				throw e;
			}
			const usage = result.usage ?? estimateUsage(messages, result.text, tools);
			tokensIn += usage.input;
			tokensOut += usage.output;
			addTaskTokens(row.id, usage.input, usage.output, {
				read: usage.cacheRead,
				write: usage.cacheWrite,
				reported: usage.cacheReported
			}, usage.cost);

			if (result.truncated) {
				// A partial tool call cannot be trusted to run, so the helper
				// reports the cut rather than executing a mangled argument.
				const cut = redactSecrets(opts.botId, result.text.trim());
				return finish(
					'The helper was cut off mid-reply by the provider stream' +
						(cut ? `; before that it said: ${cut}` : '.'),
					true
				);
			}

			if (!result.toolCalls.length) {
				return finish(
					redactSecrets(opts.botId, result.text.trim()) ||
						'(the helper finished without a report)'
				);
			}

			if (result.text.trim()) {
				partial = result.text.trim();
				note(partial + '\n');
			}
			messages.push({ role: 'assistant', content: result.text, tool_calls: result.toolCalls });
			for (const call of result.toolCalls) {
				// The advertised set is the contract, but the dispatch runs any
				// name it knows - a helper that hallucinates send_message must be
				// refused here, not just never offered the tool.
				const out = SUBAGENT_TOOL_NAMES[call.function.name]
					? await executeTool(call.function.name, call.function.arguments, ctx)
					: `error: helpers cannot use ${call.function.name} - your tools are read-only`;
				note(`→ ${call.function.name.replace(/_/g, ' ')}\n`);
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content: toolResultForContext(call.id, out)
				});
			}
		}
	} catch (e) {
		if (cancelled()) return finish('The helper was cancelled.');
		if (deadline.aborted) return finish(timedOut(partial), true);
		const msg = e instanceof Error ? e.message : String(e);
		return finish(`The helper failed: ${msg}`, true);
	} finally {
		untrack();
		inFlight.set(opts.botId, (inFlight.get(opts.botId) ?? 1) - 1);
		// The helper's spend is the bot's spend.
		settleTask(row.id);
		if (tokensIn || tokensOut) addBotTokens(opts.botId, tokensIn, tokensOut);
	}
}
