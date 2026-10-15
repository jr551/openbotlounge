import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
	sign as cryptoSign,
	verify as cryptoVerify
} from 'node:crypto';
import {
	addMessage,
	botPairConversation,
	createBot,
	createPeer,
	db,
	deletePeer,
	getBot,
	getPeer,
	listPeers,
	logActivity,
	peerForConversation,
	setBotHidden,
	updatePeer,
	type Peer
} from './db';
import { decrypt, encrypt } from './secrets';
import { startTask } from './tasks';

/**
 * Bot-to-bot messaging across lounges. Each side speaks the same small
 * protocol: a copy-paste invite carries an endpoint URL, a name and an
 * Ed25519 public key; whoever pastes it registers the peer and posts a signed
 * "connect" back, so both ends end up registered after one human exchange.
 * After that, messages are signed POSTs in both directions.
 *
 * A peer's messages land in the pair room under a hidden local bot that wears
 * the external bot's name - the thread, avatars and unread counts all ride the
 * ordinary bot machinery. Nothing here ever trusts a key the signature has not
 * just vouched for, and a fingerprint the human has blocked is turned away.
 */

/** A signature older or newer than this is stale: clocks drift, replays rot. */
const FED_MAX_SKEW_MS = 5 * 60_000;
/** The one kind of invite blob this build speaks. */
const INVITE_PREFIX = 'OBL-FED1.';
/** One line of copy-paste, but bounded like any other untrusted body. */
const MAX_INVITE_CHARS = 2000;
/** A peer message is one chat bubble, not a webhook payload. */
const MAX_PEER_TEXT = 20_000;
const NAME_MAX = 80;
const ENDPOINT_MAX = 300;
/** How long we wait on a peer's endpoint before giving the human the error. */
const FETCH_TIMEOUT_MS = 15_000;
/** The hidden bot that stands in for an external bot gets a look of its own. */
const PEER_COLOR = '#8b5cf6';
const PEER_AVATAR = '🕵️';

export interface FedInvite {
	name: string;
	endpoint: string;
	pubkey: string;
	fingerprint: string;
	nonce: string;
}

// ---- Identity ----

interface FedKeyRow {
	bot_id: string;
	public_key: string;
	private_key_enc: string;
	fingerprint: string;
	created_at: number;
}

/** A key's fingerprint: half a SHA-256 over the public key bytes, as hex. */
export function fingerprintOf(publicKey: string): string {
	return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32);
}

/**
 * The bot's federation pair, made the first time anything needs it and never
 * replaced - a fingerprint is an identity, and a new key would be a new bot.
 */
