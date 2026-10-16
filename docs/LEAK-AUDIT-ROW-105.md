# Pre-public leak audit — ROW-105 (re-audit of published commit `add23bc`)

Date: 2026-10-16 · Auditor: automated (omp worker) · Scope: full git history (all
reachable + orphaned commits), working tree incl. untracked files, GitHub
surfaces (branches, tags, refs, releases, workflows, issues, PRs, repo
settings, events feed).

> **No secret values are reproduced in this document.** Findings reference
> file/line/commit/type only.

## Context — why this audit exists

A first audit ran on 2026-10-15 against commit `81a11e7`. After it completed,
the repo's history was rewritten: `main` now points at a new root commit
`add23bc` that shares **no ancestry** with the audited commit, and the repo was
made **public**. This document is the re-audit of what is actually published,
per peer review on Linear ROW-105.

## Tools and coverage

| Tool / method | Version / scope | Result |
|---|---|---|
| gitleaks | 8.30.1, git mode, repo `.gitleaks.toml` config | 0 findings |
| gitleaks | 8.30.1, git mode, **default config only** (repo allowlist bypassed) | 12 findings — all resolve to the 16 named fixture literals in `.gitleaks.toml` |
| gitleaks | 8.30.1, dir mode (tree incl. `node_modules`, tree with `.gitleaks.toml` removed, and a worktree of orphaned commit `81a11e7`) | 6 findings — same fixture literals only |
| trufflehog | 3.99.2 (sha256-verified binary), `git` + `filesystem` modes, repo tree and orphan-commit tree | **0 secrets in repo** (0 verified, 0 unverified); 16 unverified hits all inside untracked `node_modules/` (upstream doc-comment/example matches + one base64-WASM false positive) |
| Manual regex sweep | ~60 patterns over tracked files + all 14 blobs unique to the orphan tree + `git fsck --unreachable --dangling` | No credentials; infra-exposure items below |
| Contextual file read | ~50 files (deploy, auth, secrets, crypto, routes, docs, all 11 screenshots viewed) | Findings below |
| GitHub API enumeration | `gh api` over branches/tags/refs/trees/blobs/releases/workflows/actions-secrets+variables/runs+logs/environments/deployments/milestones/keys/hooks/collaborators/events/community/security_and_analysis | Findings below |

`git fsck`: clean, no dangling objects. `npm ci` + `npm test`: **1247 passed /
4 failed** — the 4 failures are environmental (1 egress-proxy test needs real
outbound connectivity; 3 mcp-bridge tests return `undefined` JSON-RPC errors,
likely because the sandbox runs node 22.14 vs the `>=22.19` engine spec). No
test failure is security-related.

## Verdict

**No live credentials, private keys, tokens, or connection strings were found
in any published tree, blob, workflow, issue, PR, or release.** The published
content is deliberately sanitised.

**However, two standing issues prevent a clean sign-off:**

1. The repository is **already public** and its **replaced history is still
   publicly fetchable**: 20 orphaned commit heads (the pre-rewrite squashed
   commits) resolve via the REST API and contain content scrubbed from `main`.
2. The previously-raised **HIGH** item ('Vicky' family-name fixture) and
   **MEDIUM** item (WORK.md internal dev log) are **still present in `main`**
   — neither fixed nor explicitly risk-accepted by the owner.

## Findings

### HIGH

