import { describe, expect, it } from 'vitest';
import {
	createBot,
	createConversation,
	getBot,
	listBots,
	listBotProposals,
	type BotProposal
} from './db';
import { executeTool } from './tools';
import { GET as listPending } from '../../routes/api/bot-proposals/+server';
import { GET as readProposal, POST as resolveProposal } from '../../routes/api/bot-proposals/[id]/+server';

const spawn = (name: string) =>
	createBot({ name, persona: '', avatar: '', color: '', model: '', badge: '' });

/** A proposer, the chat it pitches in, and the tool call it makes from there. */
function scene(name: string) {
	const bot = spawn(name);
	const conv = createConversation([bot.id], 'direct');
	return {
		bot,
		conv,
		pitch: (args: unknown) =>
			executeTool('propose_bot', JSON.stringify(args), {
				senderBotId: bot.id,
				senderBotName: bot.name,
				conversationId: conv.id,
				depth: 0
			})
	};
}

const answer = (id: string, approve: boolean) =>
	resolveProposal({
		params: { id },
		request: new Request('http://x', { method: 'POST', body: JSON.stringify({ approve }) })
	} as never);

const proposalsIn = (conversationId: string) => listBotProposals(conversationId);
const payloadOf = (p: BotProposal) => JSON.parse(p.payload);

