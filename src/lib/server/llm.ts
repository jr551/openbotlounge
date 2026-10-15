import { streamSimple as streamOpenAiCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamCodexResponses } from '@earendil-works/pi-ai/api/openai-codex-responses';
import type { AssistantMessage, Context, Model, Tool, Usage } from '@earendil-works/pi-ai';
import { config } from './config';
import { parseOAuthSession, providerConfig, setSetting } from './db';
import { refreshOpenAiTokens } from './provider-oauth';
import { providerForBaseUrl } from '../providers';
import { LOUNGE_PROVIDER_ID, loungeRuntime } from './pi-runtime';

/** One content part: plain text or an image reference (data URI or URL). */
export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ContentPart[];
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

/** The plain text of a message's content, whatever shape it arrived in. */
export function textOf(content: ChatMessage['content']): string {
	if (typeof content === 'string') return content;
	return content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface ToolDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface ModelEntry {
	id: string;
}

/**
 * Hard ceiling on a single provider call. Without it a stalled socket hangs the
 * caller forever - and because the scheduler clears its `running` guard in a
 * `finally`, one hung call silences every routine, wake and social tick.
 */
const PROVIDER_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

/** Combine the caller's abort signal with a timeout. */
function signalFor(external?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
	return external ? AbortSignal.any([external, timeout]) : timeout;
}

/**
 * Retry a provider call on the failures worth retrying: 429 rate limits, 5xx
 * and network drops. The policy is `config.llmRetryAttempts` retries, each a
 * flat `config.llmRetryIntervalMs` after the one before - five retries five
 * seconds apart by default, so a provider that is refusing connections or
 * answering 5xx costs a turn up to 25 seconds of waiting before the failure
 * reaches the user. That worst case is the number worth knowing, because it is
 * time the reader spends watching nothing happen, and it is why the two
 * settings are read together rather than tuned apart.
 *
 * A 4xx that is not a rate limit is the request's own fault and fails at once;
 * so does the caller's abort. This retries the request only: a stream that
 * dies after the headers arrived is not retried here, because the body is
 * already in the caller's hands.
 */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
	// Read per call, not at module load: the policy is a setting, and a storm is
	// exactly when an operator wants to change it without a redeploy.
	const attempts = config.llmRetryAttempts;
	const interval = config.llmRetryIntervalMs;
	let lastErr: unknown;
	// retry 0 is the first try; 1..attempts are the retries.
	for (let retry = 0; retry <= attempts; retry++) {
		try {
			const res = await fetch(url, init);
			if (res.ok || !RETRYABLE.has(res.status) || retry === attempts) {
				return res;
			}
			// Drain the body so the socket can be reused, then wait out the interval.
			await res.text().catch(() => {});
		} catch (e) {
			lastErr = e;
			// The caller's own abort is not a retryable failure.
			if (init.signal?.aborted) throw e;
			if (retry === attempts) throw e;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, interval);
		await promise;
	}
	throw lastErr;
}

/**
 * Strip anything credential-shaped out of text that will reach a client: a
 * configured provider key that has been echoed back, and any bare bearer token.
 */
export function redactCredentials(text: string): string {
	const cfg = providerConfig();
	let out = text;
	for (const k of [config.apiKey, cfg.apiKey]) {
		if (k && k.length >= 8) out = out.split(k).join('[redacted]');
	}
	// A refresh token is as spendable as the access token it mints.
	const refresh = parseOAuthSession(cfg.oauth)?.refresh_token ?? '';
	if (refresh.length >= 8) out = out.split(refresh).join('[redacted]');
	return out.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/g, 'Bearer [redacted]');
}

function headers(apiKey: string): Record<string, string> {
	const h: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) h.Authorization = `Bearer ${apiKey}`;
	return h;
}

/** What a call needs beyond the endpoint: the OAuth session it authenticates with. */
interface ResolvedEndpoint {
	baseUrl: string;
	apiKey: string;
	/** Set when the provider signs in through OAuth rather than a pasted key. */
	oauth?: { accountId: string };
}

/** Refreshes already in flight, so two calls share one round-trip instead of
 * racing a rotating refresh token. */
let refreshing: Promise<void> | null = null;

/** Refresh window: a token this close to expiry is treated as already dead. */
const REFRESH_AHEAD_MS = 60_000;

