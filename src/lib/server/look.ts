/**
 * The looks a bot may wear once the human approves them: a page of chat CSS and
 * an SVG avatar. Both are markup the model wrote that ends up in the document,
 * so each gets a sanitizer before it is ever stored as approved.
 */

/** Cap on one bot's chat CSS; a stylesheet is a few rules, not a framework. */
export const CHAT_CSS_MAX = 16 * 1024;

/**
 * Decode CSS backslash escapes to the characters the browser will actually
 * see, so the ban checks below cannot be walked past with `\75 rl(` (url) or
 * `@\69 mport` (@import). A hex escape is a backslash, one to six hex digits,
 * and an optional single trailing whitespace; any other escaped character
 * stands for itself.
 */
function decodeCssEscapes(css: string): string {
	return css.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, esc: string) => {
		if (/^[0-9a-fA-F]{1,6}\s?$/.test(esc)) {
			const code = parseInt(esc.trim(), 16);
			// A NUL or out-of-range escape is the replacement character, per CSS.
			if (code === 0 || code > 0x10ffff) return '\uFFFD';
			return String.fromCodePoint(code);
		}
		return esc;
	});
}

/**
 * The CSS a bot proposed, checked before it can reach the page. The chat sheet
 * is scoped to the conversation by the component that injects it, so the bans
 * are about escape hatches, not layout: no fetching (@import, url(),
 * image-set()), no scriptable values (expression(), javascript:), no markup
 * (a <style> block that closed early would let the rest run as HTML), and no
 * legacy IE bindings. Comments are stripped for the check so the words "no
 * url()" inside one cannot trip it - the stored sheet keeps them.
 */
export function sanitizeChatCss(css: string): string | null {
	const raw = css.trim();
	if (!raw || raw.length > CHAT_CSS_MAX) return null;
	// Comments are stripped first so `@/**/import` reads as `@import`, then
	// escapes are decoded so `@\69 mport` and `\75 rl(` read as their real
	// tokens. The stored sheet keeps both - only the check sees the decoded form.
	const s = decodeCssEscapes(raw.replace(/\/\*[\s\S]*?\*\//g, ''));
	if (/@(?:import|charset|namespace)\b/i.test(s)) return null;
	if (/url\s*\(|image-set\s*\(|expression\s*\(/i.test(s)) return null;
	if (/javascript\s*:|vbscript\s*:/i.test(s)) return null;
	if (/<\s*\/?\s*[a-z]/i.test(s)) return null;
	if (/-moz-binding|behavior\s*:/i.test(s)) return null;
	return raw;
}
