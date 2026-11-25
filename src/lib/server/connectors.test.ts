import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBot, getPlugin, pluginsForBot } from './db';
import { pluginToolsFor } from './plugins';
import {
	CONNECTORS,
	connectWhatsapp,
	decryptedConfig,
	elevenlabsPhoneNumbers,
	forgejoRepos,
	installConnector,
	listCatalog,
	listInstalled,
	uninstallConnector,
	updateConnector
} from './connectors';
const bot = createBot({ name: 'SmokeBot', persona: '', avatar: '', color: '#fff', model: '', badge: '' });

describe('connector lifecycle', () => {
	it('installs, configures, assigns, enables and uninstalls', async () => {
		const view = installConnector('whatsapp');
		expect(view.enabled).toBe(false);
		expect(view.configured).toBe(false);
		const plugin = getPlugin(view.plugin_id)!;
		expect(plugin.kind).toBe('tool');
		expect(plugin.scope).toBe('shared');

		// Second install refused (SvelteKit HttpError: status on the error, text in body).
		let dupStatus = 0;
		try {
			installConnector('whatsapp');
		} catch (e) {
			dupStatus = (e as { status: number }).status;
		}
		expect(dupStatus).toBe(409);

		// Enabling before configuring refused.
		let earlyStatus = 0;
		try {
			updateConnector(view.plugin_id, { enabled: true });
		} catch (e) {
			earlyStatus = (e as { status: number }).status;
		}
		expect(earlyStatus).toBe(400);
		// Configure: secret lands encrypted, never plaintext in the row.
		const after = updateConnector(view.plugin_id, {
			values: { base_url: 'http://waha:3000', api_key: 'sekret-token', session: 'default' }
		});
		expect(after.configured).toBe(true);
		expect(after.secrets_set.api_key).toBe(true);
		expect(after.values.api_key).toBeUndefined();
		expect(after.values.base_url).toBe('http://waha:3000');
		const raw = getPlugin(view.plugin_id)!.config ?? '';
		expect(raw).toContain('enc:');
		expect(raw).not.toContain('sekret-token');
		expect(decryptedConfig(getPlugin(view.plugin_id)!).api_key).toBe('sekret-token');

		updateConnector(view.plugin_id, { values: { api_key: '' } });
		expect(decryptedConfig(getPlugin(view.plugin_id)!).api_key).toBe('sekret-token');

		// Assign while off: remembered, but the bot does not get the tool yet.
		updateConnector(view.plugin_id, { bots: [bot.id] });
		expect(pluginsForBot(bot.id).find((p) => p.id === view.plugin_id)?.effective_enabled).toBe(0);

		// Enable: the assigned bot's tool list gains the connector.
		const on = updateConnector(view.plugin_id, { enabled: true });
		expect(on.enabled).toBe(true);
		expect(on.bots).toEqual([bot.id]);
		expect(pluginsForBot(bot.id).find((p) => p.id === view.plugin_id)?.effective_enabled).toBe(1);
		expect(pluginToolsFor(bot.id).map((t) => t.function.name)).toContain('plugin_whatsapp');

		// Toggle off again: the assignment is kept but the tool leaves the list.
		updateConnector(view.plugin_id, { enabled: false });
		expect(pluginsForBot(bot.id).find((p) => p.id === view.plugin_id)?.effective_enabled).toBe(0);
		updateConnector(view.plugin_id, { enabled: true });

		expect(listCatalog().find((c) => c.id === 'whatsapp')?.installed?.configured).toBe(true);
		expect(listInstalled().map((c) => c.connector)).toContain('whatsapp');
		expect(listCatalog()).toHaveLength(CONNECTORS.length);

		// The chat allowlist is stored, exposed and handed to the tool code.
		const withChats = updateConnector(view.plugin_id, {
			allowed_chats: [
				{ id: '111@c.us', alias: 'Mum' },
				{ id: '222@g.us', alias: 'Book club' }
			]
		});
		expect(withChats.allowed_chats).toHaveLength(2);
		expect(decryptedConfig(getPlugin(view.plugin_id)!).allowed_chats).toEqual([
			{ id: '111@c.us', alias: 'Mum' },
			{ id: '222@g.us', alias: 'Book club' }
		]);

		// QR action without a reachable WAHA reports unreachable, not a crash.
		let qrStatus = 0;
		try {
			await connectWhatsapp(view.plugin_id);
		} catch (e) {
			qrStatus = (e as { status: number }).status;
		}
		expect(qrStatus).toBe(502);

		uninstallConnector(view.plugin_id);
		expect(getPlugin(view.plugin_id)).toBeUndefined();
		expect(listInstalled()).toHaveLength(0);
	});
});

