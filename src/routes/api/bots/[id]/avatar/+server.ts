import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, updateBot } from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';
import { sanitizeIconSvg } from '$lib/server/plugins';
import { withSshKey } from '$lib/server/ssh-keys';

/**
 * The bot's face as the app sees it: the approved avatar (emoji or sanitized
 * SVG) plus any proposal still waiting on the human. The proposal is stored as
 * JSON ({avatar, note}); '' means "none".
 */
export const GET: RequestHandler = ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	return json({ avatar: bot.avatar, avatar_proposal: bot.avatar_proposal });
};

/**
 * The human's verdict on a pending proposal. Approve promotes the face to the
 * bot's avatar; decline just drops it. Either way the proposal is cleared, so
 * the card can never be answered twice. `revert` clears the avatar back to the
 * default blob.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const approve = boolField(body, 'approve');
	const revert = boolField(body, 'revert');
	if (approve && !bot.avatar_proposal) throw error(409, 'no avatar proposal pending');
	let avatar = bot.avatar;
	if (approve) {
		try {
			const proposed = String(JSON.parse(bot.avatar_proposal).avatar ?? '');
			// Re-check on the way in: the proposal was sanitized when it was
			// written, but the row is the only thing the page will ever render.
			avatar = proposed.startsWith('<') ? (sanitizeIconSvg(proposed) ?? '') : proposed.slice(0, 16);
		} catch {
			avatar = '';
		}
	} else if (revert) {
		avatar = '';
	}
	updateBot(bot.id, { avatar, avatar_proposal: '' });
	return json(withSshKey(getBot(bot.id) ?? bot));
};
