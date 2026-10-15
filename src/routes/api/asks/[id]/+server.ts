import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addMessage,
	directConversationWith,
	getBot,
	getChangeRequest,
	resolveChangeRequest
} from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';

/**
 * The human's ruling on a bot's ask: the Approve/Deny buttons on the card in
 * the police's chat. Approving says the human takes the change on - it is not
 * a promise the thing is already done - and the bot is told the verdict
 * privately, the same way a thumb reaches it.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const req = getChangeRequest(params.id);
	if (!req) throw error(404, 'no such request');
	const body = await readJson(request);
	const approve = boolField(body, 'approve') === true;
	if (!resolveChangeRequest(params.id, approve)) {
		throw error(409, 'that request was already answered');
	}
	const bot = getBot(req.bot_id);
	if (bot) {
		// The verdict reaches the bot as a line in its own chat: a user-role
		// message it reads on its next turn, and one the human can see too.
		const conv = directConversationWith(bot.id);
		if (conv) {
			addMessage(
				conv.id,
				'user',
				`[Police] Your request "${req.need}" was ${approve ? 'approved - the human is on it' : 'denied'}.`,
				'',
				'',
				0,
				'app'
			);
		}
	}
	return json(getChangeRequest(params.id));
};
