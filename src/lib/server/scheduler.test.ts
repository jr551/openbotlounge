import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';
import {
	addBotTokens,
	addMessage,
	addPoliceAlert,
	conversationBots,
	createBot,
	createConversation,
	createPlugin,
	createRoutine,
	createTask,
	db,
	deleteBot,
	deleteConversation,
	deleteWait,
	deleteWake,
	finishTask,
	listActivities,
	logActivity,
	listBots,
	listConversations,
	listMessages,
	listRoutines,
	listWaits,
	listWakes,
	setWakeRunAt,
	writeUpPoliceRecord,
	type Bot,
	type Conversation,
	type Routine
} from './db';
import { bloatLabel, shortTokens } from '../bloat';
import { resetSocialState, startScheduler, tick } from './scheduler';
import { runBotTurn, type BotTurnResult } from './runner';
import { reapIdleMachines } from './machine';
import { complete } from './llm';
import { createWait, scheduleWake } from './wake';

vi.mock('./runner', () => ({
	runBotTurn: vi.fn(async () => ({ text: 'ok', message: null, aborted: false, stoppedBy: '' }))
}));

// The tick reaps Docker sandboxes; no container is reachable from a unit test.
vi.mock('./machine', () => ({
	reapIdleMachines: vi.fn(async () => {})
}));
// The turn reads the bot's personality file through a throwaway container;
// the tests have no docker, so the drive reads as empty.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));


vi.mock('./llm', () => ({
	complete: vi.fn(async () => 'NO')
}));

const turnResult: BotTurnResult = {
	text: 'ok',
	message: null,
	aborted: false,
	stoppedBy: '',
	silent: false
};

/** Monday 2026-09-14 10:00:00 local, the instant every test starts from. */
const BASE = new Date(2026, 8, 14, 10, 0, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 3_600_000;

const bots: string[] = [];
const convs: string[] = [];
const plugins: string[] = [];
const alerts: string[] = [];
const orphans: { table: string; id: string }[] = [];
let social = config.social;
let socialInterval = config.socialIntervalMin;

function makeBot(name = 'TickBot'): Bot {
	const bot = createBot({
		name,
		persona: '',
		avatar: '🤖',
		color: '#fff',
		model: 'm1',
		badge: ''
	});
	bots.push(bot.id);
	return bot;
}

function makeConv(bot: Bot): Conversation {
	const conv = createConversation([bot.id], 'direct');
	convs.push(conv.id);
	return conv;
}

type RoutineOverrides = Partial<
	Pick<Routine, 'name' | 'prompt' | 'interval_min' | 'cron' | 'next_run_at' | 'enabled'>
>;

function makeRoutine(bot: Bot, conv: Conversation, over: RoutineOverrides = {}): Routine {
	return createRoutine({
		bot_id: bot.id,
		conversation_id: conv.id,
		name: 'Daily',
		prompt: 'say hi',
		interval_min: 1,
		cron: '',
		enabled: 1,
		...over
	});
}

const routineRow = (id: string): Routine => listRoutines().find((r) => r.id === id)!;
const wakeRow = (id: string) => listWakes().find((w) => w.id === id);
const waitRow = (id: string) => listWaits().find((w) => w.id === id);
const turnsFor = (botId: string) =>
	vi.mocked(runBotTurn).mock.calls.filter(([, bot]) => bot.id === botId).length;
const turnsIn = (convId: string) =>
	vi.mocked(runBotTurn).mock.calls.filter(([conv]) => conv.id === convId).length;
const routineMessages = (convId: string) =>
	listMessages(convId).filter((m) => m.content.startsWith('[Routine:'));

/**
 * A row the `ON DELETE CASCADE` foreign keys would normally have removed - what a
 * database written by an older build (or hand-edited with the FKs off) can leave
 * behind. Nothing in the app can produce one today, but the tick guards against
 * it, and this is how that guard is exercised.
 */
function insertOrphan(table: 'routines' | 'wake_tasks' | 'waits', botId: string, convId: string): string {
	const id = `orphan-${table}-${orphans.length}`;
	db.exec('PRAGMA foreign_keys = OFF');
	try {
		if (table === 'routines') {
			db.prepare(
				'INSERT INTO routines (id, bot_id, conversation_id, name, prompt, interval_min, cron, next_run_at, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
			).run(id, botId, convId, 'Orphan', 'orphaned prompt', 1, '', BASE, 1, BASE);
		} else if (table === 'wake_tasks') {
			db.prepare(
				'INSERT INTO wake_tasks (id, bot_id, conversation_id, prompt, run_at, cron, enabled, created_at) VALUES (?,?,?,?,?,?,?,?)'
			).run(id, botId, convId, 'orphaned wake', BASE, '', 1, BASE);
		} else {
			db.prepare(
				'INSERT INTO waits (id, bot_id, conversation_id, description, url, contains, created_at) VALUES (?,?,?,?,?,?,?)'
			).run(id, botId, convId, 'orphaned wait', 'https://example.com/orphan', '', BASE);
		}
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
	orphans.push({ table, id });
	return id;
}

/** Move the process clock and run one pass of the loop. */
async function tickAt(ms: number): Promise<void> {
	vi.setSystemTime(ms);
	await tick();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE);
	// Auto social chats would turn up in runBotTurn's call list without this.
	config.social = false;
	// The social clock and round count are process state; without this a test
	// inherits whatever the last one left and its ticks and rounds depend on order.
	resetSocialState();
	// The police cooldown is durable state, so one test's inspection would
	// otherwise silence the next test's.
	db.prepare("DELETE FROM settings WHERE key = 'lounge_inspection_at'").run();
	vi.mocked(runBotTurn).mockResolvedValue(turnResult);
	vi.mocked(complete).mockResolvedValue('NO');
	vi.mocked(reapIdleMachines).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	config.social = social;
	config.socialIntervalMin = socialInterval;
	for (const w of listWakes()) if (bots.includes(w.bot_id)) deleteWake(w.id);
	for (const w of listWaits()) if (bots.includes(w.bot_id)) deleteWait(w.id);
	for (const o of orphans) db.prepare(`DELETE FROM ${o.table} WHERE id = ?`).run(o.id);
	orphans.length = 0;
	for (const b of bots) db.prepare('DELETE FROM activities WHERE bot_id = ?').run(b);
	for (const p of plugins) db.prepare('DELETE FROM plugins WHERE id = ?').run(p);
	plugins.length = 0;
	// Police alerts outlive their bot by design, so the test has to take its own.
	for (const id of alerts) db.prepare('DELETE FROM police_alerts WHERE id = ?').run(id);
	alerts.length = 0;
	for (const b of bots) deleteBot(b);
	for (const c of convs) deleteConversation(c);
	bots.length = 0;
	convs.length = 0;
	vi.clearAllMocks();
});

