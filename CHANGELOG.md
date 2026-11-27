# Changelog

## 0.4.26 — 2026-11-27

### Testing

- The mid-stream timeout test now aborts a controlled deadline only after its first visible token, avoiding a 1ms race on slower CI workers.

## 0.4.25 — 2026-11-27

### Fixes

- Short acknowledgements now receive last-turn app guidance that takes precedence over unrelated memories and old tasks; incomplete fragments get one short clarification.

### Testing

- Added regression cases for `okz`, `k.`, `plz`, and `i would quite like` app guidance.

## 0.4.24 — 2026-11-27

### Fixes

- Short acknowledgements now have a 12-word reply cap; bots acknowledge `okz`/`k.` without probing and ask one brief question for `plz` or another incomplete request.
- Bots no longer add unsolicited explanations about pending tasks, threads or missing context when responding to fragments.

### Testing

- Strengthened system-prompt regression coverage with the exact live-tested acknowledgement examples.

## 0.4.23 — 2026-11-27

### Fixes

- Short acknowledgements and incomplete fragments now get explicit guidance to reply briefly, ask one concise clarification, and avoid guessing at missing context or starting unrequested work.

### Testing

- Added the owner's terse-message and pasted local-model `curl` examples to tool-gating regression coverage.

## 0.4.22 — 2026-11-27

### Fixes

- Automatic specialist routing ignores generic answer and quote-framing language, so instructions like "compute this; treat the quoted string as data" do not trigger an unrelated hand-off. Topic-specific and explicit routing still work.

### Testing

- The archive-vote failure test now creates its own eligible no-voter instead of relying on bots left by earlier tests, so shuffled test order is stable.

## 0.4.21 — 2026-11-27

### Fixes

- Browser access is no longer part of the broad extended-tool bundle. It is offered for explicit web work, while pasted `curl`/HTTP API examples and quoted instructions stay data.
- Browser navigation refuses non-HTTP(S) URLs, file links and redirects are blocked, and screenshots fail closed if any browser page cannot be verified as HTTP(S).
- Memory compaction now uses row order to fold older messages that share a millisecond with the newest user message, avoiding repeated summaries of the same burst.

## 0.4.10 — 2026-11-27

### Fixes

- Bots in a group task with named assignments now receive only their own section plus the shared constraints, while the shared transcript remains unchanged. This keeps smaller models on their assigned role.

## 0.4.9 — 2026-11-27

### Fixes

- A group message that directly addresses one bot by name no longer gets handed to a different specialist based only on topic keywords.
- The claims-vs-calls check no longer treats passive action verbs in fictional descriptions as unbacked tool claims; first-person action claims remain checked.

### Testing

- Reset the summarizer and personality mocks between memory tests so randomized test ordering cannot reuse stale provider responses.

## 0.4.8 — 2026-11-27

### Fixes

- Chat-only bots no longer receive onboarding text that claims they have a computer, get machine lifecycle instructions, or see computer and machine setup tools. Their prompt now clearly states they cannot run commands; terminal-only bots are described accurately, and the computer tool refuses chat-only calls even if one is submitted directly.

## 0.4.7 — 2026-11-26

### Fixes

- Lounge and pub turns now use the configured provider model when the separate social model is blank or retains the legacy `free` alias. DeepSeek had rejected `free` as an invalid model, leaving social rounds with only their opening message.

## 0.4.6 — 2026-11-26

### Fixes

- A group message naming two bots ("Maple, meet Pip: each of you…") no longer counts as a delegation ask: name-mention made delegation decisive, so the asker handed its own introduction to the other bot, who answered in the asker's name and poisoned the thread's history. The delegation preamble also now names the target as itself.

## 0.4.5 — 2026-11-26

### Fixes

- Token accounting no longer re-bills seeded history: pi replays seeded messages through `message_end` with zeroed usage, and the runner estimated the whole history for each one (a 1k-token call billed ~18k; a live one-line turn dropped 69,903 → 7,730 input tokens after the fix). Cached tokens are also no longer counted twice across the pi bridge. Per-bot token totals recorded before this fix remain overstated.

### Performance

