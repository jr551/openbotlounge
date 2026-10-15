import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJson, numField } from '$lib/server/http';
import { defaultModel } from '$lib/server/llm';
import {
	capabilityRunning,
	lastCapabilityReport,
	runCapabilityTest
} from '$lib/server/capability';

/** The last report, and whether a run is in flight. */
export const GET: RequestHandler = () =>
	json({ running: capabilityRunning(), report: lastCapabilityReport() });

/**
 * Start a run. The battery repeats until the token budget is spent, so the
 * response is the run's promise - the page polls GET for the finished report.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const budget = Math.min(10_000_000, Math.max(1_000, numField(body, 'budget') ?? 1_000_000));
	const model = defaultModel();
	if (!model) throw error(400, 'no model configured');
	if (capabilityRunning()) throw error(409, 'a run is already in flight');
	// Fire and forget: the run can take minutes, and the page polls for it.
	void runCapabilityTest(model, budget).catch(() => {});
	return json({ ok: true, model, budget }, { status: 202 });
};
