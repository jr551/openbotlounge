/**
 * The seam between OpenBotLounge and the pi SDK
 * (@earendil-works/pi-coding-agent + @earendil-works/pi-ai).
 *
 * 1. Provider seam. `registerLoungeProvider` maps the app's provider config
 *    (`providerConfig()` in db.ts: settings table over LLM_* env) onto the
 *    shared `ModelRuntime` via `registerProvider`. The registered provider's
 *    `streamSimple` delegates to the app's own `streamChat`, which owns the
 *    wire call (pi-ai's openai-completions / openai-codex-responses
 *    adapters), the retry policy, and the truncated-reply contract - so the
 *    agent loop and every direct caller share one transport, and tests that
 *    mock `streamChat` intercept the loop's calls too.
 *
 * 2. Tool seam. `loungeTools` wraps the app's ToolDef catalogue as pi
 *    `defineTool` definitions (a JSON-schema -> TypeBox converter) that
 *    delegate to `executeTool`, so the real dispatch - DB writes, relay,
 *    machine calls - runs unchanged inside pi's agent loop.
 *
 * 3. Session seam. `createLoungeSession` builds a per-turn AgentSession with
 *    no built-in tools, no file persistence, and no extension/skill
 *    discovery - just the app's system prompt, the app's tools, and the
 *    app's provider.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ModelRuntime,
	type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
	Type,
	type Api,
	type AssistantMessage,
	type Context,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type TSchema,
	type TranscriptContext,
	type Usage
} from '@earendil-works/pi-ai';
import {
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	withoutInitialSystemMessage
} from '@earendil-works/pi-ai/utils/transcript';
import { parseOAuthSession, providerConfig } from './db';
import { LOUNGE_PROVIDER_ID, loungeRuntime } from './pi-runtime';
import { streamChat, textOf, type ChatMessage, type StreamResult, type ToolDef } from './llm';
import { executeTool, toolResultForContext, type ToolContext } from './tools';
import { executePlugin } from './plugins';
import { redactSecrets } from './secrets';

export { LOUNGE_PROVIDER_ID, loungeRuntime };

export interface LoungeProviderResult {
	/** The registered model to hand to createAgentSession. */
	model: Model<string>;
	/** 'codex' when the app is signed in with OpenAI OAuth, else 'openai'. */
	kind: 'openai' | 'codex';
	baseUrl: string;
}

/**
 * Register the app's configured provider on `runtime` and return the model a
 * session should use. Re-registration merges over the previous config, so a
 * per-turn call is cheap and picks up settings changes.
 *
 * - No OAuth session: `api: 'openai-completions'` against `baseUrl` with the
 *   configured key as a bearer token.
 * - OAuth session (Sign in with OpenAI): `api: 'openai-codex-responses'`
 *   against the Codex backend; the stored `provider_api_key` (the access
 *   token) is the apiKey, and refresh maps to
 *   `runtime.setRuntimeApiKey(LOUNGE_PROVIDER_ID, next)` - llm.ts's
 *   refreshProvider already does this after persisting the rotated token.
 *
 * `streamSimple` routes the loop's model calls through the app's streamChat:
 * one transport implementation, one retry policy, and the test seam stays
 * exactly where the suite already mocks it.
 */
export function registerLoungeProvider(
	runtime: ModelRuntime,
	overrides: { baseUrl?: string; apiKey?: string; model?: string } = {},
	turnSignal?: AbortSignal
): LoungeProviderResult {

	const cfg = providerConfig();
	const session = parseOAuthSession(cfg.oauth);
	const baseUrl = (overrides.baseUrl ?? cfg.baseUrl).replace(/\/+$/, '');
	const apiKey = overrides.apiKey ?? cfg.apiKey;
	// pi's api adapters refuse an empty key ("No API key for provider") where
	// the app happily calls a keyless local endpoint. pi-ai's own convention
	// for this is the literal placeholder "unused" - a Bearer header a keyless
	// endpoint ignores.
	const effectiveKey = apiKey || 'unused';
	const modelId = overrides.model || 'default';
	const codex = session !== null;
	runtime.registerProvider(LOUNGE_PROVIDER_ID, {
		name: 'OpenBotLounge provider',
		baseUrl,
		apiKey: effectiveKey,
		api: codex ? 'openai-codex-responses' : 'openai-completions',
		// The turn's signal is bound per registration rather than read from a
		// shared slot, so two turns running at once each see their own.
		streamSimple: (m, c, o) => loungeStream(m, c, o, turnSignal),
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: true,
				input: ['text', 'image'],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 32_000
			}
		]
	});
	const model = runtime.getModel(LOUNGE_PROVIDER_ID, modelId);
	if (!model) throw new Error('registered model not found');
	return { model, kind: codex ? 'codex' : 'openai', baseUrl };
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

/** The app's TokenUsage as a pi Usage for the assistant message record. */
function piUsageOf(result: StreamResult): Usage {
	const u = result.usage;
	if (!u) return emptyUsage();
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		totalTokens: u.input + u.output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost ?? 0 }
	};
}

