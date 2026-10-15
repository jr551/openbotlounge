import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	clearConversationMembers,
	getConversation,
	setConversationVerification,
	updateConversation
} from '$lib/server/db';
import { humanVerdict, verdictJson } from '$lib/server/police';
import { boolField, readJson } from '$lib/server/http';

/**
 * The human's ruling on a group room a bot asked for: the "Approve anyway"
 * button on a sign-off row the police refused. Approving seats the asker's
 * bots back in the room and opens it; denying empties it for good and leaves
 * the refusal as the human's own verdict on the row.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const conv = getConversation(params.id);
	if (!conv || conv.kind !== 'group') throw error(404, 'no such group chat');
	const body = await readJson(request);
	const approve = boolField(body, 'approve') === true;
	const verdict = humanVerdict(
		approve,
		approve ? 'approved by the human' : 'refused by the human'
	);
	setConversationVerification(conv.id, verdictJson(verdict));
	if (approve) {
		// The seats were emptied when the police refused; the asker's own line
		// in the room is the only record of who wanted in, so the human's
		// approval re-seats nobody - the bot is told and can open it again.
		updateConversation(conv.id, { pending: 0 });
	} else {
		clearConversationMembers(conv.id);
		updateConversation(conv.id, { pending: 1 });
	}
	return json({ ok: true, verification: verdictJson(verdict) });
};
