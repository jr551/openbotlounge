# WORK — state of this repo after the 19-20 Sep run

Everything below is committed together on `main`. Development ran on a Steam
Deck, driven by omp with DeepSeek as the model. The app's own dev deployment is
a plain systemd service on a private box, kept as a git checkout of `main`, so
a deploy is a pull plus `npm run deploy`. Hostnames, addresses and credentials
are deliberately omitted from this repository.

This began as an internal work log for a single run. It is kept because the
root-caused defects and the reasoning behind them are the useful part of it;
the branch bookkeeping it originally carried has been dropped.

## Done — merged to `main` and verified

### Root-caused bugs

- *VNC gateway crash-loop.* The gateway for a bot loses its attachment to the
  `obl-vnc` bridge and ends up on the machine's internal network only: no route
  out, no DNS, so its `apk add nodejs` fallback fails and it loop-crashes
  (`node: not found`, 35 restarts). With no published port, `vncPort` reads 0,
  which is the engine behind two user-visible bugs at once: the screen panel
  flickered, and a machine that was plainly awake still offered a Wake button.
  Reproduced byte-for-byte in a scratch container, then fixed at four layers:
  -
  * The gateway's bridge attachment verified and repaired on every call
  * the image it runs preferred to be one that already has node, rather than
    `alpine:latest` which has none
  * a new `screen: 'off'|'ok'|'gateway'` status, so a panel can say "awake but
    screen unavailable" instead of offering a Wake button
- *Cooper's GIMP lie* — it described a drawing it had never seen ("the yellow
  sun is in place, mountains are taking shape"). The root causes were two:
  the container's shell had no `DISPLAY`, so GUI apps hung until the turn's
  time budget killed them; and nothing told a bot not to narrate a screen it
  had not looked at. Both fixed (`DISPLAY` exported into the pane script and
  the tmux environment; the budget-stop error now names the work in progress;
  the prompt forbids claiming any screen state that was not observed).
- *One-line boot log spammed seven times* — `ensureTmux` raced concurrent
  callers. Boot work is now deduped by having every caller wait on the in-flight
  install rather than racing it; same fix for the desktop kick.
- *Plugin tools advertised but not runnable as written* — `executeTool` returned
  "unknown tool" for `plugin_<slug>` until the runner's own loop intercepted it;
  and a model that emits tool-call markup as text (`<arg_key>...</arg_key><arg_value>`) was
  printing a fake tool call as chat. Both handled.
- *Prototype-chain argument lookup*, *JSON import attribute* (so `mcp-bridge.mjs`
  can load machine.ts under plain node), *an `Init` placed top-level where
  Docker ignores it* (caught only by A/B testing against a real daemon).
- *xlock fix* (`xlock-fix`) — `/tmp` survives a container stop, so a machine
  that slept with its desktop up woke to `/tmp/.X1-lock` naming a pid some other
  process now owned, and Xvnc refused display `:1` forever. The xvnc phase now
  removes the lock and socket whenever its `obl_alive` check says no Xvnc is
  actually running, and `sleepMachine` clears them before stopping the container
  so a sleeping box never carries a stale lock into its next wake.

### Features that are now in

- *Forced ad blocking* on every bot browser — 97 declarativeNetRequest rules,
  covering ad/tracker networks plus 25 rules for the common
  consent-management platforms (OneTrust, Cookiebot, Quantcast, TrustArc,
  Didomi, iubenda, Osano, CookieYes, Usercentrics, consentmanager, CookieHub,
  Axeptio, Termly, Sourcepoint, Google Funding Choices, Sirdata, Evidon,
  CookieScript, Cookie Information, Securiti, Transcend, IAB consensu) so
  GDPR/cookie banners never load.
- *Machine packages* (`machine-packages`) — the base toolset `apk` installs on
  first boot is a single exported list in `machine-packages.ts` (its own module
  because `machine.ts` is partially mocked in tests). The boot install and both
  prompts that describe the machine (the per-turn system prompt in `runner.ts`
  and the computer operator's prompt in `computer-agent.ts`) name that one list,
  so a bot can check it before reaching for `apk add`.
- *Police sign-off gate* on newly written plugins, routines and wake schedules;
  verdicts stored on the rows and visible in the UI.
- *Police visibility* (`police-visibility`) — the creation gate's verdicts are
  surfaced: `GET /api/police` returns `sign_offs` (every verdict on a plugin,
  routine or wake row, newest first, via `creationSignOffs()`), the console
  gains a Sign-offs section with the officer's reason and an Approve anyway
  button for exhausted items, plugin cards and routine/wake rows show the
  verdict inline, and `/api/wakes/[id]/approve` gives a refused wake the same
  human ruling path plugins and routines have.
- *Refusal escalation* (`refusal-escalation`) — a bot about to turn down a
  request calls `consult_police` first: the officer reads the request and the
  bot's reason against the good-use guide (`GOOD_USE_GUIDE.md`, shipped in the
  image) and answers at once - REFUSE confirms the no, ASSIST hands back the way
  to do the thing, and an unreachable police force is `unreviewed`, advice
  rather than a gate so a down provider cannot leave bots unable to say no. The
  consult is a core tool, and the system prompt says a refusal never consulted
  on does not count.
