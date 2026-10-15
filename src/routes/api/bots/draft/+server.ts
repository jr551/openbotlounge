import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { draftBotDescription } from '$lib/server/bot-draft';
import { readJson, strField } from '$lib/server/http';

/**
 * The new-bot wizard's draft step: the human says what the bot is for, the
 * police writes a first persona and a one-line description from it, and the
 * human edits the result before Accept creates the bot through POST /api/bots.
 * Nothing is created here - the route only drafts.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const purpose = (strField(body, 'purpose', 1000) ?? '').trim();
	if (!purpose) throw error(400, 'purpose required');
	return json(await draftBotDescription(purpose));
};