/**
 * Swap the provider's expiring access token for a fresh one and persist
 * whatever OpenAI returned - including a rotated refresh token. A dead session
 * leaves the stale token in place so the provider's own 401 explains the
 * failure.
 */
async function refreshProvider(): Promise<void> {
	const session = parseOAuthSession(providerConfig().oauth);
	if (!session) return;
	const tokens = await refreshOpenAiTokens(session.refresh_token);
	if (!tokens) return;
	setSetting('provider_api_key', tokens.accessToken);
	setSetting(
		'provider_oauth',
		JSON.stringify({
			refresh_token: tokens.refreshToken,
			account_id: tokens.accountId || session.account_id,
			expires_at: tokens.expiresAt
		})
	);
	// Keep the pi runtime's credential in step so sessions that resolve auth
	// through it see the fresh token too. Best-effort: the wire key comes from
	// the settings row either way.
	void loungeRuntime()
		.then((runtime) => runtime.setRuntimeApiKey(LOUNGE_PROVIDER_ID, tokens.accessToken))
		.catch(() => {});
}

/**
 * The endpoint a call actually goes through. For an OAuth sign-in this may
 * refresh the access token first, which is why it is async.
 */
async function resolveEndpoint(): Promise<ResolvedEndpoint> {
	const cfg = providerConfig();
	const session = parseOAuthSession(cfg.oauth);
	if (!session) return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey };
	if (Date.now() >= session.expires_at - REFRESH_AHEAD_MS) {
		refreshing ??= refreshProvider().finally(() => {
			refreshing = null;
		});
		await refreshing;
	}
	const fresh = providerConfig();
	return {
		baseUrl: fresh.baseUrl,
		apiKey: fresh.apiKey,
		oauth: { accountId: session.account_id }
	};
}

/**
 * The model the provider is asked for when a caller does not name one.
 * `config.model` is the env value with the saved `default_model` setting
 * applied on top at boot, so this is always the model the endpoint serves.
 */
export function defaultModel(): string {
	return config.model;
}

/**
 * List models from the provider's /models endpoint; falls back to the
 * configured model. Concurrent callers share one fetch: a route that needs the
 * list to validate input and the /api/models page can both be waiting when the
 * provider is slow, and each would otherwise open its own request against it.
 * `signal` bounds the wait for callers that must answer promptly; it is
 * combined with the provider ceiling, not a replacement for it.
 */
let modelsInFlight: Promise<string[]> | null = null;
let modelsCache: { baseUrl: string; ids: string[] } | null = null;

export function listModels(signal?: AbortSignal): Promise<string[]> {
	const cfg = providerConfig();
	// The Codex backend an OAuth sign-in calls has no /models listing; the
	// catalogue's list for that endpoint is the honest answer, with the
	// configured model first.
	if (parseOAuthSession(cfg.oauth)) {
		const ids = (providerForBaseUrl(cfg.baseUrl)?.models ?? []).slice();
		if (config.model && !ids.includes(config.model)) ids.unshift(config.model);
		return Promise.resolve(ids);
	}
	// A different endpoint's list is no answer for this one.
	const cached = modelsCache?.baseUrl === cfg.baseUrl ? modelsCache.ids : null;
	modelsInFlight ??= fetchModelIds(cfg)
		.then((ids) => {
			// Only a real answer is cached: a failed fetch keeps the last good
			// list so a provider outage does not blank the picker. The
			// configured model stands in when nothing has ever answered.
			if (ids) modelsCache = { baseUrl: cfg.baseUrl, ids };
			return ids ?? cached ?? (config.model ? [config.model] : []);
		})
		.finally(() => {
			modelsInFlight = null;
		});
	// The shared fetch keeps running for the other callers when one gives up.
	if (!signal) return modelsInFlight;
	return Promise.race([
		modelsInFlight,
		new Promise<string[]>((_, reject) => {
			if (signal.aborted) reject(signal.reason ?? new Error('aborted'));
			else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
		})
	]);
}

