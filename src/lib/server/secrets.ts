import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, getBot, logActivity, setMemory } from './db';
import { machineExec } from './machine';
import { config } from './config';

/**
 * Per-bot named secrets. Values are AES-256-GCM encrypted at rest and are
 * never returned to the model — bots reference secrets by name; the value is
 * injected into the sandbox filesystem or transferred to another bot on
 * request. The LLM only ever sees the name.
 */

const ALGO = 'aes-256-gcm';

/**
 * The AES key. It is generated once and kept beside the database, so it survives
 * restarts without living in the image or the source.
 *
 * There is deliberately NO fallback to a literal or to an unrelated setting: the
 * previous version derived the key from the session secret or the provider key,
 * and in a default install both are empty, which left every stored secret
 * encrypted under a constant published in this file.
 *
 * Resolved once per process: decrypt runs for every secret on every redaction
 * pass, and the key never changes while the app is up.
 */
let cachedKey: Buffer | null = null;

function key(): Buffer {
	if (cachedKey) return cachedKey;
	const fromEnv = process.env.SECRETS_KEY;
	if (fromEnv) return (cachedKey = createHash('sha256').update(fromEnv).digest());

	const path = join(config.dataDir, 'secrets.key');
	try {
		const existing = readFileSync(path);
		if (existing.length === 32) return (cachedKey = existing);
	} catch {
		// Not created yet.
	}
	const fresh = randomBytes(32);
	mkdirSync(config.dataDir, { recursive: true });
	writeFileSync(path, fresh, { mode: 0o600 });
	return (cachedKey = fresh);
}

/**
 * The derivation used before the dedicated key existed. Kept only so a database
 * written by that version can still be read - decryption falls back to it, and
 * anything opened that way is re-encrypted with the current key on next write.
 */
function legacyKey(): Buffer {
	return createHash('sha256')
		.update(config.sessionSecret || config.apiKey || 'obl-secrets')
		.digest();
}

