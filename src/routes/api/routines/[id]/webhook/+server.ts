import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteWebhook, getRoutine } from '$lib/server/db';
import { createWebhook, routineWebhook, webhookUrl } from '$lib/server/webhooks';

const shape = (hook: { id: string; token: string; name: string; enabled: number }) => ({
	id: hook.id,
	name: hook.name,
	url: webhookUrl(hook.token)
});

/**
 * A routine's inbound webhook: POSTing any body to the URL runs the routine
 * now, the same firing the clock would produce. One hook per routine.
 */
export const GET: RequestHandler = ({ params }) => {
	const routine = getRoutine(params.id);
	if (!routine) throw error(404, 'no such routine');
	const hook = routineWebhook(params.id);
	return json({ webhook: hook ? shape(hook) : null });
};

export const POST: RequestHandler = ({ params }) => {
	const routine = getRoutine(params.id);
	if (!routine) throw error(404, 'no such routine');
	const existing = routineWebhook(params.id);
	if (existing) return json(shape(existing));
	const hook = createWebhook(
		routine.bot_id,
		routine.conversation_id,
		`Routine "${routine.name}"`,
		'',
		routine.id
	);
	return json(shape(hook), { status: 201 });
};

export const DELETE: RequestHandler = ({ params }) => {
	const routine = getRoutine(params.id);
	if (!routine) throw error(404, 'no such routine');
	const hook = routineWebhook(params.id);
	if (!hook || !deleteWebhook(hook.id)) throw error(404, 'routine has no webhook');
	return new Response(null, { status: 204 });
};