describe('catalog tool code', () => {
	it('every connector tool body parses as an async function body', () => {
		for (const def of CONNECTORS) {
			// Same shape plugins.ts wraps code in: `await (async () => { CODE })()`.
			expect(() => new Function(`return (async () => { ${def.toolCode} })`), def.id).not.toThrow();
		}
	});
});

describe('whatsapp allowlist', () => {
	const def = CONNECTORS.find((c) => c.id === 'whatsapp')!;

	async function run(args: Record<string, unknown>, allowed: { id: string; alias: string }[]) {
		const calls: string[] = [];
		const fetchMock = async (url: string) => {
			calls.push(url);
			return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
		};
		const config = {
			base_url: 'http://waha:3000',
			session: 'default',
			allowed_chats: allowed
		};
		const fn = new Function('args', 'config', 'fetch', `return (async () => { ${def.toolCode} })()`);
		const out = await fn(args, config, fetchMock);
		return { out, calls };
	}

	it('blocks chats outside the allowlist and resolves aliases', async () => {
		const allowed = [{ id: '111@c.us', alias: 'Mum' }];
		const blocked = await run({ action: 'send', chat_id: '999@c.us', text: 'hi' }, allowed);
		expect(String(blocked.out)).toContain('not an allowed chat');
		expect(blocked.calls).toHaveLength(0);

		const byAlias = await run({ action: 'send', chat_id: 'mum', text: 'hi' }, allowed);
		expect(byAlias.calls[0]).toContain('/api/sendText');

		const read = await run({ action: 'messages', chat_id: '111@c.us' }, allowed);
		expect(read.calls[0]).toContain('/chats/111%40c.us/messages');
	});

	it('an empty allowlist leaves the connector unrestricted', async () => {
		const res = await run({ action: 'send', chat_id: '999@c.us', text: 'hi' }, []);
		expect(res.calls[0]).toContain('/api/sendText');
	});
});

