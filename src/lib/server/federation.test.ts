import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addMessage,
	botPairConversation,
	createBot,
	getBot,
	listMessages,
	listPeers,
	peerForConversation
} from './db';
// Route handlers are exercised directly: SvelteKit reserves '+' filenames, so
// the tests live here rather than beside the routes.
import { POST as fedInbox } from '../../routes/fed/[botId]/+server';
import { config } from './config';
import {
	connectPeer,
	createInvite,
	ensureFedKey,
	fedSign,
	fedTsOk,
	fedVerify,
	parseInvite,
	receiveMessage,
	removePeer,
	sendToPeer,
	setPeerBlocked
} from './federation';

vi.mock('./runner', () => ({
	runBotTurn: vi.fn(async () => ({ text: 'ok', message: null, aborted: false, stoppedBy: '' }))
}));

import { runBotTurn } from './runner';

/** A stand-in identity for a far lounge: its own pair, derived fingerprint. */
function makeKey(): { pub: string; pem: string; fp: string } {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const fp = createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 32);
	return { pub, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), fp };
}

let aliceId = '';
let alice: { pub: string; pem: string; fp: string };
let rook: { pub: string; pem: string; fp: string };
let sneak: { pub: string; pem: string; fp: string };

/**
 * The far lounge: a real HTTP server that plays the peer the way one would for
 * real - verify the signature against the key the invite carried, keep what
 * arrived, answer ok.
 */
let aliceFedPub = '';
let server: Server;
let rookEndpoint = '';
const received: { kind: string; body: Record<string, unknown>; valid: boolean }[] = [];

