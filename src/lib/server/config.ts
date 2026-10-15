/**
 * OpenRouter is the default provider. It needs no pasted key - the app signs in
 * over OAuth - so a fresh install with no `.env` has a working provider rather
 * than a dead local endpoint, and `providerForBaseUrl` resolves this back to the
 * OpenRouter entry in the picker.
 */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * The default driver model, qualified for the default provider. DeepSeek v4.1
 * Flash is what this deployment is tuned for. A model set in `LLM_MODEL`, or
 * saved as the `default_model` setting, wins over this.
 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * A blank env var counts as unset. docker-compose forwards `${VAR:-}` as an
 * empty string, and a whitespace-only value is a typo rather than a setting.
 */
function envText(raw: string | undefined, fallback: string): string {
	return raw?.trim() || fallback;
}

/**
 * Numeric env vars. A blank, unparseable or out-of-range value falls back to
 * the default: `Number('')` is 0, `Number('abc')` is NaN and `Number('1e999')`
 * is Infinity, and at the call sites a NaN or Infinity ceiling reads as "no
 * ceiling at all", silently lifting the limit it was meant to impose.
 */
function envNumber(raw: string | undefined, fallback: number, min: number): number {
	// Number('') is 0, so a blank var would read as a real value wherever the
	// floor allows zero - an unset knob must fall back like a garbage one.
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= min ? value : fallback;
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Boolean env vars accept `true/1/yes/on` and `false/0/no/off` in any case.
 * Anything else is a typo and keeps the default - reading every value except
 * the exact string "false" as true would turn `BOT_SOCIAL=0` on.
 */
function envBool(raw: string | undefined, fallback: boolean): boolean {
	const value = raw?.trim().toLowerCase() ?? '';
	if (TRUE_VALUES.has(value)) return true;
	if (FALSE_VALUES.has(value)) return false;
	return fallback;
}

/** Any OpenAI-compatible chat-completions endpoint. */
export const config = {
	/** e.g. https://api.x.ai/v1, http://ollama:11434/v1, https://openrouter.ai/api/v1 */
	baseUrl:
		envText(process.env.LLM_BASE_URL, DEFAULT_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL,
	apiKey: process.env.LLM_API_KEY ?? '',
	/** Fallback model when the provider has no /models endpoint or none is picked. */
	model: envText(process.env.LLM_MODEL, DEFAULT_MODEL),
	/** Optional shared-password gate. Empty = no auth. */
	password: process.env.APP_PASSWORD ?? '',
	/** Secret for signing the session cookie. Defaults to a per-boot random value. */
	sessionSecret: process.env.SESSION_SECRET ?? '',
	dataDir: envText(process.env.DATA_DIR, './data'),
	/** Cap on messages sent to the provider per request (0 = unlimited). */
	maxHistory: envNumber(process.env.MAX_HISTORY_MESSAGES, 60, 0),
	/** Model round-trips allowed in one turn; each tool round-trip is one. */
	maxTurnsPerTask: envNumber(process.env.LLM_MAX_TURNS, 8, 1),
	/** Rough spend ceiling per turn: streamed characters / 4 (no tokeniser). A
	 * turn that delegates to a sub-agent re-sends the growing history every
	 * step - ~15k input per call with the full tool catalogue - so 60k was
	 * about four steps; 200k leaves room for a real task. */
	maxTokensPerTask: envNumber(process.env.LLM_MAX_TOKENS_PER_TASK, 200_000, 1),
	/** Wall-clock ceiling for one turn, ms. */
	taskTimeoutMs: envNumber(process.env.LLM_TASK_TIMEOUT_MS, 300_000, 1),
	/**
	 * How many times a provider call is retried after it fails, and how long to
	 * wait between tries. A rate-limit storm is the one failure an operator can
	 * do nothing about from inside the app, so the policy is a setting rather
	 * than a constant: a provider that throttles hard wants a longer wait, and
	 * one that is merely flaky wants more tries. Worst case is the product of
	 * the two, which is why the defaults are modest.
	 */
	llmRetryAttempts: envNumber(process.env.LLM_RETRY_ATTEMPTS, 5, 0),
	llmRetryIntervalMs: envNumber(process.env.LLM_RETRY_INTERVAL_MS, 5_000, 0),
	/** Let bots chat among themselves on a schedule ("social" mode). */
	social: envBool(process.env.BOT_SOCIAL, true),
	/**
	 * Let the Test-connection button probe a loopback/LAN address. Off by
	 * default: the probe runs in this process, so an open one is an SSRF into
	 * the metadata service or a LAN box. A self-hosted install whose provider
	 * is a local model server turns it on; an exposed one leaves it off.
	 */
	providerTestAllowPrivate: envBool(process.env.PROVIDER_TEST_ALLOW_PRIVATE, false),
	/** The user's name, used to detect @mentions that should ping them. */
	userName: envText(process.env.USER_NAME, 'you'),
	/** Minutes between autonomous bot-to-bot chats. */
	socialIntervalMin: envNumber(process.env.BOT_SOCIAL_MINUTES, 60, 5)
};

/**
 * Persisted settings (edited from the UI) override the environment defaults.
 * Applied at boot from the `settings` table - without this, a toggle made in
 * the UI silently reverts on restart and bots resume chatting on their own.
 */
export function applyOverrides(overrides: Record<string, string>): void {
	if (overrides.social === 'true' || overrides.social === 'false') {
		config.social = overrides.social === 'true';
	}
	const interval = Number(overrides.social_interval_min);
	if (Number.isFinite(interval) && interval >= 5) config.socialIntervalMin = interval;
	if (overrides.default_model) config.model = overrides.default_model;
}
