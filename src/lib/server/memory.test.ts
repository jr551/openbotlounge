import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addMessage,
	addNote,
	createBot,
	createConversation,
	getSummary,
	latestCompactionReview,
	listMessages,
	setMemory,
	setMessageExcluded,
	setSummary
} from './db';
import { complete, textOf } from './llm';
import { readPersonality } from './personality';
import { maybeSummarize, memoryBlock, notesBlock, summarizeNow, summaryBlock } from './memory';

vi.mock('./llm', () => ({
	complete: vi.fn(async () => 'running summary'),
	textOf: (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? (c[0]?.text ?? '') : '')
}));

// The personality file lives on a Docker volume no test can reach; a Map
// stands in for it so the summary's working-notes block has something to read.
vi.mock('./personality', () => {
	const files = new Map<string, string>();
	return {
		readPersonality: vi.fn(async (botId: string) => files.get(botId) ?? null),
		writePersonality: vi.fn(async (botId: string, content: string) => {
			files.set(botId, content);
		}),
		__files: files
	};
});

const completeMock = vi.mocked(complete);

function makeBot(name: string) {
	return createBot({
		name,
		persona: 'test persona',
		avatar: '🤖',
		color: '#fff',
		model: 'm1',
		badge: ''
	});
}

function fillMessages(conversationId: string, count: number) {
	for (let i = 0; i < count; i++) {
		addMessage(conversationId, 'user', `msg ${i}`);
	}
}

beforeEach(() => {
	completeMock.mockClear();
});

describe('memoryBlock', () => {
	it('returns empty string when the bot has no memories', () => {
		const bot = makeBot('MemBot');
		expect(memoryBlock(bot.id)).toBe('');
	});

	it('renders stored memories as key: value lines', () => {
		const bot = makeBot('MemBot');
		setMemory(bot.id, 'color', 'blue');
		setMemory(bot.id, 'name', 'Ada');
		expect(memoryBlock(bot.id)).toBe('color: blue\nname: Ada');
	});
});

describe('notesBlock', () => {
	it('returns empty string when the conversation has no notes', () => {
		const bot = makeBot('NoteBot');
		const conv = createConversation([bot.id], 'group');
		expect(notesBlock(conv.id)).toBe('');
	});

	it('renders notes as "- [BotName] content" lines', () => {
		const bot = makeBot('NoteBot');
		const conv = createConversation([bot.id], 'group');
		addNote(conv.id, bot.id, 'first note');
		addNote(conv.id, bot.id, 'second note');
		expect(notesBlock(conv.id)).toBe('- [NoteBot] first note\n- [NoteBot] second note');
	});

	it('caps the block at the 10 most recent notes', () => {
		const bot = makeBot('NoteBot');
		const conv = createConversation([bot.id], 'group');
		for (let i = 0; i < 12; i++) addNote(conv.id, bot.id, `note-${i}`);
		const block = notesBlock(conv.id);
		expect(block.split('\n')).toHaveLength(10);
		expect(block).toContain('- [NoteBot] note-11');
		expect(block).not.toContain('note-0');
	});
});

describe('summaryBlock', () => {
	it('returns empty string when no summary is stored', () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		expect(summaryBlock(conv.id)).toBe('');
	});

	it('returns the stored summary text', () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		setSummary(conv.id, 'they discussed testing', 123);
		expect(summaryBlock(conv.id)).toBe('they discussed testing');
	});
});