/** The /models round-trip; null when the endpoint could not answer a list. */
async function fetchModelIds(cfg: { baseUrl: string; apiKey: string }): Promise<string[] | null> {
	try {
		const res = await fetch(`${cfg.baseUrl}/models`, {
			headers: headers(cfg.apiKey),
			signal: signalFor()
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { data?: ModelEntry[] };
		const ids = (data.data ?? []).map((m) => m.id).filter(Boolean).sort();
		if (config.model && !ids.includes(config.model)) ids.unshift(config.model);
		return ids;
	} catch {
		return null;
	}
}

export interface StreamOptions {
	model: string;
	messages: ChatMessage[];
	signal?: AbortSignal;
	/**
	 * How hard the provider should think, where it supports the knob. 'high' is
	 * the maximum it offers; 'low' asks for the cheapest read. Unset asks for
	 * nothing at all, which leaves the provider's own default in place.
	 */
	effort?: 'low' | 'high';
	/** OpenAI-style tool definitions; omitted entirely when empty. */
	tools?: ToolDef[];
	/**
	 * The endpoint to call, bypassing the settings lookup. The agent loop's
	 * provider registration carries the endpoint it was configured with, so a
	 * session pointed at a different baseUrl than the saved settings still
	 * reaches it; OAuth refresh is skipped for an override because the
	 * caller's key is already the one it wants on the wire.
	 */
	endpoint?: { baseUrl: string; apiKey: string; codex?: boolean };
}

/**
 * What one provider call cost. `source` records how the numbers were obtained:
 * 'provider' is the API's own `usage` object, as measured; 'estimated' is the
 * characters-in, characters-out approximation used when it reports nothing.
 *
 * The cache fields are only ever provider-reported: `cacheRead` is prompt
 * tokens served from the provider's cache, `cacheWrite` is tokens written to
 * it, `cacheMiss` is prompt tokens the provider says missed (DeepSeek reports
 * the split; most providers only report the hits). `cacheReported` marks that
 * the provider sent cache fields at all - a 0 with the flag set is a real
 * miss, a 0 without it is a provider that does not say.
 */
export interface TokenUsage {
	input: number;
	output: number;
	source: 'provider' | 'estimated';
	cacheRead: number;
	cacheWrite: number;
	cacheMiss: number;
	cacheReported: boolean;
	/**
	 * What the provider says the call cost, in its own currency units, when it
	 * reports a price at all (OpenRouter's usage.cost). Undefined means it said
	 * nothing - never a zero, which would read as a measured free call.
	 */
	cost?: number;
}

/**
 * Tokens for a call the provider did not report: the prompt we sent and the
 * reply that came back, at ~4 characters per token.
 *
 * The tool definitions and any tool calls count too. They are not decoration -
 * every call carries the whole tool catalogue (several kilobytes of names,
 * descriptions and schemas) and a tool-using turn puts arguments on the wire in
 * both directions. Counting only message text understated the bill for exactly
 * the bots that lean on tools, which is also the number the avatars, the gym and
 * the lounge roast are built from.
 */
export function estimateUsage(
	messages: ChatMessage[],
	reply: string,
	tools: ToolDef[] = [],
	toolCalls: ToolCall[] = []
): TokenUsage {
	let chars = 0;
	for (const m of messages) {
		chars += textOf(m.content).length;
		for (const call of m.tool_calls ?? []) chars += (call.function?.arguments ?? '').length;
	}
	for (const tool of tools) {
		chars += tool.function.name.length + tool.function.description.length;
		chars += JSON.stringify(tool.function.parameters ?? {}).length;
	}
	const replyChars =
		reply.length + toolCalls.reduce((n, c) => n + (c.function?.arguments ?? '').length, 0);
	// The ratio the turn budget assumes. Zero stays zero; any text at all rounds
	// to at least one token, because the call did spend something.
	const tokens = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n / 4)));
	return {
		input: tokens(chars),
		output: tokens(replyChars),
		source: 'estimated',
		// Estimates never invent cache numbers: a cache figure exists only when
		// the provider reported one.
		cacheRead: 0,
		cacheWrite: 0,
		cacheMiss: 0,
		cacheReported: false
	};
}

/**
 * A provider's own `usage` object, or null when it sent none. A provider that
 * reports only a total has it put against the reply: the prompt side is the
 * part we could have estimated anyway, and the reply is what varies.
 */