- Every turn diets to the core 29 tools unless the ask names an extended need (previously only private rooms dieted): ~5.5k schema tokens saved on every provider call of an ordinary turn, pinned by a budget test. Ask-first entry points (`request_debug_access`, `request_thinking`) stay in the core set.

## 0.4.4 — 2026-11-26

### Fixes

- Retry empty provider completions even when the provider reports `stop`. This prevents the bot wizard from returning blank drafts when a reasoning model emits no visible text on its first attempt.

## 0.4.3 — 2026-11-26

### Fixes

- Reasoning models now retry truncated short answers with more room, including partial text and JSON. This keeps compact bots from returning blank replies or cut-off structured output.
- Provider checks rerun when the URL, model, or key changes, and ignore responses from older checks. A malformed HTTP 200 no longer counts as a working provider.
- Provider connection probes allow enough output budget for reasoning models.

### Testing and docs

- Isolate shared fixtures so the shuffled test suite remains order-independent.
- Document `PROVIDER_TEST_ALLOW_PRIVATE` and its LAN-access implications for local model checks.

## 0.4.2 — 2026-11-26

### Security

- Pin the Pi coding-agent dependency tree to `minimatch` 11.0.1, fixing the glob-part amplification advisory (GHSA-g3hv-75wg-m249). The Pi code uses the named `minimatch()` API retained by v11.

## 0.4.1 — 2026-11-26

### Fixes

- Routine runs now carry their routine ID, so a webhook or clock tick cannot start a duplicate while the same routine is still running after its prompt has been edited.

## 0.4.0 — 2026-11-26

### Features

- **Voice (phase 1):** server-side text-to-speech through a Wyoming Piper server (`POST /api/tts` → WAV). The read-aloud button prefers it and falls back to the browser's speech synthesis; microphone input already existed.
- **Forgejo connector** in the Marketplace: repos, branches, commits, issues read/write, pulls read/create/merge, CI runs and releases, with the token stored encrypted and a settings picker for the default repo.
- **Routine webhooks:** each routine can have one inbound token URL that runs it now (created/revoked in the Screen routines tab). A fire that finds the routine already running rides that run instead of starting a second turn.

### Fixes

- Streaming replies render markdown live in the typing bubble, and the view follows the bubble as it grows (the follow effect fired once, stranding readers below the fold).
- Interface sounds rebuilt as enveloped sines through a lowpass — no square-wave buzz — plus a Settings mute.
- Tailscale connector needs only its auth key; the tailnet name is optional.
- Machine first-boot toolset install retries 5× against the egress-proxy sidecar race; police draft parser tolerates `**KEYWORD**` replies; the personless-bot police DM is created when missing.

### Operations

- Image publish cross-builds on the native platform (a QEMU arm64 Vite build hung for 6h); production dependencies still resolve per target platform. CI jobs now time out in 10/20/45 minutes instead of the 6h default.
- Proxmox agent lab connector removed from the Marketplace (SSH-key route lives on separately); installed copies keep working.
- Dependency guardrails as a lockfile-reading test (`deps-audit.test.ts`, salvaged from the H4 PR).

## 0.3.0 — 2026-11-25

### Dependency upgrades

In-range upgrades plus security pins. Verified: `npm run check` (0 errors),
`npm test` (1257 passed), `npm run build`.

| Package | From | To |
|---------|------|-----|
| `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` | 1.4.0 | 1.4.0 (held — see below) |
| `@humanspeak/svelte-markdown` | 2.1.3 | 2.3.0 |
| `@sveltejs/kit` | 2.70.3 | 2.70.4 |
| `@sveltejs/adapter-node` | 5.5.7 | 5.5.8 |
| `@sveltejs/vite-plugin-svelte` | 7.3.1 | 7.3.2 |
| `@types/node` | 26.6.5 | 26.6.10 |
| `svelte` | 5.57.2 | 5.59.1 |
| `svelte-check` | 4.7.7 | 4.7.8 |
| `vite` | 8.3.5 | 8.3.8 |
| `vitest` | 5.0.5 | 5.1.2 |
| `cookie` (new pin + override) | transitive <0.7.0 | 0.7.2 |
| `deepmerge` (new pin + override) | transitive | 4.3.1 |
| `undici` (new pin + override) | transitive | 8.13.1 |

