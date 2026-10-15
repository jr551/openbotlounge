import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteWait, deleteWake } from '$lib/server/wake';

export const DELETE: RequestHandler = ({ params }) => {
	// An id may name either a one-off wake or a wait condition; report a miss the
	// same way every other delete route does.
	const removed = deleteWake(params.id) || deleteWait(params.id);
	if (!removed) throw error(404, 'no such wake or wait');
	return new Response(null, { status: 204 });
};
