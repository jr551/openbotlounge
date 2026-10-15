import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fireWebhook } from '$lib/server/webhooks';

/** A webhook payload is forwarded into a conversation, so it is bounded like one. */
const MAX_BODY = 256 * 1024;

export const POST: RequestHandler = async ({ params, request }) => {
	// Accept any content-type: JSON bodies are normalized, everything else
	// (text, form data, empty) is delivered as raw text.
	const raw = await request.text();
	if (raw.length > MAX_BODY) throw error(413, 'payload too large');
	let payload: string;
	try {
		const body: unknown = JSON.parse(raw);
		payload = typeof body === 'string' ? body : JSON.stringify(body);
	} catch {
		payload = raw;
	}
	const fired = await fireWebhook(params.token, payload);
	if (!fired) return json({ ok: false }, { status: 404 });
	return json({ ok: true });
};
