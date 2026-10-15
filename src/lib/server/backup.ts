import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';

/**
 * A nightly copy of the database, and the check that decides whether to use it.
 *
 * One copy, overwritten each night: a chat log is worth a day of protection, not
 * an archive, and a single file is one the user can find and copy out. The copy
 * is taken with VACUUM INTO rather than by copying the file, because a plain
 * copy of a live WAL database can catch it mid-write and produce a file that
 * only looks like a database.
 */

/** Where the one copy lives, beside the database it protects. */
const BACKUP_DIR = join(config.dataDir, 'backups');
const BACKUP_PATH = join(BACKUP_DIR, 'chat.db');

/** The live database, as this module needs to name it. */
const DB_PATH = join(config.dataDir, 'chat.db');

/** `VACUUM INTO` takes a string literal, so the path has to be quoted. */
function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Is this file a database we can actually read? Opening it and running
 * integrity_check is the only answer that means anything - a file can be the
 * right size and still be rubbish.
 */
function isDatabaseUsable(path: string): boolean {
	if (!existsSync(path)) return false;
	let probe: DatabaseSync | null = null;
	try {
		probe = new DatabaseSync(path, { readOnly: true });
		const row = probe.prepare('PRAGMA integrity_check').get() as
			| { integrity_check?: string }
			| undefined;
		// A table count is a second opinion: integrity_check alone passes on a
		// file that is intact but has none of our tables in it.
		const tables = probe
			.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
			.get() as { n?: number } | undefined;
		return row?.integrity_check === 'ok' && (tables?.n ?? 0) > 0;
	} catch {
		return false;
	} finally {
		try {
			probe?.close();
		} catch {
			// Already closed or never opened.
		}
	}
}

/**
 * Take tonight's copy.
 *
 * Written to a temporary name and moved into place, so an interrupted backup
 * cannot leave a half-file where last night's good copy was.
 */
export function backupDatabase(): { ok: boolean; bytes?: number; error?: string } {
	mkdirSync(BACKUP_DIR, { recursive: true });
	const staging = `${BACKUP_PATH}.tmp`;
	try {
		rmSync(staging, { force: true });
		const db = new DatabaseSync(DB_PATH, { timeout: 5000 });
		try {
			// Consistent, and compacted on the way out - a copy of a database that
			// has seen a lot of deletes is mostly free pages otherwise.
			db.exec(`VACUUM INTO ${sqlString(staging)}`);
		} finally {
			db.close();
		}
		if (!isDatabaseUsable(staging)) {
			rmSync(staging, { force: true });
			return { ok: false, error: 'the copy did not verify' };
		}
		renameSync(staging, BACKUP_PATH);
		return { ok: true, bytes: statSync(BACKUP_PATH).size };
	} catch (e) {
		rmSync(staging, { force: true });
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** When the copy was last taken, or 0 if there is none. */
function backupTakenAt(): number {
	try {
		return statSync(BACKUP_PATH).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Replace a broken database with the copy, keeping the broken one.
 *
 * The damaged file is renamed rather than deleted: it is the user's only record
 * of everything since the copy, and somebody who knows what they are doing can
 * often still read it. Returns a description of what happened for the user, or
 * null when there was nothing to do.
 */
function restoreFromBackup(): string | null {
	if (!isDatabaseUsable(BACKUP_PATH)) return null;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const damaged = `${DB_PATH}.damaged-${stamp}`;
	try {
		if (existsSync(DB_PATH)) renameSync(DB_PATH, damaged);
		// The sidecars belong to the database being replaced; carrying them over
		// would apply one database's log to another.
		for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
			if (existsSync(sidecar)) rmSync(sidecar, { force: true });
		}
		copyFileSync(BACKUP_PATH, DB_PATH);
		return damaged;
	} catch {
		return null;
	}
}

/** How long between copies: a fixed interval, not a calendar-day boundary. */
const BACKUP_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Whether a copy is due: none yet, or the last one is older than the interval.
 * A fixed interval rather than a day boundary - a copy taken at 23:59 is not
 * due again at 00:01, and one taken at 00:01 does not have to wait out a whole
 * calendar day when the machine slept through the next midnight.
 */
export function backupDue(now = Date.now()): boolean {
	const taken = backupTakenAt();
	if (!taken) return true;
	return now - taken >= BACKUP_INTERVAL_MS;
}

/**
 * Check the database before anything opens it, and put the copy in its place if
 * it is damaged.
 *
 * Returns the path the damaged file was moved to, or null when there was nothing
 * to do - which is every normal start.
 */
export function recoverIfDamaged(): string | null {
	// No database yet is a fresh install, not corruption.
	if (!existsSync(DB_PATH)) return null;
	if (isDatabaseUsable(DB_PATH)) return null;
	return restoreFromBackup();
}
