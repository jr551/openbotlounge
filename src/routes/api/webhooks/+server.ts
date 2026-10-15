import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteWebhook, listWebhooks, webhookUrl } from '$lib/server/webhooks';

export const GET: RequestHandler = ({ url }) => {
	const botId = url.searchParams.get('bot_id') ?? undefined;
	const webhooks = listWebhooks(botId).map((w) => ({ ...w, url: webhookUrl(w.token) }));
	return json({ webhooks });
};

export const DELETE: RequestHandler = ({ url }) => {
	const id = url.searchParams.get('id');
	if (!id) throw error(400, 'id required');
	if (!deleteWebhook(id)) throw error(404, 'no such webhook');
	return new Response(null, { status: 204 });
};
