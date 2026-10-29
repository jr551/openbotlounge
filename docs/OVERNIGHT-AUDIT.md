# Overnight audit — openbotlounge

First pass: **2026-10-29** (branch `overnight`). Findings are ranked by severity for operator action. Exploit recipes are omitted on purpose; this document is safe to share in-repo.

## Summary

| Severity | Count | Fixed this pass |
|----------|------:|----------------:|
| Critical | 1 | 1 |
| High | 4 | 1 |
| Medium | 6 | 1 |
| Low | 8 | 0 |
| Info | — | — |

Screenshots from this pass: `docs/screenshots/overnight/desktop-home.png`, `docs/screenshots/overnight/mobile-home.png`.

---

## Critical

### C1 — Fork pull requests executed on self-hosted CI runners

**Area:** GitHub Actions (`.github/workflows/ci.yml`)

**Issue:** The `verify` and `secrets` jobs ran on `[self-hosted, supermicro-server]` for every `pull_request` event, including forks. A fork PR can run arbitrary code on the operator’s machine with access to the runner environment and any secrets exposed to those jobs.

**Fix (this pass):** Gate both jobs with  
`github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`.

**Test:** `src/lib/ci-workflow.test.ts`.

---

## High

### H1 — Federation outbound SSRF to private/link-local hosts

**Area:** `src/lib/server/federation.ts` (`postSigned`, `connectPeer`, `sendToPeer`)

**Issue:** After pasting a peer invite, the server POSTs to the invite’s `endpoint` from the app process. Before this pass, `http://127.0.0.1`, `http://169.254.169.254`, and LAN addresses were allowed, enabling SSRF against loopback services and cloud metadata when the UI is reachable by an attacker.

**Fix (this pass):** Resolve the endpoint hostname and refuse private/link-local targets unless `FED_ALLOW_PRIVATE=true` (for LAN-to-LAN pairing). Shared logic with provider connection tests via `isPrivateHost`.

**Test:** `src/lib/server/federation.test.ts` (`outbound SSRF guard`).

### H2 — No authentication by default

**Area:** `APP_PASSWORD` / `src/lib/server/auth.ts`, `src/hooks.server.ts`

**Issue:** Empty `APP_PASSWORD` disables the gate entirely (`validSession` always true). VNC relay, `/api/*`, and bot sandboxes are reachable to anyone on the network. Appropriate for a trusted LAN; dangerous if the port is exposed.

**Mitigation:** Set a strong `APP_PASSWORD` and `SESSION_SECRET` before any non-LAN exposure. README already warns; treat as deployment requirement, not a code default change.

### H3 — Webhook URLs are bearer tokens with no rate limit

**Area:** `/api/hooks/[token]`, `src/lib/server/webhooks.ts`

**Issue:** Knowledge of the UUID token allows unauthenticated POSTs (by design). There is no per-token rate limiting; a leaked URL enables spam turns and LLM spend.

**Mitigation:** Rotate/disable hooks in UI; network ACL; optional future work: rate limits and payload signing.

### H4 — Transitive dependency CVEs (undici, @sveltejs/kit, cookie, deepmerge)

**Area:** `package-lock.json`

**Issue:** `npm audit` reports high-severity undici issues and moderate SvelteKit/cookie/deepmerge advisories. Some fixes require major `@sveltejs/kit` upgrades.

**Mitigation:** Schedule dependency uplift on `overnight` with full test/build; monitor advisories. No silent `npm audit fix --force` without a migration plan.

---

## Medium

### M1 — Untrusted `X-Forwarded-Proto` affected session cookies and OAuth URLs

**Area:** `src/lib/server/http.ts` (`requestIsSecure`)

**Issue:** Any client could send `X-Forwarded-Proto: https` on a direct HTTP connection, marking session cookies `Secure` and breaking login on plain-HTTP LAN installs, or skewing OAuth callback scheme selection.

**Fix (this pass):** Honor `X-Forwarded-Proto` only when `TRUST_PROXY=true` (set behind a reverse proxy that strips spoofed headers).

**Test:** `src/lib/server/http.test.ts` (`requestIsSecure`).

### M2 — Ephemeral session signing key when `SESSION_SECRET` unset

**Area:** `src/lib/server/auth.ts`

**Issue:** Sessions invalidate on every process restart. Not a confidentiality bug, but operators may not expect mass logout after deploy.

**Mitigation:** Set persistent `SESSION_SECRET` in production.

### M3 — Cross-origin write protection is Origin-based, not CSRF tokens

**Area:** `src/hooks.server.ts`, `src/lib/server/http.ts`

**Issue:** Custom `isCrossOrigin` replaces SvelteKit CSRF (documented adapter-node HTTPS mismatch). Same-site attackers and some browser edge cases differ from double-submit cookie models.

**Note:** `scripts/verify-security.sh` covers foreign Origin POSTs; keep running after deploy changes.

### M4 — Federation and webhooks skip the Origin gate

**Area:** `src/hooks.server.ts`

**Issue:** Intentional: Ed25519 federation and hook tokens authenticate those paths. Risk is token/signature strength, not missing CSRF on browser forms.

### M5 — LLM prompt injection and tool abuse

**Area:** Police subsystem, plugins, webhooks, bot tools

**Issue:** Untrusted text enters model context (webhooks, peer messages, user chat). Police rules flag injection patterns; plugins run in gated paths. No guarantee against a determined prompt injection against capable models.

