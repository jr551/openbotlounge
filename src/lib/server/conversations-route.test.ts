import { describe, expect, it } from 'vitest';
import { conversationBots, createBot, listConversations } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/conversations/+server';

function makeBot(name: string): string {
	return createBot({ name, persona: '', avatar: '', color: '', model: '', badge: '' }).id;
}

/**
 * The status a request answered with, the message a refusal carried, and the new
 * conversation's id. SvelteKit's error() throws an HttpError (not an Error), so
 * the body is narrowed by shape rather than trusted through a cast.
 */
async function post(body: unknown): Promise<{ status: number; message: string; id: string }> {
	const request = new Request('http://test/api/conversations', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	try {
		const res = await POST({ request } as Parameters<typeof POST>[0]);
		const created = (await res.json()) as { id: string };
		return { status: res.status, message: '', id: created.id };
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') {
			const payload = 'body' in e ? e.body : undefined;
			const message =
				payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
					? payload.message
					: '';
			return { status: e.status, message, id: '' };
		}
		throw e;
	}
}

describe('POST /api/conversations', () => {
	// The same id twice used to reach the second INSERT and violate the members
	// primary key: a 500, plus a conversation row with no members left behind.
	it('accepts a repeated bot id and keeps one member', async () => {
		const id = makeBot('DupBot');
		const created = await post({ bot_ids: [id, id] });
		expect(created.status).toBe(201);
		expect(conversationBots(created.id).map((b) => b.id)).toEqual([id]);
	});

	// Unknown ids used to be filtered out silently, so a group of two known bots
	// and one typo opened as a group of two.
	it('names an unknown bot id and creates nothing', async () => {
		const known = makeBot('KnownBot');
		const before = listConversations().length;
		const refused = await post({ bot_ids: [known, 'no-such-bot'] });
		expect(refused.status).toBe(404);
		expect(refused.message).toContain('no-such-bot');
		expect(listConversations()).toHaveLength(before);
	});

	it('refuses ids that are not strings', async () => {
		const refused = await post({ bot_ids: [makeBot('TypedBot'), 42] });
		expect(refused.status).toBe(400);
		expect(refused.message).toContain('bot_ids');
	});
});
