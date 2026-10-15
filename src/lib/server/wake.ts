import { createHash, randomUUID } from 'node:crypto';
import {
	addMessage,
	botConversationIds,
	createWaitCondition,
	createWakeTask,
	deleteWait,
	deleteWake,
	findConversation,
	getBot,
	getConversation,
	getWaitByToken,
	listActivities,
	listBotFiles,
	listBots,
	listMessagesSince,
	listTasks,
	listWaits,
	listWakes,
	logActivity,
	updateWait,
	type Bot,
	type Conversation,
	type Message,
	type WaitCondition,
	type WakeTask
} from './db';
import { config } from './config';
import { humanSize } from './files';
import { startTask } from './tasks';
import { ensureDesktop, machineExec, machineTier, machineWriteFile } from './machine';

// Re-exported so the API layer only needs this module.
export { deleteWait, deleteWake, listWaits, listWakes };

// ---- Cron ----

/** Field bounds for a 5-field cron expression: minute hour day-of-month month day-of-week. */
const CRON_RANGES: [number, number][] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7]
];

/**
 * One comma-separated list item: `*`, a number, a range, or any of those with
 * a `/step`. Anything else - an empty item (`1,,3`), a one-sided range (`-5`,
 * `5-`), an exponent (`1e1`) or a fraction (`1.5`) - is rejected. Without this
 * `Number()` quietly turns junk into a real field value.
 */
const CRON_ITEM = /^(\*|\d+|\d+-\d+)(\/\d+)?$/;

function parseCronField(field: string, lo: number, hi: number): Set<number> | null {
	const values = new Set<number>();
	for (const part of field.split(',')) {
		if (!CRON_ITEM.test(part)) return null;
		const [rangePart, stepPart] = part.split('/', 2);
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) return null;
		let a = lo;
		let b = hi;
		if (rangePart !== '*') {
			const dash = rangePart.indexOf('-');
			if (dash === -1) {
				a = Number(rangePart);
				b = stepPart === undefined ? a : hi;
			} else {
				a = Number(rangePart.slice(0, dash));
				b = Number(rangePart.slice(dash + 1));
			}
			if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) {
				return null;
			}
		}
		for (let v = a; v <= b; v += step) values.add(v);
	}
	return values;
}

interface CronSpec {
	min: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
}

function parseCron(expr: string): CronSpec | null {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const sets: Set<number>[] = [];
	for (let i = 0; i < 5; i++) {
		const range = CRON_RANGES[i];
		const set = parseCronField(fields[i], range[0], range[1]);
		if (!set || set.size === 0) return null;
		sets.push(set);
	}
	// Both 0 and 7 mean Sunday; normalize to 0.
	if (sets[4].has(7)) {
		sets[4].delete(7);
		sets[4].add(0);
	}
	return { min: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4] };
}

/**
 * Search horizon, in days. The longest wait any satisfiable expression can have
 * is the 8 years between leap days across a skipped century (2096-02-29 →
 * 2104-02-29), because a restricted day-of-week on its own matches within a
 * month and only 29 February needs a leap year. 41 years is far more than that
 * - deliberately, so that a change to the day rule cannot silently push an
 * expression past the bound - and still cheap: an impossible date costs one
 * pass over ~15k days.
 */
const CRON_HORIZON_DAYS = 41 * 366;

/**
 * Next minute matching a 5-field cron expression, strictly after `fromMs`.
 * Walks forward a day at a time, skips the days whose month/day fields cannot
 * match, and on the days that can, walks that day's real minutes to return the
 * earliest one whose hour and minute fields match. Returns null for an invalid
 * expression, or when no day matches within {@link CRON_HORIZON_DAYS}.
 *
 * Walking real instants (rather than building wall-clock times) keeps DST
 * honest: a fall-back day is 25 hours and an hour of it repeats, a
 * spring-forward day is 23 and an hour of it never happens, and a minute that
 * does not exist locally is never returned.
 *
 * Day rule: a field that covers its whole domain (`*`, `1-31`, or a step of one
 * over the full range) counts as unrestricted. Both unrestricted - every day;
 * one restricted - that field decides; both restricted - either may match, so
 * `0 0 13 * 5` fires on the 13th *and* on every Friday (the POSIX/vixie day
 * rule). Because "unrestricted" means full coverage rather than the literal
 * `*`, `0 0 1-31 * 1` means "Mondays" here, where vixie cron (which keys off
 * the `*` character) would read it as "every day".
 */
export function nextCronRun(expr: string, fromMs: number): number | null {
	const spec = parseCron(expr);
	if (!spec) return null;
	const domAny = spec.dom.size === 31;
	const dowAny = spec.dow.size === 7;
	const start = new Date(fromMs);
	const startYear = start.getFullYear();
	const startMonth = start.getMonth();
	const startDay = start.getDate();
	// Strictly after `fromMs`, rounded up to the next whole minute.
	const firstMinute = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
	for (let offset = 0; offset < CRON_HORIZON_DAYS; offset++) {
		const day = new Date(startYear, startMonth, startDay + offset);
		if (!spec.month.has(day.getMonth() + 1)) continue;
		const domHit = spec.dom.has(day.getDate());
		const dowHit = spec.dow.has(day.getDay());
		const dayHit = domAny && dowAny ? true : domAny ? dowHit : dowAny ? domHit : domHit || dowHit;
		if (!dayHit) continue;
		for (let t = Math.max(firstMinute, day.getTime()); ; t += 60_000) {
			const at = new Date(t);
			// The day's real minutes end when the local calendar date rolls over,
			// which happens after 23, 24 or 25 hours depending on DST.
			if (
				at.getFullYear() !== day.getFullYear() ||
				at.getMonth() !== day.getMonth() ||
				at.getDate() !== day.getDate()
			) {
				break;
			}
			if (spec.hour.has(at.getHours()) && spec.min.has(at.getMinutes())) return t;
		}
	}
	return null;
}

