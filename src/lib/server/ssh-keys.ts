import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { db, getBot, logActivity } from './db';
import { machineExec, machineWriteFile } from './machine';
import { EGRESS_NAME, EGRESS_PORT } from './machine-net';
import { decrypt, encrypt } from './secrets';

/**
 * One ed25519 key pair per bot: the identity it pushes to git with.
 *
 * The public half is shown in the bot's profile so the human can paste it into
 * GitHub or Forgejo as a deploy key; the private half is AES-256-GCM encrypted
 * at rest like a secret and is never returned by a route. It exists to be
 * written into that bot's own machine and nowhere else. Both live in their own
 * table rather than on the bot row because every bot API payload is a
 * `SELECT *` of that row - a column there would be on its way to a client.
 */

/** The canonical private key path: on the volume that survives a rebuild. */
const KEY_PATH = '/shared/.ssh/id_ed25519';

/** The literal the install command ends with, so a silent failure is not read as success. */
const INSTALLED = 'OBL_KEY_INSTALLED';

/**
 * What the machine's ~/.ssh/config holds. The first clone of a host must not
 * stop on a fingerprint prompt, but a key that changes afterwards is still
 * refused: the pin lives on /shared, so it survives the container it was
 * learned in.
 *
 * The machine's only way out is the egress proxy, which allows any port to a
 * public host and refuses every private address, so a git host's port-22
 * endpoint is reachable. GitHub is still pinned to its 443 endpoint: that port
 * is what its own docs offer for locked-down networks, and it costs nothing to
 * keep using it.
 */
const SSH_CONFIG = `# openbotlounge: the bot's git identity. Rewritten on every wake.
Host github.com
  HostName ssh.github.com
  Port 443
  ProxyCommand nc -X connect -x ${EGRESS_NAME}:${EGRESS_PORT} %h %p

Host *
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /shared/.ssh/known_hosts
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519
`;

interface KeyRow {
	bot_id: string;
	public_key: string;
	private_key_enc: string;
	comment: string;
	created_at: number;
}

/** One string in OpenSSH's wire format: a 4-byte length, then the bytes. */
function wireString(value: string | Buffer): Buffer {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
}

/**
 * A fresh ed25519 pair, the public half in OpenSSH wire format so `ssh-keygen
 * -y` agrees with it byte for byte.
 *
 * A node public key exports as SPKI DER only, and that DER is 12 bytes of
 * algorithm header followed by the raw 32-byte key, so the wire blob is
 * `string "ssh-ed25519" + string <the last 32 DER bytes>` - which is what an
 * ssh-ed25519 key is. The private half is PKCS8 PEM: OpenSSH reads it as-is,
 * and with no passphrase it needs no agent.
 */
export function generateSshKeyPair(
	comment: string,
	seed?: string
): { public_key: string; private_key: string } {
	// A seed makes the key deterministic: the same name always produces the
	// same pair, so a bot rebuilt from scratch keeps the identity the git host
	// already knows. The seed is hashed into the 32 bytes an ed25519 private
	// key is, wrapped in the fixed PKCS8 prefix the algorithm's DER carries.
	let publicKey: KeyObject;
	let privateKey: KeyObject;
	if (seed) {
		const seedBytes = createHash('sha256').update(`openbotlounge:${seed}`).digest();
		const der = Buffer.concat([
			Buffer.from('302e020100300506032b657004220420', 'hex'),
			seedBytes
		]);
		privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
		publicKey = createPublicKey(privateKey);
	} else {
		const pair = generateKeyPairSync('ed25519');
		publicKey = pair.publicKey;
		privateKey = pair.privateKey;
	}
	const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
	const blob = Buffer.concat([wireString('ssh-ed25519'), wireString(der.subarray(-32))]);
	return {
		public_key: `ssh-ed25519 ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`,
		private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
	};
}

/**
 * The bot's key row, made the first time anything asks for it and never
 * replaced.
 *
 * Lazy on purpose: a bot that existed before this table - or a test that
 * inserts a row straight through createBot - gets a key the first time one is
 * read, without every creation path having to remember to make one.
 */
export function ensureSshKey(botId: string): KeyRow | undefined {
	const read = db.prepare('SELECT * FROM bot_ssh_keys WHERE bot_id = ?');
	const existing = read.get(botId) as KeyRow | undefined;
	if (existing) return existing;
	const bot = getBot(botId);
	if (!bot) return undefined;
	// The comment a git host shows beside the key; the same slug the machine
	// takes as its hostname, so the two read as one bot.
	const comment = `${bot.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot'}@openbotlounge`;
	const pair = generateSshKeyPair(comment, bot.name);
	const row: KeyRow = {
		bot_id: botId,
		public_key: pair.public_key,
		private_key_enc: encrypt(pair.private_key),
		comment,
		created_at: Date.now()
	};
	// DO NOTHING, not REPLACE: a reader that races this one must not hand the
	// bot a second key the git host has never seen.
	const made = db
		.prepare(
			`INSERT INTO bot_ssh_keys (bot_id, public_key, private_key_enc, comment, created_at)
			 VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_id) DO NOTHING`
		)
		.run(row.bot_id, row.public_key, row.private_key_enc, row.comment, row.created_at);
	if (made.changes > 0) {
		logActivity(botId, 'secret', 'Generated its SSH key for git');
		return row;
	}
	// The loser reads the winner's row; its own key was never stored.
	return read.get(botId) as KeyRow | undefined;
}

