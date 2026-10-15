import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import {
	DEBUG_GRANT_MINUTES,
	approveDebugAccess,
	clearDebugAccess,
	debugState
} from '$lib/server/debug';
import { boolField, numField, readJson } from '$lib/server/http';
import { withSshKey } from '$lib/server/ssh-keys';

/** How long one approval may last, and how short: a session, not a lease. */
const MIN_GRANT_MINUTES = 5;
const MAX_GRANT_MINUTES = 240;

/** The ask and the access a bot holds, as the thread's card and badge show them. */
export const GET: RequestHandler = ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	return json(debugState(bot));
};

/**
 * The human's verdict, and their revoke. This route is the only thing in the
 * app that writes a grant: no tool a bot can call reaches debug_grant, so a bot
 * asking with request_debug_access can never approve itself, and a tool result
 * cannot fabricate one. Approving is always for a bounded time, so a grant
 * nobody remembers is gone on its own.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);

	if (boolField(body, 'revoke')) {
		if (!debugState(bot).grant) throw error(409, 'no debug access to revoke');
		clearDebugAccess(bot.id, 'revoked');
		return json(withSshKey(getBot(bot.id) ?? bot));
	}

	// Both verdicts require a request to answer: Approve with nothing pending
	// would hand out access the bot never asked for.
	const ask = debugState(bot).request;
	if (!ask) throw error(409, 'no debug request pending');
	if (!boolField(body, 'approve')) {
		clearDebugAccess(bot.id, 'declined');
		return json(withSshKey(getBot(bot.id) ?? bot));
	}

	const asked = numField(body, 'minutes');
	const minutes = Math.round(
		Math.min(MAX_GRANT_MINUTES, Math.max(MIN_GRANT_MINUTES, asked ?? DEBUG_GRANT_MINUTES))
	);
	approveDebugAccess(bot.id, minutes);
	return json(withSshKey(getBot(bot.id) ?? bot));
};
