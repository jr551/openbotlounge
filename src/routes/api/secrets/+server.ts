import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, listVisibleBots, logActivity } from '$lib/server/db';
import { boolField, readJson, strField } from '$lib/server/http';
import { decrypt, deleteSecret, getSecret, listSecrets } from '$lib/server/secrets';

/**
 * Every bot's secret names, in one payload. Values are never sent to the client.
 * A hidden system bot (the police) holds no secrets and is not a bot the human
 * manages, so it is not listed here either.
 */
export const GET: RequestHandler = () => {
	return json({
		bots: listVisibleBots().map((bot) => ({
			id: bot.id,
			name: bot.name,
			color: bot.color,
			hat: bot.hat,
			secrets: listSecrets(bot.id).map((s) => ({
				name: s.name,
				shared_with: s.shared_with,
				created_at: s.created_at
			}))
		}))
	});
};

/**
 * The human revealing one secret's value. This is the only place a plaintext
 * secret ever leaves the server, and only to the person who owns the app -
 * never to a bot or the model. The look is logged on the owning bot's activity
 * so the trail shows who peeked and when.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 80) ?? '';
	const name = strField(body, 'name', 200) ?? '';
	if (!boolField(body, 'reveal')) throw error(400, 'reveal required');
	const bot = getBot(botId);
	if (!bot) throw error(404, 'bot not found');
	const row = getSecret(botId, name);
	if (!row) throw error(404, 'secret not found');
	logActivity(botId, 'secret', `The human revealed "${name}"`);
	return json({ name, value: decrypt(row.value) });
};

/**
 * The human deleting one secret outright. Shares die with it - a bot that was
 * allowed to inject it simply finds it gone.
 */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 80) ?? '';
	const name = strField(body, 'name', 200) ?? '';
	const bot = getBot(botId);
	if (!bot) throw error(404, 'bot not found');
	if (!deleteSecret(botId, name)) throw error(404, 'secret not found');
	logActivity(botId, 'secret', `The human deleted "${name}"`);
	return json({ ok: true });
};
