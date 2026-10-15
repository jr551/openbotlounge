/**
 * A bot quoting another message in plain text.
 *
 * A human tapping Reply stores a reply_to and the thread renders the quote
 * block for it. A bot quoting inside its own words writes the line again in
 * double quotes, and that arrived as bare inline text. This finds the spans of
 * quoted text in a bot message that actually match something another message
 * really said - the WhatsApp quote block, rendered above the bubble, backed by
 * a real message you can jump to.
 *
 * Conservative by design: a span in quotes that no recent message said renders
 * as the plain text it always was, and a message is never reshaped for a quote
 * that cannot be traced to a row.
 */

/** A quote the thread can render: the matched span, and the message it came from. */
export interface BotQuote {
	/** The quoted line as the quoted message said it. */
	text: string;
	/** The message the line matches; clicking the quote block jumps here. */
	source: MessageRef;
}

/** Just enough of a Message for the matcher to run without importing the store. */
export interface MessageRef {
	id: string;
	/** The quoted message's sender, or '' for the human's own lines. */
	bot_id: string;
	content: string;
}

/**
 * A span must be this many characters to be worth quoting: shorter than this
 * and the span is a turn of phrase, not a quotation - matching every short
 * aside some other bot happened to have said would light the chat up with
 * quote blocks nothing was asked for.
 */
const MIN_QUOTE_LEN = 40;
/** Only the conversation's recent tail is searched - a quotation reaches back a little way, not to the dawn of the thread. */
const LOOKBACK = 60;
/** No two quotes from the same source: one quote block per matched message. */
const MAX_QUOTES = 3;

/**
 * The quoted spans of a message: runs between double quotes, straight or
 * curly. Nested markdown is left alone - the message body is markdown, and
 * the double quote remains the way a bot shows it is quoting verbatim.
 */
export function quotedSpans(text: string): string[] {
	// The alternation is deliberate: straight and curly quotes may open and
	// close a span alike, and insisting one message pick a single style would
	// miss half the corpus. Non-greedy between the pairs; a lone quote that
	// never closes is not a quotation.
	const re = /"([^"]{1,400})"|\u201c([^\u201d]{1,400})\u201d/g;
	const spans: string[] = [];
	for (const m of text.matchAll(re)) {
		const span = (m[1] ?? m[2] ?? '').trim();
		if (span) spans.push(span);
	}
	return spans;
}

/**
 * How close two lines have to be to call it the same line. Whitespace and
 * punctuation at the edges drift between a bot's original and its own
 * requote; the whole of the words must not. Normalised the same way a
 * message is read for the thread, then compared on a whole-word basis so
 * "ate the apple" does not match "ate the apples".
 */
function canon(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*_~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The words of a line, for whole-word overlap. */
function words(text: string): string[] {
	return canon(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Whether `needle`'s whole word sequence appears inside `hay`'s, aligned.
 * A quote stands for the whole sentence it repeats: sharing most of the
 * words out of order, or a paraphrase, does not count. The sequence must
 * start at the line's first word - a quotation stands for the opening of
 * what was said, and an aligned slice from the middle is far more often a
 * shared phrase than a quotation.
 */
function containsSequence(needle: string[], hay: string[]): boolean {
	if (needle.length > hay.length) return false;
	for (let i = 0; i < needle.length; i++) {
		if (hay[i] !== needle[i]) return false;
	}
	return true;
}

/**
 * Whether a quoted span and a candidate line are the same line: the span's
 * whole word sequence aligned with the line's opening words. Both directions
 * are allowed, so a bot quoting one sentence of a longer message links it
 * and a bot quoting a whole line shorter than the message does too. Rough,
 * on purpose: the bar is "this really is that line", not "these two are
 * vaguely similar".
 */
function linesMatch(span: string, line: string): boolean {
	const a = words(span);
	const b = words(line);
	if (!a.length || !b.length) return false;
	return a.length <= b.length
		? containsSequence(a, b)
		: containsSequence(b, a);
}

/** The lines of a message a quotation could have come from, capped to bound the search. */
function linesOf(content: string): string[] {
	return content
		.split('\n', 5)
		.map((l) => l.trim())
		.filter(Boolean);
}

/**
 * The quotes in a bot's message that match real lines elsewhere in the
 * conversation, in the order they appear. `all` is the whole thread, newest
 * last; only its recent tail is searched. A span that matches nothing stays
 * in the message exactly as it was written - the matcher never invents a
 * link, and never strips text it cannot back with a row.
 */
export function botQuotesOf(
	m: { id: string; bot_id: string; content: string },
	all: MessageRef[]
): BotQuote[] {
	const spans = quotedSpans(m.content);
	if (!spans.length) return [];
	// The recent tail, excluding the quoting message itself - a bot may quote
	// itself, so only this one row is ruled out.
	const window = all.filter((x) => x.id !== m.id).slice(-LOOKBACK);
	const candidates = window.filter((x) => !!x.content.trim());
	if (!candidates.length) return [];

	const out: BotQuote[] = [];
	const seenSources = new Set<string>();
	for (const span of spans) {
		if ([...span].length < MIN_QUOTE_LEN) continue;
		const spanLine = linesOf(span)[0] ?? '';
		if (!spanLine) continue;
		// Newest first: a bot that repeats a line a room has heard twice quotes
		// the one the reader saw most recently.
		for (let i = candidates.length - 1; i >= 0; i--) {
			const cand = candidates[i];
			if (seenSources.has(cand.id)) continue;
			if (linesOf(cand.content).some((line) => linesMatch(spanLine, line))) {
				out.push({ text: span, source: cand });
				seenSources.add(cand.id);
				break;
			}
		}
		if (out.length >= MAX_QUOTES) break;
	}
	return out;
}