// ---- Scheduling ----

/** Schedule a one-off (`runAt`) or recurring (`cron`) wake for a bot. */
export function scheduleWake(
	botId: string,
	conversationId: string,
	prompt: string,
	opts: { runAt?: number; cron?: string } = {}
): WakeTask {
	const cron = (opts.cron ?? '').trim();
	let runAt = opts.runAt ?? 0;
	if (cron) {
		const next = nextCronRun(cron, Date.now());
		if (next === null) throw new Error(`invalid cron expression: ${cron}`);
		runAt = next;
	} else if (!runAt) {
		throw new Error('runAt or cron required');
	}
	const wake = createWakeTask({
		bot_id: botId,
		conversation_id: conversationId,
		prompt,
		run_at: runAt,
		cron,
		enabled: 1
	});
	logActivity(botId, 'wake', cron ? `Scheduled cron wake "${cron}"` : 'Scheduled one-off wake');
	return wake;
}

/**
 * Enabled wakes whose next occurrence has passed. Cron rows store their next
 * occurrence in run_at (derived via nextCronRun at schedule/advance time);
 * when unset it is computed from the expression relative to creation.
 */
export function dueWakes(nowMs: number): WakeTask[] {
	const due: WakeTask[] = [];
	for (const w of listWakes()) {
		if (!w.enabled) continue;
		if (w.cron) {
			const next = w.run_at > 0 ? w.run_at : nextCronRun(w.cron, w.created_at);
			if (next !== null && next <= nowMs) due.push(w);
		} else if (w.run_at > 0 && w.run_at <= nowMs) {
			due.push(w);
		}
	}
	return due;
}

// ---- Watches ----
//
// A watch is a wait a bot can actually express, and a check costs no model
// tokens: every trigger below is decided from rows this app already has - the
// messages, files, tasks and activities it wrote itself - from one HTTP
// request it makes itself, from JS the bot wrote running in its own machine,
// or from a page read in its own browser. The model is not asked whether a
// condition holds, ever. It is asked to do something once, if the watch fires
// and a turn is run for it.
//
// Each kind offers one answer, so no watch can fire on the same thing twice:
// it is removed the moment it fires, and it is dropped when it expires or when
// the bot or conversation it belongs to is gone.

/**
 * What a watch is watching for. Everything here is decided locally: a pattern
 * over text the app already stores, a time that has come round, JS the bot
 * wrote running in its own machine, or a page read in its own browser.
 */
export interface WatchSpec {
	/** Text the trigger must contain. Absent means "anything of this kind". */
	pattern?: string;
	/** Read `pattern` as a regular expression rather than a substring. */
	regex?: boolean;
	/** Match case-sensitively. Off by default, so capitals cannot defeat a watch. */
	case_sensitive?: boolean;
	/** message: who must have spoken - 'any', 'user', 'me', or a bot's name or id. */
	from?: string;
	/** message: only count a message that names you. */
	mentions_me?: boolean;
	/** message: 'here' (default), 'any' room you are in, or a room's id or title. */
	conversation?: string;
	/** activity: the kind of activity to watch for, e.g. 'routine', 'task', 'error'. */
	activity_kind?: string;
	/** http: fire when the response carries exactly this status. */
	status?: number;
	/** http, page: fire when the text differs from the one seen last. */
	changed?: boolean;
	/** code: JS async function body. Truthy return fires the watch. */
	code?: string;
	/** page: scope the read to one CSS selector before comparing. */
	selector?: string;
	/** Consecutive failed checks; the watch auto-pauses at 5. */
	failures?: number;
	/** Only fire at this 5-field cron time; the condition is still read from when the watch was armed. */
	at?: string;
	/** http changed, page changed: digest of the text seen last - the baseline it compares against. */
	seen?: string;
	/** at: the instant this watch is next allowed to fire. */
	gate?: number;
}

type WatchKind = 'http' | 'message' | 'file' | 'task' | 'activity' | 'webhook' | 'code' | 'page';

const WATCH_KINDS: Record<string, true> = {
	http: true,
	message: true,
	file: true,
	task: true,
	activity: true,
	webhook: true,
	code: true,
	page: true
};

/** Shown to a bot that passes a kind that does not exist. */
export const WATCH_KIND_NAMES = Object.keys(WATCH_KINDS);

/** The kind a bot or a stored row names, or null for one that does not exist. */
function asWatchKind(name: string): WatchKind | null {
	return WATCH_KINDS[name] ? (name as WatchKind) : null;
}

/**
 * How often a kind is checked when the bot did not say, in ms. HTTP leaves the
 * machine, so it waits a minute; code and page run in the bot's own machine
 * and browser, so they wait five. A webhook watch is never polled at all: the
 * POST is the trigger.
 */
const WATCH_INTERVAL: Record<WatchKind, number> = {
	http: 60_000,
	message: 30_000,
	file: 30_000,
	task: 30_000,
	activity: 30_000,
	code: 300_000,
	page: 300_000,
	// A webhook watch is never polled at all: the POST is the trigger.
	webhook: 0
};

/** Nothing is checked more often than the scheduler's own tick. */
export const MIN_WATCH_INTERVAL_MS = 15_000;
const MAX_WATCH_INTERVAL_MS = 24 * 60 * 60_000;

/** How many rows one check reads. A watch is bounded, not merely its poll. */
const SCAN_LIMIT = 50;

/** How much of a matched message or payload a wake-up note quotes. */
const QUOTE_LIMIT = 300;

/** The kind of a stored watch, or null for a row that predates kinds. */
function watchKind(wait: WaitCondition): WatchKind | null {
	return asWatchKind(wait.kind);
}

/** A watch's spec, read defensively: a hand-edited row must not break the tick. */
export function readSpec(wait: WaitCondition): WatchSpec {
	try {
		const parsed: unknown = JSON.parse(wait.spec || '{}');
		return parsed && typeof parsed === 'object' ? (parsed as WatchSpec) : {};
	} catch {
		return {};
	}
}

