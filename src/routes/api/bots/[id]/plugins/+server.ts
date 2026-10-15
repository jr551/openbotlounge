import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { assertPluginMayBeEnabled, getPlugin, pluginsForBot, setPluginOverride } from '$lib/server/plugins';
import { boolField, readJson, strField } from '$lib/server/http';

export const GET: RequestHandler = ({ params }) => {
	if (!getBot(params.id)) throw error(404, 'bot not found');
	return json({ plugins: pluginsForBot(params.id) });
};

export const POST: RequestHandler = async ({ params, request }) => {
	if (!getBot(params.id)) throw error(404, 'bot not found');
	const body = await readJson(request);
	const pluginId = strField(body, 'plugin_id', 80) ?? '';
	const plugin = getPlugin(pluginId);
	if (!plugin) throw error(404, 'plugin not found');
	const enabled = boolField(body, 'enabled') ?? true;
	// A bot's own override is a preference, not a second verdict: it must not
	// be the way a plugin the police refused starts running again.
	if (enabled) assertPluginMayBeEnabled(plugin);
	setPluginOverride(pluginId, params.id, enabled);
	return json({ ok: true });
};
