import { addBotTokens, logActivity, logEvent, recordSiteObservation } from './db';
import { streamChat, estimateUsage, type ChatMessage, type StreamResult } from './llm';
import { BROWSER_TOOLS, executeTool, type ToolContext } from './tools';
import { carriesImage, isVisionRefusal, shotMessage } from './computer-agent';
import { visionModel } from './police';
import { redactSecrets } from './secrets';

/**
 * A bounded worker that drives a bot's browser on its behalf.
 *
 * The main reply loop never touches the browser directly: web tasks are
 * delegated here so a multi-page read or a form fill runs inside its own tool
 * loop and only a short report comes back. Where the computer operator sees
 * pixels, this agent reads the page as text - the walk's title, URL, visible
 * text and numbered elements - so a model with no vision can still browse,
 * and the pixel path (screen_look plus the shared mouse/keyboard tools) stays
 * a fallback for what the DOM cannot name.
 *
 * The sub-agent gets only the browser tools - no shell, no desktop setup, no
 * way back into the chat - and it runs under the same model and abort signal
 * as the turn that spawned it, so cancelling the reply cancels the browsing
 * too.
 */

/** Hard ceiling on sub-agent steps, independent of the reply's own budget. */
const MAX_STEPS = 16;

/** Drain a streamChat generator, returning its assembled result. */
async function drain(gen: AsyncGenerator<string, StreamResult>): Promise<StreamResult> {
	for (;;) {
		const { value, done } = await gen.next();
		if (done) return value;
	}
}

