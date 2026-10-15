import { describe, expect, it } from 'vitest';
import { mentionRegex } from './mentions';

describe('mentionRegex', () => {
	it('chips bot names and the human handles', () => {
		const re = mentionRegex(['Pook', 'Marlow']);
		expect([...'hey @Pook and @you'.matchAll(re)].map((m) => m[0])).toEqual(['@Pook', '@you']);
	});

	it('escapes regex metacharacters in bot names', () => {
		const re = mentionRegex(['a.b', 'c+d']);
		expect([...'ping @a.b and @axb and @c+d'.matchAll(re)].map((m) => m[0])).toEqual([
			'@a.b',
			'@c+d'
		]);
	});

	it('finds a mention at the start of every node scanned, not just the first', () => {
		// The thread walks text nodes and asks each one "does a mention start
		// here". A shared /g regex carries lastIndex between .test() calls, so
		// the node after a match was scanned from the middle and its leading
		// mention was skipped. matchAll is the contract the walker relies on.
		const re = mentionRegex(['Pook']);
		const nodes = ['see @Pook here', '@Pook again at the start'];
		const hits = nodes.map((text) => [...text.matchAll(re)].map((m) => m.index));
		expect(hits).toEqual([[4], [0]]);
	});
});
