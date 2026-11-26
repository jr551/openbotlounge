import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createBot,
	createConversation,
	createRoutine,
	deleteWebhook,
	getRoutine,
	listMessages,
	listWebhooks,
	setRoutineEnabled
} from './db';
import { runBotTurn } from './runner';
import { createWebhook, fireWebhook, routineWebhook } from './webhooks';

vi.mock('./runner', () => ({
	runBotTurn: vi.fn(async () => ({ text: 'ok', message: null, aborted: false, stoppedBy: '' }))
}));

let botId = '';
let convId = '';

beforeAll(() => {
	botId = createBot({
		name: 'HookBot',
		persona: '',
		avatar: '🤖',
		color: '#fff',
		model: 'm1',
		badge: ''
	}).id;
	convId = createConversation([botId], 'direct').id;
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runBotTurn).mockResolvedValue({ text: 'ok', message: null, aborted: false, stoppedBy: '', silent: false });
});

afterEach(() => {
	for (const hook of listWebhooks()) deleteWebhook(hook.id);
});

const contents = (): string[] => listMessages(convId).map((m) => m.content);

describe('fireWebhook', () => {
	it('injects an arbitrary POST body into the template verbatim', async () => {
		const hook = createWebhook(botId, convId, 'CI', 'Build said: {payload}');
		// `$&`, "$`" and "$'" are replacement patterns in String.replace, so a
		// service that sends them must still see them arrive untouched.
		await expect(fireWebhook(hook.token, "cost $& plus $` and $' end $$")).resolves.toBe(true);
		expect(contents()).toContain("Build said: cost $& plus $` and $' end $$");
		expect(runBotTurn).toHaveBeenCalledTimes(1);
	});

	it('substitutes every placeholder in the template', async () => {
		const hook = createWebhook(botId, convId, 'CI', '{payload} / {payload}');
		await expect(fireWebhook(hook.token, 'once')).resolves.toBe(true);
		expect(contents()).toContain('once / once');
	});

	it('falls back to a named prefix when there is no template', async () => {
		const hook = createWebhook(botId, convId, 'Deploy');
		await expect(fireWebhook(hook.token, 'finished')).resolves.toBe(true);
		expect(contents()).toContain('[Webhook Deploy] finished');
	});

	it('refuses an unknown token without waking the bot', async () => {
		const before = contents().length;
		await expect(fireWebhook('not-a-real-token', 'x')).resolves.toBe(false);
		expect(runBotTurn).not.toHaveBeenCalled();
		expect(contents()).toHaveLength(before);
	});
});

describe('routine webhooks', () => {
	function makeRoutine(prompt = 'check the thing') {
		return createRoutine({
			bot_id: botId,
			conversation_id: convId,
			name: 'Webhookable',
			prompt,
			interval_min: 60,
			cron: '',
			enabled: 1
		});
	}

	it('creates, finds and revokes a routine-bound webhook', () => {
		const routine = makeRoutine();
		expect(routineWebhook(routine.id)).toBeUndefined();
		expect(getRoutine(routine.id)?.name).toBe('Webhookable');
		const hook = createWebhook(botId, convId, 'Routine "Webhookable"', '', routine.id);
		expect(routineWebhook(routine.id)?.token).toBe(hook.token);
		expect(deleteWebhook(hook.id)).toBe(true);
		expect(routineWebhook(routine.id)).toBeUndefined();
	});

	it('refuses to bind a webhook to a missing routine', () => {
		expect(() => createWebhook(botId, convId, 'Ghost', '', 'no-such-routine')).toThrow(/no such routine/);
	});

	it('fires the routine with the payload as a note', async () => {
		const routine = makeRoutine('watch the gauges');
		const hook = createWebhook(botId, convId, 'Routine "Webhookable"', '', routine.id);
		const before = contents().length;
		await expect(fireWebhook(hook.token, 'pressure nominal')).resolves.toBe(true);
		const posted = listMessages(convId).slice(before).map((m) => m.content);
		expect(posted.some((c) => c.startsWith('[Routine: Webhookable] watch the gauges'))).toBe(true);
		expect(posted.some((c) => c.includes('[Webhook] pressure nominal'))).toBe(true);
		expect(runBotTurn).toHaveBeenCalled();
	});

	it('does not double-fire while a run is already in flight', async () => {
		// The turn never finishes, so the first fire is still running when the
		// retry lands - a retried webhook delivery must not buy a second run.
		vi.mocked(runBotTurn).mockImplementation(() => new Promise(() => {}));
		const routine = makeRoutine();
		const hook = createWebhook(botId, convId, 'Routine "Webhookable"', '', routine.id);
		const before = contents().length;
		await expect(fireWebhook(hook.token, 'first')).resolves.toBe(true);
		await expect(fireWebhook(hook.token, 'first (retry)')).resolves.toBe(true);
		expect(runBotTurn).toHaveBeenCalledTimes(1);
		const firings = listMessages(convId)
			.slice(before)
			.filter((m) => m.content.startsWith('[Routine:'));
		expect(firings).toHaveLength(1);
	});

	it('refuses to fire a switched-off routine', async () => {
		const routine = makeRoutine();
		setRoutineEnabled(routine.id, false);
		const hook = createWebhook(botId, convId, 'Routine "Webhookable"', '', routine.id);
		const before = contents().length;
		await expect(fireWebhook(hook.token, 'go')).resolves.toBe(false);
		expect(listMessages(convId)).toHaveLength(before);
		expect(runBotTurn).not.toHaveBeenCalled();
		setRoutineEnabled(routine.id, true);
	});

	it('a plain webhook still wakes the bot', async () => {
		const hook = createWebhook(botId, convId, 'Deploy');
		await expect(fireWebhook(hook.token, 'finished')).resolves.toBe(true);
		expect(contents()).toContain('[Webhook Deploy] finished');
	});
});