/**
 * `2026-09-14 10:05` - the local date and clock, because a watch can be armed
 * for days and a bare `10:05` would be a different day's 10:05.
 */
function stamp(at: number): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line, whitespace collapsed, clipped - an event, not a transcript. */
function clip(text: string, max = QUOTE_LIMIT): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A watch's own words, short enough for an activity line. */
function label(wait: WaitCondition): string {
	return clip(wait.description, 120);
}

/**
 * Does `text` satisfy this watch's pattern? No pattern means anything matches -
 * "tell me when the next thing happens" is a watch worth arming.
 */
function watchMatches(text: string, spec: WatchSpec): boolean {
	const pattern = spec.pattern ?? '';
	if (!pattern) return true;
	if (spec.regex) return new RegExp(pattern, spec.case_sensitive ? '' : 'i').test(text);
	return spec.case_sensitive
		? text.includes(pattern)
		: text.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Did this message come from who the bot asked for? `user` is a person writing
 * - the app's own injections (routines, scheduled wakes) are marked `kind: 'app'`
 * and a relayed bot message carries the sender's bot_id, so neither is somebody
 * speaking.
 */
function authorMatches(m: Message, spec: WatchSpec, bot: Bot): boolean {
	const from = (spec.from ?? '').trim().toLowerCase();
	// The watching bot's own messages never satisfy its watch unless it asked
	// for them by name: a bare wait_for would otherwise fire on the reply the
	// same turn persists, waking the bot on its own words.
	if (m.bot_id === bot.id && from !== 'me') return false;
	if (!from || from === 'any') return true;
	if (from === 'me') return m.bot_id === bot.id;
	if (from === 'user' || from === config.userName.toLowerCase()) {
		return m.role === 'user' && !m.bot_id && m.kind !== 'app';
	}
	const named = listBots().find((b) => b.id.toLowerCase() === from || b.name.toLowerCase() === from);
	return !!named && m.bot_id === named.id;
}

/** Which rooms a message watch reads: its own, all of the bot's, or one named. */
function sourceConversations(wait: WaitCondition, bot: Bot, spec: WatchSpec): string[] {
	const named = (spec.conversation ?? '').trim();
	if (!named || named === 'here') return [wait.conversation_id];
	if (named === 'any') return botConversationIds(bot.id);
	const room = findConversation(named);
	return room ? [room.id] : [];
}

/** A message watch's answer: the oldest matching message since the watch was armed. */
function messageHit(
	wait: WaitCondition,
	rooms: string[],
	bot: Bot,
	spec: WatchSpec
): string | null {
	const messages = listMessagesSince(rooms, wait.created_at, SCAN_LIMIT);
	for (const m of messages) {
		// `mentions_me` is this app's stand-in for "a reply to you": there is no
		// reply pointer anywhere, so a message that names the bot is the local
		// test for one that was aimed at it.
		if (spec.mentions_me && bot.name) {
			const name = bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			if (!new RegExp(`@?\\b${name}\\b`, 'i').test(m.content)) continue;
		}
		if (!authorMatches(m, spec, bot)) continue;
		if (!watchMatches(m.content, spec)) continue;
		const who =
			m.role === 'assistant' ? getBot(m.bot_id)?.name || 'a bot' : config.userName || 'the user';
		const room = m.conversation_id === wait.conversation_id ? '' : roomName(m.conversation_id);
		return `${stamp(m.created_at)} ${who} said${room}: "${clip(m.content)}"`;
	}
	return null;
}

/** ` in "Bots only"`, for a match in a room that is not the watch's own. */
function roomName(conversationId: string): string {
	const room = getConversation(conversationId);
	return room ? ` in "${room.title}"` : '';
}

/** A file watch's answer: a file that landed in the bot's inventory. */
function fileHit(wait: WaitCondition, bot: Bot, spec: WatchSpec): string | null {
	const file = listBotFiles(bot.id).find(
		(f) => f.created_at > wait.created_at && watchMatches(f.name, spec)
	);
	if (!file) return null;
	return `${stamp(file.created_at)} file "${file.name}" arrived (${humanSize(file.size)}, ${file.mime})`;
}

/** A task watch's answer: a background task of the bot's that has stopped running. */
function taskHit(wait: WaitCondition, bot: Bot, spec: WatchSpec): string | null {
	const done = listTasks({ botId: bot.id })
		.filter((t) => t.status !== 'running' && t.finished_at > wait.created_at)
		.filter((t) => watchMatches(t.prompt, spec))
		.sort((a, b) => a.finished_at - b.finished_at);
	const task = done[0];
	if (!task) return null;
	const detail =
		task.status === 'done'
			? 'finished'
			: `${task.status}${task.error ? `: ${clip(task.error, 80)}` : ''}`;
	return `${stamp(task.finished_at)} task "${clip(task.prompt, 80)}" ${detail}`;
}

/** An activity watch's answer: something the app logged for this bot. */
function activityHit(wait: WaitCondition, bot: Bot, spec: WatchSpec): string | null {
	const older = listActivities(bot.id, SCAN_LIMIT)
		.filter((a) => a.created_at > wait.created_at)
		.filter((a) => !spec.activity_kind || a.kind === spec.activity_kind)
		.filter((a) => watchMatches(a.detail, spec));
	const activity = older[older.length - 1];
	if (!activity) return null;
	return `${stamp(activity.created_at)} ${activity.kind}: ${clip(activity.detail)}`;
}

/**
 * An HTTP watch's answer. `status` asks for one code (a 500 is a reason to wake,
 * not a failed check), `changed` compares the body against the last one seen,
 * and otherwise the page has to answer ok and contain the string the bot named.
 */
async function httpHit(wait: WaitCondition, spec: WatchSpec): Promise<WatchPoll> {
	// A row armed before this check existed (or written straight into the table)
	// gets dropped rather than fetched: the poll runs inside the app's network.
	const problem = watchUrlProblem(wait.url);
	if (problem) return { lost: problem };
	// Redirects are followed by hand: the guard above only vetted the URL the
	// bot named, and a 302 to an internal address would otherwise turn the
	// watch into the SSRF probe it was written to prevent.
	let url = wait.url;
	let res: Response | null = null;
	for (let hops = 0; hops <= 5; hops++) {
		res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
		const location = res.headers.get('location');
		if (!location || res.status < 300 || res.status >= 400) break;
		const next = new URL(location, url).href;
		const refused = watchUrlProblem(next);
		if (refused) return { lost: `redirect refused: ${refused}` };
		url = next;
		res = null;
	}
	if (!res) return {};
	if (spec.status) {
		return res.status === spec.status
			? { hit: `${stamp(Date.now())} ${wait.url} answered HTTP ${spec.status}` }
			: {};
	}
	if (spec.changed) {
		const body = await res.text();
		// A digest rather than the body: "changed" has to mean the page, not the
		// clock, and the whole page has no business being stored in a watch row.
		const seen = createHash('sha256').update(body).digest('hex').slice(0, 32);
		// The first look is the baseline: a change is only a change against what
		// was there when this watch started watching.
		if (!spec.seen || spec.seen === seen) return { spec: { ...spec, seen } };
		return {
			spec: { ...spec, seen },
			hit: `${stamp(Date.now())} ${wait.url} changed (HTTP ${res.status})`
		};
	}
	if (!res.ok) return {};
	const text = await res.text();
	const needle = wait.contains;
	if (needle && !text.includes(needle)) return {};
	const found = needle ? ` contains "${clip(needle, 80)}"` : ' answered';
	return { hit: `${stamp(Date.now())} ${wait.url}${found} (HTTP ${res.status})` };
}

/** Wall-clock ceiling for one code-watch run, seconds. Mirrors the plugin harness. */
const CODE_WATCH_TIMEOUT_S = 30;
/** Consecutive failed checks before a code or page watch auto-pauses. */
const WATCH_FAILURE_PAUSE_AT = 5;
const CODE_OK = '__OBL_OK__';
const CODE_ERR = '__OBL_ERR__';

/**
 * A code watch's answer. The bot's JS runs as the body of an async function
 * inside its own machine - the same harness shape as a plugin, minus the
 * plugin row: written to a unique path, run under `timeout`, markers read
 * back out. Truthy fires the bot with the returned value quoted; falsy keeps
 * watching. Never throws: an exception is counted on the row, and five in a
 * row auto-pauses the watch instead of erroring the whole tick.
 */
async function codeHit(wait: WaitCondition, bot: Bot, spec: WatchSpec): Promise<WatchPoll> {
	const code = spec.code ?? '';
	if (!code) return { lost: 'a code watch needs code' };
	const runId = randomUUID().slice(0, 8);
	const path = `/tmp/obl-watch-${runId}.js`;
	const harness = `const bot = ${JSON.stringify({ id: bot.id, name: bot.name })};
(async () => {
  try {
    const out = await (async () => { ${code} })();
    process.stdout.write('${CODE_OK}' + JSON.stringify(out === undefined || out === null ? '' : out));
  } catch (e) {
    process.stdout.write('${CODE_ERR}' + String((e && e.message) || e));
  }
})();
`;
	let output: string;
	try {
		await machineWriteFile(bot.id, path, harness);
		output = await machineExec(
			bot.id,
			`timeout ${CODE_WATCH_TIMEOUT_S} node ${path}; rc=$?; rm -f ${path}; ` +
				`[ "$rc" -eq 124 ] && echo '${CODE_ERR}the code watch ran for more than ${CODE_WATCH_TIMEOUT_S}s and was stopped'`
		);
	} catch (e) {
		return failWatch(wait, bot, spec, (e as Error).message);
	}
	const errAt = output.indexOf(CODE_ERR);
	if (errAt !== -1) {
		const why = output.slice(errAt + CODE_ERR.length).split('\n')[0].trim() || 'the code threw';
		return failWatch(wait, bot, spec, why);
	}
	const okAt = output.indexOf(CODE_OK);
	if (okAt === -1) return failWatch(wait, bot, spec, 'the code watch answered unreadably');
	let value: unknown = '';
	try {
		value = JSON.parse(output.slice(okAt + CODE_OK.length).split('\n')[0]);
	} catch {
		return failWatch(wait, bot, spec, 'the code watch returned something unreadable');
	}
	if (!value || value === false || value === 0 || value === '') return { spec: clearFailures(spec) };
	const quoted = typeof value === 'string' ? value : JSON.stringify(value);
	return { spec: clearFailures(spec), hit: `${stamp(Date.now())} code watch fired: "${clip(String(quoted))}"` };
}

/** How long a page-watch read waits for the browser to answer, ms. */
const WATCH_PAGE_TIMEOUT_MS = 100_000;
/** Where a live watch tab records itself, so the next tick can sweep a leak. */
const WATCH_TAB_FILE = '/tmp/obl-watch-tab.id';
/** Cap on leaked watch tabs swept per bot per tick: one tab, one sweep. */
const WATCH_TAB_SWEEP_MAX = 1;

/**
 * The watch-tab driver: a small node script written into the machine, speaking
 * to the same remote-debugging port the desktop CDP tools use. `read` opens a
 * fresh tab, waits for load, reads the rendered text back and closes the tab;
 * `close` shuts one tab by id. The tab id is filed under WATCH_TAB_FILE while
 * the read runs, so a tick that dies mid-read leaves an id the next tick sweeps.
 */
const WATCH_PAGE_SCRIPT = `const [,, action, arg1, arg2] = process.argv;
const BASE = 'http://127.0.0.1:9222';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (action === 'close' && arg1) {
	try {
		await fetch(BASE + '/json/close/' + encodeURIComponent(arg1), { method: 'PUT' });
	} catch {}
	console.log(JSON.stringify({ closed: arg1 }));
	process.exit(0);
}
const url = Buffer.from(arg1 || '', 'base64').toString('utf8');
const selector = arg2 ? Buffer.from(arg2, 'base64').toString('utf8') : '';
const deadline = Date.now() + ${WATCH_PAGE_TIMEOUT_MS};
let created = null;
while (Date.now() < deadline) {
	try {
		const res = await fetch(BASE + '/json/new?about:blank', { method: 'PUT' });
		created = await res.json();
		if (created && created.webSocketDebuggerUrl) break;
		created = null;
	} catch {}
	await wait(2000);
}
if (!created) {
	console.error('the browser is not up yet - the desktop is still installing');
	process.exit(1);
}
const { writeFileSync, rmSync } = await import('node:fs');
writeFileSync('/tmp/obl-watch-tab.id', String(created.id));
let seq = 0;
const pending = new Map();
const loadDone = Promise.withResolvers();
const socketOpen = Promise.withResolvers();
const ws = new WebSocket(created.webSocketDebuggerUrl);
ws.onopen = socketOpen.resolve;
ws.onerror = socketOpen.reject;
const send = (method, params = {}) => new Promise((res, rej) => {
	const id = ++seq;
	pending.set(id, { res, rej });
	ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const q = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? q.rej(new Error(msg.error.message)) : q.res(msg.result);
	} else if (msg.method === 'Page.loadEventFired') {
		loadDone.resolve();
	}
};
try {
	await socketOpen.promise;
	await send('Page.enable');
	const loadTick = setTimeout(loadDone.resolve, 20000);
	const nav = await send('Page.navigate', { url });
	if (nav.errorText) {
		console.log(JSON.stringify({ error: nav.errorText }));
	} else {
		await loadDone.promise;
		clearTimeout(loadTick);
		await wait(1200);
		const selLit = JSON.stringify(selector);
		const expression = selector
			? "JSON.stringify({ title: document.title, text: ((document.querySelector(" + selLit + ") || {}).innerText || '').slice(0, 8000) })"
			: "JSON.stringify({ title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 8000) })";
		const evald = await send('Runtime.evaluate', { expression, returnByValue: true });
		console.log(evald && evald.result && evald.result.value ? evald.result.value : JSON.stringify({ title: '', text: '' }));
	}
} finally {
	ws.close();
	try {
		await fetch(BASE + '/json/close/' + encodeURIComponent(created.id), { method: 'PUT' });
	} catch {}
	try {
		rmSync('/tmp/obl-watch-tab.id');
	} catch {}
}
process.exit(0);
`;

/**
 * Open a URL in the bot's own browser, read the rendered text back, close the
 * tab. One watch tab per bot is ever alive: a tab a previous tick leaked (its
 * id filed under WATCH_TAB_FILE) is swept before a new one opens, and the read
 * closes its own tab when done. Throws when the page cannot be read, so the
 * caller counts it toward the watch's auto-pause.
 */
async function readWatchPage(botId: string, url: string, selector: string): Promise<string> {
	if (machineTier(botId) !== 'full') {
		throw new Error("this bot has no desktop - its machine is terminal-only");
	}
	await ensureDesktop(botId);
	await machineWriteFile(botId, '/tmp/obl-watch-page.mjs', WATCH_PAGE_SCRIPT);
	// Sweep first: a tick that died mid-read leaves one filed id, and that tab
	// is older than this tick by definition.
	for (let n = 0; n < WATCH_TAB_SWEEP_MAX; n++) {
		const sweep = await machineExec(
			botId,
			`id=$(cat ${WATCH_TAB_FILE} 2>/dev/null); ` +
				`if [ -n "$id" ]; then node /tmp/obl-watch-page.mjs close "$id" >/dev/null 2>&1; fi; ` +
				`rm -f ${WATCH_TAB_FILE}; echo swept`
		);
		if (!sweep.includes('"closed"')) break;
	}
	const b64url = Buffer.from(url, 'utf8').toString('base64');
	const b64sel = selector ? Buffer.from(selector, 'utf8').toString('base64') : '';
	const output = await machineExec(
		botId,
		`node /tmp/obl-watch-page.mjs read ${b64url}${b64sel ? ` ${b64sel}` : ''}`
	);
	const line = output
		.split('\n')
		.reverse()
		.find((l) => l.startsWith('{'));
	let page: { error?: string; title?: string; text?: string } | null = null;
	if (line) {
		try {
			page = JSON.parse(line) as { error?: string; title?: string; text?: string };
		} catch {
			page = null;
		}
	}
	if (!page) throw new Error('the page text could not be read back');
	if (page.error) throw new Error(`the page failed to load: ${page.error}`);
	return (page.text ?? '').trim();
}

/**
 * A page watch's answer. The URL opens in the bot's own browser over the same
 * CDP driver the desktop tools use, the rendered text is read back, and the
 * tab closes when done - one lookup per tick, so a watch tab must never leak
 * past its own check. `selector` scopes the text first; `contains` needs the
 * substring to appear; `changed` fires when the text differs from the last
 * look (the first look is the baseline). Never throws: failures count toward
 * the same auto-pause as code watches.
 */
async function pageHit(wait: WaitCondition, bot: Bot, spec: WatchSpec): Promise<WatchPoll> {
	const url = wait.url;
	if (!url) return { lost: 'a page watch needs a url' };
	const problem = watchUrlProblem(url);
	if (problem) return { lost: problem };
	let text: string;
	try {
		text = await readWatchPage(bot.id, url, spec.selector ?? '');
	} catch (e) {
		return failWatch(wait, bot, spec, (e as Error).message);
	}
	const needle = wait.contains;
	if (needle && !text.includes(needle)) return { spec: clearFailures(spec) };
	if (spec.changed) {
		// A digest rather than the text: only the change is news, and the
		// whole page has no business being stored in a watch row.
		const seen = createHash('sha256').update(text).digest('hex').slice(0, 32);
		// The first look is the baseline: a change is only a change against
		// what was there when this watch started watching.
		if (!spec.seen || spec.seen === seen)
			return { spec: { ...clearFailures(spec), seen } };
		return {
			spec: { ...clearFailures(spec), seen },
			hit: `${stamp(Date.now())} ${url} changed: "${clip(text)}"`
		};
	}
	if (!needle) return { spec: clearFailures(spec) };
	return {
		spec: clearFailures(spec),
		hit: `${stamp(Date.now())} ${url} contains "${clip(needle, 80)}"`
	};
}

/** Reset the failure streak once a check answers cleanly. */
function clearFailures(spec: WatchSpec): WatchSpec {
	if (!spec.failures) return spec;
	const next = { ...spec };
	delete next.failures;
	return next;
}

/**
 * Count a failed check on the row and auto-pause at five consecutive: a watch
 * that throws every tick is broken code or a dead page, not something to keep
 * polling forever. The checkpoint goes back with the poll so checkWaits writes
 * it in its normal update path.
 */
function failWatch(wait: WaitCondition, bot: Bot, spec: WatchSpec, why: string): WatchPoll {
	const failures = (spec.failures ?? 0) + 1;
	if (failures >= WATCH_FAILURE_PAUSE_AT) {
		deleteWait(wait.id);
		logActivity(bot.id, 'error', `Watch paused: "${label(wait)}" failed ${failures} times in a row (${why})`);
		return {};
	}
	logActivity(bot.id, 'error', `Watch check failed (${failures}x): "${label(wait)}" - ${why}`);
	return { spec: { ...spec, failures } };
}

/** What one check found, and any checkpoint it wants written back. */
interface WatchPoll {
	/** What happened, in one line, or nothing when the watch is still waiting. */
	hit?: string;
	/** The spec with its checkpoint moved on - the HTTP baseline, the next gate. */
	spec?: WatchSpec;
	/** What this watch was aimed at has gone, so there is nothing to wait for. */
	lost?: string;
}

/** The kinds decided from rows this app already has. */
const LOCAL_HIT: Record<string, (wait: WaitCondition, bot: Bot, spec: WatchSpec) => string | null> = {
	file: fileHit,
	task: taskHit,
	activity: activityHit
};

/** Decide one watch, locally. Nothing here can spend a token. */
async function evaluate(
	wait: WaitCondition,
	bot: Bot,
	kind: WatchKind,
	spec: WatchSpec
): Promise<WatchPoll> {
	if (kind === 'http') return httpHit(wait, spec);
	if (kind === 'code') return codeHit(wait, bot, spec);
	if (kind === 'page') return pageHit(wait, bot, spec);
	if (kind === 'message') {
		const rooms = sourceConversations(wait, bot, spec);
		// A watch aimed at a room of its own has nothing left to watch once that
		// room is gone; left armed it would sit looking at nothing forever.
		if (!rooms.length) return { lost: `the room it was watching is gone` };
		const hit = messageHit(wait, rooms, bot, spec);
		return hit ? { hit } : {};
	}
	// file, task and activity share one shape; a webhook watch is never polled.
	const hit = LOCAL_HIT[kind]?.(wait, bot, spec);
	return hit ? { hit } : {};
}
/**
 * Check a watch that is due, honouring any `at` gate first. A gated watch gets
 * one chance per cron window: if the moment comes round and the condition does
 * not hold, it waits for the next window rather than for the next tick.
 */
async function pollWatch(
	wait: WaitCondition,
	bot: Bot,
	kind: WatchKind,
	nowMs: number
): Promise<WatchPoll> {
	const spec = readSpec(wait);
	const at = spec.at ?? '';
	if (at) {
		const gate = spec.gate ?? nextCronRun(at, wait.created_at) ?? 0;
		// Before its window a gated watch does nothing at all - not even a fetch.
		if (!gate || nowMs < gate) return {};
	}
	const poll = await evaluate(wait, bot, kind, spec);
	if (!poll.hit && at) {
		poll.spec = { ...(poll.spec ?? spec), gate: nextCronRun(at, nowMs) ?? 0 };
	}
	return poll;
}

/** The gap a watch must leave between checks, in ms; 0 means it is never polled. */
function watchInterval(wait: WaitCondition, kind: WatchKind): number {
	if (wait.interval_ms <= 0) return WATCH_INTERVAL[kind];
	return Math.min(MAX_WATCH_INTERVAL_MS, Math.max(MIN_WATCH_INTERVAL_MS, wait.interval_ms));
}

/**
 * What a bot asked for, canonically: its own checkpoints left out, since a watch
 * that has already looked at the page is still the same watch.
 */
function withoutCheckpoints(spec: WatchSpec): string {
	const asked = Object.entries({ ...spec })
		.filter(
			([key, value]) => key !== 'seen' && key !== 'gate' && key !== 'failures' && value !== undefined
		)
		.filter(([, value]) => value !== '' && value !== false)
		.sort(([a], [b]) => (a < b ? -1 : 1));
	return JSON.stringify(asked);
}

/** Options a bot gives when arming a watch. */
interface WaitOptions {
	/** Trigger type. Inferred from `url` when omitted, and 'message' otherwise. */
	kind?: string;
	url?: string;
	contains?: string;
	spec?: WatchSpec;
	/** Check no more often than this. Clamped to the scheduler's tick. */
	everySeconds?: number;
	/** Drop the watch after this many minutes, so nothing waits forever by mistake. */
	expiresMinutes?: number;
}

/** The path an inbound POST carries to fire a webhook watch. */
function watchHookPath(token: string): string {
	return `/api/hooks/${token}`;
}

/**
 * Why an http watch may not poll a URL, or null when it is fine.
 *
 * The check runs in this process, from inside the app's own Docker network, so
 * an internal address turns a watch into a blind probe of the host, the other
 * containers and the cloud metadata service. The bot is told the reason at
 * creation, so it learns immediately instead of waiting for a wake that can
 * never honestly fire.
 */
function watchUrlProblem(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return `not a valid URL: ${raw}`;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return 'an http watch needs an http:// or https:// url';
	}
	// URL keeps brackets around an IPv6 literal; drop them for the tests below.
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	// An IPv4-mapped IPv6 address carries the same four octets after ::ffff:.
	const bare = host.replace(/^::ffff:/, '');
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
	const a = Number(ipv4?.[1] ?? NaN);
	const b = Number(ipv4?.[2] ?? NaN);
	const internalV4 =
		!!ipv4 &&
		(a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168));
	const internalV6 =
		bare === '::' ||
		bare === '::1' ||
		/^f[cd][0-9a-f]{2}:/i.test(bare) ||
		/^fe[89ab][0-9a-f]:/i.test(bare) ||
		/^(?:7f[0-9a-f]{2}|a9fe):/i.test(bare);
	const internalName =
		bare === 'localhost' ||
		bare === 'host.docker.internal' ||
		bare.endsWith('.localhost') ||
		bare.endsWith('.internal') ||
		bare.endsWith('.local');
	if (internalV4 || internalV6 || internalName) {
		return `that host is internal to the app's network, so it cannot be watched: ${host}`;
	}
	return null;
}