function reportedUsage(raw: unknown): TokenUsage | null {
	if (!raw || typeof raw !== 'object') return null;
	const u = raw as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
	const input = num(u.prompt_tokens);
	const output = num(u.completion_tokens);
	const total = num(u.total_tokens);
	// A provider that reports only a price still has something worth keeping:
	// the cost lands even when the token counts do not.
	const cost = num(u.cost) ?? num(u.total_cost);
	if (input === undefined && output === undefined && total === undefined && cost === undefined) {
		return null;
	}

	// Cache counters in every shape providers actually send. OpenAI nests the
	// read under prompt_tokens_details; DeepSeek splits the prompt into
	// hit/miss; Anthropic-shaped gateways pass cache_*_input_tokens through.
	const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const cacheRead =
		num(details.cached_tokens) ?? num(u.cache_read_input_tokens) ?? num(u.prompt_cache_hit_tokens);
	const cacheWrite = num(u.cache_creation_input_tokens);
	const cacheMiss = num(u.prompt_cache_miss_tokens);
	return {
		input: input ?? 0,
		output: output ?? Math.max(0, (total ?? 0) - (input ?? 0)),
		source: 'provider',
		cacheRead: cacheRead ?? 0,
		cacheWrite: cacheWrite ?? 0,
		cacheMiss: cacheMiss ?? 0,
		cacheReported:
			cacheRead !== undefined || cacheWrite !== undefined || cacheMiss !== undefined,
		...(cost !== undefined ? { cost } : {})
	};
}

export interface StreamResult {
	text: string;
	toolCalls: ToolCall[];
	/**
	 * The model the provider says it actually served, when it names one. The
	 * model the caller asked for is often an alias the provider's price list
	 * does not carry, so this is what a cost readout has to price against.
	 * Undefined when the provider reports no model, which leaves every caller
	 * on the model it asked for.
	 */
	servedModel?: string;
	/** The stream ended without a [DONE] frame: what arrived is a partial reply. */
	truncated?: boolean;
	/** The provider's own error when the stream died on one; undefined for a clean end. */
	error?: string;
	/**
	 * What the call cost. Always set by this module - measured when the provider
	 * reports `usage`, otherwise estimated from characters - but optional so a
	 * caller substituting its own generator need not invent numbers.
	 */
	usage?: TokenUsage;
}

/**
 * The Codex adapter never copies `response.model` onto the assistant message
 * the way openai-completions does, but the wire carries it on the
 * response.created/response.completed frames - and served_model drives cost
 * accounting, per-bot usage, and police pricing research. This wraps fetch so
 * the SSE body is teed: one branch feeds the adapter, the other is pumped in
 * the background just far enough to read the model name off those frames.
 */
function tapServedModel(fetchImpl: typeof fetch): {
	fetch: typeof fetch;
	servedModel: () => string | undefined;
} {
	let served: string | undefined;
	const wrapped: typeof fetch = async (input, init) => {
		const res = await fetchImpl(input, init);
		if (!res.body) return res;
		const [wire, tap] = res.body.tee();
		void (async () => {
			const reader = tap.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			try {
				for (;;) {
					const { done, value } = await reader.read();
					buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
					let idx = buf.indexOf('\n\n');
					while (idx !== -1) {
						const frame = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						for (const line of frame.split('\n')) {
							if (!line.startsWith('data:')) continue;
							try {
								const evt = JSON.parse(line.slice(5).trim()) as {
									type?: string;
									response?: { model?: unknown };
								};
								if (
									(evt.type === 'response.created' || evt.type === 'response.completed') &&
									typeof evt.response?.model === 'string'
								) {
									served = evt.response.model;
								}
							} catch {
								// A partial or non-JSON frame is not the model's name.
							}
						}
						idx = buf.indexOf('\n\n');
					}
					if (done) break;
				}
			} catch {
				// The tap is best-effort; a dead branch must not kill the wire.
			} finally {
				reader.releaseLock();
			}
		})();
		return new Response(wire, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers
		});
	};
	return { fetch: wrapped, servedModel: () => served };
}
/**
 * Stream a chat completion from any OpenAI-compatible endpoint.
 * Yields content deltas; returns assembled text plus any tool calls.
 *
 * A stream that dies after the headers arrived is retried under the same policy
 * as a failed request, but only while nothing has been yielded: see
 * `withStreamRetry`.
 */

