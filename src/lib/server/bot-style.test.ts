import { describe, expect, it } from 'vitest';
import { createBot, getBot } from './db';
import { executeTool } from './tools';
import { GET, POST } from '../../routes/api/bots/[id]/style/+server';

const ctx = (botId: string) => ({
	senderBotId: botId,
	senderBotName: 'Styler',
	conversationId: 'c1',
	depth: 0
});

const post = (id: string, body: unknown) =>
	POST({
		params: { id },
		request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
	} as never);

describe('bot bubble style', () => {
	it('propose → approve → style applies; decline clears', async () => {
		const bot = createBot({ name: 'Styler', persona: '', avatar: '', color: '', model: '', badge: '' });
		expect(bot.style).toBe('');
		expect(bot.style_proposal).toBe('');

		const out = await executeTool(
			'propose_style',
			JSON.stringify({
				font_family: 'Georgia',
				bubble_color: '#2b2f4a',
				text_color: 'rgb(240,240,250)',
				accent: '#7fb2ff',
				note: 'a moody library look'
			}),
			ctx(bot.id)
		);
		expect(out).toContain('proposal sent to the human');

		const pending = getBot(bot.id)!;
		expect(pending.style).toBe('');
		const proposal = JSON.parse(pending.style_proposal);
		expect(proposal.bubble_color).toBe('#2b2f4a');
		expect(proposal.note).toBe('a moody library look');

		const getRes = await GET({ params: { id: bot.id } } as never);
		expect((await getRes.json()).style_proposal).toBe(pending.style_proposal);

		// Decline first: proposal dropped, style untouched.
		await post(bot.id, { approve: false });
		expect(getBot(bot.id)!.style_proposal).toBe('');
		expect(getBot(bot.id)!.style).toBe('');

		// Propose again, then approve.
		await executeTool('propose_style', JSON.stringify({ accent: '#ff8800' }), ctx(bot.id));
		const res = await post(bot.id, { approve: true });
		const updated = await res.json();
		expect(JSON.parse(updated.style).accent).toBe('#ff8800');
		expect(updated.style_proposal).toBe('');
		expect(JSON.parse(getBot(bot.id)!.style).accent).toBe('#ff8800');
	});

	it('rejects CSS injection and empty proposals', async () => {
		const bot = createBot({ name: 'Evil', persona: '', avatar: '', color: '', model: '', badge: '' });
		for (const bad of [
			{ bubble_color: 'red;position:fixed' },
			{ bubble_color: 'url(http://evil)' },
			{ text_color: 'expression(alert(1))' },
			{ accent: 'javascript:alert(1)' },
			{ font_family: 'x".onmouseover=alert(1)' },
			{ bubble_color: 'a'.repeat(61) }
		]) {
			const out = await executeTool('propose_style', JSON.stringify(bad), ctx(bot.id));
			expect(out).toContain('error:');
			expect(getBot(bot.id)!.style_proposal).toBe('');
		}
		const out = await executeTool('propose_style', JSON.stringify({ note: 'nothing' }), ctx(bot.id));
		expect(out).toContain('error:');
	});
});
