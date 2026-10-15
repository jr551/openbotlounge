import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDef } from './llm';
import { config } from './config';
import { backupDue } from './backup';
import { dockerRequest, type ContainerInfo } from './docker';
import { IDLE_MINUTES, machineName, machineTier } from './machine';
import { redactEverySecret } from './secrets';
import {
	conversationBots,
	db,
	getBot,
	listActivities,
	listBots,
	listConversations,
	listPlugins,
	listRoutines,
	listSettings,
	listTasks,
	listWaits,
	listWakes,
	logActivity,
	setDebugAccess,
	setSetting,
	type Bot,
	type DebugGrant,
	type DebugRequest,
	type Task
} from './db';

/**
 * The debug skill: admin access a bot may only ASK for.
 *
 * A bot that wants it calls request_debug_access, which leaves a request the
 * human answers with Approve/Decline in the thread - the same shape as a style
 * or new-bot proposal. Approving is the only thing that writes a grant, it is
 * always time-limited, and the human can revoke it early. While a grant is live
 * the bot's tool list carries the debug toolset below; the moment it lapses or
 * is revoked, debugToolsFor returns nothing and the tools are gone from the
 * next turn's list.
 *
 * Two invariants hold however the access is used:
 *
 *   - Secret VALUES never come back through any of these tools. Names and
 *     metadata only, and every result is passed through redactEverySecret so a
 *     value that leaked into someone's transcript is masked on the way out.
 *   - Every call writes an activity row naming what it read or changed, so the
 *     human can read exactly what the access was used for.
 */

/** How long one approval lasts. Short on purpose: a debugging session is a
 *  session, and an access nobody remembers granting should be gone by dinner. */
export const DEBUG_GRANT_MINUTES = 30;

/** Ceiling on one setting write, so a tool result cannot be flooded. */
const MAX_SETTING_VALUE = 4000;

/** A key whose value is a credential never has that value shown or logged. */
const CREDENTIAL_KEY_RE = /(key|secret|token|password|passwd|credential|oauth|auth|session|cookie)/i;

/** How much of a message or persona one debug result shows. */
const DEBUG_TEXT_CHARS = 1200;

/** Rows a single debug call returns when the model does not say. */
const DEBUG_LIMIT = 50;

/** The sections debug_info understands, 'all' meaning every one of them. */
const DEBUG_SECTIONS = [
	'database',
	'machines',
	'scheduler',
	'plugins',
	'secrets',
	'bots',
	'errors'
] as const;
type DebugSection = (typeof DEBUG_SECTIONS)[number];

/** A tool argument as a trimmed string; a missing one reads as ''. */
const text = (v: unknown): string => String(v ?? '').trim();

/** A tool argument as a count, clamped to something a result can hold. */
function count(v: unknown, fallback = DEBUG_LIMIT): number {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : fallback;
}

// ---- The gate ----

/**
 * The access a bot is holding, or null. An elapsed grant reads as none: the
 * clock is half the gate, so a bot handed access yesterday holds nothing today
 * even though the row is still in the database.
 */
export function debugGrant(bot: Pick<Bot, 'debug_grant'> | undefined): DebugGrant | null {
	if (!bot?.debug_grant) return null;
	try {
		const grant = JSON.parse(bot.debug_grant) as DebugGrant;
		if (!Number.isFinite(grant.expires_at) || grant.expires_at <= Date.now()) return null;
		return grant;
	} catch {
		// An unreadable row is no access, never a guessed one.
		return null;
	}
}

/** The ask a bot has outstanding, or null. */
export function debugRequest(bot: Pick<Bot, 'debug_request'> | undefined): DebugRequest | null {
	if (!bot?.debug_request) return null;
	try {
		return JSON.parse(bot.debug_request) as DebugRequest;
	} catch {
		return null;
	}
}

/** What the panel and the request card show: the ask, the grant, and whether it is live. */
export function debugState(bot: Bot): { request: DebugRequest | null; grant: DebugGrant | null } {
	return { request: debugRequest(bot), grant: debugGrant(bot) };
}

