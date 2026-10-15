import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	claimMachineReset,
	getBot,
	getMachineReset,
	logActivity,
	reopenMachineReset
} from '$lib/server/db';
import { ensurePoliceBot } from '$lib/server/police';
import { resetMachineKeepDocs } from '$lib/server/machine';

/**
 * Approve a reset: the bot's machine and drive are wiped and its .md files are
 * carried back onto the fresh volume. The request resolves only once the wipe
 * actually ran - a failed reset leaves the row pending so the human can try
 * again rather than losing the ask.
 */
export const POST: RequestHandler = async ({ params }) => {
	const req = getMachineReset(params.id);
	if (!req) throw error(404, 'reset request not found');
	const bot = getBot(req.bot_id);
	if (!bot) {
		// The bot is gone: there is nothing to wipe, so the request is denied
		// rather than left pending forever.
		claimMachineReset(req.id, 'denied');
		throw error(404, 'bot not found');
	}
	// Claim before the wipe: a concurrent deny (or a second approve) updates
	// zero rows and loses, so the destructive reset can never run twice or
	// after a denial.
	if (!claimMachineReset(req.id, 'approved')) throw error(409, 'that reset was already answered');
	const { kept } = await resetMachineKeepDocs(bot.id).catch((e: Error) => {
		// The wipe failed: put the ask back so the human can try again.
		reopenMachineReset(req.id);
		throw error(503, `the reset could not run: ${e.message}`);
	});
	const resolved = getMachineReset(req.id)!;
	const officer = ensurePoliceBot();
	logActivity(
		officer.id,
		'police',
		`Approved ${bot.name}'s machine reset - wiped, kept ${kept.length} .md file${kept.length === 1 ? '' : 's'}`
	);
	logActivity(bot.id, 'police', 'Your machine was reset; your notes were kept.');
	return json({ reset: resolved, kept });
};
