import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { answerPolicePrompt, getPolicePrompt, logActivity } from '$lib/server/db';
import { ensurePoliceBot } from '$lib/server/police';
import { readJson, strField } from '$lib/server/http';

/**
 * Answer a police prompt. The choice must be one of the values offered;
 * otherwise the prompt's question would be answered with something the
 * officer never asked. A resolved prompt is idempotent: posting again
 * answers with the same record rather than a conflict.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	const choice = strField(body, 'choice', 80);
	if (!choice) throw error(400, 'choice required');
	const id = params.id;
	const before = getPolicePrompt(id);
	if (!before) throw error(404, 'prompt not found');
	if (before.resolved_at) return json({ prompt: before });
	const updated = answerPolicePrompt(id, choice);
	if (!updated) throw error(400, 'unknown choice');
	const officer = ensurePoliceBot();
	logActivity(officer.id, 'police', `Prompt answered: "${before.question}" -> ${updated.chosen_value}`);
	return json({ prompt: updated });
};
