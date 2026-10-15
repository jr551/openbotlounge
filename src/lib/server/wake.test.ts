import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addBotFile,
	addMessage,
	createBot,
	createConversation,
	createTask,
	db,
	deleteConversation,
	finishTask,
	listActivities,
	listMessages,
	listTasks,
	logActivity,
	updateConversation
} from './db';
import { complete } from './llm';
import { runBotTurn } from './runner';
import {
	checkWaits,
	createWait,
	deleteWait,
	deleteWake,
	dueWakes,
	fireWatchByToken,
	listWaits,
	listWakes,
	nextCronRun,
	readSpec,
	scheduleWake
} from './wake';

vi.mock('./llm', () => ({
	complete: vi.fn(async () => 'NO')
}));

vi.mock('./runner', () => ({
	runBotTurn: vi.fn(async () => ({ text: 'ok', message: null, aborted: false, stoppedBy: '' }))
}));

/** Monday 2026-09-14 10:00:00 local, the instant every watch test starts from. */
const BASE = new Date(2026, 8, 14, 10, 0, 0, 0).getTime();

/** The scheduler's own cadence, so a test can tick along it. */
const TICK = 15_000;

let botId = '';
let convId = '';
/** A room the watching bot is not in, and the bot that talks in it. */
let roomId = '';
let roomBotId = '';

beforeAll(() => {
	botId = createBot({
		name: 'WakeBot',
		persona: '',
		avatar: '🤖',
		color: '#fff',
		model: 'm1',
		badge: ''
	}).id;
	convId = createConversation([botId], 'direct').id;
	roomBotId = createBot({
		name: 'RoomBot',
		persona: '',
		avatar: '🦊',
		color: '#0ff',
		model: 'm1',
		badge: ''
	}).id;
	roomId = createConversation([roomBotId], 'group').id;
	updateConversation(roomId, { title: 'Bots only' });
});

beforeEach(() => {
	// A fixed clock, so "after the watch was armed" is a fact a test states rather
	// than a race with the millisecond the row happened to be written in.
	vi.useFakeTimers();
	vi.setSystemTime(BASE);
	vi.clearAllMocks();
	vi.mocked(complete).mockResolvedValue('NO');
	vi.mocked(runBotTurn).mockResolvedValue({ text: 'ok', message: null, aborted: false, stoppedBy: '', silent: false });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	// Clean slate: these tests share one conversation and one bot, so anything the
	// last one left - a fired watch's note, an activity, a finished task, a file -
	// would be something the next test's watch could wake on.
	for (const room of [convId, roomId]) {
		db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(room);
	}
	for (const bot of [botId, roomBotId]) {
		db.prepare('DELETE FROM activities WHERE bot_id = ?').run(bot);
		db.prepare('DELETE FROM bot_files WHERE bot_id = ?').run(bot);
		db.prepare('DELETE FROM tasks WHERE bot_id = ?').run(bot);
	}
	// Leftover rows would leak into dueWakes/checkWaits assertions.
	for (const w of listWakes()) deleteWake(w.id);
	for (const w of listWaits()) deleteWait(w.id);
});

