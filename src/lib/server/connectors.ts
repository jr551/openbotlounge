import { setTimeout as delay } from 'node:timers/promises';
import { error } from '@sveltejs/kit';
import {
	db,
	deletePlugin,
	getPlugin,
	listBots,
	listPlugins,
	setPluginOverride,
	type Plugin
} from './db';
import { assertPluginMayBeEnabled, createPlugin, updatePlugin } from './plugins';
import { decrypt, encrypt } from './secrets';
import { dockerExec, dockerRequest, isRunning, type ContainerInfo } from './docker';
import { EGRESS_URL } from './machine-net';

/**
 * Connector catalog: installable plugins that bridge a bot to an external
 * service (WhatsApp, Bitwarden, mailcow, Proxmox, Home Assistant, Tailscale).
 *
 * Installing a connector creates an ordinary `kind:'tool'` plugin row; what
 * makes it a connector is the `config` JSON in the plugins.config column:
 *
 *   { "connector": "<catalog id>", "values": { "<field>": "<value>" } }
 *
 * Secret field values are stored as `enc:<aes-256-gcm blob>` (the same cipher
 * secrets.ts uses for bot secrets) and are decrypted only when the plugin runs
 * - plugins.ts injects them as the `config` object the tool code reads. The
 * API never returns a decrypted or even encrypted secret: views mask them.
 */

// The config column arrived with connectors; backfill older databases the same
// way plugins.ts does for icon_svg, since db.ts's schema is owned elsewhere.
if (
	!(db.prepare('PRAGMA table_info(plugins)').all() as { name: string }[]).some(
		(c) => c.name === 'config'
	)
) {
	db.exec(`ALTER TABLE plugins ADD COLUMN config TEXT NOT NULL DEFAULT ''`);
}

const ENC_PREFIX = 'enc:';

export interface ConfigField {
	key: string;
	label: string;
	/** Secret fields are encrypted at rest and never echoed back. */
	secret?: boolean;
	placeholder?: string;
	/** A connector cannot be enabled until every required field has a value. */
	required?: boolean;
}

export interface ConnectorDef {
	id: string;
	name: string;
	description: string;
	icon_svg: string;
	configFields: ConfigField[];
	/** JSON schema for the tool's args, exposed to the model. */
	parameters: Record<string, unknown>;
	/** Async function body run in the bot's sandbox; sees args, config, fetch. */
	toolCode: string;
	/** Beyond `required`: custom "configured" check (e.g. either/or secrets). */
	ready?: (values: Record<string, unknown>) => boolean;
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

const WHATSAPP_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.4A8.5 8.5 0 1 1 21 11.5z"/><path d="M9 9.5c.5 2.5 3 5 5.5 5.5l1-1.5 2 1c-.5 1.5-1.5 2-3 1.5-3-1-6-4-7-7-.5-1.5 0-2.5 1.5-3l1 2-1 1.5z" fill="currentColor" stroke="none"/></svg>`;

const BITWARDEN_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3z"/><path d="M9.5 12l2 2 3.5-4"/></svg>`;

const MAILCOW_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`;

const PROXMOX_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg>`;

const HOME_ASSISTANT_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M12 15.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z" fill="currentColor" stroke="none"/></svg>`;
const TAILSCALE_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="none"><circle cx="6" cy="7" r="2"/><circle cx="12" cy="7" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2.6"/><circle cx="6" cy="17" r="2"/><circle cx="12" cy="17" r="2"/></svg>`;

const ELEVENLABS_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="none"><rect x="7.4" y="4" width="2.8" height="16" rx="1.4"/><rect x="13.8" y="4" width="2.8" height="16" rx="1.4"/></svg>`;

export const CONNECTORS: ConnectorDef[] = [
	{
		id: 'whatsapp',
		name: 'WhatsApp',
		description:
			'Send and read WhatsApp messages through a WAHA (WhatsApp HTTP API) server. ' +
			'Point base_url at your WAHA instance, then use "Connect / show QR" in ' +
			'Settings → Connectors to pair a phone. The bot can list chats, read ' +
			'messages and send text via the session.',
		icon_svg: WHATSAPP_ICON,
		configFields: [
			{
				key: 'base_url',
				label: 'WAHA base URL',
				placeholder: 'http://waha:3000',
				required: true
			},
			{
				key: 'api_key',
				label: 'API key (if WAHA requires one)',
				secret: true,
				placeholder: 'X-Api-Key value'
			},
			{ key: 'session', label: 'Session name', placeholder: 'default' }
		],
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['status', 'chats', 'messages', 'send', 'send_seen'],
					description: 'What to do on the WhatsApp session'
				},
				chat_id: {
					type: 'string',
					description:
						'WAHA chat id (447123456789@c.us, …@g.us) or an allowed-chat alias like "Mum"'
				},
				text: { type: 'string', description: 'Message text for send' },
				reply_to: { type: 'string', description: 'Message id to reply to' },
				limit: { type: 'number', description: 'Max chats/messages to return' }
			},
			required: ['action']
		},
		toolCode: `const base = (config.base_url || '').replace(/\\/+$/, '');
if (!base) return 'error: whatsapp connector is not configured (base_url missing)';
const session = config.session || 'default';
const headers = { 'Content-Type': 'application/json' };
if (config.api_key) headers['X-Api-Key'] = config.api_key;
const call = async (method, path, body) => {
\tconst res = await fetch(base + path, {
\t\tmethod,
\t\theaders,
\t\tbody: body === undefined ? undefined : JSON.stringify(body)
\t});
\tconst text = await res.text();
\tlet data;
\ttry { data = JSON.parse(text); } catch { data = text; }
\tif (!res.ok) return { error: 'WAHA HTTP ' + res.status, detail: data };
\treturn data;
};
// The user picks which chats this bot may touch and names them; an empty
// allowlist means unrestricted (nothing picked yet).
const allowed = Array.isArray(config.allowed_chats) ? config.allowed_chats : [];
const resolve = (wanted) => {
\tif (!wanted) return null;
\tconst w = String(wanted).toLowerCase();
\tconst hit = allowed.find(
\t\t(c) => c.id === wanted || (c.alias || '').toLowerCase() === w
\t);
\tif (hit) return hit.id;
\treturn allowed.length === 0 ? wanted : null;
};
const s = encodeURIComponent(session);
switch (args.action) {
\tcase 'status':
\t\treturn await call('GET', '/api/sessions/' + s);
\tcase 'chats': {
\t\tconst data = await call('GET', '/api/' + s + '/chats?limit=' + (args.limit || 50));
\t\tif (!Array.isArray(data)) return data;
\t\treturn data.map((c) => {
\t\t\tconst id = c.id && (c.id._serialized || c.id) || c.id;
\t\t\tconst entry = allowed.find((a) => a.id === id);
\t\t\treturn { id, name: c.name || '', allowed: allowed.length === 0 || !!entry, alias: (entry && entry.alias) || '' };
\t\t});
\t}
\tcase 'messages': {
\t\tconst chatId = resolve(args.chat_id);
\t\tif (!chatId) return 'error: "' + args.chat_id + '" is not an allowed chat';
\t\treturn await call('GET', '/api/' + s + '/chats/' + encodeURIComponent(chatId) + '/messages?limit=' + (args.limit || 50));
\t}
\tcase 'send': {
\t\tconst chatId = resolve(args.chat_id);
\t\tif (!chatId) return 'error: "' + args.chat_id + '" is not an allowed chat';
\t\tif (!args.text) return 'error: text required';
\t\treturn await call('POST', '/api/sendText', { session, chatId, text: args.text, reply_to: args.reply_to });
\t}
\tcase 'send_seen': {
\t\tconst chatId = resolve(args.chat_id);
\t\tif (!chatId) return 'error: "' + args.chat_id + '" is not an allowed chat';
\t\treturn await call('POST', '/api/sendSeen', { session, chatId });
\t}
\tdefault:
\t\treturn 'error: unknown action (status|chats|messages|send|send_seen)';
}`
	},
	{
		id: 'bitwarden',
		name: 'Bitwarden',
		description:
			'Fetch credentials from a Bitwarden vault (bitwarden.com or self-hosted) ' +
			'using the public API with a client_id/client_secret pair, so an assigned ' +
			'bot can look up a login by name instead of you pasting secrets into chat.',
		icon_svg: BITWARDEN_ICON,
		configFields: [
			{
				key: 'base_url',
				label: 'Vault URL',
				placeholder: 'https://vault.bitwarden.com or self-hosted'
			},
			{ key: 'client_id', label: 'Client ID', secret: true, required: true },
			{ key: 'client_secret', label: 'Client secret', secret: true, required: true }
		],
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['list', 'get'],
					description: 'List item names, or fetch one credential'
				},
				name: {
					type: 'string',
					description: 'Item name (or id) to fetch for action=get'
				}
			},
			required: ['action']
		},
		toolCode: `const base = (config.base_url || 'https://vault.bitwarden.com').replace(/\\/+$/, '');
if (!config.client_id || !config.client_secret) {
	return 'error: bitwarden connector is not configured (client_id/client_secret missing)';
}
const tokenRes = await fetch(base + '/identity/connect/token', {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: config.client_id,
		client_secret: config.client_secret,
		scope: 'api'
	})
});
if (!tokenRes.ok) return 'error: bitwarden auth failed (HTTP ' + tokenRes.status + ')';
const token = (await tokenRes.json()).access_token;
const call = async (path) => {
	const res = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
	const data = await res.json().catch(() => null);
	if (!res.ok) return { error: 'bitwarden HTTP ' + res.status, detail: data };
	return data;
};
if (args.action === 'list') {
	const data = await call('/api/list/items');
	const items = (data && data.data) || [];
	return items.map((i) => ({ id: i.id, name: i.name, type: i.type }));
}
if (args.action === 'get') {
	if (!args.name) return 'error: name required';
	const data = await call('/api/list/items');
	const items = (data && data.data) || [];
	const wanted = String(args.name).toLowerCase();
	const item = items.find((i) => i.id === args.name) ||
		items.find((i) => (i.name || '').toLowerCase() === wanted);
	if (!item) return 'error: no vault item named "' + args.name + '"';
	const full = item.login ? item : await call('/api/ciphers/' + item.id);
	const login = (full && full.login) || {};
	return {
		name: item.name,
		username: login.username || '',
		password: login.password || '',
		totp: login.totp || '',
		uris: (login.uris || []).map((u) => u.uri)
	};
}
return 'error: unknown action (list|get)';`
	},
	{
		id: 'mailcow',
		name: 'Mailcow mail',
		description:
			'Read and send mail through a mailcow-rest-api instance ' +
			'(github.com/jr551/mailcow-rest-api). Sign in with a mailbox address and ' +
			'its password or an app password; the bot can list folders, read messages, ' +
			'see aliases and send mail.',
		icon_svg: MAILCOW_ICON,
		configFields: [
			{
				key: 'base_url',
				label: 'API base URL',
				placeholder: 'https://mail.example.com/mailcow-rest-api',
				required: true
			},
			{
				key: 'username',
				label: 'Mailbox address',
				placeholder: 'bot@example.com',
				required: true
			},
			{
				key: 'password',
				label: 'Password or app password',
				secret: true,
				required: true
			}
		],
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['me', 'mailboxes', 'messages', 'read', 'send', 'aliases'],
					description: 'Which mailbox operation to run'
				},
				mailbox: { type: 'string', description: 'Folder path, default INBOX' },
				uid: { type: 'string', description: 'Message uid for action=read' },
				to: { type: 'string', description: 'Recipient address for action=send' },
				subject: { type: 'string' },
				text: { type: 'string', description: 'Plain-text body for action=send' },
				limit: { type: 'number' }
			},
			required: ['action']
		},
		toolCode: `const base = (config.base_url || '').replace(/\\/+$/, '');
