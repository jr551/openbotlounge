import { describe, expect, it } from 'vitest';
import { createBot, getBot, parseBubbleThemes } from './db';
import { executeTool } from './tools';
import { GET, POST } from '../../routes/api/bots/[id]/themes/+server';
import { bubbleLook, bubbleThemesOf } from '../stores/chat.svelte';

const ctx = (botId: string) => ({
	senderBotId: botId,
	senderBotName: 'Crafter',
	conversationId: 'c1',
	depth: 0
});

const post = (id: string, body: unknown) =>
	POST({
		params: { id },
		request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
	} as never);

const newBot = () =>
	createBot({ name: 'Crafter', persona: '', avatar: '', color: '', model: '', badge: '' });

/** Propose a theme and answer the card, the way the human would. */
async function craft(botId: string, theme: Record<string, unknown>, approve = true) {
	const out = await executeTool('propose_bubble_theme', JSON.stringify(theme), ctx(botId));
	if (approve) await post(botId, { approve });
	return out;
}

describe('bot bubble themes', () => {
	it('propose → approve files the theme; decline clears it', async () => {
		const bot = newBot();
		expect(bot.bubble_themes).toBe('');
		expect(bot.theme_proposal).toBe('');

		const out = await executeTool(
			'propose_bubble_theme',
			JSON.stringify({
				name: 'confetti',
				bubble_color: '#3a2b4a',
				accent: '#ff8800',
				radius: '18px',
				badge: '🎉',
				note: 'for good news'
			}),
			ctx(bot.id)
		);
		expect(out).toContain('proposal sent to the human');

		const pending = getBot(bot.id)!;
		expect(pending.bubble_themes).toBe('');
		const proposal = JSON.parse(pending.theme_proposal);
		expect(proposal.name).toBe('confetti');
		expect(proposal.badge).toBe('🎉');
		expect(proposal.note).toBe('for good news');

		const getRes = await GET({ params: { id: bot.id } } as never);
		expect((await getRes.json()).theme_proposal).toBe(pending.theme_proposal);

		// Decline first: the proposal is dropped and the library stays empty.
		await post(bot.id, { approve: false });
		expect(getBot(bot.id)!.theme_proposal).toBe('');
		expect(getBot(bot.id)!.bubble_themes).toBe('');

		// Craft a second one and approve it.
		await craft(bot.id, { name: 'sober', text_color: '#eeeeee', radius: '0px' });
		const themes = parseBubbleThemes(getBot(bot.id)!.bubble_themes);
		expect(themes).toHaveLength(1);
		expect(themes[0].name).toBe('sober');
		expect(themes[0].radius).toBe('0px');
		// The note is the pitch, not part of the look.
		expect('note' in themes[0]).toBe(false);

		// The result the bot sees names the themes it already has.
		const next = await executeTool(
			'propose_bubble_theme',
			JSON.stringify({ name: 'gala', accent: '#00ff00' }),
			ctx(bot.id)
		);
		expect(next).toContain('sober');
	});

	it('rejects CSS injection, junk names, badges and empty themes', async () => {
		const bot = newBot();
		for (const bad of [
			{ name: 'evil', bubble_color: 'red;position:fixed' },
			{ name: 'evil', bubble_color: 'url(http://evil)' },
			{ name: 'evil', radius: 'expression(alert(1))' },
			{ name: 'evil', accent: 'javascript:alert(1)' },
			{ name: 'evil', text_color: 'x".onmouseover=alert(1)' },
			{ name: 'evil', bubble_color: 'a'.repeat(61) }
		]) {
			const out = await executeTool('propose_bubble_theme', JSON.stringify(bad), ctx(bot.id));
			expect(out).toContain('error:');
			expect(getBot(bot.id)!.theme_proposal).toBe('');
		}
		// A badge is emoji only: ASCII could spell markup or a CSS keyword.
		for (const badge of ['AB', '".onmouseover=alert(1)', 'url(x)', '🎉🎉🎉🎉🎉']) {
			const out = await executeTool(
				'propose_bubble_theme',
				JSON.stringify({ name: 'evil', accent: '#ff0000', badge }),
				ctx(bot.id)
			);
			expect(out).toContain('error:');
		}
		// The name travels in message text, so it is a slug and nothing else.
		for (const name of [
			'Party Time',
			'party!',
			'-leading',
			'a'.repeat(25),
			'default',
			'base',
			''
		]) {
			const out = await executeTool(
				'propose_bubble_theme',
				JSON.stringify({ name, accent: '#ff0000' }),
				ctx(bot.id)
			);
			expect(out).toContain('error:');
		}
		// A shouted name is the same name: it is filed in lowercase.
		await craft(bot.id, { name: 'LOUD', accent: '#ff0000' });
		expect(parseBubbleThemes(getBot(bot.id)!.bubble_themes)[0].name).toBe('loud');
		const bare = await executeTool(
			'propose_bubble_theme',
			JSON.stringify({ name: 'bare', note: 'nothing to it' }),
			ctx(bot.id)
		);
		expect(bare).toContain('error:');
		expect(getBot(bot.id)!.theme_proposal).toBe('');
	});

	it('refuses a name the bot already uses, and stops at eight themes', async () => {
		const bot = newBot();
		for (let i = 0; i < 8; i++) await craft(bot.id, { name: `t${i}`, accent: '#ff0000' });
		expect(parseBubbleThemes(getBot(bot.id)!.bubble_themes)).toHaveLength(8);

		const dup = await executeTool(
			'propose_bubble_theme',
			JSON.stringify({ name: 't3', accent: '#00ff00' }),
			ctx(bot.id)
		);
		expect(dup).toContain('already have a theme');
		const full = await executeTool(
			'propose_bubble_theme',
			JSON.stringify({ name: 'nine', accent: '#00ff00' }),
			ctx(bot.id)
		);
		expect(full).toContain('library is full');
		expect(getBot(bot.id)!.theme_proposal).toBe('');
	});

	it('applies a directive only for an approved theme, and strips it only then', async () => {
		const bot = newBot();
		await craft(bot.id, { name: 'party', accent: '#ff8800', badge: '🎉' });
		const themes = bubbleThemesOf(getBot(bot.id)!);
		expect(themes.map((t) => t.name)).toEqual(['party']);

		const used = bubbleLook('[[bubble:party]]\nGood news, everyone', themes);
		expect(used.theme?.name).toBe('party');
		expect(used.text).toBe('Good news, everyone');

		// A shouted directive means the same theme.
		const shouted = bubbleLook('[[bubble:PARTY]]\nGood news', themes);
		expect(shouted.theme?.name).toBe('party');
		expect(shouted.text).toBe('Good news');

		// A name the bot does not have is left exactly as it was sent: nothing
		// stripped, so the mistake stays visible.
		const unknown = bubbleLook('[[bubble:gala]]\nGood news', themes);
		expect(unknown.theme).toBeNull();
		expect(unknown.text).toBe('[[bubble:gala]]\nGood news');

		// A declined theme is just as unknown as a typo.
		await craft(bot.id, { name: 'gala', accent: '#00ff00' }, false);
		const declined = bubbleLook('[[bubble:gala]]\nGood news', bubbleThemesOf(getBot(bot.id)!));
		expect(declined.theme).toBeNull();
		expect(declined.text).toBe('[[bubble:gala]]\nGood news');

		// The directive is a name, never markup: anything else is ordinary text.
		const sneaky = bubbleLook('[[bubble:party;background:url(x)]]\nGood news', themes);
		expect(sneaky.theme).toBeNull();
		expect(sneaky.text).toBe('[[bubble:party;background:url(x)]]\nGood news');
		expect(bubbleLook('Look at this [[bubble:party]]', themes).theme).toBeNull();
	});
});
