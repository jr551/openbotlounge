import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot, createConversation, deleteWebhook, listMessages, listWebhooks } from './db';
import { runBotTurn } from './runner';
import { createWebhook, fireWebhook } from './webhooks';

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
