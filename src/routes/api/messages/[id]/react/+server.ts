import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addReaction, getMessage, removeReaction } from '$lib/server/db';
import { readJson, strField } from '$lib/server/http';

/** The user reacting to a message. Bots react through their own tool. */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!getMessage(params.id)) throw error(404, 'message not found');
	const emoji = strField(await readJson(request), 'emoji', 8) ?? '';
	if (emoji) addReaction(params.id, '', emoji);
	else removeReaction(params.id, '');
	return json({ ok: true, emoji });
};