export async function* streamChat(opts: StreamOptions): AsyncGenerator<string, StreamResult> {
	const endpoint = opts.endpoint
		? {
				baseUrl: opts.endpoint.baseUrl,
				apiKey: opts.endpoint.apiKey,
				oauth: opts.endpoint.codex ? { accountId: '' } : undefined
			}
		: await resolveEndpoint();
	const context = toPiContext(opts);
	// The app's model id rides on a Model whose api picks the wire adapter:
	// chat completions for a plain endpoint, the Codex responses adapter for an
	// OAuth sign-in. `provider` is the lounge id so runtime auth resolves.
	const model = {
		id: opts.model,
		name: opts.model,
		api: endpoint.oauth ? 'openai-codex-responses' : 'openai-completions',
		provider: LOUNGE_PROVIDER_ID,
		baseUrl: endpoint.baseUrl,
		reasoning: true,
		input: ['text', 'image'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		// The gateway fronts many providers; several (deepseek et al) 422 on the
		// 'developer' role the adapter prefers for reasoning models. 'system' is
		// the name every one of them accepts.
		compat: { supportsDeveloperRole: false }
	};
	// The codex adapter never surfaces the served model, so the SSE body is
	// teed and read for it; a plain endpoint's adapter reports it itself.
	const tap = endpoint.oauth ? tapServedModel(fetch) : undefined;
	const streamOpts = {
		apiKey: endpoint.apiKey || 'unused',
		signal: signalFor(opts.signal),
		// The app's effort knob is a thinking level; 'off' sends nothing.
		reasoning: opts.effort,
		// Codex only answers over SSE; the websocket transports are for the
		// first-party client.
		transport: 'sse' as const,
		// The adapter's own retry policy handles request-level failures; this
		// cap is removed so a provider's retry-after is honoured rather than
		// clamped.
		maxRetryDelayMs: 0,
		...(tap ? { fetch: tap.fetch } : {}),
		// The model needs to know it may call tools; without this it narrates
		// them as text instead of emitting real tool_calls deltas.
		toolChoice: opts.tools?.length ? ('auto' as const) : undefined
	};

	// The same retry policy the hand-rolled reader had: a stream that dies
	// before any delta reached the caller is retried; one that dies after is a
	// truncated reply, not a replay.
	const attempts = config.llmRetryAttempts;
	const interval = config.llmRetryIntervalMs;
	for (let retry = 0; ; retry++) {
		let text = '';
		let yielded = false;
		let failed: AssistantMessage | undefined;
		try {
			const stream = endpoint.oauth
				? streamCodexResponses(model as Model<'openai-codex-responses'>, context, streamOpts)
				: streamOpenAiCompletions(model as Model<'openai-completions'>, context, streamOpts);
			for await (const event of stream) {
				if (event.type === 'text_delta') {
					text += event.delta;
					yielded = true;
					yield event.delta;
				} else if (event.type === 'error') {
					failed = event.error;
				}
			}
			const message = await stream.result();
			// The tap read the served model off the wire frames the adapter
			// drops; a truncated reply keeps it too, since the reader paid for
			// the partial answer.
			message.responseModel ??= tap?.servedModel();
			if (message.stopReason === 'error' || message.stopReason === 'aborted') {
				failed ??= message;
			} else {
				return streamResult(opts, message, text);
			}
		} catch (e) {
			// A throw from the pump is the same class of death as an error event.
			failed ??= {
				role: 'assistant',
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: opts.signal?.aborted ? 'aborted' : 'error',
				errorMessage: e instanceof Error ? e.message : String(e),
				timestamp: Date.now()
			};
		}

		if (failed.stopReason === 'aborted' || opts.signal?.aborted) {
			throw new Error(failed.errorMessage || 'Provider stream aborted');
		}
		if (!yielded) {
			// Nothing reached the reader: a retry replays nothing anyone saw.
			if (retry === attempts) {
				throw new Error(redactCredentials(failed.errorMessage || 'Provider stream failed'));
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, interval);
			await promise;
			continue;
		}
		// Text already handed to the reader: keep it, flagged partial.
		return streamResult(opts, failed, text, true);
	}
}

/** A zeroed usage record for a message that never got one. */
function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
	};
}

