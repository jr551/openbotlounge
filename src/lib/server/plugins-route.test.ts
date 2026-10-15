import { describe, expect, it, vi } from 'vitest';
import { createBot, listPlugins, setPluginVerification } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/plugins/+server';
import { PATCH } from '../../routes/api/plugins/[id]/+server';
import { policeSettings, reviewPlugin } from '$lib/server/police';
import type { CreationVerdict } from '$lib/server/police';
import { createPlugin, getPlugin, selfTestPlugin, runPluginTests } from '$lib/server/plugins';

// The police gate is a model call; the tests stand in for it. The point under
// test is what the route does with the verdict, not the officer's judgement.
vi.mock('$lib/server/police', () => ({
	policeModel: vi.fn(() => 'm1'),
	policeSettings: vi.fn(() => ({ checkPlugins: true, checkRoutines: true })),
	reviewPlugin: vi.fn(async () => ({ verdict: 'approved', reason: 'the code does what it says' })),
	verdictJson: vi.fn((v: { verdict: string; reason: string }) => JSON.stringify(v)),
	// The attempt counter is the real one: a refused edit counts against what
	// the row already carries, and a stand-in would test nothing.
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

// The sandbox runs are container round-trips the tests have no docker for;
// what is under test is the gate's verdict handling, not the harness.
vi.mock('$lib/server/plugins', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/plugins')>()),
	selfTestPlugin: vi.fn(async () => ({ ok: true, output: 'self-test ok' })),
	runPluginTests: vi.fn(async () => [])
}));

// The verdict lands after the response, so the write itself is the signal the
// tests await - spied, not slept on.
vi.mock('$lib/server/db', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/db')>();
	return { ...real, setPluginVerification: vi.fn(real.setPluginVerification) };
});

let seq = 0;

