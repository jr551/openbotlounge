import { describe, expect, it, vi } from 'vitest';
import { createBot, createConversation, createRoutine, listRoutines } from '$lib/server/db';
import type { Routine } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { DELETE, PATCH } from '../../routes/api/routines/[id]/+server';
import { POST } from '../../routes/api/routines/+server';
import { policeSettings, reviewRoutine } from '$lib/server/police';

// The police gate is a model call; the tests stand in for it. The point under
// test is what the route does with the verdict, not the officer's judgement.
vi.mock('$lib/server/police', () => ({
	policeModel: vi.fn(() => 'm1'),
	policeSettings: vi.fn(() => ({ checkPlugins: true, checkRoutines: true })),
	reviewRoutine: vi.fn(async () => ({ verdict: 'approved', reason: 'a real instruction' })),
	verdictJson: vi.fn((v: { verdict: string; reason: string }) => JSON.stringify(v)),
	// The attempt counter is the real one: the tests exercise how many times a
	// refused routine may come back, so a stand-in would test nothing.
	applyAttempt: (v: { verdict: string; reason: string }, prior: string) => {
		if (v.verdict !== 'rejected') return v;
		let attempts = 0;
		try {
			attempts = Number(JSON.parse(prior || '{}').attempts) || 0;
		} catch {
			attempts = 0;
		}
		attempts += 1;
		return { ...v, attempts, awaitingHuman: attempts >= 3 };
	},
	POLICE_MAX_ATTEMPTS: 3
}));

let seq = 0;