describe('elevenlabs phone calls', () => {
	const def = CONNECTORS.find((c) => c.id === 'elevenlabs-phone-calls')!;
	const config = { api_key: 'sk_test_key', agent_id: 'agent_1', phone_number_id: 'phone_1' };

	/** The tool body with a stubbed fetch, recording every request it makes. */
	async function run(
		args: Record<string, unknown>,
		cfg: Record<string, unknown> = config,
		reply: { status?: number; body?: unknown; throws?: boolean } = {}
	) {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetchMock = async (url: string, init: RequestInit = {}) => {
			calls.push({ url, init });
			if (reply.throws) throw new Error('getaddrinfo ENOTFOUND api.elevenlabs.io');
			const status = reply.status ?? 200;
			const body = reply.body ?? {
				success: true,
				message: 'queued',
				conversation_id: 'conv_1',
				callSid: 'CA1'
			};
			return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
		};
		const fn = new Function('args', 'config', 'fetch', `return (async () => { ${def.toolCode} })()`);
		const out = await fn(args, cfg, fetchMock);
		return { out, calls };
	}

	it('dials the outbound-call endpoint with the key, agent, number and goal', async () => {
		const { out, calls } = await run({
			action: 'call',
			to_number: '+447700900123',
			goal: 'Ask whether the parcel has shipped',
			first_message: 'Hi, this is Vicky from the lounge.'
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
		expect(calls[0].init.method).toBe('POST');
		// HeadersInit is a union the test cannot index; the tool body sets a plain object.
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers['xi-api-key']).toBe('sk_test_key');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			agent_id: 'agent_1',
			agent_phone_number_id: 'phone_1',
			to_number: '+447700900123',
			conversation_initiation_client_data: {
				conversation_config_override: {
					agent: {
						prompt: { prompt: 'Ask whether the parcel has shipped' },
						first_message: 'Hi, this is Vicky from the lounge.'
					}
				}
			}
		});
		expect(out).toEqual({
			placed: true,
			conversation_id: 'conv_1',
			call_sid: 'CA1',
			message: 'queued'
		});
	});

	it('reads a call back, and lists the account numbers for the picker', async () => {
		const status = await run({ action: 'status', conversation_id: 'conv_9' }, config, {
			body: {
				status: 'done',
				metadata: { call_duration_secs: 42, termination_reason: 'agent' },
				transcript: [
					{ role: 'agent', message: 'Hello' },
					{ role: 'user', message: 'Yes please' }
				]
			}
		});
		expect(status.calls[0].url).toBe('https://api.elevenlabs.io/v1/convai/conversations/conv_9');
		expect(status.calls[0].init.method).toBe('GET');
		expect(status.out).toEqual({
			status: 'done',
			duration_secs: 42,
			termination_reason: 'agent',
			transcript: [
				{ role: 'agent', message: 'Hello' },
				{ role: 'user', message: 'Yes please' }
			]
		});

		const numbers = await run({ action: 'numbers' }, config, {
			body: [
				{
					phone_number_id: 'phone_2',
					phone_number: '+441234567890',
					label: 'Front desk',
					provider: 'twilio',
					assigned_agent: { agent_id: 'agent_1', agent_name: 'Reception' }
				},
				{ phone_number_id: 'phone_3', phone_number: '+441234567891', provider: 'sip_trunk' }
			]
		});
		expect(numbers.calls[0].url).toBe('https://api.elevenlabs.io/v1/convai/phone-numbers');
		expect(numbers.out).toEqual([
			{
				phone_number_id: 'phone_2',
				phone_number: '+441234567890',
				label: 'Front desk',
				provider: 'twilio',
				assigned_agent: 'agent_1'
			},
			{
				phone_number_id: 'phone_3',
				phone_number: '+441234567891',
				label: '',
				provider: 'sip_trunk',
				assigned_agent: ''
			}
		]);
	});

	it('refuses bad input and missing setup without calling the API', async () => {
		const noKey = await run({ action: 'call', to_number: '+447700900123' }, { ...config, api_key: '' });
		expect(String(noKey.out)).toContain('api_key missing');
		expect(noKey.calls).toHaveLength(0);

		const noAgent = await run({ action: 'call', to_number: '+447700900123' }, { ...config, agent_id: '' });
		expect(String(noAgent.out)).toContain('agent_id missing');
		expect(noAgent.calls).toHaveLength(0);

		const noFrom = await run({ action: 'call', to_number: '+447700900123' }, { ...config, phone_number_id: '' });
		expect(String(noFrom.out)).toContain('phone_number_id missing');
		expect(noFrom.calls).toHaveLength(0);

		const national = await run({ action: 'call', to_number: '07700900123' });
		expect(String(national.out)).toContain('not an E.164 number');
		expect(national.calls).toHaveLength(0);

		const noNumber = await run({ action: 'call' });
		expect(String(noNumber.out)).toContain('to_number required');

		const noConversation = await run({ action: 'status' });
		expect(String(noConversation.out)).toContain('conversation_id required');
		expect(noConversation.calls).toHaveLength(0);

		const nonsense = await run({ action: 'sing' });
		expect(String(nonsense.out)).toContain('unknown action');
		expect(nonsense.calls).toHaveLength(0);
	});

	it('caps the goal and first message it forwards', async () => {
		const { calls } = await run({
			action: 'call',
			to_number: '+447700900123',
			goal: 'g'.repeat(5000),
			first_message: 'f'.repeat(2000)
		});
		const body = JSON.parse(String(calls[0].init.body));
		const agent = body.conversation_initiation_client_data.conversation_config_override.agent;
		expect(agent.prompt.prompt).toHaveLength(4000);
		expect(agent.first_message).toHaveLength(1000);
	});

	it('turns an unreachable API and an API rejection into readable text', async () => {
		const down = await run({ action: 'call', to_number: '+447700900123' }, config, { throws: true });
		// The tool returns the failure object, which executePlugin serialises as text.
		expect(down.out).toEqual({
			error: expect.stringContaining('ElevenLabs unreachable: getaddrinfo ENOTFOUND')
		});

		const denied = await run({ action: 'numbers' }, config, {
			status: 401,
			body: { detail: 'invalid api key' }
		});
		expect(denied.out).toEqual({ error: 'ElevenLabs HTTP 401', detail: { detail: 'invalid api key' } });
	});
});

