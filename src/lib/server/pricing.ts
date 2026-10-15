import { listSettings, parseOAuthSession, providerConfig, setSetting, type Task } from './db';
import { complete } from './llm';
import { costOf, type ModelPricing } from '../pricing';

export { costOf, formatCost, resolveModel } from '../pricing';
export type { ModelPricing, TokenTotals } from '../pricing';

/** How long a successful /models listing is trusted before it is fetched again. */
const TTL_MS = 10 * 60_000;
/**
 * How long a failed fetch is remembered. The chat header asks for prices on
 * every render, so an unreachable endpoint must not be retried per render.
 */
const FAIL_TTL_MS = 60_000;
/** The listing is small but the endpoint can be slow; do not hang a page on it. */
const TIMEOUT_MS = 10_000;

/** One entry of the provider's /models payload, as far as pricing is concerned. */
interface ModelEntry {
	id?: string;
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
	};
}

let cached: {
	baseUrl: string;
	at: number;
	byId: Map<string, ModelPricing>;
	ok: boolean;
} | null = null;
let inflight: { baseUrl: string; promise: Promise<Map<string, ModelPricing>> } | null = null;

/**
 * Parse one model's pricing object. The provider sends per-token costs as
 * strings, and a blank or missing field means "not priced" rather than zero -
 * a model priced on one side only cannot be costed honestly, so it is treated
 * as unpriced rather than half-priced.
 */
function parsePricing(raw: ModelEntry['pricing']): ModelPricing | null {
	const num = (v: unknown) => {
		if (typeof v !== 'string' || v.trim() === '') return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	};
	const prompt = num(raw?.prompt);
	const completion = num(raw?.completion);
	if (prompt === undefined || completion === undefined) return null;
	return { prompt, completion, cacheRead: num(raw?.input_cache_read) ?? 0 };
}

/** Fetch and parse the provider's /models listing. Throws on a bad response. */
async function fetchPricing(baseUrl: string, apiKey: string): Promise<Map<string, ModelPricing>> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await fetch(`${baseUrl}/models`, {
		headers,
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`models endpoint answered ${res.status}`);
	const data = (await res.json()) as { data?: ModelEntry[] };
	const byId = new Map<string, ModelPricing>();
	for (const m of data.data ?? []) {
		if (!m?.id) continue;
		const p = parsePricing(m.pricing);
		if (p) byId.set(m.id, p);
	}
	return byId;
}

/**
 * Per-token prices for every model the provider lists, keyed by model id.
 *
 * The listing is cached: the chat header prices a bot on every render, and the
 * endpoint must not be hit for each one. A failed fetch keeps the last good
 * listing when it came from the same endpoint, and is retried after a short
 * backoff, so an unreachable provider degrades to "no price" rather than an
 * error or a blank header.
 */
export async function modelPricing(): Promise<Map<string, ModelPricing>> {
	const cfg = providerConfig();
	// The Codex backend an OAuth sign-in calls has no /models listing, so there
	// is nothing to price against.
	if (parseOAuthSession(cfg.oauth)) return new Map();
	if (cached && cached.baseUrl === cfg.baseUrl) {
		const ttl = cached.ok ? TTL_MS : FAIL_TTL_MS;
		if (Date.now() - cached.at < ttl) return cached.byId;
	}
	if (!inflight || inflight.baseUrl !== cfg.baseUrl) {
		inflight = {
			baseUrl: cfg.baseUrl,
			promise: fetchPricing(cfg.baseUrl, cfg.apiKey)
				.then((byId) => {
					cached = { baseUrl: cfg.baseUrl, at: Date.now(), byId, ok: true };
					return byId;
				})
				.catch(() => {
					const byId =
						cached?.baseUrl === cfg.baseUrl
							? cached.byId
							: new Map<string, ModelPricing>();
					cached = { baseUrl: cfg.baseUrl, at: Date.now(), byId, ok: false };
					return byId;
				})
				.finally(() => {
					inflight = null;
				})
		};
	}
	return inflight.promise;
}

// ---- Researched prices ----

/**
 * A price the provider never reported. When a served model is absent from the
 * provider's priced /models listing, the police research the going market
 * rate once and cache it under `price_research` (a JSON map of model id to
 * per-token USD). The human's own figure always wins: `price_overrides` is
 * the same map, set through the settings route or the police console, and an
 * override is never re-researched.
 */

/** One settings map of model id to per-token USD prices; bad entries are skipped. */
function priceMap(key: string): Map<string, ModelPricing> {
	const out = new Map<string, ModelPricing>();
	try {
		const raw = JSON.parse(listSettings()[key] ?? '{}') as Record<string, unknown>;
		for (const [id, v] of Object.entries(raw)) {
			const p = v as { prompt?: unknown; completion?: unknown; cacheRead?: unknown };
			const prompt = Number(p?.prompt);
			const completion = Number(p?.completion);
			if (Number.isFinite(prompt) && Number.isFinite(completion)) {
				out.set(id, { prompt, completion, cacheRead: Number(p?.cacheRead) || 0 });
			}
		}
	} catch {
		// A malformed settings blob is no prices, never a crash.
	}
	return out;
}

/**
 * The best per-token price available for a model the provider reported no
 * bill for: the human's override first, then the provider's own /models
 * listing, then the researched figure. `listed` is the map modelPricing()
 * returns, passed in so a caller pricing many models fetches it once.
 */