describe('nextCronRun', () => {
	it('returns the next quarter-hour for */15 * * * *', () => {
		const from = new Date(2026, 8, 11, 10, 7, 30).getTime();
		expect(nextCronRun('*/15 * * * *', from)).toBe(new Date(2026, 8, 11, 10, 15, 0).getTime());
	});

	it('is strictly after the given time, even when that is an exact match', () => {
		const from = new Date(2026, 8, 11, 10, 15, 0).getTime();
		expect(nextCronRun('*/15 * * * *', from)).toBe(
			new Date(2026, 8, 11, 10, 30, 0).getTime()
		);
		// `from` is itself a 06:30 match on the 11th: the next one is the 12th.
		expect(nextCronRun('30 6 * * *', new Date(2026, 8, 11, 6, 30, 0).getTime())).toBe(
			new Date(2026, 8, 12, 6, 30, 0).getTime()
		);
		// A sub-minute `from` still rounds up to the next whole minute.
		expect(nextCronRun('* * * * *', new Date(2026, 8, 11, 10, 15, 0, 1).getTime())).toBe(
			new Date(2026, 8, 11, 10, 16, 0).getTime()
		);
	});

	it('honours literal, range, list and step fields', () => {
		// Literal minute 5: 10:07:30 → the 11th hour's minute 5.
		expect(nextCronRun('5 * * * *', new Date(2026, 8, 11, 10, 7, 30).getTime())).toBe(
			new Date(2026, 8, 11, 11, 5, 0).getTime()
		);
		// Range 10-12: minute 12 has passed, so the next hour's minute 10.
		expect(nextCronRun('10-12 * * * *', new Date(2026, 8, 11, 10, 12, 0).getTime())).toBe(
			new Date(2026, 8, 11, 11, 10, 0).getTime()
		);
		// List 1,3,5: from 10:04 the next listed minute is 10:05.
		expect(nextCronRun('1,3,5 * * * *', new Date(2026, 8, 11, 10, 4, 0).getTime())).toBe(
			new Date(2026, 8, 11, 10, 5, 0).getTime()
		);
		// Step over a range: 10,20,30,40,50 past every hour.
		expect(nextCronRun('10-50/10 * * * *', new Date(2026, 8, 11, 10, 50, 0).getTime())).toBe(
			new Date(2026, 8, 11, 11, 10, 0).getTime()
		);
		// Step over the whole field: hours 0,6,12,18.
		expect(nextCronRun('0 */6 * * *', new Date(2026, 8, 11, 13, 0, 0).getTime())).toBe(
			new Date(2026, 8, 11, 18, 0, 0).getTime()
		);
		// The instant really does carry the fields the expression names.
		const next = nextCronRun('20,40 9-17 * * *', new Date(2026, 8, 11, 18, 0, 0).getTime());
		expect(next).toBe(new Date(2026, 8, 12, 9, 20, 0).getTime());
		const at = new Date(Number(next));
		expect([20, 40]).toContain(at.getMinutes());
		expect(at.getHours()).toBe(9);
		expect(at.getSeconds()).toBe(0);
	});

	it('returns the next weekday 9am for 0 9 * * 1-5', () => {
		// Friday 2026-09-11 08:00 → same day 09:00.
		expect(nextCronRun('0 9 * * 1-5', new Date(2026, 8, 11, 8, 0, 0).getTime())).toBe(
			new Date(2026, 8, 11, 9, 0, 0).getTime()
		);
		// Friday 2026-09-11 09:30 → Monday 2026-09-14 09:00.
		expect(nextCronRun('0 9 * * 1-5', new Date(2026, 8, 11, 9, 30, 0).getTime())).toBe(
			new Date(2026, 8, 14, 9, 0, 0).getTime()
		);
	});

	it('treats weekday 7 as Sunday', () => {
		const from = new Date(2026, 8, 12, 6, 0, 0).getTime(); // Saturday
		expect(nextCronRun('0 0 * * 7', from)).toBe(new Date(2026, 8, 13, 0, 0, 0).getTime());
		expect(nextCronRun('0 0 * * 0', from)).toBe(new Date(2026, 8, 13, 0, 0, 0).getTime());
	});

	it('fires on either day field when both are restricted', () => {
		// 2026-09-13 is a Sunday and the 13th: day-of-month alone matches.
		expect(nextCronRun('0 0 13 * 5', new Date(2026, 8, 12, 6, 0, 0).getTime())).toBe(
			new Date(2026, 8, 13, 0, 0, 0).getTime()
		);
		// From the 14th, Friday the 18th matches day-of-week alone.
		expect(nextCronRun('0 0 13 * 5', new Date(2026, 8, 14, 6, 0, 0).getTime())).toBe(
			new Date(2026, 8, 18, 0, 0, 0).getTime()
		);
		// Requiring both would give 2026-11-13, a Friday that is also the 13th.
		expect(nextCronRun('0 0 13 * 5', new Date(2026, 8, 12, 6, 0, 0).getTime())).not.toBe(
			new Date(2026, 10, 13, 0, 0, 0).getTime()
		);
	});

	it('lets the one restricted day field decide', () => {
		// Monday 2026-09-14 09:00 is both the next Monday and the next 14th.
		const monday = new Date(2026, 8, 14, 9, 0, 0).getTime();
		expect(nextCronRun('0 9 * * 1', new Date(2026, 8, 14, 8, 0, 0).getTime())).toBe(monday);
		expect(nextCronRun('0 9 14 * *', new Date(2026, 8, 13, 9, 0, 0).getTime())).toBe(monday);
		// The unrestricted field must not filter: the next 14th is a Wednesday.
		expect(nextCronRun('0 9 14 * *', new Date(2026, 8, 14, 9, 0, 0).getTime())).toBe(
			new Date(2026, 9, 14, 9, 0, 0).getTime()
		);
	});

	it('rolls over day, week, month and year boundaries', () => {
		// Day: just after the 06:30 run.
		expect(nextCronRun('30 6 * * *', new Date(2026, 8, 11, 6, 31, 0).getTime())).toBe(
			new Date(2026, 8, 12, 6, 30, 0).getTime()
		);
		// Week: Friday 13:00 → Monday 12:00.
		expect(nextCronRun('0 12 * * 1', new Date(2026, 8, 11, 13, 0, 0).getTime())).toBe(
			new Date(2026, 8, 14, 12, 0, 0).getTime()
		);
		// Month from a 30-day month: there is no 31 April, so 31 May.
		expect(nextCronRun('0 0 31 * *', new Date(2026, 3, 30, 12, 0, 0).getTime())).toBe(
			new Date(2026, 4, 31, 0, 0, 0).getTime()
		);
		// February has no 31st either: 1 Feb → 31 Mar.
		expect(nextCronRun('0 0 31 * *', new Date(2026, 1, 1, 0, 0, 0).getTime())).toBe(
			new Date(2026, 2, 31, 0, 0, 0).getTime()
		);
		// June (30 days) is skipped after 31 May.
		expect(nextCronRun('0 0 31 * *', new Date(2026, 4, 31, 0, 0, 0).getTime())).toBe(
			new Date(2026, 6, 31, 0, 0, 0).getTime()
		);
		// Year: past 1 January → the next year's.
		expect(nextCronRun('0 0 1 1 *', new Date(2026, 2, 2, 0, 0, 0).getTime())).toBe(
			new Date(2027, 0, 1, 0, 0, 0).getTime()
		);
		expect(nextCronRun('0 0 1 1 *', new Date(2027, 0, 1, 0, 0, 0).getTime())).toBe(
			new Date(2028, 0, 1, 0, 0, 0).getTime()
		);
	});

	it('finds a 29 February more than a year away', () => {
		// The next leap day after 2026-09-12 is 535 days out.
		expect(nextCronRun('0 0 29 2 *', new Date(2026, 8, 12, 6, 0, 0).getTime())).toBe(
			new Date(2028, 1, 29, 0, 0, 0).getTime()
		);
		// The longest gap between leap days: 2100 is not one, so 2096 jumps to 2104.
		expect(nextCronRun('0 0 29 2 *', new Date(2096, 2, 1, 0, 0, 0).getTime())).toBe(
			new Date(2104, 1, 29, 0, 0, 0).getTime()
		);
		// With both day fields restricted the OR rule applies, so a February Monday
		// matches even when it is not the 29th (2096-2104 is no longer the answer).
		expect(nextCronRun('0 0 29 2 1', new Date(2072, 2, 1, 0, 0, 0).getTime())).toBe(
			new Date(2073, 1, 6, 0, 0, 0).getTime()
		);
	});

	it('gives up on dates that never exist instead of inventing one', () => {
		const from = new Date(2026, 0, 1).getTime();
		expect(nextCronRun('0 0 30 2 *', from)).toBeNull();
		expect(nextCronRun('0 0 31 2 *', from)).toBeNull();
		expect(nextCronRun('0 0 31 4 *', from)).toBeNull();
	});

	it('rejects malformed and out-of-range expressions', () => {
		const from = new Date(2026, 8, 12).getTime();
		for (const expr of [
			'',
			'   ',
			'not a cron',
			'* * * *',
			'* * * * * *',
			'61 * * * *',
			'99 * * * *',
			'* 24 * * *',
			'* * 0 * *',
			'* * 32 * *',
			'* * * 0 *',
			'* * * 13 *',
			'* * * * 8',
			'5-2 * * * *',
			'1,,3 * * * *',
			'-5 * * * *',
			'5- * * * *',
			'1e1 * * * *',
			'1.5 * * * *',
			'*/0 * * * *',
			'*/-2 * * * *',
			'* * * * MON'
		]) {
			expect(nextCronRun(expr, from), expr).toBeNull();
		}
	});
});

