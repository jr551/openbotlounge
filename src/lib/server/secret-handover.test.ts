import { describe, expect, it, vi } from 'vitest';
import { createBot, createConversation, db, listMessages } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/bots/[id]/secrets/+server';
import { listSecrets } from '$lib/server/secrets';

vi.mock('$lib/server/machine', () => ({
	machineExec: vi.fn(async () => 'OBL_INJECTED')
}));

function makeBot(name: string) {
	return createBot({ name, persona: '', avatar: '', color: '', model: '', badge: '' });
}

function handover(botId: string, body: Record<string, unknown>) {
	const request = new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return POST({ params: { id: botId }, request } as Parameters<typeof POST>[0]);
}

describe('POST /api/bots/[id]/secrets', () => {
	it('records the handover as an excluded secret message naming the bot, never the value', async () => {
		const bot = makeBot('Keeper');
		const conv = createConversation([bot.id], 'direct');

		const res = await handover(bot.id, {
			name: 'api_key',
			value: 'PLAINTEXT-VALUE',
			conversation_id: conv.id
		});
		expect(res.status).toBe(201);

		const notes = listMessages(conv.id).filter((m) => m.kind === 'secret');
		expect(notes).toHaveLength(1);
		expect(notes[0].bot_id).toBe(bot.id);
		expect(notes[0].content).toBe('api_key');
		expect(notes[0].excluded).toBe(1);

		// The value must not be reachable through the transcript at all.
		const leaked = db
			.prepare('SELECT COUNT(*) AS n FROM messages WHERE content LIKE ?')
			.get('%PLAINTEXT-VALUE%') as { n: number };
		expect(leaked.n).toBe(0);
	});

	it('stores the secret without a thread note when no conversation is given', async () => {
		const bot = makeBot('Quiet');
		const res = await handover(bot.id, { name: 'token', value: 'v' });
		expect(res.status).toBe(201);
		const notes = db
			.prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND kind = 'secret'")
			.get(bot.id) as { n: number };
		expect(notes.n).toBe(0);
	});

	it('refuses a conversation_id that names no conversation, storing nothing', async () => {
		const bot = makeBot('Wary');
		let thrown: { status?: number } = {};
		try {
			await handover(bot.id, { name: 'k', value: 'v', conversation_id: 'no-such-conv' });
		} catch (e) {
			thrown = e as { status?: number };
		}
		expect(thrown.status).toBe(404);
		// The refusal comes before the write: no half-done handover is left behind.
		expect(listSecrets(bot.id)).toHaveLength(0);
	});
});
