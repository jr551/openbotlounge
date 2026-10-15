import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	dismissPoliceAlert,
	forgivePoliceRecord,
	getBot,
	listPoliceAlerts,
	listPoliceRecords,
	listPoliceRules,
	listSettings,
	logActivity,
	setSetting
} from '$lib/server/db';
import { readJson, strField } from '$lib/server/http';
import {
	creationSignOffs,
	ensurePoliceBot,
	nextPoliceRoundAt,
	policeIntervalMs,
	policeSettings,
	standingNotices
} from '$lib/server/police';
import { BUILT_IN_CRITERIA } from '$lib/server/police-review';

const HOUR = 3_600_000;

/**
 * The police log, for the Settings tab and the transient notice.
 *
 * `notices` is what has not been dismissed and has not yet expired - the tap on
 * the shoulder. `alerts` is the whole log, dismissals and all, which is the
 * durable record. Both come from one table; the difference is age and whether
 * the human has looked.
 */
export const GET: RequestHandler = () => {
	const rules = policeSettings();
	const set = listSettings();
	// The criteria book the review runs against: the built-ins with their
	// enabled flags, then the human's own rules - which are always enabled,
	// because retiring one is deleting it.
	const criteria = [
		...BUILT_IN_CRITERIA.map((c) => ({
			id: c.id,
			name: c.name,
			summary: c.text,
			pattern: '',
			custom: false,
			enabled: !rules.disabledRules.has(c.id)
		})),
		...listPoliceRules().map((r) => ({
			id: r.id,
			name: r.name || r.summary || 'custom rule',
			summary: r.summary,
			pattern: r.pattern,
			custom: true,
			enabled: true
		}))
	];
	return json({
		interval_hours: policeIntervalMs() / HOUR,
		next_round_at: nextPoliceRoundAt(),
		last_review_at: Number(set.police_last_review_at) || 0,
		records: listPoliceRecords(),
		// The court document names the officer as its presiding judge.
		officer: ensurePoliceBot().name,
		alerts: listPoliceAlerts(100),
		// The creation book: what the officer signed off - or refused - on
		// plugins, routines and wakes, read straight off the rows' verdicts.
		sign_offs: creationSignOffs(),
		notices: standingNotices(),
		rules: criteria,
		// What the console can tune, as it stands right now, so the form shows the
		// switches in force rather than the ones this build shipped with.
		settings: {
			interval_hours: rules.intervalHours,
			write_ups: rules.writeUps,
			patrol: rules.patrol,
			check_plugins: rules.checkPlugins,
			check_routines: rules.checkRoutines,
			check_wakes: rules.checkWakes,
			// The console's Jailing select binds to this. Without it the form fell
			// back to its own 'confirm' default and the next save wrote that back,
			// silently reverting a choice the human had made.
			jail_mode: rules.jailMode
		}
	});
};

/**
 * The console's own two writes: dismissing a notice (it stays in the log,
 * stamped with when it was seen) and pardoning a bot, which clears its record
 * and says so in the officer's log.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const id = strField(body, 'dismiss', 80);
	if (id) return json({ dismissed: dismissPoliceAlert(id, Date.now()) });

	const forgivenId = strField(body, 'forgive', 80);
	if (!forgivenId) throw error(400, 'dismiss or forgive required');
	const bot = getBot(forgivenId);
	if (!bot) return json({ forgiven: false });
	const cleared = forgivePoliceRecord(bot.id);
	if (cleared) {
		const officer = ensurePoliceBot();
		logActivity(officer.id, 'police', `Forgave ${bot.name}: the write-up is off the record`);
	}
	return json({ forgiven: cleared });
};
