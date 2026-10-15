import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteNote, getNote } from '$lib/server/db';

/** Take a shared note down. */
export const DELETE: RequestHandler = ({ params }) => {
	if (!getNote(params.id)) throw error(404, 'no such note');
	deleteNote(params.id);
	return new Response(null, { status: 204 });
};
