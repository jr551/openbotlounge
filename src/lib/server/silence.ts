/**
 * Replies that mean "nothing to say". A wake or a lounge round can fire when a
 * bot has genuinely nothing to add, and storing the shrug fills the transcript
 * with noise the next turn then reads back. The check normalizes first - case,
 * punctuation and parens stripped - so "(silent)", "SILENT." and "no reply!"
 * all read as the same answer, while a real sentence that happens to contain
 * one of these words still lands.
 */
const SILENCE_WORDS: Record<string, true> = {
	silent: true,
	ghost: true,
	quiet: true,
	nothing: true,
	'no reply': true,
	'no change': true,
	same: true,
	unchanged: true,
	still: true,
	na: true,
	dead: true,
	sh: true,
	shh: true
};

/**
 * The emoji that are themselves a shrug: the ones a bot sends instead of
 * words when it has nothing to add. Every other emoji is content - a "👍" is
 * an answer, not silence - so only these normalize away.
 */
const SHRUG_CHARS: Record<string, true> = {
	'🤫': true,
	'👻': true,
	'🤷': true,
	'🙊': true,
	'😶': true,
	'🫥': true,
	'💤': true,
	'😴': true,
	'➖': true,
	// The joiners, gender signs and skin tones a multi-codepoint shrug
	// (🤷‍♀️, 🤷🏽) leaves behind once its base emoji is stripped.
	'‍': true,
	'♀': true,
	'♂': true,
	'🏻': true,
	'🏼': true,
	'🏽': true,
	'🏾': true,
	'🏿': true
};

/** True when a reply is a sentinel for "nothing to say" rather than a message. */
export function isSilence(text: string): boolean {
	// Punctuation, parens, whitespace and the shrug emoji above all map to a
	// space; letters, digits and every other emoji survive. "(silent)!" and
	// "🤫" normalize to 'silent' and '', while "42" and "👍" keep their
	// content - a numeric or emoji reply is a real answer, not the sentinel.
	const norm = [...text.toLowerCase()]
		.map((c) => (/\s|\p{P}|\p{Cf}|\p{M}/u.test(c) || SHRUG_CHARS[c] ? ' ' : c))
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
	if (!norm) return true;
	return SILENCE_WORDS[norm] === true;
}
