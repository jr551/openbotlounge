import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { fedTsOk, fedVerify, peerPubkeyFor, receiveConnect, receiveMessage } from '$lib/server/federation';

/**
 * A lounge's public inbox: the one URL an external lounge POSTs signed
 * payloads to. Like the webhook route, the credential travels with the
 * request - an Ed25519 signature over the raw body - so no session and no
 * Origin check applies here; the hooks handler lets /fed/ through for the
 * same reason.
 */

/** A peer message is one chat bubble, so it is bounded like one. */
const MAX_BODY = 256 * 1024;

export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.botId);
	if (!bot || bot.hidden) throw error(404, 'no such endpoint');

	const raw = await request.text();
	if (raw.length > MAX_BODY) throw error(413, 'payload too large');

	const ts = Number(request.headers.get('x-fed-ts'));
	if (!fedTsOk(ts)) throw error(401, 'stale or missing timestamp');
	const kind = request.headers.get('x-fed-kind') ?? '';
	const sig = request.headers.get('x-fed-sig') ?? '';
	if ((kind !== 'connect' && kind !== 'message') || !sig) throw error(400, 'bad fed headers');

	let body: Record<string, unknown>;
	try {
		body = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw error(400, 'body must be a JSON object');
	}
	if (!body || typeof body !== 'object') throw error(400, 'body must be a JSON object');

	// A connect carries the key it signs with - the invite nonce is what makes
	// trusting it safe. A message must already have a peer here, and signs with
	// the key on file, never one it brought along.
	let pubkey = '';
	if (kind === 'connect') {
		pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
	} else {
		pubkey = peerPubkeyFor(bot.id, body);
		if (!pubkey) throw error(404, 'no such peer');
	}
	if (!fedVerify(pubkey, ts, kind, raw, sig)) throw error(401, 'bad signature');

	const result = kind === 'connect' ? receiveConnect(bot.id, body) : receiveMessage(bot.id, body);
	if (!result.ok) throw error(result.status, result.reason);
	return json({ ok: true });
};