if (!base || !config.username || !config.password) {
	return 'error: mailcow connector is not configured (base_url/username/password missing)';
}
const auth = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
const call = async (method, path, body) => {
	const res = await fetch(base + path, {
		method,
		headers: { 'Content-Type': 'application/json', Authorization: auth },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const data = await res.json().catch(() => null);
	if (!res.ok) return { error: 'mailcow HTTP ' + res.status, detail: data };
	return data;
};
const mailbox = encodeURIComponent(args.mailbox || 'INBOX');
switch (args.action) {
	case 'me':
		return await call('GET', '/v1/me');
	case 'mailboxes':
		return await call('GET', '/v1/mailboxes');
	case 'messages':
		return await call('GET', '/v1/mailboxes/' + mailbox + '/messages?limit=' + (args.limit || 20));
	case 'read':
		if (!args.uid) return 'error: uid required';
		return await call('GET', '/v1/mailboxes/' + mailbox + '/messages/' + encodeURIComponent(args.uid));
	case 'send':
		if (!args.to) return 'error: to required';
		return await call('POST', '/v1/send', { to: args.to, subject: args.subject || '', text: args.text || '' });
	case 'aliases':
		return await call('GET', '/v1/me/aliases');
	default:
		return 'error: unknown action (me|mailboxes|messages|read|send|aliases)';
}`
	},
	{
		id: 'proxmox-agent-lab',
		name: 'Proxmox agent lab',
		description:
			'Provision, list and destroy disposable VMs and containers on a Proxmox ' +
			'host over the Proxmox VE REST API with a PVEAPIToken. base_url is the ' +
			'API root (https://pve:8006/api2/json); token is the full token value ' +
			'(user@realm!name=secret). Self-signed TLS is accepted. This is the ' +
			'token-and-HTTPS route; github.com/jr551/proxmox-agent-lab takes the ' +
			'other one — SSH key only, no token, with lease-scoped teardown.',
		icon_svg: PROXMOX_ICON,
		configFields: [
			{
				key: 'base_url',
				label: 'Proxmox API root',
				placeholder: 'https://pve.example.com:8006/api2/json',
				required: true
			},
			{
				key: 'token',
				label: 'API token',
				secret: true,
				placeholder: 'root@pam!lab=xxxxxxxx',
				required: true
			},
			{ key: 'node', label: 'Default node', placeholder: 'pve' }
		],
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['nodes', 'list', 'status', 'create', 'clone', 'start', 'stop', 'destroy'],
					description: 'Guest lifecycle operation'
				},
				node: { type: 'string', description: 'Proxmox node; defaults to configured node' },
				vmid: { type: 'number', description: 'Guest id for status/clone/start/stop/destroy' },
				type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Guest type, default qemu' },
				name: { type: 'string', description: 'Name for create/clone' },
				newid: { type: 'number', description: 'New vmid for clone' },
				params: {
					type: 'object',
					description: 'Extra Proxmox fields for create (cores, memory, ostemplate, …)'
				}
			},
			required: ['action']
		},
		toolCode: `const base = (config.base_url || '').replace(/\\/+$/, '');
if (!base || !config.token) {
	return 'error: proxmox connector is not configured (base_url/token missing)';
}
const { request } = require('node:https');
const call = (method, path, data) => {
\tconst { promise, resolve } = Promise.withResolvers();
\tconst body = data ? new URLSearchParams(data).toString() : null;
\tconst req = request(
\t\tbase + path,
\t\t{
\t\t\tmethod,
\t\t\trejectUnauthorized: false,
\t\t\ttimeout: 20000,
\t\t\theaders: {
\t\t\t\tAuthorization: 'PVEAPIToken=' + config.token,
\t\t\t\t...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
\t\t\t}
\t\t},
\t\t(res) => {
\t\t\tlet text = '';
\t\t\tres.on('data', (c) => (text += c));
\t\t\tres.on('end', () => {
\t\t\t\tlet json = null;
\t\t\t\ttry { json = JSON.parse(text); } catch { /* not json */ }
\t\t\t\tif (res.statusCode >= 400) {
\t\t\t\t\tresolve({ error: 'proxmox HTTP ' + res.statusCode, detail: json || text.slice(0, 300) });
\t\t\t\t} else {
\t\t\t\t\tresolve(json && 'data' in json ? json.data : json);
\t\t\t\t}
\t\t\t});
\t\t}
\t);
\treq.on('timeout', () => req.destroy(new Error('request timed out')));
\treq.on('error', (e) => resolve({ error: String((e && e.message) || e) }));
\tif (body) req.write(body);
\treq.end();
\treturn promise;
};
const node = args.node || config.node || '';
const type = args.type === 'lxc' ? 'lxc' : 'qemu';
const needNode = () => (node ? null : 'error: node required (set a default node or pass args.node)');
switch (args.action) {
	case 'nodes':
		return await call('GET', '/nodes');
	case 'list':
		return await call('GET', '/cluster/resources?type=vm');
	case 'status': {
		const err = needNode(); if (err) return err;
		if (!args.vmid) return 'error: vmid required';
		return await call('GET', '/nodes/' + node + '/' + type + '/' + args.vmid + '/status/current');
	}
	case 'create': {
		const err = needNode(); if (err) return err;
		return await call('POST', '/nodes/' + node + '/' + type, { vmid: args.vmid, name: args.name, ...(args.params || {}) });
	}
	case 'clone': {
		const err = needNode(); if (err) return err;
		if (!args.vmid || !args.newid) return 'error: vmid and newid required';
		return await call('POST', '/nodes/' + node + '/' + type + '/' + args.vmid + '/clone', { newid: args.newid, name: args.name, full: 1 });
	}
	case 'start':
	case 'stop': {
		const err = needNode(); if (err) return err;
		if (!args.vmid) return 'error: vmid required';
		return await call('POST', '/nodes/' + node + '/' + type + '/' + args.vmid + '/status/' + args.action);
	}
	case 'destroy': {
		const err = needNode(); if (err) return err;
		if (!args.vmid) return 'error: vmid required';
		return await call('DELETE', '/nodes/' + node + '/' + type + '/' + args.vmid);
	}
	default:
		return 'error: unknown action (nodes|list|status|create|clone|start|stop|destroy)';
}`
	},
	{
		id: 'home-assistant',
		name: 'Home Assistant',
		description:
			'Home Assistant — read sensors and control your home. ' +
			'An assigned bot can list entities, check a device state, call services ' +
			'(turn_on/turn_off/toggle, set_temperature, open_cover…), and show recent ' +
			'history. Create a long-lived access token in HA → Profile → Security. ' +
			'Results are already formatted as concise human-readable text — just ' +
			'summarize naturally for the user, don\'t dump raw JSON. ' +
			'Tip: browse with states + domain before calling a service; entity_id must be exact.',
		icon_svg: HOME_ASSISTANT_ICON,
		configFields: [
			{
				key: 'base_url',
				label: 'Home Assistant URL',
				placeholder: 'http://homeassistant.local:8123',
				required: true
			},
			{
				key: 'token',
				label: 'Long-lived access token',
				secret: true,
				required: true
			}
		],
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['states', 'state', 'call', 'history'],
					description:
						'What to do: states=list entities (filter by domain), state=read one entity, ' +
						'call=control a device (needs domain+service+entity_id), history=recent state changes'
				},
				entity_id: {
					type: 'string',
					description:
						'Full entity id, e.g. light.living_room, climate.bedroom, sensor.outside_temperature. ' +
						'Required for state and call; optional filter for history.'
				},
				domain: {
					type: 'string',
					description:
						'Domain filter for states (light, switch, sensor, climate, cover…) or service domain for call (light, switch, cover…). ' +
						'For states it narrows the list; for call it is the service domain.'
				},
				service: {
					type: 'string',
					description:
						'Service name for call, e.g. turn_on, turn_off, toggle, set_temperature, open_cover. Combined as domain.service.'
				},
				data: {
					type: 'object',
					description:
						'Extra service data for call, e.g. {"brightness": 120} or {"temperature": 22, "rgb_color": [255,0,0]}. Omit if not needed.',
					additionalProperties: true
				},
				since: {
					type: 'string',
					description: 'ISO timestamp for history start; defaults to 1 hour ago, e.g. 2026-09-16T08:00:00Z'
				},
				limit: {
					type: 'number',
					description: 'Max entities for states (default 30, max 200). Keep small for readability.'
				}
			},
			required: ['action']
		},
		toolCode: `const base = (config.base_url || '').replace(/\\/+$/, '');
if (!base || !config.token) {
	return 'error: Home Assistant is not configured — set base_url and token in Settings → Connectors → Home Assistant.';
}
const niceError = (status, detail) => {
	if (status === 401) return 'error: Home Assistant authentication failed (401) — check your long-lived access token.';
	if (status === 404) return 'error: Home Assistant entity not found (404) — verify entity_id or browse with action=states&domain=<domain>.';
	if (status === 403) return 'error: Home Assistant refused the request (403) — token may lack permission for this domain/service.';
	const hint = detail ? (' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 200)) : '';
	return 'error: Home Assistant HTTP ' + status + hint;
};
const cap = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const capAttr = (v) => {
	if (v == null) return '';
	if (typeof v === 'string') return cap(v, 80);
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (Array.isArray(v)) return '[' + v.slice(0, 5).map(capAttr).join(', ') + (v.length > 5 ? ', …' : '') + ']';
	return cap(JSON.stringify(v), 80);
};
const fmtEntity = (e) => {
	const id = e.entity_id || '';
	const name = e.attributes && e.attributes.friendly_name ? ' (' + cap(e.attributes.friendly_name, 40) + ')' : '';
	const state = cap(e.state, 40) || 'unknown';
	const unit = e.attributes && e.attributes.unit_of_measurement ? ' ' + e.attributes.unit_of_measurement : '';
	const extra = [];
	if (e.attributes) {
		if (e.attributes.brightness != null) extra.push('brightness ' + e.attributes.brightness);
		if (e.attributes.temperature != null) extra.push(e.attributes.temperature + (e.attributes.unit_of_measurement || '°'));
		if (e.attributes.hvac_action) extra.push(e.attributes.hvac_action);
	}
	const extraStr = extra.length ? ' — ' + extra.join(', ') : '';
	return '• ' + id + name + ' — ' + state + unit + extraStr;
};
const fmtDetail = (e) => {
	if (!e || typeof e !== 'object' || !e.entity_id) return typeof e === 'string' ? e : JSON.stringify(e).slice(0, 500);
	const id = e.entity_id;
	const name = e.attributes && e.attributes.friendly_name ? ' (' + cap(e.attributes.friendly_name, 40) + ')' : '';
	const state = cap(e.state, 60) || 'unknown';
	const unit = e.attributes && e.attributes.unit_of_measurement ? ' ' + e.attributes.unit_of_measurement : '';
	let out = id + name + ' — ' + state + unit;
	const lu = e.last_updated ? 'Updated: ' + cap(e.last_updated, 25) : '';
	const lc = e.last_changed ? 'Changed: ' + cap(e.last_changed, 25) : '';
	if (lu || lc) out += '\\n' + [lu, lc].filter(Boolean).join(' | ');
	if (e.attributes) {
		const skip = new Set(['friendly_name', 'icon', 'unit_of_measurement']);
		const attrs = Object.entries(e.attributes).filter(([k]) => !skip.has(k)).slice(0, 8);
		if (attrs.length) out += '\\nAttributes: ' + attrs.map(([k, v]) => k + ' ' + capAttr(v)).join(', ');
	}
	return out;
};
const call = async (method, path, body) => {
	let res;
	try {
		res = await fetch(base + path, {
			method,
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(20000)
		});
	} catch (e) {
		return { __err: 'error: Home Assistant is unreachable — ' + cap(String((e && e.message) || e), 200) + ' (check base_url and network).' };
	}
	const text = await res.text().catch(() => '');
	let data = null;
	try { data = text ? JSON.parse(text) : null; } catch { data = text.slice(0, 400); }
	if (!res.ok) return { __err: niceError(res.status, data) };
	return data;
};
switch (args.action) {
	case 'states': {
		const raw = await call('GET', '/api/states');
		if (raw && raw.__err) return raw.__err;
		if (!Array.isArray(raw)) return typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 2000);
		let filtered = raw;
		if (args.domain) filtered = filtered.filter((e) => e.entity_id && e.entity_id.startsWith(args.domain + '.'));
		const total = filtered.length;
		const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
		const page = filtered.slice(0, limit);
		if (total === 0) {
			return args.domain
				? 'No entities found for domain "' + cap(args.domain, 30) + '". Try action=states without a domain to browse.'
				: 'No entities found.';
		}
		const header = 'Home Assistant — ' + total + ' entit' + (total === 1 ? 'y' : 'ies') + (args.domain ? ' (domain: ' + cap(args.domain, 20) + ')' : '') + (total > limit ? ' — showing ' + page.length : '') + ':';
		const lines = page.map(fmtEntity);
		const more = total > limit ? '\\n…+' + (total - limit) + ' more — narrow with domain or raise limit (max 200).' : '';
		return header + '\\n' + lines.join('\\n') + more;
	}
	case 'state': {
		if (!args.entity_id) return 'error: entity_id is required for action=state (e.g. light.living_room).';
		const data = await call('GET', '/api/states/' + encodeURIComponent(String(args.entity_id)));
		if (data && data.__err) return data.__err;
		if (!data || typeof data !== 'object' || !data.entity_id) return typeof data === 'string' ? data : JSON.stringify(data).slice(0, 2000);
		return fmtDetail(data);
	}
	case 'call': {
		if (!args.domain || !args.service) return 'error: domain and service are required for action=call (e.g. domain=light, service=turn_on).';
		if (!args.entity_id) return 'error: entity_id is required for action=call (e.g. light.living_room).';
		const domain = cap(String(args.domain), 30);
		const service = cap(String(args.service), 30);
		const entity = cap(String(args.entity_id), 60);
		const res = await call('POST', '/api/services/' + encodeURIComponent(domain) + '/' + encodeURIComponent(service), { entity_id: entity, ...((args.data && typeof args.data === 'object') ? args.data : {}) });
		if (res && res.__err) return res.__err;
		// HA returns array of changed states; surface the new state concisely
		if (Array.isArray(res)) {
			const hit = res.find((e) => e && e.entity_id === entity) || res[0];
			if (hit && hit.state) return '✓ ' + domain + '.' + service + ' → ' + entity + ' — done. New state: ' + cap(hit.state, 40) + (hit.attributes && hit.attributes.unit_of_measurement ? ' ' + hit.attributes.unit_of_measurement : '');
			return '✓ ' + domain + '.' + service + ' → ' + entity + ' — done.' + (res.length ? ' (' + res.length + ' entit' + (res.length === 1 ? 'y' : 'ies') + ' updated)' : '');
		}
		if (res && typeof res === 'object' && res.entity_id) return '✓ ' + domain + '.' + service + ' → ' + entity + ' — done. New state: ' + cap(res.state, 40);
		return '✓ ' + domain + '.' + service + ' → ' + entity + ' — done.';
	}
	case 'history': {
		if (args.entity_id && !String(args.entity_id).includes('.')) return 'error: entity_id looks invalid — expected domain.entity, e.g. sensor.temperature (got "' + cap(String(args.entity_id), 40) + '").';
		const since = args.since ? cap(String(args.since), 30) : new Date(Date.now() - 3600e3).toISOString();
		let path = '/api/history/period/' + encodeURIComponent(since);
		if (args.entity_id) path += '?filter_entity_id=' + encodeURIComponent(String(args.entity_id));
		const data = await call('GET', path);
		if (data && data.__err) return data.__err;
		if (!Array.isArray(data)) return typeof data === 'string' ? data : JSON.stringify(data).slice(0, 2000);
		const flat = data.flat();
		if (flat.length === 0) return 'No history for ' + (args.entity_id ? cap(String(args.entity_id), 40) : 'any entity') + ' since ' + since + '.';
		const capHist = 20;
		const slice = flat.slice(-capHist);
		const header = 'History for ' + (args.entity_id ? cap(String(args.entity_id), 40) : 'entities') + ' since ' + since + ' — ' + flat.length + ' change' + (flat.length === 1 ? '' : 's') + (flat.length > capHist ? ' (showing last ' + slice.length + ')' : '') + ':';
		const lines = slice.map((h) => {
			const when = h.last_changed || h.last_updated || '';
			const t = when ? when.slice(11, 19) + ' ' : '';
			const st = cap(h.state, 40);
			const unit = h.attributes && h.attributes.unit_of_measurement ? ' ' + h.attributes.unit_of_measurement : '';
			return '• ' + t + st + unit;
		});
		return header + '\\n' + lines.join('\\n');
	}
	default:
		return 'error: unknown action "' + cap(String(args.action), 20) + '" — use states, state, call, or history.';
}`
	},
	{
		id: 'tailscale',
		name: 'Tailscale',
		description:
			'Joins the bot\'s machine to your tailnet: on enable a tailscale ' +
			'sidecar shares the machine\'s network and brings it up with the auth ' +
			'key, so the bot can reach tailnet hosts. The tool reports the ' +
			'machine\'s tailnet IP/status and can also query the Tailscale API ' +
			'(devices, authorize, keys) when an API key or OAuth client is set.',
		icon_svg: TAILSCALE_ICON,
		configFields: [
			{
				key: 'tailnet',
				label: 'Tailnet name',
				placeholder: 'example.com (or - for default)',
				required: true
			},
			{
				key: 'auth_key',
				label: 'Auth key (joins the machine)',
				secret: true,
				placeholder: 'tskey-auth-…',
				required: true
			},
			{ key: 'api_key', label: 'API key (for tailnet admin actions)', secret: true, placeholder: 'tskey-api-…' },
			{ key: 'client_id', label: 'OAuth client ID', placeholder: 'optional' },
			{ key: 'client_secret', label: 'OAuth client secret', secret: true }
		],
		ready: (v) => !!v.tailnet && !!v.auth_key,
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['status', 'reach', 'devices', 'device', 'authorize', 'create_key', 'dns'],
					description:
						'status/reach report this machine\'s tailnet link; the rest query the Tailscale API'
				},
				host: { type: 'string', description: 'Tailnet host or IP for reach' },
				port: { type: 'number', description: 'TCP port for reach, default 443' },
				device_id: { type: 'string', description: 'Device id for device/authorize' },
				reusable: { type: 'boolean', description: 'Auth key may be reused' },
				ephemeral: { type: 'boolean', description: 'Auth key creates ephemeral nodes' },
				preauthorized: { type: 'boolean', description: 'Auth key needs no approval (default true)' },
				tags: { type: 'array', items: { type: 'string' }, description: 'ACL tags for the key, e.g. tag:server' },
				expiry_seconds: { type: 'number', description: 'Key lifetime, default 86400' }
			},
			required: ['action']
		},
		toolCode: `// The machine's own tailnet link first: the sidecar shares this
// container's network namespace, so tailscale0 shows up here.
if (args.action === 'status') {
\tconst os = require('node:os');
\tconst ifaces = os.networkInterfaces();
\tconst ts = ifaces.tailscale0 || [];
\tconst ips = ts.filter((i) => i.family === 'IPv4').map((i) => i.address);
\treturn ips.length
\t\t? { online: true, ips, interface: 'tailscale0' }
\t\t: { online: false, detail: 'no tailscale0 interface - the connector may still be joining' };
}
if (args.action === 'reach') {
\tif (!args.host) return 'error: host required';
\tconst net = require('node:net');
\tconst port = args.port || 443;
\tconst { promise, resolve } = Promise.withResolvers();
\tconst sock = net.connect({ host: args.host, port, timeout: 8000 });
\tsock.on('connect', () => { sock.destroy(); resolve({ reachable: true, host: args.host, port }); });
\tsock.on('timeout', () => { sock.destroy(); resolve({ reachable: false, error: 'timed out' }); });
\tsock.on('error', (e) => resolve({ reachable: false, error: String((e && e.message) || e) }));
\treturn await promise;
}
const tailnet = config.tailnet || '-';
let token = config.api_key || '';
if (!token && config.client_id && config.client_secret) {
\tconst res = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
\t\tmethod: 'POST',
\t\theaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
\t\tbody: new URLSearchParams({
\t\t\tgrant_type: 'client_credentials',
\t\t\tclient_id: config.client_id,
\t\t\tclient_secret: config.client_secret
\t\t})
\t});
\tif (!res.ok) return 'error: tailscale oauth failed (HTTP ' + res.status + ')';
\ttoken = (await res.json()).access_token;
}
if (!token) return 'error: tailscale API actions need an api_key or oauth client (status/reach work without one)';
const call = async (method, path, body) => {
	const res = await fetch('https://api.tailscale.com' + path, {
		method,
		headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const data = await res.json().catch(() => null);
	if (!res.ok) return { error: 'tailscale HTTP ' + res.status, detail: data };
	return data;
};
const tn = encodeURIComponent(tailnet);
switch (args.action) {
	case 'devices':
		return await call('GET', '/api/v2/tailnet/' + tn + '/devices');
	case 'device':
		if (!args.device_id) return 'error: device_id required';
		return await call('GET', '/api/v2/device/' + encodeURIComponent(args.device_id));
	case 'authorize':
		if (!args.device_id) return 'error: device_id required';
		return await call('POST', '/api/v2/device/' + encodeURIComponent(args.device_id) + '/authorized', { authorized: true });
	case 'create_key':
		return await call('POST', '/api/v2/tailnet/' + tn + '/keys', {
			capabilities: {
				devices: {
					create: {
						reusable: !!args.reusable,
						ephemeral: !!args.ephemeral,
						preauthorized: args.preauthorized !== false,
						tags: args.tags || []
					}
				}
			},
			expirySeconds: args.expiry_seconds || 86400
		});
	case 'dns':
		return await call('GET', '/api/v2/tailnet/' + tn + '/dns/nameservers');
	default:
		return 'error: unknown action (devices|device|authorize|create_key|dns)';
}`
	},
	{
		id: 'elevenlabs-phone-calls',
		name: 'ElevenLabs phone calls',
		description:
			'Have a bot place real outbound phone calls with an ElevenLabs ' +
			'Conversational AI agent. Supply an API key from your ElevenLabs ' +
			'profile, the agent id, and the phone number id of a number imported ' +
			'under ElevenLabs telephony (Twilio or a SIP trunk) - that is the ' +
			'number the agent calls from. The bot can then dial a number with a ' +
			'goal, read a call\'s status and transcript, and list the account\'s ' +
			'phone numbers.',
		icon_svg: ELEVENLABS_ICON,
		configFields: [
			{
				key: 'api_key',
				label: 'ElevenLabs API key',
				secret: true,
				placeholder: 'sk_… (profile → API keys)',
				required: true
			},
			{
				key: 'agent_id',
				label: 'Agent id',
				placeholder: 'agent_… (the Conversational AI agent)',
				required: true
			},
			{
				key: 'phone_number_id',
				label: 'Phone number id (the number it calls from)',
				placeholder: 'phone_… (ElevenLabs → Phone numbers)',
				required: true
			}
		],
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['call', 'status', 'numbers'],
					description:
						'call places an outbound call, status reads one call, numbers lists the account\'s phone numbers'
				},
				to_number: {
					type: 'string',
					description: 'Number to dial for action=call, in E.164 form, e.g. +447700900123'
				},
				goal: {
					type: 'string',
					description:
						'What the agent should achieve on this call; it replaces the agent prompt for the call'
				},
				first_message: {
					type: 'string',
					description: 'Optional opening line the agent says once the call is answered'
				},
				conversation_id: {
					type: 'string',
					description: 'Conversation id returned by action=call, for action=status'
				}
			},
			required: ['action']
		},
		toolCode: `const BASE = 'https://api.elevenlabs.io';
const missing = (what) => 'error: elevenlabs connector is not configured (' + what + ' missing)';
if (!config.api_key) return missing('api_key');
const cap = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
const call = async (method, path, body) => {
\tlet res;
\ttry {
\t\tres = await fetch(BASE + path, {
\t\t\tmethod,
\t\t\theaders: { 'xi-api-key': String(config.api_key), 'Content-Type': 'application/json' },
\t\t\tbody: body === undefined ? undefined : JSON.stringify(body),
\t\t\tsignal: AbortSignal.timeout(20000)
\t\t});
\t} catch (e) {
\t\treturn { error: 'ElevenLabs unreachable: ' + String((e && e.message) || e) };
\t}
\tconst text = await res.text().catch(() => '');
\tlet data = null;
\ttry { data = text ? JSON.parse(text) : null; } catch { data = text.slice(0, 400); }
\tif (!res.ok) return { error: 'ElevenLabs HTTP ' + res.status, detail: data };
\treturn data;
};
switch (args.action) {
\tcase 'call': {
\t\tif (!config.agent_id) return missing('agent_id');
\t\tif (!config.phone_number_id) return missing('phone_number_id');
\t\tconst to = cap(args.to_number, 20);
\t\tif (!to) return 'error: to_number required (E.164, e.g. +447700900123)';
\t\tif (!/^\\+[1-9]\\d{6,14}$/.test(to)) {
\t\t\treturn 'error: "' + to + '" is not an E.164 number (e.g. +447700900123)';
\t\t}
\t\tconst body = {
\t\t\tagent_id: String(config.agent_id),
\t\t\tagent_phone_number_id: String(config.phone_number_id),
\t\t\tto_number: to
\t\t};
\t\tconst goal = cap(args.goal, 4000);
\t\tconst firstMessage = cap(args.first_message, 1000);
\t\tif (goal || firstMessage) {
\t\t\tconst agent = {};
\t\t\tif (goal) agent.prompt = { prompt: goal };
\t\t\tif (firstMessage) agent.first_message = firstMessage;
\t\t\tbody.conversation_initiation_client_data = { conversation_config_override: { agent } };
\t\t}
\t\tconst out = await call('POST', '/v1/convai/twilio/outbound-call', body);
\t\tif (!out || out.error) return out || 'error: ElevenLabs returned an empty response';
\t\treturn {
\t\t\tplaced: !!out.success,
\t\t\tconversation_id: out.conversation_id || '',
\t\t\tcall_sid: out.callSid || '',
\t\t\tmessage: out.message || ''
\t\t};
\t}
\tcase 'status': {
\t\tconst id = cap(args.conversation_id, 120);
\t\tif (!id) return 'error: conversation_id required (the id action=call returned)';
\t\tconst out = await call('GET', '/v1/convai/conversations/' + encodeURIComponent(id));
\t\tif (!out || out.error) return out || 'error: ElevenLabs returned an empty response';
\t\tconst meta = out.metadata || {};
\t\treturn {
\t\t\tstatus: out.status || '',
\t\t\tduration_secs: meta.call_duration_secs || 0,
\t\t\ttermination_reason: meta.termination_reason || '',
\t\t\ttranscript: (Array.isArray(out.transcript) ? out.transcript.slice(-10) : []).map((t) => ({
\t\t\t\trole: t.role || '',
\t\t\t\tmessage: cap(t.message, 500)
\t\t\t}))
\t\t};
\t}
\tcase 'numbers': {
\t\tconst out = await call('GET', '/v1/convai/phone-numbers');
\t\tif (!Array.isArray(out)) return out;
\t\treturn out.slice(0, 50).map((n) => ({
\t\t\tphone_number_id: n.phone_number_id || '',
\t\t\tphone_number: n.phone_number || '',
\t\t\tlabel: n.label || '',
\t\t\tprovider: n.provider || '',
\t\t\tassigned_agent: (n.assigned_agent && n.assigned_agent.agent_id) || ''
\t\t}));
\t}
\tdefault:
\t\treturn 'error: unknown action (call|status|numbers)';
}`
	}
];

/* ------------------------------------------------------------------ */
/* Stored config                                                       */
/* ------------------------------------------------------------------ */

interface StoredConfig {
	connector: string;
	values: Record<string, string>;
	/** Bots the connector is assigned to; overrides mirror this while enabled. */
	bots?: string[];
	/** WhatsApp: chats the bot may read/send to, with friendly names. */
	allowed_chats?: { id: string; alias: string }[];
}

/** db.ts's Plugin type predates both backfilled columns; rows carry them. */
type PluginRow = Plugin & { config?: string; icon_svg?: string };

function readConfig(plugin: Plugin): StoredConfig | null {
	const raw = (plugin as PluginRow).config;
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as StoredConfig;
		if (!parsed || typeof parsed.connector !== 'string' || !parsed.values) return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeConfig(pluginId: string, cfg: StoredConfig): void {
	db.prepare('UPDATE plugins SET config = ? WHERE id = ?').run(JSON.stringify(cfg), pluginId);
}

/** The plugin's config with `enc:` secrets decrypted. For plugin runs only. */
export function decryptedConfig(plugin: Plugin): Record<string, unknown> {
	const cfg = readConfig(plugin);
	if (!cfg) return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(cfg.values)) {
		if (typeof value === 'string' && value.startsWith(ENC_PREFIX)) {
			try {
				out[key] = decrypt(value.slice(ENC_PREFIX.length));
			} catch {
				out[key] = '';
			}
		} else {
			out[key] = value;
		}
	}
	// Structured extras ride alongside the flat values: the whatsapp
	// allowlist is read by its tool code as config.allowed_chats.
	if (cfg.allowed_chats) out.allowed_chats = cfg.allowed_chats;
	return out;
}

/** The catalog entry a plugin was installed from, if it is a connector. */
export function connectorOf(plugin: Plugin): ConnectorDef | undefined {
	const cfg = readConfig(plugin);
	return cfg ? CONNECTORS.find((c) => c.id === cfg.connector) : undefined;
}

function isConfigured(def: ConnectorDef, values: Record<string, unknown>): boolean {
	const filled = (key: string) => typeof values[key] === 'string' && values[key] !== '';
	if (def.ready) return def.ready(values);
	return def.configFields.every((f) => !f.required || filled(f.key));
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

export interface InstalledConnector {
	plugin_id: string;
	connector: string;
	name: string;
	description: string;
	icon_svg: string;
	enabled: boolean;
	configured: boolean;
	fields: ConfigField[];
	/** Non-secret values only. */
	values: Record<string, string>;
	/** Which secret fields hold a value (never the value). */
	secrets_set: Record<string, boolean>;
	/** Bots the connector is assigned to. */
	bots: string[];
	/** WhatsApp only: the chat allowlist with aliases. */
	allowed_chats?: { id: string; alias: string }[];
}

function installedView(plugin: Plugin, def: ConnectorDef): InstalledConnector {
	const cfg = readConfig(plugin) ?? { connector: def.id, values: {} };
	const values: Record<string, string> = {};
	const secretsSet: Record<string, boolean> = {};
	for (const field of def.configFields) {
		const stored = cfg.values[field.key] ?? '';
		if (field.secret) {
			secretsSet[field.key] = stored.startsWith(ENC_PREFIX);
		} else {
			values[field.key] = stored;
		}
	}
	const assigned = cfg.bots ?? [];
	return {
		plugin_id: plugin.id,
		connector: def.id,
		name: plugin.name,
		description: plugin.description,
		icon_svg: (plugin as PluginRow).icon_svg ?? def.icon_svg,
		enabled: plugin.enabled === 1,
		configured: isConfigured(def, decryptedConfig(plugin)),
		fields: def.configFields,
		values,
		secrets_set: secretsSet,
		bots: assigned,
		allowed_chats: cfg.allowed_chats
	};
}

/** Every installed connector, for Settings. */
export function listInstalled(): InstalledConnector[] {
	const out: InstalledConnector[] = [];
	for (const plugin of listPlugins()) {
		const def = connectorOf(plugin);
		if (def) out.push(installedView(plugin, def));
	}
	return out;
}

/** The catalog with install state, for the Marketplace. */
export function listCatalog() {
	const installed = new Map<string, Plugin>();
	for (const plugin of listPlugins()) {
		const cfg = readConfig(plugin);
		if (cfg) installed.set(cfg.connector, plugin);
	}
	return CONNECTORS.map((def) => {
		const plugin = installed.get(def.id);
		return {
			id: def.id,
			name: def.name,
			description: def.description,
			icon_svg: def.icon_svg,
			fields: def.configFields.map(({ key, label, secret, placeholder, required }) => ({
				key,
				label,
				secret: !!secret,
				placeholder,
				required: !!required
			})),
			installed: plugin
				? {
						plugin_id: plugin.id,
						enabled: plugin.enabled === 1,
						configured: isConfigured(def, decryptedConfig(plugin))
					}
				: null
		};
	});
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

/** Create the shared tool plugin for a catalog connector. */
export function installConnector(connectorId: string): InstalledConnector {
	const def = CONNECTORS.find((c) => c.id === connectorId);
	if (!def) throw error(404, 'unknown connector');
	for (const plugin of listPlugins()) {
		if (readConfig(plugin)?.connector === connectorId) {
			throw error(409, `${def.name} is already installed`);
		}
	}
	const plugin = createPlugin({
		name: def.name,
		description: def.description,
		kind: 'tool',
		hook_point: '',
		parameters: JSON.stringify(def.parameters),
		code: def.toolCode,
		icon_svg: def.icon_svg,
		author_bot_id: '',
		scope: 'shared',
		// Off until configured and assigned; per-bot overrides do the enabling.
		enabled: 0
	});
	writeConfig(plugin.id, { connector: def.id, values: {} });
	return installedView(getPlugin(plugin.id) ?? plugin, def);
}

export interface ConnectorPatch {
	values?: Record<string, string>;
	bots?: string[];
	enabled?: boolean;
	/** WhatsApp: the chat allowlist with aliases. */
	allowed_chats?: { id: string; alias: string }[];
}

/** Update config values, bot assignment and/or the enable flag. */
export function updateConnector(pluginId: string, patch: ConnectorPatch): InstalledConnector {
	const plugin = getPlugin(pluginId);
	if (!plugin) throw error(404, 'connector not found');
	const def = connectorOf(plugin);
	if (!def) throw error(404, 'not a connector plugin');
	const cfg = readConfig(plugin) ?? { connector: def.id, values: {} };

	if (patch.values) {
		for (const field of def.configFields) {
			const incoming = patch.values[field.key];
			if (incoming === undefined) continue;
			if (field.secret) {
				// '' means "keep the stored secret" - the page never held it, so a
				// blank input cannot wipe what it cannot see.
				if (incoming !== '') cfg.values[field.key] = ENC_PREFIX + encrypt(incoming);
			} else {
				cfg.values[field.key] = incoming;
			}
		}
		writeConfig(pluginId, cfg);
	}

	if (patch.bots) {
		const known = new Set(listBots().map((b) => b.id));
		for (const botId of patch.bots) {
			if (!known.has(botId)) throw error(404, `bot ${botId} not found`);
		}
		cfg.bots = patch.bots;
		writeConfig(pluginId, cfg);
	}

	if (patch.allowed_chats) {
		cfg.allowed_chats = patch.allowed_chats;
		writeConfig(pluginId, cfg);
	}

	if (patch.enabled !== undefined) {
		if (patch.enabled && !isConfigured(def, decryptedConfig(getPlugin(pluginId) ?? plugin))) {
			throw error(400, `${def.name} needs its settings filled in before it can be enabled`);
		}
		// The verdict holds the switch here too: a connector is switched on
		// through its own route, and that route is not a second opinion.
		if (patch.enabled) assertPluginMayBeEnabled(plugin);
		updatePlugin(pluginId, { enabled: patch.enabled ? 1 : 0 });
	}

	// Assignment and the enable flag meet in the overrides: a bot gets the
	// connector only while it is both assigned and the connector is on, so
	// either half changing rewrites every bot's override.
	if (patch.bots || patch.enabled !== undefined) {
		const on = patch.enabled ?? plugin.enabled === 1;
		// A re-assignment can leave the connector on for a bot without any
		// enable in this patch: the same hold applies before a single override
		// row is rewritten, so refused code cannot be assigned its way back on.
		if (on) assertPluginMayBeEnabled(plugin);
		const assigned = new Set(cfg.bots ?? []);
		for (const bot of listBots()) {
			setPluginOverride(pluginId, bot.id, on && assigned.has(bot.id));
		}
	}

	// Tailscale's job is the machine's tailnet link: once the connector is on
	// and assigned, each assigned bot's machine gets its sidecar. Best-effort -
	// a bot whose machine cannot start still keeps its other tools.
	if (def.id === 'tailscale' && (patch.bots || patch.enabled || patch.values)) {
		const on = patch.enabled ?? plugin.enabled === 1;
		if (on) {
			const authKey = String(decryptedConfig(getPlugin(pluginId) ?? plugin).auth_key ?? '');
			for (const botId of cfg.bots ?? []) {
				void ensureTailscale(botId, authKey).catch((e) =>
					console.warn(`tailscale join for ${botId} failed:`, e)
				);
			}
		}
	}

	return installedView(getPlugin(pluginId) ?? plugin, def);
}

/** Remove the connector's plugin (overrides cascade). */
export function uninstallConnector(pluginId: string): void {
	const plugin = getPlugin(pluginId);
	if (!plugin || !connectorOf(plugin)) throw error(404, 'connector not found');
	deletePlugin(pluginId);
}

/* ------------------------------------------------------------------ */
/* WhatsApp pairing                                                    */
/* ------------------------------------------------------------------ */

export interface ConnectResult {
	/** WAHA session status: SCANNING_QR_CODE, WORKING, STOPPED, … */
	status: string;
	/** PNG data URL to show for scanning, when the session wants a QR. */
	qr?: string;
	detail?: string;
}

/**
 * Start the connector's WAHA session and fetch the pairing QR. The image is
 * fetched server-side (the api_key never reaches the page) and returned as a
 * data URL.
 */
export async function connectWhatsapp(pluginId: string): Promise<ConnectResult> {
	const plugin = getPlugin(pluginId);
	if (!plugin) throw error(404, 'connector not found');
	const def = connectorOf(plugin);
	if (def?.id !== 'whatsapp') throw error(400, 'only the whatsapp connector can pair');
	const cfg = decryptedConfig(plugin);
	const base = String(cfg.base_url ?? '').replace(/\/+$/, '');
	if (!base) throw error(400, 'set the WAHA base URL first');
	const session = String(cfg.session || 'default');
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cfg.api_key) headers['X-Api-Key'] = String(cfg.api_key);
	const s = encodeURIComponent(session);

	const get = async (path: string) => {
		try {
			return await fetch(base + path, { headers, signal: AbortSignal.timeout(10_000) });
		} catch (e) {
			throw error(502, `WAHA unreachable at ${base}: ${(e as Error).message}`);
		}
	};

	// The session may not exist yet; create it started so it begins pairing.
	let res = await get(`/api/sessions/${s}`);
	if (res.status === 404) {
		res = await fetch(`${base}/api/sessions`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: session, start: true }),
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) {
			return { status: 'ERROR', detail: `could not create session (${res.status})` };
		}
	} else {
		const info = (await res.json().catch(() => null)) as { status?: string } | null;
		if (info?.status === 'WORKING') return { status: 'WORKING' };
		await fetch(`${base}/api/sessions/${s}/start`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(10_000)
		}).catch(() => {});
	}

	// The QR appears once the session is up; give it a few short tries.
	for (let attempt = 0; attempt < 5; attempt++) {
		const qr = await fetch(`${base}/api/${s}/auth/qr`, {
			headers: { ...headers, Accept: 'image/png' },
			signal: AbortSignal.timeout(10_000)
		}).catch(() => null);
		if (qr?.ok) {
			const buf = Buffer.from(await qr.arrayBuffer());
			return { status: 'SCANNING_QR_CODE', qr: `data:image/png;base64,${buf.toString('base64')}` };
		}
		const info = (await (await get(`/api/sessions/${s}`)).json().catch(() => null)) as {
			status?: string;
		} | null;
		if (info?.status === 'WORKING') return { status: 'WORKING' };
		if (info?.status && info.status !== 'SCANNING_QR_CODE' && info.status !== 'STARTING') {
			return { status: info.status };
		}
		await delay(1500);
	}
	return { status: 'STARTING', detail: 'session is still starting; try again in a moment' };
}

/** The chats a connected WAHA session can see, for the allowlist picker. */
export async function listWhatsappChats(pluginId: string): Promise<{ id: string; name: string }[]> {
	const plugin = getPlugin(pluginId);
	if (!plugin) throw error(404, 'connector not found');
	const def = connectorOf(plugin);
	if (def?.id !== 'whatsapp') throw error(400, 'only the whatsapp connector lists chats');
	const cfg = decryptedConfig(plugin);
	const base = String(cfg.base_url ?? '').replace(/\/+$/, '');
	if (!base) throw error(400, 'set the WAHA base URL first');
	const session = String(cfg.session || 'default');
	const headers: Record<string, string> = {};
	if (cfg.api_key) headers['X-Api-Key'] = String(cfg.api_key);
	let res: Response;
	try {
		res = await fetch(`${base}/api/${encodeURIComponent(session)}/chats?limit=200`, {
			headers,
			signal: AbortSignal.timeout(10_000)
		});
	} catch (e) {
		throw error(502, `WAHA unreachable at ${base}: ${(e as Error).message}`);
	}
	if (!res.ok) throw error(502, `WAHA answered ${res.status}`);
	const data: unknown = await res.json();
	if (!Array.isArray(data)) return [];
	return data
		.map((c) => {
			const raw = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
			const idField = raw.id;
			const id =
				typeof idField === 'string'
					? idField
					: idField && typeof idField === 'object'
						? String((idField as Record<string, unknown>)._serialized ?? '')
						: '';
			return { id, name: String(raw.name ?? '') };
		})
		.filter((c) => c.id !== '');
}

/* ------------------------------------------------------------------ */
/* ElevenLabs phone numbers                                            */
/* ------------------------------------------------------------------ */

export interface ElevenLabsNumber {
	phone_number_id: string;
	phone_number: string;
	label: string;
	provider: string;
	/** The agent the number is assigned to, when one is. */
	assigned_agent: string;
}

/**
 * The ElevenLabs account's phone numbers, for the Settings picker: the
 * phone_number_id the connector needs is not shown anywhere in the dashboard's
 * URL, so the page reads it out of the API with the stored key.
 */
export async function elevenlabsPhoneNumbers(pluginId: string): Promise<ElevenLabsNumber[]> {
	const plugin = getPlugin(pluginId);
	if (!plugin) throw error(404, 'connector not found');
	const def = connectorOf(plugin);
	if (def?.id !== 'elevenlabs-phone-calls') throw error(400, 'not the elevenlabs connector');
	const key = String(decryptedConfig(plugin).api_key ?? '');
	if (!key) throw error(400, 'set the ElevenLabs API key first');
	let res: Response;
	try {
		res = await fetch('https://api.elevenlabs.io/v1/convai/phone-numbers', {
			headers: { 'xi-api-key': key },
			signal: AbortSignal.timeout(15_000)
		});
	} catch (e) {
		throw error(502, `ElevenLabs unreachable: ${(e as Error).message}`);
	}
	if (!res.ok) throw error(502, `ElevenLabs answered ${res.status}`);
	const data: unknown = await res.json().catch(() => null);
	if (!Array.isArray(data)) return [];
	return data.slice(0, 100).map((raw) => {
		const n: Record<string, unknown> =
			raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
		const agent = n.assigned_agent;
		return {
			phone_number_id: String(n.phone_number_id ?? ''),
			phone_number: String(n.phone_number ?? ''),
			label: String(n.label ?? ''),
			provider: String(n.provider ?? ''),
			assigned_agent:
				agent && typeof agent === 'object'
					? String((agent as Record<string, unknown>).agent_id ?? '')
					: ''
		};
	});
}

/* ------------------------------------------------------------------ */
/* Tailscale machine join                                              */
/* ------------------------------------------------------------------ */

const TAILSCALE_IMAGE = process.env.TAILSCALE_IMAGE ?? 'tailscale/tailscale:latest';

const tailscaleName = (botId: string) => `obl-tailscale-${botId.slice(0, 12)}`;

async function findTailscale(botId: string) {
	const res = await dockerRequest(
		'GET',
		`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: [tailscaleName(botId)] }))}`
	);
	if (res.status !== 200) return null;
	const list = JSON.parse(res.body.toString()) as ContainerInfo[];
	return list[0] ?? null;
}

async function containerStartedAt(id: string): Promise<number> {
	const res = await dockerRequest('GET', `/containers/${id}/json`);
	if (res.status !== 200) return 0;
	const info: unknown = JSON.parse(res.body.toString());
	const started =
		info && typeof info === 'object' && 'State' in info
			? String((info.State as Record<string, unknown>).StartedAt ?? '')
			: '';
	const ms = Date.parse(started);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * Bring the bot's machine onto the tailnet: a tailscale/tailscale sidecar
 * shares the machine's network namespace (NetworkMode container:<machine>),
 * so everything the machine does - tools, fetches, shells - can reach tailnet
 * hosts. The auth key goes in as TS_AUTHKEY; the image brings tailscaled up
 * itself and keeps state on a per-bot volume so restarts stay logged in.
 *
 * machine.ts is UnifiedMachine's module; the dynamic import keeps this file
 * loadable while it lands.
 */
export async function ensureTailscale(botId: string, authKey: string): Promise<void> {
	if (!authKey) throw new Error('tailscale auth key is not configured');
	const { ensureMachine, machineName } = await import('./machine');
	const machine = await ensureMachine(botId);
	const name = tailscaleName(botId);
	let c = await findTailscale(botId);
	if (!c) {
		const res = await dockerRequest('POST', `/containers/create?name=${name}`, {
			Image: TAILSCALE_IMAGE,
			Env: [
				`TS_AUTHKEY=${authKey}`,
				`TS_HOSTNAME=obl-${botId.slice(0, 8)}`,
				'TS_STATE_DIR=/var/lib/tailscale',
				'TS_USERSPACE=false',
				// The machine's network is internal, so the sidecar's only way to
				// the tailnet is the egress proxy. tailscaled honours HTTPS_PROXY
				// for its control plane and DERP relays; direct UDP paths simply
				// do not exist in there.
				`HTTPS_PROXY=${EGRESS_URL}`,
				`HTTP_PROXY=${EGRESS_URL}`
			],
			HostConfig: {
				NetworkMode: `container:${machineName(botId)}`,
				CapAdd: ['NET_ADMIN'],
				Binds: [`obl-tailscale-${botId.slice(0, 12)}:/var/lib/tailscale`],
				RestartPolicy: { Name: 'unless-stopped' }
			},
			Labels: { 'obl.bot': botId, 'obl.managed': 'true', 'obl.kind': 'tailscale' }
		});
		if (res.status === 201) {
			const created: { Id: string } = JSON.parse(res.body.toString());
			c = { Id: created.Id, State: 'created', Names: [name] };
		} else if (res.status === 409) {
			await delay(250);
			c = await findTailscale(botId);
		} else if (res.status === 404 || res.body.includes('No such image')) {
			throw new Error(`tailscale image not pulled: docker pull ${TAILSCALE_IMAGE}`);
		} else {
			throw new Error(`Docker create failed ${res.status}: ${res.body.slice(0, 200)}`);
		}
	}
	if (!c) throw new Error('tailscale sidecar could not be created');
	if (!isRunning(c)) {
		const res = await dockerRequest('POST', `/containers/${c.Id}/start`);
		if (res.status !== 204 && res.status !== 304) {
			throw new Error(`tailscale sidecar start failed ${res.status}`);
		}
	} else {
		// A restarted machine gets a fresh netns; a sidecar started before it is
		// still bound to the dead one, so it has to come up again to re-attach.
		const [machineStarted, sidecarStarted] = await Promise.all([
			containerStartedAt(machine),
			containerStartedAt(c.Id)
		]);
		if (machineStarted > sidecarStarted) {
			await dockerRequest('POST', `/containers/${c.Id}/restart`).catch(() => {});
		}
	}
}

/** The sidecar's own report: backend state and the machine's tailnet IPs. */
export async function tailscaleStatus(botId: string): Promise<{
	online: boolean;
	ips: string[];
	backend: string;
	detail?: string;
}> {
	const c = await findTailscale(botId);
	if (!c || !isRunning(c)) {
		return { online: false, ips: [], backend: 'off', detail: 'no tailscale sidecar running' };
	}
	const status = await dockerExec(c.Id, ['tailscale', 'status', '--json'], { timeoutMs: 15_000 });
	if (status.exitCode !== 0) {
		return { online: false, ips: [], backend: 'error', detail: status.output.trim().slice(0, 300) };
	}
	let backend = '';
	try {
		const parsed: unknown = JSON.parse(status.output);
		if (parsed && typeof parsed === 'object' && 'BackendState' in parsed) {
			backend = String(parsed.BackendState);
		}
	} catch {
		// Fall through to the ip probe.
	}
	const ips = await dockerExec(c.Id, ['tailscale', 'ip', '-4'], { timeoutMs: 15_000 });
	const list = ips.exitCode === 0 ? ips.output.trim().split('\n').filter(Boolean) : [];
	return { online: backend === 'Running' && list.length > 0, ips: list, backend };
}
