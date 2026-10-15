import { describe, expect, it } from 'vitest';
import {
	addBotTokens,
	addMessage,
	addTaskTokens,
	createBot,
	createConversation,
	createTask,
	finishTask,
	setSetting
} from './db';
import { GET as statsGet } from '../../routes/api/bots/[id]/stats/+server';
import { GET as usageGet } from '../../routes/api/bots/[id]/usage/+server';
// The per-bot pricing readout: a priced task and an unpriced one served by
// different models, read back through the stats and usage routes. The
// handlers only read params.id, so a stub event is cast to the real type.
type StatsBody = {
	cost: {
		lifetime: number | null;
		total: number | null;
		estimated: number | null;
		by_model: { model: string; cost: number | null; estimated_cost: number | null }[];
	};
};
type UsageBody = {
	tasks: { id: string; model: string; cost: number | null; estimated_cost: number | null }[];
	by_model: { model: string }[];
};

describe('GET /api/bots/[id] spend readouts', () => {
	it('breaks spend down per model and prices unpriced tasks by estimate', async () => {
		const bot = createBot({
			name: 'SmokeBot',
			persona: '',
			avatar: '',
			color: '',
			model: 'cfg/model',
			badge: ''
		});
		const conv = createConversation([bot.id], 'direct');

		// A priced task served by model A.
		const m1 = addMessage(conv.id, 'assistant', 'a', bot.id, 'served/a');
		const t1 = createTask(conv.id, bot.id, 'turn one');
		addTaskTokens(t1.id, 1000, 100, { read: 0, write: 0, reported: false }, 0.05);
		finishTask(t1.id, 'done', { messageId: m1.id });
		// The runner meters the bot row beside the task row on every call.
		addBotTokens(bot.id, 1000, 100, 0.05);
		// An unpriced task served by model B, with a human override price.
		const m2 = addMessage(conv.id, 'assistant', 'b', bot.id, 'served/b');
		const t2 = createTask(conv.id, bot.id, 'turn two');
		addTaskTokens(t2.id, 2000, 200);
		finishTask(t2.id, 'done', { messageId: m2.id });
		setSetting(
			'price_overrides',
			JSON.stringify({ 'served/b': { prompt: 0.000001, completion: 0.000002 } })
		);

		const statsEvent = { params: { id: bot.id } } as unknown as Parameters<typeof statsGet>[0];
		const stats = (await (await statsGet(statsEvent)).json()) as StatsBody;
		expect(stats.cost.lifetime).toBeCloseTo(0.05, 10);
		expect(stats.cost.total).toBeCloseTo(0.05, 10);
		// 2000 * 1e-6 + 200 * 2e-6 = 0.0024
		expect(stats.cost.estimated).toBeCloseTo(0.0024, 10);
		const byModel = Object.fromEntries(stats.cost.by_model.map((m) => [m.model, m]));
		expect(byModel['served/a'].cost).toBeCloseTo(0.05, 10);
		expect(byModel['served/b'].estimated_cost).toBeCloseTo(0.0024, 10);

		const usageEvent = { params: { id: bot.id } } as unknown as Parameters<typeof usageGet>[0];
		const usage = (await (await usageGet(usageEvent)).json()) as UsageBody;
		const rows = Object.fromEntries(usage.tasks.map((t) => [t.id, t]));
		expect(rows[t1.id].model).toBe('served/a');
		expect(rows[t1.id].cost).toBeCloseTo(0.05, 10);
		expect(rows[t2.id].model).toBe('served/b');
		expect(rows[t2.id].estimated_cost).toBeCloseTo(0.0024, 10);
		expect(usage.by_model).toHaveLength(2);
	});
});
