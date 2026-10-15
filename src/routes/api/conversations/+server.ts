import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createConversation, getBot, listConversations } from '$lib/server/db';
import { readJson } from '$lib/server/http';

export const GET: RequestHandler = () => {
	return json({ conversations: listConversations() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const raw = Array.isArray(body.bot_ids) ? body.bot_ids : [];
	if (!raw.length) throw error(400, 'bot_ids required');
	if (raw.some((id) => typeof id !== 'string')) throw error(400, 'bot_ids must be strings');
	// A repeated id would violate conversation_members' primary key partway
	// through the insert; an unknown one used to be dropped, quietly opening a
	// room that was not the one that was asked for.
	const botIds = [...new Set(raw as string[])];
	const unknown = botIds.filter((id) => !getBot(id));
	if (unknown.length) throw error(404, `unknown bot_ids: ${unknown.join(', ')}`);
	const kind = botIds.length > 1 ? 'group' : 'direct';
	const conv = createConversation(botIds, kind);
	return json(conv, { status: 201 });
};