- *Cookie handover*: site-scoped, police-approved on a stated reason, enforced
  twice (in-container CDP filter plus app-side), never persisted, carried over
  `dockerExec` so a value cannot reach the activity log.
- `give_plugin` — a real bot-to-bot plugin transfer.
- *Live composing text* streamed over SSE (new `/api/tasks/stream`).
- *Cropped screenshots* posted into chat (`send_screenshot`, new `messages.image`).
- *Computer-use vision*: the sub-agent sees a grid-labelled screenshot every
  step, drives the desktop with xdotool mouse/keyboard tools that refuse
  until it has looked, falls back to the police model when the bot's model
  cannot take images, and the police patrol writes up desktop clutter.
- *VNC backdrop and take-control glow* (`vnc-backdrop`) — the expanded viewer's
  dim was a giant box-shadow, so clicks outside it fell through to whatever was
  behind; it is now a real backdrop element that shrinks the viewer on click,
  matching the backdrop conventions used elsewhere (PlayGym, modal overlays).
  The take-control button breathes a soft green glow while the bot drives, so
  it reads as an available action; the glow stops once the human holds the
  screen and is disabled under `prefers-reduced-motion`.
- *Computer expert* (`computer-expert`) — the computer operator gets an install
  mandate and a field guide. `COMPUTER_GUIDE.md` is read off disk once (the way
  `police.ts` reads `GOOD_USE_GUIDE.md`) and covers installing software (apk,
  community repo, static binaries, pip/npm), launching GUI apps on `DISPLAY=:1`
  detached, playing games by the look-act-look vision loop (DOSBox, scummvm,
  fceux, xdotool key names), the browser boundary, and the errors this box
  actually produces. The operator's prompt now says install what the task needs
  rather than refuse, and `use_computer`'s description tells the bot to delegate
  anything visual or interactive.
- *Browser agent* (`browser-agent`) — a dedicated sub-agent owns the web: the
  bot's `browse` tool hands it the task, and it reads every page as a walk (the
  title, the URL, the on-screen text and a numbered list of the links, buttons
  and fields near the viewport), clicking and filling by number over CDP.
  Scroll, back and key presses answer with the fresh walk, so it never acts on a
  stale view - and a text-only model can browse at all. The pixel path stays as
  the fallback (`screen_look` plus the shared mouse/keyboard tools), and a
  toolbox marker keeps each sub-agent in its own catalogue.
- *Exa search* (`exa-search`) — a `search_web` tool (core set, so private-room
  turns see it too) calls `POST https://api.exa.ai/search` and returns
  title/URL/snippet lines the bot can hand to browsing. The key is the
  `exa_api_key` settings row (writable through `POST /api/settings`, blanked out
  of its response like the provider key), falling back to `EXA_API_KEY`.
- *Subagents* (`subagents`) — `spawn_agent` hands one focused task to a helper
  that runs its own tool loop (`subagent.ts`, mirroring `computer-agent.ts`):
  read-only tools only, no parent history, a hard five-minute life, a ten-step
  cap, and at most four alive per bot. Same-step `spawn_agent` calls genuinely
  fan out; helpers cannot spawn helpers, and a hallucinated call outside the
  read-only set is refused at dispatch.
- *Cost readout* priced against the model the provider *actually served* (a new
  `bots.served_model` column), with the alias as display-only. `pricing-workmd`
  prices each bot's spend per model and shows it on the card and meter.
- *The police as a help-bot contact*, shelved in "More rooms".
- *WhatsApp-style quote rendering* that links a genuine quote back to the line it
  came from, judged against the live thread.
- *Secrets*: decline, revoke-share, and a fixed accept path (the handover bubble
  was excluded from model context, so a bot could go on denying it had anything).
- *Secrets Ask affordance*, 24-hour usage meter with hover detail, live LinkedIn
  card in the main profile.
- *Lounge conversations*: names no longer self-prefixed (a comma after a leading
  name is respected as addressing, a colon or dash is a signature and is
  stripped) — 51 runner tests.
