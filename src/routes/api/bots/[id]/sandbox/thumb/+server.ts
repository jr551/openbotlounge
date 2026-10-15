import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { readSnapshot } from '$lib/server/machine';

/** The bot's last-seen screen as a PNG, captured before its sandbox slept. */
export const GET: RequestHandler = async ({ params }) => {
	if (!getBot(params.id)) throw error(404, 'not found');
	const png = await readSnapshot(params.id);
	if (!png) throw error(404, 'no snapshot yet');
	return new Response(new Uint8Array(png), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'no-store'
		}
	});
};
