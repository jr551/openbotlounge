import { describe, expect, it } from 'vitest';
import {
	createBot,
	createChangeRequest,
	createConversation,
	directConversationWith,
	getChangeRequest,
	listMessages,
	pendingChangeRequests
} from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { GET as listAsks } from '../../routes/api/asks/+server';
import { POST as resolveAsk } from '../../routes/api/asks/[id]/+server';

let seq = 0;

/** A bot with an ask waiting on the human, as request_change leaves it. */
function askedBot() {
	const bot = createBot({
		name: `asker-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
	const req = createChangeRequest(bot.id, 'open the firewall', 'the peer needs a port');
	return { bot, req };
}

/** A POST to the resolve route, as the card's buttons send it. */
function post(id: string, body: unknown) {
	const request = new Request('http://test/resolve', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return resolveAsk({ request, params: { id } } as never);
}

/** The status a route answers with, error() throws included. */
async function status(fn: () => unknown): Promise<{ status: number }> {
	try {
		const res = (await fn()) as Response;
		return { status: res.status };
	} catch (e) {
		const err = e as { status?: number };
		return { status: err.status ?? 500 };
	}
}

describe('GET /api/asks', () => {
	it('lists the asks still waiting, with the asking bot\'s name', async () => {
		const { bot } = askedBot();
		const res = await listAsks({} as never);
		const data = await res.json();
		const mine = data.asks.filter((r: { bot_id: string }) => r.bot_id === bot.id);
		expect(mine).toHaveLength(1);
		expect(mine[0].bot_name).toBe(bot.name);
	});
});

describe('POST /api/asks/[id]', () => {
	it('approves the ask and tells the bot in its own chat', async () => {
		const { bot, req } = askedBot();
		// The verdict line lands in the bot's DM; it has to exist to hold it.
		createConversation([bot.id], 'direct');

		const res = await post(req.id, { approve: true });
		expect(res.status).toBe(200);
		expect(getChangeRequest(req.id)?.status).toBe('approved');
		expect(getChangeRequest(req.id)?.resolved_at).toBeGreaterThan(0);
		// Answered asks leave the pending list, so the card flips to done.
		expect(pendingChangeRequests().find((r) => r.id === req.id)).toBeUndefined();

		const dm = directConversationWith(bot.id)!;
		const verdict = listMessages(dm.id).find((m) => m.content.includes('open the firewall'));
		expect(verdict?.content).toContain('approved');
	});

	it('denies the ask and says so to the bot', async () => {
		const { bot, req } = askedBot();
		createConversation([bot.id], 'direct');

		const res = await post(req.id, { approve: false });
		expect(res.status).toBe(200);
		expect(getChangeRequest(req.id)?.status).toBe('denied');

		const dm = directConversationWith(bot.id)!;
		const verdict = listMessages(dm.id).find((m) => m.content.includes('open the firewall'));
		expect(verdict?.content).toContain('denied');
	});

	it('refuses to answer an ask that was already answered', async () => {
		const { req } = askedBot();
		await post(req.id, { approve: true });
		const res = await status(() => post(req.id, { approve: false }));
		expect(res.status).toBe(409);
		// The first ruling stands.
		expect(getChangeRequest(req.id)?.status).toBe('approved');
	});

	it('404s on an ask that does not exist', async () => {
		const res = await status(() => post('no-such-ask', { approve: true }));
		expect(res.status).toBe(404);
	});
});