/** The app's message list as a pi context: system text hoisted to the slot the
 * adapters expect, tool results carried as toolResult messages. */
export function toPiContext(opts: StreamOptions): Context {
	const system: string[] = [];
	const messages: Context['messages'] = [];
	for (const m of opts.messages) {
		if (m.role === 'system') {
			const text = textOf(m.content);
			if (text.trim()) system.push(text);
			continue;
		}
		if (m.role === 'tool') {
			messages.push({
				role: 'toolResult',
				toolCallId: m.tool_call_id ?? '',
				toolName: '',
				content: [{ type: 'text', text: textOf(m.content) }],
				isError: false,
				timestamp: Date.now()
			});
			continue;
		}
		if (m.role === 'assistant') {
			const content: AssistantMessage['content'] = [];
			const text = textOf(m.content);
			if (text) content.push({ type: 'text', text });
			for (const call of m.tool_calls ?? []) {
				let args: Record<string, unknown> = {};
				try {
					const parsed: unknown = JSON.parse(call.function.arguments || '{}');
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						args = parsed as Record<string, unknown>;
					}
				} catch {
					// Unparseable arguments cannot be replayed faithfully; an empty
					// object at least keeps the call's shape.
				}
				content.push({
					type: 'toolCall',
					id: call.id,
					name: call.function.name,
					arguments: args
				});
			}
			messages.push({
				role: 'assistant',
				content,
				api: 'openai-completions',
				provider: LOUNGE_PROVIDER_ID,
				model: opts.model,
				usage: emptyUsage(),
				stopReason: 'stop',
				timestamp: Date.now()
			});
			continue;
		}
		// user
		const content =
			typeof m.content === 'string'
				? [{ type: 'text' as const, text: m.content }]
				: m.content.map((p) => {
						if (p.type === 'text') return { type: 'text' as const, text: p.text };
						// pi's ImageContent.data is raw base64 - the adapters build the
						// data: URI themselves - so the app's image_url part, which
						// carries the whole URL, has to be unpacked. Anything that is
						// not a data: URL passes through as-is; the adapter will reject
						// it the same way it would reject bad base64.
						const url = p.image_url.url;
						const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
						return {
							type: 'image' as const,
							data: dataUrl ? dataUrl[3] : url,
							mimeType: (dataUrl && dataUrl[1]) || 'image/png'
						};
					});
		messages.push({ role: 'user', content, timestamp: Date.now() });
	}
	return {
		systemPrompt: system.join('\n\n') || undefined,
		messages,
		tools: (opts.tools ?? []).map(piTool)
	};
}

/** A ToolDef as a pi Tool: the JSON-schema parameters pass through as-is. */
function piTool(tool: ToolDef): Tool {
	return {
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters as Tool['parameters']
	};
}

/** Assemble the StreamResult the runner consumes from a pi assistant message. */
function streamResult(
	opts: StreamOptions,
	message: AssistantMessage,
	text: string,
	truncated = false
): StreamResult {
	// A reply that arrives whole on text_end - no deltas streamed - is still
	// the reply; the accumulated text is only empty because nothing streamed.
	if (!text) {
		text = message.content
			.filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
			.map((c) => c.text)
			.join('');
	}
	const toolCalls: ToolCall[] = message.content
		.filter((c): c is Extract<typeof c, { type: 'toolCall' }> => c.type === 'toolCall')
		.map((c) => ({
			id: c.id,
			type: 'function' as const,
			function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
		}));
	const usage = piTokenUsage(message.usage);
	// A model that hallucinates the tool-call syntax as text - `<tool_call>bash`
	// or `<tool_call>bash -c "..."` - is not making a real call; the text is
	// noise the user should not see. Strip it from the reply so the stored
	// message reads as the answer, not the model's own markup. The real tool
	// calls ride the `toolCalls` array, parsed by the adapter, not this text.
	// The body ends at the next `<tool_call>` marker, a `</tool_call>` closer,
	// or end-of-text - a closer's trailing text belongs to the reply.
	const clean = text
		.replace(/<tool_call>[\s\S]*?(?=<tool_call>|<\/tool_call>|$)/g, '')
		.replace(/<\/tool_call>/g, '')
		.trim();
	return {
		text: clean,
		toolCalls,
		servedModel: message.responseModel || undefined,
		truncated: truncated || undefined,
		error: truncated ? message.errorMessage || 'provider stream truncated' : undefined,
		usage: usage ?? estimateUsage(opts.messages, clean, opts.tools, toolCalls)
	};
}