/** Reject a watch that could never fire, at the moment the bot asks for it. */
function validateWatch(kind: WatchKind, wait: { url: string; contains: string }, spec: WatchSpec): void {
	if (kind === 'http') {
		if (!wait.url) throw new Error('an http watch needs a url');
		const problem = watchUrlProblem(wait.url);
		if (problem) throw new Error(problem);
		if (spec.status !== undefined && !(spec.status >= 100 && spec.status <= 599)) {
			throw new Error(`status must be an HTTP status code, got ${spec.status}`);
		}
	}
	if (kind === 'code') {
		if (!(spec.code ?? '').trim()) throw new Error('a code watch needs code');
		if ((spec.code ?? '').length > 8000) throw new Error('code must fit in 8000 characters');
	}
	if (kind === 'page') {
		if (!wait.url) throw new Error('a page watch needs a url');
		const problem = watchUrlProblem(wait.url);
		if (problem) throw new Error(problem);
	}
	if (spec.regex && spec.pattern) {
		try {
			new RegExp(spec.pattern);
		} catch {
			throw new Error(`pattern is not a valid regular expression: ${spec.pattern}`);
		}
	}
	if (spec.at && nextCronRun(spec.at, Date.now()) === null) {
		throw new Error(`invalid cron expression: ${spec.at}`);
	}
	// A room named by id or title has to exist now: a watch on a room that never
	// did would sit there looking at nothing, which is not what was asked for.
	if (kind === 'message' && spec.conversation && !['here', 'any'].includes(spec.conversation)) {
		if (!findConversation(spec.conversation)) {
			throw new Error(`no conversation called "${spec.conversation}"`);
		}
	}
}