/** A pi context message as the app's ChatMessage - the inverse of llm.ts's
 * piContext, so history the loop built round-trips faithfully. */
export function toChatMessage(m: Context['messages'][number]): ChatMessage {
	if (m.role === 'toolResult') {
		return {
			role: 'tool',
			tool_call_id: m.toolCallId,
			content: m.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
		};
	}
	if (m.role === 'assistant') {
		const text = m.content
			.filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
			.map((c) => c.text)
			.join('');
		const calls = m.content.filter(
			(c): c is Extract<typeof c, { type: 'toolCall' }> => c.type === 'toolCall'
		);
		return {
			role: 'assistant',
			content: text,
			...(calls.length
				? {
						tool_calls: calls.map((c) => ({
							id: c.id,
							type: 'function' as const,
							function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
						}))
					}
				: {})
		};
	}
	// user
	if (typeof m.content === 'string') return { role: 'user', content: m.content };
	return {
		role: 'user',
		content: m.content.map((c) =>
			c.type === 'text'
				? ({ type: 'text' as const, text: c.text })
				: ({
						type: 'image_url' as const,
						image_url: {
							url: c.data.startsWith('data:') ? c.data : `data:${c.mimeType};base64,${c.data}`
						}
					})
		)
	};
}

/**
 * The provider's streamSimple: drive the app's streamChat and re-emit its
 * deltas and result as pi assistant-message events. A truncated streamChat
 * result becomes an 'error' event whose message still carries the partial
 * text - the runner reads that as the app's truncated-reply case, and the
 * loop never executes tool calls off it.
 */
function loungeStream(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	turnSignal?: AbortSignal
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const messages: ChatMessage[] = [];
	const collapsed = collapseSystemMessages(context);
	const systemPrompt = getCurrentSystemPrompt(collapsed.messages);
	if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
	for (const m of withoutInitialSystemMessage([...collapsed.messages])) {
		messages.push(toChatMessage(m));
	}
	const tools: ToolDef[] = getCurrentTools(collapsed.messages).map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters as Record<string, unknown>
		}
	}));
	const effort = options?.reasoning;
	const partial: AssistantMessage = {
		role: 'assistant',
		content: [{ type: 'text', text: '' }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: 'stop',
		timestamp: Date.now()
	};
	void (async () => {
		stream.push({ type: 'start', partial });
		try {
			const gen = streamChat({
				model: model.id,
				messages,
				tools: tools.length ? tools : undefined,
				// The run's own signal (session.abort) plus the turn's: the
				// wire call dies on either, and a caller holding the signal it
				// was handed sees the turn's abort on it.
				signal:
					options?.signal && turnSignal
						? AbortSignal.any([options.signal, turnSignal])
						: (options?.signal ?? turnSignal),
				effort: effort === 'low' || effort === 'high' ? effort : undefined,
				// The registered model's endpoint, not the settings lookup: a
				// session registered with a different baseUrl or key (a test's
				// fake provider, an operator override) must reach that endpoint.
				endpoint: {
					baseUrl: model.baseUrl,
					apiKey: options?.apiKey ?? '',
					codex: model.api === 'openai-codex-responses'
				}
			});
			let result: StreamResult | undefined;
			for (;;) {
				const next = await gen.next();
				if (next.done) {
					result = next.value;
					break;
				}
				const textBlock = partial.content[0];
				if (textBlock.type === 'text') textBlock.text += next.value;
				stream.push({ type: 'text_delta', contentIndex: 0, delta: next.value, partial });
			}
			const content: AssistantMessage['content'] = [];
			if (result?.text) content.push({ type: 'text', text: result.text });
			for (const call of result?.toolCalls ?? []) {
				let args: JsonObject = {};
				try {
					const parsed: unknown = JSON.parse(call.function.arguments || '{}');
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						args = parsed as JsonObject;
					}
				} catch {
					// Unparseable arguments cannot be replayed faithfully.
				}
				content.push({
					type: 'toolCall',
					id: call.id,
					name: call.function.name,
					arguments: args
				});
			}
			const message: AssistantMessage = {
				...partial,
				content,
				usage: piUsageOf(result ?? { text: '', toolCalls: [] }),
				stopReason: result?.truncated
					? 'error'
					: content.some((c) => c.type === 'toolCall')
						? 'toolUse'
						: 'stop',
				errorMessage: result?.truncated ? result.error || 'provider stream truncated' : undefined,
				responseModel: result?.servedModel
			};
			if (result?.truncated) {
				stream.push({ type: 'error', reason: 'error', error: message });
			} else {
				stream.push({
					type: 'done',
					reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
					message
				});
			}
		} catch (e) {
			const message: AssistantMessage = {
				...partial,
				stopReason: options?.signal?.aborted ? 'aborted' : 'error',
				errorMessage: e instanceof Error ? e.message : String(e)
			};
			stream.push({
				type: 'error',
				reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
				error: message
			});
		}
	})();
	return stream;
}

/** The app's JSON-schema tool parameters as a TypeBox schema. The catalogue
 * only uses object/string/number/boolean/array shapes with string enums. */
