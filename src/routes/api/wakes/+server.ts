import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, getConversation } from '$lib/server/db';
import { createWait, listWaits, listWakes, scheduleWake } from '$lib/server/wake';
import { boolField, readJson, numField, strField } from '$lib/server/http';

export const GET: RequestHandler = ({ url }) => {
	const botId = url.searchParams.get('bot_id') ?? undefined;
	return json({ wakes: listWakes(botId), waits: listWaits(botId) });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 80) ?? '';
	const convId = strField(body, 'conversation_id', 80) ?? '';
	if (!getBot(botId)) throw error(404, 'bot not found');
	if (!getConversation(convId)) throw error(404, 'conversation not found');
	if (boolField(body, 'wait') === true) {
		const description = (strField(body, 'description', 2000) ?? '').trim();
		if (!description) throw error(400, 'description required');
		// createWait refuses a watch that could never fire - a url aimed inside
		// the app's own network, a broken pattern, a room that does not exist -
		// by throwing. Without this the reason reached the caller as an opaque
		// 500 instead of the bad request it is.
		try {
			const wait = createWait(botId, convId, description.slice(0, 2000), {
				url: (strField(body, 'url', 2000) ?? '').trim(),
				contains: strField(body, 'contains', 500) ?? ''
			});
			return json(wait, { status: 201 });
		} catch (e) {
			throw error(400, (e as Error).message);
		}
	}
	const prompt = (strField(body, 'prompt', 4000) ?? '').trim();
	if (!prompt) throw error(400, 'prompt required');
	const cron = (strField(body, 'cron', 120) ?? '').trim();
	const runAt = numField(body, 'run_at') ?? 0;
	if (!cron && !runAt) throw error(400, 'run_at or cron required');
	if (runAt && runAt <= Date.now()) throw error(400, 'run_at is in the past');
	// A timestamp years out is almost always a units mistake (seconds, or a
	// stray digit); refuse it rather than park a wake no one will ever see.
	if (runAt > Date.now() + 10 * 365 * 86400_000) throw error(400, 'run_at is too far away');
	try {
		const wake = scheduleWake(botId, convId, prompt, {
			runAt: runAt || undefined,
			cron: cron || undefined
		});
		return json(wake, { status: 201 });
	} catch (e) {
		throw error(400, (e as Error).message);
	}
};