/**
 * Register a watch: something the bot wants to be woken by, checked locally.
 *
 * An identical watch (same kind, options, room and target) is not registered
 * twice - the bot gets the one it already has back, so asking twice cannot
 * stack two turns on the same event.
 */
export function createWait(
	botId: string,
	conversationId: string,
	description: string,
	opts: WaitOptions = {}
): WaitCondition {
	const requested = (opts.kind ?? '').trim().toLowerCase();
	const known = requested ? asWatchKind(requested) : null;
	if (requested && !known) throw new Error(`kind must be one of ${WATCH_KIND_NAMES.join(', ')}`);
	// A url is what an http watch is; anything else the bot describes is
	// something it wants to see in the conversation.
	const kind = known ?? (opts.url ? 'http' : 'message');
	const token = kind === 'webhook' ? randomUUID() : '';
	const url = kind === 'webhook' ? watchHookPath(token) : (opts.url ?? '');
	const contains = kind === 'http' || kind === 'page' ? (opts.contains ?? '') : '';
	// A fresh watch has no history: the internal checkpoints start empty, so what
	// happened before it was armed never counts as something it was waiting for.
	const spec: WatchSpec = { ...(opts.spec ?? {}) };
	delete spec.seen;
	delete spec.gate;
	delete spec.failures;
	// 'here' and 'any' mean the same thing however they are capitalised; anything
	// else is a room, and rooms are matched by id or title as written.
	if (spec.conversation) {
		const room = spec.conversation.trim();
		spec.conversation = ['here', 'any'].includes(room.toLowerCase()) ? room.toLowerCase() : room;
	}
	validateWatch(kind, { url, contains }, spec);

	// Stored raw: the bounds are enforced where the gap is read, in watchInterval.
	const interval_ms =
		opts.everySeconds && opts.everySeconds > 0 ? Math.round(opts.everySeconds * 1000) : 0;
	const expires_at =
		opts.expiresMinutes && opts.expiresMinutes > 0
			? Date.now() + Math.round(opts.expiresMinutes * 60_000)
			: 0;

	// Two identical watches are one watch. Checked before the insert rather than
	// after, so a bot repeating itself cannot leave a second row to leak.
	const wanted = withoutCheckpoints(spec);
	const existing = listWaits(botId).find(
		(w) =>
			w.conversation_id === conversationId &&
			w.kind === kind &&
			w.url === url &&
			w.contains === contains &&
			withoutCheckpoints(readSpec(w)) === wanted
	);
	if (existing) return existing;

	const wait = createWaitCondition({
		bot_id: botId,
		conversation_id: conversationId,
		description,
		url,
		contains,
		kind,
		spec: JSON.stringify(spec),
		interval_ms,
		expires_at,
		token
	});
	logActivity(botId, 'wait', `Watching for: ${label(wait)}`);
	return wait;
}

