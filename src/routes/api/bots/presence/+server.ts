import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listBots } from '$lib/server/db';
import { presenceForBots } from '$lib/server/machine';

/**
 * One answer for the whole fleet's machine presence, so the header dots cost
 * a single Docker list call however many bots are in the room. A machine that
 * is merely stopped is 'sleeping' — the UI says "asleep"; 'off' means the bot
 * has no machine container at all, which for a chat-only tier is not a state
 * to surface at all. An archived bot is out of the picture on its own row's
 * authority, without asking Docker about it.
 */
export const GET: RequestHandler = async () => {
	const bots = listBots();
	const machines = await presenceForBots(bots.map((b) => b.id));
	const presence: Record<string, string> = {};
	for (const b of bots) presence[b.id] = b.archived ? 'archived' : (machines[b.id] ?? 'off');
	return json({ presence });
};
