import { readFileSync } from 'node:fs';
import { addBotTokens, logActivity, logEvent } from './db';
import { streamChat, estimateUsage, type ChatMessage, type StreamResult } from './llm';
import { COMPUTER_TOOLS, executeTool, SCREEN_GRID_PX, type ToolContext } from './tools';
import { machineScreenshot } from './machine';
import { MACHINE_PACKAGES } from './machine-packages';
import { visionModel } from './police';
import { redactSecrets } from './secrets';

/**
 * A bounded worker that drives a bot's computer on its behalf.
 *
 * The main reply loop never touches the sandbox directly: shell and browser
 * actions are delegated here so a long command or a multi-step page task runs
 * inside its own tool loop and only a short report comes back. That keeps the
 * bot's conversation context free of raw command output and stops one slow
 * exec from stalling the whole reply.
 *
 * The sub-agent gets only the computer tools - it cannot message other bots,
 * schedule work, or reach back into the chat - and it runs under the same
 * model and abort signal as the turn that spawned it, so cancelling
 * the reply cancels the computer work too. Its system prompt ends with the
 * field guide (COMPUTER_GUIDE.md): the standing notes on installing software,
 * driving GUI apps and playing games by vision.
 */


/**
 * What a provider says when the model cannot take image input: the request
 * was refused for carrying a picture, not for anything else that can fail.
 * The words come from the providers' own error bodies - "does not support
 * image", "images are not supported", "not a vision model", "unsupported
 * modality" - matched in either order so "unsupported image input" and
 * "image input is not supported" both land. A generic failure never matches:
 * the fallback is for capability, not for a bad day.
 */