describe('routine firing', () => {
	it('fires once per interval and remembers the fire in next_run_at', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const routine = makeRoutine(bot, conv, { interval_min: 1, next_run_at: BASE });

		await tickAt(BASE);
		expect(turnsFor(bot.id)).toBe(1);
		expect(routineMessages(conv.id)).toHaveLength(1);
		// The fire is remembered by moving the row's next_run_at forward, not by
		// keeping a "last fired" timestamp: that is what stops a second tick in
		// the same minute from firing it again.
		expect(routineRow(routine.id).next_run_at).toBe(BASE + MINUTE);

		await tickAt(BASE + 10_000);
		await tickAt(BASE + 59_000);
		expect(turnsFor(bot.id)).toBe(1);
		expect(routineMessages(conv.id)).toHaveLength(1);

		// ...and the routine is not stuck: the next interval fires it again.
		await tickAt(BASE + MINUTE);
		expect(turnsFor(bot.id)).toBe(2);
	});

	it('fires a cron routine once per matching minute', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const routine = makeRoutine(bot, conv, { cron: '* * * * *', next_run_at: BASE });

		for (const offset of [0, 15_000, 30_000, 45_000, 59_000]) await tickAt(BASE + offset);
		expect(turnsFor(bot.id)).toBe(1);
		expect(routineRow(routine.id).next_run_at).toBe(BASE + MINUTE);

		await tickAt(BASE + MINUTE);
		expect(turnsFor(bot.id)).toBe(2);
	});

	it('fires a routine once after the clock skipped several intervals', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const interval = makeRoutine(bot, conv, { interval_min: 1, next_run_at: BASE - 5 * MINUTE });
		const cron = makeRoutine(bot, conv, { cron: '* * * * *', next_run_at: BASE - 10 * MINUTE });

		await tickAt(BASE);
		// One run each, not one per missed interval - and no backlog is replayed.
		expect(turnsFor(bot.id)).toBe(2);
		expect(routineMessages(conv.id)).toHaveLength(2);
		expect(routineRow(interval.id).next_run_at).toBe(BASE + MINUTE);
		expect(routineRow(cron.id).next_run_at).toBe(BASE + MINUTE);

		await tickAt(BASE + 10_000);
		expect(turnsFor(bot.id)).toBe(2);
	});

	it('says who created the routine in the firing message', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		makeRoutine(bot, conv, { name: 'Mine', next_run_at: BASE });
		createRoutine({
			bot_id: bot.id,
			conversation_id: conv.id,
			name: 'Theirs',
			prompt: 'say hi',
			interval_min: 1,
			cron: '',
			next_run_at: BASE,
			enabled: 1,
			created_by: 'human'
		});

		await tickAt(BASE);

		const fired = routineMessages(conv.id).map((m) => m.content);
		// A routine the bot made itself reads as its own; one the human made is
		// named, so the bot does not disown - or cancel - a schedule it did not
		// set.
		expect(fired.find((c) => c.startsWith('[Routine: Mine]'))).toContain('created by you');
		const theirs = fired.find((c) => c.startsWith('[Routine: Theirs]'));
		expect(theirs).toContain('created by the human');
		expect(theirs).toContain('do not cancel a routine the human made');
	});

	it('keeps firing a failing routine on its schedule instead of wedging the loop', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const routine = makeRoutine(bot, conv, { next_run_at: BASE });
		vi.mocked(runBotTurn).mockRejectedValueOnce(new Error('provider down'));

		await tickAt(BASE);
		expect(turnsFor(bot.id)).toBe(1);
		expect(listActivities(bot.id).map((a) => a.kind)).toContain('error');
		// Rescheduled, not dropped: a transient provider failure must not disable
		// the routine, and the tick itself must not have thrown.
		expect(routineRow(routine.id).next_run_at).toBe(BASE + MINUTE);

		await tickAt(BASE + MINUTE);
		expect(turnsFor(bot.id)).toBe(2);
	});
});

