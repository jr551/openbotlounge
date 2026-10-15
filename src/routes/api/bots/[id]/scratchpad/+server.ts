import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, logActivity } from '$lib/server/db';
import { readJson, strField } from '$lib/server/http';
import { readScratchpad, writeScratchpad } from '$lib/server/personality';

/**
 * The bot's scratchpad file as the app sees it: `scratchpad.md` on its own
 * drive, which is also where its `remember` writes land. The route keeps the
 * old scratchpad shape so the panel does not change: `versions` is empty now -
 * the file has no history - and `shared` is always false, because a file on
 * the bot's own drive is only ever its own.
 */
export const GET: RequestHandler = async ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const content = await readScratchpad(bot.id).catch(() => null);
	if (content === null) throw error(503, 'the bot’s drive could not be read');
	return json({ content, shared: false, updated_at: 0, versions: [] });
};

/** The human editing the file by hand. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const content = strField(body, 'content', 20000);
	if (content === undefined) throw error(400, 'content required');
	await writeScratchpad(bot.id, content).catch((e) => {
		throw error(503, `the bot’s drive could not be written: ${(e as Error).message}`);
	});
	logActivity(bot.id, 'file', 'The human edited your scratchpad');
	return json({ ok: true });
};