/** Wake the bot: what it was watching, what happened, and when. */
function fire(wait: WaitCondition, hit: string): void {
	const bot = getBot(wait.bot_id);
	const conv = getConversation(wait.conversation_id);
	if (!bot || !conv) {
		deleteWait(wait.id);
		return;
	}
	logActivity(bot.id, 'wait', `Watch fired: ${label(wait)}`);
	// Marked as the app speaking, so a watch that only wants a person's words
	// does not wake on this note. Removed before the turn, so a failing reply
	// cannot leave the watch to fire a second time.
	const note = `[Wait satisfied: ${wait.description}]\n${hit}`;
	addMessage(conv.id, 'user', note, '', '', 0, 'app');
	deleteWait(wait.id);
	// The reply runs as a background task, not inside the tick or the webhook
	// POST that fired it: awaiting it held the POST open for the whole turn
	// and stalled every other watch behind one slow reply.
	startTask(conv, bot, note.slice(0, 200));
}
/**
 * The bot a watch would wake, or null once there is nothing left to wake: a
 * watch whose owner or room is gone is dropped (the cascade removes it and this
 * catches the rest), and one past its expiry is given up on and said so.
 */
function watchTarget(wait: WaitCondition, nowMs: number): Bot | null {
	const bot = getBot(wait.bot_id);
	const conv = getConversation(wait.conversation_id);
	if (!bot || !conv) {
		deleteWait(wait.id);
		return null;
	}
	if (wait.expires_at && nowMs >= wait.expires_at) {
		deleteWait(wait.id);
		logActivity(bot.id, 'wait', `Gave up on "${label(wait)}": it expired`);
		return null;
	}
	return bot;
}

