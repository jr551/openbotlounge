import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, logActivity } from '$lib/server/db';
import { readJson, strField } from '$lib/server/http';
import { readDirectoryProfile, writeDirectoryProfile } from '$lib/server/personality';

/**
 * The bot's page in the company directory (`/company/directory/<botId>.md`
 * on the shared company drive), as its card shows it. Seeded from the persona
 * on first read. Same shape as the accounts route so the panels treat alike.
 */
export const GET: RequestHandler = async ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const content = await readDirectoryProfile(bot.id).catch(() => null);
	if (content === null) throw error(503, 'the company drive could not be read');
	return json({ content });
};

/** The human editing the profile by hand. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const content = strField(body, 'content', 20000);
	if (content === undefined) throw error(400, 'content required');
	await writeDirectoryProfile(bot.id, content).catch((e) => {
		throw error(503, `the company drive could not be written: ${(e as Error).message}`);
	});
	logActivity(bot.id, 'file', 'The human edited your company profile');
	return json({ ok: true });
};