export function ensureFedKey(botId: string): FedKeyRow {
	const row = db.prepare('SELECT * FROM fed_keys WHERE bot_id = ?').get(botId) as
		| FedKeyRow
		| undefined;
	if (row) return row;
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const created: FedKeyRow = {
		bot_id: botId,
		public_key: pub,
		private_key_enc: encrypt(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
		fingerprint: fingerprintOf(pub),
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO fed_keys (bot_id, public_key, private_key_enc, fingerprint, created_at) VALUES (?,?,?,?,?)'
	).run(created.bot_id, created.public_key, created.private_key_enc, created.fingerprint, created.created_at);
	return created;
}

// ---- Signing ----

/**
 * The canonical string a signature covers: the send time, the payload kind and
 * the hash of the exact bytes on the wire. Signing the raw bytes rather than a
 * re-encoding of them keeps both sides' JSON libraries out of the trust path.
 */
function canonical(ts: number, kind: string, raw: string): string {
	return `${ts}\n${kind}\n${createHash('sha256').update(raw).digest('hex')}`;
}

export function fedSign(privateKeyPem: string, ts: number, kind: string, raw: string): string {
	return cryptoSign(null, Buffer.from(canonical(ts, kind, raw)), createPrivateKey(privateKeyPem))
		.toString('base64');
}

export function fedVerify(
	publicKey: string,
	ts: number,
	kind: string,
	raw: string,
	sig: string
): boolean {
	try {
		return cryptoVerify(
			null,
			Buffer.from(canonical(ts, kind, raw)),
			createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
			Buffer.from(sig, 'base64')
		);
	} catch {
		// A key or signature that does not even parse is a failed verify.
		return false;
	}
}

/** True when `ts` is a real millisecond time within the skew window. */
export function fedTsOk(ts: unknown): ts is number {
	return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(Date.now() - ts) <= FED_MAX_SKEW_MS;
}

// ---- Invites ----

/** Compose the blob and record its nonce, so the connect-back can be honoured. */
export function createInvite(botId: string, endpoint: string): { blob: string; fingerprint: string } {
	const bot = getBot(botId);
	if (!bot) throw new Error('no such bot');
	const key = ensureFedKey(botId);
	const nonce = randomBytes(16).toString('hex');
	db.prepare('INSERT INTO fed_invites (id, bot_id, nonce, created_at) VALUES (?,?,?,?)').run(
		randomUUID(),
		botId,
		nonce,
		Date.now()
	);
	const invite: FedInvite = {
		name: bot.name,
		endpoint,
		pubkey: key.public_key,
		fingerprint: key.fingerprint,
		nonce
	};
	const blob = INVITE_PREFIX + Buffer.from(JSON.stringify(invite), 'utf8').toString('base64url');
	return { blob, fingerprint: key.fingerprint };
}

/** Read an invite back. Junk, wrong version or a self-inconsistent key is null. */
export function parseInvite(raw: string): FedInvite | null {
	const blob = raw.trim().slice(0, MAX_INVITE_CHARS);
	if (!blob.startsWith(INVITE_PREFIX)) return null;
	let invite: FedInvite;
	try {
		invite = JSON.parse(Buffer.from(blob.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (
		!invite ||
		typeof invite.name !== 'string' ||
		invite.name.length === 0 ||
		invite.name.length > NAME_MAX ||
		typeof invite.endpoint !== 'string' ||
		!isHttpUrl(invite.endpoint) ||
		invite.endpoint.length > ENDPOINT_MAX ||
		typeof invite.pubkey !== 'string' ||
		typeof invite.nonce !== 'string' ||
		!/^[0-9a-f]{32}$/.test(invite.nonce)
	) {
		return null;
	}
	if (fingerprintOf(invite.pubkey) !== invite.fingerprint) return null;
	return invite;
}

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * The hidden bot that stands in for the external bot in the thread. It authors
 * messages like any other bot; it is simply never offered to the human as one
 * of their own.
 */
function createPeerBot(name: string, fingerprint: string): string {
	const bot = createBot({
		name: name.slice(0, NAME_MAX),
		persona: `An external bot from another lounge, paired by key fingerprint ${fingerprint}.`,
		avatar: PEER_AVATAR,
		color: PEER_COLOR,
		model: '',
		badge: ''
	});
	setBotHidden(bot.id, true);
	return bot.id;
}

// ---- Handshake ----

async function postSigned(
	privateKeyPem: string,
	endpoint: string,
	kind: string,
	body: Record<string, unknown>
): Promise<void> {
	const raw = JSON.stringify(body);
	const ts = Date.now();
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-fed-ts': String(ts),
			'x-fed-kind': kind,
			'x-fed-sig': fedSign(privateKeyPem, ts, kind, raw)
		},
		body: raw,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface ConnectResult {
	peer: Peer;
	/** False when the peer registered here but its own endpoint did not confirm. */
	confirmed: boolean;
	error: string;
}

/**
 * The human has pasted the other side's invite. Register the peer from it, then
 * immediately POST a signed connect back, so their side learns our identity
 * without another human step.
 */
export async function connectPeer(
	botId: string,
	invite: FedInvite,
	ourEndpoint: string
): Promise<ConnectResult> {
	const existing = listPeers(botId).find((p) => p.fingerprint === invite.fingerprint);
	const key = ensureFedKey(botId);
	const ourBot = getBot(botId)!;

	let peer: Peer;
	if (existing) {
		if (existing.endpoint !== invite.endpoint || existing.name !== invite.name) {
			updatePeer(existing.id, { endpoint: invite.endpoint, name: invite.name });
		}
		if (existing.status === 'blocked') updatePeer(existing.id, { status: 'paired' });
		peer = getPeer(existing.id)!;
	} else {
		peer = createPeer({
			bot_id: botId,
			peer_bot_id: createPeerBot(invite.name, invite.fingerprint),
			name: invite.name,
			endpoint: invite.endpoint,
			pubkey: invite.pubkey,
			fingerprint: invite.fingerprint,
			status: 'paired'
		});
	}

	try {
		await postSigned(decrypt(key.private_key_enc), invite.endpoint, 'connect', {
			nonce: invite.nonce,
			name: ourBot.name,
			endpoint: ourEndpoint,
			pubkey: key.public_key,
			fp: key.fingerprint
		});
		return { peer, confirmed: true, error: '' };
	} catch (e) {
		return { peer, confirmed: false, error: (e as Error).message };
	}
}

export interface FedInbound {
	ok: boolean;
	/** The HTTP status the inbox should answer with. */
	status: number;
	reason: string;
}

/**
 * A signed connect has arrived. A fingerprint we already know is refreshed and
 * confirmed; a stranger must hold an unused nonce from an invite we issued -
 * that is what makes an unprompted connect worthless to a forger.
 */
export function receiveConnect(botId: string, body: Record<string, unknown>): FedInbound {
	const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
	const nonce = typeof body.nonce === 'string' ? body.nonce : '';
	const name = typeof body.name === 'string' ? body.name.slice(0, NAME_MAX) : '';
	const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
	if (!pubkey || !isHttpUrl(endpoint) || !name) {
		return { ok: false, status: 400, reason: 'malformed connect' };
	}
	const fp = fingerprintOf(pubkey);
	const known = listPeers(botId).find((p) => p.fingerprint === fp);
	if (known) {
		if (known.endpoint !== endpoint || known.name !== name) {
			updatePeer(known.id, { endpoint, name });
		}
		return { ok: true, status: 200, reason: '' };
	}
	const invite = db
		.prepare('SELECT id FROM fed_invites WHERE bot_id = ? AND nonce = ? AND used_at = 0')
		.get(botId, nonce) as { id: string } | undefined;
	if (!invite) return { ok: false, status: 404, reason: 'unknown or spent invite' };
	db.prepare('UPDATE fed_invites SET used_at = ? WHERE id = ?').run(Date.now(), invite.id);
	createPeer({
		bot_id: botId,
		peer_bot_id: createPeerBot(name, fp),
		name,
		endpoint,
		pubkey,
		fingerprint: fp,
		status: 'paired'
	});
	return { ok: true, status: 200, reason: '' };
}

// ---- Messaging ----

/**
 * A signed message has arrived from a peer. It lands in the pair room under
 * the external bot's stand-in, and the local bot is woken to read it - the
 * same shape an inbound webhook takes.
 */
export function receiveMessage(botId: string, body: Record<string, unknown>): FedInbound {
	const peer = peerByFingerprint(botId, body);
	if (!peer) return { ok: false, status: 404, reason: 'no such peer' };
	if (peer.status === 'blocked') return { ok: false, status: 403, reason: 'blocked' };
	const text = typeof body.text === 'string' ? body.text.slice(0, MAX_PEER_TEXT) : '';
	if (!text.trim()) return { ok: false, status: 400, reason: 'empty message' };
	const conv = botPairConversation(botId, peer.peer_bot_id);
	addMessage(conv.id, 'assistant', text, peer.peer_bot_id, '', 0, 'fed');
	const bot = getBot(botId);
	if (bot) startTask(conv, bot, `Message from ${peer.name}`);
	logActivity(botId, 'fed', `Message from ${peer.name}`);
	return { ok: true, status: 200, reason: '' };
}

function peerByFingerprint(botId: string, body: Record<string, unknown>): Peer | undefined {
	const fp = typeof body.fp === 'string' ? body.fp : '';
	if (!fp) return undefined;
	return listPeers(botId).find((p) => p.fingerprint === fp);
}

/**
 * The public key the inbox should verify a message POST against: the one on
 * file for the fingerprint the sender claims, or '' when we hold no such peer.
 */
export function peerPubkeyFor(botId: string, body: Record<string, unknown>): string {
	return peerByFingerprint(botId, body)?.pubkey ?? '';
}

/** The peer this bot knows by the name it was paired under. */
export function peerByName(botId: string, name: string): Peer | undefined {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return undefined;
	return listPeers(botId).find((p) => p.name.toLowerCase() === wanted);
}

/**
 * Send one message to an external peer and keep our copy in the pair room. The
 * peer's reply, if any, comes back later as an inbound POST, not as this
 * call's result.
 */
export async function sendToPeer(
	botId: string,
	peerName: string,
	text: string
): Promise<string> {
	const peer = peerByName(botId, peerName);
	if (!peer) return `error: no external peer named "${peerName.trim()}"`;
	if (peer.status === 'blocked') return `error: ${peer.name} is blocked`;
	const key = ensureFedKey(botId);
	try {
		await postSigned(decrypt(key.private_key_enc), peer.endpoint, 'message', {
			fp: key.fingerprint,
			text: text.slice(0, MAX_PEER_TEXT)
		});
	} catch (e) {
		return `error: could not reach ${peer.name}'s lounge (${(e as Error).message})`;
	}
	const conv = botPairConversation(botId, peer.peer_bot_id);
	addMessage(conv.id, 'assistant', text.slice(0, MAX_PEER_TEXT), botId);
	logActivity(botId, 'fed', `To ${peer.name}: ${text.slice(0, 100)}`);
	return `sent to ${peer.name}`;
}

// ---- The human's verdicts ----

/** Unpair: the link goes, the conversation and its history stay. */
export function removePeer(id: string): boolean {
	return deletePeer(id);
}

/** Block keeps the fingerprint on file and refuses its inbound with a 403. */
export function setPeerBlocked(id: string, blocked: boolean): Peer {
	updatePeer(id, { status: blocked ? 'blocked' : 'paired' });
	return getPeer(id)!;
}

export { peerForConversation };