describe('elevenlabs install and account lookup', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('installs from the catalog and exposes its tool once assigned and on', () => {
		const view = installConnector('elevenlabs-phone-calls');
		expect(view.name).toBe('ElevenLabs phone calls');
		expect(view.configured).toBe(false);
		expect(view.enabled).toBe(false);
		expect(view.fields.map((f) => f.key)).toEqual(['api_key', 'agent_id', 'phone_number_id']);
		expect(listCatalog().find((c) => c.id === 'elevenlabs-phone-calls')?.installed?.plugin_id).toBe(
			view.plugin_id
		);

		updateConnector(view.plugin_id, {
			values: { api_key: 'sk_test_key', agent_id: 'agent_1', phone_number_id: 'phone_1' },
			bots: [bot.id],
			enabled: true
		});
		const tool = pluginToolsFor(bot.id).find(
			(t) => t.function.name === 'plugin_elevenlabs_phone_calls'
		);
		expect(tool).toBeDefined();
		const schema = tool!.function.parameters as { properties: { action: { enum: string[] } } };
		expect(schema.properties.action.enum).toEqual(['call', 'status', 'numbers']);

		uninstallConnector(view.plugin_id);
		expect(getPlugin(view.plugin_id)).toBeUndefined();
	});

	it('reads the account numbers with the stored key, and refuses without one', async () => {
		const view = installConnector('elevenlabs-phone-calls');

		let status = 0;
		try {
			await elevenlabsPhoneNumbers(view.plugin_id);
		} catch (e) {
			status = (e as { status: number }).status;
		}
		expect(status).toBe(400);

		updateConnector(view.plugin_id, {
			values: { api_key: 'sk_test_key', agent_id: 'agent_1', phone_number_id: 'phone_1' }
		});
		const seen: { url: string; key: string }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
			// Same HeadersInit union as above; elevenlabsPhoneNumbers sends a plain object.
			const headers = (init.headers ?? {}) as Record<string, string>;
			seen.push({ url, key: headers['xi-api-key'] });
			return {
				ok: true,
				status: 200,
				json: async () => [
					{
						phone_number_id: 'phone_2',
						phone_number: '+441234567890',
						label: 'Front desk',
						provider: 'twilio',
						assigned_agent: { agent_id: 'agent_1', agent_name: 'Reception' }
					}
				]
			} as Response;
		});

		expect(await elevenlabsPhoneNumbers(view.plugin_id)).toEqual([
			{
				phone_number_id: 'phone_2',
				phone_number: '+441234567890',
				label: 'Front desk',
				provider: 'twilio',
				assigned_agent: 'agent_1'
			}
		]);
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/convai/phone-numbers');
		expect(seen[0].key).toBe('sk_test_key');

		uninstallConnector(view.plugin_id);
	});
});

