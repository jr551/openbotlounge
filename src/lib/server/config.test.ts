import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * config.ts reads process.env once, at import time, so every case needs a fresh
 * module instance. That is the one thing a dynamic import is for here: a static
 * import would freeze whichever environment happened to be set first.
 */
const ENV_KEYS = [
	'LLM_BASE_URL',
	'LLM_API_KEY',
	'LLM_MODEL',
	'APP_PASSWORD',
	'SESSION_SECRET',
	'DATA_DIR',
	'MAX_HISTORY_MESSAGES',
	'LLM_MAX_TURNS',
	'LLM_MAX_TOKENS_PER_TASK',
	'LLM_TASK_TIMEOUT_MS',
	'BOT_SOCIAL',
	'USER_NAME',
	'BOT_SOCIAL_MINUTES',
	'PROVIDER_TEST_ALLOW_PRIVATE',
	'TRUST_PROXY',
	'FED_ALLOW_PRIVATE'
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const savedEnv: Partial<Record<EnvKey, string>> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
afterAll(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function loadConfig(env: Partial<Record<EnvKey, string>> = {}) {
	vi.resetModules();
	for (const key of ENV_KEYS) delete process.env[key];
	Object.assign(process.env, env);
	return (await import('./config')).config;
}

/** Every numeric setting, the default it documents and a value it accepts. */
const NUMBERS = [
	{ env: 'MAX_HISTORY_MESSAGES', field: 'maxHistory', fallback: 60, allowed: 50 },
	{ env: 'LLM_MAX_TURNS', field: 'maxTurnsPerTask', fallback: 8, allowed: 3 },
	{ env: 'LLM_MAX_TOKENS_PER_TASK', field: 'maxTokensPerTask', fallback: 200_000, allowed: 1_200 },
	{ env: 'LLM_TASK_TIMEOUT_MS', field: 'taskTimeoutMs', fallback: 300_000, allowed: 1_200 },
	{ env: 'LLM_RETRY_ATTEMPTS', field: 'llmRetryAttempts', fallback: 5, allowed: 2 },
	{ env: 'LLM_RETRY_INTERVAL_MS', field: 'llmRetryIntervalMs', fallback: 5_000, allowed: 250 },
	{ env: 'BOT_SOCIAL_MINUTES', field: 'socialIntervalMin', fallback: 60, allowed: 15 }
] as const;

// Blank, unparseable and out-of-range are all the same mistake: fall back.
const BAD_NUMBERS = ['', '   ', 'abc', '8px', '1e999', '-5', 'NaN'];

describe('config: defaults', () => {
	it('uses the documented default when nothing is set', async () => {
		const c = await loadConfig();
		expect(c).toEqual({
			baseUrl: 'https://openrouter.ai/api/v1',
			apiKey: '',
			model: 'deepseek/deepseek-v4.1-flash',
			password: '',
			sessionSecret: '',
			dataDir: './data',
			maxHistory: 60,
			maxTurnsPerTask: 8,
			maxTokensPerTask: 200_000,
			taskTimeoutMs: 300_000,
			llmRetryAttempts: 5,
			llmRetryIntervalMs: 5_000,
			social: true,
			userName: 'you',
			socialIntervalMin: 60,
			providerTestAllowPrivate: false,
			trustProxy: false,
			fedAllowPrivate: false
		});
	});
});

describe('config: numbers', () => {
	it.each(NUMBERS)('passes a sane $env through unchanged', async (row) => {
		const c = await loadConfig({ [row.env]: String(row.allowed) });
		expect(c[row.field]).toBe(row.allowed);
	});

	it.each(NUMBERS)('falls back to the default for a garbage $env', async (row) => {
		for (const value of BAD_NUMBERS) {
			const c = await loadConfig({ [row.env]: value });
			expect(c[row.field], `${row.env}=${JSON.stringify(value)}`).toBe(row.fallback);
		}
	});

	it('never leaves a numeric setting as NaN or Infinity', async () => {
		// A NaN ceiling reads as "no ceiling" in runner.ts (`steps >= NaN` is
		// always false), so a typo would silently lift every turn limit.
		const c = await loadConfig(
			Object.fromEntries(NUMBERS.map((row) => [row.env, 'not a number'])) as Partial<
				Record<EnvKey, string>
			>
		);
		for (const row of NUMBERS) {
			expect(Number.isFinite(c[row.field]), row.field).toBe(true);
			expect(c[row.field]).toBe(row.fallback);
		}
	});

	it('treats 0 as "send everything" for MAX_HISTORY_MESSAGES but as invalid for the turn budgets', async () => {
		const c = await loadConfig({
			MAX_HISTORY_MESSAGES: '0',
			LLM_MAX_TURNS: '0',
			LLM_MAX_TOKENS_PER_TASK: '0',
			LLM_TASK_TIMEOUT_MS: '0'
		});
		// 0 is the documented "unlimited history" value, so it must survive.
		expect(c.maxHistory).toBe(0);
		// 0 turns / 0 tokens / 0 ms would stop the turn before the model is even
		// called, so those fall back rather than becoming the live setting.
		expect(c.maxTurnsPerTask).toBe(8);
		expect(c.maxTokensPerTask).toBe(200_000);
		expect(c.taskTimeoutMs).toBe(300_000);
	});

	it('holds BOT_SOCIAL_MINUTES to its 5-minute floor', async () => {
		expect((await loadConfig({ BOT_SOCIAL_MINUTES: '5' })).socialIntervalMin).toBe(5);
		// Below the floor the settings route also rejects, so fall back rather
		// than let a typo make bots chat every scheduler tick.
		for (const value of ['0', '4', '-30']) {
			const c = await loadConfig({ BOT_SOCIAL_MINUTES: value });
			expect(c.socialIntervalMin, value).toBe(60);
		}
	});
});

describe('config: booleans', () => {
	const TRUE_VALUES = ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', ' true '];
	const FALSE_VALUES = ['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', ' false '];
	// A typo keeps the documented default; it must never flip the feature off.
	const GARBAGE = ['', '   ', 'maybe', '2', '-1', 'nope', 'trueish'];

	it('reads the values a user would write for BOT_SOCIAL', async () => {
		for (const value of TRUE_VALUES) {
			const c = await loadConfig({ BOT_SOCIAL: value });
			expect(c.social, `BOT_SOCIAL=${JSON.stringify(value)}`).toBe(true);
		}
		for (const value of FALSE_VALUES) {
			const c = await loadConfig({ BOT_SOCIAL: value });
			expect(c.social, `BOT_SOCIAL=${JSON.stringify(value)}`).toBe(false);
		}
	});

	it('keeps the default for an unrecognised BOT_SOCIAL', async () => {
		for (const value of GARBAGE) {
			const c = await loadConfig({ BOT_SOCIAL: value });
			expect(c.social, `BOT_SOCIAL=${JSON.stringify(value)}`).toBe(true);
		}
	});

	it('reads PROVIDER_TEST_ALLOW_PRIVATE, defaulting off', async () => {
		for (const value of TRUE_VALUES) {
			const c = await loadConfig({ PROVIDER_TEST_ALLOW_PRIVATE: value });
			expect(c.providerTestAllowPrivate, `PROVIDER_TEST_ALLOW_PRIVATE=${JSON.stringify(value)}`).toBe(
				true
			);
		}
		for (const value of [...FALSE_VALUES, ...GARBAGE]) {
			const c = await loadConfig({ PROVIDER_TEST_ALLOW_PRIVATE: value });
			expect(c.providerTestAllowPrivate, `PROVIDER_TEST_ALLOW_PRIVATE=${JSON.stringify(value)}`).toBe(
				false
			);
		}
	});
});

describe('config: blank strings', () => {
	it('treats a blank endpoint as unset and strips trailing slashes otherwise', async () => {
		for (const value of ['', '   ', '/']) {
			const c = await loadConfig({ LLM_BASE_URL: value });
			expect(c.baseUrl, JSON.stringify(value)).toBe('https://openrouter.ai/api/v1');
		}
		expect((await loadConfig({ LLM_BASE_URL: 'http://x/v1///' })).baseUrl).toBe('http://x/v1');
	});

	it('keeps a usable name and data directory', async () => {
		// An empty USER_NAME makes every "@bot" look like a ping for the user,
		// and an empty DATA_DIR makes the boot-time mkdir fail.
		expect((await loadConfig({ USER_NAME: '  ' })).userName).toBe('you');
		expect((await loadConfig({ DATA_DIR: '' })).dataDir).toBe('./data');
		expect((await loadConfig({ DATA_DIR: ' /tmp/obl ' })).dataDir).toBe('/tmp/obl');
	});

	it('keeps the empty-by-design strings empty', async () => {
		// No key, no password gate and no fixed session secret are documented
		// states, so these must not be invented. The model is the exception: it
		// has a real default so a fresh install has something to call.
		const c = await loadConfig({
			LLM_API_KEY: '',
			LLM_MODEL: '',
			APP_PASSWORD: '',
			SESSION_SECRET: ''
		});
		expect(c.apiKey).toBe('');
		expect(c.model).toBe('deepseek/deepseek-v4.1-flash');
		expect(c.password).toBe('');
		expect(c.sessionSecret).toBe('');
	});
});

describe('config: applyOverrides', () => {
	// Overrides mutate the singleton, so each case starts from a fresh module.
	async function loadModule() {
		const config = await loadConfig();
		const { applyOverrides } = await import('./config');
		return { config, applyOverrides };
	}

	it('applies the toggles the settings table stores', async () => {
		const { config: c, applyOverrides } = await loadModule();
		applyOverrides({ social: 'false', social_interval_min: '30', default_model: 'm-2' });
		expect(c.social).toBe(false);
		expect(c.socialIntervalMin).toBe(30);
		expect(c.model).toBe('m-2');
		applyOverrides({ social: 'true' });
		expect(c.social).toBe(true);
	});

	it('ignores an unusable interval rather than resetting it', async () => {
		const { config: c, applyOverrides } = await loadModule();
		c.socialIntervalMin = 45;
		for (const value of ['4', 'abc', '', undefined]) {
			applyOverrides({ social_interval_min: value as string });
			expect(c.socialIntervalMin, String(value)).toBe(45);
		}
	});

	it('leaves unset keys alone', async () => {
		const { config: c, applyOverrides } = await loadModule();
		applyOverrides({});
		expect(c.social).toBe(true);
		expect(c.socialIntervalMin).toBe(60);
		expect(c.model).toBe('deepseek/deepseek-v4.1-flash');
	});
});
