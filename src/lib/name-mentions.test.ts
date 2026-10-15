import { describe, expect, it } from 'vitest';
import { nameMentionRegex, nameMentionSegments } from './name-mentions';

describe('nameMentionSegments', () => {
	it('tints a bare bot name in prose', () => {
		const segs = nameMentionSegments('I talked to Pook about it', ['Pook']);
		expect(segs).toEqual([
			{ text: 'I talked to ', name: false },
			{ text: 'Pook', name: true },
			{ text: ' about it', name: false }
		]);
	});

	it('leaves an @mention alone - the pill owns that text', () => {
		const segs = nameMentionSegments('ping @Pook then Pook replied', ['Pook']);
		expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual(['Pook']);
		expect(segs.map((s) => s.text).join('')).toBe('ping @Pook then Pook replied');
	});

	it('matches case-insensitively but keeps the written casing', () => {
		const segs = nameMentionSegments('pook said POOK says hi', ['Pook']);
		expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual(['pook', 'POOK']);
	});

	it('needs a word boundary, so a name inside a longer word stays plain', () => {
		const segs = nameMentionSegments('Pookerville is not Pook', ['Pook']);
		expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual(['Pook']);
		expect(segs.map((s) => s.text).join('')).toBe('Pookerville is not Pook');
	});

	it('skips names inside code spans and fenced blocks', () => {
		const segs = nameMentionSegments('run `Pook --fast` then ask Pook\n```\nPook\n```', ['Pook']);
		expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual(['Pook']);
		expect(segs.map((s) => s.text).join('')).toBe('run `Pook --fast` then ask Pook\n```\nPook\n```');
	});

	it('skips names inside markdown links and bare URLs', () => {
		const segs = nameMentionSegments('see [Pook docs](https://Pook.example) or https://Pook.dev', [
			'Pook'
		]);
		expect(segs.every((s) => !s.name)).toBe(true);
	});

	it('tints several bots in one line', () => {
		const segs = nameMentionSegments('Pook told Marlow, and Marlow told Pook', ['Pook', 'Marlow']);
		expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual([
			'Pook',
			'Marlow',
			'Marlow',
			'Pook'
		]);
	});

	it('prefers the longer name when one bot name starts another', () => {
		const segs = nameMentionSegments('ask Pook Two, not Pook', ['Pook', 'Pook Two']);
		expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual(['Pook Two', 'Pook']);
	});

	it('escapes regex metacharacters in bot names', () => {
		const segs = nameMentionSegments('is a.b here? axb is not', ['a.b']);
		expect(segs.filter((s) => s.name).map((s) => s.text)).toEqual(['a.b']);
	});

	it('returns the text untouched when there are no bots', () => {
		expect(nameMentionSegments('hello Pook', [])).toEqual([{ text: 'hello Pook', name: false }]);
	});
});

describe('nameMentionRegex', () => {
	it('is safe to reuse across matchAll calls on different nodes', () => {
		const re = nameMentionRegex(['Pook']);
		const hits = ['see Pook here', 'Pook again'].map((t) =>
			[...t.matchAll(re)].map((m) => m.index)
		);
		expect(hits).toEqual([[4], [0]]);
	});
});