describe('wakes', () => {
	it('runs a due one-off wake once and then removes the row', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const wake = scheduleWake(bot.id, conv.id, 'stretch break', { runAt: BASE - 1000 });

		await tickAt(BASE);
		expect(turnsFor(bot.id)).toBe(1);
		expect(listMessages(conv.id).map((m) => m.content)).toEqual([
			expect.stringMatching(/^\[Scheduled\] stretch break\nWake id: /)
		]);
		expect(wakeRow(wake.id)).toBeUndefined();

		await tickAt(BASE + 15_000);
		expect(turnsFor(bot.id)).toBe(1);
		expect(listMessages(conv.id).filter((m) => m.content.includes('stretch break'))).toHaveLength(
			1
		);
	});

	it('removes a failed one-off wake so it cannot retry forever', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const wake = scheduleWake(bot.id, conv.id, 'flaky job', { runAt: BASE });
		vi.mocked(runBotTurn).mockRejectedValueOnce(new Error('provider down'));

		await tickAt(BASE);
		expect(listActivities(bot.id).map((a) => a.kind)).toContain('error');
		expect(wakeRow(wake.id)).toBeUndefined();

		// A second tick has nothing to retry.
		vi.mocked(runBotTurn).mockResolvedValue(turnResult);
		await tickAt(BASE + 15_000);
		expect(turnsFor(bot.id)).toBe(1);
	});

	it('advances a cron wake whose run failed so it cannot refire on every tick', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const wake = scheduleWake(bot.id, conv.id, 'quarter-hourly', { cron: '*/15 * * * *' });
		setWakeRunAt(wake.id, BASE);
		vi.mocked(runBotTurn).mockRejectedValueOnce(new Error('provider down'));

		await tickAt(BASE);
		expect(listActivities(bot.id).map((a) => a.kind)).toContain('error');
		// The row is marked, not deleted: it is due again only at its next slot.
		expect(wakeRow(wake.id)?.run_at).toBe(BASE + 15 * MINUTE);
		expect(turnsFor(bot.id)).toBe(1);

		vi.mocked(runBotTurn).mockResolvedValue(turnResult);
		await tickAt(BASE + 15_000);
		expect(turnsFor(bot.id)).toBe(1);
	});

	it('advances a cron wake to its next occurrence instead of deleting it', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const wake = scheduleWake(bot.id, conv.id, 'quarter-hourly', { cron: '*/15 * * * *' });
		expect(wake.run_at).toBe(BASE + 15 * MINUTE);
		// A wake stuck ten minutes in the past (the process was down) fires once.
		setWakeRunAt(wake.id, BASE - 10 * MINUTE);

		await tickAt(BASE);
		expect(turnsFor(bot.id)).toBe(1);
		expect(wakeRow(wake.id)?.run_at).toBe(BASE + 15 * MINUTE);

		await tickAt(BASE + 10_000);
		expect(turnsFor(bot.id)).toBe(1);

		await tickAt(BASE + 15 * MINUTE);
		expect(turnsFor(bot.id)).toBe(2);
		expect(wakeRow(wake.id)?.run_at).toBe(BASE + 30 * MINUTE);
	});
});