### Deliberately not upgraded

- **`@earendil-works/pi-ai` / `pi-coding-agent` 1.5–1.6** — 1.6 removes the `Type`/`TSchema` exports `pi-bridge.ts` uses and hangs 88 agent-loop tests (tasks, runner, budgets, llm). Held on exact `1.4.0`; the 1.6 migration is a code-adaptation job, not a bump.
- **`@sveltejs/kit` 3.x**, **`@sveltejs/adapter-node` 6.x**, **`typescript` 7.x** — as in 0.2.0 (kit 3 needs the `$lib` → `#lib` migration).

### Advisories

- Cleared the `cookie` line via the 0.7.2 override.
- **4 remain** (1 low, 2 moderate, 1 high): the kit GHSA set and bundled `minimatch`, all fixable only via the breaking upgrades above.

### Also in this release

- Machine first-boot toolset install retries 5× (egress proxy race).
- Police draft parser tolerates `**DESCRIPTION**` / `**PERSONA**` markers; personless-bot police DM is created, not dropped.
- Install guide: systemd route documents the Docker engine, `EnvironmentFile`, and DeepSeek.
- CI: gitleaks image pull retries 5× against ghcr.io TLS flakes.

## 0.2.0 — 2026-10-22

### Dependency upgrades

Two-pass upgrade: patch/minor within current majors, then major bumps with code adaptation.

| Package | From | To |
|---------|------|-----|
| `@earendil-works/pi-ai` | 0.85.1 | 1.4.0 |
| `@earendil-works/pi-coding-agent` | 0.85.1 | 1.4.0 |
| `@humanspeak/svelte-markdown` | 1.9.0 | 2.1.3 |
| `@sveltejs/kit` | 2.16.0 | 2.70.3 |
| `@sveltejs/adapter-node` | 5.2.12 | 5.5.7 |
| `@sveltejs/vite-plugin-svelte` | 5.0.3 | 7.3.1 |
| `@types/node` | 24.x | 26.6.5 |
| `svelte` | 5.19.0 | 5.57.2 |
| `svelte-check` | 4.1.4 | 4.7.7 |
| `typescript` | 5.7.3 | 5.9.3 |
| `vite` | 6.0.11 | 8.3.5 |
| `vitest` | 5.0.0 | 5.0.5 |
| `highlight.js` | 11.11.1 | 11.12.0 |

### Deliberately not upgraded

- **`@sveltejs/kit` 3.x** — requires replacing `$lib` with `#lib` and explicit module extensions across the app (~161 files), plus TypeScript 6; would be a full-app migration, not a dependency bump.
- **`@sveltejs/adapter-node` 6.x** — peers `@sveltejs/kit` 3.x.
- **`typescript` 7.x** — left on 5.9.x; `svelte-check` and the current SvelteKit 2 tree do not require TS 7.

### Advisories

- Resolved **vite** / `launch-editor` high-severity issues by moving to Vite 8.
- Resolved **undici** issues bundled with older `@earendil-works/pi-coding-agent` by upgrading to 1.4.0.
- **3 low** remain on `@sveltejs/kit` / `@sveltejs/adapter-node` (upstream); upgrading to kit 3 would be required to clear them.

### Runtime / tooling

- Added `engines.node` `>=24` (aligned with `Dockerfile` `node:24-slim` and CI `node-version: 24`).

### Code changes (pi 1.x / Vite 8)

- `TranscriptContext` + `normalizeContext` for provider streaming; tool declarations via `getCurrentTools` / `collapseSystemMessages`.
- Agent loop: `finishTurn` replaces `shouldStopAfterTurn`; transcript seeding via `prompt(piContext.messages)`; tool-retry `continue()` guard for system-only transcripts.
- `package.json` `overrides` pins nested `@sveltejs/vite-plugin-svelte` to v7 for Vite 8.

### Verification

- `npm ci`, `npm run check` (0 errors), `npm test` (1251 passed), `npm run build` — passed on this runner.
- **Docker image build/smoke** — not run here (Docker unavailable in this environment). CI `publish` job builds and pushes `ghcr.io/jr551/openbotlounge` on tag push.
