import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, logActivity } from '$lib/server/db';
import { readJson, strField } from '$lib/server/http';
import { readAccounts, writeAccounts } from '$lib/server/personality';

/**
 * The bot's accounts ledger as the app sees it: `accounts.md` on its own
 * drive, seeded on first read. Same shape as the scratchpad route so the
 * panel can treat them alike.
 */
export const GET: RequestHandler = async ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const content = await readAccounts(bot.id).catch(() => null);
	if (content === null) throw error(503, 'the bot’s drive could not be read');
	return json({ content, shared: false, updated_at: 0, versions: [] });
};

/** The human editing the ledger by hand. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const content = strField(body, 'content', 20000);
	if (content === undefined) throw error(400, 'content required');
	await writeAccounts(bot.id, content).catch((e) => {
		throw error(503, `the bot’s drive could not be written: ${(e as Error).message}`);
	});
	logActivity(bot.id, 'file', 'The human edited your accounts file');
	return json({ ok: true });
};