export function estimatePricing(
	model: string,
	listed: Map<string, ModelPricing>
): ModelPricing | null {
	return (
		priceMap('price_overrides').get(model) ??
		listed.get(model) ??
		priceMap('price_research').get(model) ??
		null
	);
}

/**
 * One model's share of a bot's spend: the tasks it served, their tokens, the
 * provider's own bill where it named a price, and the estimate against the
 * best known rate where it did not. `cost` is null when no task in the group
 * was priced, `estimated_cost` null when no unpriced task has a rate to
 * estimate against - so "not priced" never reads as $0.
 */
export interface ModelSpend {
	model: string;
	tasks: number;
	tokens_in: number;
	tokens_out: number;
	cost: number | null;
	estimated_cost: number | null;
}

/**
 * Group a bot's tasks by the model that served them and price each group.
 * `modelOf` resolves a task to its model (see taskModels in db.ts); the
 * provider's /models listing is fetched once and shared by every estimate.
 * Rows are ordered by what is known about them: provider-priced spend first,
 * then estimated, then unpriced.
 */
export async function costBreakdown(
	tasks: Task[],
	modelOf: (t: Task) => string
): Promise<{ total: number | null; estimated: number | null; byModel: ModelSpend[] }> {
	const listed = await modelPricing();
	const groups = new Map<string, ModelSpend>();
	for (const t of tasks) {
		const model = modelOf(t);
		const g =
			groups.get(model) ??
			groups
				.set(model, {
					model,
					tasks: 0,
					tokens_in: 0,
					tokens_out: 0,
					cost: null,
					estimated_cost: null
				})
				.get(model)!;
		g.tasks++;
		g.tokens_in += t.tokens_in;
		g.tokens_out += t.tokens_out;
		if (t.cost !== null) {
			g.cost = (g.cost ?? 0) + t.cost;
		} else {
			const p = estimatePricing(model, listed);
			if (p) {
				g.estimated_cost =
					(g.estimated_cost ?? 0) +
					costOf(p, { input: t.tokens_in, output: t.tokens_out, cacheRead: t.cache_read });
			}
		}
	}
	const byModel = [...groups.values()].sort(
		(a, b) => (b.cost ?? -1) - (a.cost ?? -1) || (b.estimated_cost ?? -1) - (a.estimated_cost ?? -1)
	);
	return {
		total: byModel.some((m) => m.cost !== null)
			? byModel.reduce((n, m) => n + (m.cost ?? 0), 0)
			: null,
		estimated: byModel.some((m) => m.estimated_cost !== null)
			? byModel.reduce((n, m) => n + (m.estimated_cost ?? 0), 0)
			: null,
		byModel
	};
}

/**
 * What the market charges for one model, as a per-token price. The public
 * OpenRouter listing is the lookup: it is the same shape the provider's own
 * /models endpoint speaks, so one parser serves both. A model it does not
 * list falls back to asking the model itself for its going rate - a rough
 * figure, but an estimate the readout marks as such rather than nothing.
 */
async function marketPrice(model: string, askModel: string): Promise<ModelPricing | null> {
	try {
		const res = await fetch('https://openrouter.ai/api/v1/models', {
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (res.ok) {
			const data = (await res.json()) as { data?: ModelEntry[] };
			const entry = (data.data ?? []).find((m) => m.id === model);
			const priced = parsePricing(entry?.pricing);
			if (priced) return priced;
		}
	} catch {
		// The listing being unreachable falls through to the model's own answer.
	}
	try {
		const reply = await complete(askModel, [
			{
				role: 'user',
				content:
					`What is the current market price per token in USD for the model "${model}"? ` +
					'Reply with JSON only: {"prompt": <per-token input price>, "completion": <per-token output price>}. ' +
					'If you do not know, reply {}.'
			}
		]);
		const parsed = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
			prompt?: unknown;
			completion?: unknown;
		};
		const prompt = Number(parsed.prompt);
		const completion = Number(parsed.completion);
		if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt > 0 && completion > 0) {
			return { prompt, completion, cacheRead: 0 };
		}
	} catch {
		// No answer is no price: the readout stays unpriced rather than guessed.
	}
	return null;
}

/**
 * The police's price research, run once per round: every model a bot was
 * actually served that the provider does not price and nobody has a figure
 * for gets one lookup, and the answer is cached. A model the lookup could not
 * price is not written, so a later round may try again - but a priced one is
 * never re-researched, and the human's override is never touched.
 */
export async function researchMissingPrices(servedModels: string[], askModel: string): Promise<void> {
	if (!servedModels.length) return;
	const listed = await modelPricing();
	const known = new Map([...priceMap('price_research'), ...priceMap('price_overrides')]);
	const missing = [...new Set(servedModels)].filter((m) => m && !listed.has(m) && !known.has(m));
	if (!missing.length) return;
	const researched = priceMap('price_research');
	const found: Record<string, ModelPricing> = {};
	for (const model of missing) {
		const price = await marketPrice(model, askModel);
		if (price) {
			researched.set(model, price);
			found[model] = price;
		}
	}
	if (Object.keys(found).length) {
		setSetting('price_research', JSON.stringify(Object.fromEntries(researched)));
	}
}