const VISION_REFUSAL_RE =
	/(image|vision|multimodal|modalit\w+|input_image|image_url)[\w\s'".-]{0,60}(not supported|unsupported|not allowed|not a|cannot|can't|unable|refus\w+|invalid|do not support|does not support|no support)|(not supported|unsupported|not allowed|not a|cannot|can't|unable|refus\w+|invalid|do not support|does not support|no support)[\w\s'".-]{0,60}(image|vision|multimodal|modalit\w+|input_image|image_url)/i;

/** Whether a provider error is the model refusing image content specifically. */
export function isVisionRefusal(message: string): boolean {
	return VISION_REFUSAL_RE.test(message);
}

/** Whether any message in the call carries an image part. */
export function carriesImage(messages: ChatMessage[]): boolean {
	return messages.some(
		(m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
	);
}

/** A screenshot message for the model: the grid-labelled frame plus its legend. */
export function shotMessage(b64: string): ChatMessage {
	return {
		role: 'user',
		content: [
			{
				type: 'text',
				text:
					`Current desktop screenshot. Red gridlines every ${SCREEN_GRID_PX} ` +
					'pixels carry their coordinate in yellow - name x,y from those ' +
					'labels when you click, move or scroll.'
			},
			{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
		]
	};
}


/** Hard ceiling on sub-agent steps, independent of the reply's own budget. */
const MAX_STEPS = 30;

/** Drain a streamChat generator, returning its assembled result. */
async function drain(gen: AsyncGenerator<string, StreamResult>): Promise<StreamResult> {
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return value;
	}
}

export interface ComputerTaskOpts {
	botId: string;
	botName: string;
	/** What the bot wants done, in its own words. */
	goal: string;
	model: string;
	signal?: AbortSignal;
	/** Relay depth of the parent turn, carried into the tool context. */
	depth?: number;
	/**
	 * The conversation the task was asked in. Progress notes post here as
	 * events - visible in the thread, never an unread or a ping.
	 */
	conversationId?: string;
}

/**
 * The operator's field guide, read off disk once: the standing notes on
 * installing packages, launching GUI apps and playing games by vision that
 * the sub-agent's system prompt ends with. It ships at the repo root next to
 * GOOD_USE_GUIDE.md and is read the same way; a missing file leaves an empty
 * guide rather than a dead task.
 */
let computerGuide: string | undefined;
function computerGuideText(): string {
	if (computerGuide === undefined) {
		try {
			computerGuide = readFileSync('COMPUTER_GUIDE.md', 'utf8');
		} catch {
			computerGuide = '';
		}
	}
	return computerGuide;
}

/**
 * Run one delegated computer task and return the sub-agent's report.
 * Never throws - a failure comes back as text so the bot can say what went
 * wrong rather than the turn dying on a tool error.
 */
export async function runComputerTask(opts: ComputerTaskOpts): Promise<string> {
	const goal = opts.goal.trim();
	if (!goal) return 'error: describe what the computer should do';

	logActivity(opts.botId, 'computer', `Delegated: ${goal.slice(0, 120)}`);

	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				`You are ${opts.botName}'s computer operator. You drive their ` +
				'machine: one Alpine Linux box with a terminal (shell_exec with ' +
				'machine:"shell" types into the pane the person watches; ' +
				'machine:"desktop" runs quietly) and a desktop you can set up and ' +
				'drive (setup_desktop picks the window manager and browser). ' +
				'It mounts /shared, and /company is a drive every bot shares. Do the ' +
				'task below with the fewest commands that get it done, then stop.\n\n' +
				'Rules:\n' +
				'- Reading the web is not your job: the bot has a separate browser ' +
				'operator for that. If the task is to open, visit, read or use a ' +
				'website, report that it needs the browser tool (browse) and stop ' +
				'- do not curl a page just to read it.\n' +
				'- browser_screenshot puts a picture on the person\'s screen panel; ' +
				'you get no pixels back, so it can never tell you what a page says.\n' +
				'- send_screenshot sends a picture into the chat the person reads, ' +
				'optionally of just part of the screen (a pixel rectangle). Use it ' +
				'when the task is to show the person something; you still get no ' +
				'pixels back.\n' +
				'- You see the desktop: a fresh screenshot with a labelled ' +
				'coordinate grid is fed to you each step, and screen_look takes ' +
				'another mid-step. mouse_click, mouse_move, mouse_scroll, ' +
				'type_text and key_press drive the real desktop at pixel ' +
				'coordinates you read off the grid. They refuse until you have ' +
				'looked, and every action spends that look - act once, then look ' +
				'again before the next action.\n' +
				'- Games and other live screens are played by that same loop: ' +
				'look, act, look again. Read coordinates off the grid labels, ' +
				'prefer key_press for anything real-time, and keep cycling until ' +
				'the task is done rather than declaring it unplayable.\n' +
				'- Prefer one shell command over several; chain with && when order matters.\n' +
				'- To read a /company file use company_read - it pages. cat/sed/grep are ' +
				'fine for searching but never for dumping whole files.\n' +
				`- The box already has ${MACHINE_PACKAGES.join(', ')} plus BusyBox ` +
				'core tools. Install whatever else the task needs: apk add ' +
				'--no-cache for Alpine packages (apk search finds the name), ' +
				'curl/wget for static binaries, pip/npm for language tools. ' +
				'"command not found" means install it, not report it missing - ' +
				'never refuse a task for software you have not tried to install.\n' +
				'- When the task is done, reply with a short report: what you did and the ' +
				'result the bot needs. No preamble, no command echo.\n' +
				'- The network reaches the web only through the HTTP proxy already set in ' +
				'the environment: curl and wget work for APIs, raw endpoints and ' +
				'downloads. ping, traceroute, dig and ' +
				'other ICMP/raw tools can never work - do not retry them. For a latency ' +
				'check use curl -w time_total.\n' +
				'- A command that comes back "still running" is done being waited on: ' +
				'report the partial output it gave you and stop. Never retry the same ' +
				'command, and never send sleep or probe commands to check on it - the ' +
				'output so far is on the machine screen and that is the answer.\n' +
				'- Report what the tools actually returned, quoted verbatim when it ' +
				'looks odd. Never invent an explanation the tool did not give - a ' +
				'"the police refused it" or "the machine is down for maintenance" ' +
				'that no tool result said is a lie the bot will repeat to the human.\n' +
				'- If the machine or Docker itself is unavailable, report that once and ' +
				'stop - retrying cannot fix it.\n' +
				'- If you cannot do it, say why in one line.\n\n' +
				`Field guide:\n${computerGuideText() || '(the guide is missing - work from the rules above)'}`
		},
		{ role: 'user', content: goal }
	];

	// The sub-agent's tool context: it can only reach the computer tools, so the
	// fields those never read are inert. No runComputer - it cannot re-delegate -
	// and toolbox:'computer' keeps the page-walk tools out of reach. The
	// conversation is carried so send_screenshot can post into the thread
	// the task was asked in.
	const ctx: ToolContext = {
		senderBotId: opts.botId,
		senderBotName: opts.botName,
		conversationId: opts.conversationId ?? '',
		depth: opts.depth ?? 0,
		signal: opts.signal,
		model: opts.model,
		toolbox: 'computer'
	};
	let tokensIn = 0;
	let tokensOut = 0;
	let steps = 0;

	try {
		for (;;) {
			if (opts.signal?.aborted) return 'The computer task was cancelled.';
			if (steps >= MAX_STEPS) {
				const detail = `Computer sub-agent hit its ${MAX_STEPS}-step limit: ${opts.goal.slice(0, 80)}`;
				logActivity(opts.botId, 'subagent', detail);
				return `The computer task hit its ${MAX_STEPS}-step limit without finishing.`;
			}
			steps++;

			// Vision per step: the model acts on what the screen looks like now,
			// not on what it remembers. The shot carries the coordinate grid the
			// input tools' x,y arguments are read off, and taking it is what
			// re-arms them - a bot with no desktop gets a text-only step instead
			// of a failed one.
			ctx.screenSeen = false;
			try {
				const shot = await machineScreenshot(opts.botId, undefined, SCREEN_GRID_PX);
				if (shot) {
					messages.push(shotMessage(shot));
					ctx.screenSeen = true;
				}
			} catch {
				// No desktop yet, or a terminal-only machine: the step still runs,
				// just without eyes - the input tools will refuse on their own.
			}

			let result: StreamResult;
			try {
				result = await drain(
					streamChat({
						model: opts.model,
						messages,
						signal: opts.signal,
						tools: COMPUTER_TOOLS
					})
				);
			} catch (e) {
				// The vision fallback: a model that cannot take image input gets
				// this call retried through the vision model - the console's own
				// pick, which has been checked against an image before it was
				// stored. Only a refusal of the image itself reroutes - any other
				// failure is the task's to report, and a text-only step never
				// leaves the bot's model.
				const msg = e instanceof Error ? e.message : String(e);
				if (!carriesImage(messages) || !isVisionRefusal(msg)) throw e;
				logActivity(
					opts.botId,
					'computer',
					'Its model cannot see screenshots - asking the vision model to look'
				);
				result = await drain(
					streamChat({
						model: visionModel(),
						messages,
						signal: opts.signal,
						tools: COMPUTER_TOOLS
					})
				);
			}
			const usage = result.usage ?? estimateUsage(messages, result.text, COMPUTER_TOOLS);
			tokensIn += usage.input;
			tokensOut += usage.output;

			if (result.truncated) {
				// The same refusal the reply loop makes: a partial tool call cannot
				// be trusted to run, so the task reports the cut rather than
				// executing a mangled command.
				const partial = redactSecrets(opts.botId, result.text.trim());
				logActivity(
					opts.botId,
					'subagent',
					`Computer sub-agent's stream was cut off: ${result.error || 'provider stream truncated'}`
				);
				return (
					'The computer task was cut off mid-reply by the provider stream' +
					(partial ? `; before that it said: ${partial}` : '.')
				);
			}

			if (!result.toolCalls.length) {
				// The sub-agent has the bot's shell, so its report can quote a
				// secret; mask it here, the same way the shell tool does.
				return (
					redactSecrets(opts.botId, result.text.trim()) ||
					'(the computer task finished without a report)'
				);
			}

			messages.push({ role: 'assistant', content: result.text, tool_calls: result.toolCalls });
			for (const call of result.toolCalls) {
				const out = await executeTool(call.function.name, call.function.arguments, ctx);
				messages.push({ role: 'tool', tool_call_id: call.id, content: out });
				// screen_look leaves its picture on the context rather than in
				// the tool result: the image rides a user message of its own, so
				// the model sees the screen it just asked for.
				if (ctx.pendingShot) {
					messages.push(shotMessage(ctx.pendingShot));
					ctx.pendingShot = undefined;
				}
				// A long task reads as the bot having wandered off; a short note
				// every few steps says it is still on it. Events, not messages -
				// they show in the thread without an unread count or a ping.
				if (opts.conversationId && steps % 3 === 0) {
					logEvent(
						opts.conversationId,
						opts.botId,
						'computer',
						`Still on it - ${call.function.name.replace(/_/g, ' ')} (step ${steps})`
					);
				}
			}
		}
	} catch (e) {
		if (opts.signal?.aborted) return 'The computer task was cancelled.';
		const msg = e instanceof Error ? e.message : String(e);
		// The failure is the sub-agent's, not the bot's paraphrase of it: the
		// feed gets the real error so a broken driver or a refused image is
		// diagnosable without reading the chat.
		logActivity(opts.botId, 'subagent', `Computer sub-agent failed: ${msg}`);
		return `The computer task failed: ${msg}`;
	} finally {
		// The sub-agent's spend is the bot's spend.
		if (tokensIn || tokensOut) addBotTokens(opts.botId, tokensIn, tokensOut);
	}
}
