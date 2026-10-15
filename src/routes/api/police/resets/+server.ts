import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, listMachineResets } from '$lib/server/db';

/**
 * The machine-reset queue: bots file requests with request_machine_reset, the
 * human answers them here. Pending rows lead, then the newest decided ones -
 * the console shows the queue and a little of its history.
 */
export const GET: RequestHandler = () => {
	const resets = listMachineResets().map((r) => ({
		...r,
		bot_name: getBot(r.bot_id)?.name ?? 'a bot that is gone'
	}));
	return json({ resets });
};
