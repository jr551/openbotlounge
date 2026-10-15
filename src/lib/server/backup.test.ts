import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * backupDue reads the real backup file's mtime, so the test writes a real file
 * into a temp DATA_DIR and sets its mtime by hand. config.dataDir is read at
 * module load, so the env var is set before the import and restored after.
 */

const DAY = 24 * 60 * 60_000;
let dataDir = '';

// A controlled mtime on the backup file, so backupDue sees a known age.
function touchBackupAt(mtimeMs: number): void {
	const dir = join(dataDir, 'backups');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'chat.db');
	writeFileSync(path, 'x');
	const when = new Date(mtimeMs);
	utimesSync(path, when, when);
}
function touchBackup(ageMs: number): void {
	touchBackupAt(Date.now() - ageMs);
}

describe('backupDue', () => {
	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'obl-backup-'));
		process.env.DATA_DIR = dataDir;
		vi.resetModules();
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
		delete process.env.DATA_DIR;
	});

	// Dynamic import: backup.ts resolves BACKUP_PATH from config.dataDir at
	// module load, so the module must be imported only after DATA_DIR is set.
	async function due(now?: number): Promise<boolean> {
		const { backupDue } = await import('./backup');
		return backupDue(now);
	}

	it('is due when no backup exists', async () => {
		expect(await due()).toBe(true);
	});

	it('is not due inside the interval', async () => {
		touchBackup(DAY - 60_000); // 23h59m old
		expect(await due()).toBe(false);
	});

	it('is due once the interval has elapsed', async () => {
		touchBackup(DAY + 60_000); // 24h01m old
		expect(await due()).toBe(true);
	});

	it('does not fire early across a calendar-day boundary', async () => {
		// The old bug: a copy taken at 23:59 was "due" at 00:01 because
		// toDateString changed. A fixed interval must not.
		const now = new Date();
		now.setHours(0, 1, 0, 0); // 00:01 today
		touchBackupAt(now.getTime() - 2 * 60_000); // 23:59 yesterday
		expect(await due(now.getTime())).toBe(false);
	});

	it('fires when the machine slept through a whole day boundary', async () => {
		// The other half of the bug: a copy taken just after midnight was not
		// due again until the next calendar day even if 47h passed. A fixed
		// interval is due as soon as 24h elapse.
		const now = new Date();
		now.setHours(0, 2, 0, 0); // 00:02 today
		touchBackupAt(now.getTime() - 47 * 60 * 60_000); // 47h ago
		expect(await due(now.getTime())).toBe(true);
	});
});