describe('forgejo tool', () => {
	const def = CONNECTORS.find((c) => c.id === 'forgejo')!;
	const config = {
		base_url: 'https://git.rowe.lol',
		token: 'forgejo_test_token',
		default_repo: 'john/home-infra-information'
	};

	/** The tool body with a stubbed fetch, recording every request it makes. */
	async function run(
		args: Record<string, unknown>,
		cfg: Record<string, unknown> = config,
		reply: { status?: number; body?: unknown; throws?: boolean } = {}
	) {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetchMock = async (url: string, init: RequestInit = {}) => {
			calls.push({ url, init });
			if (reply.throws) throw new Error('getaddrinfo ENOTFOUND git.rowe.lol');
			const status = reply.status ?? 200;
			const body = reply.body ?? {};
			return { ok: status < 400, status, json: async () => body } as Response;
		};
		const fn = new Function('args', 'config', 'fetch', `return (async () => { ${def.toolCode} })()`);
		const out = await fn(args, cfg, fetchMock);
		return { out, calls };
	}

	const authOf = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

	it('reads a repo with the token and trims the readout', async () => {
		const { out, calls } = await run(
			{ action: 'repo' },
			config,
			{
				body: {
					full_name: 'john/home-infra-information',
					description: 'home lab',
					default_branch: 'main',
					private: true,
					open_issues_count: 1,
					open_pr_counter: 2,
					html_url: 'https://git.rowe.lol/john/home-infra-information',
					clone_url: 'https://git.rowe.lol/john/home-infra-information.git',
					extra_noise: 'dropped'
				}
			}
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://git.rowe.lol/api/v1/repos/john/home-infra-information');
		expect(calls[0].init.method).toBe('GET');
		expect(authOf(calls[0].init)).toBe('token forgejo_test_token');
		expect(out).toEqual({
			full_name: 'john/home-infra-information',
			description: 'home lab',
			default_branch: 'main',
			private: true,
			open_issues: 1,
			open_pulls: 2,
			html_url: 'https://git.rowe.lol/john/home-infra-information',
			clone_url: 'https://git.rowe.lol/john/home-infra-information.git'
		});
	});

	it('lists issues and pulls with slim rows', async () => {
		const { out, calls } = await run(
			{ action: 'issues', repo: 'john/other', state: 'all' },
			config,
			{ body: [{ number: 1, title: 'Fix it', state: 'open', user: { login: 'john' }, comments: 3, html_url: 'u' }] }
		);
		expect(calls[0].url).toBe(
			'https://git.rowe.lol/api/v1/repos/john/other/issues?state=all&type=issues&limit=10'
		);
		expect(out).toEqual([
			{ number: 1, title: 'Fix it', state: 'open', user: 'john', comments: 3, html_url: 'u' }
		]);

		const pulls = await run({ action: 'pulls' }, config, {
			body: [
				{
					number: 4,
					title: 'Docs',
					state: 'open',
					merged: false,
					base: { label: 'main' },
					head: { label: 'feat' },
					user: { login: 'john' },
					html_url: 'p'
				}
			]
		});
		expect(pulls.out).toEqual([
			{
				number: 4,
				title: 'Docs',
				state: 'open',
				merged: false,
				base: 'main',
				head: 'feat',
				user: 'john',
				html_url: 'p'
			}
		]);
	});

	it('validates before writing: titles, numbers, branches and repos', async () => {
		const noTitle = await run({ action: 'issue_create', body: 'text' });
		expect(String(noTitle.out)).toContain('title required');
		expect(noTitle.calls).toHaveLength(0);

		const noNumber = await run({ action: 'issue', repo: 'john/other' });
		expect(String(noNumber.out)).toContain('number required');
		expect(noNumber.calls).toHaveLength(0);

		const noHead = await run({ action: 'pull_create', base: 'main', title: 'T' });
		expect(String(noHead.out)).toContain('head branch required');
		expect(noHead.calls).toHaveLength(0);

		const badRepo = await run({ action: 'issues', repo: 'not-a-repo' });
		expect(String(badRepo.out)).toContain('owner/name');
		expect(badRepo.calls).toHaveLength(0);

		const noRepo = await run({ action: 'issues' }, { base_url: 'https://git.rowe.lol', token: 't' });
		expect(String(noRepo.out)).toContain('repo required');
		expect(noRepo.calls).toHaveLength(0);

		const noToken = await run({ action: 'repo' }, { base_url: 'https://git.rowe.lol' });
		expect(String(noToken.out)).toContain('token missing');
		expect(noToken.calls).toHaveLength(0);

		const nonsense = await run({ action: 'frobnicate' });
		expect(String(nonsense.out)).toContain('unknown action');
		expect(nonsense.calls).toHaveLength(0);
	});

	it('creates issues and comments with capped text', async () => {
		const created = await run({ action: 'issue_create', title: '  New bug  ', body: 'b'.repeat(9000) });
		expect(created.calls[0].init.method).toBe('POST');
		expect(created.calls[0].url).toBe('https://git.rowe.lol/api/v1/repos/john/home-infra-information/issues');
		expect(JSON.parse(String(created.calls[0].init.body))).toEqual({
			title: 'New bug',
			body: 'b'.repeat(8000)
		});

		const commented = await run({ action: 'issue_comment', number: 2, comment: 'noted' });
		expect(commented.calls[0].url).toBe(
			'https://git.rowe.lol/api/v1/repos/john/home-infra-information/issues/2/comments'
		);
		expect(JSON.parse(String(commented.calls[0].init.body))).toEqual({ body: 'noted' });
	});

	it('merges a pull with the merge directive', async () => {
		const { out, calls } = await run({ action: 'pull_merge', number: 5 });
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].url).toBe('https://git.rowe.lol/api/v1/repos/john/home-infra-information/pulls/5/merge');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({ Do: 'merge' });
		expect(out).toEqual({ merged: true });
	});

	it('passes CI runs through slimmed', async () => {
		const { out, calls } = await run(
			{ action: 'runs' },
			config,
			{ body: { workflow_runs: [{ id: 1, name: 'CI', status: 'completed', noise: 'dropped' }] } }
		);
		expect(calls[0].url).toContain('/actions/tasks?limit=10');
		expect(out).toEqual([{ id: 1, name: 'CI', status: 'completed' }]);
	});

	it('turns an unreachable API and an API rejection into readable text', async () => {
		const down = await run({ action: 'repo' }, config, { throws: true });
		expect(down.out).toEqual({
			error: expect.stringContaining('Forgejo unreachable: getaddrinfo ENOTFOUND')
		});

		const denied = await run({ action: 'repo' }, config, {
			status: 401,
			body: { message: 'Only signed in user is allowed to call APIs.' }
		});
		expect(denied.out).toEqual({
			error: 'Forgejo HTTP 401',
			detail: { message: 'Only signed in user is allowed to call APIs.' }
		});
	});
});

