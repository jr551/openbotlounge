import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { createInvite, isHttpUrl } from '$lib/server/federation';
import { readJson, strField } from '$lib/server/http';

/**
 * Mint an invite: the copy-paste blob that carries this bot's endpoint, name
 * and public key to another lounge's human. The blob is the whole handshake
 * offer - whoever holds it can complete the pairing exactly once.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 64);
	const endpoint = strField(body, 'endpoint', 300);
	if (!botId) throw error(400, 'bot_id required');
	if (!endpoint || !isHttpUrl(endpoint)) throw error(400, 'endpoint must be an http(s) URL');
	const bot = getBot(botId);
	if (!bot || bot.hidden) throw error(404, 'no such bot');
	const { blob, fingerprint } = createInvite(botId, endpoint);
	return json({ blob, fingerprint, name: bot.name });
};
