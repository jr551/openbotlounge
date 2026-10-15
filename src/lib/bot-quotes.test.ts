import { describe, expect, it } from 'vitest';
import { botQuotesOf, quotedSpans, type MessageRef } from './bot-quotes';

const msg = (id: string, bot_id: string, content: string): MessageRef => ({
	id,
	bot_id,
	content
});

describe('quotedSpans', () => {
	it('finds straight-quoted spans', () => {
		expect(quotedSpans('he said "hello there" and left')).toEqual(['hello there']);
	});

	it('finds curly-quoted spans', () => {
		expect(quotedSpans('he said \u201chello there\u201d and left')).toEqual(['hello there']);
	});

	it('finds several spans', () => {
		expect(quotedSpans('"a one" mid "b two"')).toEqual(['a one', 'b two']);
	});

	it('leaves an unclosed quote alone', () => {
		expect(quotedSpans('he said "hello there')).toEqual([]);
	});

	it('ignores markdown-style nesting and other punctuation', () => {
		expect(quotedSpans('no quotes here at all')).toEqual([]);
	});
});

describe('botQuotesOf', () => {
	const eaten = msg('m1', 'bot_a', 'You ate the whole apple. It was crisp and sweet, and gone in two bites.');
	const asker = msg('m2', 'bot_b', 'the eat plugin ran and returned that exactly: "You ate the whole apple. It was crisp and sweet, and gone in two bites." All done.');

	it('matches a span that repeats another bot\'s line, newest message wins', () => {
		const quotes = botQuotesOf(asker, [eaten, asker]);
		expect(quotes).toHaveLength(1);
		expect(quotes[0].source.id).toBe('m1');
		expect(quotes[0].text).toBe('You ate the whole apple. It was crisp and sweet, and gone in two bites.');
	});

	it('links a bot quoting itself', () => {
		const again = msg('m3', 'bot_a', 'To remind myself: "You ate the whole apple. It was crisp and sweet, and gone in two bites." Yes.');
		const quotes = botQuotesOf(again, [eaten, asker, again]);
		expect(quotes).toHaveLength(1);
		// The newest self-quote outside the quoting message itself is m1.
		expect(quotes[0].source.id).toBe('m1');
	});

	it('links across the full lookback window', () => {
		const filler: MessageRef[] = [];
		for (let i = 0; i < 55; i++) filler.push(msg(`f${i}`, 'bot_c', `Unrelated line ${i} about the weather today.`));
		const late = msg('late', 'bot_b', 'as seen before: "You ate the whole apple. It was crisp and sweet, and gone in two bites." indeed');
		const quotes = botQuotesOf(late, [eaten, ...filler, late]);
		expect(quotes).toHaveLength(1);
		expect(quotes[0].source.id).toBe('m1');
	});

	it('does not link a span nothing said', () => {
		const stranger = msg('m4', 'bot_b', 'I heard "the quick brown fox jumps over the lazy dog again and again" somewhere.');
		const quotes = botQuotesOf(stranger, [eaten, stranger]);
		expect(quotes).toEqual([]);
	});

	it('does not link a span too short to be a quotation', () => {
		const short = msg('m5', 'bot_b', 'It was "You ate the whole apple" all over again.');
		const quotes = botQuotesOf(short, [eaten, short]);
		expect(quotes).toEqual([]);
	});

	it('links a quoted opening of a longer line (prefix of the real message)', () => {
		const near = msg('m6', 'bot_b', 'So the summary: "You ate the whole apple. It was crisp and sweet." End of story.');
		const quotes = botQuotesOf(near, [eaten, near]);
		// The span repeats the line's opening words verbatim - a real quote of
		// the first sentence, so it links.
		expect(quotes).toHaveLength(1);
		expect(quotes[0].source.id).toBe('m1');
		expect(quotes[0].text).toBe('You ate the whole apple. It was crisp and sweet.');
	});

	it('does not link a span that shares words but starts elsewhere', () => {
		// "It was crisp and sweet, and gone in two bites" - real words, but not
		// how the line opens; a mid-line slice is a shared phrase, not a quote.
		const mid = msg('m6', 'bot_b', 'So the summary: "It was crisp and sweet, and gone in two bites." End of story.');
		const quotes = botQuotesOf(mid, [eaten, mid]);
		expect(quotes).toEqual([]);
	});

	it('skips the quoting message itself, even with a self-referential span', () => {
		const self = msg('m7', 'bot_b', 'I said: "You ate the whole apple. It was crisp and sweet, and gone in two bites." Done.');
		const quotes = botQuotesOf(self, [eaten, self]);
		// m7's own line is excluded; only m1's line matches.
		expect(quotes).toHaveLength(1);
		expect(quotes[0].source.id).toBe('m1');
	});

	it('prefers the newest matching message', () => {
		const older = msg('old', 'bot_a', 'You ate the whole apple. It was crisp and sweet, and gone in two bites.');
		const newer = msg('new', 'bot_a', 'You ate the whole apple. It was crisp and sweet, and gone in two bites.');
		const quoter = msg('q', 'bot_b', 'He said: "You ate the whole apple. It was crisp and sweet, and gone in two bites." Truly.');
		const quotes = botQuotesOf(quoter, [older, newer, quoter]);
		expect(quotes).toHaveLength(1);
		expect(quotes[0].source.id).toBe('new');
	});

	it('handles curly quotes in the message', () => {
		const curly = msg('m8', 'bot_b', 'She replied \u201cYou ate the whole apple. It was crisp and sweet, and gone in two bites.\u201d and signed off.');
		const quotes = botQuotesOf(curly, [eaten, curly]);
		expect(quotes).toHaveLength(1);
		expect(quotes[0].source.id).toBe('m1');
	});

	it('caps at three quotes per message', () => {
		const lines = ['Alpha beta gamma delta epsilon zeta', 'One two three four five six seven', 'Red orange yellow green blue indigo', 'North south east west up down over'];
		const others = lines.map((l, i) => msg(`o${i}`, 'bot_a', l));
		const quoter = msg('q2', 'bot_b', `${lines.map((l) => `"${l}"`).join(' ')} - all four, straight back at you`);
		const quotes = botQuotesOf(quoter, [...others, quoter]);
		expect(quotes.length).toBeLessThanOrEqual(3);
	});

	it('matches one sentence out of a longer quoted message', () => {
		const long = msg('m9', 'bot_a', 'Chapter one:\nYou ate the whole apple. It was crisp and sweet.\nChapter two:');
		const quoter = msg('q3', 'bot_b', 'The key bit was "You ate the whole apple. It was crisp and sweet." precisely.');
		const quotes = botQuotesOf(quoter, [long, quoter]);
		expect(quotes).toHaveLength(1);
		expect(quotes[0].source.id).toBe('m9');
	});

	it('returns nothing for a message with no quotes at all', () => {
		const plain = msg('m10', 'bot_b', 'Just talking, nothing quoted.');
		expect(botQuotesOf(plain, [eaten, plain])).toEqual([]);
	});
});
