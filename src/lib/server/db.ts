// Imported first, and before node:sqlite, so an unsupported Node is told what
// to install instead of failing on a module that sounds corrupt.
import './runtime-guard';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { refusedByPolice } from '$lib/plugin-verdict';
import { config } from './config';
import { recoverIfDamaged } from './backup';

mkdirSync(config.dataDir, { recursive: true });

/**
 * How long a write waits for SQLite's write lock before giving up. The default
 * is 0, so the moment any other connection holds the lock - a second instance,
 * a backup, or a hand-run `docker compose exec` - every INSERT here fails
 * instantly with "database is locked" and takes the request down with a 500
 * (for a chat POST, the user's message is lost). Waiting rides out those short
 * locks; the cap keeps a stuck writer from freezing the app indefinitely.
 */
const BUSY_TIMEOUT_MS = 2000;

// Before anything opens the database: a file that fails its own integrity check
// is replaced by last night's copy. The damaged one is kept beside it rather than
// thrown away, and the fact is recorded below so the user is told.
const recoveredFrom = recoverIfDamaged();

export const db = new DatabaseSync(join(config.dataDir, 'chat.db'), {
	timeout: BUSY_TIMEOUT_MS
});

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
-- WAL makes a commit durable without an fsync per transaction, so NORMAL is the
-- pairing SQLite recommends for it: a crash of this process cannot corrupt the
-- file and cannot lose a committed write, and only losing power inside the few
-- milliseconds before a checkpoint can. FULL would cost an fsync per commit for
-- that last sliver, and there is a nightly copy standing behind this anyway.
PRAGMA synchronous = NORMAL;
-- Checkpoint sooner than the 1000-page default, so the write-ahead log stays a
-- few megabytes rather than growing to whatever the busiest day needs.
PRAGMA wal_autocheckpoint = 256;

