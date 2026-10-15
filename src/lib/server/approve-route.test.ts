import { describe, expect, it, vi } from 'vitest';
import { createBot, createConversation, createRoutine, createWakeTask, listRoutines, listWakes, setRoutineVerification, setWakeVerification } from '$lib/server/db';
import { createPlugin, getPlugin, setPluginVerification } from '$lib/server/plugins';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST as approvePlugin } from '../../routes/api/plugins/[id]/approve/+server';
import { POST as approveRoutine } from '../../routes/api/routines/[id]/approve/+server';
import { POST as approveWake } from '../../routes/api/wakes/[id]/approve/+server';

// The police gate is a model call; the tests stand in for it. The point under
// test is what the route writes, not the officer's judgement.
vi.mock('$lib/server/police', () => ({
	humanVerdict: vi.fn((approve: boolean, reason: string) => ({
		verdict: approve ? 'approved' : 'rejected',
		reason,
		by: 'human'
	})),
	verdictJson: vi.fn((v: unknown) => JSON.stringify(v))
}));

let seq = 0;

/** A POST to an approve route, as the console's button sends it. */
function post(
	handler: (event: never) => Response | Promise<Response>,
	id: string,
	body: unknown
) {
	const request = new Request(`http://test/approve`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return handler({ request, params: { id } } as never);
}

/** A refused plugin, as the police left it: off, with a spent-attempts verdict. */
function refusedPlugin() {
	const bot = createBot({
		name: `approve-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
	const plugin = createPlugin({
		name: 'Refused Tool',
		description: '',
		kind: 'tool',
		hook_point: '',
		parameters: '{}',
		code: 'return "ok";',
		icon_svg: '',
		author_bot_id: bot.id,
		scope: 'bot',
		enabled: 0
	});
	setPluginVerification(
		plugin.id,
		JSON.stringify({
			verdict: 'rejected',
			reason: 'the code is a stub',
			attempts: 3,
			awaitingHuman: true
		})
	);
	return { bot, plugin };
}

describe('the human approve route for plugins', () => {
	it('signs the plugin off as the human\'s verdict and switches it on', async () => {
		const { plugin } = refusedPlugin();
		const res = await post(approvePlugin, plugin.id, { approve: true });
		expect(res.ok).toBe(true);
		const stored = getPlugin(plugin.id)!;
		const verdict = JSON.parse(stored.verification);
		// The signature is the human's, never the officer's: a console ruling
		// must not read as the police's word.
		expect(verdict.verdict).toBe('approved');
		expect(verdict.by).toBe('human');
		expect(stored.enabled).toBe(1);
	});

	it('writes the human\'s refusal and leaves the plugin off', async () => {
		const { plugin } = refusedPlugin();
		const res = await post(approvePlugin, plugin.id, { approve: false });
		expect(res.ok).toBe(true);
		const stored = getPlugin(plugin.id)!;
		const verdict = JSON.parse(stored.verification);
		expect(verdict.verdict).toBe('rejected');
		expect(verdict.by).toBe('human');
		expect(stored.enabled).toBe(0);
	});
});

describe('the human approve route for routines', () => {
	it('signs the routine off as the human\'s verdict and switches it on', async () => {
		const bot = createBot({
			name: `approve-r-${++seq}`,
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		const conv = createConversation([bot.id], 'direct');
		const routine = createRoutine({
			bot_id: bot.id,
			conversation_id: conv.id,
			name: 'Refused',
			prompt: 'Say hi',
			interval_min: 30,
			cron: '',
			enabled: 0
		});
		setRoutineVerification(
			routine.id,
			JSON.stringify({
				verdict: 'rejected',
				reason: 'spam',
				attempts: 3,
				awaitingHuman: true
			})
		);
		const res = await post(approveRoutine, routine.id, { approve: true });
		expect(res.ok).toBe(true);
		const stored = listRoutines(bot.id).find((r) => r.id === routine.id)!;
		const verdict = JSON.parse(stored.verification);
		expect(verdict.verdict).toBe('approved');
		expect(verdict.by).toBe('human');
		expect(stored.enabled).toBe(1);
	});
});

describe('the human approve route for wakes', () => {
	it('signs the wake off as the human\'s verdict and switches it on', async () => {
		const bot = createBot({
			name: `approve-w-${++seq}`,
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		const conv = createConversation([bot.id], 'direct');
		const wake = createWakeTask({
			bot_id: bot.id,
			conversation_id: conv.id,
			prompt: 'Check the inbox',
			run_at: Date.now() + 60_000,
			cron: '',
			enabled: 0
		});
		setWakeVerification(
			wake.id,
			JSON.stringify({
				verdict: 'rejected',
				reason: 'it fires every minute and would spam the room',
				attempts: 3,
				awaitingHuman: true
			})
		);
		const res = await post(approveWake, wake.id, { approve: true });
		expect(res.ok).toBe(true);
		const stored = listWakes(bot.id).find((w) => w.id === wake.id)!;
		const verdict = JSON.parse(stored.verification);
		expect(verdict.verdict).toBe('approved');
		expect(verdict.by).toBe('human');
		expect(stored.enabled).toBe(1);
	});
});