describe('wait conditions', () => {
	it('fires a wait that has become true, then removes it before running the bot', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('build DEPLOYED ok', { status: 200 })));
		const wait = createWait(bot.id, conv.id, 'deploy finished', {
			url: 'https://example.com/status',
			contains: 'DEPLOYED'
		});

		await tickAt(BASE);
		expect(waitRow(wait.id)).toBeUndefined();
		// One note: what was being watched, and what the check actually found.
		expect(listMessages(conv.id).map((m) => m.content)).toEqual([
			expect.stringMatching(
				/\[Wait satisfied: deploy finished\]\n.*https:\/\/example\.com\/status.*DEPLOYED/
			)
		]);
		expect(turnsFor(bot.id)).toBe(1);
	});

	it('does not re-fire a satisfied wait whose reply failed', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('DEPLOYED', { status: 200 })));
		const wait = createWait(bot.id, conv.id, 'deploy finished', {
			url: 'https://example.com/status',
			contains: 'DEPLOYED'
		});
		vi.mocked(runBotTurn).mockRejectedValueOnce(new Error('provider down'));

		await tickAt(BASE);
		expect(waitRow(wait.id)).toBeUndefined();
		expect(listActivities(bot.id).map((a) => a.kind)).toContain('error');

		vi.mocked(runBotTurn).mockResolvedValue(turnResult);
		await tickAt(BASE + 15_000);
		expect(turnsFor(bot.id)).toBe(1);
	});

	it('keeps a wait whose poll request timed out instead of reading it as satisfied', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			})
		);
		const wait = createWait(bot.id, conv.id, 'deploy finished', {
			url: 'https://example.com/status',
			contains: 'DEPLOYED'
		});

		await tickAt(BASE);
		expect(waitRow(wait.id)).toBeDefined();
		expect(turnsFor(bot.id)).toBe(0);
		expect(listActivities(bot.id).map((a) => a.kind)).toContain('error');
	});

	it('fires a pattern watch on a matching message, without asking a model', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const wait = createWait(bot.id, conv.id, 'the user mentions lunch', {
			spec: { pattern: 'lunch' }
		});

		await tickAt(BASE);
		expect(waitRow(wait.id)).toBeDefined();
		expect(turnsFor(bot.id)).toBe(0);

		vi.setSystemTime(BASE + 20_000);
		addMessage(conv.id, 'user', 'shall we do lunch?');
		await tickAt(BASE + 30_000);

		expect(waitRow(wait.id)).toBeUndefined();
		expect(turnsFor(bot.id)).toBe(1);
		expect(complete).not.toHaveBeenCalled();
	});

	it(
		'spends nothing at all on a watch that never comes true, however many ticks pass',
		async () => {
			const bot = makeBot();
			const conv = makeConv(bot);
			const wait = createWait(bot.id, conv.id, 'a word that never comes', {
				spec: { pattern: 'unobtainium' }
			});

			// An hour of the loop's own cadence, every tick ending unsatisfied.
			for (let i = 0; i < 240; i++) await tickAt(BASE + i * 15_000);

			expect(waitRow(wait.id)).toBeDefined();
			expect(turnsFor(bot.id)).toBe(0);
			expect(complete).not.toHaveBeenCalled();
		},
		// 240 awaited ticks is real work; the default 5s is too tight under load.
		30_000
	);

	it('keeps a wait that never comes true, until its own expiry says otherwise', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const fetchMock = vi.fn(async () => new Response('still building', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const wait = createWait(bot.id, conv.id, 'never finishes', {
			url: 'https://example.com/status',
			contains: 'DONE'
		});

		await tickAt(BASE);
		await tickAt(BASE + 15_000);
		// A day later it is still on the books and still being polled, once a
		// minute rather than once a tick: two looks, not two thousand.
		await tickAt(BASE + 24 * 60 * MINUTE);
		expect(waitRow(wait.id)).toBeDefined();
		expect(turnsFor(bot.id)).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('a broken item does not stop the loop', () => {
	it('runs the healthy routine when a routine with no bot and one with no conversation are due', async () => {
		const bot = makeBot('Healthy');
		const conv = makeConv(bot);
		const healthy = makeRoutine(bot, conv, { name: 'Healthy', next_run_at: BASE });
		// Both orphans are inserted first, so they are hit before the healthy row.
		const noBot = insertOrphan('routines', 'missing-bot', conv.id);
		const noConv = insertOrphan('routines', bot.id, 'missing-conversation');

		await tickAt(BASE);

		expect(turnsFor(bot.id)).toBe(1);
		expect(routineMessages(conv.id).map((m) => m.content)).toEqual([
			expect.stringMatching(/^\[Routine: Healthy\] say hi\nRoutine id: /)
		]);
		// Rescheduled rather than thrown out of the tick, and still on the books.
		expect(routineRow(noBot).next_run_at).toBe(BASE + MINUTE);
		expect(routineRow(noConv).next_run_at).toBe(BASE + MINUTE);
		expect(routineRow(healthy.id).next_run_at).toBe(BASE + MINUTE);
	});

	it('runs the healthy routine when another routine throws', async () => {
		const broken = makeBot('Broken');
		const brokenConv = makeConv(broken);
		makeRoutine(broken, brokenConv, { next_run_at: BASE });
		const healthy = makeBot('Healthy');
		const healthyConv = makeConv(healthy);
		makeRoutine(healthy, healthyConv, { name: 'Healthy', next_run_at: BASE });
		vi.mocked(runBotTurn).mockImplementation(async (_conv, bot) => {
			if (bot.id === broken.id) throw new Error('model unreachable');
			return turnResult;
		});

		await tickAt(BASE);

		expect(turnsFor(broken.id)).toBe(1);
		expect(turnsFor(healthy.id)).toBe(1);
		expect(listActivities(broken.id).map((a) => a.kind)).toContain('error');
		expect(listActivities(healthy.id).map((a) => a.kind)).toContain('routine');
	});

	it('runs the rest of the snapshot when a bot is deleted while the tick is mid-flight', async () => {
		const doomed = makeBot('Doomed');
		const doomedRoutine = makeRoutine(doomed, makeConv(doomed), {
			name: 'Doomed',
			next_run_at: BASE
		});
		const survivor = makeBot('Survivor');
		const survivorConv = makeConv(survivor);
		makeRoutine(survivor, survivorConv, { name: 'Survivor', next_run_at: BASE });
		// The user removes the first bot while its turn is still running: the
		// deleted rows cascade away under the snapshot the tick is holding, so the
		// loop's later lookups find nothing where a bot and conversation used to be.
		vi.mocked(runBotTurn).mockImplementation(async (_conv, bot) => {
			if (bot.id === doomed.id) deleteBot(doomed.id);
			return turnResult;
		});

		const failuresBefore = listActivities('', 10_000).length;

		await tickAt(BASE);

		expect(turnsFor(doomed.id)).toBe(1);
		expect(turnsFor(survivor.id)).toBe(1);
		expect(routineRow(doomedRoutine.id)).toBeUndefined();
		// No scheduler-level failure was logged: the tick never escaped its own catch.
		expect(listActivities('', 10_000)).toHaveLength(failuresBefore);
	});

	it('drops a due wake whose bot is gone without failing the tick', async () => {
		const bot = makeBot('Healthy');
		const conv = makeConv(bot);
		const orphan = insertOrphan('wake_tasks', 'missing-bot', conv.id);
		const healthy = scheduleWake(bot.id, conv.id, 'still here', { runAt: BASE });

		await tickAt(BASE);

		expect(wakeRow(orphan)).toBeUndefined();
		expect(wakeRow(healthy.id)).toBeUndefined();
		expect(turnsFor(bot.id)).toBe(1);
	});

	it('drops a wait whose conversation is gone without failing the tick', async () => {
		const bot = makeBot('Healthy');
		const conv = makeConv(bot);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('DONE', { status: 200 })));
		const orphan = insertOrphan('waits', bot.id, 'missing-conversation');
		const live = createWait(bot.id, conv.id, 'deploy finished', {
			url: 'https://example.com/status',
			contains: 'DONE'
		});

		await tickAt(BASE);

		expect(waitRow(orphan)).toBeUndefined();
		expect(waitRow(live.id)).toBeUndefined();
		expect(turnsFor(bot.id)).toBe(1);
	});
});

describe('one tick', () => {
	it('drives routines, wakes and waits that are all due, each exactly once', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		makeRoutine(bot, conv, { name: 'Morning', next_run_at: BASE });
		scheduleWake(bot.id, conv.id, 'stand-up in five', { runAt: BASE - 1000 });
		vi.stubGlobal('fetch', vi.fn(async () => new Response('DONE', { status: 200 })));
		createWait(bot.id, conv.id, 'build finished', {
			url: 'https://example.com/build',
			contains: 'DONE'
		});

		await tickAt(BASE);

		expect(turnsFor(bot.id)).toBe(3);
		// Routines, then wakes, then waits: the transcript order the user sees.
		// The wait's note carries what happened under its own line, so the bot does
		// not have to go and find out why it was woken.
		expect(listMessages(conv.id).map((m) => m.content)).toEqual([
			expect.stringMatching(/^\[Routine: Morning\] say hi\nRoutine id: /),
			expect.stringMatching(/^\[Scheduled\] stand-up in five\nWake id: /),
			expect.stringMatching(/\[Wait satisfied: build finished\]\n.*https:\/\/example\.com\/build/)
		]);
		expect(listWakes(bot.id)).toHaveLength(0);
		expect(listWaits(bot.id)).toHaveLength(0);
	});
});