beforeAll(async () => {
	config.fedAllowPrivate = true;
	aliceId = createBot({ name: 'Alice', persona: '', avatar: '🎭', color: '#fff', model: 'm', badge: '' }).id;
	alice = makeKey();
	rook = makeKey();
	sneak = makeKey();
	// The key the far lounge would hold for Alice, learned during the handshake.
	aliceFedPub = ensureFedKey(aliceId).public_key;
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			const kind = String(req.headers['x-fed-kind']);
			const ts = Number(req.headers['x-fed-ts']);
			const sig = String(req.headers['x-fed-sig']);
			const body = JSON.parse(raw) as Record<string, unknown>;
			// The peer knows Alice's key from the pairing; that is what it verifies with.
			received.push({ kind, body, valid: fedVerify(aliceFedPub, ts, kind, raw, sig) });
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	rookEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fed/rook`;
});

/**
 * Canonical slate before every test: exactly one unblocked link to Rook and
 * one seeded fed message, no captured wire traffic. connectPeer dedupes on
 * the fingerprint and re-pairs a removed or blocked Rook, so any test passes
 * in any order (npm run test:shuffle shuffles within the file too).
 */
beforeEach(async () => {
	for (const p of listPeers(aliceId)) removePeer(p.id);
	await connectPeer(aliceId, {
		name: 'Rook',
		endpoint: rookEndpoint,
		pubkey: rook.pub,
		fingerprint: rook.fp,
		// The mock far lounge answers connect unconditionally; the nonce only
		// matters for real strangers.
		nonce: '0'.repeat(32)
	}, rookEndpoint);
	receiveMessage(aliceId, { fp: rook.fp, text: 'seed from the far lounge' });
	received.length = 0;
	vi.mocked(runBotTurn).mockClear();
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

afterEach(() => {
	received.length = 0;
	vi.mocked(runBotTurn).mockClear();
});

function signedRequest(
	botId: string,
	kind: string,
	body: Record<string, unknown>,
	pem: string,
	ts = Date.now()
): Promise<Response> {
	const raw = JSON.stringify(body);
	return fedInbox({
		params: { botId },
		request: new Request(`http://test/fed/${botId}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-fed-ts': String(ts),
				'x-fed-kind': kind,
				'x-fed-sig': fedSign(pem, ts, kind, raw)
			},
			body: raw
		})
	} as Parameters<typeof fedInbox>[0]) as Promise<Response>;
}
/** The status a route call answered, whether it returned or threw. */
async function status(p: unknown): Promise<number> {
	try {
		return ((await p) as Response).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

describe('signing', () => {
	it('verifies a good signature over the exact bytes', () => {
		const raw = JSON.stringify({ text: 'hello' });
		const ts = Date.now();
		expect(fedVerify(alice.pub, ts, 'message', raw, fedSign(alice.pem, ts, 'message', raw))).toBe(true);
	});

	it('rejects a tampered body, a wrong key and a different kind', () => {
		const ts = Date.now();
		const sig = fedSign(alice.pem, ts, 'message', JSON.stringify({ text: 'hello' }));
		expect(fedVerify(alice.pub, ts, 'message', JSON.stringify({ text: 'helló' }), sig)).toBe(false);
		expect(fedVerify(rook.pub, ts, 'message', JSON.stringify({ text: 'hello' }), sig)).toBe(false);
		expect(fedVerify(alice.pub, ts, 'connect', JSON.stringify({ text: 'hello' }), sig)).toBe(false);
	});

	it('refuses timestamps outside the skew window', () => {
		expect(fedTsOk(Date.now() - 4 * 60_000)).toBe(true);
		expect(fedTsOk(Date.now() + 6 * 60_000)).toBe(false);
		expect(fedTsOk(Date.now() - 6 * 60_000)).toBe(false);
		expect(fedTsOk('now')).toBe(false);
	});
});

describe('invites', () => {
	it('round-trips through parse with the fingerprint intact', () => {
		const { blob, fingerprint } = createInvite(aliceId, 'http://localhost:3000/fed/x');
		const invite = parseInvite(blob);
		expect(invite).not.toBeNull();
		expect(invite?.name).toBe('Alice');
		expect(invite?.endpoint).toBe('http://localhost:3000/fed/x');
		expect(invite?.fingerprint).toBe(fingerprint);
		expect(invite?.nonce).toMatch(/^[0-9a-f]{32}$/);
	});

	it('reads junk, a broken blob or a mismatched fingerprint as nothing', () => {
		expect(parseInvite('not an invite')).toBeNull();
		expect(parseInvite('OBL-FED1.zzz')).toBeNull();
		const { blob } = createInvite(aliceId, 'http://localhost:3000/fed/x');
		const invite = parseInvite(blob)!;
		const forged = Buffer.from(JSON.stringify({ ...invite, fingerprint: '0'.repeat(32) })).toString('base64url');
		expect(parseInvite('OBL-FED1.' + forged)).toBeNull();
	});
});

describe('handshake', () => {
	it('registers both sides when the far lounge pastes our invite and connects back', async () => {
		const { blob } = createInvite(aliceId, rookEndpoint);
		const invite = parseInvite(blob)!;
		const res = (await signedRequest(aliceId, 'connect', {
			nonce: invite.nonce,
			name: 'Rook',
			endpoint: rookEndpoint,
			pubkey: rook.pub,
			fp: rook.fp
		}, rook.pem)) as Response;
		expect(res.status).toBe(200);
		// Both ends now agree on who Rook is: the fingerprint shows in our row.
		expect(listPeers(aliceId)[0]?.fingerprint).toBe(rook.fp);
	});

	it('turns a stranger without a usable nonce away', async () => {
		expect(
			await status(signedRequest(aliceId, 'connect', {
				nonce: '0'.repeat(32),
				name: 'Sneak',
				endpoint: 'http://127.0.0.1:9/fed/sneak',
				pubkey: sneak.pub,
				fp: sneak.fp
			}, sneak.pem))
		).toBe(404);
		expect(listPeers(aliceId)).toHaveLength(1);
	});

	it('delivers a signed message into the pair room as the external bot', async () => {
		const res = (await signedRequest(aliceId, 'message', { fp: rook.fp, text: 'hello from the far lounge' }, rook.pem)) as Response;
		expect(res.status).toBe(200);
		// The local bot is woken to read it, webhook-style, in the background.
		expect(runBotTurn).toHaveBeenCalledTimes(1);
		const peer = listPeers(aliceId)[0];
		const conv = botPairConversation(aliceId, peer.peer_bot_id);
		// The strip up top finds the peer through the conversation.
		expect(peerForConversation(conv.id)?.id).toBe(peer.id);
		const fed = listMessages(conv.id).find((m) => m.kind === 'fed' && m.content === 'hello from the far lounge');
		expect(fed?.bot_id).toBe(peer.peer_bot_id);
		// The stand-in is a face in the thread, never one of the human's bots.
		expect(getBot(peer.peer_bot_id)?.hidden).toBe(1);
	});

	it('rejects an unknown fingerprint and a blocked one', async () => {
		expect(
			await status(signedRequest(aliceId, 'message', { fp: sneak.fp, text: 'hi' }, sneak.pem))
		).toBe(404);
		const before = listMessages(botPairConversation(aliceId, listPeers(aliceId)[0].peer_bot_id).id).length;
		setPeerBlocked(listPeers(aliceId)[0].id, true);
		expect(
			await status(signedRequest(aliceId, 'message', { fp: rook.fp, text: 'still there?' }, rook.pem))
		).toBe(403);
		const conv = botPairConversation(aliceId, listPeers(aliceId)[0].peer_bot_id);
		expect(listMessages(conv.id).length).toBe(before);
	});

	it('refuses stale and tampered POSTs before anything lands', async () => {
		const stale = Date.now() - 6 * 60_000;
		expect(
			await status(signedRequest(aliceId, 'message', { fp: rook.fp, text: 'late' }, rook.pem, stale))
		).toBe(401);
		// A signature over different bytes must not pass.
		const raw = JSON.stringify({ fp: rook.fp, text: 'honest' });
		const forged = new Request('http://test/fed/x', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-fed-ts': String(Date.now()),
				'x-fed-kind': 'message',
				'x-fed-sig': fedSign(rook.pem, Date.now(), 'message', raw)
			},
			body: JSON.stringify({ fp: rook.fp, text: 'tampered' })
		});
		expect(await status(fedInbox({ params: { botId: aliceId }, request: forged } as Parameters<typeof fedInbox>[0]))).toBe(401);
	});
});

