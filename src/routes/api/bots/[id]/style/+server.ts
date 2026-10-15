import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, updateBot } from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';
import { withSshKey } from '$lib/server/ssh-keys';

/**
 * The bot's bubble style as the app sees it: the approved fields plus any
 * proposal still waiting on the human. Both are stored as JSON strings on the
 * bot row; '' means "none".
 */
export const GET: RequestHandler = ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	return json({ style: bot.style, style_proposal: bot.style_proposal });
};

/**
 * The human's verdict on a pending proposal. Approve promotes the proposal to
 * the bot's style; decline just drops it. Either way the proposal is cleared,
 * so the card can never be answered twice.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const approve = boolField(body, 'approve');
	if (approve && !bot.style_proposal) throw error(409, 'no style proposal pending');
	// The note is the pitch, not part of the look - it does not carry over.
	let style = '';
	if (approve) {
		try {
			const { note: _note, ...fields } = JSON.parse(bot.style_proposal);
			style = JSON.stringify(fields);
		} catch {
			style = bot.style_proposal;
		}
	}
	updateBot(bot.id, { style: approve ? style : bot.style, style_proposal: '' });
	return json(withSshKey(getBot(bot.id) ?? bot));
};
