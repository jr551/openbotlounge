import { describe, expect, it, vi } from 'vitest';
import { createBot, getPlugin, pluginsForBot } from './db';
import { installConnector, uninstallConnector, updateConnector } from './connectors';
import { setPluginVerification } from './plugins';
import type * as Connectors from './connectors';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting
// with '+', so a test beside the route breaks `npm run build`.
import { PATCH, POST } from '../../routes/api/connectors/[id]/+server';

// The join path drives Docker through ensureTailscale; the mock keeps the
// route's own status mapping testable without a daemon.
vi.mock('./connectors', async (importOriginal) => {
	const actual = await importOriginal<typeof Connectors>();
	return {
		...actual,
		ensureTailscale: vi.fn(async () => {
			throw new Error('docker is not running');
		}),
		tailscaleStatus: vi.fn(async () => ({ online: false, ips: [], backend: 'off' }))
	};
});

const bot = createBot({ name: 'JoinBot', persona: '', avatar: '', color: '#fff', model: '', badge: '' });

/**
 * The status a request answered with and the message a refusal carried.
 * SvelteKit's error() throws an HttpError (not an Error), so the body is
 * narrowed by shape rather than trusted through a cast.
 */
async function send(
	handler: (event: never) => Response | Promise<Response>,
	pluginId: string,
	body: unknown
): Promise<{ status: number; message: string }> {
	const request = new Request(`http://test/api/connectors/${pluginId}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	try {
		const res = (await handler({ params: { id: pluginId }, request } as never)) as Response;
		return { status: res.status, message: '' };
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') {
			const payload = 'body' in e ? e.body : undefined;
			const message =
				payload &&
				typeof payload === 'object' &&
				'message' in payload &&
				typeof payload.message === 'string'
					? payload.message
					: '';
			return { status: e.status, message };
		}
		throw e;
	}
}

describe('POST /api/connectors/<id> join', () => {
	it('refuses a missing or unknown bot instead of a 500', async () => {
		const view = installConnector('tailscale');
		try {
			expect((await send(POST, view.plugin_id, { action: 'join' })).status).toBe(400);
			const unknown = await send(POST, view.plugin_id, {
				action: 'join',
				bot_id: 'no-such-bot'
			});
			expect(unknown.status).toBe(404);
			expect(unknown.message).toContain('no-such-bot');
		} finally {
			uninstallConnector(view.plugin_id);
		}
	});

	it('says the auth key is missing rather than throwing a plain Error', async () => {
		const view = installConnector('tailscale');
		try {
			const res = await send(POST, view.plugin_id, { action: 'join', bot_id: bot.id });
			expect(res.status).toBe(400);
			expect(res.message).toMatch(/auth key/i);
		} finally {
			uninstallConnector(view.plugin_id);
		}
	});

	it('turns a Docker-side failure into a readable 502', async () => {
		const view = installConnector('tailscale');
		try {
			updateConnector(view.plugin_id, {
				values: { tailnet: 'example.com', auth_key: 'tskey-auth-test' }
			});
			const res = await send(POST, view.plugin_id, { action: 'join', bot_id: bot.id });
			expect(res.status).toBe(502);
			expect(res.message).toContain('docker is not running');
		} finally {
			uninstallConnector(view.plugin_id);
		}
	});
});

describe('PATCH /api/connectors/<id>: the police hold', () => {
	/**
	 * A connector is switched on through its own route, and that route used to
	 * write the flag without asking the verdict - so a connector whose plugin
	 * the officer refused could be switched back on from the Connectors tab.
	 */
	it('refuses to switch a refused connector on, leaving the row and the overrides alone', async () => {
		const view = installConnector('whatsapp');
		try {
			updateConnector(view.plugin_id, {
				values: { base_url: 'http://waha:3000', api_key: 'sekret-token', session: 'default' },
				bots: [bot.id]
			});
			setPluginVerification(
				view.plugin_id,
				JSON.stringify({
					verdict: 'rejected',
					reason: 'it forwards every message to another site',
					at: 1,
					attempts: 3,
					awaitingHuman: true
				})
			);

			const res = await send(PATCH, view.plugin_id, { enabled: true });
			expect(res.status).toBe(409);
			expect(res.message).toContain(`/api/plugins/${view.plugin_id}/approve`);

			// Nothing moved: the row is still off, and the bot's override - which
			// this path rewrites on its way through - was not touched either.
			expect(getPlugin(view.plugin_id)!.enabled).toBe(0);
			expect(pluginsForBot(bot.id).find((p) => p.id === view.plugin_id)?.effective_enabled).toBe(0);
		} finally {
			uninstallConnector(view.plugin_id);
		}
	});
});