/** The bot's public key in OpenSSH format; '' when there is no such bot. */
export function sshPublicKey(botId: string): string {
	return ensureSshKey(botId)?.public_key ?? '';
}

/**
 * A bot row as an API payload: everything the row has, plus the one key field a
 * client is allowed to see. Every route that hands the UI a bot goes through
 * this, because the UI replaces the bot it holds with whatever comes back.
 *
 * The row's flag columns are SQLite INTEGER 0/1 (the Bot type stays numeric -
 * that is the storage contract, not the wire one), but the HTTP API speaks
 * booleans: these are serialized here, once, so every route that answers with
 * a bot agrees.
 */
const BOT_BOOL_COLUMNS = ['onboarded', 'hidden', 'archived', 'nix_enabled'] as const;

export function withSshKey<T extends { id: string }>(bot: T): T & { ssh_public_key: string } {
	const out = { ...bot, ssh_public_key: sshPublicKey(bot.id) } as Record<string, unknown>;
	for (const column of BOT_BOOL_COLUMNS) {
		if (column in out) out[column] = !!out[column];
	}
	return out as T & { ssh_public_key: string };
}

/**
 * Put the bot's key into its machine, where git can find it.
 *
 * The container's writable layer is thrown away whenever Docker recreates the
 * machine, so the canonical copy sits on the /shared volume and every wake
 * copies it into $HOME/.ssh - root's home inside the machine - with the modes
 * ssh insists on. The config points known_hosts at /shared for the same reason.
 *
 * Best-effort by design: this runs on the wake path, and a bot whose key could
 * not be written should still wake. Returns the public key, or '' if it is not
 * installed. The private key goes only into this bot's own machine and is never
 * returned to a caller.
 */
export async function materializeBotKey(botId: string): Promise<string> {
	const key = ensureSshKey(botId);
	if (!key) return '';
	try {
		// The directories and the empty known_hosts first, in a command that
		// carries no key material: the writes below are plain redirects that
		// need the directory to exist.
		await machineExec(
			botId,
			'mkdir -p /shared/.ssh "$HOME/.ssh" && chmod 700 /shared/.ssh "$HOME/.ssh" && ' +
				'touch /shared/.ssh/known_hosts && chmod 600 /shared/.ssh/known_hosts',
			undefined,
			'sandbox'
		);

		// The key material travels over file writes, never a shell command:
		// an exec of the base64 PEM used to land verbatim in the exec log,
		// publishing the bot's private key to the activity feed. base64
		// through the write path, like injectSecret - no quoting in a PEM
		// can break out of the redirect.
		await machineWriteFile(botId, KEY_PATH, decrypt(key.private_key_enc));
		await machineWriteFile(botId, `${KEY_PATH}.pub`, `${key.public_key}\n`);
		await machineWriteFile(botId, '/shared/.ssh/config', SSH_CONFIG);
		// The canonical copies live on /shared, because the container's layer
		// is not kept; $HOME/.ssh is what ssh actually reads.
		const out = await machineExec(
			botId,
			[
				'chmod 600 /shared/.ssh/id_ed25519 /shared/.ssh/config',
				'chmod 644 /shared/.ssh/id_ed25519.pub',
				'cp -f /shared/.ssh/id_ed25519 /shared/.ssh/id_ed25519.pub /shared/.ssh/config "$HOME/.ssh/"',
				'chmod 600 "$HOME/.ssh/id_ed25519" "$HOME/.ssh/config"',
				'chmod 644 "$HOME/.ssh/id_ed25519.pub"',
				// A symlink, so a host key learned now is still trusted after a rebuild.
				'ln -sf /shared/.ssh/known_hosts "$HOME/.ssh/known_hosts"',
				`echo ${INSTALLED}`
			].join(' && '),
			undefined,
			'sandbox'
		);
		if (!out.includes(INSTALLED)) throw new Error(out.trim() || 'no output');
	} catch (e) {
		// A chat-only bot has no machine at all, which is not worth shouting
		// about; anything else is worth a line in the app log.
		console.error(`could not install the SSH key for ${botId}: ${(e as Error).message}`);
		return '';
	}
	return key.public_key;
}
