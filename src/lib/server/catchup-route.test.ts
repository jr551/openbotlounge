import { describe, expect, it } from 'vitest';
import {
	addMessage,
	createBot,
	createConversation,
	markConversationRead
} from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/conversations/[id]/catchup/+server';

type CatchupBody = { summary: string; count: number };

async function post(id: string, since?: number): Promise<CatchupBody> {
	const url = new URL(`http://test/api/conversations/${id}/catchup`);
	if (since !== undefined) url.searchParams.set('since', String(since));
	const request = new Request(url, { method: 'POST' });
	const res = await POST({ params: { id }, url, request } as Parameters<typeof POST>[0]);
	return (await res.json()) as CatchupBody;
}

describe('POST /api/conversations/[id]/catchup', () => {
	// The chat store asks for the digest and marks the chat read in the same
	// breath, and /read is the faster of the two: by the time the catch-up
	// request ran, last_read_at already said "just now" and the backlog looked
	// empty, so the digest almost never showed. The opener now sends the stamp
	// it saw, and this pins that the stamp - not the row - decides the window.
	it('summarises the backlog the opener saw, not the one markRead just erased', async () => {
		const bot = createBot({ name: 'CatchupBot', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const seenAt = Date.now() - 60_000;
		addMessage(conv.id, 'assistant', 'first thing that happened', bot.id);
		addMessage(conv.id, 'assistant', 'second thing that happened', bot.id);
		// The race, replayed: the read marker lands before the digest is asked for.
		markConversationRead(conv.id);
		const body = await post(conv.id, seenAt);
		expect(body.count).toBe(2);
	});

	it('falls back to the stored read stamp when no since is sent', async () => {
		const bot = createBot({ name: 'CatchupBot2', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		addMessage(conv.id, 'assistant', 'already read', bot.id);
		markConversationRead(conv.id);
		const body = await post(conv.id);
		expect(body.count).toBe(0);
	});

	it('ignores a since that is not a number', async () => {
		const bot = createBot({ name: 'CatchupBot3', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		addMessage(conv.id, 'assistant', 'already read', bot.id);
		markConversationRead(conv.id);
		const url = new URL(`http://test/api/conversations/${conv.id}/catchup?since=garbage`);
		const request = new Request(url, { method: 'POST' });
		const res = await POST({ params: { id: conv.id }, url, request } as Parameters<typeof POST>[0]);
		expect(((await res.json()) as CatchupBody).count).toBe(0);
	});
});
