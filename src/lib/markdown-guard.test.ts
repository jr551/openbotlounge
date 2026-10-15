import { describe, expect, it } from 'vitest';
import { guardHtml } from './markdown-guard';

describe('guardHtml', () => {
	it('neutralises a tag that would otherwise load remote content', () => {
		expect(guardHtml('<iframe src="https://evil.example/"></iframe>')).toBe(
			'\\<iframe src="https://evil.example/">\\</iframe>'
		);
		expect(guardHtml('<img src="https://evil.example/pixel.gif">')).toBe(
			'\\<img src="https://evil.example/pixel.gif">'
		);
	});

	it('neutralises a form that would render as a fake sign-in box', () => {
		const out = guardHtml('<form action="https://evil.example/"><input name="pw"></form>');
		// Every angle bracket must be escaped, or the parser builds an element.
		expect(out.match(/(?<!\\)</g)).toBeNull();
		expect(out).toContain('\\<form');
		expect(out).toContain('\\<input');
	});

	it('neutralises payloads that hide an @ behind attribute syntax', () => {
		// Regression: isAutolink() once returned true for any tag whose text
		// contained an '@', so all three of these rendered as live elements.
		for (const payload of [
			'<iframe src=//evil.com/@>',
			'<img src=//evil.com/track@>',
			'<form action=//evil.com/@><input name=p@ss>'
		]) {
			const out = guardHtml(payload);
			expect(out.match(/(?<!\\)</g), payload).toBeNull();
			expect(out).toContain('\\<');
		}
	});

	it('leaves ordinary markdown alone', () => {
		const md = '# Title\n\nSome **bold** and _italic_ text.\n\n- one\n- two';
		expect(guardHtml(md)).toBe(md);
	});

	it('leaves autolinks working', () => {
		expect(guardHtml('see <https://example.com/a>')).toBe('see <https://example.com/a>');
		expect(guardHtml('mail <me@example.com>')).toBe('mail <me@example.com>');
	});

	it('shows HTML inside code verbatim, because a bot may be quoting it', () => {
		const fenced = '```html\n<iframe src="x"></iframe>\n```';
		expect(guardHtml(fenced)).toBe(fenced);
		const inline = 'use `<iframe>` here';
		expect(guardHtml(inline)).toBe(inline);
	});

	it('leaves comparisons and bare angle brackets readable', () => {
		expect(guardHtml('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
	});
});