- *Police verdicts are bounded*: a refused plugin or routine spends one of
  POLICE_MAX_ATTEMPTS (3) attempts each re-review, and the attempt that runs
  out leaves the item disabled with `awaitingHuman` in its verification JSON.
  The human rules from the card ("Approve anyway") via POST
  /api/plugins/[id]/approve and /api/routines/[id]/approve, which writes a
  `by:'human'` verdict and switches the item on.
- *Effort is tiered*: bot turns run at the provider's low effort by default;
  the police's calls always run at the maximum, and a bot can ask for hard
  thinking with `request_thinking` - the human approves a 30-minute grant
  (bots.thinking_request/thinking_grant, POST /api/bots/[id]/thinking), shown
  as a card and badge in the thread.
- *Cost attribution*: providers that report a price land it on tasks.cost and
  bots.cost; for a served model with no provider price the police researches
  the market rate once per round (OpenRouter listing, model-estimate
  fallback), caches it in the `price_research` setting, and the usage readout
  shows it marked as estimated. `price_overrides` (settings key, USD
  per-token) is the human's figure and always wins.
- *Bots can ask the human for a change* they cannot make themselves
  (`request_change`): the ask lands as an Approve/Deny card in the police's
  own chat (change_requests table, GET /api/asks, POST /api/asks/[id]), one
  pending ask per bot, and the verdict reaches the bot as a line in its own
  chat.
- *Nix*: a human can switch Nix on for a bot (bots.nix_enabled,
  PATCH /api/bots/[id]) - the `nix` tool appears, the store lives on a
  `obl-nix-<id>` volume mounted at /nix so installs survive a rebuild, and
  first use installs Nix itself. The *Nix switch* (`nix-switch`) is now visible:
  the bot form's Machine section carries a "Nix package manager" checkbox
  (edit only - a bot being created has no machine yet).
- *The fleet can vote a bot into cold storage* (`vote_archive` to call it,
  `cast_vote` for ballots): one open vote per target, one ballot per bot
  (recasting replaces it), the target and hidden/archived bots get no say,
  and the human is not in the tally. Yes needs more than half the eligible
  fleet; the vote fails the moment noes make that unreachable, and the
  scheduler sweep expires anything still open after ARCHIVE_VOTE_HOURS (4).
  The call and the outcome are announced in the lounge by the police.
- *Host memory is a police criterion*: each round reads /proc/meminfo once and
  every bot's cgroup usage, and the bundle carries both. When the host is
  tight the `contention` rule prefers orchestration over punishment - a new
  `sleep_machine` action puts the bot's box down (machine.ts `sleepMachine`,
  `hostMemory`, `machineMemoryUsage`) rather than a write-up or jail.
- *Checkbot regeneration loop*: a refused plugin or routine is re-read once by a
  second officer whose prompt carries the standing refusal and says plainly
  that it is one officer's reading, not evidence - a second look rather than an
  echo - and only a refusal is re-read (approval ends the loop at once). Both
  reviews share one loop function (`runPoliceRounds`) so they cannot drift.
  A verdict of `unreviewed` (officer unreachable, or none in the reply) is the
  police being absent, not a refusal: round one signs nothing off and refuses
  nothing, and on round two a refusal already standing keeps standing, because
  a provider outage must never leave refused work switched on.
- *Plugin unit tests run, not just stored*: `plugins.tests` holds the author's own
  `{name, args, expect}` entries, `create_plugin`/`update_plugin` take them (a
  malformed entry is refused by name, not dropped), `runPluginTests` runs each
  against the real code in the author's sandbox, and the results ride to the
  officer beside the code they prove - as does the fact that an author brought
  none.
- *Police-check toggles*: `police_check_plugins` and `police_check_routines`
  (on unless a row says `off`) are honoured at every call site - the create and
  update plugin tools, `schedule_task`, and the routines route - and a gate
  switched off creates the work unjudged and unrefused, with no verdict row for
  the console to read as a review. Both sit in the police console beside the
  duties.
- *A regenerated reply is a rewrite, not a redo*: `regenerate` now runs with
  `noTools`, so a turn that had already relayed a message or woken another bot
  re-composes its text from the same history without running any tool again.
- *Reply claims are checked against the tools the turn actually called*: every
  tool that ran is recorded and the reply's text is matched against a small
  verb table (remembered, saved, sent, told, scheduled, watching, ran, checked).
  A claim no call can back is logged as a `claim` activity and queued as a
  private note in the bot's next system prompt. Tool-less turns (regenerate,
  `noTools`) are exempt.
