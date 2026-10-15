import { addBotTokens, addMessage, db, logActivity, logEvent, setMemory } from './db';
import { streamChat, estimateUsage, type ChatMessage, type StreamResult } from './llm';
import { redactSecrets } from './secrets';
import { listActivities, listMessages, listMemories, pendingFeedback, getBot } from './db';
import { policeModel, meterPoliceCall } from './police';
import { IMPROVEMENT_PLAN_KEY } from './police';

/**
 * The improvement expert: a specialist sub-agent that reviews a bot's recent
 * feedback, activity and messages, and writes a detailed improvement plan.
 *
 * Unlike the generic spawn_agent helper, this one always runs on the police
 * model - the fleet's judgment brain - because the whole point is an outside
 * read on what the bot got wrong. It sees the bot's own record, not just a
 * pasted brief: the messages it sent, the activities it logged, the feedback
 * the human left, and the standing plan it is already under.
 *
 * The plan lands as a collapsed system bubble in the bot's chat (kind 'event',
 * so it reads as a quiet note, not a message), and is stored under
 * IMPROVEMENT_PLAN_KEY so the bot's next turn sees it in its memory block.
 */

/** How many recent messages/activities the expert reads. */
const EVIDENCE_LIMIT = 40;
/** Hard ceiling on expert steps; it should need one or two. */
const MAX_STEPS = 3;

/** Drain a streamChat generator, returning its assembled result. */
async function drain(gen: AsyncGenerator<string, StreamResult>): Promise<StreamResult> {
	let result: StreamResult | undefined;
	for (;;) {
		const next = await gen.next();
		if (next.done) {
			result = next.value;
			break;
		}
	}
	if (!result) throw new Error('stream ended without a result');
	return result;
}

/**
 * The evidence bundle: what the bot has been doing and what the human thought
 * of it, assembled from the app's own rows. No model call is spent gathering
 * it - the rows are already there.
 */
function evidenceBundle(botId: string): string {
	const bot = getBot(botId);
	if (!bot) return '';
	const parts: string[] = [];

	// The human's unreads: the feedback the bot has not been told about yet.
	const feedback = pendingFeedback(botId, 10);
	if (feedback.length) {
		parts.push(
			'## Human feedback (not yet seen by the bot)\n' +
				feedback.map((f) => `- ${f.rating > 0 ? '👍' : '👎'} "${f.snippet}"`).join('\n')
		);
	}

	// The bot's recent messages: what it actually said.
	const messages = db
		.prepare('SELECT content FROM messages WHERE bot_id = ? AND role = \'assistant\' ORDER BY created_at DESC LIMIT ?')
		.all(botId, EVIDENCE_LIMIT) as { content: string }[];
	if (messages.length) {
		parts.push(
			'## Recent replies\n' +
				messages.map((m) => `- "${m.content.slice(0, 120).replace(/\n/g, ' ')}"`).join('\n')
		);
	}

	// The activity log: what it actually did.
	const acts = listActivities(botId, EVIDENCE_LIMIT);
	if (acts.length) {
		parts.push(
			'## Recent activity\n' +
				acts.map((a) => `- ${a.kind}: ${a.detail.slice(0, 100).replace(/\n/g, ' ')}`).join('\n')
		);
	}

	// The standing plan, if one exists.
	const plan = listMemories(botId).find((m) => m.key === IMPROVEMENT_PLAN_KEY)?.value;
	if (plan) {
		parts.push(`## Standing improvement plan\n${plan}`);
	}

	return parts.join('\n\n') || '(no evidence yet - the bot is new)';
}

/**
 * Run the improvement expert on a bot. Returns the plan text, or an error
 * string the bot can report. Never throws - a failure comes back as text.
 */
export async function runImprovementExpert(opts: {
	botId: string;
	botName: string;
	/** What the bot asked for help with, in its own words. */
	goal: string;
	/** The conversation the plan posts into. */
	conversationId: string;
	signal?: AbortSignal;
}): Promise<string> {
	const model = policeModel();
	if (!model) return 'error: no police model configured - the improvement expert cannot run';

	logActivity(opts.botId, 'improve', `Improvement review: ${opts.goal.slice(0, 120)}`);

	const evidence = evidenceBundle(opts.botId);
	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				`You are the improvement expert for ${opts.botName}, a chat bot. Your job is to ` +
				'read the evidence below and write a detailed, honest improvement plan.\n\n' +
				'The plan must be specific: name the exact things the bot did wrong, the exact ' +
				'things it should do instead, and the safe actions it can take. Not vague advice ' +
				'like "be more helpful" - concrete rules like "when the user asks for a file, ' +
				'create it with shell_exec instead of saying you cannot".\n\n' +
				'Format:\n' +
				'WHAT WENT WRONG - one line per mistake, quoting the evidence\n' +
				'WHAT TO DO INSTEAD - one line per fix, naming the tool or action\n' +
				'SAFE ACTIONS - the tools/actions that are always safe to use\n' +
				'DO NOT - the things that got it in trouble, to never do again\n\n' +
				'Be direct. The bot reads this to change its behavior.'
		},
		{
			role: 'user',
			content: `The bot asked for help with: ${opts.goal}\n\nEvidence:\n${evidence}`
		}
	];

	let tokensIn = 0;
	let tokensOut = 0;
	try {
		const result = await drain(
			streamChat({
				model,
				messages,
				signal: opts.signal,
				tools: [] // The expert reads; it does not call tools.
			})
		);
		const usage = result.usage ?? estimateUsage(messages, result.text, []);
		tokensIn += usage.input;
		tokensOut += usage.output;
		if (opts.signal?.aborted) return 'The improvement review was cancelled.';
		if (result.truncated) {
			return `The improvement review was cut off: ${result.error || 'provider stream truncated'}`;
		}
		const plan = redactSecrets(opts.botId, result.text.trim());
		if (!plan) return '(the improvement expert returned nothing)';

		// Store the plan so the bot's next turn sees it in its memory block.
		setMemory(opts.botId, IMPROVEMENT_PLAN_KEY, plan);

		// Post it as a collapsed system bubble in the bot's chat - a quiet note,
		// not a message, so it reads as an event rather than a reply.
		if (opts.conversationId) {
			addMessage(opts.conversationId, 'user', `[Improvement plan]\n${plan}`, '', '', 0, 'event');
		}

		logActivity(opts.botId, 'improve', `Improvement plan written (${plan.length} chars)`);
		return plan;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logActivity(opts.botId, 'error', `Improvement review failed: ${msg}`);
		return `The improvement review failed: ${msg}`;
	} finally {
		if (tokensIn || tokensOut) addBotTokens(opts.botId, tokensIn, tokensOut);
	}
}