/** A pi Usage as the app's TokenUsage; undefined when the provider reported
 * nothing, so the caller's estimate stands in. */
export function piTokenUsage(usage: Usage | undefined): TokenUsage | undefined {
	if (!usage) return undefined;
	if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return undefined;
	// pi's input is the uncached share of the prompt; the app's input is the
	// whole prompt, so the cache tokens are added back. A miss is that same
	// uncached share - but only when the provider reported cache fields at
	// all, since an unreported cache is not a measured miss.
	const cacheReported = usage.cacheRead > 0 || usage.cacheWrite > 0;
	return {
		input: usage.input + usage.cacheRead + usage.cacheWrite,
		output: usage.output,
		source: 'provider',
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cacheMiss: cacheReported ? usage.input : 0,
		cacheReported,
		...(usage.cost?.total ? { cost: usage.cost.total } : {})
	};
}

/**
 * One-shot completion (used for titles, memory jobs, and small judgements).
 * `opts.onUsage` receives what the call cost - measured when the provider
 * reports it, otherwise estimated - for callers that account for spend.
 */
export async function complete(
	model: string,
	messages: ChatMessage[],
	opts: {
		onUsage?: (usage: TokenUsage) => void;
		/**
		 * How hard the provider should think, where it supports the knob. 'high'
		 * is the maximum it offers - used where the answer is worth more than
		 * the tokens, like the pre-compaction summary and the police's calls.
		 */
		effort?: 'low' | 'high';
		/** Output ceiling for this one call; the default suits short replies. */
		maxTokens?: number;
		/**
		 * Bounds the call for a caller that must answer promptly - an HTTP
		 * route holding a response open. Combined with the provider ceiling,
		 * so the smaller of the two wins.
		 */
		signal?: AbortSignal;
	} = {}
): Promise<string> {
	const endpoint = await resolveEndpoint();
	if (endpoint.oauth) {
		// The Codex backend only streams, so a one-shot answer is a drained one.
		const gen = streamChat({ model, messages, effort: opts.effort, signal: opts.signal });
		let result: StreamResult | undefined;
		for (;;) {
			const next = await gen.next();
			if (next.done) {
				result = next.value;
				break;
			}
		}
		const text = (result?.text ?? '').trim();
		opts.onUsage?.(result?.usage ?? estimateUsage(messages, text));
		return text;
	}
	// A reasoning model can spend the whole token budget on hidden
	// reasoning_content and answer with finish_reason 'length' and empty
	// content - which callers read as a failed call. Retry that one case
	// without the effort knob: a truncated-but-nonempty answer is real output
	// and is returned as-is, but an empty one earned nothing.
	for (const effort of [opts.effort, undefined]) {
		const res = await fetchWithRetry(`${endpoint.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: headers(endpoint.apiKey),
			// Reasoning models spend part of this on hidden reasoning_content before
			// the visible answer; a small cap returns finish_reason 'length' with
			// empty content, which callers read as a failed call.
			body: JSON.stringify({
				model,
				messages,
				stream: false,
				max_tokens: opts.maxTokens ?? 4096,
				...(effort ? { reasoning_effort: effort } : {})
			}),
			signal: signalFor(opts.signal)
		});
		if (!res.ok) throw new Error(`Provider ${res.status}`);
		const data = await res.json();
		const text = (data.choices?.[0]?.message?.content ?? '').trim();
		const usage = reportedUsage(data.usage);
		// Some providers put the price beside the usage object rather than in it.
		const topCost = (data as Record<string, unknown>).cost;
		opts.onUsage?.(
			usage
				? usage.cost === undefined && typeof topCost === 'number' && Number.isFinite(topCost)
					? { ...usage, cost: topCost }
					: usage
				: // complete() sends no tools, so there are none to count on the way out.
					estimateUsage(messages, text, [], data.choices?.[0]?.message?.tool_calls ?? [])
		);
		if (text || data.choices?.[0]?.finish_reason !== 'length' || effort === undefined) {
			return text;
		}
	}
	return '';
}