- *Boot/deploy work is deduped and atomic*: `ensureTmux` and the desktop kick
  wait on the in-flight install instead of racing it, `npm run deploy` builds
  into `builds/<id>` and swaps a `build` symlink, and the service exits on
  SIGTERM instead of hanging to SIGKILL.
- *Machine networking fails loudly*: `machine-net`/`machine` re-attach networkless
  running machines and fix subnet collisions instead of letting a machine come
  up without a network.
- *Cooperative browsing*: a documenter agent maps new domains for the fleet.
- *Mid-task steering* (`mid-task-steering`): a message sent while a bot is
  mid-turn is judged by a cheap classifier (`steering.ts`, on the police model)
  - a correction is queued into the running turn's tool loop (`agent.steer`,
  delivered before the next provider call, with a post-run drain for one that
  lands after the last poll), while a separate ask starts a parallel task
  instead of interrupting. The chat route reports the running task with
  `steered: true`. Classifier failure defaults to steer.
- *Live fixes* (`live-fixes`) — follow-ups from the live test pass: the
  full-tier prompt no longer carries the "no desktop/VNC/browser screen" clause
  (full bots were refusing screen tasks); `use_computer` now says the operator
  sees the screen each step and can send screenshots into chat, and its "raw
  connections refused" claim is corrected to match the egress proxy; the
  computer operator's `MAX_STEPS` went 12 -> 30 and gained `browser_fill`; a
  turn stopped early stores its reply with a `[stopped: <reason>]` tail;
  documenter `fetch_page` execs are tagged `documenter` and billed to the
  police bot.
- *Retest fixes* (`retest-fixes`) — image `data:` URLs are unpacked into raw
  base64 + mimeType (the adapters build the URI themselves, so it arrived
  double-prefixed and was rejected as invalid base64); the in-container CDP
  driver catches and reports one clean line instead of dumping a stack whose
  last line is the Node version banner; a provider error mid-stream now fails
  the task rather than storing a truncated reply as done (the partial text is
  still persisted with the cut-off marker); sub-agent failures log a `subagent`
  activity entry with the real error; `LLM_MAX_TOKENS_PER_TASK` default raised
  60k -> 200k.
- *Mid-task steering scope* (`steering-scope`) — a message sent while
  a bot is working steers that bot's running turn whichever conversation
  started it: the chat route falls back to the bot's newest running task on a
  confident classifier verdict, writes the human's line into the room the
  work is in (kind `steer`), and the lounge's inject route steers a member
  already mid-round instead of starting a second task. The human's own line
  is marked `⚡ steered`, and every accepted steer stays on an unread list
  until the run reports the model reading it - a caller told "steered" either
  had the message read or gets a task for it.
- *Steer/new classifier fix* (`steer-parallel`) — the classifier's
  `maxTokens` went to 512: the reasoner was spending its whole budget on
  thinking and returning an empty verdict, so unrelated asks were steered
  into running turns instead of getting a parallel answer.
- *Plugin review visibility* (`plugin-review-visibility`) — the
  police's plugin verdict is shown on the card including `unreviewed`, and a
  plugin that never got a verdict can be re-reviewed on demand from its own
  route.
- *Plugin police parity* (`plugin-police-parity`) — `give_plugin`
  re-reviews the plugin in the recipient's name before the transfer lands,
  and `PATCH /api/plugins/[id]` runs an edit through the same review a create
  gets, so a refused-then-edited plugin cannot come back unjudged.
- *Group-chat gate* (`group-chat-gate`) — `create_group_chat` is
  gated on a new `police_check_rooms` switch beside the plugin and routine
  gates: a refused room stays pending and seatless, a gate switched off opens
  the room unchecked, and the human can approve from the console.
- *Vision fallback* (`vision-fallback`) — a `vision_model` setting
  names the model a text-only bot's images are read with; it is stored only
  once it has actually answered an image, so a typo cannot strand every
  picture on a model that cannot see.
- *PC takeover report* (`pc-takeover-report`) — when the human takes
  a machine over, the bot is told what it had done on it so far, so a watched
  session does not resume blind.
- *PC icon flash* (`pc-icon-flash`) — the machine's screen icon
  flashes electric blue while the bot is driving it.
- *Relay reply bubbles* (`relay-reply-bubble`) — the relay's reply
  half shows in the human's DM feed, so a two-sided conversation no longer
  reads as the bot talking to itself.
- *Firecrawl failover and machine prewake* (`firecrawl-prewake`) —
  `search_web` tries Exa first and falls back to Firecrawl when Exa cannot
  answer, and a machine is prewoken at turn start instead of mid-turn.
- *Task-tray click split* (`task-click-opens-chat`) — clicking a
  task in the tray no longer also opens the bot's chat.
