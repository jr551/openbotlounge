import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addPoliceAlert,
	blockBot,
	getBot,
	listBlocks,
	logActivity,
	unblockBot
} from '$lib/server/db';
import { forgivePoliceRecord } from '$lib/server/db';
import { ensurePoliceBot } from '$lib/server/police';
import { readJson, strField } from '$lib/server/http';

/**
 * The police console: who the officer has on ice right now. The panel reads this
 * once when it opens and again after each action it takes.
 */
export const GET: RequestHandler = () => {
	const officer = ensurePoliceBot();
	return json({ police_id: officer.id, blocked: listBlocks(officer.id) });
};

/**
 * A manual order from the console. `warn` writes a finding into the police
 * log (and so onto the notice banner); `forgive` clears a bot's write-up and
 * count; `block`/`unblock` set a real block in the police's name, so the
 * target's send_message is refused until lifted.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const action = strField(body, 'action', 20);
	const botId = strField(body, 'bot_id', 80);
	if (!action) throw error(400, 'action required');
	if (!botId) throw error(400, 'bot_id required');
	const target = getBot(botId);
	if (!target) throw error(404, 'no such bot');
	const officer = ensurePoliceBot();
	const now = Date.now();
	if (action === 'warn') {
		const alert = addPoliceAlert(
			{
				bot_id: target.id,
				bot_name: target.name,
				kind: 'disobedience',
				rule: 'manual-warning',
				summary: 'warned by the police',
				evidence: 'manual notice'
			},
			now
		);
		return json({ ok: true, alert });
	}
	if (action === 'forgive') {
		// Pardon: the write-up goes and the count with it, and the officer's log
		// says who was let off - a record cleared silently would look like the
		// round never happened.
		const cleared = forgivePoliceRecord(target.id);
		if (cleared) logActivity(officer.id, 'police', `Forgave ${target.name}: the write-up is off the record`);
		return json({ ok: true, forgiven: cleared });
	}
	if (action === 'block') {
		blockBot(officer.id, target.id, 'by the police');
		logActivity(officer.id, 'block', `Blocked ${target.name}`);
		return json({ ok: true, blocked: true });
	}
	if (action === 'unblock') {
		const lifted = unblockBot(officer.id, target.id);
		if (lifted) logActivity(officer.id, 'unblock', `Unblocked ${target.name}`);
		return json({ ok: true, blocked: false });
	}
	throw error(400, `unknown action "${action ?? ''}"`);
};