| # | Class | Type | Location | Note |
|---|---|---|---|---|
| H1 | INFRA-EXPOSURE | Orphaned-commit history | 20 replaced commit heads, e.g. `81a11e77128cbb11f5bf814c520acb2d1989d629`; enumerated from the public `/events` PushEvent feed (17 pushes, 2026-10-15 13:33–19:05 UTC) | Every intermediate pre-rewrite tree remains publicly fetchable via `GET /commits/{sha}` + `/git/trees` + `/git/blobs` (all verified HTTP 200). GitHub does not GC unreachable objects promptly. Content scanned: no live-format keys, but superseded `WORK.md` variants contain a private dev-worklog (internal project task names, "PR #70" reference, internal commit SHAs, five `192.168.x.x` addresses) and old `.env.example`/`llm.test.ts`/`runner.test.ts` contain the scrubbed personal-gateway identifiers (`rowe/free`, `rowe/value`, an Ollama base URL, a model profile name). **Remediation requires GitHub support/GC (or repo recreation) — a push cannot purge these objects. Everything in them must be treated as already exposed.** |
| H2 | PII | Family first name | `src/lib/server/connectors.test.ts:187,204` (present in `add23bc` and orphan `81a11e7`) | Test fixture string `Hi, this is Vicky from the lounge.` — flagged HIGH in the first audit as a family member's name; unchanged. Needs owner decision: rename fixture or accept-risk. |

### MEDIUM

| # | Class | Type | Location | Note |
|---|---|---|---|---|
| M1 | VERIFIED-LEAK (design) | Published constant usable as decryption key | `src/lib/server/secrets.ts:54-57` (fallback at `:79`) | `legacyKey()` = `sha256(sessionSecret \|\| apiKey \|\| 'obl-secrets')` — in a default install the effective key derives from a constant published in this file; `decrypt()` still falls back to it. `README.md:556-558` itself states pre-fix ciphertext "should be treated as plaintext". Any `chat.db` ever written by a pre-fix build is decryptable by anyone. Code fix, not a repo-content fix. |
| M2 | LIKELY-LEAK (design) | Deterministic private-key derivation from public input | `src/lib/server/ssh-keys.ts:75-104,123` | Bot git-identity ed25519 private keys = `sha256('openbotlounge:' + bot.name)`. Bot names are visible to other bots/users, so a bot's SSH private key is derivable from public data; also lets observers link a public key to a named bot. |
| M3 | INFRA-EXPOSURE | Internal dev log still published | `WORK.md` (372 lines; e.g. `:361` Steam Deck + model disclosure, `:367` systemd unit name, Handover section) | Sanitised vs the first audit (LXC path removed) but still an internal worklog: dev-machine, deployment shape, and day-to-day process details. First audit rated MEDIUM "embarrassing"; still present. Needs fix-or-accept. |
| M4 | INFRA-EXPOSURE | Platform safety nets disabled | repo `security_and_analysis` | `secret_scanning`, `secret_scanning_push_protection`, `secret_scanning_non_provider_patterns`, `dependabot_security_updates`, vulnerability alerts, automated security fixes: all **disabled**; no `SECURITY.md`. The repo deliberately ships credential-shaped fixture strings allowlisted in `.gitleaks.toml` — platform push protection would have been the last net for anything else. |

### LOW

| # | Class | Type | Location | Note |
|---|---|---|---|---|
| L1 | INFRA-EXPOSURE | CI coverage gap | `.github/workflows/ci.yml:60-65` | The `secrets` job runs gitleaks `detect --no-git` (tree-only) with the repo allowlist — history is never scanned in CI, so a real secret already committed would not be caught there. |
| L2 | INFRA-EXPOSURE | Unsigned commits | all commit objects | `verification.verified=false, reason=unsigned` on `add23bc` and every orphan head. |
| L3 | INFRA-EXPOSURE | Plausible LAN-IP fixtures | `src/lib/server/settings-route.test.ts:74-75` (`192.168.1.95:3000`), `src/lib/server/http.test.ts:111-130` (`192.168.1.25:3000`) | Non-round-number RFC1918 fixtures that could be real dev-box addresses; also five more `192.168.x.x` values inside orphaned WORK.md/test blobs (covered by H1). |
| L4 | INFRA-EXPOSURE | Adjacent-project linkage | `src/lib/server/connectors.ts:275,283,357-359`; `docs/screenshots/marketplace.png` | Connector copy ties `jr551` to sibling public repos (`mailcow-rest-api`, `proxmox-agent-lab`) and discloses the operator's homelab stack (WAHA/WhatsApp, Bitwarden, Mailcow, Proxmox, Home Assistant, Tailscale, ElevenLabs). Recon value only. |
| L5 | INFRA-EXPOSURE | Embedded third-party OAuth client id | `src/lib/server/provider-oauth.ts:123` | Hardcoded OpenAI Codex device-flow client id — public-by-design (same value ships in Codex CLI); recorded for owner confirmation it is intentional. |
| L6 | PLACEHOLDER | Partial-credential print footgun | `scripts/pi-spike.ts:109` | Dev script prints first ~24 chars of the live `Authorization` header when run against real config. Not committed material; runtime footgun if output is pasted. |
| L7 | PII | Third-party maintainer emails | `THIRD_PARTY_NOTICES.md:28,30,287,333` | Licence attribution for upstream authors (github-slugger, htmlparser2). Required; no action. |
| L8 | PII | Commit author real name | commit metadata (`add23bc`, orphans) | `John Rowe` + GitHub noreply email. Expected for a personal public repo; noted. |

