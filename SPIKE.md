# pi SDK spike — OpenBotLounge

Bounded proof-of-concept for swapping the hand-rolled agent loop
(`runner.ts:runBotTurn` → `llm.ts:streamChat` → `tools.ts:executeTool`) onto
`@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` (0.85.1).

Artifacts:

- `src/lib/server/pi-bridge.ts` — the seam adapter: `createLoungeRuntime()`,
  `registerLoungeProvider()`, `loungeTools()`, `createLoungeSession()`.
- `src/lib/server/pi-spike.test.ts` — vitest proofs for both seams (3 tests).
- `scripts/pi-spike.ts` — standalone driver; bundle then run:

  ```
  npx esbuild scripts/pi-spike.ts --bundle --platform=node --format=esm \
    --packages=external --alias:'$lib'=./src/lib --outfile=node_modules/.cache/pi-spike.mjs
  node node_modules/.cache/pi-spike.mjs [--codex]
  ```

## 1. Provider seam — WORKS

`ModelRuntime.registerProvider(id, { baseUrl, apiKey, api, models })` accepts
the app's `providerConfig()` output verbatim. Evidence:

- **Arbitrary baseUrl + key** (`openai-completions`): the test registers a
  provider pointed at a local mock and `session.prompt()` completes a streamed
  reply. The mock records `POST /v1/chat/completions` with
  `Authorization: Bearer <key>` and `model`/`stream` in the body. The script
  prints the same against the app's real `providerConfig()`.
- **Codex OAuth** (`openai-codex-responses`): pi-ai ships a first-class Codex
  adapter. With the app's OAuth state seeded (`provider_oauth` +
  `provider_api_key` = JWT access token), the request lands on
  `POST {baseUrl}/responses` with `chatgpt-account-id` (derived from the JWT —
  the same value llm.ts sends from `OAuthSession.account_id`),
  `OpenAI-Beta: responses=experimental`, `store:false`, `stream:true`. Token
  refresh maps to `runtime.setRuntimeApiKey()` after `refreshOpenAiTokens()`.
  Caveat: the adapter defaults to `transport: "auto"` (websocket first, SSE
  fallback); the app's implementation is SSE-only, so set
  `SettingsManager.inMemory({ transport: 'sse' })` or accept the fallback.
  Real-account verification needs live ChatGPT credentials — the wire shape
  is proven, the credential acceptance is not.
- **Keyless endpoints**: pi's api adapters throw `No API key for provider` on
  an empty key where the app calls Ollama bare. pi-ai's own convention is the
  literal `"unused"` placeholder; `registerLoungeProvider` applies it.
- **Model catalogue**: `models` is a static array in the provider config;
  `refreshModels` can call the app's `listModels()` for dynamic lists.

## 2. Tool seam — WORKS

`defineTool` takes TypeBox `parameters` and an `execute(toolCallId, params,
signal, onUpdate, ctx)` returning `{ content: [{type:'text',text}], details }`.
`loungeTools()` wraps `shell_exec`, `remember`, `send_message` delegating to
the real `executeTool` with the app's `ToolContext` (relay/runComputer injected
by the caller exactly as runner.ts does).

Evidence (`pi-spike.test.ts`, scripted `fauxProvider` driving a real
`createAgentSession` + `session.prompt()`): three tool calls across two model
round-trips all dispatched — `remember` wrote `bot_memories` in the real DB,
`shell_exec` reached the machine layer, `send_message` ran the injected relay
and logged the relay row. `tool_execution_start/end` events fired in order.
`executionMode: 'sequential'` reproduces the app's serial tool execution.

