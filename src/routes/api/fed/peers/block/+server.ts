import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setPeerBlocked } from '$lib/server/federation';
import { boolField, readJson, strField } from '$lib/server/http';

/**
 * The human's verdict on a peer. Block keeps the fingerprint on file and turns
 * every inbound POST from it away with a 403; lifting the block returns the
 * link to plain paired without re-running the handshake.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const id = strField(body, 'id', 64);
	const blocked = boolField(body, 'blocked');
	if (!id || blocked === undefined) throw error(400, 'id and blocked required');
	return json({ peer: setPeerBlocked(id, blocked) });
};
