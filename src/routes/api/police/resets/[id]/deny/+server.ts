import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { claimMachineReset, getBot, getMachineReset, logActivity } from '$lib/server/db';
import { ensurePoliceBot } from '$lib/server/police';

/**
 * Deny a reset: the machine stays as it is and the request is closed. The bot
 * can ask again - a denial is an answer, not a ban.
 */
export const POST: RequestHandler = async ({ params }) => {
	const req = getMachineReset(params.id);
	if (!req) throw error(404, 'reset request not found');
	// The claim is the lock: a concurrent approve updates zero rows and loses,
	// so a denial can never land after (or race) the wipe an approval starts.
	if (!claimMachineReset(req.id, 'denied')) throw error(409, 'that reset was already answered');
	const resolved = getMachineReset(req.id)!;
	const officer = ensurePoliceBot();
	const bot = getBot(req.bot_id);
	logActivity(officer.id, 'police', `Denied ${bot?.name ?? 'a bot'}'s machine reset`);
	if (bot) logActivity(bot.id, 'police', 'Your machine reset request was denied.');
	return json({ reset: resolved });
};
