import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteMessage, getMessage, setMessageExcluded } from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';

/**
 * Toggle whether the model sees a message. The message stays in the transcript
 * either way - this only drops it from the context sent to the provider.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const message = getMessage(params.id);
	if (!message) throw error(404, 'message not found');
	const excluded = boolField(await readJson(request), 'excluded');
	if (excluded === undefined) throw error(400, 'excluded is required');
	setMessageExcluded(params.id, excluded);
	return json({ ok: true, excluded });
};

/** Delete a message outright. Its reactions go with it. */
export const DELETE: RequestHandler = ({ params }) => {
	if (!getMessage(params.id)) throw error(404, 'message not found');
	deleteMessage(params.id);
	return new Response(null, { status: 204 });
};