export function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGO, key(), iv);
	const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob: string): string {
	const [iv, tag, data] = blob.split(':').map((s) => Buffer.from(s, 'base64'));
	const open = (k: Buffer) => {
		const decipher = createDecipheriv(ALGO, k, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
	};
	try {
		return open(key());
	} catch (e) {
		// A secret written before the dedicated key existed.
		try {
			return open(legacyKey());
		} catch {
			throw e;
		}
	}
}

interface SecretRow {
	id: string;
	bot_id: string;
	name: string;
	value: string; // encrypted
	shared_with: string; // CSV of bot_ids allowed to use it
	created_at: number;
}

export function createSecret(botId: string, name: string, plainValue: string): SecretRow {
	const row: SecretRow = {
		id: crypto.randomUUID(),
		bot_id: botId,
		name,
		value: encrypt(plainValue),
		shared_with: '',
		created_at: Date.now()
	};
	// Re-using a name rotates the value - and keeps whoever it was shared with.
	db.prepare(
		`INSERT INTO bot_secrets (id, bot_id, name, value, shared_with, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(bot_id, name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
	).run(row.id, row.bot_id, row.name, row.value, row.shared_with, row.created_at);
	logActivity(botId, 'secret', `Stored secret "${name}"`);
	return getSecret(botId, name) ?? row;
}

export function listSecrets(botId: string): Omit<SecretRow, 'value'>[] {
	return db
		.prepare('SELECT id, bot_id, name, shared_with, created_at FROM bot_secrets WHERE bot_id = ?')
		.all(botId) as unknown as Omit<SecretRow, 'value'>[];
}

export function getSecret(botId: string, name: string): SecretRow | undefined {
	return db
		.prepare('SELECT * FROM bot_secrets WHERE bot_id = ? AND name = ?')
		.get(botId, name) as SecretRow | undefined;
}

/** Secrets visible to a bot: its own plus those shared to it. */
export function usableSecrets(botId: string): Omit<SecretRow, 'value'>[] {
	const own = listSecrets(botId);
	const shared = (
		db.prepare('SELECT * FROM bot_secrets WHERE shared_with LIKE ?').all(`%${botId}%`) as unknown as SecretRow[]
	).map(({ value: _v, ...rest }) => rest);
	return [...own, ...shared];
}

export function deleteSecret(botId: string, name: string): boolean {
	const r = db.prepare('DELETE FROM bot_secrets WHERE bot_id = ? AND name = ?').run(botId, name);
	return r.changes > 0;
}

/** Grant another bot use of a secret (value stays hidden; it can inject it). */
export function shareSecret(ownerBotId: string, name: string, targetBotId: string): boolean {
	const s = getSecret(ownerBotId, name);
	const target = getBot(targetBotId);
	if (!s || !target) return false;
	const shared = s.shared_with ? s.shared_with.split(',') : [];
	if (!shared.includes(targetBotId)) shared.push(targetBotId);
	db.prepare('UPDATE bot_secrets SET shared_with = ? WHERE id = ?').run(shared.join(','), s.id);
	logActivity(ownerBotId, 'secret', `Shared "${name}" with ${target.name}`);
	return true;
}

/**
 * Take a share back: the named bot loses its entry and with it every way in -
 * injectSecret re-checks shared_with on each call, so nothing has to be hunted
 * down on the target's sandbox. What stays is the file a previous inject already
 * wrote there: it was readable at 0600 by the target's own sandbox user, so the
 * value was in their reach until then and a database edit cannot unpaste it.
 * The honest wording is on the caller, which knows the target's name.
 * Returns true when a share existed to remove, false when there was none.
 */
export function unshareSecret(ownerBotId: string, name: string, targetBotId: string): boolean {
	const s = getSecret(ownerBotId, name);
	if (!s || !s.shared_with) return false;
	const kept = s.shared_with.split(',').filter((id) => id !== targetBotId);
	if (kept.length === s.shared_with.split(',').length) return false;
	db.prepare('UPDATE bot_secrets SET shared_with = ? WHERE id = ?').run(kept.join(','), s.id);
	return true;
}

/**
 * A bot's recorded "no" to a secret it was offered. There is nothing to accept
 * or refuse on the row itself - the human's handover creates the secret and the
 * memory note in one POST (see the bots/[id]/secrets route) - so the decline
 * overwrites the offer's memory key (`secret:<name>`): a bot that said no must
 * not keep carrying a memory that says the secret is there for it, and a later
 * turn reads "you declined this, and why" instead of a standing invitation.
 * The activity row is what the human's panel reads; the reason is the bot's own
 * words and never a value - the caller redacts it before it gets here.
 */
export function recordSecretDecline(botId: string, name: string, reason: string): void {
	setMemory(
		botId,
		`secret:${name}`,
		`You declined the secret "${name}"` +
			(reason ? ` - your reason: ${reason}` : '') +
			'. It is still stored by the human; do not use it unless they say otherwise.'
	);
	logActivity(botId, 'secret', `Declined the secret "${name}"${reason ? ` - ${reason}` : ''}`);
}

function canUse(botId: string, row: SecretRow): boolean {
	return row.bot_id === botId || row.shared_with.split(',').includes(botId);
}

/**
 * The only shape of name that can be written into a sandbox path. Storing and
 * injecting share it, so a bot can never save a name it cannot later use.
 */
export const SECRET_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Put a secret into the bot's sandbox as ~/.secrets/<name>, readable only by the
 * sandbox user. The bot can then use it in commands (for example
 * `curl -H "Authorization: $(cat ~/.secrets/api_key)"`) without the value ever
 * entering the transcript.
 *
 * The value is written through the shell as base64 so no amount of quoting in
 * the secret can break out of the command.
 */
export async function injectSecret(botId: string, name: string): Promise<string> {
	if (!SECRET_NAME_RE.test(name)) return 'error: secret names may use letters, digits, dot, dash or underscore';
	const row =
		getSecret(botId, name) ??
		(db
			.prepare('SELECT * FROM bot_secrets WHERE name = ? AND shared_with LIKE ?')
			.get(name, `%${botId}%`) as SecretRow | undefined);
	if (!row || !canUse(botId, row)) return `error: no usable secret named "${name}"`;

	const encoded = Buffer.from(decrypt(row.value), 'utf8').toString('base64');
	// The exec lands in the machine's shell user home ($HOME), so the file is
	// wherever that account keeps its secrets rather than at a fixed path.
	const command =
		`mkdir -p "$HOME/.secrets" && chmod 700 "$HOME/.secrets" && ` +
		`printf %s '${encoded}' | base64 -d > "$HOME/.secrets/${name}" && ` +
		`chmod 600 "$HOME/.secrets/${name}" && echo OBL_INJECTED`;

	try {
		const out = await machineExec(botId, command);
		if (!out.includes('OBL_INJECTED')) return 'error: inject failed';
	} catch (e) {
		return `error: inject failed (${(e as Error).message})`;
	}
	logActivity(botId, 'secret', `Injected "${name}" into the machine`);
	return `secret "${name}" available at ~/.secrets/${name} (use it in commands, never print it)`;
}
/**
 * Replace any of a bot's secret values with a placeholder before text reaches
 * the model. The value has to live in the sandbox for the bot to use it, so a
 * bot that cats the file would otherwise put the secret straight into the
 * transcript - and from there into the provider's logs.
 */
export function redactSecrets(botId: string, text: string): string {
	if (!text) return text;
	for (const { name, plain } of plaintextSecretsFor(botId)) {
		// A floor keeps a short value from matching half the output and mangling
		// it. Five, not six: a four-digit PIN or a short password is exactly the
		// kind of secret that must not slip through, and four characters collide
		// with ordinary words and numbers often enough to wreck the transcript.
		if (plain.length < 5) continue;
		if (text.includes(plain)) text = text.split(plain).join(`[secret:${name}]`);
	}
	return text;
}

/**
 * Replace every value in the table with a placeholder, whoever owns it. The
 * debug toolset can read other bots' conversations and state, where a value
 * that escaped redaction elsewhere could be sitting; this is the last gate
 * before such a result reaches a model.
 */
export function redactEverySecret(text: string): string {
	if (!text) return text;
	for (const { name, plain } of plaintextEverySecret()) {
		// Same floor as redactSecrets, for the same reason.
		if (plain.length < 5) continue;
		if (text.includes(plain)) text = text.split(plain).join(`[secret:${name}]`);
	}
	return text;
}

/** Every stored secret, decrypted. For redaction only - never logged. */
function plaintextEverySecret(): { name: string; plain: string }[] {
	const rows = db.prepare('SELECT * FROM bot_secrets').all() as unknown as SecretRow[];
	const out: { name: string; plain: string }[] = [];
	for (const row of rows) {
		try {
			out.push({ name: row.name, plain: decrypt(row.value) });
		} catch {
			// Unreadable row: nothing to redact.
		}
	}
	return out;
}

/** Every secret this bot may use, decrypted. For redaction only - never logged. */
function plaintextSecretsFor(botId: string): { name: string; plain: string }[] {
	const rows = [
		...(db.prepare('SELECT * FROM bot_secrets WHERE bot_id = ?').all(botId) as unknown as SecretRow[]),
		...(db
			.prepare('SELECT * FROM bot_secrets WHERE shared_with LIKE ?')
			.all(`%${botId}%`) as unknown as SecretRow[])
	];
	const out: { name: string; plain: string }[] = [];
	for (const row of rows) {
		try {
			out.push({ name: row.name, plain: decrypt(row.value) });
		} catch {
			// Unreadable row: nothing to redact.
		}
	}
	return out;
}
