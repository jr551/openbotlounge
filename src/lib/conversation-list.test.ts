import { describe, expect, it } from 'vitest';
import { conversationSnippet, isLounge, isPairRoom } from './conversation-list';
import type { Conversation } from './types';

describe('conversationSnippet', () => {
	it('never cuts a surrogate pair in half at the clip point', () => {
		// 59 ascii chars then an emoji: a naive slice(0, 60) keeps the emoji's
		// lead surrogate and drops its trail, printing mojibake in the rail.
		const conv = { last_message: 'x'.repeat(59) + '🔥 tail' } as Conversation;
		const snippet = conversationSnippet(conv, []);
		expect(snippet.endsWith('…')).toBe(true);
		for (const ch of snippet) {
			const code = ch.codePointAt(0)!;
			expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
		}
	});
});

describe('isLounge / isPairRoom', () => {
	// The header and hero read `private` as "the lounge" until they learned to
	// ask for it by name: a two-bot pair room opened under the lounge's sofa
	// and title. These pin the distinction both checks now share.
	const lounge = { private: 1, title: 'Lounge', kind: 'group' } as Conversation;
	const pair = { private: 1, title: 'Pook ⇄ Tinker (bots only)', kind: 'group' } as Conversation;
	const group = { private: 0, title: 'New chat', kind: 'group' } as Conversation;

	it('knows the lounge by its title, not just the private flag', () => {
		expect(isLounge(lounge)).toBe(true);
		expect(isLounge(pair)).toBe(false);
		expect(isLounge(group)).toBe(false);
	});

	it('knows a pair room is private and two bots but not the lounge', () => {
		expect(isPairRoom(pair, [{} as never, {} as never])).toBe(true);
		expect(isPairRoom(lounge, [{} as never, {} as never])).toBe(false);
		expect(isPairRoom(pair, [{} as never])).toBe(false);
		expect(isPairRoom(group, [{} as never, {} as never])).toBe(false);
	});
});