function toTypeBox(schema: unknown): TSchema {
	const s = (schema ?? {}) as Record<string, unknown>;
	const opts: Record<string, unknown> = {};
	if (typeof s.description === 'string') opts.description = s.description;
	if (s.default !== undefined) opts.default = s.default;
	if (Array.isArray(s.enum)) {
		return Type.Union(
			s.enum.map((v) => Type.Literal(v as string)),
			opts
		);
	}
	switch (s.type) {
		case 'string':
			return Type.String({
				...opts,
				...(typeof s.pattern === 'string' ? { pattern: s.pattern } : {})
			});
		case 'number':
		case 'integer':
			return Type.Number(opts);
		case 'boolean':
			return Type.Boolean(opts);
		case 'array':
			return Type.Array(toTypeBox(s.items), opts);
		case 'object': {
			if (s.properties && typeof s.properties === 'object') {
				const required = new Set(Array.isArray(s.required) ? s.required : []);
				const props: Record<string, TSchema> = {};
				for (const [key, value] of Object.entries(s.properties)) {
					const prop = toTypeBox(value);
					props[key] = required.has(key) ? prop : Type.Optional(prop);
				}
				return Type.Object(props, opts);
			}
			return Type.Record(Type.String(), Type.Any(), opts);
		}
		default:
			return Type.Any(opts);
	}
}

/**
 * Wrap one app tool as a pi ToolDefinition. Execution delegates to the app's
 * `executeTool`, so every behaviour the dispatch owns (validation, DB writes,
 * relay, redaction inside the tool) is unchanged.
 */
function loungeTool(def: ToolDef, ctx: ToolContext): ToolDefinition {
	return defineTool({
		name: def.function.name,
		label: def.function.name,
		description: def.function.description,
		parameters: toTypeBox(def.function.parameters),
		// Bot tools mutate shared state (memories, relays, machines); run them
		// one at a time like the app's own loop does.
		executionMode: 'sequential',
		execute: async (toolCallId, params, signal) => {
			// Plugin tools dispatch to executePlugin, the rest to executeTool -
			// the same split the old loop made. Every result is masked before it
			// reaches the model: a plugin runs with the bot's secrets in reach,
			// and read_file/read_lines/grep_files hand back whatever a file
			// holds, so a secret pasted into a note must not ride into the
			// provider's logs from any of them.
			const raw = redactSecrets(
				ctx.senderBotId,
				def.function.name.startsWith('plugin_')
					? await executePlugin(ctx.senderBotId, def.function.name, JSON.stringify(params))
					: await executeTool(def.function.name, JSON.stringify(params), {
							...ctx,
							signal: signal ?? ctx.signal
						})
			);
			// A long answer is stashed and paged rather than poured into the
			// context whole: the model gets the first chunk and the way to ask
			// for more, while the tray's tool event keeps the full text.
			return {
				content: [{ type: 'text', text: toolResultForContext(toolCallId, raw) }],
				details: { output: raw }
			};
		}
	});
}

/**
 * The app's tool catalogue as pi customTools. `defs` is the slice the runner
 * already selected for this turn (toolsForTurn), so the allowlist logic stays
 * app-side.
 */
export function loungeTools(ctx: ToolContext, defs: ToolDef[]): ToolDefinition[] {
	return defs.map((d) => loungeTool(d, ctx));
}

export interface PiSessionOptions {
	model: Model<string>;
	modelRuntime: ModelRuntime;
	/** The bot's persona/system prompt - what buildHistory puts at index 0. */
	systemPrompt: string;
	customTools?: ToolDefinition[];
	/** Tool allowlist; defaults to every custom tool. */
	tools?: string[];
	/** The app's effort knob as a pi thinking level. */
	thinkingLevel?: 'low' | 'high';
	/** Force SSE for the Codex adapter (its default 'auto' tries websockets first). */
	transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto';
}

/**
 * One bot turn through pi: an AgentSession with no built-in tools, no file
 * persistence, no extension/skill discovery - just the app's system prompt,
 * the app's tools, and the app's provider.
 */
// Sessions are per-turn but nothing they do touches disk: one shared pair of
// throwaway dirs serves them all rather than littering /tmp per reply.
let sessionDirs: { cwd: string; agentDir: string } | undefined;

export async function createLoungeSession(opts: PiSessionOptions): Promise<{
	session: AgentSession;
}> {
	sessionDirs ??= {
		cwd: mkdtempSync(join(tmpdir(), 'obl-pi-cwd-')),
		agentDir: mkdtempSync(join(tmpdir(), 'obl-pi-agent-'))
	};
	const { cwd, agentDir } = sessionDirs;
	const settingsManager = SettingsManager.inMemory(
		opts.transport ? { transport: opts.transport } : {}
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: opts.systemPrompt
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: opts.model,
		modelRuntime: opts.modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
		customTools: opts.customTools,
		// Only the wrapped app tools are exposed - none of pi's coding tools.
		tools: opts.tools ?? (opts.customTools ?? []).map((t) => t.name)
	});
	if (opts.thinkingLevel) session.setThinkingLevel(opts.thinkingLevel);
	return { session };
}