describe('outbound', () => {
	it('sends signed, reaches the far lounge and keeps our copy', async () => {
		setPeerBlocked(listPeers(aliceId)[0].id, false);
		const note = await sendToPeer(aliceId, 'rook', 'over the wire');
		expect(note).toBe('sent to Rook');
		const hit = received.find((r) => r.kind === 'message');
		expect(hit?.valid).toBe(true);
		expect(hit?.body.text).toBe('over the wire');
		const peer = listPeers(aliceId)[0];
		const conv = botPairConversation(aliceId, peer.peer_bot_id);
		const ours = listMessages(conv.id).find((m) => m.bot_id === aliceId && m.content === 'over the wire');
		expect(ours).toBeDefined();
	});

	it('refuses unknown names and blocked peers without a POST', async () => {
		expect(await sendToPeer(aliceId, 'nobody', 'x')).toContain('error');
		setPeerBlocked(listPeers(aliceId)[0].id, true);
		expect(await sendToPeer(aliceId, 'rook', 'x')).toContain('blocked');
		expect(received).toHaveLength(0);
		setPeerBlocked(listPeers(aliceId)[0].id, false);
	});
});

describe('module-level delivery', () => {
	it('receiveMessage answers the same verdicts the route does', () => {
		const ok = receiveMessage(aliceId, { fp: rook.fp, text: 'direct' });
		expect(ok.ok).toBe(true);
		expect(receiveMessage(aliceId, { fp: sneak.fp, text: 'who?' }).status).toBe(404);
		expect(receiveMessage(aliceId, { fp: rook.fp, text: '' }).status).toBe(400);
	});
});

describe('remove vs block', () => {
	it('removing drops the link but keeps the history, and closes the door', async () => {
		const peer = listPeers(aliceId)[0];
		const conv = botPairConversation(aliceId, peer.peer_bot_id);
		const before = listMessages(conv.id).length;
		expect(before).toBeGreaterThan(0);
		expect(removePeer(peer.id)).toBe(true);
		// Inbound from the removed fingerprint is a stranger again...
		expect(
			await status(signedRequest(aliceId, 'message', { fp: rook.fp, text: 'anyone there?' }, rook.pem))
		).toBe(404);
		// ...but the transcript is untouched.
		expect(listMessages(conv.id).length).toBe(before);
		expect(listPeers(aliceId)).toHaveLength(0);
	});
});

describe('connect back over the wire', () => {
	it('pairs from a pasted invite with a real POST the far side verifies', async () => {
		// Rook was removed above, so this exercises the full path from scratch.
		// The invite is the one Rook's human would have been handed: Rook's key,
		// Rook's endpoint, a nonce only Rook's side checks.
		const invite = {
			name: 'Rook',
			endpoint: rookEndpoint,
			pubkey: rook.pub,
			fingerprint: rook.fp,
			nonce: randomBytes(16).toString('hex')
		};
		const result = await connectPeer(aliceId, invite, rookEndpoint);
		expect(result.confirmed).toBe(true);
		expect(result.error).toBe('');
		const hit = received.find((r) => r.kind === 'connect');
		expect(hit?.valid).toBe(true);
		expect(hit?.body.nonce).toBe(invite.nonce);
		// The far side verified with the key the pairing taught it.
		expect(hit?.body.pubkey).toBe(aliceFedPub);
		expect(listPeers(aliceId)[0]?.fingerprint).toBe(rook.fp);
	});
});

describe('outbound SSRF guard', () => {
	it('refuses to POST to a private endpoint unless FED_ALLOW_PRIVATE is set', async () => {
		const previous = config.fedAllowPrivate;
		config.fedAllowPrivate = false;
		try {
			const invite = parseInvite(
				createInvite(aliceId, 'http://127.0.0.1:65530/fed/x').blob
			)!;
			const result = await connectPeer(aliceId, invite, 'http://127.0.0.1:1/fed/us');
			expect(result.confirmed).toBe(false);
			expect(result.error).toMatch(/private|link-local/);
		} finally {
			config.fedAllowPrivate = previous;
		}
	});
});
