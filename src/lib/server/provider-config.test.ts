import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';
import { createBot, db, getBot, listSettings, providerConfig, setSetting } from './db';

/**
 * Re-run the db module boot sequence - migrations, cleanups and the
 * provider-config migration - against the current tables. The migration is
 * not exported; a fresh module graph is the only way to invoke it again.
 */
async function reimportDb() {
	vi.resetModules();
	return import('./db');
}

/** The schema a pre-cutover database carried, recreated by hand. */
function makeOldSchema(): void {
	db.exec(`
		CREATE TABLE model_profiles (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			base_url   TEXT NOT NULL,
			api_key    TEXT NOT NULL DEFAULT '',
			model      TEXT NOT NULL,
			is_default INTEGER NOT NULL DEFAULT 0,
			oauth      TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL
		);
		ALTER TABLE bots ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';
	`);
}

// Each case starts from a clean provider config: the settings table is shared
// state, and a key one test writes must not leak into the next.
beforeEach(() => {
	for (const k of ['provider_base_url', 'provider_api_key', 'provider_oauth', 'default_model']) {
		db.prepare('DELETE FROM settings WHERE key = ?').run(k);
	}
});

describe('the model_profiles → settings migration', () => {
	it('copies the default profile into settings and drops the table', async () => {
		makeOldSchema();
		db.prepare(
			"INSERT INTO model_profiles (id, name, base_url, api_key, model, is_default, oauth, created_at) VALUES ('p1', 'Old', 'https://api.old.example/v1', 'sk-old-key', 'old-model', 1, '', 1)"
		).run();
		const bot = createBot({
			name: `Mig${Date.now()}`,
			persona: '',
			avatar: '',
			color: '',
			model: 'kept-model',
			badge: ''
		});
		db.prepare("UPDATE bots SET profile_id = 'p1' WHERE id = ?").run(bot.id);

		const fresh = await reimportDb();

		const s = fresh.listSettings();
		expect(s.provider_base_url).toBe('https://api.old.example/v1');
		expect(s.provider_api_key).toBe('sk-old-key');
		expect(s.default_model).toBe('old-model');
		// The table and the column that pointed at it are gone.
		expect(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_profiles'")
				.all()
		).toEqual([]);
		const cols = db.prepare('PRAGMA table_info(bots)').all() as { name: string }[];
		expect(cols.some((c) => c.name === 'profile_id')).toBe(false);
		// The bot that referenced the profile keeps its own model override.
		expect(fresh.getBot(bot.id)?.model).toBe('kept-model');
	});

	it('keeps settings the user already saved over the profile values', async () => {
		setSetting('provider_base_url', 'https://api.new.example/v1');
		makeOldSchema();
		db.prepare(
			"INSERT INTO model_profiles (id, name, base_url, api_key, model, is_default, oauth, created_at) VALUES ('p2', 'Old', 'https://api.old.example/v1', 'sk-old-key', 'old-model', 1, '', 1)"
		).run();

		await reimportDb();

		expect(listSettings().provider_base_url).toBe('https://api.new.example/v1');
		// The key the profile held still migrates - only the key already set wins.
		expect(listSettings().provider_api_key).toBe('sk-old-key');
	});

	it('is a no-op on a database that never had profiles', async () => {
		const fresh = await reimportDb();
		expect(fresh.listSettings().provider_base_url).toBeUndefined();
	});
});

describe('providerConfig', () => {
	it('falls back to the environment when nothing is saved', () => {
		setSetting('provider_base_url', '');
		setSetting('provider_api_key', '');
		setSetting('provider_oauth', '');
		const cfg = providerConfig();
		expect(cfg.baseUrl).toBe(config.baseUrl);
		expect(cfg.apiKey).toBe(config.apiKey);
		expect(cfg.oauth).toBe('');
	});

	it('answers with the saved values once they exist', () => {
		setSetting('provider_base_url', 'https://api.saved.example/v1/');
		setSetting('provider_api_key', 'sk-saved');
		const cfg = providerConfig();
		expect(cfg.baseUrl).toBe('https://api.saved.example/v1');
		expect(cfg.apiKey).toBe('sk-saved');
	});
});
