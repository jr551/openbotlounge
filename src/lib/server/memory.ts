import {
	addBotTokens,
	collapseContextUpTo,
	getBot,
	getSummary,
	latestCompactionReview,
	listMemories,
	listContextMessages,
	listMessages,
	listNotes,
	logActivity,
	setSummary
} from './db';
import { complete } from './llm';
import { readPersonality, writePersonality } from './personality';
import { reviewCompaction } from './police';
import { isSilence } from './silence';

/** Who a transcript line is from: the bot's name, or the role for the user/system. */
function speaker(m: { bot_id: string; role: string }): string {
	return m.bot_id ? (getBot(m.bot_id)?.name ?? m.role) : m.role;
}

/** Render a bot's stored memories as `key: value` lines for the system prompt. */
export function memoryBlock(botId: string): string {
	const memories = listMemories(botId);
	if (memories.length === 0) return '';
	return memories.map((m) => `${m.key}: ${m.value}`).join('\n');
}

/** Render the last 10 shared notes in a conversation for the system prompt. */
export function notesBlock(conversationId: string): string {
	const notes = listNotes(conversationId).slice(-10);
	if (notes.length === 0) return '';
	return notes
		.map((n) => `- [${getBot(n.bot_id)?.name ?? 'unknown'}] ${n.content}`)
		.join('\n');
}


/** Render the stored rolling summary for a conversation, or '' when none exists. */
export function summaryBlock(conversationId: string): string {
	return getSummary(conversationId)?.summary ?? '';
}

const SUMMARIZE_AFTER = 40;
const SUMMARIZE_SPAN = 30;
/** The same trigger by size: forty short lines and ten huge ones are both due. */
const SUMMARIZE_AFTER_CHARS = 24_000;

/** Total characters across a span of messages - the size half of the trigger. */
function transcriptSize(messages: { content: string }[]): number {
	let n = 0;
	for (const m of messages) n += m.content.length;
	return n;
}