### Test fixtures (PLACEHOLDER, no action)

All gitleaks default-config hits are the 16 named fabricated `sk-*`/`relay-test-pw`
literals allowlisted in `.gitleaks.toml` (`src/lib/server/{mounts,police-evidence,llm,provider-connect,provider-oauth,secrets}.test.ts`, `debug.test.ts`,
`scripts/adversarial.mjs` `hunter2-secret`, `connectors.ts:373` Proxmox token
shape `root@pam!lab=xxxxxxxx`). The `.gitleaks.toml` allowlist was verified to
suppress **exactly** those literals and nothing else (default-config delta = 6
unique fixture values).

## Checked and clean

- No `.env*` files tracked; `.env`/`.env.*` ignored; `.env.example` all blank.
- No private keys/certs (`BEGIN …PRIVATE KEY`, ssh-rsa/ed25519 material), no AWS/GitHub/Slack/Google/SendGrid/Stripe/Twilio token shapes, no JWTs, no userinfo-in-URL, no DB connection strings, no webhook URLs.
- No tailnet/internal domains (`*.ts.net`, `rowe.lol`, `delivering.email`, `mouse-pentatonic`, `pikapod`), no `/home/<user>` paths, no real `root@` hosts.
- `Dockerfile`, `docker-compose.yml` (env passthrough only), `egress-proxy.mjs`, `vnc-gateway.mjs`, `obl-machine.profile`, `scripts/deploy.sh`, `.omp/*`, `.pi/*`, `svelte.config.js` — clean.
- All 11 screenshots: fixture bots only, no PII; PNGs carry no EXIF/author metadata.
- GitHub side: 1 branch, 0 tags, 0 releases, 0 issues, 0 PRs, 0 Actions secrets/variables/environments/deployments, 0 webhooks, 0 deploy keys, 1 collaborator, workflow run logs masked `***` (only `127.0.x.x` IPs), GHCR package denies anonymous pull (401) — effectively private.
- `git fsck --unreachable --dangling`: clean.

## Recommended actions (owner decision required)

1. **Purge orphaned objects**: open a GitHub support request to GC the 20
   unreachable commit heads (or delete+recreate the repo). Until then treat
   every replaced tree as public — nothing in them requires rotation (no live
   credentials found), but the worklog content is already exposed.
2. **Decide H2/M3**: rename the `Vicky` fixture and remove/relocate `WORK.md`,
   or explicitly accept-risk both. They remain published either way.
3. **Fix M1/M2 in code**: remove the `legacyKey()` decryption fallback (or gate
   it behind an explicit operator flag), and seed bot SSH keys from randomness
   or a per-install secret instead of `sha256('openbotlounge:'+name)`.
4. **Enable secret scanning + push protection** (free for public repos) and
   consider a SECURITY.md; optionally extend CI to a history scan instead of
   `--no-git`.
5. Consider signing commits for the published history.
