import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readShot } from '$lib/server/machine';

/** Screen grabs taken by bots, referenced from activity rows. */
export const GET: RequestHandler = async ({ params }) => {
	const png = await readShot(params.name);
	if (!png) throw error(404, 'no such screenshot');
	return new Response(new Uint8Array(png), {
		headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' }
	});
};
