import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteRoutine, listRoutines, setRoutineEnabled, updateRoutine } from '$lib/server/db';
import { nextCronRun } from '$lib/server/wake';
import { boolField, numField, readJson, strField } from '$lib/server/http';

/**
 * Edit a routine, or flip it on and off.
 *
 * A body carrying only `enabled` is the panel's toggle and writes that one
 * column. Anything else is an edit of the routine's own fields, checked the
 * same way a new routine is: the prompt has to say something, the interval has
 * to be a real number of minutes, and a cron expression has to parse. A changed
 * schedule is rescheduled from now, while an edit that left the schedule alone
 * keeps the run it already had coming.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	const routine = listRoutines().find((r) => r.id === params.id);
	if (!routine) throw error(404, 'no such routine');

	const enabled = boolField(body, 'enabled');
	const prompt = strField(body, 'prompt', 4000);
	const cron = strField(body, 'cron', 120);
	const given = numField(body, 'interval_min');

	if (prompt === undefined && cron === undefined && given === undefined) {
		if (enabled === undefined) throw error(400, 'enabled is required');
		setRoutineEnabled(params.id, enabled);
		return json({ ok: true });
	}

	const nextPrompt = (prompt ?? routine.prompt).trim();
	if (!nextPrompt) throw error(400, 'prompt required');
	if (given !== undefined && (!Number.isInteger(given) || given < 1)) {
		throw error(400, 'interval_min must be a whole number of minutes, at least 1');
	}
	const nextCron = (cron ?? routine.cron).trim();
	const nextInterval = Math.min(10080, given ?? routine.interval_min);

	let nextRunAt = routine.next_run_at;
	if (cron !== undefined || given !== undefined) {
		// Cron wins when present, the interval is the fallback - the same rule the
		// create route applies to a new routine.
		if (nextCron) {
			const next = nextCronRun(nextCron, Date.now());
			if (next === null)
				throw error(400, 'cron must be a 5-field expression, e.g. "0 9 * * 1-5"');
			nextRunAt = next;
		} else {
			nextRunAt = Date.now() + nextInterval * 60_000;
		}
	}

	const updated = updateRoutine(params.id, {
		prompt: nextPrompt,
		interval_min: nextInterval,
		cron: nextCron,
		next_run_at: nextRunAt,
		enabled: enabled === undefined ? routine.enabled : enabled ? 1 : 0
	});
	return json(updated);
};

export const DELETE: RequestHandler = ({ params }) => {
	if (!deleteRoutine(params.id)) throw error(404, 'no such routine');
	return new Response(null, { status: 204 });
};
