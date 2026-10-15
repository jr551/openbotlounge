import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pendingChangeRequests } from '$lib/server/db';

/** The asks still waiting on the human, as the police chat's cards read them. */
export const GET: RequestHandler = () => {
	return json({ asks: pendingChangeRequests() });
};