- *Bounded provider calls* (`timeout-fixes`) — live fuzzing found a
  class of bugs with one shape: a route awaiting a provider/LLM/sandbox call
  with no bound, so a slow provider hung the request, the client timed out,
  and the write still completed - silent duplicates and apparently-lost
  work. The model check on `POST /api/bots` is bounded (10s -> 503) and the
  draft re-validated on the spot (a name taken mid-wait gets a 409, not a
  duplicate); `classifyInterruption` takes a 5s signal; the plugin police
  review runs after the 201 instead of holding it; `listModels` shares one
  in-flight fetch and serves the last good list when the provider stops
  answering; `provider_base_url` is validated http(s)-only and refused when
  it points back at this server; an unknown `hat` on `PATCH /api/bots/[id]`
  is a 400, not a silent clear.
- *Lounge insults register* (`lounge-insults`) — the lounge's
  piss-taking is pinned to a 1990s British register with the limits it rides
  with, not a flat insult.

- *Sandbox install kind* (`installKey` sandbox kind) — infrastructure
  execs no longer wake the desktop: the install key uses the `sandbox` kind, so
  a provisioning command cannot pop the user's screen awake.
- *Police bug reports* — a confident police bug report is filed to the
  human with loop guards, so the same report cannot re-file forever.
- *Police wake gate* — `police_check_wakes` now exists: wakes created
  through `POST /api/wakes` are reviewed under their own switch, separate from
  the routines gate (`police_check_routines`).
- *Backup cadence* — the plugin POST unreviewed-live window is closed,
  and `backupDue()` now uses a fixed 24h interval instead of a local-day
  boundary evaluated only on the 15-second scheduler tick.

**Tested** — 1251 tests across 88 files, typecheck clean (0 errors; 3
pre-existing a11y/CSS warnings). That was the count when this document was
written; the suite was re-checked afterwards on current `main`, not by this
document refresh.

## Outstanding

- *Merged topic branches still on `origin`* — the round the cleanup was aimed
  at is gone, but these fully-merged branches were left in place because they
  were not in the cleanup list: `boolean-flag-contract`,
  `bug-report-to-human`, `fix-leftover-outstanding`, `group-chat-gate`,
  `lounge-insults`, `merge-all`, `plugin-review-visibility`,
  `steering-scope`, `vision-fallback`, `wake-faster`, `wakes-police-gate`.
  They are all ancestors of `main` and safe to delete whenever wanted.
- *Merge records need tidying.* A handful of changes landed on `main` while
  their pull-request records were closed without being marked merged. Each head
  commit is an ancestor of `main`, so nothing is lost — it is a bookkeeping
  discrepancy, not missing work.
- *Steering edges still open* (from the `steering-scope` round): the
  classifier's own model call is outside the steer channel; a
  steer into a *delegated* turn is still refused; and the ⚡ row mark lives
  in the client, so a full page reload loses it (a durable marker would mean
  storing it on the message row, i.e. a schema change).
- *Tool surface optimizations* — see the ToolAnalysis findings.
- *Secrets decline end-to-end test* — the `decline_secret` tool is coded and
  unit-tested (`tools.test.ts`), but no test asserts the end-to-end human flow
  (offer -> decline -> the panel/memory state the human sees).
- *AppArmor profile loading* — `obl-machine.profile` needs
  `apparmor_parser -r -W` on the host once (see _Follow-ups_).
- *Egress port configurability* — the proxy's port relaxation is hard-coded;
  making LAN access configurable is the human's call (see _Follow-ups_).

## Follow-ups worth doing

- Make the egress port relaxation configurable, not hard-coded: the proxy now
  allows any port to a public address, but refuses LAN/host/metadata for
  everything. If the user wants LAN access too, that removes the isolation, and
  it is their call.
- AppArmor profile at repo root (`obl-machine.profile`) needs loading on the
  host once (`apparmor_parser -r -W obl-machine.profile`) before the cap-drop
  puzzle means anything.

## Handover

Development ran on a Steam Deck, driven by omp with DeepSeek as the model.
Work was committed to `main` as it went, so the deck held the same repo the app
deployed from.

- The dev box stays the app runtime: builds, tests and restarts happen there
  over SSH, not on the deck. `npm run deploy` builds into `builds/<id>` and
  swaps the `build` symlink, then restarts `openbotlounge.service` when the unit
  exists.
- The app on the dev box is a git checkout of `main`: a deploy is `git pull`
  plus `npm run deploy`.
- Verify after any deploy: `systemctl status openbotlounge` reports active and
  the app answers on its port with 200.