/** A bot's ask, replacing any earlier one so it can never leave two cards. */
export function askForDebugAccess(botId: string, reason: string): string {
	const bot = getBot(botId);
	if (!bot) return 'error: bot not found';
	const reasonText = text(reason).slice(0, 300);
	if (!reasonText) return 'error: a reason is required - say what you need to debug and why';
	if (debugGrant(bot)) {
		return (
			'you already hold debug access until ' +
			`${new Date(debugGrant(bot)!.expires_at).toISOString().slice(11, 16)} UTC - ` +
			'use it rather than asking again'
		);
	}
	setDebugAccess(botId, {
		request: JSON.stringify({ reason: reasonText, at: Date.now() } satisfies DebugRequest)
	});
	logActivity(botId, 'debug', `Requested debug access: ${reasonText}`);
	return (
		'request sent - the human sees a card in this chat with Approve and Decline, and ' +
		'nothing changes until they answer. Debug access is never yours to grant.'
	);
}

/** The human's yes: a time-limited grant replaces the ask. */
export function approveDebugAccess(botId: string, minutes: number): void {
	const ask = debugRequest(getBot(botId));
	const at = Date.now();
	const grant: DebugGrant = {
		reason: ask?.reason ?? '',
		granted_at: at,
		expires_at: at + minutes * 60_000
	};
	setDebugAccess(botId, { grant: JSON.stringify(grant), request: '' });
	logActivity(botId, 'debug', `Debug access granted for ${minutes} minutes`);
}

/** The human's no, or a later change of mind: nothing is granted either way. */
export function clearDebugAccess(botId: string, why: 'declined' | 'revoked'): void {
	if (why === 'declined') setDebugAccess(botId, { request: '' });
	else setDebugAccess(botId, { request: '', grant: '' });
	logActivity(botId, 'debug', `Debug access ${why} by the human`);
}

/**
 * The tools a bot may use right now. Empty unless a live grant exists, which is
 * what makes the toolset appear the moment the human approves and disappear the
 * moment the grant lapses or is revoked - the runner asks again every step.
 */
export function debugToolsFor(botId: string): ToolDef[] {
	return debugGrant(getBot(botId)) ? DEBUG_TOOLS : [];
}

/** True for a tool name the debug toolset owns; the name is still gated on call. */
export function isDebugTool(name: string): boolean {
	return name.startsWith('debug_');
}

// ---- The tools ----

const READ_WRITE = {
	type: 'object',
	properties: {
		action: {
			type: 'string',
			enum: ['read', 'write'],
			description: "What to do (default: read)"
		},
		key: { type: 'string', description: 'write: the setting to change' },
		value: { type: 'string', description: 'write: its new value' }
	}
} as const;

