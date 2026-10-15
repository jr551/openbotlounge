import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { captureSnapshot } from '$lib/server/machine';

/** Capture the sandbox screen now, refreshing the panel's last-seen image. */
export const POST: RequestHandler = async ({ params }) => {
	if (!getBot(params.id)) throw error(404, 'not found');
	const ok = await captureSnapshot(params.id);
	if (!ok) throw error(502, 'could not capture the sandbox screen');
	return json({ ok: true });
};
