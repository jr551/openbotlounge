import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConversation, markConversationRead } from '$lib/server/db';

/** The user has caught up on this chat; clear its unread and ping badges. */
export const POST: RequestHandler = ({ params }) => {
	if (!getConversation(params.id)) throw error(404, 'conversation not found');
	markConversationRead(params.id);
	return json({ ok: true });
};