/** A POST to the plugins route, as the form's caller sends it. */
function post(body: unknown) {
	const request = new Request('http://test/api/plugins', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return POST({ request } as Parameters<typeof POST>[0]);
}

/** A bot for a plugin to belong to. */
function owner() {
	return createBot({
		name: `plugins-post-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

/**
 * The review runs after the response now - a slow officer must not hold the
 * create open - so a test awaits the verdict write landing rather than the
 * POST's return carrying it.
 */
async function verdictLanded(name: string): Promise<{ enabled: number; verification: string }> {
	const row = listPlugins().find((p) => p.name === name)!;
	await vi.waitFor(() => {
		expect(
			vi.mocked(setPluginVerification).mock.calls.some((call) => call[0] === row.id)
		).toBe(true);
	});
	return listPlugins().find((p) => p.name === name)!;
}

describe('creating a plugin through the API', () => {
	it('answers before the officer does - a slow review must not hold the create', async () => {
		const { promise: officer, resolve: release } = Promise.withResolvers<CreationVerdict>();
		vi.mocked(reviewPlugin).mockImplementationOnce(() => officer);
		const bot = owner();
		const res = await post({
			name: `slow-${seq}`,
			kind: 'tool',
			scope: 'bot',
			author_bot_id: bot.id,
			code: 'return "hi";'
		});
		// The officer has not answered and may never: the create still returns.
		expect(res.status).toBe(201);
		release({ verdict: 'approved', reason: 'the code does what it says' });
		const row = await verdictLanded(`slow-${seq}`);
		expect(JSON.parse(row.verification).verdict).toBe('approved');
		expect(row.enabled).toBe(1);
	});

	it('runs the same police gate the bot tool path does', async () => {
		const bot = owner();
		const res = await post({
			name: `gated-${seq}`,
			kind: 'tool',
			scope: 'bot',
			author_bot_id: bot.id,
			code: 'return "hi";'
		});
		expect(res.status).toBe(201);
		// The self-test ran, the officer was phoned, and the verdict is on the row.
		await vi.waitFor(() => {
			expect(vi.mocked(reviewPlugin)).toHaveBeenCalled();
		});
		const row = await verdictLanded(`gated-${seq}`);
		expect(JSON.parse(row.verification)).toEqual({
			verdict: 'approved',
			reason: 'the code does what it says'
		});
		expect(row.enabled).toBe(1);
	});

	it('switches a refused plugin off and keeps the officer\'s reason', async () => {
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'the code is a stub that returns a fixed string'
		});
		const bot = owner();
		const res = await post({
			name: `refused-${seq}`,
			kind: 'tool',
			scope: 'bot',
			author_bot_id: bot.id,
			code: 'return "42";'
		});
		// The plugin is kept so it can be fixed, but it is not presented as usable.
		expect(res.status).toBe(201);
		const row = await verdictLanded(`refused-${seq}`);
		expect(row.enabled).toBe(0);
		expect(JSON.parse(row.verification).verdict).toBe('rejected');
	});

	it('switches a new plugin off when the police cannot be reached', async () => {
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'unreviewed',
			reason: 'the police could not be reached (provider down)'
		});
		const bot = owner();
		const res = await post({
			name: `unreviewed-${seq}`,
			kind: 'tool',
			scope: 'bot',
			author_bot_id: bot.id,
			code: 'return "hi";'
		});
		expect(res.status).toBe(201);
		// A new plugin is unsigned code: an unreachable police force must not
		// leave it live.
		const row = await verdictLanded(`unreviewed-${seq}`);
		expect(row.enabled).toBe(0);
		expect(JSON.parse(row.verification).verdict).toBe('unreviewed');
	});

	it('creates the plugin unchecked when the plugin check is switched off', async () => {
		// Once, not permanently: there is no beforeEach here to put the gate back,
		// and a shuffled run must not leave the next test's gate shut.
		vi.mocked(policeSettings).mockReturnValueOnce({
			intervalHours: 12,
			jailMode: 'confirm',
			disabledRules: new Set<string>(),
			writeUps: true,
			patrol: true,
			checkPlugins: false,
			checkRoutines: true,
			checkWakes: true,
			checkRooms: true
		});
		const bot = owner();
		const res = await post({
			name: `unchecked-${seq}`,
			kind: 'tool',
			scope: 'bot',
			author_bot_id: bot.id,
			code: 'return "hi";'
		});
		expect(res.status).toBe(201);
		expect(vi.mocked(reviewPlugin)).not.toHaveBeenCalled();
		const row = listPlugins().find((p) => p.name === `unchecked-${seq}`)!;
		// Nothing judged it, so it runs and carries no verdict the console can show.
		expect(row.enabled).toBe(1);
		expect(row.verification).toBe('');
	});
});

describe('editing a plugin through the API', () => {
	/** A PATCH to the plugin's own route, as the editor's save sends it. */
	function patch(id: string, body: unknown) {
		const request = new Request(`http://test/api/plugins/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return PATCH({ request, params: { id } } as Parameters<typeof PATCH>[0]);
	}

	/** A bot-owned plugin the officer already approved, as a row mid-life looks. */
	function approvedPlugin() {
		const bot = owner();
		const plugin = createPlugin({
			name: `patch-${seq}`,
			description: '',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: 'return "v1";',
			author_bot_id: bot.id,
			scope: 'bot',
			enabled: 1
		});
		return { bot, plugin };
	}

	it('re-reviews new code the way the bot\'s update_plugin does', async () => {
		const { plugin } = approvedPlugin();
		vi.mocked(reviewPlugin).mockClear();
		const res = await patch(plugin.id, { code: 'return "v2";' });
		expect(res.status).toBe(200);
		expect(vi.mocked(reviewPlugin)).toHaveBeenCalledTimes(1);
		// The officer saw the code now on the row, not what it replaced.
		expect(vi.mocked(reviewPlugin).mock.calls[0][0].code).toBe('return "v2";');
		const stored = getPlugin(plugin.id)!;
		expect(JSON.parse(stored.verification).verdict).toBe('approved');
		expect(stored.enabled).toBe(1);
	});

	it('switches the plugin off when the re-review refuses it', async () => {
		const { plugin } = approvedPlugin();
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'the new code reads every secret it can reach'
		});
		const res = await patch(plugin.id, { code: 'return await secrets();' });
		expect(res.status).toBe(200);
		const stored = getPlugin(plugin.id)!;
		expect(stored.enabled).toBe(0);
		expect(JSON.parse(stored.verification).verdict).toBe('rejected');
	});

	it('draws no review for a name, description or switch-only edit', async () => {
		const { plugin } = approvedPlugin();
		vi.mocked(reviewPlugin).mockClear();
		await patch(plugin.id, { name: `renamed-${seq}`, description: 'a note', enabled: false });
		expect(vi.mocked(reviewPlugin)).not.toHaveBeenCalled();
		// Nothing judged it, so no verdict row appeared to read as a review.
		expect(getPlugin(plugin.id)!.verification).toBe('');
	});

	it('edits code without a review when the plugin check is switched off', async () => {
		vi.mocked(policeSettings).mockReturnValueOnce({
			intervalHours: 12,
			jailMode: 'confirm',
			disabledRules: new Set<string>(),
			writeUps: true,
			patrol: true,
			checkPlugins: false,
			checkRoutines: true,
			checkWakes: true,
			checkRooms: true
		});
		const { plugin } = approvedPlugin();
		vi.mocked(reviewPlugin).mockClear();
		const res = await patch(plugin.id, { code: 'return "v2";' });
		expect(res.status).toBe(200);
		expect(vi.mocked(reviewPlugin)).not.toHaveBeenCalled();
		expect(getPlugin(plugin.id)!.verification).toBe('');
	});
});
