import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, updateBot } from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';
import { sanitizeChatCss } from '$lib/server/look';
import { withSshKey } from '$lib/server/ssh-keys';

/**
 * The bot's chat stylesheet as the app sees it: the approved sheet plus any
 * proposal still waiting on the human. The proposal is stored as JSON
 * ({css, note}); '' means "none".
 */
export const GET: RequestHandler = ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	return json({ custom_css: bot.custom_css, css_proposal: bot.css_proposal });
};

/**
 * The human's verdict on a pending proposal. Approve promotes the sheet to the
 * bot's custom_css; decline just drops it. Either way the proposal is cleared,
 * so the card can never be answered twice. `revert` clears the approved sheet
 * back to the default look.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const approve = boolField(body, 'approve');
	const revert = boolField(body, 'revert');
	if (approve && !bot.css_proposal) throw error(409, 'no css proposal pending');
	// The note is the pitch, not part of the sheet - it does not carry over.
	let css = bot.custom_css;
	if (approve) {
		try {
			css = sanitizeChatCss(JSON.parse(bot.css_proposal).css ?? '') ?? '';
		} catch {
			css = '';
		}
	} else if (revert) {
		css = '';
	}
	updateBot(bot.id, { custom_css: css, css_proposal: '' });
	return json(withSshKey(getBot(bot.id) ?? bot));
};