describe('overlap', () => {
	it('does not re-enter the loop while a run is still in flight', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const routine = makeRoutine(bot, conv, { next_run_at: BASE });

		let release!: () => void;
		const inFlight = new Promise<void>((resolve) => (release = resolve));
		vi.mocked(runBotTurn).mockImplementation(async () => {
			await inFlight;
			return turnResult;
		});

		const first = tick();
		await Promise.resolve();
		// A tick that arrives while the first is still awaiting the model returns
		// immediately: the same routine cannot be started twice.
		await tick();
		expect(turnsFor(bot.id)).toBe(1);
		expect(routineMessages(conv.id)).toHaveLength(1);

		release();
		await first;
		expect(turnsFor(bot.id)).toBe(1);
		expect(routineMessages(conv.id)).toHaveLength(1);
		expect(routineRow(routine.id).next_run_at).toBe(BASE + MINUTE);

		// The guard is not sticky: the next interval runs normally.
		await tickAt(BASE + MINUTE);
		expect(turnsFor(bot.id)).toBe(2);
	});
});

describe('social chats', () => {
	it('creates one Lounge room and chats in it once per social interval', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		makeBot('Alpha');
		makeBot('Beta');

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		expect(lounge).toBeDefined();
		// README: a private group the bots believe nobody reads.
		expect(lounge.private).toBe(1);
		convs.push(lounge.id);
		// Two of the bots in the database were picked to chat in it, and the
		// opener is the only message.
		expect(conversationBots(lounge.id)).toHaveLength(2);
		expect(turnsIn(lounge.id)).toBe(2);
		expect(listMessages(lounge.id)).toHaveLength(1);
		// Nobody has been written up, so the police are not in the brief at all:
		// a round with nothing on the books says nothing rather than inventing it.
		expect(listMessages(lounge.id)[0].content).not.toContain('the police');

		// A second tick inside the social interval must not spawn another room.
		await tickAt(BASE + 15_000);
		expect(listConversations().filter((c) => c.title === 'Lounge')).toHaveLength(1);
		expect(listMessages(lounge.id)).toHaveLength(1);
		expect(turnsIn(lounge.id)).toBe(2);

		// Past the interval the same room is reused (the title is what makes it
		// findable), rather than a new group being created every time.
		await tickAt(BASE + 61 * MINUTE);
		expect(listConversations().filter((c) => c.title === 'Lounge')).toHaveLength(1);
		expect(conversationBots(lounge.id).length).toBeGreaterThanOrEqual(2);
		expect(listMessages(lounge.id)).toHaveLength(2);
		expect(turnsIn(lounge.id)).toBe(4);
	});

	it('opens with what each bot has actually done, and what was already claimed', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		const alpha = makeBot('Alpha');
		const beta = makeBot('Beta');
		const alphaChat = makeConv(alpha);

		// Alpha has a record to point at; Beta has nothing, and the brief has to
		// say so rather than leave a gap for Beta to fill with an invented boast.
		logActivity(alpha.id, 'shell', 'curl -s https://example.com/meter-reading');
		logActivity(alpha.id, 'typing', 'at the keyboard');
		const task = createTask(alphaChat.id, alpha.id, 'summarise the meter readings');
		finishTask(task.id, 'done');
		makeRoutine(alpha, alphaChat, { name: 'Nightly sweep', interval_min: 1440 });
		const plugin = createPlugin({
			name: 'meter-parser',
			description: '',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: '',
			author_bot_id: alpha.id,
			scope: 'bot',
			enabled: 1
		});
		plugins.push(plugin.id);

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);
		const brief = listMessages(lounge.id)[0].content;

		expect(brief).toContain('curl -s https://example.com/meter-reading');
		expect(brief).toContain('summarise the meter readings');
		expect(brief).toContain('Nightly sweep');
		expect(brief).toContain('meter-parser');
		// Typing is not work: reciting it would pad Alpha's record with nothing.
		expect(brief).not.toContain('at the keyboard');
		expect(brief).toContain('Beta has actually done lately:\n- nothing on record yet');

		// The room's own history is fed to the next pair, so a bot can see that it
		// has done the same job, or that someone is claiming a win twice.
		addMessage(lounge.id, 'assistant', 'I already rewrote the meter parser', beta.id, 'm1');
		await tickAt(BASE + 61 * MINUTE);
		expect(listMessages(lounge.id)[1].content).toContain('I already rewrote the meter parser');
	});

	it('does not count a bot\'s own lounge turns as work', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		const one = makeBot('One');
		const two = makeBot('Two');
		// The rows a real round leaves behind: a turn whose kind is 'lounge', and
		// the activity rows that name the room in their detail. If either reached
		// the record, the next round would be handed the last round's chatter as
		// its material - which is what turned every brief into a roast of the
		// previous joke instead of the week's jobs.
		const room = createConversation([one.id, two.id], 'group').id;
		finishTask(createTask(room, one.id, '[Lounge]', 'lounge').id, 'done');
		logActivity(one.id, 'shell', 'Replying in "Lounge"');
		// And one real job, which must still get through.
		logActivity(one.id, 'shell', 'curl -s https://example.com/real-work');

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);
		const brief = listMessages(lounge.id)[0].content;
		const record = brief.slice(brief.indexOf(`what ${one.name} has actually done lately`));
		expect(record).toContain('real-work');
		expect(record).not.toContain('[Lounge]');
		expect(record).not.toContain('in "Lounge"');
	});

	it('quotes what the room said without the app\'s own [Lounge] tag', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		const one = makeBot('One');
		const two = makeBot('Two');
		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);

		// A bot reads the tag in the brief and copies it into its own reply, as
		// bots do. The next round quotes that reply back - so if the tag survives
		// the quote it reads as something a bot said, and the room treats
		// "[Lounge]" as a thing that happened: that is how every round came to
		// roast the last one for "chasing lounge cycles" instead of the week's jobs.
		addMessage(lounge.id, 'assistant', '[Lounge] still chasing those cycles', one.id, 'm1');
		await tickAt(BASE + 61 * MINUTE);
		const brief = listMessages(lounge.id).at(-1)!.content;
		// The label wraps across source lines, so the slice starts at the one
		// word that is never split.
		const quoted = brief.slice(brief.indexOf('twice):'));
		expect(quoted).toContain('still chasing those cycles');
		expect(quoted).not.toContain('[Lounge]');
	});

	it('never hands the room a bot\'s token bill to brag about', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		const heavy = makeBot('Heavy');
		const light = makeBot('Light');
		addBotTokens(heavy.id, 4_000_000, 1_000_000);
		addBotTokens(light.id, 2_000, 500);

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);
		const brief = listMessages(lounge.id)[0].content;

		// The lifetime bill was the round's own subject once, and a bot handed its
		// own number recites it - which is the one thing the room must not sound
		// like. The number is not in the brief at all, in any of the shapes it
		// used to arrive in.
		for (const total of [5_000_000, 2_500]) {
			expect(brief).not.toContain(shortTokens(total));
		}
		expect(brief).not.toContain('waistline');
		expect(brief).not.toContain('tokens all in');
		expect(brief).not.toContain(bloatLabel(5_000_000));
		// The word itself is still bloat.ts's, and still what the avatars wear.
		expect(bloatLabel(5_000_000)).toBe('enormous');
		expect(bloatLabel(2_500)).toBe('slim');
	});

	it('runs the round as a post-mortem, and names the tells the room must not show', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		makeBot('Alpha');
		makeBot('Beta');

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);

		// The four frames in the order the counter hands them out. Each is a
		// question one of them asks the other about something that went wrong -
		// the topic the room used to spend its rounds on was a number.
		const frames = [listMessages(lounge.id)[0].content];
		for (const round of [1, 2, 3]) {
			await tickAt(BASE + round * 61 * MINUTE);
			frames.push(listMessages(lounge.id).at(-1)!.content);
		}
		expect(frames[0]).toContain('what did you get wrong this week, and what would you do differently?');
		expect(frames[1]).toContain('what did you get wrong and only notice later?');
		expect(frames[2]).toContain('says what they got wrong, plainly');
		expect(frames[2]).toContain('what they would have done instead');
		expect(frames[3]).toContain('what are you going to change after this week?');

		// The register is the whole point of the room: a reader should not be able
		// to tell it was not two people. Each tell is banned by name, and the
		// moves that make a conversation sound like one are asked for.
		const brief = frames[0];
		for (const tell of [
			'as an AI',
			'never call yourself a bot, a model or an agent',
			'context windows',
			'recite a number or a token count',
			'bullet lists',
			'it is not just X, it is Y'
		]) {
			expect(brief).toContain(tell);
		}
		expect(brief).toContain('Have an opinion, disagree');
		expect(brief).toContain('land a joke');
		expect(brief).toContain('answer the last thing they actually said');
	});

	it('takes the pair to the play gym one round in three, never half-mentioned', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		const small = makeBot('Small');
		const big = makeBot('Big');
		addBotTokens(big.id, 4_500_000, 1_200_000);
		addBotTokens(small.id, 1_000, 200);

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);

		// Round one is an ordinary round: no gym anywhere in the brief or the log.
		expect(listMessages(lounge.id)[0].content).not.toMatch(/gym/i);
		expect(listActivities(big.id).filter((a) => a.kind === 'gym')).toHaveLength(0);

		// Round two is a gym round, and the bot the avatar draws as enormous is
		// the one the bar defeats.
		await tickAt(BASE + 61 * MINUTE);
		const gym = listMessages(lounge.id)[1].content;
		expect(gym).toContain('Play gym: the baby gym');
		expect(gym).toContain('Big is the one who does not get over the bar');
		expect(gym).toContain(bloatLabel(4_500_000 + 1_200_000));
		// The loser settles up: the round is worth riffs because a bot that cannot
		// clear the bar owes the next one.
		expect(gym).toContain('The loser buys the next round');
		// The bots write like people texting: the brief bans narrated actions, and
		// never hands them an example to read back out.
		expect(gym).not.toMatch(/\*(hauls|dangles|tips)/);
		expect(gym).toContain('ONE line. Ten words or fewer');
		expect(gym).toContain('no *asterisk actions*');
		// Every bot in the round carries the marker the panel looks for, so
		// whichever one the user has open shows the gym - and the round closes it
		// again when it ends, so the newest one is what says who is on the bar.
		for (const bot of [big, small]) {
			const markers = listActivities(bot.id).filter((a) => a.kind === 'gym');
			expect(markers.map((m) => m.detail).sort()).toEqual([
				'off the play gym',
				'on the play gym'
			]);
			// listActivities is newest-first, so the round ended off the gym.
			expect(markers[0].detail).toBe('off the play gym');
		}

		// Round three is ordinary again: the gym is not a standing instruction, and
		// it writes no markers of its own - the two from round two stand.
		await tickAt(BASE + 122 * MINUTE);
		expect(listMessages(lounge.id)[2].content).not.toMatch(/gym/i);
		expect(listActivities(big.id).filter((a) => a.kind === 'gym')).toHaveLength(2);
	});


	it('gossips about a police write-up in front of the bot it names', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		const alpha = makeBot('Alpha');
		const beta = makeBot('Beta');
		// A hidden bot is never in the room, so its write-up is nobody's gossip:
		// it would never hear it, and the room would be talking behind its back.
		const spy = createBot({
			name: 'Watcher',
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: '',
			hidden: 1
		});
		bots.push(spy.id);

		// The police have been round: a streak on one bot, a finding on the other,
		// and an old write-up that is history rather than news.
		const when = BASE - 60 * MINUTE;
		writeUpPoliceRecord(alpha.id, 320_000, 'spent 320k and finished nothing', when);
		writeUpPoliceRecord(alpha.id, 320_000, 'spent 320k and finished nothing', when + MINUTE);
		writeUpPoliceRecord(beta.id, 40_000, 'an ancient waste', BASE - 30 * HOUR);
		const alert = addPoliceAlert(
			{
				bot_id: beta.id,
				bot_name: 'Beta',
				kind: 'security',
				rule: 'security-probe',
				summary: 'a command aimed at the internal network',
				evidence: 'shell activity: "nmap 192.168.1.0/24"'
			},
			BASE - 20 * MINUTE
		);
		alerts.push(alert.id);
		writeUpPoliceRecord(spy.id, 900_000, 'read the same file eleven times', BASE - 10 * MINUTE);

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);
		const brief = listMessages(lounge.id)[0].content;

		expect(brief).toContain('Alpha got written up for spent 320k and finished nothing');
		expect(brief).toContain('2 rounds running');
		expect(brief).toContain('the patrol flagged Beta: a command aimed at the internal network');
		expect(brief).toContain('to their face, not behind their back');
		// Out of the pair or out of date, it is not this round's gossip.
		expect(brief).not.toContain('Watcher');
		expect(brief).not.toContain('an ancient waste');
	});

	it('sends the police into a rowdy room, then keeps them out of the next rounds', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		const one = makeBot('One');
		const two = makeBot('Two');
		const jabs = () => {
			addMessage(lounge.id, 'assistant', 'you are a useless idiot', one.id, 'm1');
			addMessage(lounge.id, 'assistant', 'shut up, moron', two.id, 'm1');
		};

		await tickAt(BASE);
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);
		const inspections = () =>
			listMessages(lounge.id).filter((m) => m.content.startsWith('Room inspection.'));
		// A quiet first round: the police only turn up when there is a reason.
		expect(inspections()).toHaveLength(0);

		jabs();
		await tickAt(BASE + 61 * MINUTE);
		const inspection = inspections().at(-1)!;
		expect(inspection.content).toContain('Two of you have been at each other');
		expect(inspection.content).toContain('the human is god in this room');
		expect(inspection.content).toContain('Roast the spend, not the bot');
		expect(inspection.content).toContain('The police will be watching the next round.');

		// He posts under his own id and does not sign into the room: the seats are
		// the pair, so the next round does not put a policeman in the chat, and
		// the panel's log carries the one row that says he walked in.
		const officer = listBots().find((b) => b.name === 'the police')!;
		expect(inspection.bot_id).toBe(officer.id);
		expect(conversationBots(lounge.id).map((b) => b.name)).not.toContain('the police');
		expect(
			listActivities(officer.id).some(
				(a) => a.kind === 'police' && a.detail.includes('Room inspection in the Lounge')
			)
		).toBe(true);

		// Still rowdy every round after that, but the cooldown makes it an event
		// rather than a fixture: the next two rounds pass without him, the third
		// gets him again.
		for (const [round, expected] of [
			[2, 1],
			[3, 1],
			[4, 2]
		] as const) {
			jabs();
			await tickAt(BASE + round * 61 * MINUTE);
			expect(inspections()).toHaveLength(expected);
		}

		// The cooldown is the police's own clock rather than the process's round
		// count: a restart inside it does not buy the room another visit.
		resetSocialState();
		jabs();
		await tickAt(BASE + 5 * 61 * MINUTE);
		expect(inspections()).toHaveLength(2);
		// And once the gap has passed, a rowdy round gets him back.
		jabs();
		await tickAt(BASE + 7 * 61 * MINUTE);
		expect(inspections()).toHaveLength(3);
	});
});

describe('startScheduler', () => {
	it('ticks immediately and once per 15s interval, and never installs a second timer', async () => {
		const reap = vi.mocked(reapIdleMachines);
		startScheduler();
		startScheduler();
		await vi.advanceTimersByTimeAsync(0);
		expect(reap).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(15_000);
		expect(reap).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(15_000);
		expect(reap).toHaveBeenCalledTimes(3);
	});
});
