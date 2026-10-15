import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, listPeers, peerForConversation } from '$lib/server/db';
import { connectPeer, isHttpUrl, parseInvite, removePeer } from '$lib/server/federation';
import { readJson, strField } from '$lib/server/http';

/**
 * The human's side of pairing. GET answers the two questions the UI asks -
 * which peers a bot has, and whether the open conversation is a fed pair -
 * POST accepts a pasted invite and connects, DELETE unpairs.
 */
export const GET: RequestHandler = ({ url }) => {
	const conversationId = url.searchParams.get('conversation_id');
	if (conversationId) return json({ peer: peerForConversation(conversationId) ?? null });
	const botId = url.searchParams.get('bot_id');
	return json({ peers: listPeers(botId ?? undefined) });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 64);
	const blob = strField(body, 'invite', 2000);
	const endpoint = strField(body, 'endpoint', 300);
	if (!botId || !blob) throw error(400, 'bot_id and invite required');
	const bot = getBot(botId);
	if (!bot || bot.hidden) throw error(404, 'no such bot');
	const invite = parseInvite(blob);
	if (!invite) throw error(400, 'that does not read as an Openbotlounge invite');
	if (!endpoint || !isHttpUrl(endpoint)) throw error(400, 'endpoint must be an http(s) URL');
	const { peer, confirmed, error: backError } = await connectPeer(botId, invite, endpoint);
	return json({ peer, confirmed, error: backError });
};

export const DELETE: RequestHandler = ({ url }) => {
	const id = url.searchParams.get('id');
	if (!id) throw error(400, 'id required');
	if (!removePeer(id)) throw error(404, 'no such peer');
	return new Response(null, { status: 204 });
};