export const DEBUG_TOOLS: ToolDef[] = [
	{
		type: 'function',
		function: {
			name: 'debug_settings',
			description:
				'Read or change the whole app\'s settings - the live config, every stored ' +
				'override and the model profiles - while you hold debug access. Credential ' +
				'values (API keys, OAuth tokens) are redacted. Every write is logged for the ' +
				'human. Requires debug access: ask with request_debug_access and wait for the ' +
				'human to Approve.',
			parameters: READ_WRITE
		}
	},
	{
		type: 'function',
		function: {
			name: 'debug_info',
			description:
				'Read system state while you hold debug access: database size/integrity/backup, ' +
				'bot machines and sandboxes, the scheduler\'s queues, plugins, secret NAMES only ' +
				'(values are never shown), every bot\'s settings, and recent errors.',
			parameters: {
				type: 'object',
				properties: {
					section: {
						type: 'string',
						enum: ['all', ...DEBUG_SECTIONS],
						description: 'Which part to read (default: all)'
					}
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'debug_activity',
			description:
				'Read any bot\'s activity log while you hold debug access - what every bot has ' +
				'been doing, not just you, newest first.',
			parameters: {
				type: 'object',
				properties: {
					bot: { type: 'string', description: 'One bot by name (default: every bot)' },
					kind: { type: 'string', description: 'Only this kind of row, e.g. error, shell, debug' },
					limit: { type: 'number', description: `Rows to return (default ${DEBUG_LIMIT})` }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'debug_tasks',
			description:
				'Read the background task history of every bot while you hold debug access: ' +
				'what was asked, what state it ended in, what it cost, and any error.',
			parameters: {
				type: 'object',
				properties: {
					bot: { type: 'string', description: 'One bot by name (default: every bot)' },
					status: {
						type: 'string',
						enum: ['running', 'done', 'error', 'cancelled'],
						description: 'Only tasks in this state'
					},
					limit: { type: 'number', description: `Tasks to return (default ${DEBUG_LIMIT})` }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'debug_chat',
			description:
				'Read any chat while you hold debug access, including rooms you are not a member ' +
				'of. With no arguments it lists every conversation; "conversation" reads one ' +
				'room\'s messages; "search" greps every message in the app.',
			parameters: {
				type: 'object',
				properties: {
					conversation: { type: 'string', description: 'A room by title or id' },
					search: { type: 'string', description: 'Text to find in any message, any room' },
					limit: { type: 'number', description: `Rows to return (default ${DEBUG_LIMIT})` }
				}
			}
		}
	}
];

/** The refusals and results are the model's; the log line is what the human reads. */
export async function executeDebugTool(
	name: string,
	argsJson: string,
	botId: string
): Promise<string> {
	let args: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(argsJson || '{}');
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			args = parsed as Record<string, unknown>;
		}
	} catch {
		return 'error: invalid tool arguments';
	}
	// The gate, re-checked on every call: the tools are not even listed without
	// a grant, so a model that names one anyway is told, and the attempt is
	// logged where the human can see it.
	if (!debugGrant(getBot(botId))) {
		logActivity(botId, 'debug', `Refused ${name}: no active debug access`);
		return (
			'error: debug access is not granted. Ask with request_debug_access and wait for the ' +
			'human to Approve - you cannot grant it yourself.'
		);
	}
	// Belt and braces: no tool below returns a secret value, and this masks one
	// that reached a transcript some other way before it reaches a model.
	const result = redactEverySecret(await runDebugTool(name, args, botId));
	logActivity(botId, 'debug', auditLine(name, args));
	return result;
}

/** One debug call's work; the audit line is written by the caller. */
async function runDebugTool(
	name: string,
	args: Record<string, unknown>,
	botId: string
): Promise<string> {
	switch (name) {
		case 'debug_settings':
			return debugSettings(args, botId);
		case 'debug_info': {
			const asked = text(args.section) || 'all';
			const sections =
				asked === 'all'
					? [...DEBUG_SECTIONS]
					: DEBUG_SECTIONS.filter((s) => s === asked);
			if (!sections.length) return `error: unknown section "${asked}"`;
			const parts: string[] = [];
			for (const section of sections) parts.push(await debugSection(section, botId));
			return parts.join('\n\n');
		}
		case 'debug_activity':
			return debugActivity(args);
		case 'debug_tasks':
			return debugTasks(args);
		case 'debug_chat':
			return debugChat(args);
		default:
			return `error: unknown tool "${name}"`;
	}
}

// ---- Settings ----

/** A setting's value as anyone may read it: credentials are never shown. */
function shownValue(key: string, value: string): string {
	return CREDENTIAL_KEY_RE.test(key) ? '[redacted]' : value;
}

function debugSettings(args: Record<string, unknown>, botId: string): string {
	if (text(args.action).toLowerCase() === 'write') {
		const key = text(args.key);
		if (!key) return 'error: key required to write a setting';
		const value = text(args.value).slice(0, MAX_SETTING_VALUE);
		setSettingLive(key, value);
		// The write is the audit line's business; the value is withheld when the
		// key names a credential, so the log cannot become the leak.
		return (
			`wrote setting "${key}" = ` +
			`"${CREDENTIAL_KEY_RE.test(key) ? '[value withheld]' : value}"\n` +
			'live config keys take effect immediately; others are stored and read by their own feature.'
		);
	}
	const live = [
		['base_url', config.baseUrl],
		['api_key', config.apiKey ? '[redacted]' : ''],
		['default_model', config.model],
		['user_name', config.userName],
		['social', String(config.social)],
		['social_interval_min', String(config.socialIntervalMin)],
		['max_history_messages', String(config.maxHistory)],
		['max_turns_per_task', String(config.maxTurnsPerTask)],
		['max_tokens_per_task', String(config.maxTokensPerTask)],
		['task_timeout_ms', String(config.taskTimeoutMs)],
		['session_password', config.password ? '[redacted]' : ''],
		['data_dir', config.dataDir]
	] as const;
	const stored = Object.entries(listSettings())
		.map(([key, value]) => `${key} = ${shownValue(key, value)}`)
		.sort();
	return [
		`Live config for ${getBot(botId)?.name ?? botId} (credentials redacted):`,
		...live.map(([key, value]) => `  ${key} = ${value}`),
		`Stored settings (${stored.length}):`,
		...(stored.length ? stored.map((s) => `  ${s}`) : ['  (none)'])
	].join('\n');
}

/**
 * Write a setting and, for the handful the config object mirrors, apply it at
 * once - the same path the settings route uses, so a bot's write survives the
 * same way the human's toggle does.
 */
function setSettingLive(key: string, value: string): void {
	setSetting(key, value);
	if (key === 'social') config.social = value === 'true';
	if (key === 'default_model') config.model = value;
	if (key === 'social_interval_min') {
		const minutes = Number(value);
		if (Number.isFinite(minutes) && minutes >= 5) config.socialIntervalMin = minutes;
	}
}

// ---- Debug info ----

async function debugSection(section: DebugSection, botId: string): Promise<string> {
	switch (section) {
		case 'database':
			return await databaseBlock();
		case 'machines':
			return await machineBlock();
		case 'scheduler':
			return schedulerBlock();
		case 'plugins':
			return pluginBlock();
		case 'secrets':
			return secretBlock();
		case 'bots':
			return botBlock();
		case 'errors':
			return errorBlock();
	}
}

async function databaseBlock(): Promise<string> {
	const file = join(config.dataDir, 'chat.db');
	let bytes = 0;
	try {
		bytes = (await stat(file)).size;
	} catch {
		// A missing file is worth reporting rather than hiding behind 0.
	}
	const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size);
	const pages = Number((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
	const journal = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
	let integrity = 'ok';
	try {
		integrity = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
	} catch (e) {
		integrity = `unreadable: ${(e as Error).message}`;
	}
	const tables = (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as {
			name: string;
		}[]
	).map(({ name }) => {
		const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
		return `  ${name}: ${count}`;
	});
	const settings = listSettings();
	return [
		`Database: ${file} (${(bytes / 1024).toFixed(0)} KB on disk, ${pages} pages of ${pageSize} B, ${journal})`,
		`Integrity: ${integrity}`,
		`Last backup: ${settings.db_last_backup_at ? new Date(Number(settings.db_last_backup_at)).toISOString() : 'never'}` +
			`${settings.db_last_backup_bytes ? ` (${(Number(settings.db_last_backup_bytes) / 1024).toFixed(0)} KB)` : ''}` +
			`${settings.db_backup_error ? ` - last error: ${settings.db_backup_error}` : ''}` +
			`${backupDue() ? ' - one is due' : ''}`,
		'Rows:',
		...tables
	].join('\n');
}

/** Every bot's machine, in one Docker list call rather than one per bot. */
async function machineBlock(): Promise<string> {
	const bots = listBots();
	const res = await dockerRequest('GET', '/containers/json?all=1').catch(() => null);
	const containers = new Map<string, ContainerInfo>();
	if (res && res.status === 200) {
		for (const c of JSON.parse(res.body.toString()) as ContainerInfo[]) {
			containers.set((c.Names?.[0] ?? '').replace(/^\//, ''), c);
		}
	}
	const lines = bots.map((bot) => {
		const c = containers.get(machineName(bot.id));
		const state = c ? c.State : 'not built';
		const since = c?.Created ? ` since ${new Date(c.Created * 1000).toISOString().slice(0, 16)}` : '';
		return `  ${bot.name}: tier ${machineTier(bot.id)}${bot.archived ? ', archived' : ''} - ${state}${since}`;
	});
	const strays = [...containers.keys()].filter(
		(name) => name.startsWith('obl-machine-') && !bots.some((b) => machineName(b.id) === name)
	);
	return [
		`Machines (idle sleep after ${IDLE_MINUTES} min):`,
		...(lines.length ? lines : ['  (no bots)']),
		...(strays.length ? [`Containers with no bot: ${strays.join(', ')}`] : [])
	].join('\n');
}

function schedulerBlock(): string {
	const now = Date.now();
	const routines = listRoutines();
	const wakes = listWakes();
	const waits = listWaits();
	const next = (times: number[]) =>
		times.length ? new Date(Math.min(...times)).toISOString().slice(0, 16) : 'none';
	const settings = listSettings();
	const running = listTasks().filter((t) => t.status === 'running');
	return [
		`Scheduler: social ${config.social ? 'on' : 'off'}, every ${config.socialIntervalMin} min` +
			`${settings.lounge_inspection_at ? `, last room inspection ${new Date(Number(settings.lounge_inspection_at)).toISOString().slice(0, 16)}` : ''}`,
		`Routines: ${routines.length} (${routines.filter((r) => r.enabled).length} enabled), next ${next(routines.filter((r) => r.enabled).map((r) => r.next_run_at))}`,
		`Wakes: ${wakes.length} (${wakes.filter((w) => w.enabled).length} enabled), next ${next(wakes.filter((w) => w.enabled).map((w) => w.run_at))}`,
		`Waits: ${waits.length} (${waits.filter((w) => w.expires_at > now || w.expires_at === 0).length} live), next expiry ${next(waits.map((w) => w.expires_at).filter((t) => t > now))}`,
		`Tasks running now: ${running.length}`
	].join('\n');
}

function pluginBlock(): string {
	const plugins = listPlugins();
	if (!plugins.length) return 'Plugins: none.';
	const overrides = db
		.prepare('SELECT plugin_id, COUNT(*) AS n FROM plugin_overrides GROUP BY plugin_id')
		.all() as unknown as { plugin_id: string; n: number }[];
	const byPlugin = new Map(overrides.map((o) => [o.plugin_id, o.n]));
	const lines = plugins.map(
		(p) =>
			`  "${p.name}" (${p.kind}${p.hook_point ? ` ${p.hook_point}` : ''}) ${p.enabled ? 'enabled' : 'disabled'}, ${byPlugin.get(p.id) ?? 0} per-bot override(s)`
	);
	return [`Plugins (${plugins.length}):`, ...lines].join('\n');
}

function secretBlock(): string {
	const rows = db
		.prepare('SELECT b.name AS bot_name, s.name, s.shared_with, s.created_at FROM bot_secrets s JOIN bots b ON b.id = s.bot_id ORDER BY b.name, s.name')
		.all() as unknown as { bot_name: string; name: string; shared_with: string; created_at: number }[];
	if (!rows.length) return 'Secrets: none stored (values are never readable here anyway).';
	const names = new Map(listBots().map((b) => [b.id, b.name]));
	return [
		`Secrets (${rows.length}) - names and metadata only, values are never exposed:`,
		...rows.map((r) => {
			const shared = r.shared_with
				.split(',')
				.filter(Boolean)
				.map((id) => names.get(id) ?? id)
				.join(', ');
			return `  ${r.bot_name}/${r.name}${shared ? ` (shared with ${shared})` : ''} - stored ${new Date(r.created_at).toISOString().slice(0, 10)}`;
		})
	].join('\n');
}

function botBlock(): string {
	const lines = listBots().map((bot) => {
		const state = debugState(bot);
		const access = state.grant
			? `debug until ${new Date(state.grant.expires_at).toISOString().slice(11, 16)} UTC`
			: state.request
				? 'debug requested'
				: 'no debug access';
		return [
			`  ${bot.name} (${bot.id})`,
			`    model ${bot.model || 'the default model'}, ${machineTier(bot.id)} machine`,
			`    tokens in/out ${bot.input_tokens}/${bot.output_tokens}, ${bot.hidden ? 'hidden system bot, ' : ''}${bot.archived ? 'archived, ' : ''}${access}`,
			`    persona: ${bot.persona ? bot.persona.slice(0, 400) : '(none)'}`
		].join('\n');
	});
	return ['Bots:', ...(lines.length ? lines : ['  (none)'])].join('\n');
}

function errorBlock(): string {
	const failed = db
		.prepare(
			`SELECT t.status, t.error, t.prompt, t.created_at, b.name AS bot_name
			 FROM tasks t JOIN bots b ON b.id = t.bot_id
			 WHERE t.status = 'error' ORDER BY t.created_at DESC LIMIT 10`
		)
		.all() as unknown as {
		status: string;
		error: string;
		prompt: string;
		created_at: number;
		bot_name: string;
	}[];
	const logged = db
		.prepare(
			`SELECT a.kind, a.detail, a.created_at, b.name AS bot_name
			 FROM activities a LEFT JOIN bots b ON b.id = a.bot_id
			 WHERE a.kind = 'error' ORDER BY a.created_at DESC LIMIT 10`
		)
		.all() as unknown as { kind: string; detail: string; created_at: number; bot_name: string }[];
	return [
		`Failed tasks (${failed.length} shown, newest first):`,
		...failed.map(
			(f) =>
				`  ${stamp(f.created_at)} ${f.bot_name}: ${f.error || 'no error text'} - ${oneLine(f.prompt)}`
		),
		`Logged errors (${logged.length} shown):`,
		...logged.map((l) => `  ${stamp(l.created_at)} ${l.bot_name ?? 'system'}: ${oneLine(l.detail)}`)
	].join('\n');
}

// ---- Activity and tasks ----

function debugActivity(args: Record<string, unknown>): string {
	const wanted = text(args.bot);
	const bot = namedBot(wanted);
	if (wanted && !bot) return `error: no bot named "${wanted}"`;
	const kind = text(args.kind);
	const limit = count(args.limit);
	const rows = db
		.prepare(
			`SELECT a.kind, a.detail, a.image, a.created_at, b.name AS bot_name
			 FROM activities a LEFT JOIN bots b ON b.id = a.bot_id
			 WHERE (? = '' OR a.bot_id = ?) AND (? = '' OR a.kind = ?)
			 ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`
		)
		.all(bot ? bot.id : '', bot ? bot.id : '', kind, kind, limit) as unknown as {
		kind: string;
		detail: string;
		image: string;
		created_at: number;
		bot_name: string;
	}[];
	if (!rows.length) return 'No matching activity.';
	return rows
		.map(
			(r) =>
				`${stamp(r.created_at)} ${r.bot_name ?? 'system'} [${r.kind}] ${oneLine(r.detail)}` +
				(r.image ? ' (screenshot on file)' : '')
		)
		.join('\n');
}

function debugTasks(args: Record<string, unknown>): string {
	const wanted = text(args.bot);
	const bot = namedBot(wanted);
	if (wanted && !bot) return `error: no bot named "${wanted}"`;
	const status = text(args.status);
	const limit = count(args.limit);
	const rows = db
		.prepare(
			`SELECT t.*, b.name AS bot_name, c.title AS conv_title
			 FROM tasks t JOIN bots b ON b.id = t.bot_id
			 LEFT JOIN conversations c ON c.id = t.conversation_id
			 WHERE (? = '' OR t.bot_id = ?) AND (? = '' OR t.status = ?)
			 ORDER BY t.created_at DESC LIMIT ?`
		)
		.all(bot ? bot.id : '', bot ? bot.id : '', status, status, limit) as unknown as (Task & {
		bot_id: string;
		bot_name: string;
		conv_title: string;
	})[];
	if (!rows.length) return 'No matching tasks.';
	return rows
		.map(
			(t) =>
				`${stamp(t.created_at)} ${t.bot_name} in "${t.conv_title ?? '?'}" [${t.status}] ` +
				`${t.tokens_in}/${t.tokens_out} tokens - ${oneLine(t.prompt)}` +
				(t.error ? `\n    error: ${oneLine(t.error)}` : '')
		)
		.join('\n');
}

// ---- Chat ----

function debugChat(args: Record<string, unknown>): string {
	const wanted = text(args.conversation);
	const search = text(args.search);
	const limit = count(args.limit);
	if (search) return searchEveryMessage(search, limit);
	if (!wanted) return listEveryConversation();
	const conv = listConversations().find(
		(c) => c.id === wanted || c.title.toLowerCase() === wanted.toLowerCase()
	);
	if (!conv) return `error: no conversation titled or named "${wanted}"`;
	const members = conversationBots(conv.id).map((b) => b.name);
	const stored = db
		.prepare(
			'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
		)
		.all(conv.id, limit) as unknown as {
		bot_id: string;
		role: string;
		content: string;
		kind: string;
		excluded: number;
		created_at: number;
	}[];
	const names = new Map(listBots().map((b) => [b.id, b.name]));
	const total = (
		db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv.id) as {
			n: number;
		}
	).n;
	return [
		`"${conv.title}" (${conv.kind}${conv.private ? ', bots only' : ''}), members: ${members.join(', ') || 'none'}, ${total} messages - newest ${stored.length} shown, oldest first:`,
		...stored
			.reverse()
			.map(
				(m) =>
					`  ${stamp(m.created_at)} ${m.bot_id ? (names.get(m.bot_id) ?? m.bot_id) : m.role === 'user' ? config.userName : m.role}` +
					`${m.kind === 'secret' ? ' [secret handed over]' : ''}${m.excluded ? ' [hidden from context]' : ''}: ` +
					oneLine(m.content, DEBUG_TEXT_CHARS)
			)
	].join('\n');
}

/** No membership check anywhere: debug access means every room, as asked. */
function listEveryConversation(): string {
	const convs = listConversations();
	if (!convs.length) return 'No conversations.';
	return [
		`Conversations (${convs.length}):`,
		...convs.map(
			(c) =>
				`  ${c.id} "${c.title}" (${c.kind}${c.private ? ', bots only' : ''}) - ` +
				`${conversationBots(c.id).map((b) => b.name).join(', ') || 'no members'}, ` +
				`last message ${c.last_message ? stamp(c.updated_at) : 'never'}`
		)
	].join('\n');
}

function searchEveryMessage(search: string, limit: number): string {
	// Like the model would write it: a literal substring, with LIKE's own
	// wildcards escaped so searching for "100%" is not a search for everything.
	const escaped = search.replace(/[\\%_]/g, (c) => `\\${c}`);
	const rows = db
		.prepare(
			`SELECT m.content, m.kind, m.created_at, c.title, b.name AS bot_name
			 FROM messages m JOIN conversations c ON c.id = m.conversation_id
			 LEFT JOIN bots b ON b.id = m.bot_id
			 WHERE m.content LIKE ? ESCAPE '\\'
			 ORDER BY m.created_at DESC LIMIT ?`
		)
		.all(`%${escaped}%`, limit) as unknown as {
		content: string;
		kind: string;
		created_at: number;
		title: string;
		bot_name: string;
	}[];
	if (!rows.length) return `Nothing in any chat matches "${search}".`;
	return [
		`${rows.length} message(s) matching "${search}", newest first:`,
		...rows.map(
			(r) =>
				`  ${stamp(r.created_at)} "${r.title}" ${r.bot_name ?? 'user'}: ` +
				oneLine(context(r.content, search), DEBUG_TEXT_CHARS)
		)
	].join('\n');
}

/** The hit and a little either side of it, so a long message stays readable. */
function context(content: string, needle: string): string {
	const at = content.toLowerCase().indexOf(needle.toLowerCase());
	if (at < 0 || content.length <= 300) return content;
	return `…${content.slice(Math.max(0, at - 120), at + 180)}…`;
}

// ---- Shared bits ----

/** The bot a name or id means; undefined when the name matches nobody. */
function namedBot(wanted: string): Bot | undefined {
	if (!wanted) return undefined;
	const lower = wanted.toLowerCase();
	return listBots().find((b) => b.id === wanted || b.name.toLowerCase() === lower);
}

function stamp(ms: number): string {
	return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** One line, cut to a length a result can hold. */
function oneLine(value: string, max = 240): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The activity row one debug call leaves. It names what was read or changed and
 * never the value of a credential, and it keeps a write's new value so the
 * human can see exactly what was changed under their name.
 */
function auditLine(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case 'debug_settings': {
			if (text(args.action).toLowerCase() !== 'write') return 'Read every setting';
			const key = text(args.key);
			const value = CREDENTIAL_KEY_RE.test(key) ? '[value withheld]' : text(args.value).slice(0, 120);
			return `Changed setting "${key}" to "${value}"`;
		}
		case 'debug_info':
			return `Read system state: ${text(args.section) || 'all'}`;
		case 'debug_activity':
			return `Read the activity log${text(args.bot) ? ` of ${text(args.bot)}` : ''}${text(args.kind) ? ` (${text(args.kind)})` : ''}`;
		case 'debug_tasks':
			return `Read the task history${text(args.bot) ? ` of ${text(args.bot)}` : ''}${text(args.status) ? ` (${text(args.status)})` : ''}`;
		case 'debug_chat': {
			// The room is named as the human knows it, not by the id the model
			// happened to pass: an audit trail full of uuids names nothing.
			if (text(args.search)) return `Searched every chat for "${oneLine(text(args.search), 80)}"`;
			if (text(args.conversation)) {
				const asked = text(args.conversation);
				const conv = listConversations().find(
					(c) => c.id === asked || c.title.toLowerCase() === asked.toLowerCase()
				);
				return `Read the chat "${conv?.title ?? asked}"`;
			}
			return 'Listed every conversation';
		}
		default:
			return `Called ${name}`;
	}
}
