import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listBotProposals } from '$lib/server/db';

/** Pending proposals to create a bot, for one chat. */
export const GET: RequestHandler = ({ url }) => {
	const conversationId = url.searchParams.get('conversation_id') ?? '';
	if (!conversationId) throw error(400, 'conversation_id required');
	return json({ proposals: listBotProposals(conversationId) });
};
