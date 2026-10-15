import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	createRoutine,
	getBot,
	getConversation,
	listRoutines,
	setRoutineEnabled,
	setRoutineVerification
} from '$lib/server/db';
import { nextCronRun } from '$lib/server/wake';
import { applyAttempt, policeModel, reviewRoutine, verdictJson, policeSettings } from '$lib/server/police';
import { numField, readJson, strField } from '$lib/server/http';

export const GET: RequestHandler = ({ url }) => {
	return json({ routines: listRoutines(url.searchParams.get('bot_id') ?? undefined) });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 80) ?? '';
	const convId = strField(body, 'conversation_id', 80) ?? '';
	const prompt = (strField(body, 'prompt', 4000) ?? '').trim();
	const cron = (strField(body, 'cron', 120) ?? '').trim();
	// Cron wins when present; the interval is only a fallback. Kept unclamped
	// here so "neither given" is still detectable below. A fraction of a minute
	// or a zero can schedule nothing anyone asked for, so both are refused.
	const given = numField(body, 'interval_min');
	if (given !== undefined && (!Number.isInteger(given) || given < 1)) {
		throw error(400, 'interval_min must be a whole number of minutes, at least 1');
	}
	const intervalMin = Math.min(10080, given ?? 0);
	if (!getBot(botId)) throw error(404, 'bot not found');
	if (!getConversation(convId)) throw error(404, 'conversation not found');
	if (!prompt) throw error(400, 'prompt required');
	if (!cron && !intervalMin) throw error(400, 'interval_min or cron required');

	let next_run_at = Date.now() + intervalMin * 60_000;
	if (cron) {
		const next = nextCronRun(cron, Date.now());
		if (next === null) throw error(400, 'cron must be a 5-field expression, e.g. "0 9 * * 1-5"');
		next_run_at = next;
	}

	const routine = createRoutine({
		bot_id: botId,
		conversation_id: convId,
		name: strField(body, 'name', 80) ?? prompt.slice(0, 40),
		prompt,
		interval_min: intervalMin || 1440,
		cron,
		next_run_at,
		enabled: 1,
		created_by: 'human'
	});
	// A routine is a prompt the bot will run on a clock, and it cannot be run on
	// demand - so the police judge the instruction and the schedule, not an
	// outcome. A refusal is not a success: the routine is kept so it can be
	// fixed, but it is switched off until the police sign it off. With the gate
	// off the routine is simply created, unsigned and unrefused.
	if (policeSettings().checkRoutines) {
		const siblings = listRoutines(botId).filter((r) => r.id !== routine.id);
		const review = applyAttempt(
			await reviewRoutine({
				botName: getBot(botId)?.name ?? '',
				name: routine.name,
				prompt: routine.prompt,
				schedule: routine.cron ? `cron "${routine.cron}"` : `every ${routine.interval_min}m`,
				existing: siblings.map((r) => {
					const when = r.cron ? `cron "${r.cron}"` : `every ${r.interval_min}m`;
					return `routine "${r.name}" (${when}) - ${r.prompt.slice(0, 120)}`;
				}),
				model: policeModel()
			}),
			// Re-creating a refused routine spends another attempt: the newest
			// other routine with the same name carries the count.
			siblings.find((r) => r.name === routine.name)?.verification ?? ''
		);
		setRoutineVerification(routine.id, verdictJson(review));
		if (review.verdict === 'rejected') setRoutineEnabled(routine.id, false, review.reason);
		return json({ ...routine, verification: verdictJson(review) }, { status: 201 });
	}
	return json({ ...routine }, { status: 201 });
};