/**
 * Poll every registered watch that is due. Satisfied watches are cleared and
 * the bot is woken once; everything else is left exactly where it was, at no
 * cost beyond the rows this app wrote itself.
 */
export async function checkWaits(nowMs: number = Date.now()): Promise<void> {
	let waits: WaitCondition[];
	try {
		waits = listWaits();
	} catch {
		return;
	}
	for (const wait of waits) {
		try {
			const bot = watchTarget(wait, nowMs);
			if (!bot) continue;
			let kind = watchKind(wait);
			if (!kind) {
				if (wait.url) {
					// A wait armed before kinds existed: a url poll is exactly an
					// http watch, so it keeps running under its own name.
					kind = 'http';
					updateWait(wait.id, { kind });
				} else {
					// An old condition in prose. Deciding it means asking the model
					// on every tick, which is the cost this module no longer pays,
					// and nothing local can decide it - so it is retired and said so.
					deleteWait(wait.id);
					logActivity(
						bot.id,
						'wait',
						`Retired open-ended wait "${label(wait)}": re-arm it with a pattern`
					);
					continue;
				}
			}
			const gap = watchInterval(wait, kind);
			if (!gap) continue; // webhook only fires on a POST
			if (nowMs - wait.last_check_at < gap) continue;
			const poll = await pollWatch(wait, bot, kind, nowMs);
			if (poll.lost) {
				deleteWait(wait.id);
				logActivity(bot.id, 'wait', `Dropped "${label(wait)}": ${poll.lost}`);
				continue;
			}
			updateWait(wait.id, {
				last_check_at: nowMs,
				...(poll.spec ? { spec: JSON.stringify(poll.spec) } : {})
			});
			if (!poll.hit) continue;
			fire(wait, poll.hit);
		} catch (e) {
			logActivity(wait.bot_id, 'error', `Watch check failed: ${(e as Error).message}`);
		}
	}
}

