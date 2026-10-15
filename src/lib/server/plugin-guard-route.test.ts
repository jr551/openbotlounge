import { describe, expect, it } from 'vitest';
import { createBot } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { PATCH } from '../../routes/api/plugins/[id]/+server';
import { POST as setOverride } from '../../routes/api/bots/[id]/plugins/+server';
import { createPlugin, getPlugin, pluginsForBot, setPluginVerification } from '$lib/server/plugins';

let seq = 0;

function request(body: unknown) {
	return new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

/** The status a request answered with and the message a refusal carried.
    SvelteKit's error() throws an HttpError (not an Error), so the body is
    narrowed by shape rather than trusted through a cast. */
async function status(fn: () => unknown): Promise<{ status: number; message: string }> {
	try {
		const res = (await fn()) as Response;
		return { status: res.status, message: '' };
	} catch (e) {
		const err = e as { status: number; body?: { message?: string } };
		return { status: err.status, message: err.body?.message ?? '' };
	}
}

function owner() {
	return createBot({
		name: `guard-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

/** A bot-scoped plugin with a verdict already on the row, as the officer left it. */
function pluginWith(verdict: Record<string, unknown>, enabled = 0) {
	const bot = owner();
	const plugin = createPlugin({
		name: `Guarded ${++seq}`,
		description: '',
		kind: 'tool',
		hook_point: '',
		parameters: '{}',
		code: 'return "ok";',
		icon_svg: '',
		author_bot_id: bot.id,
		scope: 'bot',
		enabled
	});
	setPluginVerification(plugin.id, JSON.stringify({ reason: 'the code is a stub', at: 1, ...verdict }));
	return { bot, plugin };
}

function switchOn(id: string) {
	return status(() => PATCH({ request: request({ enabled: true }), params: { id } } as Parameters<typeof PATCH>[0]));
}

function override(botId: string, pluginId: string, enabled: boolean) {
	return status(() =>
		setOverride({
			request: request({ plugin_id: pluginId, enabled }),
			params: { id: botId }
		} as Parameters<typeof setOverride>[0])
	);
}

describe('switching a refused plugin back on', () => {
	it('refuses the flip and points at the human approve route', async () => {
		const { plugin } = pluginWith({ verdict: 'rejected', attempts: 3, awaitingHuman: true });
		const res = await switchOn(plugin.id);
		expect(res.status).toBe(409);
		expect(res.message).toContain(`/api/plugins/${plugin.id}/approve`);
		expect(getPlugin(plugin.id)!.enabled).toBe(0);
	});

	it("lets the human's own verdict through - their approval is not the officer's refusal", async () => {
		const { plugin } = pluginWith({ verdict: 'rejected', by: 'human' });
		const res = await switchOn(plugin.id);
		expect(res.status).toBe(200);
		expect(getPlugin(plugin.id)!.enabled).toBe(1);
	});

	it('leaves a plugin the police approved alone', async () => {
		const { plugin } = pluginWith({ verdict: 'approved' });
		const res = await switchOn(plugin.id);
		expect(res.status).toBe(200);
		expect(getPlugin(plugin.id)!.enabled).toBe(1);
	});
});

describe('a bot turning a refused plugin on for itself', () => {
	it('refuses the override too, writing no row behind the verdict', async () => {
		const { bot, plugin } = pluginWith({ verdict: 'rejected', attempts: 3, awaitingHuman: true });
		const res = await override(bot.id, plugin.id, true);
		expect(res.status).toBe(409);
		expect(res.message).toContain(`/api/plugins/${plugin.id}/approve`);
		// With no override row, what the bot sees is the plugin's own state: off.
		const view = pluginsForBot(bot.id).find((p) => p.id === plugin.id)!;
		expect(view.effective_enabled).toBe(0);
	});

	it("still lets a bot switch off a plugin it is allowed to run", async () => {
		const { bot, plugin } = pluginWith({ verdict: 'approved' }, 1);
		const res = await override(bot.id, plugin.id, false);
		expect(res.status).toBe(200);
		const view = pluginsForBot(bot.id).find((p) => p.id === plugin.id)!;
		expect(view.effective_enabled).toBe(0);
	});
});