export interface BrowserTaskOpts {
	botId: string;
	botName: string;
	/** What the bot wants done on the web, in its own words. */
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
 * Run one delegated browser task and return the sub-agent's report.
 * Never throws - a failure comes back as text so the bot can say what went
 * wrong rather than the turn dying on a tool error.
 */
export async function runBrowserTask(opts: BrowserTaskOpts): Promise<string> {
	const goal = opts.goal.trim();
	if (!goal) return 'error: describe what the browser should do';

	logActivity(opts.botId, 'browser', `Delegated: ${goal.slice(0, 120)}`);

	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				`You are ${opts.botName}'s browser operator. You drive the browser ` +
				'on their machine - a real Chromium on a desktop the person can ' +
				'watch - and you read pages as text, not pixels. Do the task below, ' +
				'then stop.\n\n' +
				'How you see a page: every tool that touches the page answers with ' +
				'the walk - the title, the URL it is on, the text visible on ' +
				'screen, and a numbered list of the links, buttons and fields near ' +
				'the viewport. That list is how you act: browser_click and ' +
				'browser_fill take an element number, browser_scroll moves the ' +
				'page, browser_back goes back, browser_press hits a key, and ' +
				'browser_walk re-reads without changing anything.\n\n' +
				'Rules:\n' +
				'- Start with browser_navigate on the URL the task names, or on a ' +
				'search engine when it names none. Read what comes back before ' +
				'acting - the answer is often already in the text.\n' +
				'- Element numbers go stale the moment the page changes. Click or ' +
				'fill only numbers from the LAST page view; if one comes back "no ' +
				'element", walk again for fresh numbers.\n' +
				'- Scroll before concluding: the walk only covers what is near the ' +
				'viewport, and the page view says when more sits below. Scroll ' +
				'down, read, scroll again - do not report "not on the page" until ' +
				'you have seen the bottom.\n' +
				'- Cookie banners, consent walls and popups come first: click their ' +
				'accept/reject/close element (or press escape) before reading what ' +
				'is behind them. Do it once; a banner that survives one dismissal ' +
				'is part of the page, not a wall.\n' +
				'- Forms: fill each field by number, then press enter or click the ' +
				'submit element. Search boxes usually submit on enter.\n' +
				'- A click that navigates returns the new page - check the URL line ' +
				'to see where you actually landed, and use browser_back when a turn ' +
				'was wrong.\n' +
				'- The pixel path is the fallback, not the default: screen_look ' +
				'shows the screen with a labelled coordinate grid, and ' +
				'mouse_click, mouse_move, mouse_scroll, type_text and key_press ' +
				'act at pixel coordinates off it. Reach for it only for what the ' +
				'walk cannot name - a canvas game, a drawn widget, a map. Every ' +
				'pixel action spends the look, so look again before the next one.\n' +
				'- send_screenshot posts a picture into the chat when the task is to ' +
				'show the person something; you get no pixels back from it.\n' +
				'- Do not fight walls: a login you were not given credentials for, a ' +
				'captcha, a paywall, or a page that stays blank after a navigate ' +
				'and a walk is a finding - report it and stop rather than ' +
				'clicking around it.\n' +
				'- Stay on the task: follow links that serve the goal, never sign ' +
				'up, buy, post or agree to anything the task did not name.\n' +
				'- The first navigate after a wake can wait while the desktop ' +
				'installs; if it says the browser is not up yet, wait and retry ' +
				'rather than giving up.\n' +
				'- Report what the tools actually returned, quoted verbatim when it ' +
				'looks odd. Never invent a page, a price or an error no tool ' +
				'showed you - the bot will repeat it to the human.\n' +
				'- When the task is done, reply with a short report: what you found ' +
				'or did and the URL it came from. If you cannot do it, say why in ' +
				'one line.'
		},
		{ role: 'user', content: goal }
	];

	// The sub-agent's tool context: it can only reach the browser tools, so
	// the fields those never read are inert. No runBrowser - it cannot
	// re-delegate - and toolbox:'browser' keeps the shell out of reach. The
	// conversation is carried so send_screenshot can post into the thread the
	// task was asked in.
	const ctx: ToolContext = {
		senderBotId: opts.botId,
		senderBotName: opts.botName,
		conversationId: opts.conversationId ?? '',
		depth: opts.depth ?? 0,
		signal: opts.signal,
		model: opts.model,
		toolbox: 'browser'
	};

	let tokensIn = 0;
	let tokensOut = 0;
	let steps = 0;

	try {
		for (;;) {
			if (opts.signal?.aborted) return 'The browser task was cancelled.';
			if (steps >= MAX_STEPS) {
				logActivity(
					opts.botId,
					'subagent',
					`Browser sub-agent hit its ${MAX_STEPS}-step limit: ${goal.slice(0, 80)}`
				);
				return `The browser task hit its ${MAX_STEPS}-step limit without finishing.`;
			}
			steps++;

			let result: StreamResult;
			try {
				result = await drain(
					streamChat({
						model: opts.model,
						messages,
						signal: opts.signal,
						tools: BROWSER_TOOLS
					})
				);
			} catch (e) {
				// The vision fallback, same as the computer operator's: a model
				// that cannot take image input gets a call carrying a screen_look
				// picture retried through the vision model, which has been checked
				// against an image before it was stored. Only a refusal of the
				// image itself reroutes - a text-only step never leaves the bot's
				// model.
				const msg = e instanceof Error ? e.message : String(e);
				if (!carriesImage(messages) || !isVisionRefusal(msg)) throw e;
				logActivity(
					opts.botId,
					'browser',
					'Its model cannot see screenshots - asking the vision model to look'
				);
				result = await drain(
					streamChat({
						model: visionModel(),
						messages,
						signal: opts.signal,
						tools: BROWSER_TOOLS
					})
				);
			}
			const usage = result.usage ?? estimateUsage(messages, result.text, BROWSER_TOOLS);
			tokensIn += usage.input;
			tokensOut += usage.output;
			if (result.truncated) {
				// A partial tool call cannot be trusted to run, so the task
				// reports the cut rather than executing a mangled action.
				const partial = redactSecrets(opts.botId, result.text.trim());
				logActivity(
					opts.botId,
					'subagent',
					`Browser sub-agent's stream was cut off: ${result.error || 'provider stream truncated'}`
				);
				return (
					'The browser task was cut off mid-reply by the provider stream' +
					(partial ? `; before that it said: ${partial}` : '.')
				);
			}

			if (!result.toolCalls.length) {
				// The report can quote a page that holds a secret; mask it here,
				// the same way the shell tool does.
				return (
					redactSecrets(opts.botId, result.text.trim()) ||
					'(the browser task finished without a report)'
				);
			}

			messages.push({ role: 'assistant', content: result.text, tool_calls: result.toolCalls });
			for (const call of result.toolCalls) {
				const out = await executeTool(call.function.name, call.function.arguments, ctx);
				messages.push({ role: 'tool', tool_call_id: call.id, content: out });
				// The actor's trail feeds the site documenter: every tool call
				// on the domain the browser is on lands as an observation row,
				// so the note it writes reflects what actually worked here.
				if (ctx.currentDomain) {
					recordSiteObservation(
						ctx.currentDomain,
						opts.botId,
						`${call.function.name} ${call.function.arguments}`,
						out
					);
				}
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
						'browser',
						`Still on it - ${call.function.name.replace(/_/g, ' ')} (step ${steps})`
					);
				}
			}
		}
	} catch (e) {
		if (opts.signal?.aborted) return 'The browser task was cancelled.';
		const msg = e instanceof Error ? e.message : String(e);
		// The feed gets the real error, not just the bot's paraphrase of it.
		logActivity(opts.botId, 'subagent', `Browser sub-agent failed: ${msg}`);
		return `The browser task failed: ${msg}`;
	} finally {
		// The sub-agent's spend is the bot's spend.
		if (tokensIn || tokensOut) addBotTokens(opts.botId, tokensIn, tokensOut);
	}
}
