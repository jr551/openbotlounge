import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { deleteSecret } from '$lib/server/secrets';

/** Forget a secret. The stored ciphertext is dropped with it. */
export const DELETE: RequestHandler = ({ params }) => {
	if (!getBot(params.id)) throw error(404, 'bot not found');
	if (!deleteSecret(params.id, params.name)) throw error(404, 'no such secret');
	return new Response(null, { status: 204 });
};