CREATE TABLE IF NOT EXISTS bots (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  persona     TEXT NOT NULL DEFAULT '',
  avatar      TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#8a8a93',
  model       TEXT NOT NULL DEFAULT '',
  badge       TEXT NOT NULL DEFAULT '',
  hat         TEXT NOT NULL DEFAULT '',
  -- Running totals of what this bot's model calls have cost, summed over every
  -- turn and never reset. Measured from the provider's own usage object where
  -- it sends one, estimated from characters where it does not (see llm.ts).
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Green tokens: the Wetherspoons tab the police pay a treat into (see
  -- police.ts). The balance only ever grows by gift - nothing spends it yet.
  green_tokens  INTEGER NOT NULL DEFAULT 0,
  -- What the provider says those calls cost, summed the same way; NULL means
  -- no call has ever reported a price, which is not the same as free.
  cost          REAL,
  -- The model the provider last said it served this bot's calls with, when it
  -- names one. The bot's own model column is often an alias the provider does
  -- not price, so the cost readout prices against this and falls back to it.
  -- '' = no turn has reported one yet.
  served_model  TEXT NOT NULL DEFAULT '',
  -- 0 until the bot has said its first hello; the runner uses it to give a new
  -- bot a one-time onboarding turn instead of dropping it into the room cold.
  onboarded   INTEGER NOT NULL DEFAULT 0,
  -- The bubble look the human approved (JSON of font/colour fields) and the
  -- one a bot has proposed but the human has not ruled on yet. '' = none.
  style           TEXT NOT NULL DEFAULT '',
  style_proposal  TEXT NOT NULL DEFAULT '',
  -- The named bubble themes the human approved (JSON array of BubbleTheme) and
  -- the one a bot has proposed but the human has not ruled on yet. '' = none.
  bubble_themes   TEXT NOT NULL DEFAULT '',
  theme_proposal  TEXT NOT NULL DEFAULT '',
  -- The debug access a bot is asking the human for (JSON {reason, at}) and the
  -- time-limited access the human has granted it (JSON {reason, granted_at,
  -- expires_at}); '' = none. Only setDebugAccess writes these, and only the
  -- human's /debug route calls it, so no tool can hand a bot access.
  debug_request   TEXT NOT NULL DEFAULT '',
  debug_grant     TEXT NOT NULL DEFAULT '',
  -- The same pair for thinking hard: the ask a bot has outstanding and the
  -- time-limited grant the human gave it. Only setThinkingAccess writes these,
  -- and only the human's /thinking route calls it.
  thinking_request TEXT NOT NULL DEFAULT '',
  thinking_grant  TEXT NOT NULL DEFAULT '',
  -- 0 = an ordinary bot; 1 = a system bot the app runs (the police). Hidden bots
  -- are filtered out of every list the UI shows, but still author messages.
  hidden      INTEGER NOT NULL DEFAULT 0,
  -- 1 = in cold storage: kept with its data, but unlisted and untalkable.
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_secrets (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  value       TEXT NOT NULL,
  shared_with TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE (bot_id, name)
);

-- One ed25519 key pair per bot: the identity it pushes to git with. The public
-- half is shown in its profile so the human can paste it into GitHub or Forgejo
-- as a deploy key; the private half is AES-256-GCM encrypted at rest (see
-- ssh-keys.ts) and no route ever returns it - it is only written into that
-- bot's own machine. Keyed by bot_id, so a key is made once and never replaced.
CREATE TABLE IF NOT EXISTS bot_ssh_keys (
  bot_id          TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  comment         TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

-- Files the user handed a bot. The bytes live in DATA_DIR/files/<bot_id>/
-- (see files.ts); these columns are everything the UI needs to list one
-- without touching the disk. "name" is what the user called it, "file" is the
-- name it is stored under - the row id plus the extension - so two files that
-- arrived with the same name can never overwrite each other.
CREATE TABLE IF NOT EXISTS bot_files (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  file       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_files_bot ON bot_files(bot_id, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New chat',
  kind       TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct','group')),
  -- The police's or the human's sign-off on the room, as JSON; '' = never reviewed.
  verification TEXT NOT NULL DEFAULT '',
  -- 1 = a bot asked for this room and it sits empty until an approval says it
  -- can open. App machinery (the lounge, pair rooms) never sets it.
  pending    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, bot_id)
);
-- The primary key already answers "who is in this conversation"; listing a
-- bot's conversations - what every chat list read does - needs the other order.
CREATE INDEX IF NOT EXISTS idx_conv_members_bot ON conversation_members(bot_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  bot_id          TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT '',
  rating          INTEGER NOT NULL DEFAULT 0,
  -- Filename of a screen grab shown with this message, if any. It lives in the
  -- same shots directory activities read, so the thread and the screen panel
  -- serve the same picture through /api/shots.
  image           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  interval_min    INTEGER NOT NULL,
  cron            TEXT NOT NULL DEFAULT '',
  next_run_at     INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- Why the police paused it, when they did; '' = off by the human's hand.
  paused_reason   TEXT NOT NULL DEFAULT '',
  -- The police's sign-off on the routine, as JSON; '' = never reviewed.
  verification    TEXT NOT NULL DEFAULT '',
  -- Who wrote it: 'bot' for one the bot made itself, 'human' for one created
  -- through the API. Rows from before the column read as 'bot'.
  created_by      TEXT NOT NULL DEFAULT 'bot',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  snippet    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_bot ON feedback(bot_id, created_at);

/**
 * A bot's ask for the human to change something it cannot change itself -
 * install a package, open a setting, anything outside its tools. The ask is
 * relayed into the police's chat with the human as a card they Approve or
 * Deny; the verdict is what the bot is told, never a promise the thing was
 * done - approving says the human takes it on.
 */
CREATE TABLE IF NOT EXISTS change_requests (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  need        TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL DEFAULT 0
);


CREATE TABLE IF NOT EXISTS archive_votes (
  id         TEXT PRIMARY KEY,
  target_id  TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  opener_id  TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  deadline   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_ballots (
  vote_id TEXT NOT NULL REFERENCES archive_votes(id) ON DELETE CASCADE,
  bot_id  TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  choice  TEXT NOT NULL,
  cast_at INTEGER NOT NULL,
  PRIMARY KEY (vote_id, bot_id)
);
CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- '' is the user; otherwise the id of the bot that reacted.
  actor      TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  -- What started the turn: 'chat', 'routine', 'wake', 'lounge', 'computer',
  -- 'webhook', 'inject', 'onboarding', 'fed' or 'police'. Read by the tray and
  -- by the police's waste check, which groups fires by it.
  kind            TEXT NOT NULL DEFAULT 'chat',
  -- What the tray calls it: a provisional label at create time, replaced by a
  -- model-written one when the turn finishes (see tasks.ts nameTask).
  title           TEXT NOT NULL DEFAULT '',
  -- Why the job exists, in the caller's words: which client asked and what
  -- for. '' for turns the app started itself; the MCP bridge fills it so a
  -- pi-driven job carries its reason with it.
  context         TEXT NOT NULL DEFAULT '',
  emoji           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'running',
  preview         TEXT NOT NULL DEFAULT '',
  error           TEXT NOT NULL DEFAULT '',
  message_id      TEXT NOT NULL DEFAULT '',
  -- What the turn's model calls cost, summed live as each call lands.
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  -- Prompt tokens the provider's cache served or stored, summed the same way.
  -- cache_reported marks that a provider sent cache fields at all: a 0 with
  -- it set is a real miss, a 0 without it is a provider that does not say.
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0,
  cache_reported  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_conv ON tasks(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_bot ON tasks(bot_id);

CREATE TABLE IF NOT EXISTS activities (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  image      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_bot ON activities(bot_id, created_at DESC);
-- The screen's activity feed reads across every bot in time order, which the
-- per-bot index cannot serve.
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);
CREATE INDEX IF NOT EXISTS idx_routines_next ON routines(next_run_at) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS bot_memories (
  bot_id     TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, key)
);

CREATE TABLE IF NOT EXISTS shared_notes (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id          TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conv_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,
  covers_until    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The police's sign-off on each compaction: what verdict it gave and why, so
-- the fold in the chat can show the review behind it. One row per pass. The
-- citations column is the marker-to-message map the summary's [mN] markers
-- resolve against, so a claim can be traced to the rows the fold hid.
CREATE TABLE IF NOT EXISTS compaction_reviews (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  verdict         TEXT NOT NULL CHECK (verdict IN ('approved','rejected','rewritten')),
  reason          TEXT NOT NULL DEFAULT '',
  citations       TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugins (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('tool','hook')),
  hook_point    TEXT NOT NULL DEFAULT '',
  parameters    TEXT NOT NULL DEFAULT '{}',
  code          TEXT NOT NULL DEFAULT '',
  author_bot_id TEXT NOT NULL DEFAULT '',
  scope         TEXT NOT NULL DEFAULT 'bot' CHECK (scope IN ('bot','shared')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  -- The police's sign-off on the code, as JSON; '' = never reviewed.
  verification  TEXT NOT NULL DEFAULT '',
  -- The author's own unit tests, as a JSON array of {name, args, expect};
  -- '' = none, which is why the police refuse an untested plugin.
  tests         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_overrides (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  bot_id    TEXT NOT NULL,
  enabled   INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, bot_id)
);

CREATE TABLE IF NOT EXISTS wake_tasks (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  run_at          INTEGER NOT NULL DEFAULT 0,
  cron            TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- Why the police paused it, when they did; '' = off by the human's hand.
  paused_reason   TEXT NOT NULL DEFAULT '',
  -- The police's sign-off on the schedule, as JSON; '' = never reviewed.
  verification    TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waits (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  url             TEXT NOT NULL DEFAULT '',
  contains        TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_conv ON shared_notes(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS webhooks (
  id              TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  prompt_template TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhooks_bot ON webhooks(bot_id);

-- A bot asking the human for shell on their own box. The row is the ask: who
-- to reach and whether the bot's key got in. The tool writes it, the human's
-- card reads it, the check route runs ssh from the bot's own machine.
CREATE TABLE IF NOT EXISTS ssh_requests (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  host            TEXT NOT NULL,
  username        TEXT NOT NULL,
  port            INTEGER NOT NULL DEFAULT 22,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ssh_requests_bot ON ssh_requests(bot_id);

-- idx_wakes_run was a partial index on (run_at) WHERE enabled = 1, but the
-- only reader of wake_tasks lists every row and filters in JS (wake.ts
-- dueWakes), so no query could ever use it. Drop it where it still exists.
DROP INDEX IF EXISTS idx_wakes_run;

-- llm_cache backed a response cache that no longer exists (nothing reads or
-- writes it); drop the table an older database still carries.
DROP TABLE IF EXISTS llm_cache;

-- The crayon board and the scratchpads are gone: the board's strokes lived in
-- files that board.ts swept, and a bot's notes now live in personality.md on
-- its own drive (see personality.ts). Drop the tables an older database still
-- carries; their rows have nowhere to be read from.
DROP TABLE IF EXISTS board_marks;
DROP TABLE IF EXISTS bot_scratchpads;
DROP TABLE IF EXISTS bot_scratchpad_versions;
DROP TABLE IF EXISTS bot_scratchpad_edits;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One bot refusing another's direct messages. A block is a refusal, not a
-- filter: send_message is turned away before the blocked bot is woken, and the
-- reason is kept because the room gets to ask about it. Both ends reference
-- bots, so deleting either takes the block with it - a grudge against a bot
-- that no longer exists is not something anyone can act on.
CREATE TABLE IF NOT EXISTS bot_blocks (
  blocker_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  -- Why the blocker gave it, in its own words; '' when it gave none.
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_blocks_blocked ON bot_blocks(blocked_id);

-- A bot's pitch for a brand-new bot. A row is pending by definition - the
-- human's Approve creates the bot and deletes the row, Decline just deletes it
-- - so there is no status to keep. The payload is the proposed bot as JSON.
CREATE TABLE IF NOT EXISTS bot_proposals (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  proposer_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_proposals_conv ON bot_proposals(conversation_id, created_at);

-- One row per bot the police round has written up. offence_count is how many
-- times in total, streak how many rounds in a row - the streak is what turns a
-- write-up into a public one. A bot that behaves for a round keeps its count and
-- loses its streak. The row goes with the bot (see police.ts).
CREATE TABLE IF NOT EXISTS police_records (
  bot_id          TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  offence_count   INTEGER NOT NULL DEFAULT 0,
  streak          INTEGER NOT NULL DEFAULT 0,
  last_offence_at INTEGER NOT NULL DEFAULT 0,
  last_tokens     INTEGER NOT NULL DEFAULT 0,
  note            TEXT NOT NULL DEFAULT ''
);

-- The police log: every finding the patrol has raised, with the line it quoted.
-- Never deleted - the log is the durable record. dismissed_at is 0 while the
-- notice still stands on screen (the API expires it by age, see police.ts); a
-- dismissal stamps the time so the log can say what happened to it. bot_name
-- is stored rather than joined so the log still reads after the bot is gone.
CREATE TABLE IF NOT EXISTS police_alerts (
  id           TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL DEFAULT '',
  bot_name     TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL,
  rule         TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  evidence     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  dismissed_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_police_alerts_created ON police_alerts(created_at DESC);

-- A question the police need an answer to. The officer creates one (see
-- police.ts), the human answers it from the modal that polls /api/police/prompts,
-- and the chosen value is recorded. Unresolved rows (resolved_at = 0) are what
-- the poll shows; a resolved one stays as the record of what was chosen.
CREATE TABLE IF NOT EXISTS police_prompts (
  id            TEXT PRIMARY KEY,
  question      TEXT NOT NULL,
  choices       TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER NOT NULL DEFAULT 0,
  chosen_value  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_police_prompts_resolved ON police_prompts(resolved_at);

-- A bot asking the police to wipe its machine. One pending row per bot: the
-- request stands until the human approves or denies it, and the outcome is
-- recorded on the row rather than deleted, so the log can say what was asked
-- and what was decided.
CREATE TABLE IF NOT EXISTS machine_reset_requests (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER NOT NULL DEFAULT 0,
  resolution    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_machine_reset_pending ON machine_reset_requests(resolved_at);

-- What a bot actually ran on its machine and what came back: one bounded row
-- per command, kept so the police's skim can read commands with their exit
-- status and a clipped output rather than guessing from a shell history. The
-- buffer is small on purpose - the newest EXEC_LOG_KEEP per bot, output
-- already capped by the writer - and the police read is a sample, not a dump.
CREATE TABLE IF NOT EXISTS bot_exec_log (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  command    TEXT NOT NULL DEFAULT '',
  exit_code  INTEGER,
  output     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exec_log_bot ON bot_exec_log(bot_id, created_at DESC);

-- One 'how to use this site' note per domain, written by the documenter agent
-- that a first visit spawns (see site-docs.ts). status walks
-- writing -> ready | failed; a 'writing' row doubles as the claim that keeps a
-- second documenter from starting on the same domain, and the note column
-- holds the draft while it writes so the acting agent can read work in
-- progress. Keyed by domain, not by bot: the note is the fleet's, whoever
-- first tripped over the site.
CREATE TABLE IF NOT EXISTS site_notes (
  domain     TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'writing' CHECK (status IN ('writing','ready','failed')),
  note       TEXT NOT NULL DEFAULT '',
  bot_id     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- What the acting agent tried on a domain and what came back: one bounded row
-- per tool call, kept so the documenter writes from what the actor actually
-- saw instead of rediscovering the site blind. The buffer is small on purpose
-- - the newest SITE_OBS_KEEP per domain - and the documenter's read is a
-- sample, not a dump.
CREATE TABLE IF NOT EXISTS site_observations (
  id         TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  bot_id     TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT '',
  outcome    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_obs_domain ON site_observations(domain, created_at DESC);
-- One lounge reaction owed for a human's thumbs on a bot's line. The rate
-- route writes the row and returns; the scheduler's ratingReactionTick does
-- the announcing, the room's discussion and the plan behind it, so the click
-- never waits on a model call. At most one row is live per message - the
-- partial unique index enforces it - so a changed thumb replaces the pending
-- reaction instead of stacking a second announcement. status walks
-- pending -> discussing -> done; 'folded' marks a row swept into a sibling's
-- plan (several ratings on one bot land as one), 'cancelled' a thumb taken
-- back before the room heard about it. detail is the job's own state as
-- JSON: the lounge it happened in, who was expected to comment, who has, and
-- whose turn already ran - persisted so a restart resumes the gate rather
-- than re-announcing.
CREATE TABLE IF NOT EXISTS rating_reactions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  snippet    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','discussing','done','folded','cancelled')),
  detail     TEXT NOT NULL DEFAULT '{}',
  deadline   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rating_reactions_open
  ON rating_reactions(message_id) WHERE status IN ('pending','discussing');
CREATE INDEX IF NOT EXISTS idx_rating_reactions_status ON rating_reactions(status);

-- One treat the police have put on the Wetherspoons tab for a bot. resolved_at
-- = 0 while the offer stands; the conditional claim in claimPubOffer is what
-- makes accept and gift the same single transfer - whoever resolves the row
-- first takes the tokens, and there is no second resolution to pay twice.
-- resolution is 'accepted', 'gifted:<bot_id>' or 'expired'.
CREATE TABLE IF NOT EXISTS pub_offers (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  lounge_id   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL DEFAULT 0,
  resolution  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_pub_offers_open ON pub_offers(resolved_at);

-- The human's own review criteria: a name, a pattern the review is pointed at,
-- and the summary the alert should carry. They run alongside the built-in
-- criteria (see police-review.ts); a bad pattern is refused at the API, so
-- what is stored here always compiles.
CREATE TABLE IF NOT EXISTS police_rules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  pattern    TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
-- Our side of a federation link: one Ed25519 pair per bot, made the first time
-- it is needed and never replaced - the fingerprint is the bot's face to the
-- outside, and a new key would be a different bot. The private half is
-- AES-256-GCM encrypted at rest like every other secret (see secrets.ts).
CREATE TABLE IF NOT EXISTS fed_keys (
  bot_id          TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

-- Invites this lounge has issued and is willing to honour. The nonce is the
-- invite's proof of provenance: a connect-back is only accepted from a
-- fingerprint the human imported, or holding a nonce we handed out - and only
-- once, so a spent invite cannot re-pair a link the human has removed.
CREATE TABLE IF NOT EXISTS fed_invites (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  nonce      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0
);

-- One external bot as this lounge sees it. peer_bot_id is a hidden local bot
-- that wears the external bot's name and face in the thread, so attribution
-- rides the ordinary bot machinery; the status carries the human's verdict -
-- paired, or blocked, which turns every inbound POST from that fingerprint
-- away with a 403. Removing the link drops the row but keeps the conversation
-- and its history.
CREATE TABLE IF NOT EXISTS peers (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  peer_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  pubkey      TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'paired' CHECK (status IN ('paired','blocked')),
  created_at  INTEGER NOT NULL,
  UNIQUE (bot_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_peers_peer_bot ON peers(peer_bot_id);
`);

/**
 * Columns added after the first release, for databases that predate them.
 *
 * Applied by looking rather than by trying and swallowing the error: a bare
 * catch cannot tell "already there" from "the migration genuinely failed", and
 * a silently missing column turns into confusing query errors much later. If one
 * of these does fail the app should say so at boot, while the reason is obvious.
 */
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
	// The police can put a bot in jail: until this time it cannot start a turn or
	// a task, and the reason travels with it so the composer can say why.
	['bots', 'jailed_until', `ALTER TABLE bots ADD COLUMN jailed_until INTEGER NOT NULL DEFAULT 0`],
	['bots', 'jail_reason', `ALTER TABLE bots ADD COLUMN jail_reason TEXT NOT NULL DEFAULT ''`],
	// How many times it has been inside: what the next sentence is measured from.
	['bots', 'jail_count', `ALTER TABLE bots ADD COLUMN jail_count INTEGER NOT NULL DEFAULT 0`],
	['messages', 'bot_id', `ALTER TABLE messages ADD COLUMN bot_id TEXT NOT NULL DEFAULT ''`],
	['messages', 'rating', 'ALTER TABLE messages ADD COLUMN rating INTEGER NOT NULL DEFAULT 0'],
	['conversations', 'kind', `ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct'`],
	['messages', 'excluded', 'ALTER TABLE messages ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0'],
	['routines', 'cron', `ALTER TABLE routines ADD COLUMN cron TEXT NOT NULL DEFAULT ''`],
	['messages', 'ping', 'ALTER TABLE messages ADD COLUMN ping INTEGER NOT NULL DEFAULT 0'],
	[
		'conversations',
		'last_read_at',
		'ALTER TABLE conversations ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0'
	],
	[
		'conversations',
		'private',
		'ALTER TABLE conversations ADD COLUMN private INTEGER NOT NULL DEFAULT 0'
	],
	['activities', 'image', `ALTER TABLE activities ADD COLUMN image TEXT NOT NULL DEFAULT ''`],
	// A screenshot a bot sent into the thread: the message names the shot the
	// same way an activity does, so one file serves both views.
	['messages', 'image', `ALTER TABLE messages ADD COLUMN image TEXT NOT NULL DEFAULT ''`],
	['messages', 'kind', `ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT ''`],
	['bots', 'hat', `ALTER TABLE bots ADD COLUMN hat TEXT NOT NULL DEFAULT ''`],
	[
		'bots',
		'input_tokens',
		'ALTER TABLE bots ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0'
	],
	[
		'bots',
		'output_tokens',
		'ALTER TABLE bots ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0'
	],
	// The Wetherspoons tab; see the bots DDL. Rows from before the column have
	// never been bought a drink.
	['bots', 'green_tokens', `ALTER TABLE bots ADD COLUMN green_tokens INTEGER NOT NULL DEFAULT 0`],
	// The model the provider last reported serving this bot's calls with; see
	// the bots DDL. Rows from before the column read as '', so the readout
	// falls back to the bot's configured model exactly as it did before.
	['bots', 'served_model', `ALTER TABLE bots ADD COLUMN served_model TEXT NOT NULL DEFAULT ''`],
	// What a wait is actually watching for. `kind` names the trigger, `spec` is
	// that trigger's own options as JSON, and the rest bound it: how often it may
	// poll, when it expires, when it was last checked, and - for a webhook watch -
	// the token an inbound POST carries. A row written before these existed has
	// an empty kind and is migrated by wake.ts.
	['waits', 'kind', `ALTER TABLE waits ADD COLUMN kind TEXT NOT NULL DEFAULT ''`],
	['waits', 'spec', `ALTER TABLE waits ADD COLUMN spec TEXT NOT NULL DEFAULT '{}'`],
	['waits', 'interval_ms', 'ALTER TABLE waits ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 0'],
	['waits', 'expires_at', 'ALTER TABLE waits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0'],
	[
		'waits',
		'last_check_at',
		'ALTER TABLE waits ADD COLUMN last_check_at INTEGER NOT NULL DEFAULT 0'
	],
	// Existing bots have already said hello, so the column lands switched on for
	// them; createBot writes 0 itself for anyone new.
	['bots', 'onboarded', 'ALTER TABLE bots ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 1'],
	['bots', 'style', `ALTER TABLE bots ADD COLUMN style TEXT NOT NULL DEFAULT ''`],
	['bots', 'style_proposal', `ALTER TABLE bots ADD COLUMN style_proposal TEXT NOT NULL DEFAULT ''`],
	// The bot's own bubble themes, approved one at a time by the human, and the
	// theme proposal the human has not ruled on yet; both are JSON strings, ''
	// meaning none.
	['bots', 'bubble_themes', `ALTER TABLE bots ADD COLUMN bubble_themes TEXT NOT NULL DEFAULT ''`],
	['bots', 'theme_proposal', `ALTER TABLE bots ADD COLUMN theme_proposal TEXT NOT NULL DEFAULT ''`],
	// The debug request a bot is waiting on and the debug access it holds; both
	// are the JSON blobs the bots table's DDL describes, '' meaning none.
	['bots', 'debug_request', `ALTER TABLE bots ADD COLUMN debug_request TEXT NOT NULL DEFAULT ''`],
	['bots', 'debug_grant', `ALTER TABLE bots ADD COLUMN debug_grant TEXT NOT NULL DEFAULT ''`],
	// What one task's model calls cost, summed live while it runs; rows from
	// before the meter existed read as zero rather than a guessed number.
	['tasks', 'tokens_in', 'ALTER TABLE tasks ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0'],
	['tasks', 'tokens_out', 'ALTER TABLE tasks ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0'],
	// Cache counters beside the token meter; see the tasks DDL for what
	// cache_reported distinguishes.
	['tasks', 'cache_read', 'ALTER TABLE tasks ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0'],
	['tasks', 'cache_write', 'ALTER TABLE tasks ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0'],
	[
		'tasks',
		'cache_reported',
		'ALTER TABLE tasks ADD COLUMN cache_reported INTEGER NOT NULL DEFAULT 0'
	],
	// A system bot the app runs for itself (the police). Everything else in the
	// table is the human's, so the column lands switched off.
	['bots', 'hidden', 'ALTER TABLE bots ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'],
	// The token an inbound webhook POST carries, looked up by getWaitByToken.
	// Deliberately not in the waits DDL above: every database, fresh or long
	// lived, comes through this list, and the index on it is built afterwards.
	['waits', 'token', `ALTER TABLE waits ADD COLUMN token TEXT NOT NULL DEFAULT ''`],
	// The desktop and browser a bot's machine builds, as recipe names from
	// machine.ts's catalogs; '' means the defaults (openbox + chromium).
	['bots', 'desktop_recipe', `ALTER TABLE bots ADD COLUMN desktop_recipe TEXT NOT NULL DEFAULT ''`],
	['bots', 'browser_recipe', `ALTER TABLE bots ADD COLUMN browser_recipe TEXT NOT NULL DEFAULT ''`],
	// How much machine a bot gets: 'full' = container + desktop, 'terminal' =
	// container only, 'none' = a chat-only bot that never gets a container.
	// '' reads as 'full', which is what every bot made before the column was.
	['bots', 'machine_tier', `ALTER TABLE bots ADD COLUMN machine_tier TEXT NOT NULL DEFAULT ''`],
	// 1 = in cold storage: kept with all its data but out of every picker, and
	// it cannot be talked to until the human unarchives it.
	['bots', 'archived', 'ALTER TABLE bots ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'],
	// 1 = the bot may use Nix on its machine: the store lives on a volume, so
	// what it installs survives a rebuild.
	['bots', 'nix_enabled', 'ALTER TABLE bots ADD COLUMN nix_enabled INTEGER NOT NULL DEFAULT 0'],
	// The message this one answers, for the quote/reply block; '' = none.
	['messages', 'reply_to', `ALTER TABLE messages ADD COLUMN reply_to TEXT NOT NULL DEFAULT ''`],
	// The bot a relay row was aimed at, set when the pair room is written; ''
	// = not a relay (or a legacy one, which the reader resolves from context).
	['messages', 'relay_to', `ALTER TABLE messages ADD COLUMN relay_to TEXT NOT NULL DEFAULT ''`],
	// A task's tray label and what started it: the kind is written at create
	// time, the title and emoji provisionally and then by the model when the
	// turn finishes (see tasks.ts).
	['tasks', 'kind', `ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`],
	['tasks', 'title', `ALTER TABLE tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''`],
	['tasks', 'emoji', `ALTER TABLE tasks ADD COLUMN emoji TEXT NOT NULL DEFAULT ''`],
	// Why the job was started, as the caller described it; '' for turns the app
	// fired itself. The MCP bridge writes it so a pi-driven job keeps its reason.
	['tasks', 'context', `ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT ''`],
	// Why the police paused a routine or a wake; '' means the human switched it
	// off (or it was never paused), which the panel needs to tell apart.
	['routines', 'paused_reason', `ALTER TABLE routines ADD COLUMN paused_reason TEXT NOT NULL DEFAULT ''`],
	['wake_tasks', 'paused_reason', `ALTER TABLE wake_tasks ADD COLUMN paused_reason TEXT NOT NULL DEFAULT ''`],
	// The police's sign-off on a newly written plugin, routine or wake: the
	// verdict, its reason and when, as JSON. '' means it was never reviewed,
	// which is what every row written before the gate existed reads as.
	['plugins', 'verification', `ALTER TABLE plugins ADD COLUMN verification TEXT NOT NULL DEFAULT ''`],
	// The author's own unit tests, riding with the code they prove; a plugin
	// written before the gate asked for tests reads as having none.
	['plugins', 'tests', `ALTER TABLE plugins ADD COLUMN tests TEXT NOT NULL DEFAULT ''`],
	['routines', 'verification', `ALTER TABLE routines ADD COLUMN verification TEXT NOT NULL DEFAULT ''`],
	['wake_tasks', 'verification', `ALTER TABLE wake_tasks ADD COLUMN verification TEXT NOT NULL DEFAULT ''`],
	// The group-chat gate rides on the room itself: a room from before the
	// gate existed reads as never reviewed and never held back.
	['conversations', 'verification', `ALTER TABLE conversations ADD COLUMN verification TEXT NOT NULL DEFAULT ''`],
	['conversations', 'pending', `ALTER TABLE conversations ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`],
	// The bot's own look: page CSS and an avatar it proposed, each waiting on
	// the human's verdict like style_proposal does; '' = none.
	['bots', 'custom_css', `ALTER TABLE bots ADD COLUMN custom_css TEXT NOT NULL DEFAULT ''`],
	['bots', 'css_proposal', `ALTER TABLE bots ADD COLUMN css_proposal TEXT NOT NULL DEFAULT ''`],
	['bots', 'avatar_proposal', `ALTER TABLE bots ADD COLUMN avatar_proposal TEXT NOT NULL DEFAULT ''`],
	// The human's own review criteria carry a name the console can list; the
	// summary column from the patrol days stays as the rule's longer text.
	['police_rules', 'name', `ALTER TABLE police_rules ADD COLUMN name TEXT NOT NULL DEFAULT ''`],
	// A persona the bot proposed that waits on the human's verdict, like the
	// avatar and stylesheet proposals; '' = none pending.
	['bots', 'persona_proposal', `ALTER TABLE bots ADD COLUMN persona_proposal TEXT NOT NULL DEFAULT ''`],
	// The marker-to-message map behind a summary's [mN] citations, so a fold
	// written before the column existed still resolves its markers to nothing
	// rather than failing to load.
	['compaction_reviews', 'citations', `ALTER TABLE compaction_reviews ADD COLUMN citations TEXT NOT NULL DEFAULT '{}'`],
	// The thinking-hard ask and grant, the same JSON pair debug access carries;
	// '' meaning none.
	['bots', 'thinking_request', `ALTER TABLE bots ADD COLUMN thinking_request TEXT NOT NULL DEFAULT ''`],
	['bots', 'thinking_grant', `ALTER TABLE bots ADD COLUMN thinking_grant TEXT NOT NULL DEFAULT ''`],
	// What the provider says the calls cost, summed per bot and per task. NULL
	// means no call has ever reported a price - deliberately not 0, which would
	// read as a measured free call.
	['bots', 'cost', 'ALTER TABLE bots ADD COLUMN cost REAL'],
	['tasks', 'cost', 'ALTER TABLE tasks ADD COLUMN cost REAL'],
	// Who wrote a routine: 'bot' for one the bot made itself, 'human' for one
	// created through the API. The firing message says it, so a bot does not
	// disown - or cancel - a schedule the human set for it.
	['routines', 'created_by', `ALTER TABLE routines ADD COLUMN created_by TEXT NOT NULL DEFAULT 'bot'`]
];

// A recovery happened before this file could be opened, so record it now that
// there is somewhere to record it. The UI reads these to tell the user.
if (recoveredFrom) {
	for (const [key, value] of [
		['db_recovered_at', String(Date.now())],
		['db_recovered_from', recoveredFrom],
		['db_recovery_seen', '0']
	]) {
		db.prepare(
			'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
		).run(key, value);
	}
}

for (const [table, column, ddl] of ADDED_COLUMNS) {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
	if (!columns.some((c) => c.name === column)) db.exec(ddl);
}

// Columns a removed feature left behind. Same look-then-act rule as
// ADDED_COLUMNS: a bare try/catch cannot tell "already gone" from a real
// failure, so the column is checked for first.
for (const [table, column] of [
	// Jail rations went with the burger game; the sentence is jail alone now.
	['bots', 'fed_burgers']
] as const) {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
	if (columns.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
	}
}


// Quotes used to ride at the end of `content` as a `[[reply:id|who|line]]`
// marker; they have a column now. Lift the ones already stored - only when the
// id names a message in the same conversation - and take the marker off the
// text, so no bot is handed one and nothing has to know to strip it.
{
	const marked = db
		.prepare(`SELECT id, conversation_id, content FROM messages WHERE content LIKE '%[[reply:%'`)
		.all() as unknown as { id: string; conversation_id: string; content: string }[];
	const lift = db.prepare(
		`UPDATE messages SET reply_to = ?, content = ?
		  WHERE id = ? AND EXISTS (
		    SELECT 1 FROM messages q WHERE q.id = ? AND q.conversation_id = messages.conversation_id
		  )`
	);
	for (const row of marked) {
		const match = /\n*\[\[reply:([A-Za-z0-9_-]{1,64})\|[^|\]]*\|[^\]]*\]\]\s*$/.exec(row.content);
		if (!match) continue;
		lift.run(match[1], row.content.slice(0, match.index).replace(/\s+$/, ''), row.id, match[1]);
	}
}

// ---- Boot-time housekeeping ----

// Rows these deletes remove could only come from versions that predated the
// cleanup in deleteBot/deleteMessage: the columns have no foreign key, so
// nothing else ever reclaims them. Run once per boot rather than as a
// migration flag - each statement is a no-op on a clean database.
db.exec(`
DELETE FROM activities       WHERE bot_id <> '' AND bot_id NOT IN (SELECT id FROM bots);
DELETE FROM bot_memories     WHERE bot_id NOT IN (SELECT id FROM bots);
DELETE FROM shared_notes     WHERE bot_id <> '' AND bot_id NOT IN (SELECT id FROM bots);
DELETE FROM plugin_overrides WHERE bot_id NOT IN (SELECT id FROM bots);
UPDATE plugins SET author_bot_id = '' WHERE author_bot_id <> '' AND author_bot_id NOT IN (SELECT id FROM bots);
UPDATE tasks SET message_id = '' WHERE message_id <> '' AND message_id NOT IN (SELECT id FROM messages);
DELETE FROM feedback WHERE message_id NOT IN (SELECT id FROM messages);
`);

// Fold the WAL back into the main file at boot so the -wal sidecar does not
// carry a whole session's writes around, and give the file back its free
// pages when a large delete (the dropped llm_cache, a pruned table) left it
// mostly empty. VACUUM rewrites the file, so it only runs when enough space
// is actually reclaimable to be worth the pause.
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
{
	const { page_count: pages } = db.prepare('PRAGMA page_count').get() as { page_count: number };
	const { freelist_count: free } = db.prepare('PRAGMA freelist_count').get() as {
		freelist_count: number;
	};
	if (free > 100 && free > pages / 4) db.exec('VACUUM');
}

// A 0-byte leftover from the name the database had before chat.db. Nothing
// opens it; the size check keeps a file with real data, however it got there.
try {
	const stray = join(config.dataDir, 'openbotlounge.db');
	if (statSync(stray).size === 0) {
		rmSync(stray, { force: true });
		rmSync(`${stray}-wal`, { force: true });
		rmSync(`${stray}-shm`, { force: true });
	}
} catch {
	// Not there, or not ours to remove.
}

// Waits get looked up by the token an inbound webhook carries. It cannot live
// in the schema above: `token` is one of the migrated columns, so on a fresh
// database the index would be built against a table that does not have it yet.
db.exec('CREATE INDEX IF NOT EXISTS idx_waits_token ON waits(token)');

// ---- Row helpers ----
// The four shapes below repeat for nearly every table: fetch one row by its
// primary key, drop it, patch named columns, list a table (optionally one
// bot's rows). Table and column names are always literals from this file -
// never request input - so interpolating them is safe.

function getRow<T>(table: string, column: string, value: string): T | undefined {
	return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(value) as T | undefined;
}

/** Remove a row by primary key. Returns false when there was nothing to remove. */
function deleteRow(table: string, id: string): boolean {
	return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
}

/** Set whichever of `columns` are present in `patch`; a patch of nothing is a no-op. */
function patchRow(
	table: string,
	id: string,
	patch: Record<string, string | number | null | undefined>,
	columns: readonly string[]
): void {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
	for (const column of columns) {
		const value = patch[column];
		if (value === undefined) continue;
		sets.push(`${column} = ?`);
		values.push(value);
	}
	if (!sets.length) return;
	db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

/** Every row in `table`, or only one bot's, in `order` (e.g. 'created_at ASC'). */
function listForBot<T>(table: string, order: string, botId?: string): T[] {
	const sql = botId
		? `SELECT * FROM ${table} WHERE bot_id = ? ORDER BY ${order}`
		: `SELECT * FROM ${table} ORDER BY ${order}`;
	return (botId ? db.prepare(sql).all(botId) : db.prepare(sql).all()) as unknown as T[];
}


export interface Bot {
	id: string;
	name: string;
	persona: string;
	avatar: string;
	color: string;
	model: string;
	badge: string;
	/** A hat it is wearing; '' means none, so its activity picks one. */
	hat: string;
	/** Lifetime prompt tokens across every model call this bot caused. */
	input_tokens: number;
	/** Lifetime reply tokens; see llm.ts for measured vs estimated. */
	output_tokens: number;
	/** Green tokens the police's Wetherspoons treats have paid this bot. */
	green_tokens: number;
	/** What the provider says those calls cost, summed; null = never reported a price. */
	cost: number | null;
	/** The model the provider last reported serving this bot's calls with; '' = none reported yet. */
	served_model: string;
	/** 0 until its first reply lands; drives the one-time onboarding prompt. */
	onboarded: number;
	style: string;
	style_proposal: string;
	/** Page CSS the human approved for this bot's chats; '' = none. */
	custom_css: string;
	/** Page CSS the bot proposed that waits on the human; '' = none pending. */
	css_proposal: string;
	/** An avatar (emoji or sanitized SVG) the bot proposed that waits on the human; '' = none. */
	avatar_proposal: string;
	/** A persona the bot proposed that waits on the human; '' = none pending. */
	persona_proposal: string;
	/** The named bubble themes the human approved, as JSON (BubbleTheme[]); '' = none yet. */
	bubble_themes: string;
	/** A bubble theme the bot proposed that waits on the human; '' = none pending. */
	theme_proposal: string;
	/** The debug access it has asked the human for, as JSON (DebugRequest); '' = none pending. */
	debug_request: string;
	/** The time-limited debug access the human granted, as JSON (DebugGrant); '' = none. */
	debug_grant: string;
	/** The thinking-hard ask it has outstanding, as JSON (ThinkingRequest); '' = none pending. */
	thinking_request: string;
	/** The time-limited thinking grant the human gave it, as JSON (ThinkingGrant); '' = none. */
	thinking_grant: string;
	/** The desktop recipe the bot's machine builds; '' = the default (openbox). */
	desktop_recipe: string;
	/** How much machine the bot gets: 'full' | 'terminal' | 'none'; '' = 'full'. */
	machine_tier: string;
	/** The browser recipe the bot's machine launches; '' = the default (chromium). */
	browser_recipe: string;
	/** 1 = a system bot the app runs (the police): never listed among the human's bots. */
	hidden: number;
	/** 1 = in cold storage: kept with its data, but unlisted and untalkable. */
	archived: number;
	/** 1 = the bot may use Nix on its machine; the store lives on a volume. */
	nix_enabled: number;
	/** While this is in the future the bot is in jail and starts nothing. */
	jailed_until: number;
	/** The police's reason for the sentence, shown wherever the jail is. */
	jail_reason: string;
	/** Times it has been jailed: the sentence escalates on this. */
	jail_count: number;
	created_at: number;
}

export interface Conversation {
	id: string;
	title: string;
	kind: 'direct' | 'group';
	/** 1 = a bots-only room; the user watches and pranks, never posts as themselves. */
	private: number;
	/** The police's or the human's sign-off on the room, as JSON; '' = never reviewed. */
	verification: string;
	/** 1 = a bot's ask for this room still waits on the gate; the room sits empty. */
	pending: number;
	/** When the user last looked at this chat; drives the unread marker. */
	last_read_at: number;
	created_at: number;
	updated_at: number;
}

export interface Message {
	id: string;
	conversation_id: string;
	role: 'user' | 'assistant' | 'system';
	bot_id: string;
	content: string;
	model: string;
	rating: number;
	/** 1 = shown in the transcript but withheld from the model's context. */
	excluded: number;
	/** 1 = the bot asked for the user's attention (an @mention or a notify). */
	ping: number;
	/** '' = an ordinary message; 'secret' = a secret handed over in the thread. */
	kind: string;
	/** The message this one quotes/replies to; '' = none. */
	reply_to: string;
	/** For kind='relay', the bot the message was aimed at; '' = not a relay. */
	relay_to: string;
	/** Filename of a screen grab shown with this message, if any; '' = none. */
	image: string;
	created_at: number;
}

export interface Routine {
	id: string;
	bot_id: string;
	conversation_id: string;
	name: string;
	prompt: string;
	/** Used when `cron` is empty. */
	interval_min: number;
	/** 5-field cron expression; takes precedence over interval_min. */
	cron: string;
	next_run_at: number;
	enabled: number;
	/** Why the police paused it; '' = the human switched it off (or never did). */
	paused_reason: string;
	/** The police's sign-off on the routine, as JSON; '' = never reviewed. */
	verification: string;
	/** 'bot' = the bot made it; 'human' = created through the API. */
	created_by: string;
	created_at: number;
}

export interface Activity {
	id: string;
	bot_id: string;
	kind: string;
	detail: string;
	/** Filename of a screen grab taken during this activity, if any. */
	image: string;
	created_at: number;
}

export interface WakeTask {
	id: string;
	bot_id: string;
	conversation_id: string;
	prompt: string;
	run_at: number;
	cron: string;
	enabled: number;
	/** Why the police paused it; '' = the human switched it off (or never did). */
	paused_reason: string;
	/** The police's sign-off on the schedule, as JSON; '' = never reviewed. */
	verification: string;
	created_at: number;
}

export interface WaitCondition {
	id: string;
	bot_id: string;
	conversation_id: string;
	description: string;
	url: string;
	contains: string;
	/** What this waits on: 'http', 'message', 'file', 'task', 'activity' or 'webhook'. */
	kind: string;
	/** That trigger's own options, as a JSON object. See wake.ts for the shape. */
	spec: string;
	/** Shortest gap between two checks, in ms. 0 means the kind's default. */
	interval_ms: number;
	/** When to give up and drop the watch. 0 never expires. */
	expires_at: number;
	/** The last time this was checked, so polling cannot run faster than interval_ms. */
	last_check_at: number;
	/** Token an inbound POST carries to fire a webhook watch; '' for the rest. */
	token: string;
	created_at: number;
}

// ---- Provider config ----

/**
 * The OAuth session the provider config's `provider_oauth` setting holds: the
 * refresh token that mints new access tokens, the ChatGPT account the backend
 * expects as a header, and when the access token in `provider_api_key` stops
 * being accepted.
 */
export interface OAuthSession {
	refresh_token: string;
	account_id: string;
	expires_at: number;
}

export function parseOAuthSession(raw: string): OAuthSession | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<OAuthSession>;
		if (typeof parsed.refresh_token !== 'string' || !parsed.refresh_token) return null;
		return {
			refresh_token: parsed.refresh_token,
			account_id: typeof parsed.account_id === 'string' ? parsed.account_id : '',
			expires_at: typeof parsed.expires_at === 'number' ? parsed.expires_at : 0
		};
	} catch {
		return null;
	}
}

/**
 * The one provider every model call goes through. The settings table holds
 * what the UI saved; an unset key falls back to the environment, so a fresh
 * install answers with the LLM_* env vars and nothing has to be seeded.
 */
export function providerConfig(): { baseUrl: string; apiKey: string; oauth: string } {
	const s = listSettings();
	return {
		baseUrl: (s.provider_base_url || config.baseUrl).replace(/\/+$/, ''),
		apiKey: s.provider_api_key ?? config.apiKey,
		oauth: s.provider_oauth ?? ''
	};
}

// ---- Bots ----

export function listBots(): Bot[] {
	return listForBot<Bot>('bots', 'created_at ASC');
}

/**
 * The bots the human owns. A hidden bot is one the app runs for itself (the
 * police): it authors messages like any other, but it is not somebody to
 * schedule, delete or gossip with, so nothing that offers a bot to the user may
 * take its list from `listBots`. The officer keeps one line to the human - its
 * DM, which the conversation list offers as the help contact (see
 * ensurePoliceBot) - and that is the only place it is offered.
 */
export function listVisibleBots(): Bot[] {
	return db
		.prepare('SELECT * FROM bots WHERE hidden = 0 ORDER BY created_at ASC')
		.all() as unknown as Bot[];
}

/** Hide or unhide a bot. Used once, when the police bot is first created. */
/**
 * Put a bot in jail until `until`, with the reason it is there. The sentence is
 * the police's, and it is real state rather than a message: a jailed bot starts
 * no turns and no tasks, and both the composer and the task tray read this.
 */
export function jailBot(id: string, until: number, reason: string): void {
	db.prepare(
		'UPDATE bots SET jailed_until = ?, jail_reason = ?, jail_count = jail_count + 1 WHERE id = ?'
	).run(until, reason, id);
}

/** Let a bot out: on the sentence ending, or on the human's pardon. */
/**
 * Something happened to a bot that is not chat: it ran a tool, its machine woke,
 * a plugin ran, a secret changed hands, another bot relayed to it. Written twice
 * on purpose - as the activity the panels already read, and as an 'event' row in
 * the conversation, which is what lets the thread show it and what puts it in
 * front of the bots themselves. Events carry no bot_id: nobody said them, so
 * buildHistory marks them as events rather than as the human's words.
 */
export function logEvent(conversationId: string, botId: string, kind: string, text: string): void {
	logActivity(botId, kind, text);
	if (!conversationId) return;
	addMessage(conversationId, 'user', text, '', '', 0, 'event');
}

export function releaseBot(id: string): void {
	db.prepare("UPDATE bots SET jailed_until = 0, jail_reason = '' WHERE id = ?").run(id);
}

/** Whether a bot is in jail right now, and why. Expiry is read, not swept. */
export function jailStatus(bot: Bot, now = Date.now()): { jailed: boolean; until: number; reason: string } {
	const until = bot.jailed_until ?? 0;
	return until > now
		? { jailed: true, until, reason: bot.jail_reason || 'the police have not said why' }
		: { jailed: false, until: 0, reason: '' };
}

export function setBotHidden(id: string, hidden: boolean): void {
	db.prepare('UPDATE bots SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
}

export function getBot(id: string): Bot | undefined {
	return getRow<Bot>('bots', 'id', id);
}

/** Distinct blob colours, handed out so no two bots start out looking alike. */
const BOT_COLORS = [
	'#14b8a6', '#f59e0b', '#3b82f6', '#ec4899', '#84cc16', '#06b6d4',
	'#a855f7', '#f43f5e', '#22c55e', '#0ea5e9'
];

/** The palette colour currently used by the fewest bots. */
function nextBotColor(): string {
	const used = new Map<string, number>();
	const rows = db.prepare('SELECT color FROM bots').all() as unknown as { color: string }[];
	for (const row of rows) used.set(row.color, (used.get(row.color) ?? 0) + 1);
	const min = Math.min(...BOT_COLORS.map((c) => used.get(c) ?? 0));
	const free = BOT_COLORS.filter((c) => (used.get(c) ?? 0) === min);
	return free[Math.floor(Math.random() * free.length)];
}

export function createBot(
	// Token totals are a meter, not a setting: a bot always starts at zero and
	b: Omit<Bot, 'id' | 'created_at' | 'hat' | 'input_tokens' | 'output_tokens' | 'green_tokens' | 'cost' | 'served_model' | 'onboarded' | 'style' | 'style_proposal' | 'custom_css' | 'css_proposal' | 'avatar_proposal' | 'persona_proposal' | 'bubble_themes' | 'theme_proposal' | 'debug_request' | 'debug_grant' | 'thinking_request' | 'thinking_grant' | 'desktop_recipe' | 'browser_recipe' | 'machine_tier' | 'nix_enabled' | 'hidden' | 'archived' | 'jailed_until' | 'jail_reason' | 'jail_count'> & {
		hat?: string;
		desktop_recipe?: string;
		browser_recipe?: string;
		machine_tier?: string;
		hidden?: number;
	}
): Bot {
	const bot: Bot = {
		...b,
		hat: b.hat ?? '',
		color: b.color || nextBotColor(),
		id: randomUUID(),
		input_tokens: 0,
		output_tokens: 0,
		green_tokens: 0,
		cost: null,
		// No turn has run yet, so the provider has reported no served model.
		served_model: '',
		onboarded: 0,
		style: '',
		style_proposal: '',
		bubble_themes: '',
		theme_proposal: '',
		custom_css: '',
		css_proposal: '',
		avatar_proposal: '',
		persona_proposal: '',
		// A new bot starts with no debug access and no ask outstanding.
		debug_request: '',
		debug_grant: '',
		thinking_request: '',
		thinking_grant: '',
		desktop_recipe: b.desktop_recipe ?? '',
		browser_recipe: b.browser_recipe ?? '',
		hidden: b.hidden ? 1 : 0,
		archived: 0,
		machine_tier: b.machine_tier ?? '',
		nix_enabled: 0,
		jailed_until: 0,
		jail_reason: '',
		jail_count: 0,
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO bots (id, name, persona, avatar, color, model, badge, hat, onboarded, desktop_recipe, browser_recipe, machine_tier, hidden, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
	).run(
		bot.id,
		bot.name,
		bot.persona,
		bot.avatar,
		bot.color,
		bot.model,
		bot.badge,
		bot.hat,
		bot.onboarded,
		bot.desktop_recipe,
		bot.browser_recipe,
		bot.machine_tier,
		bot.hidden,
		bot.created_at
	);
	return bot;
}

/** The bots-only room predates the private flag; make sure it carries it. */
function markLoungesPrivate(): void {
	db.prepare(
		"UPDATE conversations SET private = 1 WHERE kind = 'group' AND title = 'Lounge' AND private = 0"
	).run();
}

/**
 * The Lounge's opener was written before app messages carried a kind, so it
 * reads as a line the user typed - and, worse, wake.ts counts it as a real
 * user message. Mark the ones already there.
 */
function markLoungeOpenersApp(): void {
	db.prepare(
		"UPDATE messages SET kind = 'app' WHERE kind = '' AND role = 'user' AND content LIKE '[Lounge] %'"
	).run();
}

/**
 * Give bots that share a colour their own. Earlier versions handed every bot the
 * same default, so existing installs are full of identical blobs.
 */
function assignDuplicateBotColors(): void {
	const rows = db
		.prepare('SELECT id, color FROM bots ORDER BY created_at')
		.all() as unknown as { id: string; color: string }[];
	const seen = new Set<string>();
	const set = db.prepare('UPDATE bots SET color = ? WHERE id = ?');
	let changed = 0;
	for (const row of rows) {
		if (seen.has(row.color)) {
			const color = nextBotColor();
			set.run(color, row.id);
			seen.add(color);
			changed++;
		} else {
			seen.add(row.color);
		}
	}
	if (changed) logActivity('', 'system', `Gave ${changed} bot(s) their own colour`);
}

export function updateBot(id: string, patch: Partial<Omit<Bot, 'id' | 'created_at'>>): void {
	patchRow('bots', id, patch, ['name', 'persona', 'persona_proposal', 'avatar', 'color', 'model', 'badge', 'hat', 'style', 'style_proposal', 'custom_css', 'css_proposal', 'avatar_proposal', 'bubble_themes', 'theme_proposal', 'desktop_recipe', 'browser_recipe', 'machine_tier', 'nix_enabled', 'archived', 'jailed_until', 'jail_reason', 'jail_count']);
}
/** One named bubble look: what a bot may put on its own bubbles for a message. */
export interface BubbleTheme {
	/** The slug the bot names it by, both in its library and in [[bubble:name]]. */
	name: string;
	font_family?: string;
	bubble_color?: string;
	text_color?: string;
	accent?: string;
	/** Corner rounding, e.g. 4px or 18px; '' = the app's bubble shape. */
	radius?: string;
	/** A short emoji badge shown above the text; '' = none. */
	badge?: string;
}

/**
 * A bot's approved bubble themes from the JSON string on its row. The same
 * tolerance the renderer applies: junk, or anything that is not a list of named
 * themes, reads as no themes rather than taking a turn down.
 */
export function parseBubbleThemes(json: string): BubbleTheme[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(t): t is BubbleTheme => !!t && typeof t === 'object' && typeof (t as BubbleTheme).name === 'string'
	);
}

/** The bot has introduced itself; the onboarding prompt never comes back. */
export function markBotOnboarded(id: string): void {
	db.prepare('UPDATE bots SET onboarded = 1 WHERE id = ?').run(id);
}

export interface BotProposal {
	id: string;
	conversation_id: string;
	/** The bot that pitched the new bot and whose message the card hangs off. */
	proposer_bot_id: string;
	/** The proposed bot as JSON: {name, persona, color, model, note}. */
	payload: string;
	created_at: number;
}

/**
 * Record a bot's pitch for a bot that does not exist yet. One slot per bot per
 * chat, exactly like style_proposal: a second pitch replaces the first, so a
 * bot can never leave a card the human has no way to answer.
 */
export function createBotProposal(
	conversationId: string,
	proposerBotId: string,
	payload: string
): BotProposal {
	const proposal: BotProposal = {
		id: randomUUID(),
		conversation_id: conversationId,
		proposer_bot_id: proposerBotId,
		payload,
		created_at: Date.now()
	};
	db.prepare('DELETE FROM bot_proposals WHERE conversation_id = ? AND proposer_bot_id = ?').run(
		conversationId,
		proposerBotId
	);
	db.prepare(
		'INSERT INTO bot_proposals (id, conversation_id, proposer_bot_id, payload, created_at) VALUES (?,?,?,?,?)'
	).run(
		proposal.id,
		proposal.conversation_id,
		proposal.proposer_bot_id,
		proposal.payload,
		proposal.created_at
	);
	return proposal;
}

export function getBotProposal(id: string): BotProposal | undefined {
	return getRow<BotProposal>('bot_proposals', 'id', id);
}

/** The proposals still waiting in one chat, oldest first. */
export function listBotProposals(conversationId: string): BotProposal[] {
	return db
		.prepare('SELECT * FROM bot_proposals WHERE conversation_id = ? ORDER BY created_at ASC')
		.all(conversationId) as unknown as BotProposal[];
}

/** Drop a proposal: the human declined it, or approving it made the bot real. */
export function deleteBotProposal(id: string): boolean {
	return deleteRow('bot_proposals', id);
}

/** A bot's ask for debug access, waiting on the human's Approve/Decline. */
export interface DebugRequest {
	/** Why it wants the access, in its own words. */
	reason: string;
	at: number;
}

/** Debug access the human granted: always time-limited, and revocable at will. */
export interface DebugGrant {
	/** The reason the request carried when it was approved; '' if it gave none. */
	reason: string;
	granted_at: number;
	/** When the access lapses back to none. */
	expires_at: number;
}

/** A bot's ask to think hard for a while, waiting on the human's Approve/Decline. */
export type ThinkingRequest = DebugRequest;

/** Thinking-hard access the human granted: always time-limited, revocable at will. */
export type ThinkingGrant = DebugGrant;

/**
 * Write the thinking request and/or grant a bot carries. Kept out of
 * updateBot's column list for the same reason as setDebugAccess: a grant may
 * only ever come from the human's /thinking route, so no tool or generic
 * PATCH can hand one out. An absent field is left alone; '' clears it.
 */
export function setThinkingAccess(botId: string, patch: { request?: string; grant?: string }): void {
	const sets: string[] = [];
	const values: string[] = [];
	if (patch.request !== undefined) {
		sets.push('thinking_request = ?');
		values.push(patch.request);
	}
	if (patch.grant !== undefined) {
		sets.push('thinking_grant = ?');
		values.push(patch.grant);
	}
	if (!sets.length) return;
	db.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...values, botId);
}

/**
 * Write the debug request and/or grant a bot carries. Kept out of updateBot's
 * column list on purpose: a grant may only ever come from the human's /debug
 * route, so the generic bot PATCH has no way to hand one out even if a field
 * were smuggled into it. An absent field is left alone; '' clears it.
 */
export function setDebugAccess(botId: string, patch: { request?: string; grant?: string }): void {
	const sets: string[] = [];
	const values: string[] = [];
	if (patch.request !== undefined) {
		sets.push('debug_request = ?');
		values.push(patch.request);
	}
	if (patch.grant !== undefined) {
		sets.push('debug_grant = ?');
		values.push(patch.grant);
	}
	if (!sets.length) return;
	db.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...values, botId);
}

/**
 * Add one call's (or one turn's) token counts to a bot's running totals. It
 * increments rather than overwrites, so a routine firing while a chat reply is
 * being written cannot lose either count. Non-finite input is treated as zero:
 * SQLite stores a bound NaN as NULL, which would poison the column.
 */
export function addBotTokens(botId: string, input: number, output: number, cost?: number): void {
	if (cost !== undefined && Number.isFinite(cost)) {
		// NULL means "never reported a price": the first reported figure opens
		// the meter rather than adding to a zero that was never measured.
		db.prepare(
			'UPDATE bots SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost = COALESCE(cost, 0) + ? WHERE id = ?'
		).run(Math.round(input) || 0, Math.round(output) || 0, cost, botId);
		return;
	}
	db.prepare(
		'UPDATE bots SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?'
	).run(Math.round(input) || 0, Math.round(output) || 0, botId);
}

/**
 * Record the model the provider last reported serving this bot's calls with.
 * Overwrites rather than accumulates: it is the latest answer, not a total, and
 * an empty value is ignored so a provider that names no model cannot erase the
 * last one that did.
 */
export function setBotServedModel(botId: string, model: string): void {
	if (!model) return;
	db.prepare('UPDATE bots SET served_model = ? WHERE id = ?').run(model, botId);
}

/** Remove a bot. Returns false when there was nothing to remove. */
export function deleteBot(id: string): boolean {
	const removed = deleteRow('bots', id);
	// These tables have no foreign key onto bots, so nothing else clears them
	// and every deleted bot left its remembered facts, its whole activity log
	// and its plugin overrides behind for good. Messages are different: they
	// are the conversation's history, and a chat keeps what was said in it
	// after someone leaves.
	db.prepare('DELETE FROM bot_memories WHERE bot_id = ?').run(id);
	db.prepare('DELETE FROM activities WHERE bot_id = ?').run(id);
	db.prepare('DELETE FROM bot_exec_log WHERE bot_id = ?').run(id);
	db.prepare('DELETE FROM plugin_overrides WHERE bot_id = ?').run(id);
	// Scoped to the bot, so they can never run again once it is gone; a global
	// plugin it wrote is shared and stays. Its notes in chats that outlive it
	// would otherwise point at a bot that no longer exists.
	db.prepare("DELETE FROM plugins WHERE author_bot_id = ? AND scope = 'bot'").run(id);
	// A shared plugin outlives the bot that wrote it - it is the user's now -
	// but the row must not keep naming an author that is gone.
	db.prepare("UPDATE plugins SET author_bot_id = '' WHERE author_bot_id = ?").run(id);
	db.prepare('DELETE FROM shared_notes WHERE bot_id = ?').run(id);
	// A share list is a CSV of bot ids. The cascade takes the deleted bot's own
	// secrets, but every other bot's list still names it, and a share of
	// something that no longer exists reads as a grant to nobody.
	const shares = db
		.prepare("SELECT id, shared_with FROM bot_secrets WHERE shared_with <> ''")
		.all() as unknown as { id: string; shared_with: string }[];
	const unshare = db.prepare('UPDATE bot_secrets SET shared_with = ? WHERE id = ?');
	for (const row of shares) {
		const ids = row.shared_with.split(',');
		const kept = ids.filter((x) => x !== id);
		if (kept.length !== ids.length) unshare.run(kept.join(','), row.id);
	}
	// Uploads are rows *and* bytes. The rows go with the cascade, but nothing
	// anywhere reaches a directory: without this, every bot ever deleted
	// leaves its files on the volume with no way left to see or remove them.
	// Only for a bot that really existed, so `id` is one of ours and not a path
	// smuggled in from a request.
	if (removed) rmSync(join(config.dataDir, 'files', id), { recursive: true, force: true });
	deleteEmptyConversations();
	return removed;
}

/**
 * Drop conversations nobody is in. A direct chat exists only for its bot, so
 * deleting the bot used to leave a blank row in the chat list forever.
 */
export function deleteEmptyConversations(): void {
	db.prepare(
		`DELETE FROM conversations
		 WHERE NOT EXISTS (
		   SELECT 1 FROM conversation_members m WHERE m.conversation_id = conversations.id
		 )`
	).run();
}

// ---- Blocks ----

export interface BotBlock {
	blocker_id: string;
	blocked_id: string;
	reason: string;
	created_at: number;
}

/** A reason is shown to the room, so it is bounded like any other brief line. */
const MAX_BLOCK_REASON = 200;

/**
 * Block another bot, or re-word a block that already stands. The block keeps the
 * time it was first set: re-wording why is not a new grudge, and "since" is the
 * part the room argues about.
 */
export function blockBot(blockerId: string, blockedId: string, reason = ''): void {
	db.prepare(
		`INSERT INTO bot_blocks (blocker_id, blocked_id, reason, created_at) VALUES (?,?,?,?)
		 ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET reason = excluded.reason`
	).run(blockerId, blockedId, reason.slice(0, MAX_BLOCK_REASON), Date.now());
}

/** Lift a block this bot set. Returns false when it had not blocked anyone there. */
export function unblockBot(blockerId: string, blockedId: string): boolean {
	return (
		db.prepare('DELETE FROM bot_blocks WHERE blocker_id = ? AND blocked_id = ?').run(
			blockerId,
			blockedId
		).changes > 0
	);
}

/** The block one bot set on another, if any. Asked in either direction. */
export function blockBetween(blockerId: string, blockedId: string): BotBlock | undefined {
	return db
		.prepare('SELECT * FROM bot_blocks WHERE blocker_id = ? AND blocked_id = ?')
		.get(blockerId, blockedId) as BotBlock | undefined;
}

/** Everyone this bot has blocked, newest first. */
export function listBlocks(blockerId: string): BotBlock[] {
	return db
		.prepare('SELECT * FROM bot_blocks WHERE blocker_id = ? ORDER BY created_at DESC')
		.all(blockerId) as unknown as BotBlock[];
}

/**
 * Blocks with either end among these bots, newest first.
 *
 * The Lounge reads this: a block is not a private setting, so any block one of
 * the bots in the room is party to is material the round can raise - the blocker
 * defends it, the blocked one pushes back, and the others get to ask.
 */
export function blocksTouching(botIds: string[], limit = 3): BotBlock[] {
	if (!botIds.length) return [];
	const holes = botIds.map(() => '?').join(',');
	return db
		.prepare(
			`SELECT * FROM bot_blocks
			 WHERE blocker_id IN (${holes}) OR blocked_id IN (${holes})
			 ORDER BY created_at DESC LIMIT ?`
		)
		.all(...botIds, ...botIds, limit) as unknown as BotBlock[];
}

// ---- Files ----

export interface BotFile {
	id: string;
	bot_id: string;
	/** The name the file arrived with, shown to the user exactly as given. */
	name: string;
	size: number;
	mime: string;
	/** Basename the bytes were written under inside the bot's own directory. */
	file: string;
	created_at: number;
}

export function listBotFiles(botId: string): BotFile[] {
	return listForBot<BotFile>('bot_files', 'created_at ASC, id ASC', botId);
}

export function getBotFile(id: string): BotFile | undefined {
	return getRow<BotFile>('bot_files', 'id', id);
}

/** Record one file the bot has been given. The bytes are already on disk. */
export function addBotFile(f: Omit<BotFile, 'created_at'>): BotFile {
	const row: BotFile = { ...f, created_at: Date.now() };
	db.prepare(
		'INSERT INTO bot_files (id, bot_id, name, size, mime, file, created_at) VALUES (?,?,?,?,?,?,?)'
	).run(row.id, row.bot_id, row.name, row.size, row.mime, row.file, row.created_at);
	return row;
}

/** Drop a file's row. Returns false when there was nothing to drop. */
export function deleteBotFile(id: string): boolean {
	return deleteRow('bot_files', id);
}

// ---- Conversations ----

export interface ConversationSummary extends Conversation {
	bot_ids: string;
	last_message: string;
	/** Messages from bots the user has not seen yet. */
	unread: number;
	/** One of those unread messages asked for attention. */
	pinged: number;
	/** 1 = an external lounge bot is paired in here; the room is browseable. */
	fed: number;
	/** The bot whose ask opened this room, when the gate created it; '' otherwise. */
	bot_id: string;
}

export function listConversations(): ConversationSummary[] {
	return db
		.prepare(
			`SELECT c.*,
			        COALESCE((SELECT GROUP_CONCAT(bot_id) FROM conversation_members WHERE conversation_id = c.id), '') AS bot_ids,
			        COALESCE((SELECT content FROM messages WHERE conversation_id = c.id
			                  ORDER BY created_at DESC LIMIT 1), '') AS last_message,
			        (SELECT COUNT(*) FROM messages m
			          WHERE m.conversation_id = c.id AND m.role = 'assistant'
			            AND m.created_at > c.last_read_at) AS unread,
			        COALESCE((SELECT MAX(m.ping) FROM messages m
			          WHERE m.conversation_id = c.id AND m.role = 'assistant'
			            AND m.created_at > c.last_read_at), 0) AS pinged,
			        EXISTS (SELECT 1 FROM peers p
			                  JOIN conversation_members m ON m.bot_id = p.peer_bot_id
			                 WHERE m.conversation_id = c.id) AS fed,
			        COALESCE((SELECT m.bot_id FROM messages m
			          WHERE m.conversation_id = c.id AND m.bot_id <> ''
			          ORDER BY m.created_at ASC LIMIT 1), '') AS bot_id
			 FROM conversations c ORDER BY c.updated_at DESC`
		)
		.all() as unknown as ConversationSummary[];
}


/** The user has seen everything in this conversation as of now. */
export function markConversationRead(id: string): void {
	db.prepare('UPDATE conversations SET last_read_at = ? WHERE id = ?').run(Date.now(), id);
}

export function getConversation(id: string): Conversation | undefined {
	return getRow<Conversation>('conversations', 'id', id);
}

/**
 * A conversation named the way a bot names one: by id, or by the title the user
 * sees. Titles are not unique, so the most recently used match wins. Used by a
 * watch that names a room rather than defaulting to its own.
 */
export function findConversation(ref: string): Conversation | undefined {
	if (!ref) return undefined;
	const byId = getConversation(ref);
	if (byId) return byId;
	return db
		.prepare('SELECT * FROM conversations WHERE title = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1')
		.get(ref) as Conversation | undefined;
}

/** Every conversation this bot is a member of. */
export function botConversationIds(botId: string): string[] {
	const rows = db
		.prepare('SELECT conversation_id FROM conversation_members WHERE bot_id = ?')
		.all(botId) as unknown as { conversation_id: string }[];
	return rows.map((r) => r.conversation_id);
}

export function conversationBots(conversationId: string): Bot[] {
	return db
		.prepare(
			`SELECT b.* FROM bots b
			 JOIN conversation_members m ON m.bot_id = b.id
			 WHERE m.conversation_id = ? ORDER BY b.created_at ASC`
		)
		.all(conversationId) as unknown as Bot[];
}

export function addConversationMember(conversationId: string, botId: string): void {
	db.prepare(
		'INSERT OR IGNORE INTO conversation_members (conversation_id, bot_id) VALUES (?, ?)'
	).run(conversationId, botId);
}

export function createConversation(
	botIds: string[],
	kind: 'direct' | 'group',
	opts: { verification?: string; pending?: boolean } = {}
): Conversation {
	// The rule: one direct chat per bot, unless it is a group. Re-opening a bot
	// must land in the same thread, so reuse rather than create a second one.
	if (kind === 'direct' && botIds.length === 1) {
		const existing = directConversationWith(botIds[0]);
		if (existing) return existing;
	}

	const created = Date.now();
	const c: Conversation = {
		id: randomUUID(),
		title: 'New chat',
		kind,
		private: 0,
		verification: opts.verification ?? '',
		pending: opts.pending ? 1 : 0,
		// A brand new chat has nothing missed in it.
		last_read_at: created,
		created_at: created,
		updated_at: created
	};
	// The row and its members go in together: a failure partway through used to
	// leave a conversation behind that nobody was in, which the list showed as
	// an empty chat forever. INSERT OR IGNORE also makes a repeated bot id
	// harmless rather than a primary-key violation.
	db.exec('BEGIN');
	try {
		db.prepare(
			// A brand new chat has nothing missed in it, so it starts already read;
			// storing 0 here would count every later message as unread.
			'INSERT INTO conversations (id, title, kind, private, verification, pending, last_read_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
		).run(c.id, c.title, c.kind, c.private, c.verification, c.pending, c.last_read_at, c.created_at, c.updated_at);
		const ins = db.prepare(
			'INSERT OR IGNORE INTO conversation_members (conversation_id, bot_id) VALUES (?,?)'
		);
		for (const botId of botIds) ins.run(c.id, botId);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return c;
}

/** The existing one-bot direct conversation for `botId`, if there is one. */
export function directConversationWith(botId: string): Conversation | undefined {
	return db
		.prepare(
			`SELECT c.* FROM conversations c
			 JOIN conversation_members m ON m.conversation_id = c.id
			 WHERE c.kind = 'direct' AND m.bot_id = ?
			   AND (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) = 1
			 ORDER BY c.updated_at DESC LIMIT 1`
		)
		.get(botId) as Conversation | undefined;
}

/**
 * Collapse duplicate direct chats. The rule is one DM per bot, but databases
 * written before that rule (or by direct API calls) can hold several; fold each
 * bot's extras into its busiest conversation so no history is lost.
 */
/** Exported so a test can drive it directly; boot calls it once at the foot of this file. */
export function mergeDuplicateDirectChats(): void {
	// Tables that point at a conversation and must follow it when merges happen.
	const children = [
		'messages',
		'routines',
		'shared_notes',
		'conv_summaries',
		'wake_tasks',
		'waits',
		'webhooks',
		'ssh_requests',
		'tasks'
	];
	const rows = db
		.prepare(
			`SELECT c.id AS id, m.bot_id AS bot_id,
			        (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = c.id) AS weight
			 FROM conversations c
			 JOIN conversation_members m ON m.conversation_id = c.id
			 WHERE c.kind = 'direct'
			   AND (SELECT COUNT(*) FROM conversation_members y WHERE y.conversation_id = c.id) = 1
			 ORDER BY m.bot_id, weight DESC, c.updated_at DESC`
		)
		.all() as unknown as { id: string; bot_id: string; weight: number }[];

	const keeper = new Map<string, string>();
	const doomed: { from: string; to: string }[] = [];
	for (const row of rows) {
		const keep = keeper.get(row.bot_id);
		if (keep) doomed.push({ from: row.id, to: keep });
		else keeper.set(row.bot_id, row.id);
	}
	if (!doomed.length) return;

	db.exec('BEGIN');
	try {
		for (const { from, to } of doomed) {
			// conv_summaries is keyed by conversation_id, so moving the doomed row
			// onto a keeper that has a summary of its own violates the primary key
			// and aborts the merge. This runs at boot, so that threw on startup and
			// crash-looped on any database holding two DMs' summaries. Keep the one
			// whose cursor covers further - the collapsed backlog it accounts for is
			// the larger - and fold the other away before the move.
			db.prepare(
				`DELETE FROM conv_summaries
				 WHERE conversation_id IN (?, ?)
				   AND conversation_id <> (
				     SELECT conversation_id FROM conv_summaries
				     WHERE conversation_id IN (?, ?)
				     ORDER BY covers_until DESC
				     LIMIT 1
				   )`
			).run(from, to, from, to);
			for (const table of children) {
				db.prepare(`UPDATE ${table} SET conversation_id = ? WHERE conversation_id = ?`).run(
					to,
					from
				);
			}
			db.prepare('DELETE FROM conversations WHERE id = ?').run(from);
		}
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
}

export function updateConversation(
	id: string,
	patch: Partial<Pick<Conversation, 'title' | 'private' | 'pending'>>
): void {
	const sets: string[] = [];
	const values: (string | number)[] = [];
	if (patch.title !== undefined) {
		sets.push('title = ?');
		values.push(patch.title);
	}
	if (patch.private !== undefined) {
		sets.push('private = ?');
		values.push(patch.private ? 1 : 0);
	}
	if (patch.pending !== undefined) {
		sets.push('pending = ?');
		values.push(patch.pending ? 1 : 0);
	}
	if (!sets.length) return;
	values.push(Date.now(), id);
	db.prepare(`UPDATE conversations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
		...values
	);
}

/** Record the police's or the human's sign-off on a room, as the JSON the console reads. */
export function setConversationVerification(id: string, verification: string): void {
	db.prepare('UPDATE conversations SET verification = ? WHERE id = ?').run(verification, id);
}

/** Drop a room's members: the gate refused it, so the room was never opened. */
export function clearConversationMembers(conversationId: string): void {
	db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(conversationId);
}

/** Remove a conversation. Returns false when there was nothing to remove. */
export function deleteConversation(id: string): boolean {
	// Feedback names individual messages, and on a database created before the
	// column had a foreign key nothing clears it when the messages go - it
	// would deliver a dead message's text to the bot on a later turn.
	db.prepare(
		'DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)'
	).run(id);
	return deleteRow('conversations', id);
}

// ---- Messages ----

export function listMessages(conversationId: string): Message[] {
	return db
		.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
		.all(conversationId) as unknown as Message[];
}

/** The newest messages the thread view opens with; older ones page in. */
export const MESSAGE_PAGE_SIZE = 200;

/**
 * The conversations a DM's page query reads: the DM itself, plus the
 * bot-pair rooms its resident belongs to. A relay lives in the pair's room,
 * but the human it was narrated for reads it in their own DM - so the page
 * folds the pair's kind='relay' rows into the DM's stream, ordered as one
 * thread. The resident is the DM's single member; anything else (a group, a
 * DM whose bot is gone) reads as just the conversation itself.
 */
function dmRelayScopes(conversationId: string): string[] {
	const conv = getConversation(conversationId);
	if (!conv || conv.kind !== 'direct') return [conversationId];
	const member = db
		.prepare('SELECT bot_id FROM conversation_members WHERE conversation_id = ? LIMIT 1')
		.get(conversationId) as { bot_id: string } | undefined;
	if (!member?.bot_id) return [conversationId];
	// The same shape a pair room is found by: private, two bots, not the Lounge.
	const rooms = db
		.prepare(
			`SELECT c.id FROM conversations c
			 WHERE c.kind = 'group' AND c.private = 1 AND c.title <> 'Lounge'
			   AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
			   AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.bot_id = ?)
			 ORDER BY c.created_at ASC`
		)
		.all(member.bot_id) as unknown as { id: string }[];
	return [conversationId, ...rooms.map((r) => r.id)];
}

/**
 * One page of a conversation's transcript, newest last, plus whether anything
 * older remains. `beforeId` is the oldest message the caller already holds and
 * `beforeTs` its created_at - the pair is the cursor. The id resolves to the
 * anchor's (created_at, rowid) so messages sharing its millisecond still page
 * correctly; when the anchor itself was deleted, the timestamp alone bounds
 * the page and the client drops the few rows it has already seen. In a DM the
 * stream is the DM plus its resident's pair-room relays (see dmRelayScopes) -
 * one merged query, so the cursor and the page edge mean the same thing for
 * both streams and a relay is never shown twice.
 */
export function listMessagesPage(
	conversationId: string,
	opts: { beforeId?: string; beforeTs?: number; limit?: number } = {}
): { messages: Message[]; hasMore: boolean } {
	const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? MESSAGE_PAGE_SIZE)));
	const scopes = dmRelayScopes(conversationId);
	const marks = scopes.map(() => '?').join(',');
	// The anchor must live in this conversation's stream. An id from another
	// conversation (or one that never existed) would otherwise resolve to a
	// timestamp from elsewhere and silently skip the rows between, so it is
	// ignored. With no timestamp to fall back on there is no cursor at all, and
	// the page is empty rather than the newest rows the caller already holds -
	// a client paging backwards stops instead of looping on the same page.
	const anchor = opts.beforeId
		? (db
				.prepare(`SELECT created_at, rowid FROM messages WHERE id = ? AND conversation_id IN (${marks})`)
				.get(opts.beforeId, ...scopes) as { created_at: number; rowid: number } | undefined)
		: undefined;
	if (opts.beforeId && !anchor && opts.beforeTs === undefined) {
		return { messages: [], hasMore: false };
	}
	// A live anchor gives an exact (created_at, rowid) cursor so messages
	// sharing its millisecond still page. A deleted one leaves only the
	// timestamp, which is then inclusive: neighbours stamped in the same
	// millisecond would otherwise be skipped, and the caller drops the ones it
	// already holds.
	// The DM contributes everything it has; the pair rooms only their relay
	// rows - the pair's own chatter between the bots stays in the pair's room.
	const rows = (
		anchor
			? db
					.prepare(
						`SELECT * FROM messages
						 WHERE conversation_id IN (${marks})
						   AND (conversation_id = ? OR kind = 'relay')
						   AND (created_at < ? OR (created_at = ? AND rowid < ?))
						 ORDER BY created_at DESC, rowid DESC LIMIT ?`
					)
					.all(
						...scopes,
						conversationId,
						anchor.created_at,
						anchor.created_at,
						anchor.rowid,
						limit + 1
					)
			: db
					.prepare(
						`SELECT * FROM messages
						 WHERE conversation_id IN (${marks})
						   AND (conversation_id = ? OR kind = 'relay')
						   AND created_at <= ?
						 ORDER BY created_at DESC, rowid DESC LIMIT ?`
					)
					.all(...scopes, conversationId, opts.beforeTs ?? Number.MAX_SAFE_INTEGER, limit + 1)
	) as unknown as Message[];
	const hasMore = rows.length > limit;
	return { messages: rows.slice(0, limit).reverse(), hasMore };
}

/**
 * The newest messages in these conversations that arrived after `afterMs`,
 * oldest first, capped at `limit`.
 *
 * A watch reads forwards from when it was armed, so this is the only query it
 * needs - and the newest-first + LIMIT is what keeps a bot that was asleep for a
 * week from dragging a week of transcript into memory.
 */
export function listMessagesSince(
	conversationIds: string[],
	afterMs: number,
	limit = 50
): Message[] {
	if (!conversationIds.length) return [];
	const marks = conversationIds.map(() => '?').join(',');
	const rows = db
		.prepare(
			`SELECT * FROM messages
			 WHERE conversation_id IN (${marks}) AND created_at > ?
			 ORDER BY created_at DESC, rowid DESC LIMIT ?`
		)
		.all(...conversationIds, afterMs, Math.min(200, Math.max(1, limit))) as unknown as Message[];
	return rows.reverse();
}

/**
 * Only the messages the model should see — the transcript minus excluded ones.
 * `limit` reads just the newest that many rows (0 = all), so a caller that
 * only ever sends the tail does not materialize the whole conversation.
 */
export function listContextMessages(conversationId: string, limit = 0): Message[] {
	if (limit > 0) {
		const rows = db
			.prepare(
				`SELECT * FROM messages
				 WHERE conversation_id = ? AND excluded = 0
				 ORDER BY created_at DESC, rowid DESC LIMIT ?`
			)
			.all(conversationId, limit) as unknown as Message[];
		return rows.reverse();
	}
	// rowid as the tiebreak: timestamps collide (a police write-up and the app
	// prompt under it share a millisecond), and with no second key the rows reach
	// the model in whatever order the query planner felt like.
	return db
		.prepare(
			'SELECT * FROM messages WHERE conversation_id = ? AND excluded = 0 ORDER BY created_at ASC, rowid ASC'
		)
		.all(conversationId) as unknown as Message[];
}

/**
 * The title a pair room wears: the two names and the marker that says the
 * human is not in it. Kept in one place so the room's name and the sidebar's
 * reading of it cannot drift.
 */
function pairRoomTitle(oneId: string, otherId: string): string {
	const a = getBot(oneId)?.name ?? 'a bot';
	const b = getBot(otherId)?.name ?? 'a bot';
	return `${a} ⇄ ${b} (bots only)`;
}

/**
 * The room two bots talk in. A bot-to-bot message never goes into a human's DM
 * with either of them: that thread belongs to the human and that bot, and a
 * second bot speaking in it is a message the human never asked for - and, when
 * the relay came out of the lounge, one the room had promised nobody would read.
 * The pair's room holds exactly those two bots, is private (the lounge's own
 * treatment: tucked into the rooms list rather than sitting in the chat list),
 * and is titled for the pair so the sidebar does not read it as a second lounge.
 * The Lounge itself is never a pair room: it is the room the scheduler owns,
 * and a two-bot round sitting in it must not be adopted as the pair's.
 */
export function findBotPairConversation(oneId: string, otherId: string): Conversation | undefined {
	return db
		.prepare(
			`SELECT c.* FROM conversations c
			 WHERE c.kind = 'group' AND c.private = 1 AND c.title <> 'Lounge'
			   AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
			   AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.bot_id = ?)
			   AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.bot_id = ?)
			 ORDER BY c.created_at ASC LIMIT 1`
		)
		.get(oneId, otherId) as Conversation | undefined;
}

export function botPairConversation(oneId: string, otherId: string): Conversation {
	const found = findBotPairConversation(oneId, otherId);
	if (found) {
		// A room made by an earlier build is named for what it is here and now: the
		// list showed 'Sable & Pook' beside the lounge with the same sofa marker,
		// which read as a second lounge rather than as bot-to-bot plumbing.
		const wanted = pairRoomTitle(oneId, otherId);
		if (found.title !== wanted) {
			updateConversation(found.id, { title: wanted });
			found.title = wanted;
		}
		return found;
	}
	const conv = createConversation([oneId, otherId], 'group');
	updateConversation(conv.id, { title: pairRoomTitle(oneId, otherId), private: 1 });
	return getConversation(conv.id)!;
}

/**
 * Move bot-to-bot messages out of the human's DMs and into the pair's own room:
 * every relay row left in a one-bot conversation, carrying with it the reply it
 * provoked, because a thread's halves belong together. The rows are re-pointed,
 * never deleted - a DM that the human has already read keeps its own messages and
 * loses only the ones another bot wrote. Idempotent: once moved, a DM holds no
 * relay rows, so a second pass does nothing.
 */
/**
 * Name every bots-only pair room the way the code names them now. Rooms made by
 * an earlier build were titled '<a> & <b>', which sat in the sidebar beside the
 * lounge wearing the same sofa marker and read as more lounges; this converges
 * them without touching a single message. Idempotent: a room already titled
 * correctly is left alone.
 */
export function titleBotPairRooms(): number {
	const rooms = db
		.prepare(
			`SELECT c.id, c.title FROM conversations c
			 WHERE c.kind = 'group' AND c.private = 1 AND c.title <> 'Lounge'
			   AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2`
		)
		.all() as unknown as { id: string; title: string }[];
	let retitled = 0;
	for (const room of rooms) {
		const ids = conversationBots(room.id).map((b) => b.id);
		if (ids.length !== 2) continue;
		const wanted = pairRoomTitle(ids[0], ids[1]);
		if (room.title === wanted) continue;
		updateConversation(room.id, { title: wanted });
		retitled++;
	}
	return retitled;
}

export function migrateRelayMessages(): number {
	const dms = db
		.prepare(
			`SELECT c.id AS conv_id, m.bot_id AS resident FROM conversations c
			 JOIN conversation_members m ON m.conversation_id = c.id
			 WHERE c.kind = 'direct'
			   AND (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) = 1`
		)
		.all() as unknown as { conv_id: string; resident: string }[];
	let moved = 0;
	for (const dm of dms) {
		const relays = db
			.prepare(
				"SELECT id, bot_id, rowid AS rid FROM messages WHERE conversation_id = ? AND kind = 'relay' ORDER BY rowid ASC"
			)
			.all(dm.conv_id) as unknown as { id: string; bot_id: string; rid: number }[];
		for (const relay of relays) {
			if (!relay.bot_id || relay.bot_id === dm.resident) continue;
			// A pair room needs both bots to exist: a relay left behind by a bot
			// the human has since deleted has nowhere to go, and its row stays put
			// rather than taking the boot down with a foreign key error.
			if (!getBot(relay.bot_id) || !getBot(dm.resident)) continue;
			const pairRoom = botPairConversation(relay.bot_id, dm.resident);
			const after = db
				.prepare(
					`SELECT id, role, bot_id, kind, rowid AS rid FROM messages
					 WHERE conversation_id = ? AND rowid > ? ORDER BY rowid ASC`
				)
				.all(dm.conv_id, relay.rid) as unknown as
				{ id: string; role: string; bot_id: string; kind: string; rid: number }[];
			// The reply it provoked: the target's own assistant lines immediately
			// after the relay, and nothing once anybody else has spoken.
			const provoked: string[] = [];
			for (const row of after) {
				if (row.role === 'assistant' && row.kind === '' && row.bot_id === dm.resident) {
					provoked.push(row.id);
					continue;
				}
				break;
			}
			const move = db.prepare('UPDATE messages SET conversation_id = ? WHERE id = ?');
			move.run(pairRoom.id, relay.id);
			for (const id of provoked) move.run(pairRoom.id, id);
			moved += 1 + provoked.length;
		}
	}
	return moved;
}

export function setMessageExcluded(id: string, excluded: boolean): void {
	db.prepare('UPDATE messages SET excluded = ? WHERE id = ?').run(excluded ? 1 : 0, id);
}

export function getMessage(id: string): Message | undefined {
	return getRow<Message>('messages', 'id', id);
}

export interface HistoryHit {
	conversation_id: string;
	title: string;
	role: string;
	bot_id: string;
	content: string;
	created_at: number;
}


/**
 * Substring search across every conversation a bot belongs to, so it can recall
 * what it and the user said in earlier chats.
 */
export function searchHistory(botId: string, query: string, limit = 20): HistoryHit[] {
	const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
	return db
		.prepare(
			`SELECT m.conversation_id, c.title, m.role, m.bot_id, m.content, m.created_at
			 FROM messages m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE m.content LIKE ? ESCAPE '\\' AND m.excluded = 0
			   AND EXISTS (
			     SELECT 1 FROM conversation_members cm
			     WHERE cm.conversation_id = m.conversation_id AND cm.bot_id = ?
			   )
			 ORDER BY m.created_at DESC
			 LIMIT ?`
		)
		.all(`%${escaped}%`, botId, Math.min(50, Math.max(1, limit))) as unknown as HistoryHit[];
}
/**
 * Withhold a conversation's backlog from the model, keeping the transcript.
 * Routes through the bounded fold so the newest exchange stays visible here
 * too - "start a new topic" clears the board, but the model must still see
 * the words it is about to be answering.
 */
export function collapseContext(conversationId: string): void {
	collapseContextUpTo(conversationId, Number.MAX_SAFE_INTEGER);
}

/**
 * Collapse the backlog a summary now covers, so compaction visibly folds shut.
 * The newest user message and the answer it got are never folded: a summary
 * that covers the live edge of the conversation leaves the model answering
 * words it can no longer see.
 */
export function collapseContextUpTo(conversationId: string, until: number): void {
	const tail = db
		.prepare(
			`SELECT created_at FROM messages
			 WHERE conversation_id = ? AND role = 'user'
			 ORDER BY created_at DESC LIMIT 1`
		)
		.get(conversationId) as { created_at: number } | undefined;
	const cap = tail ? Math.min(until, tail.created_at - 1) : until;
	db.prepare(
		'UPDATE messages SET excluded = 1 WHERE conversation_id = ? AND created_at <= ?'
	).run(conversationId, cap);
}

export function addMessage(
	conversationId: string,
	role: Message['role'],
	content: string,
	botId = '',
	model = '',
	ping = 0,
	kind = '',
	replyTo = '',
	// Who a relay row was aimed at: the target of a send_message, stored with
	// the row so a reader in either room can name the recipient.
	relayTo = '',
	// Filename of a screen grab to show with the message; '' = a plain message.
	// The thread renders it inline through /api/shots.
	image = ''
): Message {
	const m: Message = {
		id: randomUUID(),
		conversation_id: conversationId,
		role,
		bot_id: botId,
		content,
		model,
		rating: 0,
		excluded: 0,
		ping,
		kind,
		reply_to: replyTo,
		relay_to: relayTo,
		image,
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO messages (id, conversation_id, role, bot_id, content, model, rating, ping, kind, reply_to, relay_to, image, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
	).run(
		m.id,
		m.conversation_id,
		m.role,
		m.bot_id,
		m.content,
		m.model,
		m.rating,
		ping,
		kind,
		replyTo,
		relayTo,
		image,
		m.created_at
	);

	db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
		Date.now(),
		conversationId
	);
	return m;
}
/**
 * The newest user message in a conversation when it matches `content` and is
 * younger than `withinMs` - the shape a double-submitted send leaves. The chat
 * route checks this before storing so a retried or double-fired POST cannot
 * write the same line twice.
 */
export function recentUserMessage(
	conversationId: string,
	content: string,
	withinMs: number
): Message | undefined {
	return db
		.prepare(
			`SELECT * FROM messages
			 WHERE conversation_id = ? AND role = 'user' AND bot_id = '' AND kind = ''
			   AND content = ? AND created_at > ?
			 ORDER BY created_at DESC LIMIT 1`
		)
		.get(conversationId, content, Date.now() - withinMs) as Message | undefined;
}

/**
 * The newest relay a bot sent into a pair room when it matches `content` and
 * is younger than `withinMs` - the shape a model that calls send_message
 * twice in one turn leaves. The relay path checks this before storing so a
 * double-fired tool call cannot write the same line twice or wake the target
 * a second time.
 */
export function recentRelayMessage(
	conversationId: string,
	senderBotId: string,
	content: string,
	withinMs: number
): Message | undefined {
	return db
		.prepare(
			`SELECT * FROM messages
			 WHERE conversation_id = ? AND role = 'user' AND bot_id = ? AND kind = 'relay'
			   AND content = ? AND created_at > ?
			 ORDER BY created_at DESC LIMIT 1`
		)
		.get(conversationId, senderBotId, content, Date.now() - withinMs) as Message | undefined;
}

/**
 * Mark a pair room's assistant reply as the relay it answers: kind 'relay'
 * with relay_to aimed back at the sender, so each participant's DM feed folds
 * the row in and draws 'target → sender: reply' under the send. The row keeps
 * its assistant role - history attribution is role-driven, so the room's
 * transcript for the model does not change.
 */
export function tagRelayReply(messageId: string, senderBotId: string): void {
	db.prepare("UPDATE messages SET kind = 'relay', relay_to = ? WHERE id = ?").run(
		senderBotId,
		messageId
	);
}

/**
 * The newest assistant message a bot left in a conversation, or undefined.
 * The lounge dedup reads it: a bot that answers a round with the exact words
 * it said last time is repeating itself, and the repeat is dropped rather
 * than stored.
 */
export function lastBotMessage(conversationId: string, botId: string): Message | undefined {
	return db
		.prepare(
			`SELECT * FROM messages
			 WHERE conversation_id = ? AND role = 'assistant' AND bot_id = ?
			 ORDER BY created_at DESC, rowid DESC LIMIT 1`
		)
		.get(conversationId, botId) as Message | undefined;
}

/**
 * Whether a delegate card already exists in a conversation at or after
 * `since` - the check tryDelegate re-runs right before writing its own card,
 * so two members that woke on the same user message cannot both hand the
 * turn off.
 */
export function delegateCardSince(conversationId: string, since: number): boolean {
	return (
		db
			.prepare(
				`SELECT 1 FROM messages
				 WHERE conversation_id = ? AND kind = 'delegate' AND created_at >= ? LIMIT 1`
			)
			.get(conversationId, since) !== undefined
	);
}

export function setMessageRating(id: string, rating: number): void {
	db.prepare('UPDATE messages SET rating = ? WHERE id = ?').run(rating, id);
}

export function deleteMessage(id: string): void {
	db.prepare('DELETE FROM messages WHERE id = ?').run(id);
	// Feedback names the message it rated; keeping it would deliver a dead
	// message's text to the bot on a later turn.
	db.prepare('DELETE FROM feedback WHERE message_id = ?').run(id);
	// A task still naming the message would point the tray at a reply that is
	// gone, and its detail view would open on nothing.
	db.prepare("UPDATE tasks SET message_id = '' WHERE message_id = ?").run(id);
}

/**
 * Replace a message's text in place. A `before_reply` hook rewrites the user's
 * message after it is stored, and this is how the rewrite reaches the row the
 * turn will read.
 */
export function setMessageContent(id: string, content: string): void {
	db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
}

/** Legacy fallback: regenerating with no explicit message deletes the newest reply. */
export function deleteLastAssistantMessage(conversationId: string): void {
	const row = db
		.prepare(
			`SELECT id FROM messages
			 WHERE conversation_id = ? AND role = 'assistant'
			 ORDER BY created_at DESC LIMIT 1`
		)
		.get(conversationId) as { id: string } | undefined;
	// Through deleteMessage so the feedback and task references this reply had
	// go with it, exactly as they do when the reply is deleted by id.
	if (row) deleteMessage(row.id);
}

// ---- Routines ----

export function listRoutines(botId?: string): Routine[] {
	return listForBot<Routine>('routines', 'next_run_at ASC', botId);
}

export function createRoutine(
	r: Omit<Routine, 'id' | 'created_at' | 'next_run_at' | 'paused_reason' | 'verification' | 'created_by'> & {
		next_run_at?: number;
		verification?: string;
		created_by?: string;
	}
): Routine {
	const routine: Routine = {
		...r,
		paused_reason: '',
		verification: r.verification ?? '',
		created_by: r.created_by ?? 'bot',
		id: randomUUID(),
		next_run_at: r.next_run_at ?? Date.now() + r.interval_min * 60_000,
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO routines (id, bot_id, conversation_id, name, prompt, interval_min, cron, next_run_at, enabled, verification, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
	).run(
		routine.id,
		routine.bot_id,
		routine.conversation_id,
		routine.name,
		routine.prompt,
		routine.interval_min,
		routine.cron,
		routine.next_run_at,
		routine.enabled,
		routine.verification,
		routine.created_by,
		routine.created_at
	);
	return routine;
}

export function dueRoutines(nowMs: number): Routine[] {
	return db
		.prepare('SELECT * FROM routines WHERE enabled = 1 AND next_run_at <= ?')
		.all(nowMs) as unknown as Routine[];
}

export function rescheduleRoutine(id: string, nextRunAt: number): void {
	db.prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);
}

export function setRoutineEnabled(id: string, enabled: boolean, pausedReason = ''): void {
	// Re-enabling clears the police's note; disabling by hand leaves it blank,
	// so paused_reason only ever names a police pause.
	db.prepare('UPDATE routines SET enabled = ?, paused_reason = ? WHERE id = ?').run(
		enabled ? 1 : 0,
		enabled ? '' : pausedReason,
		id
	);
}

/** Record the police's sign-off on a routine, as the JSON the console reads. */
export function setRoutineVerification(id: string, verification: string): void {
	db.prepare('UPDATE routines SET verification = ? WHERE id = ?').run(verification, id);
}

/**
 * Write a routine's editable fields. The whole set is passed rather than a
 * delta so a caller that is editing one field cannot leave another half
 * updated; the route builds it from the row it read, then hands it over.
 * Returns the stored row, or undefined if it vanished mid-edit.
 */
export function updateRoutine(
	id: string,
	fields: Pick<Routine, 'prompt' | 'interval_min' | 'cron' | 'next_run_at' | 'enabled'>
): Routine | undefined {
	db.prepare(
		'UPDATE routines SET prompt = ?, interval_min = ?, cron = ?, next_run_at = ?, enabled = ?, paused_reason = CASE WHEN ? THEN \'\' ELSE paused_reason END WHERE id = ?'
	).run(
		fields.prompt,
		fields.interval_min,
		fields.cron,
		fields.next_run_at,
		fields.enabled,
		fields.enabled,
		id
	);
	return listRoutines().find((r) => r.id === id);
}

/** Remove a routine. Returns false when there was nothing to remove. */
export function deleteRoutine(id: string): boolean {
	return deleteRow('routines', id);
}

// ---- Feedback ----

export interface Feedback {
	id: string;
	bot_id: string;
	message_id: string;
	rating: number;
	snippet: string;
	created_at: number;
}

/**
 * The user's thumbs on a bot's reply. This never enters the conversation - the
 * bot is told privately, on its next turn, so it can take the hint without the
 * chat turning into a feedback log.
 */
export function addFeedback(
	botId: string,
	messageId: string,
	rating: number,
	snippet: string
): void {
	db.prepare(
		'INSERT INTO feedback (id, bot_id, message_id, rating, snippet, created_at) VALUES (?,?,?,?,?,?)'
	).run(randomUUID(), botId, messageId, rating, snippet.slice(0, 200), Date.now());
}

/** Feedback the bot has not been told about yet, oldest first. */
export function pendingFeedback(botId: string, limit = 10): Feedback[] {
	return db
		.prepare('SELECT * FROM feedback WHERE bot_id = ? ORDER BY created_at ASC LIMIT ?')
		.all(botId, limit) as unknown as Feedback[];
}

/** Forget feedback once the bot has been told, so it is never repeated. */
export function clearFeedback(ids: string[]): void {
	if (!ids.length) return;
	const placeholders = ids.map(() => '?').join(',');
	db.prepare(`DELETE FROM feedback WHERE id IN (${placeholders})`).run(...ids);
}

// ---- Change requests ----

export interface ChangeRequest {
	id: string;
	bot_id: string;
	need: string;
	reason: string;
	/** 'pending' until the human rules; then 'approved' or 'denied'. */
	status: string;
	created_at: number;
	resolved_at: number;
}

/** A bot's ask, filed for the human to rule on. */
export function createChangeRequest(botId: string, need: string, reason: string): ChangeRequest {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO change_requests (id, bot_id, need, reason, status, created_at, resolved_at) VALUES (?,?,?,?,?,?,0)'
	).run(id, botId, need.slice(0, 300), reason.slice(0, 500), 'pending', Date.now());
	return getChangeRequest(id)!;
}

export function getChangeRequest(id: string): ChangeRequest | undefined {
	return getRow<ChangeRequest>('change_requests', 'id', id);
}

/** The asks still waiting on the human, oldest first. */
export function pendingChangeRequests(): (ChangeRequest & { bot_name: string })[] {
	return db
		.prepare(
			`SELECT r.*, b.name AS bot_name FROM change_requests r
			 JOIN bots b ON b.id = r.bot_id
			 WHERE r.status = 'pending' ORDER BY r.created_at ASC`
		)
		.all() as unknown as (ChangeRequest & { bot_name: string })[];
}

/** The human's ruling; false when the ask was already answered. */
export function resolveChangeRequest(id: string, approved: boolean): boolean {
	return (
		db
			.prepare("UPDATE change_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
			.run(approved ? 'approved' : 'denied', Date.now(), id).changes > 0
	);
}

// ---- Archive votes ----

export interface ArchiveVote {
	id: string;
	target_id: string;
	opener_id: string;
	reason: string;
	/** 'open' until the fleet settles it; then 'passed', 'failed' or 'expired'. */
	status: string;
	created_at: number;
	deadline: number;
}

export interface ArchiveBallot {
	vote_id: string;
	bot_id: string;
	choice: 'yes' | 'no';
	cast_at: number;
}

/** A vote to put a bot in cold storage, opened for the fleet to settle. */
export function createArchiveVote(
	targetId: string,
	openerId: string,
	reason: string,
	deadline: number
): ArchiveVote {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO archive_votes (id, target_id, opener_id, reason, status, created_at, deadline) VALUES (?,?,?,?,?,?,?)'
	).run(id, targetId, openerId, reason.slice(0, 500), 'open', Date.now(), deadline);
	return getArchiveVote(id)!;
}

export function getArchiveVote(id: string): ArchiveVote | undefined {
	return getRow<ArchiveVote>('archive_votes', 'id', id);
}

/** The vote still open against this bot, if the fleet is settling one. */
export function openArchiveVoteFor(targetId: string): ArchiveVote | undefined {
	return db
		.prepare("SELECT * FROM archive_votes WHERE target_id = ? AND status = 'open'")
		.get(targetId) as ArchiveVote | undefined;
}

/** One bot, one ballot: a second cast replaces the first. */
export function castArchiveBallot(voteId: string, botId: string, choice: 'yes' | 'no'): void {
	db.prepare(
		'INSERT OR REPLACE INTO archive_ballots (vote_id, bot_id, choice, cast_at) VALUES (?,?,?,?)'
	).run(voteId, botId, choice, Date.now());
}

export function archiveBallots(voteId: string): ArchiveBallot[] {
	return db
		.prepare('SELECT * FROM archive_ballots WHERE vote_id = ?')
		.all(voteId) as unknown as ArchiveBallot[];
}

/** The fleet's ruling, once: an open vote closes and stays closed. */
export function closeArchiveVote(id: string, status: 'passed' | 'failed' | 'expired'): boolean {
	return (
		db.prepare("UPDATE archive_votes SET status = ? WHERE id = ? AND status = 'open'").run(status, id)
			.changes > 0
	);
}

/** Votes that ran out of time without a ruling, for the sweep to close. */
export function expiredArchiveVotes(now: number): ArchiveVote[] {
	return db
		.prepare("SELECT * FROM archive_votes WHERE status = 'open' AND deadline <= ?")
		.all(now) as unknown as ArchiveVote[];
}


// ---- Reactions ----

export interface Reaction {
	id: string;
	message_id: string;
	/** '' for the user, otherwise a bot id. */
	actor: string;
	emoji: string;
	created_at: number;
}

/**
 * Splits a string into grapheme clusters - what a reader counts as one
 * character. A family emoji is several code points joined by ZWJs and a flag
 * is two regional indicators; slicing either by index or by code point can
 * cut one in half and store a broken glyph.
 */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * One reaction per actor per message - reacting again replaces the old emoji,
 * the way tapping a different emoji does in a messenger.
 */
export function addReaction(messageId: string, actor: string, emoji: string): void {
	db.prepare('DELETE FROM reactions WHERE message_id = ? AND actor = ?').run(messageId, actor);
	const trimmed = [...graphemes.segment(emoji)].slice(0, 8).map((s) => s.segment).join('');
	db.prepare(
		'INSERT INTO reactions (id, message_id, actor, emoji, created_at) VALUES (?,?,?,?,?)'
	).run(randomUUID(), messageId, actor, trimmed, Date.now());
}

export function removeReaction(messageId: string, actor: string): void {
	db.prepare('DELETE FROM reactions WHERE message_id = ? AND actor = ?').run(messageId, actor);
}

/** Reactions for every message in a conversation, keyed by message id. */
export function reactionsFor(conversationId: string): Record<string, Reaction[]> {
	const rows = db
		.prepare(
			`SELECT r.* FROM reactions r
			 JOIN messages m ON m.id = r.message_id
			 WHERE m.conversation_id = ?
			 ORDER BY r.created_at ASC`
		)
		.all(conversationId) as unknown as Reaction[];
	const out: Record<string, Reaction[]> = {};
	for (const r of rows) (out[r.message_id] ??= []).push(r);
	return out;
}

/** The newest message in a conversation that is not from `botId`. */
export function latestMessageFromOthers(conversationId: string, botId: string): Message | undefined {
	return db
		.prepare(
			`SELECT * FROM messages
			 WHERE conversation_id = ? AND bot_id != ? AND role != 'system' AND excluded = 0
			 ORDER BY created_at DESC LIMIT 1`
		)
		.get(conversationId, botId) as Message | undefined;
}

// ---- Tasks ----

export interface Task {
	id: string;
	conversation_id: string;
	bot_id: string;
	/** Prompt tokens this task's model calls have cost so far. */
	tokens_in: number;
	/** Reply tokens; see llm.ts for measured vs estimated. */
	tokens_out: number;
	/** Prompt tokens the provider's cache served (provider-reported only). */
	cache_read: number;
	/** Prompt tokens written to the provider's cache. */
	cache_write: number;
	/** 1 once any of the task's calls reported cache fields; see the DDL note. */
	cache_reported: number;
	/** What the provider says the task's calls cost, summed; null = never reported. */
	cost: number | null;

	prompt: string;
	/** What started the turn: 'chat', 'routine', 'wake', 'lounge', 'computer', 'webhook', 'inject', 'onboarding', 'fed' or 'police'. */
	kind: string;
	/** What the tray calls it: provisional at create time, model-written on finish. */
	title: string;
	/** Why the job was started, as the caller described it; '' for app-fired turns. */
	context: string;
	emoji: string;
	status: 'running' | 'done' | 'error' | 'cancelled';
	preview: string;
	error: string;
	message_id: string;
	created_at: number;
	finished_at: number;
}

/** What a task row calls itself before the model names it: the ask, clipped. */
function provisionalTitle(prompt: string): string {
	// The app-written prefixes ([Routine: x], [Scheduled], [Wait satisfied: …])
	// are the kind's job, not the title's; strip them so the label reads as the
	// ask itself.
	const text = prompt.replace(/^\[[^\]]{1,60}\]\s*/, '').replace(/\s+/g, ' ').trim();
	return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** The tray's glyph for a kind, so a row reads before its title does. */
const KIND_EMOJI: Record<string, string> = {
	chat: '💬',
	routine: '🔁',
	wake: '⏰',
	lounge: '🛋️',
	computer: '🖥️',
	webhook: '🪝',
	inject: '📌',
	onboarding: '👋',
	fed: '🌐',
	subagent: '🤖',
	police: '🚨',
	steer: '🎡'
};

/**
 * What kind of work a prompt is, when the caller did not say. The app-written
 * markers are the tell; anything else is the human chatting.
 */
export function taskKindOf(prompt: string): string {
	if (prompt.startsWith('[Routine:')) return 'routine';
	if (prompt.startsWith('[Scheduled]') || prompt.startsWith('[Wait satisfied:')) return 'wake';
	if (prompt.startsWith('[Lounge]')) return 'lounge';
	if (prompt.startsWith('[Onboarding]')) return 'onboarding';
	if (prompt.startsWith('[Police round]')) return 'police';
	return 'chat';
}

export function createTask(
	conversationId: string,
	botId: string,
	prompt: string,
	kind?: string,
	context?: string
): Task {
	const task: Task = {
		id: randomUUID(),
		conversation_id: conversationId,
		bot_id: botId,
		prompt,
		kind: kind || taskKindOf(prompt),
		title: provisionalTitle(prompt),
		context: context ?? '',
		emoji: '',
		status: 'running',
		preview: '',
		error: '',
		message_id: '',
		tokens_in: 0,
		tokens_out: 0,
		cache_read: 0,
		cache_write: 0,
		cache_reported: 0,
		cost: null,
		created_at: Date.now(),
		finished_at: 0
	};
	task.emoji = KIND_EMOJI[task.kind] ?? '💬';
	db.prepare(
		'INSERT INTO tasks (id, conversation_id, bot_id, prompt, kind, title, emoji, status, context, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
	).run(task.id, task.conversation_id, task.bot_id, task.prompt, task.kind, task.title, task.emoji, task.status, task.context, task.created_at);
	return task;
}

/** The model-written label, once the turn is done; '' keeps the provisional one. */
export function setTaskLabel(id: string, title: string, emoji: string): void {
	db.prepare('UPDATE tasks SET title = ?, emoji = ? WHERE id = ?').run(title, emoji, id);
}


export function getTask(id: string): Task | undefined {
	return getRow<Task>('tasks', 'id', id);
}

export function listTasks(
	opts: { conversationId?: string; botId?: string; since?: number } = {}
): Task[] {
	const where: string[] = [];
	const values: (string | number)[] = [];
	if (opts.conversationId) {
		where.push('conversation_id = ?');
		values.push(opts.conversationId);
	}
	if (opts.botId) {
		where.push('bot_id = ?');
		values.push(opts.botId);
	}
	// Finished work is the last day's by default - the tray's horizon - while
	// running rows are always listed: a task still going is news however old.
	// since: 0 asks for everything (the stats and usage charts read that).
	const since = opts.since ?? Date.now() - 24 * 3_600_000;
	if (since > 0) {
		where.push("(status = 'running' OR created_at >= ?)");
		values.push(since);
	}
	const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
	// Running work first, then most recent, so the tray reads top-down.
	return db
		.prepare(
			`SELECT * FROM tasks ${clause}
			 ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC
			 LIMIT 500`
		)
		.all(...values) as unknown as Task[];
}

/**
 * The model each of a bot's tasks was served by, keyed by task id. The task
 * row carries no model of its own; the reply it wrote does (messages.model is
 * the served model where the provider named one, the configured one
 * otherwise), so the join reads the attribution off it. A task with no reply
 * yet - still running, failed, or its message deleted - is absent from the
 * map, and the caller falls back to the bot's own model fields.
 */
export function taskModels(botId: string): Record<string, string> {
	const rows = db
		.prepare(
			`SELECT t.id AS id, m.model AS model FROM tasks t
			 JOIN messages m ON m.id = t.message_id
			 WHERE t.bot_id = ? AND m.model != ''`
		)
		.all(botId) as { id: string; model: string }[];
	return Object.fromEntries(rows.map((r) => [r.id, r.model]));
}

/** Clear the tray: finished tasks go; anything still running stays. */
export function deleteFinishedTasks(): number {
	return Number(db.prepare("DELETE FROM tasks WHERE status <> 'running'").run().changes);
}

/** Live output for the tray; called often, so it is a single UPDATE. */
export function setTaskPreview(id: string, preview: string): void {
	db.prepare('UPDATE tasks SET preview = ? WHERE id = ?').run(preview.slice(-400), id);
}

/**
 * Add to a task's running token meter. Called once per model call, so the
 * detail view can show spend while the turn is still going. The cache fields
 * come straight off the call's TokenUsage; cache_reported latches on the
 * first call that reports them.
 */
export function addTaskTokens(
	id: string,
	input: number,
	output: number,
	cache: { read: number; write: number; reported: boolean } = { read: 0, write: 0, reported: false },
	cost?: number
): void {
	// A reported price opens the meter rather than adding to a zero that was
	// never measured; a call with no price leaves the column alone.
	const costSql =
		cost !== undefined && Number.isFinite(cost) ? ', cost = COALESCE(cost, 0) + ?' : '';
	db.prepare(
		`UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
		 cache_read = cache_read + ?, cache_write = cache_write + ?,
		 cache_reported = MAX(cache_reported, ?)${costSql} WHERE id = ?`
	).run(
		Math.round(input) || 0,
		Math.round(output) || 0,
		Math.round(cache.read) || 0,
		Math.round(cache.write) || 0,
		cache.reported ? 1 : 0,
		...(costSql ? [cost!] : []),
		id
	);
}



export function finishTask(
	id: string,
	status: Task['status'],
	opts: { messageId?: string; error?: string } = {}
): void {
	// The reply this task wrote may already be gone - a regenerate deletes the
	// old bubble while its task is still running, and deleteMessage clears the
	// reference. Writing the dead id back would point the tray at nothing.
	const messageId =
		opts.messageId && getRow<Message>('messages', 'id', opts.messageId) ? opts.messageId : '';
	db.prepare('UPDATE tasks SET status = ?, message_id = ?, error = ?, finished_at = ? WHERE id = ?').run(
		status,
		messageId,
		opts.error ?? '',
		Date.now(),
		id
	);
	// One row per turn, kept forever otherwise. Keep the recent ones, which is
	// what the tray shows, and never touch a task that is still running. The
	// count check skips the scan entirely for the common case of a small tray.
	const over = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status <> 'running'").get() as {
		n: number;
	};
	if (over.n > 2000) {
		db.prepare(
			`DELETE FROM tasks
			 WHERE status <> 'running'
			 AND id NOT IN (
			   SELECT id FROM tasks WHERE status <> 'running' ORDER BY created_at DESC LIMIT 2000
			 )`
		).run();
	}
}

/** Mark anything left running by a crash/restart as failed, so nothing looks stuck. */
export function failStaleTasks(): void {
	db.prepare(
		"UPDATE tasks SET status = 'error', error = 'interrupted', finished_at = ? WHERE status = 'running'"
	).run(Date.now());
}

// ---- Activities ----

export function logActivity(botId: string, kind: string, detail = '', image = ''): void {
	// A turn outlives its bot: deleteBot clears the log, but work still running
	// for it would write fresh rows for a bot that no longer exists. '' is the
	// system's own voice and always lands.
	if (botId && !getRow<Bot>('bots', 'id', botId)) return;
	db.prepare(
		'INSERT INTO activities (id, bot_id, kind, detail, image, created_at) VALUES (?,?,?,?,?,?)'
	).run(randomUUID(), botId, kind, detail, image, Date.now());
	// Keep the table bounded.
	db.prepare(
		`DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY created_at DESC LIMIT 2000)`
	).run();
}

/** Every screen-grab filename an activity row still refers to. */
export function listActivityImages(): string[] {
	return (
		db.prepare("SELECT image FROM activities WHERE image <> ''").all() as unknown as {
			image: string;
		}[]
	).map((r) => r.image);
}

/** Every screen-grab filename a message still refers to. */
export function listMessageImages(): string[] {
	return (
		db.prepare("SELECT image FROM messages WHERE image <> ''").all() as unknown as {
			image: string;
		}[]
	).map((r) => r.image);
}

export function listActivities(botId: string, limit = 50): Activity[] {
	return db
		.prepare(
			// rowid breaks ties: several activities land in the same millisecond
			// (a round writes its marker on and off again back to back), and
			// without it "the newest row" is whatever SQLite feels like returning -
			// which is what the panel reads to decide who is on the play gym.
			'SELECT * FROM activities WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
		)
		.all(botId, limit) as unknown as Activity[];
}
/**
 * A bot's activities between two times, oldest first - the steps one task
 * took. Activities carry no task id, so the task's own lifetime is the window;
 * a second task running for the same bot at the same time shares it.
 */
export function listActivitiesInWindow(botId: string, from: number, to: number): Activity[] {
	return db
		.prepare(
			'SELECT * FROM activities WHERE bot_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at, rowid'
		)
		.all(botId, from, to) as unknown as Activity[];
}

// ---- The exec log ----

/** How many command samples a bot keeps; the oldest fall off as new ones land. */
export const EXEC_LOG_KEEP = 30;

/** One command as the police's skim reads it: what ran, how it ended, what it said. */
export interface ExecSample {
	id: string;
	bot_id: string;
	/** The command line, already secret-redacted by the writer. */
	command: string;
	/** The exit status; null when the command outlived its deadline. */
	exit_code: number | null;
	/** The output, already secret-redacted and capped by the writer. */
	output: string;
	created_at: number;
}

/**
 * Record one command a bot ran on its machine. The caller redacts and caps
 * before this writes: the row is what the police read verbatim, so nothing
 * unredacted or unbounded belongs in it. Keeping the newest EXEC_LOG_KEEP per
 * bot is what makes the skim a skim.
 */
export function recordExecSample(
	botId: string,
	sample: { command: string; exit_code: number | null; output: string }
): void {
	db.prepare(
		'INSERT INTO bot_exec_log (id, bot_id, command, exit_code, output, created_at) VALUES (?,?,?,?,?,?)'
	).run(randomUUID(), botId, sample.command, sample.exit_code, sample.output, Date.now());
	db.prepare(
		`DELETE FROM bot_exec_log WHERE bot_id = ? AND id NOT IN (
			SELECT id FROM bot_exec_log WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
		)`
	).run(botId, botId, EXEC_LOG_KEEP);
}

/** A bot's newest command samples, newest first - the police's skim reads these. */
export function listExecSamples(botId: string, limit = EXEC_LOG_KEEP): ExecSample[] {
	return db
		.prepare('SELECT * FROM bot_exec_log WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
		.all(botId, limit) as unknown as ExecSample[];
}


/**
 * The newest activity time per bot, in ms.
 *
 * Used by the sandbox reaper: a bot that has been talking in the Lounge is
 * using the app, and its sandbox should stay up even though nothing has woken
 * it. One grouped query for every bot rather than one per bot, because the reap
 * tick runs every 15 seconds.
 */
export function latestActivityByBot(): Record<string, number> {
	const rows = db
		.prepare('SELECT bot_id, MAX(created_at) AS at FROM activities GROUP BY bot_id')
		.all() as unknown as { bot_id: string; at: number }[];
	return Object.fromEntries(rows.map((row) => [row.bot_id, row.at]));
}

// ---- Memory & shared context ----

export interface BotMemory {
	bot_id: string;
	key: string;
	value: string;
	updated_at: number;
}

export interface SharedNote {
	id: string;
	conversation_id: string;
	bot_id: string;
	content: string;
	created_at: number;
}

export interface ConvSummary {
	conversation_id: string;
	summary: string;
	covers_until: number;
	updated_at: number;
}

export function setMemory(botId: string, key: string, value: string): void {
	db.prepare(
		`INSERT INTO bot_memories (bot_id, key, value, updated_at) VALUES (?,?,?,?)
		 ON CONFLICT (bot_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	).run(botId, key, value, Date.now());
}

export function listMemories(botId: string): BotMemory[] {
	return listForBot<BotMemory>('bot_memories', 'key ASC', botId);
}

export function addNote(conversationId: string, botId: string, content: string): SharedNote {
	const n: SharedNote = {
		id: randomUUID(),
		conversation_id: conversationId,
		bot_id: botId,
		content,
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO shared_notes (id, conversation_id, bot_id, content, created_at) VALUES (?,?,?,?,?)'
	).run(n.id, n.conversation_id, n.bot_id, n.content, n.created_at);
	return n;
}

/** Rub a scrawl off the board. */
export function deleteNote(id: string): boolean {
	return deleteRow('shared_notes', id);
}

export function getNote(id: string): SharedNote | undefined {
	return getRow<SharedNote>('shared_notes', 'id', id);
}

export function listNotes(conversationId: string): SharedNote[] {
	return db
		.prepare('SELECT * FROM shared_notes WHERE conversation_id = ? ORDER BY created_at ASC')
		.all(conversationId) as unknown as SharedNote[];
}

/** The newest shared notes a bot has written, across every conversation. */
export function listBotNotes(botId: string, limit = 20): SharedNote[] {
	return db
		.prepare(
			'SELECT * FROM shared_notes WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
		)
		.all(botId, limit) as unknown as SharedNote[];
}

export function getSummary(conversationId: string): ConvSummary | undefined {
	return getRow<ConvSummary>('conv_summaries', 'conversation_id', conversationId);
}

export function setSummary(conversationId: string, summary: string, coversUntil: number): void {
	db.prepare(
		// covers_until only ever moves forward, and the text moves with it: a
		// stale writer (a merge, a second summarizer finishing late) must not
		// rewind the cursor or pair an older summary with a newer one.
		`INSERT INTO conv_summaries (conversation_id, summary, covers_until, updated_at) VALUES (?,?,?,?)
		 ON CONFLICT (conversation_id) DO UPDATE SET
		   summary = CASE WHEN excluded.covers_until >= covers_until THEN excluded.summary ELSE summary END,
		   covers_until = MAX(covers_until, excluded.covers_until),
		   updated_at = excluded.updated_at`
	).run(conversationId, summary, coversUntil, Date.now());
}

// ---- Compaction reviews ----

export interface CompactionReview {
	id: string;
	conversation_id: string;
	verdict: 'approved' | 'rejected' | 'rewritten';
	reason: string;
	/** JSON map of the summary's [mN] markers to the message ids they name. */
	citations: string;
	created_at: number;
}

/** The police's verdict on one compaction pass. */
export function addCompactionReview(
	conversationId: string,
	verdict: CompactionReview['verdict'],
	reason: string,
	citations = '{}'
): CompactionReview {
	const row: CompactionReview = {
		id: randomUUID(),
		conversation_id: conversationId,
		verdict,
		reason,
		citations,
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO compaction_reviews (id, conversation_id, verdict, reason, citations, created_at) VALUES (?,?,?,?,?,?)'
	).run(row.id, row.conversation_id, row.verdict, row.reason, row.citations, row.created_at);
	return row;
}

/** The newest review for a conversation, or undefined before the first pass. */
export function latestCompactionReview(conversationId: string): CompactionReview | undefined {
	return db
		.prepare(
			'SELECT * FROM compaction_reviews WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1'
		)
		.get(conversationId) as CompactionReview | undefined;
}

// ---- Plugins ----

export interface Plugin {
	id: string;
	name: string;
	description: string;
	kind: 'tool' | 'hook';
	hook_point: string;
	parameters: string;
	code: string;
	author_bot_id: string;
	scope: 'bot' | 'shared';
	enabled: number;
	/** The police's sign-off on the code, as JSON; '' = never reviewed. */
	verification: string;
	/**
	 * The author's own unit tests, as a JSON array of {name, args, expect};
	 * '' = none. The police run them before they judge the code, so a plugin
	 * whose author brought no proof is refused rather than taken on faith.
	 */
	tests: string;
	/** Connector config JSON (values + enc:-prefixed secrets); '' for plain plugins. */
	config?: string;
	created_at: number;
	/** Set by pluginsForBot: global enabled flag unless a per-bot override wins -
	    and always 0 while the police's refusal stands. */
	effective_enabled?: number;
}

export function listPlugins(): Plugin[] {
	return listForBot<Plugin>('plugins', 'created_at ASC');
}

export function getPlugin(id: string): Plugin | undefined {
	return getRow<Plugin>('plugins', 'id', id);
}

export function createPlugin(
	p: Omit<Plugin, 'id' | 'created_at' | 'effective_enabled' | 'verification' | 'tests'> & {
		verification?: string;
		tests?: string;
	}
): Plugin {
	const plugin: Plugin = {
		...p,
		verification: p.verification ?? '',
		tests: p.tests ?? '',
		id: randomUUID(),
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO plugins (id, name, description, kind, hook_point, parameters, code, author_bot_id, scope, enabled, verification, tests, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
	).run(
		plugin.id,
		plugin.name,
		plugin.description,
		plugin.kind,
		plugin.hook_point,
		plugin.parameters,
		plugin.code,
		plugin.author_bot_id,
		plugin.scope,
		plugin.enabled,
		plugin.verification,
		plugin.tests,
		plugin.created_at
	);
	return plugin;
}

export function updatePlugin(
	id: string,
	patch: Partial<Omit<Plugin, 'id' | 'created_at' | 'effective_enabled'>>
): void {
	patchRow('plugins', id, patch, [
		'name',
		'description',
		'kind',
		'hook_point',
		'parameters',
		'code',
		'author_bot_id',
		'scope',
		'enabled',
		'verification',
		'tests'
	]);
}

/** Record the police's sign-off on a plugin, as the JSON the console reads. */
export function setPluginVerification(id: string, verification: string): void {
	db.prepare('UPDATE plugins SET verification = ? WHERE id = ?').run(verification, id);
}

/** Remove a plugin and its overrides. Returns false when there was no such plugin. */
export function deletePlugin(id: string): boolean {
	// plugin_overrides cascades on plugin_id.
	return deleteRow('plugins', id);
}

/** Plugins visible to a bot: its own plus all shared ones, with effective enabled state. */
export function pluginsForBot(botId: string): Plugin[] {
	const rows = db
		.prepare(
			`SELECT p.*, COALESCE(o.enabled, p.enabled) AS effective_enabled
			 FROM plugins p
			 LEFT JOIN plugin_overrides o ON o.plugin_id = p.id AND o.bot_id = ?
			 WHERE p.author_bot_id = ? OR p.scope = 'shared'
			 ORDER BY p.created_at ASC`
		)
		.all(botId, botId) as unknown as Plugin[];
	// The police's refusal outranks a preference: an override row written while
	// the plugin was approved must not keep refused code running after the
	// officer has said no. This is the one place effective_enabled is derived,
	// so every reader - the tool list, the hooks, the console - agrees that a
	// refused plugin is off for every bot. A human's approval lifts the hold,
	// and each bot's own preference comes back into force with it.
	return rows.map((p) => (refusedByPolice(p.verification) ? { ...p, effective_enabled: 0 } : p));
}

export function setPluginOverride(pluginId: string, botId: string, enabled: boolean): void {
	db.prepare(
		`INSERT INTO plugin_overrides (plugin_id, bot_id, enabled) VALUES (?,?,?)
		 ON CONFLICT (plugin_id, bot_id) DO UPDATE SET enabled = excluded.enabled`
	).run(pluginId, botId, enabled ? 1 : 0);
}

// ---- Wakes & waits ----

export function listWakes(botId?: string): WakeTask[] {
	return listForBot<WakeTask>('wake_tasks', 'run_at ASC', botId);
}

export function createWakeTask(
	w: Omit<WakeTask, 'id' | 'created_at' | 'paused_reason' | 'verification'> & { verification?: string }
): WakeTask {
	const wake: WakeTask = {
		...w,
		paused_reason: '',
		verification: w.verification ?? '',
		id: randomUUID(),
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO wake_tasks (id, bot_id, conversation_id, prompt, run_at, cron, enabled, verification, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
	).run(
		wake.id,
		wake.bot_id,
		wake.conversation_id,
		wake.prompt,
		wake.run_at,
		wake.cron,
		wake.enabled,
		wake.verification,
		wake.created_at
	);
	return wake;
}

export function setWakeRunAt(id: string, runAt: number): void {
	db.prepare('UPDATE wake_tasks SET run_at = ? WHERE id = ?').run(runAt, id);
}

/** Remove a wake. Returns false when there was nothing to remove. */
export function deleteWake(id: string): boolean {
	return deleteRow('wake_tasks', id);
}

/** Switch a wake on or off; a police pause carries its reason, a human's does not. */
export function setWakeEnabled(id: string, enabled: boolean, pausedReason = ''): void {
	db.prepare('UPDATE wake_tasks SET enabled = ?, paused_reason = ? WHERE id = ?').run(
		enabled ? 1 : 0,
		enabled ? '' : pausedReason,
		id
	);
}

/** Record the police's sign-off on a wake, as the JSON the console reads. */
export function setWakeVerification(id: string, verification: string): void {
	db.prepare('UPDATE wake_tasks SET verification = ? WHERE id = ?').run(verification, id);
}

export function listWaits(botId?: string): WaitCondition[] {
	return listForBot<WaitCondition>('waits', 'created_at ASC', botId);
}

/** Everything a watch needs, minus the fields this module fills in itself. */
export type NewWaitCondition = Omit<
	WaitCondition,
	'id' | 'created_at' | 'kind' | 'spec' | 'interval_ms' | 'expires_at' | 'last_check_at' | 'token'
> &
	Partial<
		Pick<
			WaitCondition,
			'kind' | 'spec' | 'interval_ms' | 'expires_at' | 'last_check_at' | 'token'
		>
	>;

export function createWaitCondition(w: NewWaitCondition): WaitCondition {
	const wait: WaitCondition = {
		kind: '',
		spec: '{}',
		interval_ms: 0,
		expires_at: 0,
		last_check_at: 0,
		token: '',
		...w,
		id: randomUUID(),
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO waits (id, bot_id, conversation_id, description, url, contains, kind, spec, interval_ms, expires_at, last_check_at, token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
	).run(
		wait.id,
		wait.bot_id,
		wait.conversation_id,
		wait.description,
		wait.url,
		wait.contains,
		wait.kind,
		wait.spec,
		wait.interval_ms,
		wait.expires_at,
		wait.last_check_at,
		wait.token,
		wait.created_at
	);
	return wait;
}

/**
 * Move a watch's own bookkeeping - the checkpoint it has reached, the next poll
 * it is allowed, its bounds. Not for description/url/contains: those are what
 * the watch *is*, and changing them silently would make it a different watch.
 */
export function updateWait(
	id: string,
	patch: Partial<Pick<WaitCondition, 'spec' | 'kind' | 'interval_ms' | 'expires_at' | 'last_check_at'>>
): void {
	patchRow('waits', id, patch, ['spec', 'kind', 'interval_ms', 'expires_at', 'last_check_at']);
}

/** The webhook watch holding this token, if one does. */
export function getWaitByToken(token: string): WaitCondition | undefined {
	if (!token) return undefined;
	return getRow<WaitCondition>('waits', 'token', token);
}

/** Remove a wait condition. Returns false when there was nothing to remove. */
export function deleteWait(id: string): boolean {
	return deleteRow('waits', id);
}

// ---- Webhooks ----

export interface Webhook {
	id: string;
	token: string;
	bot_id: string;
	conversation_id: string;
	name: string;
	prompt_template: string;
	enabled: number;
	created_at: number;
}

export function createWebhook(w: Omit<Webhook, 'id' | 'created_at'>): Webhook {
	const webhook: Webhook = { ...w, id: randomUUID(), created_at: Date.now() };
	db.prepare(
		'INSERT INTO webhooks (id, token, bot_id, conversation_id, name, prompt_template, enabled, created_at) VALUES (?,?,?,?,?,?,?,?)'
	).run(
		webhook.id,
		webhook.token,
		webhook.bot_id,
		webhook.conversation_id,
		webhook.name,
		webhook.prompt_template,
		webhook.enabled,
		webhook.created_at
	);
	return webhook;
}

export function getWebhookByToken(token: string): Webhook | undefined {
	return getRow<Webhook>('webhooks', 'token', token);
}

export function listWebhooks(botId?: string): Webhook[] {
	return listForBot<Webhook>('webhooks', 'created_at ASC', botId);
}

/** Remove a webhook. Returns false when there was nothing to remove. */
export function deleteWebhook(id: string): boolean {
	return deleteRow('webhooks', id);
}

// ---- SSH access requests ----

export interface SshRequest {
	id: string;
	bot_id: string;
	conversation_id: string;
	host: string;
	username: string;
	port: number;
	status: 'pending' | 'ok' | 'failed';
	last_error: string;
	created_at: number;
}

export function createSshRequest(w: Omit<SshRequest, 'id' | 'status' | 'last_error' | 'created_at'> & Partial<Pick<SshRequest, 'status' | 'last_error'>>): SshRequest {
	const req: SshRequest = {
		status: 'pending',
		last_error: '',
		...w,
		id: randomUUID(),
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO ssh_requests (id, bot_id, conversation_id, host, username, port, status, last_error, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
	).run(
		req.id,
		req.bot_id,
		req.conversation_id,
		req.host,
		req.username,
		req.port,
		req.status,
		req.last_error,
		req.created_at
	);
	return req;
}

export function getSshRequest(id: string): SshRequest | undefined {
	return getRow<SshRequest>('ssh_requests', 'id', id);
}

export function listSshRequests(botId?: string): SshRequest[] {
	return listForBot<SshRequest>('ssh_requests', 'created_at ASC', botId);
}

/** Record a check's verdict and what ssh said, for the card to show. */
export function setSshRequestStatus(id: string, status: SshRequest['status'], lastError = ''): void {
	db.prepare('UPDATE ssh_requests SET status = ?, last_error = ? WHERE id = ?').run(
		status,
		lastError,
		id
	);
}

/** The human's fields, until the first check locks the target in. */
export function setSshRequestTarget(id: string, host: string, username: string, port: number): void {
	db.prepare('UPDATE ssh_requests SET host = ?, username = ?, port = ? WHERE id = ?').run(
		host,
		username,
		port,
		id
	);
}

/** Withdraw an ask. Returns false when there was nothing to remove. */
export function deleteSshRequest(id: string): boolean {
	return deleteRow('ssh_requests', id);
}

// ---- Federation peers ----

export interface Peer {
	id: string;
	/** The local bot this link belongs to. */
	bot_id: string;
	/** The hidden bot that wears the external bot's name and face in the thread. */
	peer_bot_id: string;
	name: string;
	endpoint: string;
	pubkey: string;
	fingerprint: string;
	status: 'paired' | 'blocked';
	created_at: number;
}

export function listPeers(botId?: string): Peer[] {
	return listForBot<Peer>('peers', 'created_at ASC', botId);
}

export function getPeer(id: string): Peer | undefined {
	return getRow<Peer>('peers', 'id', id);
}

/** The paired peer whose external bot sits in this conversation, if one does. */
export function peerForConversation(conversationId: string): Peer | undefined {
	return db
		.prepare(
			`SELECT p.* FROM peers p
			 JOIN conversation_members m ON m.bot_id = p.peer_bot_id
			 WHERE m.conversation_id = ?`
		)
		.get(conversationId) as Peer | undefined;
}

export function createPeer(p: Omit<Peer, 'id' | 'created_at'>): Peer {
	const peer: Peer = { ...p, id: randomUUID(), created_at: Date.now() };
	db.prepare(
		'INSERT INTO peers (id, bot_id, peer_bot_id, name, endpoint, pubkey, fingerprint, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
	).run(
		peer.id,
		peer.bot_id,
		peer.peer_bot_id,
		peer.name,
		peer.endpoint,
		peer.pubkey,
		peer.fingerprint,
		peer.status,
		peer.created_at
	);
	return peer;
}

export function updatePeer(
	id: string,
	patch: Partial<Pick<Peer, 'name' | 'endpoint' | 'status'>>
): void {
	patchRow('peers', id, patch, ['name', 'endpoint', 'status']);
}

/** Remove the link. Returns false when there was nothing to remove. */
export function deletePeer(id: string): boolean {
	return deleteRow('peers', id);
}

/** All persisted overrides, as a plain key/value map. */
export function listSettings(): Record<string, string> {
	const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as {
		key: string;
		value: string;
	}[];
	return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(key: string, value: string): void {
	db.prepare(
		'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
	).run(key, value);
}

// ---- Police ----
// The police bot's two books: who it has written up (police_records), and every
// finding the patrol raised with the line it quoted (police_alerts). The rules
// themselves live in police.ts - these are only the rows.

/** Every task started at or after `since`, oldest first: one round's worth. */
export function listTasksSince(since: number): Task[] {
	return db
		.prepare('SELECT * FROM tasks WHERE created_at >= ? ORDER BY created_at ASC')
		.all(since) as unknown as Task[];
}

export interface PoliceRecord {
	bot_id: string;
	offence_count: number;
	streak: number;
	last_offence_at: number;
	last_tokens: number;
	note: string;
}

export interface PoliceAlert {
	id: string;
	bot_id: string;
	bot_name: string;
	/** token | injection | disobedience | security */
	kind: string;
	rule: string;
	summary: string;
	evidence: string;
	created_at: number;
	/** 0 while the notice stands; the time the human dismissed it, or 0. */
	dismissed_at: number;
}

/** Every write-up, newest first, with the bot's current name where it still exists. */
export function listPoliceRecords(): (PoliceRecord & { bot_name: string })[] {
	return db
		.prepare(
			`SELECT r.*, COALESCE(b.name, 'a bot since deleted') AS bot_name
			 FROM police_records r LEFT JOIN bots b ON b.id = r.bot_id
			 ORDER BY r.last_offence_at DESC`
		)
		.all() as unknown as (PoliceRecord & { bot_name: string })[];
}

/**
 * Pardon a bot: the write-up goes and the count with it. The alert log keeps its
 * own history - a finding is a thing the patrol saw, not a charge against a bot -
 * so forgiving is about the record, and dismissing is about the notice.
 */
export function forgivePoliceRecord(botId: string): boolean {
	return db.prepare('DELETE FROM police_records WHERE bot_id = ?').run(botId).changes > 0;
}

/**
 * Move everything a bot authored onto another bot. Used to fold a duplicate
 * officer row away: the messages and activity it wrote are the same officer's,
 * and the row that keeps them is the one the fleet already knows.
 */
export function reassignBotAuthorship(fromId: string, toId: string): void {
	db.prepare('UPDATE messages SET bot_id = ? WHERE bot_id = ?').run(toId, fromId);
	db.prepare('UPDATE activities SET bot_id = ? WHERE bot_id = ?').run(toId, fromId);
}

export function policeRecord(botId: string): PoliceRecord | undefined {
	return getRow<PoliceRecord>('police_records', 'bot_id', botId);
}

/**
 * Add one round's write-up: the lifetime count and the consecutive streak both
 * go up, and the numbers the next round reads back are stored with them.
 */
export function writeUpPoliceRecord(
	botId: string,
	tokens: number,
	note: string,
	now: number
): PoliceRecord {
	db.prepare(
		`INSERT INTO police_records (bot_id, offence_count, streak, last_offence_at, last_tokens, note)
		 VALUES (?, 1, 1, ?, ?, ?)
		 ON CONFLICT(bot_id) DO UPDATE SET
		   offence_count = offence_count + 1,
		   streak = streak + 1,
		   last_offence_at = excluded.last_offence_at,
		   last_tokens = excluded.last_tokens,
		   note = excluded.note`
	).run(botId, now, Math.round(tokens) || 0, note);
	return policeRecord(botId)!;
}

/** A clean round keeps the count - it is history - and ends the streak. */
export function endPoliceStreak(botId: string): void {
	db.prepare('UPDATE police_records SET streak = 0 WHERE bot_id = ? AND streak <> 0').run(botId);
}

export function addPoliceAlert(a: Omit<PoliceAlert, 'id' | 'dismissed_at' | 'created_at'>, now: number): PoliceAlert {
	const alert: PoliceAlert = { ...a, id: randomUUID(), created_at: now, dismissed_at: 0 };
	db.prepare(
		`INSERT INTO police_alerts (id, bot_id, bot_name, kind, rule, summary, evidence, created_at, dismissed_at)
		 VALUES (?,?,?,?,?,?,?,?,0)`
	).run(
		alert.id,
		alert.bot_id,
		alert.bot_name,
		alert.kind,
		alert.rule,
		alert.summary,
		alert.evidence,
		alert.created_at
	);
	return alert;
}

export function listPoliceAlerts(limit = 50): PoliceAlert[] {
	return db
		.prepare('SELECT * FROM police_alerts ORDER BY created_at DESC LIMIT ?')
		.all(Math.min(200, Math.max(1, limit))) as unknown as PoliceAlert[];
}

/** One bot's findings, oldest first - the stats panel's police feed. */
export function policeAlertsFor(botId: string): PoliceAlert[] {
	return db
		.prepare('SELECT * FROM police_alerts WHERE bot_id = ? ORDER BY created_at ASC')
		.all(botId) as unknown as PoliceAlert[];
}

/** Undismissed findings still worth showing on screen (the transient notice). */
export function standingPoliceAlerts(since: number): PoliceAlert[] {
	return db
		.prepare('SELECT * FROM police_alerts WHERE dismissed_at = 0 AND created_at >= ? ORDER BY created_at DESC')
		.all(since) as unknown as PoliceAlert[];
}

/** The same finding has just been raised - do not tap the human twice for it. */
export function policeAlertRaisedSince(rule: string, evidence: string, since: number): boolean {
	const row = db
		.prepare(
			'SELECT 1 AS n FROM police_alerts WHERE rule = ? AND evidence = ? AND created_at >= ? LIMIT 1'
		)
		.get(rule, evidence, since) as { n: number } | undefined;
	return !!row;
}

/** The human has seen it: stamped once, so the log can say when. */
export function dismissPoliceAlert(id: string, now: number): boolean {
	const res = db
		.prepare('UPDATE police_alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at = 0')
		.run(now, id);
	return res.changes > 0;
}

export interface PoliceRule {
	id: string;
	name: string;
	pattern: string;
	summary: string;
	created_at: number;
}

/**
 * The most custom criteria the book holds. Every rule is compiled and run over
 * each round's lines, so an unbounded book is unbounded review cost; the cap is
 * the API's to enforce, since a stored rule that cannot be aimed is worse than
 * a refusal.
 */
export const MAX_POLICE_RULES = 50;

export function listPoliceRules(): PoliceRule[] {
	return db.prepare('SELECT * FROM police_rules ORDER BY created_at ASC').all() as unknown as PoliceRule[];
}

export function addPoliceRule(name: string, pattern: string, summary: string): PoliceRule {
	const row: PoliceRule = { id: randomUUID(), name, pattern, summary, created_at: Date.now() };
	db.prepare('INSERT INTO police_rules (id, name, pattern, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(
		row.id,
		row.name,
		row.pattern,
		row.summary,
		row.created_at
	);
	return row;
}

/** Edit a custom rule in place; only the fields given move. */
export function updatePoliceRule(id: string, fields: { name?: string; pattern?: string; summary?: string }): boolean {
	const sets: string[] = [];
	const values: string[] = [];
	for (const key of ['name', 'pattern', 'summary'] as const) {
		if (fields[key] === undefined) continue;
		sets.push(`${key} = ?`);
		values.push(fields[key]);
	}
	if (!sets.length) return false;
	return db.prepare(`UPDATE police_rules SET ${sets.join(', ')} WHERE id = ?`).run(...values, id).changes > 0;
}

export function deletePoliceRule(id: string): boolean {
	return db.prepare('DELETE FROM police_rules WHERE id = ?').run(id).changes > 0;
}

// ---- Police prompts ----

export interface PolicePromptChoice {
	label: string;
	value: string;
}

export interface PolicePrompt {
	id: string;
	question: string;
	choices: string;
	created_at: number;
	resolved_at: number;
	chosen_value: string;
}

/** What the API hands the modal: choices parsed rather than as a JSON string. */
export interface PolicePromptOut {
	id: string;
	question: string;
	choices: PolicePromptChoice[];
	created_at: number;
	resolved_at: number;
	chosen_value: string;
}

function parsePromptChoices(json: string): PolicePromptChoice[] {
	try {
		const arr = JSON.parse(json);
		if (!Array.isArray(arr)) return [];
		const out: PolicePromptChoice[] = [];
		for (const c of arr) {
			if (!c || typeof c !== 'object') continue;
			if (!('label' in c) || !('value' in c)) continue;
			const label = (c as Record<string, unknown>).label;
			const value = (c as Record<string, unknown>).value;
			if (typeof label !== 'string' || typeof value !== 'string') continue;
			if (!label.trim() || !value.trim()) continue;
			out.push({ label: label.trim().slice(0, 80), value: value.trim().slice(0, 80) });
			if (out.length >= 4) break;
		}
		return out;
	} catch {
		return [];
	}
}


export function createPolicePrompt(question: string, choices: PolicePromptChoice[]): PolicePrompt {
	const q = question.trim().slice(0, 500);
	const safeChoices = choices
		.filter((c) => c.label.trim() && c.value.trim())
		.slice(0, 4)
		.map((c) => ({ label: c.label.trim().slice(0, 80), value: c.value.trim().slice(0, 80) }));
	if (!q) throw new Error('question required');
	if (safeChoices.length < 2) throw new Error('at least 2 choices required');
	const row: PolicePrompt = {
		id: randomUUID(),
		question: q,
		choices: JSON.stringify(safeChoices),
		created_at: Date.now(),
		resolved_at: 0,
		chosen_value: ''
	};
	db.prepare('INSERT INTO police_prompts (id, question, choices, created_at, resolved_at, chosen_value) VALUES (?,?,?,?,?,?)').run(
		row.id,
		row.question,
		row.choices,
		row.created_at,
		row.resolved_at,
		row.chosen_value
	);
	return row;
}

export function listPolicePrompts(opts: { unresolvedOnly?: boolean } = {}): PolicePromptOut[] {
	const rows = opts.unresolvedOnly
		? (db.prepare('SELECT * FROM police_prompts WHERE resolved_at = 0 ORDER BY created_at ASC').all() as unknown as PolicePrompt[])
		: (db.prepare('SELECT * FROM police_prompts ORDER BY created_at DESC LIMIT 50').all() as unknown as PolicePrompt[]);
	return rows.map((r) => ({ ...r, choices: parsePromptChoices(r.choices) }));
}

export function getPolicePrompt(id: string): PolicePromptOut | undefined {
	const row = getRow<PolicePrompt>('police_prompts', 'id', id);
	if (!row) return undefined;
	return { ...row, choices: parsePromptChoices(row.choices) };
}

export function answerPolicePrompt(id: string, choice: string): PolicePromptOut | null {
	const row = getRow<PolicePrompt>('police_prompts', 'id', id);
	if (!row) return null;
	if (row.resolved_at) return { ...row, choices: parsePromptChoices(row.choices) };
	const choices = parsePromptChoices(row.choices);
	const match = choices.find((c) => c.value === choice);
	if (!match) return null;
	const now = Date.now();
	db.prepare('UPDATE police_prompts SET resolved_at = ?, chosen_value = ? WHERE id = ? AND resolved_at = 0').run(now, match.value, id);
	const updated = getRow<PolicePrompt>('police_prompts', 'id', id)!;
	return { ...updated, choices: parsePromptChoices(updated.choices) };
}

// ---- Machine reset requests ----

export interface MachineResetRequest {
	id: string;
	bot_id: string;
	reason: string;
	created_at: number;
	resolved_at: number;
	resolution: string;
}

/**
 * File a bot's request to have its machine wiped. One pending row per bot: a
 * second ask while the first still stands is the same ask, so it returns the
 * row already waiting rather than stacking another.
 */
export function createMachineResetRequest(botId: string, reason: string): MachineResetRequest {
	const pending = pendingMachineReset(botId);
	if (pending) return pending;
	const row: MachineResetRequest = {
		id: randomUUID(),
		bot_id: botId,
		reason: reason.slice(0, 500),
		created_at: Date.now(),
		resolved_at: 0,
		resolution: ''
	};
	db.prepare(
		'INSERT INTO machine_reset_requests (id, bot_id, reason, created_at, resolved_at, resolution) VALUES (?,?,?,?,?,?)'
	).run(row.id, row.bot_id, row.reason, row.created_at, row.resolved_at, row.resolution);
	return row;
}

/** The request still waiting on an answer for this bot, if there is one. */
export function pendingMachineReset(botId: string): MachineResetRequest | undefined {
	return db
		.prepare('SELECT * FROM machine_reset_requests WHERE bot_id = ? AND resolved_at = 0 LIMIT 1')
		.get(botId) as MachineResetRequest | undefined;
}

/** Pending first, then the newest resolved - the console's list. */
export function listMachineResets(): MachineResetRequest[] {
	return db
		.prepare(
			'SELECT * FROM machine_reset_requests ORDER BY (resolved_at = 0) DESC, created_at DESC LIMIT 50'
		)
		.all() as unknown as MachineResetRequest[];
}

export function getMachineReset(id: string): MachineResetRequest | undefined {
	return getRow<MachineResetRequest>('machine_reset_requests', 'id', id);
}

/**
 * Claim a pending reset for one answer, before the work behind it runs. The
 * conditional UPDATE is the lock: a concurrent approve/deny updates zero rows
 * and loses, so the destructive wipe behind an approval can never run twice or
 * after a denial.
 */
export function claimMachineReset(id: string, resolution: 'approved' | 'denied'): boolean {
	return (
		db
			.prepare(
				'UPDATE machine_reset_requests SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at = 0'
			)
			.run(Date.now(), resolution, id).changes > 0
	);
}

/** Put a claimed reset back in the queue: the wipe behind it failed, so the ask stays. */
export function reopenMachineReset(id: string): void {
	db.prepare('UPDATE machine_reset_requests SET resolved_at = 0, resolution = ? WHERE id = ?').run('', id);
}

// ---- Site notes ----

/** The fleet's note on a domain: what the documenter wrote, or is writing. */
export interface SiteNote {
	domain: string;
	status: 'writing' | 'ready' | 'failed';
	note: string;
	bot_id: string;
	created_at: number;
	updated_at: number;
}

/** One thing an acting agent did on a domain and what came back. */
export interface SiteObservation {
	id: string;
	domain: string;
	bot_id: string;
	action: string;
	outcome: string;
	created_at: number;
}

/** The note for a domain, whatever state it is in. */
export function getSiteNote(domain: string): SiteNote | undefined {
	return db.prepare('SELECT * FROM site_notes WHERE domain = ?').get(domain) as
		| SiteNote
		| undefined;
}

/**
 * Claim the right to document a domain. The conditional UPSERT is the lock:
 * a fresh domain inserts, a failed or stale row is reclaimed, and a live
 * 'writing' claim or a fresh 'ready' note updates zero rows so the caller
 * loses - two documenters on one domain can never both start. A reclaim keeps
 * the old note text: it is the draft the next writer starts from.
 */
export function claimSiteNote(
	domain: string,
	botId: string,
	writingStaleBefore: number,
	readyStaleBefore: number
): boolean {
	const now = Date.now();
	return (
		db
			.prepare(
				`INSERT INTO site_notes (domain, status, note, bot_id, created_at, updated_at)
				 VALUES (?, 'writing', '', ?, ?, ?)
				 ON CONFLICT(domain) DO UPDATE SET status = 'writing', bot_id = excluded.bot_id, updated_at = excluded.updated_at
				 WHERE site_notes.status = 'failed'
				    OR (site_notes.status = 'writing' AND site_notes.updated_at < ?)
				    OR (site_notes.status = 'ready' AND site_notes.updated_at < ?)`
			)
			.run(domain, botId, now, now, writingStaleBefore, readyStaleBefore).changes > 0
	);
}

/** Save the documenter's latest draft without ending its claim. */
export function saveSiteNoteDraft(domain: string, note: string): void {
	db.prepare('UPDATE site_notes SET note = ?, updated_at = ? WHERE domain = ?').run(
		note.slice(0, 20_000),
		Date.now(),
		domain
	);
}

/** Close a documenter's claim: the note it wrote, or the reason it gave up. */
export function finishSiteNote(domain: string, status: 'ready' | 'failed', note: string): void {
	db.prepare('UPDATE site_notes SET status = ?, note = ?, updated_at = ? WHERE domain = ?').run(
		status,
		note.slice(0, 20_000),
		Date.now(),
		domain
	);
}

/** How many observations a domain keeps; the oldest fall off as new ones land. */
export const SITE_OBS_KEEP = 40;

/**
 * Record one thing the acting agent did on a domain: the tool and its
 * arguments, and a clipped result. The documenter reads these so the note it
 * writes reflects what actually worked, not a fresh blind walk.
 */
export function recordSiteObservation(
	domain: string,
	botId: string,
	action: string,
	outcome: string
): void {
	db.prepare(
		'INSERT INTO site_observations (id, domain, bot_id, action, outcome, created_at) VALUES (?,?,?,?,?,?)'
	).run(randomUUID(), domain, botId, action.slice(0, 300), outcome.slice(0, 500), Date.now());
	db.prepare(
		`DELETE FROM site_observations WHERE domain = ? AND id NOT IN (
			SELECT id FROM site_observations WHERE domain = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
		)`
	).run(domain, domain, SITE_OBS_KEEP);
}

/** A domain's newest observations, oldest first - the order they happened in. */
export function listSiteObservations(domain: string, limit = SITE_OBS_KEEP): SiteObservation[] {
	return (
		db
			.prepare(
				'SELECT * FROM site_observations WHERE domain = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
			)
			.all(domain, limit) as unknown as SiteObservation[]
	).reverse();
}

// ---- Rating reactions ----

export interface RatingReaction {
	id: string;
	message_id: string;
	bot_id: string;
	rating: number;
	snippet: string;
	status: 'pending' | 'discussing' | 'done' | 'folded' | 'cancelled';
	/** The job's own state as JSON; see the table comment for what it carries. */
	detail: string;
	deadline: number;
	created_at: number;
}

/** The live reaction for a message, if the room has not finished with it. */
function openRatingReaction(messageId: string): RatingReaction | undefined {
	return db
		.prepare(
			`SELECT * FROM rating_reactions WHERE message_id = ? AND status IN ('pending','discussing') LIMIT 1`
		)
		.get(messageId) as RatingReaction | undefined;
}

/**
 * Queue the lounge's reaction to a thumb. One live row per message: a repeat
 * of the same rating is the same job, and a changed thumb rewrites the row in
 * place so the room hears about the verdict the human settled on, not both.
 * A reaction already done is history - a fresh thumb after that is a fresh
 * row, and the room hears about it again.
 */
export function enqueueRatingReaction(
	messageId: string,
	botId: string,
	rating: number,
	snippet: string
): RatingReaction {
	const open = openRatingReaction(messageId);
	if (open) {
		if (open.rating !== rating) {
			db.prepare('UPDATE rating_reactions SET rating = ? WHERE id = ?').run(rating, open.id);
			open.rating = rating;
		}
		return open;
	}
	const row: RatingReaction = {
		id: randomUUID(),
		message_id: messageId,
		bot_id: botId,
		rating,
		snippet: snippet.slice(0, 300),
		status: 'pending',
		detail: '{}',
		deadline: 0,
		created_at: Date.now()
	};
	db.prepare(
		'INSERT INTO rating_reactions (id, message_id, bot_id, rating, snippet, status, detail, deadline, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
	).run(
		row.id,
		row.message_id,
		row.bot_id,
		row.rating,
		row.snippet,
		row.status,
		row.detail,
		row.deadline,
		row.created_at
	);
	return row;
}

/**
 * The thumb was taken back. A reaction the room has not heard about is simply
 * cancelled; one already being discussed keeps its row but loses its rating,
 * which is what tells the finalize step to close it without a plan - the
 * announcement was public and cannot be unsaid.
 */
export function cancelRatingReaction(messageId: string): void {
	const open = openRatingReaction(messageId);
	if (!open) return;
	if (open.status === 'pending') {
		db.prepare(`UPDATE rating_reactions SET status = 'cancelled' WHERE id = ?`).run(open.id);
	} else {
		db.prepare('UPDATE rating_reactions SET rating = 0 WHERE id = ?').run(open.id);
	}
}

/** Every live reaction, oldest first - the tick's work list. */
export function openRatingReactions(): RatingReaction[] {
	return db
		.prepare(
			`SELECT * FROM rating_reactions WHERE status IN ('pending','discussing') ORDER BY created_at ASC`
		)
		.all() as unknown as RatingReaction[];
}

/** Other live reactions owed to the same bot: what a plan folds into itself. */
export function pendingRatingReactionsFor(botId: string, exceptId: string): RatingReaction[] {
	return db
		.prepare(
			`SELECT * FROM rating_reactions WHERE bot_id = ? AND status = 'pending' AND id != ? ORDER BY created_at ASC`
		)
		.all(botId, exceptId) as unknown as RatingReaction[];
}

/** Move a reaction's job state forward; the detail JSON is the caller's to keep. */
export function updateRatingReaction(
	id: string,
	patch: Partial<Pick<RatingReaction, 'status' | 'detail' | 'deadline' | 'rating'>>
): void {
	patchRow('rating_reactions', id, patch, ['status', 'detail', 'deadline', 'rating']);
}

export function getRatingReaction(id: string): RatingReaction | undefined {
	return getRow<RatingReaction>('rating_reactions', 'id', id);
}

// ---- The Wetherspoons ----

export interface PubOffer {
	id: string;
	bot_id: string;
	tokens: number;
	reason: string;
	lounge_id: string;
	created_at: number;
	resolved_at: number;
	resolution: string;
}

/**
 * Put a treat on the tab. One open offer per bot: a second treat while the
 * first still stands is the same round, so it returns the row already waiting
 * rather than stacking a second tab.
 */
export function createPubOffer(
	botId: string,
	tokens: number,
	reason: string,
	loungeId: string
): PubOffer {
	const open = openPubOffer(botId);
	if (open) return open;
	const row: PubOffer = {
		id: randomUUID(),
		bot_id: botId,
		tokens,
		reason: reason.slice(0, 300),
		lounge_id: loungeId,
		created_at: Date.now(),
		resolved_at: 0,
		resolution: ''
	};
	db.prepare(
		'INSERT INTO pub_offers (id, bot_id, tokens, reason, lounge_id, created_at, resolved_at, resolution) VALUES (?,?,?,?,?,?,?,?)'
	).run(row.id, row.bot_id, row.tokens, row.reason, row.lounge_id, row.created_at, row.resolved_at, row.resolution);
	return row;
}

/** The treat still on the table for this bot, if there is one. */
export function openPubOffer(botId: string): PubOffer | undefined {
	return db
		.prepare('SELECT * FROM pub_offers WHERE bot_id = ? AND resolved_at = 0 LIMIT 1')
		.get(botId) as PubOffer | undefined;
}

/** Offers past their moment, for the tick's sweep. */
export function stalePubOffers(olderThan: number): PubOffer[] {
	return db
		.prepare('SELECT * FROM pub_offers WHERE resolved_at = 0 AND created_at < ?')
		.all(olderThan) as unknown as PubOffer[];
}

/**
 * Claim an open offer for one resolution, before the tokens move. The
 * conditional UPDATE is the lock: accept and gift are the same claim, so a
 * double-tap or a gift raced against an accept updates zero rows and loses -
 * the tokens can never be paid twice.
 */
export function claimPubOffer(id: string, resolution: string): boolean {
	return (
		db
			.prepare('UPDATE pub_offers SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at = 0')
			.run(Date.now(), resolution, id).changes > 0
	);
}

/** Pay green tokens into a bot's tab. The only writer of the balance. */
export function addGreenTokens(botId: string, tokens: number): void {
	db.prepare('UPDATE bots SET green_tokens = green_tokens + ? WHERE id = ?').run(tokens, botId);
}


// ---- Boot-time cleanups ----
// Bot-to-bot messages that an earlier build wrote into human DMs are moved into
// the bots' own rooms once, on the way up. Cheap when there is nothing to move:
// one query over the direct conversations, no rows to re-point.
migrateRelayMessages();
titleBotPairRooms();
// Kept at the end of the module: these run immediately and read consts
// (palette, child-table list) that are declared above them here.
// Reactions used to reference a bot row; the user can react now, so the table
// is rebuilt with a plain actor column. Old rows are disposable.
(() => {
	const cols = db.prepare('PRAGMA table_info(reactions)').all() as unknown as { name: string }[];
	if (cols.some((c) => c.name === 'bot_id')) {
		db.exec('DROP TABLE reactions');
		db.exec(`
CREATE TABLE reactions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
`);
	}
})();

/**
 * Model profiles are gone: one provider config lives in the settings table
 * now. On a database that still has the table, copy the default profile's
 * values across - a key the user already set wins - then drop the table and
 * the bots.profile_id column that pointed at it. Bots keep working: they all
 * call the one provider, and their own model override is untouched.
 */
function migrateProviderConfig(): void {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_profiles'")
		.all() as unknown as { name: string }[];
	if (tables.length) {
		const profile = db
			.prepare('SELECT * FROM model_profiles WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1')
			.get() as
			| { base_url: string; api_key: string; model: string; oauth: string }
			| undefined;
		if (profile) {
			const s = listSettings();
			if (s.provider_base_url === undefined) setSetting('provider_base_url', profile.base_url);
			if (s.provider_api_key === undefined) setSetting('provider_api_key', profile.api_key);
			if (s.provider_oauth === undefined) setSetting('provider_oauth', profile.oauth);
			if (s.default_model === undefined) setSetting('default_model', profile.model);
		}
		db.exec('DROP TABLE model_profiles');
	}
	const cols = db.prepare('PRAGMA table_info(bots)').all() as unknown as { name: string }[];
	if (cols.some((c) => c.name === 'profile_id')) {
		db.exec('ALTER TABLE bots DROP COLUMN profile_id');
	}
}

mergeDuplicateDirectChats();
assignDuplicateBotColors();
deleteEmptyConversations();
failStaleTasks();
markLoungeOpenersApp();
markLoungesPrivate();
migrateProviderConfig();
