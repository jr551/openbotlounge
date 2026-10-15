import { describe, expect, it } from 'vitest';
import { sanitizeChatCss } from './look';

describe('sanitizeChatCss', () => {
	it('keeps an ordinary sheet, comments and all', () => {
		const css = '/* a look */\n.bubble { color: #fff; border-radius: 8px; }\n.md a { color: #6ea8fe; }';
		expect(sanitizeChatCss(css)).toBe(css);
	});

	it('refuses the fetching and scriptable escapes it names', () => {
		for (const css of [
			'.x{background:url(https://evil.example/x)}',
			'.x{background:url(//evil.example/x)}',
			'.x{background:image-set("https://evil.example/x" 1x)}',
			'@import "https://evil.example/x.css";',
			'.x{width:expression(alert(1))}',
			'.x{background:javascript:alert(1)}',
			'.x{behavior:url(#default#time2)}',
			'.x{color:red}</style><script>alert(1)</script>'
		]) {
			expect(sanitizeChatCss(css), css).toBeNull();
		}
	});

	it('refuses a fetch hidden behind CSS escapes', () => {
		// The browser decodes these to `url(` / `@import` before it parses the
		// rule, so a check that reads the raw text walks straight past them.
		for (const css of [
			'.x{background:\\75 rl(https://evil.example/x)}',
			'.x{background:\\000075 rl(https://evil.example/x)}',
			'.x{background:u\\72 l(https://evil.example/x)}',
			'.x{background:\\75rl(https://evil.example/x)}',
			'@\\69 mport "https://evil.example/x.css";',
			'@\\69mport "https://evil.example/x.css";'
		]) {
			expect(sanitizeChatCss(css), css).toBeNull();
		}
	});

	it('refuses @import split by a comment', () => {
		expect(sanitizeChatCss('@/**/import "https://evil.example/x.css";')).toBeNull();
	});

	it('refuses a sheet over the size cap', () => {
		expect(sanitizeChatCss('.x{color:red}'.repeat(2000))).toBeNull();
	});
});