describe('forgejo install and repo lookup', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('installs from the catalog and exposes its tool once assigned and on', () => {
		const view = installConnector('forgejo');
		expect(view.name).toBe('Forgejo');
		expect(view.configured).toBe(false);
		expect(view.enabled).toBe(false);
		expect(view.fields.map((f) => f.key)).toEqual(['base_url', 'token', 'default_repo']);
		expect(listCatalog().find((c) => c.id === 'forgejo')?.installed?.plugin_id).toBe(view.plugin_id);

		updateConnector(view.plugin_id, {
			values: { base_url: 'https://git.rowe.lol', token: 'forgejo_test_token', default_repo: 'john/x' },
			bots: [bot.id],
			enabled: true
		});
		const tool = pluginToolsFor(bot.id).find((t) => t.function.name === 'plugin_forgejo');
		expect(tool).toBeDefined();
		const schema = tool!.function.parameters as { properties: { action: { enum: string[] } } };
		expect(schema.properties.action.enum).toContain('pull_merge');

		uninstallConnector(view.plugin_id);
		expect(getPlugin(view.plugin_id)).toBeUndefined();
	});

	it('stores the token encrypted and reads the repo list with it', async () => {
		const view = installConnector('forgejo');

		let status = 0;
		try {
			await forgejoRepos(view.plugin_id);
		} catch (e) {
			status = (e as { status: number }).status;
		}
		expect(status).toBe(400);

		updateConnector(view.plugin_id, {
			values: { base_url: 'https://git.rowe.lol/', token: 'forgejo_test_token' }
		});
		const raw = getPlugin(view.plugin_id)!.config ?? '';
		expect(raw).toContain('enc:');
		expect(raw).not.toContain('forgejo_test_token');

		const seen: { url: string; key: string }[] = [];
		vi.stubGlobal(
			'fetch',
			async (url: string, init: RequestInit = {}) => {
				const headers = (init.headers ?? {}) as Record<string, string>;
				seen.push({ url, key: headers['Authorization'] });
				return {
					ok: true,
					status: 200,
					json: async () => [
						{ full_name: 'john/a', private: true, default_branch: 'main', noise: 1 },
						{ full_name: 'john/b', private: false, default_branch: 'trunk' }
					]
				} as Response;
			}
		);

		expect(await forgejoRepos(view.plugin_id)).toEqual([
			{ full_name: 'john/a', private: true, default_branch: 'main' },
			{ full_name: 'john/b', private: false, default_branch: 'trunk' }
		]);
		expect(seen[0].url).toBe('https://git.rowe.lol/api/v1/user/repos?limit=50');
		expect(seen[0].key).toBe('token forgejo_test_token');

		uninstallConnector(view.plugin_id);
	});
});