/** The marker-to-message map a prior review stored, or {} when there is none. */
function parseCitationMap(json: string | undefined): Record<string, string> {
	if (!json) return {};
	try {
		const parsed = JSON.parse(json) as unknown;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** The highest marker number in a map, or 0 when it is empty. */
function maxMarker(map: Record<string, string>): number {
	let max = 0;
	for (const key of Object.keys(map)) {
		const n = Number(key.slice(1));
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max;
}

/**
 * Pre-compaction "dream": the bot reflects on the conversation and tidies its
 * personality file. Runs before the summary is written so its output can
 * shape what the summary keeps. Never throws.
 */
async function dream(
	botId: string,
	conversationId: string,
	model: string
): Promise<string> {
	logActivity(botId, 'dreaming', 'Reflecting before compaction');
	const pad = (await readPersonality(botId).catch(() => null)) ?? '';
	const messages = listContextMessages(conversationId, 20);
	const transcript = messages.map((m) => `${speaker(m)}: ${m.content}`).join('\n');
	const reflection = await complete(
		model,
		[
			{
				role: 'system',
				content:
					'You are a bot reflecting before your memory is compacted. ' +
					'In at most 80 words: what should your personality file keep, drop, or add? ' +
					'Reply with the improved file content only (or the word UNCHANGED).'
			},
			{
				role: 'user',
				content: `Current personality file:\n${pad || '(empty)'}\n\nRecent conversation:\n${transcript}`
			}
		],
		// The dream is this bot's own call, so its cost is its own. It thinks as hard
		// as the summary does: whatever it decides here is what the bot keeps.
		{ effort: 'high', onUsage: (usage) => addBotTokens(botId, usage.input, usage.output) }
	);
	const trimmed = reflection.trim();
	// Empty, UNCHANGED, or anything over 4000 chars is not a usable personality file.
	if (trimmed && trimmed !== 'UNCHANGED' && trimmed.length <= 4000) {
		await writePersonality(botId, trimmed).catch(() => {});
	}
	return trimmed;
}

/**
 * One summarizer per conversation at a time: two concurrent runs would read
 * the same cursor, fold the same span twice, and the loser's write could
 * rewind covers_until over the winner's.
 */
const summarizing = new Map<string, Promise<unknown>>();

/**
 * Fold everything not yet summarised in a conversation into the stored running
 * summary. Shared by automatic compaction and the "new topic" button.
 * Returns true when a summary was written.
 */
export function summarizeNow(
	conversationId: string,
	model: string,
	opts: { force?: boolean } = {}
): Promise<boolean> {
	const prev = summarizing.get(conversationId) ?? Promise.resolve();
	const run = prev.then(() => summarizeNowInner(conversationId, model, opts));
	// The map holds a settled-safe promise: a failed run must not poison the
	// chain for the next call, and the cleanup must not float a rejection.
	const stored = run.catch(() => false);
	summarizing.set(conversationId, stored);
	void stored.finally(() => {
		if (summarizing.get(conversationId) === stored) summarizing.delete(conversationId);
	});
	return run;
}

async function summarizeNowInner(
	conversationId: string,
	model: string,
	opts: { force?: boolean } = {}
): Promise<boolean> {
	const messages = listMessages(conversationId);
	if (!messages.length) return false;
	const coversUntil = getSummary(conversationId)?.covers_until ?? 0;
	// "Covered" means folded: a message exactly at the cursor (timestamps share
	// milliseconds) or one merged in behind it is only accounted for once it is
	// excluded, so anything still in context counts as unsummarized.
	const unsummarized = messages.filter((m) => m.created_at > coversUntil || !m.excluded);
	if (!unsummarized.length) return false;
	// A span that is only silence sentinels, empty replies and short app notes
	// (routine/webhook markers) has nothing to fold: skip the model call and
	// just collapse it, so a run of quiet turns cannot spend a summary on
	// nothing.
	const substantive = unsummarized.filter(
		(m) =>
			!m.excluded &&
			m.content.trim() &&
			!isSilence(m.content) &&
			!(m.kind === 'app' && m.content.trim().length < 40)
	);
	if (!substantive.length) {
		collapseContextUpTo(conversationId, unsummarized[unsummarized.length - 1].created_at);
		return false;
	}
	if (!opts.force && unsummarized.length <= SUMMARIZE_SPAN && transcriptSize(unsummarized) <= SUMMARIZE_AFTER_CHARS)
		return false;

	const lastBot = [...messages].reverse().find((m) => m.bot_id)?.bot_id;
	if (lastBot) await dream(lastBot, conversationId, model).catch(() => {});

	const prior = getSummary(conversationId)?.summary ?? '';
	// Only messages still in context may shape the summary. Folding one shut with
	// the ✕ has to mean the model stops seeing it - and this summary is injected
	// into the system prompt, so ignoring `excluded` here would smuggle it back.
	// Each line carries the marker the summary must cite, so a durable claim can
	// be traced to the message it came from even after the fold hides it. The
	// map is the only surviving link: the rows it names are exactly the ones the
	// fold removes from context. Markers continue from the last fold's map, so a
	// claim carried forward from the prior summary still resolves to its own
	// message rather than to a new row that reuses the number.
	const folded = unsummarized.filter((m) => !m.excluded);
	const citations = parseCitationMap(latestCompactionReview(conversationId)?.citations);
	let marker = maxMarker(citations) + 1;
	const transcript = folded
		.map((m) => {
			const key = `m${marker++}`;
			citations[key] = m.id;
			return `[${key}] ${speaker(m)}: ${m.content}`;
		})
		.join('\n');
	// The bot's working memory and the room's shared notes are as much a part of
	// what it knows as the transcript is, and compaction is exactly where they go
	// missing: the messages are folded away, and a summary written from the chat
	// alone would drop the one place a decision was actually written down.
	const pad = lastBot ? ((await readPersonality(lastBot).catch(() => null)) ?? '') : '';
	const notes = listNotes(conversationId)
		.map((n) => `- ${n.bot_id ? (getBot(n.bot_id)?.name ?? 'a bot') : 'the human'}: ${n.content}`)
		.join('\n');

	const summary = await complete(
		model,
		[
			{
				role: 'system',
				content:
					'You keep the running summary of a group chat, and it is the memory ' +
					'the bots will have to work from once the messages it covers are ' +
					'folded away. Write it so nothing load-bearing is lost: decisions and ' +
					'the reason for them, who is doing what, names, numbers, file paths, ' +
					'commands, commitments, deadlines, anything tried that failed, and ' +
					'every open question. The working notes and the room notes below are ' +
					'memory too - keep what matters from them in the summary as well, in ' +
					'their own words where the wording matters. ' +
					'Cite every durable claim with the marker(s) of the messages it came ' +
					'from, like [m3] or [m7][m9] - a claim with no marker cannot be ' +
					'checked once the messages are folded away. ' +
					'Dense, not short: aim under 400 words, but never drop something that ' +
					'matters to make the count. Reply with the summary text only.'
			},
			{
				role: 'user',
				content:
					(prior ? `Prior summary:\n${prior}\n\nNew messages:\n` : 'Messages:\n') +
					transcript +
					`\n\nWorking notes (the bot's personality file):\n${pad || '(empty)'}` +
					`\n\nShared notes in this room:\n${notes || '(none)'}`
			}
		],
		// The summary is the one call where the tokens are worth spending: it is
		// what survives compaction, so it runs at the provider's highest effort with
		// room to write, whatever the bot's own profile or the deployment's defaults
		// say. Compaction is triggered by whoever spoke last, so the cost lands on
		// that bot's meter rather than nowhere.
		{
			effort: 'high',
			maxTokens: 8000,
			onUsage: (u) => lastBot && addBotTokens(lastBot, u.input, u.output)
		}
	);
	if (!summary) return false;

	// The police sign off on what the fold drops: the transcript it covered
	// against the summary that replaced it. A rejection gets one rewrite, and a
	// second rejection leaves the span in place for a redo; a review that could
	// not answer leaves the summary it was given rather than blocking the fold.
	let finalSummary = summary;
	let rejected = false;
	// The review is worth its call when there is something to lose: a short
	// transcript is cheap to re-read, and a span with no human in it is bots
	// talking among themselves. A summary that cites its sources is worth the
	// read whatever its length, because the citations are what the review checks.
	const worthReview =
		transcript.length > 4000 ||
		unsummarized.some((m) => m.role === 'user' && !m.bot_id && !m.kind) ||
		/\[m\d+\]/.test(summary);
	let mapStored = false;
	if (worthReview) {
		try {
			const review = await reviewCompaction(conversationId, transcript, summary, model, {
				botId: lastBot,
				citations
			});
			if (review.verdict === 'rejected') rejected = true;
			else {
				finalSummary = review.summary;
				// An unsigned summary has no stored map, so its markers would point
				// at nothing.
				mapStored = review.verdict !== 'unreviewed';
			}
		} catch {
			// A reviewer that could not answer is not a reason to keep the backlog.
		}
	}
	// A rejected fold is not written: the messages stay in context so the next
	// pass can redo the summary rather than lose what the police sent back.
	if (rejected) return false;
	// A summary whose citations were never stored would show markers that point
	// at nothing; drop them rather than leave a dangling citation.
	if (!mapStored) finalSummary = finalSummary.replace(/\s*\[m\d+\]/g, '');

	// The cursor advances over the newest row regardless of exclusion, so a run
	// of folded messages cannot stall summarisation forever.
	const coveredThrough = unsummarized[unsummarized.length - 1].created_at;
	setSummary(conversationId, finalSummary, coveredThrough);
	// Fold the covered messages shut: the summary now carries their gist, and
	// the chat list shows them as a collapsed block you can reopen.
	collapseContextUpTo(conversationId, coveredThrough);
	return true;
}

export async function maybeSummarize(conversationId: string, model: string): Promise<void> {
	try {
		const messages = listMessages(conversationId);
		if (messages.length <= SUMMARIZE_AFTER && transcriptSize(messages) <= SUMMARIZE_AFTER_CHARS) return;
		await summarizeNow(conversationId, model);
	} catch {
		// Summarization is best-effort; a failure must not break the turn.
	}
}