**Mitigation:** Treat as research software; restrict network; review police alerts; limit powerful plugins on exposed instances.

### M6 — SQLite and bot sandboxes share the host

**Area:** Docker machine isolation, `egress-proxy.mjs`

**Issue:** Bot containers are network-isolated with egress filtering; the app process still holds DB secrets and can reach loopback unless federation/provider guards apply. Defense in depth depends on auth + LAN trust.

---

## Low (UI / UX)

Reviewed against a local preview (`npm run preview` on port 4173). See screenshots under `docs/screenshots/overnight/`.

### U1 — Icon-only controls lack accessible names (desktop)

**Files:** `src/routes/+page.svelte`, `src/lib/components/Composer.svelte`

Header and composer actions rely on `title` only; screen readers get no consistent `aria-label`. Menu toggle missing `aria-expanded`.

### U2 — Sidebar search unlabeled

**File:** `src/lib/components/Sidebar.svelte`  
Mobile search already uses `aria-label="Search chats"`; desktop sidebar does not.

### U3 — Unread badges not exposed to assistive tech

**File:** `src/lib/components/Sidebar.svelte`  
Dot indicators have no text/ARIA equivalent.

### U4 — Mobile drawer does not inert the main thread

**Files:** `src/routes/+page.svelte`, contrast `src/lib/components/mobile/MobileApp.svelte`  
At ≤700px, overlay sidebar leaves `<main>` focusable/scrollable underneath.

### U5 — Tablet screen panel covers chat without dismiss scrim

**File:** `src/routes/+page.svelte` (`.screenwrap` @ max-width 1000px)  
340px panel overlays the thread; chat remains tappable behind it.

### U6 — Markdown autolink edge cases

**File:** `src/lib/markdown-guard.ts`  
Guard is strong for HTML in prose; operators should still treat bot output as untrusted when copying into other apps.

### U7 — Mobile cookie `secure: false`

**File:** `src/hooks.server.ts` (`MOBILE_COOKIE`)  
Intentional for HTTP LAN; document for HTTPS-only sites.

### U8 — Login page minimal error surfacing

**File:** `src/routes/login/+page.svelte`  
Failed login returns 401 fail payload; ensure visible error text (verify in browser when auth enabled).

---

## Low (performance)

### P1 — Overlapping client polls

**File:** `src/lib/stores/chat.svelte.ts`  
Sync (~3s), activity (~5s), presence (~8s), global tasks (1.8s), plus 700ms task polling during active turns.

### P2 — Heavy thread reload on sync

**File:** `src/lib/stores/chat.svelte.ts` → `/api/conversations/[id]`  
Reload can pull ≥200 messages and multiple side fetches per detected change.

### P3 — Screen panel polling while open

**File:** `src/lib/components/ScreenPanel.svelte`  
Sandbox status, pointer, and wake intervals while mounted.

### P4 — MessageList scroll work during streaming

**File:** `src/lib/components/MessageList.svelte`  
Scroll effects keyed on content length during token stream.

### P5 — Onboarding scans all conversations

**File:** `src/lib/server/runner.ts` (`onboardingBlock`)  
O(conversations × notes) on first bot turn.

---

## Informational — controls that looked solid

- **SQL:** Widespread prepared statements in `src/lib/server/db.ts`; dynamic DDL guarded in migrations.
- **Path traversal:** File uploads use row IDs on disk; `safeFilePath` / `storedPath` in `src/lib/server/files.ts`.
- **XSS (chat):** `guardHtml` + `Markdown.svelte`; bot CSS proposals tested in `bot-style.test.ts`.
- **CSRF (browser writes):** Origin check on state-changing methods; verified by `scripts/verify-security.sh`.
- **Command injection:** `strField` rejects C0 controls before spawn paths; machine commands run in containers.
- **Egress from bots:** `egress-proxy.mjs` resolves DNS and blocks private targets for sandbox traffic.
- **Provider test SSRF:** `probeProvider` blocks private hosts unless `PROVIDER_TEST_ALLOW_PRIVATE`.
- **VNC:** WebSocket relay requires session cookie when auth enabled (`vnc-proxy.ts`).
- **Secrets:** gitleaks in CI; encrypted bot secrets; redaction tests in server code.
- **Auth crypto:** HMAC session cookies, timing-safe password compare with length guard (`auth.test.ts`).

---

## Changes landed in this pass (PR into `overnight`)

1. CI fork guard on self-hosted jobs.
2. Federation private-endpoint refusal (`FED_ALLOW_PRIVATE`).
3. `TRUST_PROXY` for `X-Forwarded-Proto`.
4. This audit document and overnight UI screenshots.
5. Tests: `ci-workflow.test.ts`, federation/http/config updates.

---

## Recommended next slice (hourly continuation)

1. **UI:** Add `aria-label` / `aria-expanded` on desktop chrome and composer; inert main when sidebar drawer open.
2. **Performance:** Debounce or coalesce chat store polls; backoff task polling when SSE preview active.
3. **Security:** Webhook rate limiting; optional `SESSION_SECRET` warning in settings when auth enabled.
4. **Dependencies:** Planned `@sveltejs/kit` / undici upgrade branch with full CI on self-hosted (non-fork).
5. **Final merge:** Single PR `overnight` → `main` for John after review (do not auto-merge).

---

## How to re-verify locally

```bash
npm test
npm run build
# With a running instance:
./scripts/verify-security.sh http://127.0.0.1:4173 127.0.0.1:4173
```

Never run security probes against production deployments you do not own.
