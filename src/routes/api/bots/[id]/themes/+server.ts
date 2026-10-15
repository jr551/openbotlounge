import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, parseBubbleThemes, updateBot, type BubbleTheme } from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';
import { withSshKey } from '$lib/server/ssh-keys';

/**
 * The bot's own bubble themes as the app sees them: the approved library plus
 * any proposal still waiting on the human. Both are JSON strings on the bot
 * row; '' means "none".
 */
export const GET: RequestHandler = ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	return json({ themes: bot.bubble_themes, theme_proposal: bot.theme_proposal });
};

/**
 * The human's verdict on a pending theme proposal. Approve files the theme in
 * the bot's library - the note is the pitch and stays out of it - and decline
 * just drops it. Either way the proposal is cleared, so the card can never be
 * answered twice.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const approve = boolField(body, 'approve');
	if (approve && !bot.theme_proposal) throw error(409, 'no theme proposal pending');
	const themes = parseBubbleThemes(bot.bubble_themes);
	let library = bot.bubble_themes;
	if (approve) {
		let theme: BubbleTheme | undefined;
		try {
			// The stored blob carries the note too; the pitch is not part of the look.
			const { note: _note, ...rest } = JSON.parse(bot.theme_proposal) as BubbleTheme & {
				note?: string;
			};
			theme = rest;
		} catch {
			theme = undefined;
		}
		if (!theme?.name) throw error(409, 'the pending theme proposal is unreadable');
		// The bot may not have two themes under one name, and the card is the
		// last moment that can be caught before the library is ambiguous.
		if (themes.some((t) => t.name === theme.name)) {
			throw error(409, `a theme called "${theme.name}" is already approved`);
		}
		library = JSON.stringify([...themes, theme]);
	}
	updateBot(bot.id, { bubble_themes: library, theme_proposal: '' });
	return json(withSshKey(getBot(bot.id) ?? bot));
};