/** A stored routine: the fields the panel's edit form reads and writes back. */
function routine(
	overrides: Partial<
		Pick<Routine, 'prompt' | 'interval_min' | 'cron' | 'enabled' | 'next_run_at'>
	> = {}
): Routine {
	const bot = createBot({
		name: `routines-route-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
	const conv = createConversation([bot.id], 'direct');
	return createRoutine({
		bot_id: bot.id,
		conversation_id: conv.id,
		name: 'Morning',
		prompt: 'Summarise the inbox',
		interval_min: 30,
		cron: '',
		enabled: 1,
		next_run_at: Date.now() + 30 * 60_000,
		...overrides
	});
}

function patch(id: string, body: unknown) {
	const request = new Request(`http://test/api/routines/${id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return PATCH({ params: { id }, request } as Parameters<typeof PATCH>[0]);
}

function remove(id: string) {
	return DELETE({ params: { id } } as Parameters<typeof DELETE>[0]);
}

/** The response, or the thrown SvelteKit error, as one shape to assert on. */
async function sent(
	fn: () => unknown
): Promise<{ status: number; message: string; res: Response | null }> {
	try {
		const res = (await fn()) as Response;
		return { status: res.status, message: '', res };
	} catch (e) {
		const err = e as { status: number; body?: { message?: string } };
		return { status: err.status, message: err.body?.message ?? '', res: null };
	}
}

describe('editing a routine', () => {
	it('stores the edited prompt, schedule and enabled flag', async () => {
		const r = routine();
		const before = Date.now();
		const { status, res } = await sent(() =>
			patch(r.id, {
				prompt: '  Check the NAS disks  ',
				interval_min: 45,
				cron: '',
				enabled: false
			})
		);
		expect(status).toBe(200);

		const row = listRoutines().find((x) => x.id === r.id)!;
		expect(row.prompt).toBe('Check the NAS disks');
		expect(row.interval_min).toBe(45);
		expect(row.enabled).toBe(0);
		// The response is the row as stored, which is what the form's caller reads.
		const returned = (await res!.json()) as Routine;
		expect(returned.prompt).toBe(row.prompt);
		expect(returned.enabled).toBe(0);
		// A changed interval takes effect from now, not after the old one runs out.
		expect(row.next_run_at).toBeGreaterThanOrEqual(before + 45 * 60_000);
		expect(row.next_run_at).toBeLessThanOrEqual(Date.now() + 45 * 60_000);
	});

	it('follows a cron expression, and falls back to minutes when it is cleared', async () => {
		const r = routine();
		const onCronRes = await sent(() =>
			patch(r.id, { prompt: r.prompt, cron: '0 9 * * 1-5', interval_min: 30 })
		);
		expect(onCronRes.status).toBe(200);

		const onCron = listRoutines().find((x) => x.id === r.id)!;
		expect(onCron.cron).toBe('0 9 * * 1-5');
		const at = new Date(onCron.next_run_at);
		expect(onCron.next_run_at).toBeGreaterThan(Date.now());
		expect([at.getHours(), at.getMinutes()]).toEqual([9, 0]);
		expect(at.getDay()).toBeGreaterThanOrEqual(1);
		expect(at.getDay()).toBeLessThanOrEqual(5);

		// Clearing the cron hands the schedule back to the interval.
		const onIntervalRes = await sent(() =>
			patch(r.id, { prompt: r.prompt, cron: '', interval_min: 120 })
		);
		expect(onIntervalRes.status).toBe(200);
		const onInterval = listRoutines().find((x) => x.id === r.id)!;
		expect(onInterval.cron).toBe('');
		expect(onInterval.next_run_at).toBeGreaterThan(Date.now() + 119 * 60_000);
		expect(onInterval.next_run_at).toBeLessThanOrEqual(Date.now() + 120 * 60_000);
	});

	it('refuses a cron that does not parse, leaving the row alone', async () => {
		const r = routine();
		const { status, message } = await sent(() =>
			patch(r.id, { prompt: 'New text', cron: 'every morning', interval_min: 30 })
		);
		expect(status).toBe(400);
		expect(message).toContain('cron');

		const row = listRoutines().find((x) => x.id === r.id)!;
		expect(row.prompt).toBe('Summarise the inbox');
		expect(row.cron).toBe('');
	});

	it('refuses an interval that is not a whole number of minutes', async () => {
		const r = routine();
		for (const interval_min of [0, -5, 2.5]) {
			const { status } = await sent(() => patch(r.id, { prompt: 'New text', interval_min }));
			expect(status).toBe(400);
		}
		expect(listRoutines().find((x) => x.id === r.id)!.interval_min).toBe(30);
	});

	it('refuses an empty prompt', async () => {
		const r = routine();
		const { status } = await sent(() => patch(r.id, { prompt: '   ' }));
		expect(status).toBe(400);
		expect(listRoutines().find((x) => x.id === r.id)!.prompt).toBe('Summarise the inbox');
	});

	it('404s a routine that is not there', async () => {
		const { status } = await sent(() =>
			patch('no-such-routine', { prompt: 'New text', interval_min: 5, cron: '' })
		);
		expect(status).toBe(404);
	});

	it('still toggles enabled without disturbing the schedule', async () => {
		const r = routine();
		const { status } = await sent(() => patch(r.id, { enabled: false }));
		expect(status).toBe(200);

		const row = listRoutines().find((x) => x.id === r.id)!;
		expect(row.enabled).toBe(0);
		expect(row.interval_min).toBe(30);
		expect(row.prompt).toBe('Summarise the inbox');
		// The run that was already coming is the one that still comes.
		expect(row.next_run_at).toBe(r.next_run_at);
	});
});

describe('deleting a routine', () => {
	it('removes the row, and says so when it is already gone', async () => {
		const r = routine();
		expect((await remove(r.id)).status).toBe(204);
		expect(listRoutines().some((x) => x.id === r.id)).toBe(false);
		expect((await sent(() => remove(r.id))).status).toBe(404);
	});
});

describe('creating a routine', () => {
	/** A POST to the routines route, as the form's caller sends it. */
	function post(body: unknown) {
		const request = new Request('http://test/api/routines', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return POST({ request } as Parameters<typeof POST>[0]);
	}

	/** A bot and its room, for a routine to belong to. */
	function owner() {
		const bot = createBot({
			name: `routines-post-${++seq}`,
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		return { bot, conv: createConversation([bot.id], 'direct') };
	}

	it('records the police sign-off on the new routine', async () => {
		vi.mocked(reviewRoutine).mockResolvedValueOnce({
			verdict: 'approved',
			reason: 'a real instruction on a sane schedule'
		});
		const { bot, conv } = owner();
		const res = await post({
			bot_id: bot.id,
			conversation_id: conv.id,
			prompt: 'Summarise the inbox',
			interval_min: 30
		});
		expect(res.status).toBe(201);
		const row = listRoutines(bot.id).find((r) => r.prompt === 'Summarise the inbox')!;
		expect(JSON.parse(row.verification)).toEqual({
			verdict: 'approved',
			reason: 'a real instruction on a sane schedule'
		});
		expect(row.enabled).toBe(1);
	});

	it('switches a refused routine off and keeps the officer\'s reason', async () => {
		vi.mocked(reviewRoutine).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'it fires every minute and would spam the room'
		});
		const { bot, conv } = owner();
		const res = await post({
			bot_id: bot.id,
			conversation_id: conv.id,
			prompt: 'Say hi',
			interval_min: 1
		});
		// The routine is kept so it can be fixed, but it is not presented as usable.
		expect(res.status).toBe(201);
		const row = listRoutines(bot.id).find((r) => r.prompt === 'Say hi')!;
		expect(row.enabled).toBe(0);
		expect(row.paused_reason).toContain('would spam the room');
		expect(JSON.parse(row.verification).verdict).toBe('rejected');
	});

	it('creates the routine unchecked when the routine check is switched off', async () => {
		// Once, not permanently: there is no beforeEach here to put the gate back,
		// and a shuffled run must not leave the next test's gate shut.
		vi.mocked(policeSettings).mockReturnValueOnce({
			intervalHours: 12,
			jailMode: 'confirm',
			disabledRules: new Set<string>(),
			writeUps: true,
			patrol: true,
			checkPlugins: true,
			checkRoutines: false,
			checkWakes: true,
			checkRooms: true
		});
		const { bot, conv } = owner();
		const res = await post({
			bot_id: bot.id,
			conversation_id: conv.id,
			prompt: 'Stretch every hour',
			interval_min: 60
		});
		expect(res.status).toBe(201);
		expect(vi.mocked(reviewRoutine)).not.toHaveBeenCalled();
		const row = listRoutines(bot.id).find((r) => r.prompt === 'Stretch every hour')!;
		// Nothing judged it, so it runs and carries no verdict the console can show.
		expect(row.enabled).toBe(1);
		expect(row.verification).toBe('');
	});
});