describe('maybeSummarize', () => {
	it('does not call complete at or below 40 messages', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 40);
		await maybeSummarize(conv.id, 'm1');
		expect(completeMock).not.toHaveBeenCalled();
		expect(getSummary(conv.id)).toBeUndefined();
	});

	it('summarizes once past 40 messages and stores the result', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		await maybeSummarize(conv.id, 'm1');

		// The summary call, then the police review of it.
		expect(completeMock).toHaveBeenCalledTimes(2);
		expect(completeMock.mock.calls[0][0]).toBe('m1');
		expect(completeMock.mock.calls[0][1][1].content).toContain('msg 40');

		const stored = getSummary(conv.id);
		expect(stored?.summary).toBe('running summary');
		const messages = listMessages(conv.id);
		expect(stored?.covers_until).toBe(messages[messages.length - 1].created_at);
	});

	it('thinks as hard as the provider allows, and keeps the working memory', async () => {
		const bot = makeBot('Thoughtful');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		// The bot speaks last, which is who compaction is charged to and whose
		// working notes the summary has to carry forward.
		addMessage(conv.id, 'assistant', 'I will keep the key safe', bot.id);
		vi.mocked(readPersonality)
			.mockResolvedValueOnce('the deploy key lives in /srv/keys; the human hates mornings')
			.mockResolvedValueOnce('the deploy key lives in /srv/keys; the human hates mornings');
		addNote(conv.id, bot.id, 'we settled on the Friday release');
		// The dream runs first and returns UNCHANGED, so the notes the summary is
		// handed are the bot's own rather than the dream's rewrite.
		completeMock.mockResolvedValueOnce('UNCHANGED').mockResolvedValue('running summary');

		await maybeSummarize(conv.id, 'm1');

		// The summary is the one call worth the tokens: it runs at the highest
		// effort with room to write, whatever the bot's profile or the deployment's
		// defaults say, because it is what survives when the rest is folded away.
		// The dream runs first (the bot spoke last), so the summary is the last call.
		// The summary call is the one carrying the summarizer brief; the review is a separate call after it.
		const summaryCall = completeMock.mock.calls.find((c) => String(c[1][0].content).includes('running summary'))!;
		expect(summaryCall[2]).toMatchObject({ effort: 'high' });
		expect((summaryCall[2] as { maxTokens?: number }).maxTokens).toBeGreaterThanOrEqual(8000);

		// And it is written from everything the bot knows, not only the messages:
		// a compaction that drops the bot's own notes and the room's notes loses
		// the one place a decision was actually written down.
		const prompt = summaryCall[1][1].content;
		expect(prompt).toContain('the deploy key lives in /srv/keys');
		expect(prompt).toContain('we settled on the Friday release');
		expect(prompt).toContain('Working notes');
		expect(prompt).toContain('Shared notes in this room');
	});

	it('does not call complete again when no new messages arrived', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		await maybeSummarize(conv.id, 'm1');
		await maybeSummarize(conv.id, 'm1');
		// Summary plus its review; the second run adds nothing.
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it('does not call complete when fewer than 30 messages are unsummarized', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		await maybeSummarize(conv.id, 'm1');
		addMessage(conv.id, 'user', 'one more');
		await maybeSummarize(conv.id, 'm1');
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it('spends no summary when the span holds only short app notes', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		// Routine/webhook markers: real rows, real words, nothing to fold. They
		// are not silence sentinels, so only the app-line rule skips them.
		for (let i = 0; i < 41; i++) addMessage(conv.id, 'user', `[Marker] tick-${i}`, '', '', 0, 'app');
		await maybeSummarize(conv.id, 'm1');
		expect(completeMock).not.toHaveBeenCalled();
	});

	it('never throws when complete rejects', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		completeMock.mockRejectedValueOnce(new Error('provider down'));
		await expect(maybeSummarize(conv.id, 'm1')).resolves.toBeUndefined();
		expect(getSummary(conv.id)).toBeUndefined();
	});

	it('stores nothing when complete returns an empty summary', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		completeMock.mockResolvedValueOnce('');
		await maybeSummarize(conv.id, 'm1');
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(getSummary(conv.id)).toBeUndefined();
	});
});

