import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, listTasks, policeAlertsFor, policeRecord, taskModels } from '$lib/server/db';
import { costBreakdown } from '$lib/server/pricing';

/**
 * The bot-detail panel's numbers: per-task token spend over time, the spend
 * priced per model, and the police's history with this bot - write-ups and
 * patrol findings merged into one feed, oldest first, capped at 50 so the
 * panel never has to paginate.
 */
export const GET: RequestHandler = async ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');

	// since: 0 asks for every task, running ones included - the chart is the
	// whole history, not the tray's last-day window.
	const all = listTasks({ botId: bot.id, since: 0 });
	const usage = all
		.map((t) => ({ t: t.created_at, input: t.tokens_in, output: t.tokens_out }))
		.sort((a, b) => a.t - b.t);

	// The spend priced per model: the provider's own bill where it named one,
	// the best known rate's estimate where it did not. `lifetime` is the
	// bot-row meter, which also counts calls no task owns (memory writes,
	// compactions), so it can exceed the task-attributed total.
	const models = taskModels(bot.id);
	const spend = await costBreakdown(all, (t) => models[t.id] ?? (bot.served_model || bot.model));

	const police: { t: number; kind: string; detail: string }[] = policeAlertsFor(bot.id).map(
		(a) => ({ t: a.created_at, kind: a.kind, detail: a.summary })
	);
	const record = policeRecord(bot.id);
	if (record && record.last_offence_at) {
		police.push({
			t: record.last_offence_at,
			kind: 'record',
			detail: record.note || `written up ${record.offence_count} time(s)`
		});
	}
	police.sort((a, b) => a.t - b.t);

	return json({
		usage,
		cost: {
			lifetime: bot.cost,
			total: spend.total,
			estimated: spend.estimated,
			by_model: spend.byModel
		},
		police: police.slice(-50)
	});
};
