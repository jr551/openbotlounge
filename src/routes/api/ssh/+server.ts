import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	createSshRequest,
	deleteSshRequest,
	getBot,
	getConversation,
	getSshRequest,
	listSshRequests
} from '$lib/server/db';
import { numField, readJson, strField } from '$lib/server/http';

/**
 * The asks in one chat (or one bot's): the rows the SSH cards hang off.
 * The card itself carries the pubkey from the bot row, so these rows hold no
 * key material at all.
 */
export const GET: RequestHandler = ({ url }) => {
	const botId = url.searchParams.get('bot_id') ?? undefined;
	const convId = url.searchParams.get('conversation_id') ?? undefined;
	const rows = listSshRequests(botId);
	return json({ requests: convId ? rows.filter((r) => r.conversation_id === convId) : rows });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 80) ?? '';
	const convId = strField(body, 'conversation_id', 80) ?? '';
	if (!getBot(botId)) throw error(404, 'bot not found');
	if (!getConversation(convId)) throw error(404, 'conversation not found');
	const host = (strField(body, 'host', 253) ?? '').trim();
	const username = (strField(body, 'username', 64) ?? '').trim();
	if (!host) throw error(400, 'host required');
	if (!username) throw error(400, 'username required');
	if (/[\s@:/]/.test(host)) throw error(400, 'host is a bare hostname or IP, no user@, port or path');
	if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw error(400, 'username has characters ssh cannot use');
	const port = numField(body, 'port') ?? 22;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw error(400, 'port is 1-65535');
	const req = createSshRequest({ bot_id: botId, conversation_id: convId, host, username, port });
	return json({ request: req }, { status: 201 });
};

export const DELETE: RequestHandler = ({ url }) => {
	const id = url.searchParams.get('id');
	if (!id) throw error(400, 'id required');
	if (!getSshRequest(id)) throw error(404, 'no such request');
	if (!deleteSshRequest(id)) throw error(404, 'no such request');
	return new Response(null, { status: 204 });
};