describe('summarizeNow', () => {
	/** The completion call that writes the summary (a dream may run before it). */
	function summaryCall() {
		return completeMock.mock.calls.find(([, msgs]) =>
			textOf(msgs[0].content).includes('running summary')
		);
	}

	it('keeps excluded messages out of the transcript sent to the provider', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		addMessage(conv.id, 'user', 'VISIBLE one');
		const folded = addMessage(conv.id, 'user', 'FOLDED-AWAY');
		addMessage(conv.id, 'assistant', 'VISIBLE two', bot.id);
		setMessageExcluded(folded.id, true);

		expect(await summarizeNow(conv.id, 'm1', { force: true })).toBe(true);

		const call = summaryCall();
		expect(call).toBeDefined();
		const sent = call![1].map((m) => m.content).join('\n');
		expect(sent).toContain('VISIBLE one');
		expect(sent).toContain('VISIBLE two');
		expect(sent).not.toContain('FOLDED-AWAY');
	});

	it('advances covers_until over the newest row even when it is excluded', async () => {
		vi.useFakeTimers();
		try {
			const bot = makeBot('SumBot');
			const conv = createConversation([bot.id], 'group');
			vi.setSystemTime(1_000_000);
			addMessage(conv.id, 'user', 'still visible');
			vi.setSystemTime(2_000_000);
			const folded = addMessage(conv.id, 'user', 'folded newest');
			setMessageExcluded(folded.id, true);

			expect(await summarizeNow(conv.id, 'm1', { force: true })).toBe(true);

			// If the cursor only reached the last in-context message, a run of
			// folded messages would be re-summarized (or stall) forever.
			expect(getSummary(conv.id)?.covers_until).toBe(folded.created_at);
		} finally {
			vi.useRealTimers();
		}
	});


	it('counts a message at the cursor boundary as unsummarized until it is folded', async () => {
		vi.useFakeTimers();
		try {
			const bot = makeBot('SumBot');
			const conv = createConversation([bot.id], 'group');
			vi.setSystemTime(1_000_000);
			addMessage(conv.id, 'user', 'first');
			// A second message in the same millisecond: the cursor lands on the
			// first one's timestamp, and the second must not be skipped.
			addMessage(conv.id, 'user', 'same instant');

			expect(await summarizeNow(conv.id, 'm1', { force: true })).toBe(true);
			const sent = summaryCall()![1].map((m) => m.content).join('\n');
			expect(sent).toContain('same instant');
			expect(getSummary(conv.id)?.covers_until).toBe(1_000_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('never lets a stale write rewind covers_until or its summary', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		setSummary(conv.id, 'newer summary', 2_000_000);

		setSummary(conv.id, 'stale summary', 1_000_000);

		const row = getSummary(conv.id);
		expect(row?.covers_until).toBe(2_000_000);
		expect(row?.summary).toBe('newer summary');
	});
});

describe('the compaction sign-off', () => {
	it('leaves the folded span in place when the police reject the summary', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		// The summary, the review that sends it back, the rewrite, and the second
		// review that sends that back too.
		completeMock
			.mockResolvedValueOnce('a lossy summary')
			.mockResolvedValueOnce('REJECTED - dropped the deploy key')
			.mockResolvedValueOnce('a rewritten summary')
			.mockResolvedValueOnce('REJECTED - still dropped it');

		expect(await summarizeNow(conv.id, 'm1', { force: true })).toBe(false);

		// Nothing was written and nothing was folded: the messages stay in context
		// so the next pass can redo the summary rather than lose them.
		expect(getSummary(conv.id)).toBeUndefined();
		expect(listMessages(conv.id).every((m) => !m.excluded)).toBe(true);
	});

	it('cites the folded messages and stores the marker map with the review', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		const messages = listMessages(conv.id);
		completeMock
			.mockResolvedValueOnce('the plan is Friday [m1]')
			.mockResolvedValueOnce('APPROVED - kept the plan');

		expect(await summarizeNow(conv.id, 'm1', { force: true })).toBe(true);

		expect(getSummary(conv.id)?.summary).toBe('the plan is Friday [m1]');
		const review = latestCompactionReview(conv.id);
		expect(review?.verdict).toBe('approved');
		// The map is what makes [m1] checkable: it names the row the fold hid.
		expect(JSON.parse(review!.citations)).toMatchObject({ m1: messages[0].id });
	});

	it('drops citation markers when the review could not sign off', async () => {
		const bot = makeBot('SumBot');
		const conv = createConversation([bot.id], 'group');
		fillMessages(conv.id, 41);
		completeMock
			.mockResolvedValueOnce('the plan is Friday [m1]')
			.mockResolvedValueOnce('hmm, not sure');

		expect(await summarizeNow(conv.id, 'm1', { force: true })).toBe(true);

		// No map was stored, so the marker would point at nothing.
		expect(getSummary(conv.id)?.summary).toBe('the plan is Friday');
	});
});
