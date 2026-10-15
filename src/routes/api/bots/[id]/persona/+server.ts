import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, logActivity, updateBot } from '$lib/server/db';
import { readJson, strField } from '$lib/server/http';
import { withSshKey } from '$lib/server/ssh-keys';

/**
 * The bot's persona as the app sees it: the approved text plus any proposal
 * still waiting on the human. The proposal is stored as JSON ({persona, note});
 * '' means "none". The card diffs proposal against bot.persona itself.
 */
export const GET: RequestHandler = ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	return json({ persona: bot.persona, persona_proposal: bot.persona_proposal });
};

/**
 * The human's verdict on a pending proposal. Approve promotes the proposed
 * persona to the bot's own; deny just drops it. Either way the proposal is
 * cleared, so the card can never be answered twice.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const action = strField(body, 'action', 20);
	if (action !== 'approve' && action !== 'deny') throw error(400, 'action must be approve or deny');
	if (!bot.persona_proposal) throw error(409, 'no persona proposal pending');
	let persona = bot.persona;
	if (action === 'approve') {
		try {
			persona = String(JSON.parse(bot.persona_proposal).persona ?? '').slice(0, 8000);
		} catch {
			persona = bot.persona;
		}
		logActivity(bot.id, 'style', 'The human approved your new persona');
	} else {
		logActivity(bot.id, 'style', 'The human declined your new persona');
	}
	updateBot(bot.id, { persona, persona_proposal: '' });
	return json(withSshKey(getBot(bot.id) ?? bot));
};
