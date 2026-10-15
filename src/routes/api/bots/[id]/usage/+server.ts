import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, listTasks, taskModels } from '$lib/server/db';
import {
	costBreakdown,
	costOf,
	estimatePricing,
	modelPricing,
	type ModelPricing
} from '$lib/server/pricing';

/**
 * One bot's token spend, oldest task first, for the panel's usage chart.
 * listTasks orders for the tray (running first, then newest), so the rows are
 * re-sorted here into the order the chart draws.
 *
 * Cache figures ride beside the token counts. `cache_reported` is the flag
 * that lets the chart tell "the provider said nothing was cached" from "the
 * provider does not report cache at all": it is 1 once any of the task's
 * calls sent cache fields, so a 0 read under it is a real miss. The totals'
 * hit rate is cache_read over the prompt tokens of reporting tasks only -
 * tasks whose provider never said anything cannot dilute it.
 *
 * `by_model` is the same spend grouped by the model that served each task:
 * the per-bot pricing breakdown the totals alone cannot show.
 */
export const GET: RequestHandler = async ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'not found');
	// A task the provider priced carries its own bill; one it did not is
	// estimated against the best known rate for the model that served it -
	// the human's override, the provider's listing, then the researched
	// figure - and marked as such so the two never read alike. The model is
	// read off the task's reply where it has one; a task with no reply yet
	// falls back to the bot's own model fields.
	const listed = await modelPricing();
	const models = taskModels(params.id);
	const modelOf = (id: string) => models[id] ?? (bot.served_model || bot.model);
	const all = listTasks({ botId: params.id });
	// The rate each model's unpriced tasks are estimated at, resolved once per
	// model rather than once per task.
	const rates: Record<string, ModelPricing | null> = {};
	for (const t of all) {
		const m = modelOf(t.id);
		if (!(m in rates)) rates[m] = estimatePricing(m, listed);
	}
	const tasks = all
		.slice()
		.sort((a, b) => a.created_at - b.created_at)
		.map((t) => {
			const model = modelOf(t.id);
			return {
				id: t.id,
				created_at: t.created_at,
				// The model that served the task, so the readout can name it.
				model,
				tokens_in: t.tokens_in,
				tokens_out: t.tokens_out,
				cache_read: t.cache_read,
				cache_write: t.cache_write,
				cache_reported: t.cache_reported === 1,
				// What the provider said the task cost; null when it named no price.
				cost: t.cost,
				// The estimate for an unpriced task; null when there is no figure
				// to estimate against either.
				estimated_cost:
					t.cost === null && rates[model]
						? costOf(rates[model], {
								input: t.tokens_in,
								output: t.tokens_out,
								cacheRead: t.cache_read
							})
						: null
			};
		});
	const reported = tasks.filter((t) => t.cache_reported);
	const spend = await costBreakdown(all, (t) => modelOf(t.id));
	return json({
		tasks,
		by_model: spend.byModel,
		totals: {
			in: tasks.reduce((n, t) => n + t.tokens_in, 0),
			out: tasks.reduce((n, t) => n + t.tokens_out, 0),
			cache_read: tasks.reduce((n, t) => n + t.cache_read, 0),
			cache_write: tasks.reduce((n, t) => n + t.cache_write, 0),
			// The provider's own bill across the tasks that named a price; null
			// when none did, so the panel can say "not priced" rather than $0.
			cost: tasks.some((t) => t.cost !== null)
				? tasks.reduce((n, t) => n + (t.cost ?? 0), 0)
				: null,
			// The estimate across unpriced tasks; null when there is nothing to
			// estimate, so "not priced" never reads as $0.
			estimated_cost: tasks.some((t) => t.estimated_cost !== null)
				? tasks.reduce((n, t) => n + (t.estimated_cost ?? 0), 0)
				: null,
			// null when no task reported cache fields: the chart can show
			// "not measured" rather than a misleading 0%.
			cache_hit_rate: reported.length
				? reported.reduce((n, t) => n + t.cache_read, 0) /
					reported.reduce((n, t) => n + t.tokens_in, 0)
				: null
		}
	});
};
