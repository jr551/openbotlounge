/**
 * Message text is not trusted: it arrives from a model, from webhook payloads
 * and from plugins. The markdown renderer turns raw HTML into live elements, so
 * a message containing an `<iframe>` loads a third-party page inside the chat,
 * an `<img>` fetches a remote URL (telling the sender that you read the message)
 * and a `<form>` renders a convincing fake sign-in box.
 *
 * Markdown is the contract for a bubble, so neutralise HTML tags in the prose
 * while leaving code alone — a bot showing an HTML snippet must still render it
 * verbatim. A backslash escape is used rather than an HTML entity: the renderer
 * escapes entities a second time, which would show the reader `&lt;iframe>`.
 * One backslash on the opening bracket is enough to stop the parser making an
 * element of it, and the tag then reads as ordinary text.
 */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/**
 * `<https://example.com>` and `<you@example.com>` are markdown autolinks. The
 * whole tag body has to be one, though: an earlier version only looked for an
 * '@' anywhere in it, so `<img src=//evil.com/track@>` counted as an autolink
 * and went through unescaped. No spaces, quotes or attribute syntax survive.
 */
const AUTOLINK = /^(?:[a-z][a-z0-9+.-]*:[^\s<>"']+|[^\s<>"'@]+@[^\s<>"'@]+\.[^\s<>"'@]+)$/i;

/**
 * Escape HTML tags in markdown prose, leaving fenced blocks, inline code and
 * autolinks untouched.
 */
export function guardHtml(source: string): string {
	// Odd-indexed splits are the code segments, which must pass through as-is.
	const parts = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
	return parts
		.map((part, i) => {
			if (i % 2 === 1) return part;
			return part.replace(TAG, (whole, _slash, name: string, rest: string) =>
				AUTOLINK.test(name + rest) ? whole : '\\' + whole
			);
		})
		.join('');
}
