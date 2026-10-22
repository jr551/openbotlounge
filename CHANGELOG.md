# Changelog

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
