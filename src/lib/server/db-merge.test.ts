import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	addMessage,
	createBot,
	createConversation,
	db,
	getConversation,
	getSummary,
	listConversations,
	listMessages,
	mergeDuplicateDirectChats,
	setSummary
} from './db';

/**
 * Repair of duplicate direct chats runs once at boot. Calling it directly keeps
 * this deterministic: an earlier version re-imported db.ts with vi.resetModules()
 * to reach the boot path, which made the result depend on which other test files
 * had already loaded the module.
 */
function duplicateDirectChat(botId: string): string {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		'INSERT INTO conversations (id, title, kind, private, created_at, updated_at) VALUES (?,?,?,?,?,?)'
	).run(id, 'New chat', 'direct', 0, now, now);
	db.prepare('INSERT INTO conversation_members (conversation_id, bot_id) VALUES (?,?)').run(id, botId);
	return id;
}

function bot() {
	return createBot({ name: 'merge', persona: '', avatar: '', color: '', model: '', badge: '' }).id;
}

describe('duplicate direct chats', () => {
	// conv_summaries is keyed by conversation_id, so moving the duplicate's row
	// onto a keeper that already has one used to violate the primary key. This
	// runs at boot, so that threw at module load and the server crash-looped.
	it('folds a duplicate whose summary collides with the keeper', () => {
		const id = bot();
		const keeper = createConversation([id], 'direct');
		const doomed = duplicateDirectChat(id);
		// The busier chat is the keeper, so give it more than one message: which
		// of two equally busy chats wins otherwise depends on updated_at, and
		// both are created inside the same millisecond here.
		addMessage(keeper.id, 'user', 'first');
		addMessage(keeper.id, 'user', 'second');
		addMessage(doomed, 'user', 'in the duplicate');
		setSummary(keeper.id, 'keeper summary', 1000);
		setSummary(doomed, 'duplicate summary', 2000);

		expect(() => mergeDuplicateDirectChats()).not.toThrow();

		expect(getConversation(doomed)).toBeUndefined();
		// The summary whose cursor covers further survives, and both transcripts are kept.
		expect(getSummary(keeper.id)?.summary).toBe('duplicate summary');
		expect(listMessages(keeper.id).map((m) => m.content).sort()).toEqual([
			'first',
			'in the duplicate',
			'second'
		]);
		expect(listConversations().filter((c) => c.kind === 'direct' && c.id === keeper.id)).toHaveLength(1);
	});

	it('leaves a lone direct chat alone', () => {
		const id = bot();
		const only = createConversation([id], 'direct');
		mergeDuplicateDirectChats();
		expect(getConversation(only.id)).toBeDefined();
	});
});
