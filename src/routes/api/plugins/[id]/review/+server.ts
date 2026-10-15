import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { getPlugin, selfTestPlugin } from '$lib/server/plugins';
import { policePlugin } from '$lib/server/plugin-gate';
import { verificationOf } from '$lib/plugin-verdict';

/**
 * The human asking the police to look at a plugin now: the action on a card the
 * gate never saw - written while the setting was off, or a row from before the
 * gate existed - or on one the officer could not be reached for, which is the
 * state that most needs asking again. Either way the row carries no ruling, so
 * there is nothing here to re-litigate.
 *
 * It is the same review the create paths run, not a second one: the officer's
 * verdict is stored on the row, an approval switches it on and a refusal
 * switches it off, exactly as it would have on the day it was written. A plugin
 * that already carries a verdict is refused instead: a decision is not quietly
 * reversed by asking again, and switching a decided plugin on or off is what
 * its own switch and the approve route are for. The gate's setting is
 * deliberately not consulted - the human asked, by hand.
 */
export const POST: RequestHandler = async ({ params }) => {
	const plugin = getPlugin(params.id);
	if (!plugin) throw error(404, 'plugin not found');
	const decided = verificationOf(plugin.verification);
	if (decided?.verdict === 'approved' || decided?.verdict === 'rejected') {
		throw error(
			409,
			`the police have already ruled on "${plugin.name}" (${decided.verdict === 'approved' ? 'verified' : 'refused'}) - update the plugin to have that judged again${decided.verdict === 'rejected' ? `, or overrule the refusal at /api/plugins/${plugin.id}/approve` : ''}`
		);
	}
	// The sandbox self-test runs in the author's machine; a shared plugin has
	// no author, so there is nowhere to run it and the officer is told that
	// rather than given a verdict built on a failed boot.
	const bot = plugin.author_bot_id ? (getBot(plugin.author_bot_id) ?? null) : null;
	const test = bot
		? await selfTestPlugin(plugin)
		: { ok: true, output: '(not run - a shared plugin has no author machine)' };
	await policePlugin(plugin, test, bot, true);
	return json(getPlugin(params.id));
};