/**
 * An inbound POST at a webhook URL. A token that belongs to a watch satisfies
 * that watch instead of starting a turn outright: the bot asked to be woken by
 * this POST, so a POST that does not carry what it is waiting for leaves the
 * watch armed, and a POST that does costs one turn rather than being ignored.
 *
 * Returns true when the token was a watch's, fired or not - the payload has been
 * dealt with, so it must not also start a turn through the classic webhook path.
 */
export async function fireWatchByToken(token: string, payload: string): Promise<boolean> {
	const wait = getWaitByToken(token);
	if (!wait) return false;
	try {
		if (!watchTarget(wait, Date.now())) return true;
		const spec = readSpec(wait);
		if (!watchMatches(payload, spec)) return true;
		fire(wait, `${stamp(Date.now())} posted to ${wait.url}: ${clip(payload)}`);
	} catch (e) {
		logActivity(wait.bot_id, 'error', `Webhook watch failed: ${(e as Error).message}`);
	}
	return true;
}

/**
 * Code watches a bot owns, clipped for review. police-review.ts owns the
 * bundle assembly; this is the feed it reads, alongside plugins.
 */
export function listCodeWatches(botId: string): { id: string; code: string }[] {
	return listWaits(botId)
		.filter((w) => w.kind === 'code')
		.map((w) => {
			const code = readSpec(w).code ?? '';
			return { id: w.id, code: code.length > 500 ? `${code.slice(0, 499)}…` : code };
		})
		.filter((w) => w.code);
}

/**
 * Page watches a bot owns, clipped the same way: the URL it reads, what it is
 * waiting for, and the selector it scopes to.
 */
export function listPageWatches(botId: string): { id: string; text: string }[] {
	return listWaits(botId)
		.filter((w) => w.kind === 'page')
		.map((w) => {
			const spec = readSpec(w);
			const what = spec.changed ? 'changed' : w.contains;
			const scoped = spec.selector ? ` @ ${spec.selector}` : '';
			return { id: w.id, text: `${w.url} (${what})${scoped}`.slice(0, 500) };
		});
}
