import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Plugin } from '$lib/server/db';
import {
	assertPluginMayBeEnabled,
	deletePlugin,
	getPlugin,
	selfTestPlugin,
	updatePlugin
} from '$lib/server/plugins';
import { getBot } from '$lib/server/db';
import { policePlugin } from '$lib/server/plugin-gate';
import { policeSettings } from '$lib/server/police';
import { boolField, readJson, strField } from '$lib/server/http';

export const PATCH: RequestHandler = async ({ params, request }) => {
	const plugin = getPlugin(params.id);
	if (!plugin) throw error(404, 'plugin not found');
	const body = await readJson(request);
	const patch: Partial<Omit<Plugin, 'id' | 'created_at' | 'effective_enabled'>> & {
		icon_svg?: string;
	} = {};
	if (body.name !== undefined) {
		const name = (strField(body, 'name', 80) ?? '').trim();
		if (!name) throw error(400, 'name required');
		patch.name = name;
	}
	const description = strField(body, 'description', 500);
	if (description !== undefined) patch.description = description;
	const code = strField(body, 'code', 20000);
	if (code !== undefined) patch.code = code;
	const iconSvg = strField(body, 'icon_svg', 8000);
	if (iconSvg !== undefined) patch.icon_svg = iconSvg;
	const kind = body.kind !== undefined ? body.kind : plugin.kind;
	if (body.kind !== undefined) {
		if (body.kind !== 'tool' && body.kind !== 'hook') {
			throw error(400, 'kind must be tool or hook');
		}
		patch.kind = body.kind;
	}
	if (body.hook_point !== undefined) {
		// Same rule as POST: only a hook has a hook point. A tool that arrives
		// with one - or is switched to a tool - stores '', so a stray value
		// cannot linger on a row that has no use for it.
		if (kind === 'tool') {
			patch.hook_point = '';
		} else {
			const hookPoint = strField(body, 'hook_point', 40);
			if (hookPoint !== 'before_reply' && hookPoint !== 'after_reply') {
				throw error(400, 'hook_point must be before_reply or after_reply');
			}
			patch.hook_point = hookPoint;
		}
	}
	if (body.scope !== undefined) {
		if (body.scope !== 'bot' && body.scope !== 'shared') {
			throw error(400, 'scope must be bot or shared');
		}
		patch.scope = body.scope;
	}
	if (body.parameters !== undefined) {
		const raw =
			typeof body.parameters === 'string' ? body.parameters : JSON.stringify(body.parameters);
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw error(400, 'parameters must be a JSON schema object');
			}
			patch.parameters = raw;
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) throw e;
			throw error(400, 'parameters must be valid JSON');
		}
	}
	const enabled = boolField(body, 'enabled');
	if (enabled !== undefined) {
		// Switching it off is always the human's to do; switching it on is not
		// while the police's refusal stands.
		if (enabled) assertPluginMayBeEnabled(plugin);
		patch.enabled = enabled ? 1 : 0;
	}
	updatePlugin(params.id, patch);
	// The same re-review the bot's own update_plugin runs: new code,
	// parameters or hook point is a new creation for the police to judge,
	// and a refusal switches the plugin off the same way. Name, description
	// and the switch itself change nothing the officer judges, so they draw
	// no review. A plugin with no author machine self-tests against a bare
	// stand-in, exactly as the review route does.
	if (patch.code !== undefined || patch.parameters !== undefined || patch.hook_point !== undefined) {
		if (policeSettings().checkPlugins) {
			const updated = getPlugin(params.id)!;
			const bot = plugin.author_bot_id ? (getBot(plugin.author_bot_id) ?? null) : null;
			const test = bot
				? await selfTestPlugin(updated)
				: { ok: true, output: '(not run - a shared plugin has no author machine)' };
			await policePlugin(updated, test, bot);
		}
	}
	return json(getPlugin(params.id));
};

export const DELETE: RequestHandler = ({ params }) => {
	if (!deletePlugin(params.id)) throw error(404, 'no such plugin');
	return new Response(null, { status: 204 });
};
