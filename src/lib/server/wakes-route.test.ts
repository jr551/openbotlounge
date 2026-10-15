import { describe, expect, it } from 'vitest';
import { createBot, createConversation } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/wakes/+server';

function makeFixture(): { botId: string; convId: string } {
	const bot = createBot({ name: 'w', persona: '', avatar: '', color: '', model: '', badge: '' });
	return { botId: bot.id, convId: createConversation([bot.id], 'direct').id };
}

/** The status, and the message a refusal carried, without trusting a cast. */
async function post(body: unknown): Promise<{ status: number; message: string }> {
	const request = new Request('http://test/api/wakes', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	try {
		const res = await POST({ request } as Parameters<typeof POST>[0]);
		return { status: res.status, message: '' };
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') {
			const payload = 'body' in e ? e.body : undefined;
			const message =
				payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
					? payload.message
					: '';
			return { status: e.status, message };
		}
		throw e;
	}
}

describe('POST /api/wakes watch refusals', () => {
	// createWait refuses a watch it could never arm by throwing, which reached
	// the caller as an opaque 500 "Internal Error" - the same refusal its callers
	// (the tool, another route) answer with, only unreadable.
	it('answers 400 with the reason when the watch is refused', async () => {
		const { botId, convId } = makeFixture();
		const refused = await post({
			bot_id: botId,
			conversation_id: convId,
			description: 'watch the app itself',
			wait: true,
			url: 'http://127.0.0.1:3000/'
		});
		expect(refused.status).toBe(400);
		expect(refused.message).toContain('internal to the app');
	});

	it('still arms a watch it can fire', async () => {
		const { botId, convId } = makeFixture();
		const armed = await post({
			bot_id: botId,
			conversation_id: convId,
			description: 'watch example',
			wait: true,
			url: 'https://example.com/'
		});
		expect(armed.status).toBe(201);
	});
});
