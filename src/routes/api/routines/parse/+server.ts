import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { complete, defaultModel } from '$lib/server/llm';
import { nextCronRun } from '$lib/server/wake';
import { readJson, strField } from '$lib/server/http';

interface Draft {
	name: string;
	prompt: string;
	cron: string;
	interval_min: number;
}

/**
 * Turn one plain-English sentence into a routine the scheduler can run: the
 * model fills in the task, a name, and a schedule, which the user reviews
 * before saving.
 */
export const POST: RequestHandler = async ({ request }) => {
	const text = (strField(await readJson(request), 'text', 2000) ?? '').trim();
	if (!text) throw error(400, 'text required');
	if (!defaultModel()) throw error(400, 'no model configured');

	const now = new Date();
	const raw = await complete(defaultModel(), [
		{
			role: 'system',
			content:
				'You turn a request into a recurring bot routine. Reply with JSON only, no prose:\n' +
				'{"name": short label (max 6 words),\n' +
				' "prompt": the instruction the bot should carry out each run, written to the bot,\n' +
				' "cron": a 5-field cron expression (minute hour day-of-month month day-of-week),\n' +
				' "interval_min": minutes between runs when no useful cron applies}\n' +
				'Always give a cron when the user names a time of day, weekday, or "every N minutes/hours" ' +
				'that fits cron; otherwise leave cron as "" and set interval_min.'
		},
		{
			role: 'user',
			content: `Current local time: ${now.toString()}\nRequest: ${text}`
		}
	]);

	let parsed: Partial<Draft>;
	try {
		parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
	} catch {
		throw error(502, 'the model did not return a usable routine');
	}

	const cron = String(parsed.cron ?? '').trim();
	const valid = cron ? nextCronRun(cron, Date.now()) !== null : false;
	const interval = Number(parsed.interval_min);
	const draft: Draft = {
		name: String(parsed.name ?? text.slice(0, 40)).slice(0, 80),
		prompt: String(parsed.prompt ?? text).slice(0, 4000),
		cron: valid ? cron : '',
		interval_min: Number.isFinite(interval) && interval >= 1 ? Math.min(10080, interval) : 1440
	};

	return json({
		draft,
		next_run_at: draft.cron
			? nextCronRun(draft.cron, Date.now())
			: Date.now() + draft.interval_min * 60_000
	});
};