describe('scheduleWake / dueWakes', () => {
	it('one-off wake becomes due once run_at has passed', () => {
		const runAt = Date.now() + 60_000;
		const wake = scheduleWake(botId, convId, 'stretch break', { runAt });
		expect(wake.run_at).toBe(runAt);
		expect(dueWakes(Date.now()).map((w) => w.id)).not.toContain(wake.id);
		expect(dueWakes(runAt).map((w) => w.id)).toContain(wake.id);
	});

	it('cron wake becomes due when its stored next run passes', () => {
		const wake = scheduleWake(botId, convId, 'quarter-hourly check', {
			cron: '*/15 * * * *'
		});
		expect(wake.cron).toBe('*/15 * * * *');
		expect(wake.run_at).toBeGreaterThan(Date.now());
		expect(dueWakes(Date.now()).map((w) => w.id)).not.toContain(wake.id);
		expect(dueWakes(wake.run_at).map((w) => w.id)).toContain(wake.id);
	});

	it('rejects an invalid cron expression and a missing schedule', () => {
		expect(() => scheduleWake(botId, convId, 'x', { cron: 'bogus' })).toThrow(/invalid cron/);
		expect(() => scheduleWake(botId, convId, 'x')).toThrow(/runAt or cron/);
	});
});

/**
 * A waits row as an older build wrote it: description and url, no kind, no spec,
 * no bounds. Rows like this are what a database from before watches contains.
 */