Schema translation is mechanical: OpenAI JSON-schema → TypeBox. ~50 tools is
bulk work, not a design problem (a `ToolDef`→TypeBox converter is feasible
since the app's schemas are plain object/string/enum shapes).

## 3. What does NOT map cleanly

| App concern | pi seam | Verdict |
|---|---|---|
| `maxTurnsPerTask` | No config knob. Count `turn_end` events via `session.subscribe` and call `session.abort()`; or `AgentToolResult.terminate`/`tool_call` handler `terminate:true`. | App-side loop around events — works, but the stop reason ('turns'/'tokens'/'time') must be tracked by us. |
| `maxTokensPerTask` | `message_end`/`turn_end` carry `message.usage` (real tokens, better than the app's chars/4 estimate). Sum and `abort()`. | Same — app-side accounting. |
| `taskTimeoutMs` | `AbortSignal.timeout` into `session.abort()`; pi threads `signal` into provider calls and tool `execute`. | Clean. |
| Secret redaction on tool results | `tool_result` extension event can rewrite `content` before it enters context; or redact inside each wrapped `execute` (what the spike does — `executeTool` already redacts internally for shell_exec). | Seam exists; safest is keeping redaction inside `executeTool` (already true) plus a `tool_result` belt. |
| Jail checks | `before_agent_start` extension hook can inject/refuse; or keep the guard in the caller before `session.prompt()`. | Clean — stays app-side. |
| Delegation (tryDelegate keyword scan) | Runs before the model call; stays app-side, calls the target's `session.prompt()`. | No pi involvement needed. |
| Police mini-review | `maybeRequestMiniReview` lives in the relay callback and message ingest, not the loop. | No pi involvement needed. |
| Per-turn history rebuild from DB (notes/feedback/compaction) | `SessionManager.inMemory()` + fresh session per turn, or `agent.state.messages` seeding; `before_agent_start` can inject a custom message; `context` event can rewrite the message list pre-call. pi also has its own compaction (`compact()`, `session_before_compact` hook) which could replace `maybeSummarize`. | Seam exists; the app's buildHistory stays the source of truth. |
| SSE tray events (`TurnEvent`) | `session.subscribe` gives `turn_start`, `message_update` (text deltas), `tool_execution_start/update/end`, `message_end`, `agent_end` — a superset of the app's `TurnEvent` union. | Maps 1:1, richer. |
| `noTools` turns / tool-diet (private rooms) | `tools: []` allowlist per session, or `session.setActiveTools([...])` per turn. | Clean. |
| Effort knob (`low`/`high`) | `thinkingLevel` on the session/model (`thinkingLevelMap` per model). | Maps, with per-model clamping. |
| Retry policy (`llmRetryAttempts`) | `SettingsManager` provider retry settings (`maxRetries`, `maxRetryDelayMs`, `timeoutMs`). | Maps. |
| `streamChat` mid-stream retry / truncation salvage | pi-ai has its own retry + `isRetryableAssistantError`; the app's "keep partial text on wire cut" semantics differ (pi marks `stopReason:'error'`). | Partial — behavior differs; needs an adapter decision. |
| `servedModel` / cost accounting | `AssistantMessage.model` + `usage.cost` on every `message_end`. | Maps, better than app's estimate. |
| Plugin tools (`plugin_*`, `executePlugin`) | Same `defineTool` wrapper as built-ins. | Clean. |
| `use_computer` sub-agent | A second `createAgentSession` with the computer toolset, driven by the `use_computer` tool's `execute` — mirrors `runComputerTask`. | Clean. |

**No seam found for:** nothing load-bearing. The only real gaps are (a) budget
stops are app-side accounting + `abort()` rather than config, and (b) pi's
stream-failure semantics differ from the app's partial-reply salvage.

## Recommendation: GO

Both risky seams prove out. The provider seam is the stronger result than
expected — Codex OAuth is a first-class pi api (`openai-codex-responses`), not
a custom `streamSimple` hack, and the app's stored access token drops straight
in. The tool seam is a mechanical TypeBox wrap of `executeTool`.

Suggested swap shape: keep `buildHistory`, `executeTool`, budgets, jail,
delegation, police, and SSE fan-out app-side; replace the `runStep`/tool-loop
core of `runBotTurn` with a per-turn `AgentSession` (in-memory SessionManager,
custom `ResourceLoader` carrying the persona prompt, `customTools` =
`loungeTools(ctx)`, `tools:` allowlist = `toolsForTurn` selection). Budget
enforcement wraps `session.subscribe` + `session.abort()`.

Risks to carry into the refactor: pi session/agent lifecycle per turn (one
session per turn vs. pooled), the partial-reply semantics difference, and
websocket-vs-SSE transport choice for Codex.

## 3. The swap as it landed (pi-runtime branch)

The recommended shape held. What the refactor actually did:

- **Provider**: `registerLoungeProvider` registers the app's endpoint on the
  shared `ModelRuntime` (`pi-runtime.ts`) with a custom `streamSimple` that
  delegates to `streamChat` - one transport, one retry policy, and the ~1000
  tests that mock `streamChat` intercept the agent loop's calls unchanged.
  The turn's AbortSignal is bound per registration, not via module state.
- **Tools**: `loungeTools(ctx, defs)` wraps the whole catalogue through a
  JSON-schema -> TypeBox converter; `execute` delegates to `executeTool` /
  `executePlugin` with `redactSecrets` and `toolResultForContext` paging
  exactly as the old loop did. Unknown tools are answered by pi's dispatch
  ("Tool X not found") instead of reaching `executeTool`.
- **Loop**: `runBotTurn` drives a per-turn `AgentSession`
  (`createLoungeSession`): in-memory SessionManager, ResourceLoader carrying
  the persona prompt, customTools = the wrapped catalogue, allowlist =
  `toolsForTurn` + plugin + debug tools. History is seeded onto
  `session.agent.state.messages` and the system prompt onto
  `state.systemPrompt` (the resource loader would otherwise append a
  cwd line pointing at a throwaway dir).
- **Budgets**: `shouldStopAfterTurn` consults `spentBudget()` after each
  step; `message_end` events feed `account()` with real `message.usage`
  (estimated when the provider reports none); the deadline signal aborts
  the run. `stoppedBy` reasons ('turns'/'tokens'/'time'/'truncated') are
  preserved.
- **Events**: `session.subscribe` maps `message_update` text deltas to
  `onDelta`, `tool_execution_*` to the app's TurnEvent union, `turn_end`
  to step counting and history append. The SSE tray is unchanged.
- **Partial replies**: a truncated `streamChat` result becomes an 'error'
  event whose message still carries the partial text; the runner keeps the
  accumulated text and reports `stoppedBy: 'truncated'` - the app's
  salvage semantics preserved deliberately.
- **Tool-support retry**: a provider that rejects tools gets one retry
  without them via `session.agent.continue()` after stripping the failed
  message and clearing `state.tools`.
- **use_computer**: kept app-side - `ctx.runComputer` still calls
  `runComputerTask` (computer-agent.ts unchanged). A nested session would
  have meant a second provider registration and event plumbing for no
  behaviour change.
- **pi-memory**: not wired into bot sessions. pi-memory@0.4.2 resolves its
  directory from `process.env.PI_MEMORY_DIR` once at module scope
  (`resolveMemoryDir`), so a per-bot dir would be process-global state
  racing across concurrent turns. It stays wired only for the external omp
  client (pi-memory branch), where one process is one bot.

Test-seam notes: the codex adapter needs `response.output_item.added`
frames before `output_text.delta` (slot-keyed accumulation), tool call ids
arrive as `<call_id>|<item_id>`, and the wire path is
`<base>/codex/responses`. llm.test.ts's fake provider was updated to match.