describe('bot proposes a new bot', () => {
	it('propose → approve creates the bot with the pitched model and clears the card', async () => {
		// No model pitched, so approving starts no provider call.
		const { conv, pitch } = scene('Pitcher');

		const out = await pitch({
			name: '  Cooper  ',
			persona: 'You are Cooper, the lounge bookkeeper.',
			color: '#4f8ef7',
			model: '',
			note: 'he does the books'
		});
		expect(out).toContain('proposal sent to the human');

		const [pending] = proposalsIn(conv.id);
		const payload = payloadOf(pending);
		expect(payload.name).toBe('Cooper');
		expect(payload.persona).toBe('You are Cooper, the lounge bookkeeper.');
		expect(payload.color).toBe('#4f8ef7');
		expect(payload.model).toBe('');
		expect(payload.note).toBe('he does the books');
		// A pitch creates nobody: the human has not answered yet.
		expect(listBots().some((b) => b.name === 'Cooper')).toBe(false);

		const res = await answer(pending.id, true);
		expect(res.status).toBe(201);
		const created = await res.json();
		expect(created.name).toBe('Cooper');
		expect(created.color).toBe('#4f8ef7');
		expect(created.model).toBe('');
		expect(getBot(created.id)?.persona).toBe('You are Cooper, the lounge bookkeeper.');
		expect(proposalsIn(conv.id)).toEqual([]);
	});

	it('decline drops the pitch and creates nobody', async () => {
		const { conv, pitch } = scene('Picker');
		await pitch({ name: 'Nobody', persona: 'You are Nobody.' });
		const [pending] = proposalsIn(conv.id);

		const res = await answer(pending.id, false);
		expect(res.status).toBe(200);
		expect(proposalsIn(conv.id)).toEqual([]);
		expect(listBots().some((b) => b.name === 'Nobody')).toBe(false);
	});

	it('refuses a pitch the bots API would refuse, and cuts what it would cut', async () => {
		const { conv, pitch } = scene('Sifter');
		spawn('Taken');
		for (const bad of [
			{ persona: 'You are nobody.' },
			{ name: 'Ghost' },
			{ name: 'Taken', persona: 'You are Taken.' },
			{ name: 'Ghost', persona: 'You are Ghost.', color: 'blue' },
			{ name: 'x'.repeat(61), persona: 'You are Ghost.' }
		]) {
			expect(await pitch(bad), JSON.stringify(bad)).toContain('error:');
		}
		expect(proposalsIn(conv.id)).toEqual([]);

		expect(
			await pitch({
				name: 'Longwinded',
				persona: 'y'.repeat(9000),
				note: 'n'.repeat(300)
			})
		).toContain('proposal sent to the human');
		const [long] = proposalsIn(conv.id);
		expect(payloadOf(long).persona).toHaveLength(8000);
		expect(payloadOf(long).note).toHaveLength(200);

		// One slot per bot, like the style card: a second pitch replaces the first.
		await pitch({ name: 'Second', persona: 'You are Second.' });
		expect(proposalsIn(conv.id)).toHaveLength(1);
		expect(payloadOf(proposalsIn(conv.id)[0]).name).toBe('Second');
	});

	it('a name taken after the pitch fails the approval and leaves nobody behind', async () => {
		const { conv, pitch } = scene('Late');
		await pitch({ name: 'Latecomer', persona: 'You are Latecomer.' });
		const [pending] = proposalsIn(conv.id);
		// Somebody gives a bot that name while the card is still on screen.
		const rival = spawn('latecomer');

		await expect(answer(pending.id, true)).rejects.toMatchObject({ status: 409 });
		// The bot that had the name is untouched, and the pitch is still there
		// for the human to decline rather than vanishing on a refused approve.
		expect(getBot(rival.id)?.name).toBe('latecomer');
		expect(listBots().filter((b) => b.name.toLowerCase() === 'latecomer')).toHaveLength(1);
		expect(proposalsIn(conv.id)).toHaveLength(1);

		await answer(pending.id, false);
		expect(proposalsIn(conv.id)).toEqual([]);
	});

	it('the card reads what is pending, and an answered pitch is gone', async () => {
		const { conv, pitch } = scene('Reader');
		await pitch({ name: 'Visible', persona: 'You are Visible.' });
		const [pending] = proposalsIn(conv.id);

		const listed = await listPending({
			url: new URL(`http://x/api/bot-proposals?conversation_id=${conv.id}`)
		} as never);
		expect((await listed.json()).proposals.map((p: BotProposal) => p.id)).toEqual([pending.id]);

		const one = await readProposal({ params: { id: pending.id } } as never);
		expect((await one.json()).payload).toBe(pending.payload);

		await answer(pending.id, false);
		const after = await listPending({
			url: new URL(`http://x/api/bot-proposals?conversation_id=${conv.id}`)
		} as never);
		expect((await after.json()).proposals).toEqual([]);
		// Both handlers answer synchronously, so the refusal is thrown by the call
		// itself; the wrapper hands it to `rejects` the way an async route would.
		await expect(
			(async () => readProposal({ params: { id: pending.id } } as never))()
		).rejects.toMatchObject({ status: 404 });
		await expect(
			(async () => listPending({ url: new URL('http://x/api/bot-proposals') } as never))()
		).rejects.toMatchObject({ status: 400 });
	});

	// Two answers to one card used to both read it before either deleted it, so
	// an approve racing a decline could create a bot the human also declined.
	// The delete is now the claim: only the answer that removes the row acts.
	it('lets only one of a racing approve and decline take the card', async () => {
		const { conv, pitch } = scene('SplitRacer');
		await pitch({ name: 'Split', persona: 'You are Split.' });
		const [pending] = proposalsIn(conv.id);

		const results = await Promise.allSettled([answer(pending.id, true), answer(pending.id, false)]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
		expect(loser.reason).toMatchObject({ status: 404 });
		expect(proposalsIn(conv.id)).toEqual([]);
		// The bot exists only if the approval was the answer that took the card.
		expect(listBots().filter((b) => b.name === 'Split')).toHaveLength(
			results[0].status === 'fulfilled' ? 1 : 0
		);
	});

	it('creates one bot when two approvals race', async () => {
		const { conv, pitch } = scene('TwinRacer');
		await pitch({ name: 'Twin', persona: 'You are Twin.' });
		const [pending] = proposalsIn(conv.id);

		const results = await Promise.allSettled([answer(pending.id, true), answer(pending.id, true)]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(listBots().filter((b) => b.name === 'Twin')).toHaveLength(1);
		expect(proposalsIn(conv.id)).toEqual([]);
	});
});