function insertLegacyWait(url: string, description: string): string {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO waits (id, bot_id, conversation_id, description, url, contains, created_at) VALUES (?,?,?,?,?,?,?)'
	).run(id, botId, convId, description, url, '', BASE);
	return id;
}

/** The note a fired watch left in the watching bot's own conversation. */
function wakeNote(): string {
	return listMessages(convId).find((m) => m.content.startsWith('[Wait satisfied:'))?.content ?? '';
}

describe('waiting costs nothing', () => {
	it('makes no model call, and touches no page, over two hours of an unsatisfied watch', async () => {
		const fetchMock = vi.fn(async () => new Response('nothing to see', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const wait = createWait(botId, convId, 'a word that never turns up', {
			spec: { pattern: 'unobtainium' }
		});

		// Two hours at the scheduler's own cadence, every check unsatisfied.
		for (let i = 1; i <= 480; i++) await checkWaits(BASE + i * TICK);

		expect(complete).not.toHaveBeenCalled();
		expect(runBotTurn).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
	});

	it('polls an http watch once a minute rather than once a tick', async () => {
		const fetchMock = vi.fn(async () => new Response('still building', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const wait = createWait(botId, convId, 'the build finishes', {
			url: 'https://example.com/build',
			contains: 'DONE'
		});

		// Armed: the first look is immediate.
		await checkWaits(BASE + TICK);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Three more ticks inside the same minute are left alone.
		for (let i = 2; i <= 4; i++) await checkWaits(BASE + i * TICK);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// ...and the minute that has passed is looked at again.
		await checkWaits(BASE + 5 * TICK);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(complete).not.toHaveBeenCalled();
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
	});

	it('honours an interval the bot asked for', async () => {
		const fetchMock = vi.fn(async () => new Response('idle', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		createWait(botId, convId, 'hourly look', {
			url: 'https://example.com/status',
			contains: 'DONE',
			everySeconds: 3600
		});

		await checkWaits(BASE + TICK);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// An hour later: the second look. Ticked past the hour so the gap since the
		// first look is a full 3600s, and no further.
		for (let i = 2; i <= 242; i++) await checkWaits(BASE + i * TICK);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('a message watch', () => {
	it('wakes on the message it was waiting for, and says who said it', async () => {
		const wait = createWait(botId, convId, 'someone says deploy', {
			spec: { pattern: 'deploy' }
		});
		vi.setSystemTime(BASE + 60_000);
		addMessage(convId, 'user', 'the deploy is finished');

		await checkWaits(BASE + 90_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('[Wait satisfied: someone says deploy]');
		expect(wakeNote()).toContain('the deploy is finished');
		// The note is the app speaking, not somebody in the room.
		expect(listMessages(convId).at(-1)?.kind).toBe('app');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
		expect(complete).not.toHaveBeenCalled();
	});

	it('does not wake for what was said before it was armed', async () => {
		addMessage(convId, 'user', 'the deploy is finished');
		vi.setSystemTime(BASE + 60_000);
		const wait = createWait(botId, convId, 'a deploy', { spec: { pattern: 'deploy' } });

		await checkWaits(BASE + 120_000);

		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();
	});

	it('can wait for a person, not for the app talking to itself', async () => {
		const wait = createWait(botId, convId, 'the user says hello', {
			spec: { pattern: 'hello', from: 'user' }
		});
		vi.setSystemTime(BASE + 60_000);
		addMessage(convId, 'user', '[Routine: Nightly] say hello', '', '', 0, 'app');
		await checkWaits(BASE + 90_000);
		expect(listWaits().map((w) => w.id)).toContain(wait.id);

		vi.setSystemTime(BASE + 120_000);
		addMessage(convId, 'user', 'hello there');
		await checkWaits(BASE + 150_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('can wait to be named', async () => {
		const wait = createWait(botId, convId, 'someone asks for me', { spec: { mentions_me: true } });
		vi.setSystemTime(BASE + 60_000);
		addMessage(convId, 'user', 'is anyone about?');
		await checkWaits(BASE + 90_000);
		expect(listWaits().map((w) => w.id)).toContain(wait.id);

		vi.setSystemTime(BASE + 120_000);
		addMessage(convId, 'user', '@WakeBot take a look please');
		await checkWaits(BASE + 150_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('can watch a room it is not in, and names that room in the note', async () => {
		const wait = createWait(botId, convId, 'the other room mentions a deploy', {
			spec: { pattern: 'deploy', conversation: 'Bots only' }
		});
		vi.setSystemTime(BASE + 60_000);
		addMessage(roomId, 'assistant', 'the deploy went out', roomBotId, 'm1');

		await checkWaits(BASE + 90_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('RoomBot');
		expect(wakeNote()).toContain('in "Bots only"');
		// Woken where it lives, not left standing in the room it was watching.
		expect(runBotTurn).toHaveBeenCalledWith(
			expect.objectContaining({ id: convId }),
			expect.objectContaining({ id: botId }),
			expect.anything()
		);
	});

	it('does not wake on the watching bot\'s own reply', async () => {
		const wait = createWait(botId, convId, 'anything new', {});
		vi.setSystemTime(BASE + 60_000);
		// The bot's own words, persisted the way a turn persists them.
		addMessage(convId, 'assistant', 'my own reply', botId, 'm1');

		await checkWaits(BASE + 90_000);

		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();
	});

	it('still wakes on its own message when it asks for them by name', async () => {
		const wait = createWait(botId, convId, 'my own words', { spec: { from: 'me' } });
		vi.setSystemTime(BASE + 60_000);
		addMessage(convId, 'assistant', 'something I said', botId, 'm1');

		await checkWaits(BASE + 90_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('can match a regular expression, and refuses one that will not compile', async () => {
		createWait(botId, convId, 'a version number', {
			spec: { pattern: 'v\\d+\\.\\d+', regex: true }
		});
		vi.setSystemTime(BASE + 60_000);
		addMessage(convId, 'user', 'shipped v2.4 today');

		await checkWaits(BASE + 90_000);
		expect(runBotTurn).toHaveBeenCalledTimes(1);

		expect(() =>
			createWait(botId, convId, 'bad', { spec: { pattern: '(', regex: true } })
		).toThrow(/regular expression/);
	});
});

describe('events inside the app', () => {
	it('wakes when a file lands in the bot inventory', async () => {
		const wait = createWait(botId, convId, 'the report lands', {
			kind: 'file',
			spec: { pattern: 'report' }
		});
		vi.setSystemTime(BASE + 60_000);
		addBotFile({
			id: randomUUID(),
			bot_id: botId,
			name: 'report.pdf',
			size: 2048,
			mime: 'application/pdf',
			file: 'stored.pdf'
		});

		await checkWaits(BASE + 90_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('file "report.pdf" arrived');
		expect(wakeNote()).toContain('2.0 KB');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('wakes when one of its background tasks finishes', async () => {
		const wait = createWait(botId, convId, 'the summary is done', {
			kind: 'task',
			spec: { pattern: 'summarise' }
		});
		vi.setSystemTime(BASE + 60_000);
		const task = createTask(convId, botId, 'summarise the logs');

		await checkWaits(BASE + 90_000);
		expect(listWaits().map((w) => w.id)).toContain(wait.id); // still running

		vi.setSystemTime(BASE + 120_000);
		finishTask(task.id, 'done', { messageId: 'm1' });
		await checkWaits(BASE + 150_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('task "summarise the logs" finished');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('wakes on an activity, so a routine finishing is something it can wait for', async () => {
		const wait = createWait(botId, convId, 'the nightly routine ends', {
			kind: 'activity',
			spec: { activity_kind: 'routine', pattern: 'Finished' }
		});
		vi.setSystemTime(BASE + 60_000);
		logActivity(botId, 'routine', 'Running routine "Nightly"');
		await checkWaits(BASE + 90_000);
		expect(listWaits().map((w) => w.id)).toContain(wait.id); // the start is not the end

		vi.setSystemTime(BASE + 120_000);
		logActivity(botId, 'routine', 'Finished routine "Nightly"');
		await checkWaits(BASE + 150_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('routine: Finished routine "Nightly"');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});
});

describe('an http watch', () => {
	it('wakes when the page contains the string it named', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('build DEPLOYED ok', { status: 200 })));
		const wait = createWait(botId, convId, 'deploy finished', {
			url: 'https://example.com/status',
			contains: 'DEPLOYED'
		});

		await checkWaits(BASE + TICK);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('https://example.com/status');
		expect(wakeNote()).toContain('DEPLOYED');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
		expect(runBotTurn).toHaveBeenCalledWith(
			expect.objectContaining({ id: convId }),
			expect.objectContaining({ id: botId }),
			expect.anything()
		);
		// A page is not a model: nothing here is worth a token.
		expect(complete).not.toHaveBeenCalled();
	});

	it('refuses a redirect to an internal address instead of following it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data/' }
			}))
		);
		const wait = createWait(botId, convId, 'the build', {
			url: 'https://example.com/build',
			contains: 'DONE'
		});

		await checkWaits(BASE + TICK);

		// The watch is dropped rather than turned into an SSRF probe.
		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();
		expect(listActivities(botId).some((a) => a.detail.includes('redirect refused'))).toBe(true);
	});

	it('follows a redirect to a public address and fires on what it finds', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) =>
				String(url).endsWith('/moved')
					? new Response('build DONE ok', { status: 200 })
					: new Response(null, { status: 302, headers: { location: '/moved' } })
			)
		);
		const wait = createWait(botId, convId, 'the build', {
			url: 'https://example.com/build',
			contains: 'DONE'
		});

		await checkWaits(BASE + TICK);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('stays armed while the page lacks the string, or fails, or is an error status', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('still building', { status: 200 })));
		const wait = createWait(botId, convId, 'deploy finished', {
			url: 'https://example.com/status',
			contains: 'DEPLOYED'
		});
		await checkWaits(BASE + TICK);
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);
		await expect(checkWaits(BASE + 120_000)).resolves.toBeUndefined();
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();

		vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
		await expect(checkWaits(BASE + 240_000)).resolves.toBeUndefined();
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();
	});

	it('can wait for a status code instead of a body', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
		const wait = createWait(botId, convId, 'the site falls over', {
			kind: 'http',
			url: 'https://example.com',
			spec: { status: 503 }
		});

		await checkWaits(BASE + TICK);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('HTTP 503');
		// A 503 is the thing being watched for, not a failed check.
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('waits for the page to change, taking the first look as the baseline', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('version one', { status: 200 })));
		const wait = createWait(botId, convId, 'the page changes', {
			kind: 'http',
			url: 'https://example.com',
			spec: { changed: true }
		});

		await checkWaits(BASE + TICK);
		expect(listWaits().map((w) => w.id)).toContain(wait.id); // baseline, not a change
		expect(runBotTurn).not.toHaveBeenCalled();

		vi.stubGlobal('fetch', vi.fn(async () => new Response('version two', { status: 200 })));
		await checkWaits(BASE + 90_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('changed');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});
});

describe('a webhook watch', () => {
	it('wakes on the POST it was waiting for, and stays armed for any other', async () => {
		const wait = createWait(botId, convId, 'ci reports a failure', {
			kind: 'webhook',
			spec: { pattern: 'failed' }
		});
		expect(wait.token).not.toBe('');
		expect(wait.url).toBe(`/api/hooks/${wait.token}`);

		// A POST that is not the one it is waiting for changes nothing at all.
		expect(await fireWatchByToken(wait.token, '{"status":"ok"}')).toBe(true);
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();

		vi.setSystemTime(BASE + 60_000);
		expect(await fireWatchByToken(wait.token, '{"status":"failed"}')).toBe(true);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		// The reply runs as a background task, so the POST is not held open for
		// the whole turn - the task row is what carries it now.
		expect(listTasks({ botId }).at(-1)?.prompt).toContain('Wait satisfied');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
		expect(complete).not.toHaveBeenCalled();

		// A token that belongs to nobody is left to the ordinary webhook path.
		expect(await fireWatchByToken('not-a-token', 'x')).toBe(false);
	});
});

describe('a watch stays bounded', () => {
	it('gives up when it expires, and says so', async () => {
		const wait = createWait(botId, convId, 'something that never happens', {
			spec: { pattern: 'unobtainium' },
			expiresMinutes: 5
		});

		await checkWaits(BASE + 60_000);
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		await checkWaits(BASE + 5 * 60_000);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();
		expect(listActivities(botId).some((a) => a.detail.includes('expired'))).toBe(true);
	});

	it('arms an identical watch only once, so asking twice cannot stack two turns', () => {
		const first = createWait(botId, convId, 'the deploy', { spec: { pattern: 'deploy' } });
		const second = createWait(botId, convId, 'the deploy', { spec: { pattern: 'deploy' } });

		expect(second.id).toBe(first.id);
		expect(listWaits(botId)).toHaveLength(1);
	});

	it('holds a gated watch until its cron time, then lets it fire', async () => {
		const wait = createWait(botId, convId, 'a deploy by nine', {
			spec: { pattern: 'deploy', at: '0 9 * * 1-5' }
		});
		vi.setSystemTime(BASE + 60_000);
		addMessage(convId, 'user', 'the deploy is green');

		// 10:00 on Monday: the gate is next Tuesday 09:00, so nothing is looked at.
		await checkWaits(BASE + 90_000);
		expect(listWaits().map((w) => w.id)).toContain(wait.id);
		expect(runBotTurn).not.toHaveBeenCalled();

		await checkWaits(new Date(2026, 8, 15, 9, 0, 0).getTime());

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(wakeNote()).toContain('the deploy is green');
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('re-arms a gated watch to the next window when its condition is not met', async () => {
		createWait(botId, convId, 'a deploy by nine', {
			spec: { pattern: 'never', at: '0 9 * * 1-5' }
		});
		const tuesday9 = new Date(2026, 8, 15, 9, 0, 0).getTime();

		await checkWaits(tuesday9);

		expect(readSpec(listWaits(botId)[0]).gate).toBe(new Date(2026, 8, 16, 9, 0, 0).getTime());
		expect(runBotTurn).not.toHaveBeenCalled();
	});

	it('refuses a watch that could never fire', () => {
		expect(() => createWait(botId, convId, 'a page', { kind: 'http' })).toThrow(/needs a url/);
		expect(() => createWait(botId, convId, 'x', { kind: 'nonsense' })).toThrow(/kind must be one of/);
		expect(() => createWait(botId, convId, 'x', { spec: { at: 'bogus' } })).toThrow(/invalid cron/);
		expect(() =>
			createWait(botId, convId, 'x', { spec: { conversation: 'No Such Room' } })
		).toThrow(/no conversation called/);
	});

	it('refuses to aim an http watch at the app\'s own network', () => {
		// The poll is a fetch from inside the app's Docker network, so an internal
		// target would make the watch a blind SSRF probe (metadata included).
		for (const url of [
			'http://localhost:8080/status',
			'http://127.0.0.1/status',
			'http://10.1.2.3/status',
			'http://172.16.0.1/status',
			'http://192.168.1.1/status',
			'http://169.254.169.254/latest/meta-data/',
			'http://router.local/status',
			'http://waha.internal/status',
			'http://host.docker.internal:11434/status',
			'http://[::1]/status',
			'ftp://example.com/status'
		]) {
			expect(() => createWait(botId, convId, 'a page', { kind: 'http', url }), url).toThrow(
				/internal to the app's network|needs an http/
			);
		}
		// A public page is still watchable.
		const wait = createWait(botId, convId, 'the build', {
			kind: 'http',
			url: 'https://example.com/build'
		});
		expect(wait.url).toBe('https://example.com/build');
		deleteWait(wait.id);
	});

	it('drops a stored watch aimed at an internal address rather than fetching it', async () => {
		const fetchMock = vi.fn(async () => new Response('x', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		// A row an older build could still have written, bypassing createWait.
		const id = insertLegacyWait('http://169.254.169.254/latest/meta-data/', 'the metadata');

		await checkWaits(BASE + TICK);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(listWaits().map((w) => w.id)).not.toContain(id);
	});

	it('drops a watch whose target room goes away, rather than looking at nothing forever', async () => {
		const doomed = createConversation([roomBotId], 'group').id;
		updateConversation(doomed, { title: 'Short lived' });
		const wait = createWait(botId, convId, 'a word in a room that goes', {
			spec: { pattern: 'deploy', conversation: 'Short lived' }
		});

		deleteConversation(doomed);
		await checkWaits(BASE + TICK);

		expect(listWaits().map((w) => w.id)).not.toContain(wait.id);
		expect(listActivities(botId).some((a) => a.detail.includes('Dropped'))).toBe(true);
		expect(runBotTurn).not.toHaveBeenCalled();
	});
});

describe('waits armed before watches existed', () => {
	it('keeps polling a bare url wait, now as an http watch', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('DONE', { status: 200 })));
		const id = insertLegacyWait('https://example.com/build', 'the old url wait');

		await checkWaits(BASE + TICK);

		expect(listWaits().map((w) => w.id)).not.toContain(id);
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('retires an open-ended condition rather than asking a model about it', async () => {
		const id = insertLegacyWait('', 'the user agrees to lunch');

		await checkWaits(BASE + TICK);

		expect(listWaits().map((w) => w.id)).not.toContain(id);
		expect(complete).not.toHaveBeenCalled();
		expect(runBotTurn).not.toHaveBeenCalled();
		expect(listActivities(botId).some((a) => a.detail.includes('Retired'))).toBe(true);
	});
});
