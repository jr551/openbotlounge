import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createPlugin, listPlugins, runPluginTests, selfTestPlugin, updatePlugin } from '$lib/server/plugins';
import { getBot, setPluginVerification } from '$lib/server/db';
import { policeModel, policeSettings, reviewPlugin, verdictJson } from '$lib/server/police';
import { readJson, strField } from '$lib/server/http';


export const GET: RequestHandler = () => {
	return json({ plugins: listPlugins() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const name = (strField(body, 'name', 80) ?? '').trim();
	const kind = strField(body, 'kind', 20) ?? '';
	const scope = strField(body, 'scope', 20) ?? 'bot';
	const hookPoint = strField(body, 'hook_point', 40) ?? '';
	const code = strField(body, 'code', 20000) ?? '';
	if (!name) throw error(400, 'name required');
	// Tools are dispatched by slugified name, so a second plugin with the same
	// one is unreachable - the first match wins.
	if (listPlugins().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
		throw error(409, `a plugin named "${name}" already exists`);
	}
	if (kind !== 'tool' && kind !== 'hook') throw error(400, 'kind must be tool or hook');
	if (scope !== 'bot' && scope !== 'shared') throw error(400, 'scope must be bot or shared');
	if (kind === 'hook' && hookPoint !== 'before_reply' && hookPoint !== 'after_reply') {
		throw error(400, 'hook_point must be before_reply or after_reply');
	}
	// A bot-scoped plugin with no bot belongs to nobody: it is stored, listed and
	// never run by anyone. Only a shared one may be authored by the user.
	const author = strField(body, 'author_bot_id', 80) ?? '';
	if (scope === 'bot' && !author) throw error(400, 'author_bot_id required for a bot-scoped plugin');
	if (author && !getBot(author)) throw error(404, 'author bot not found');
	let parameters = '{}';
	if (body.parameters !== undefined) {
		const raw = typeof body.parameters === 'string' ? body.parameters : JSON.stringify(body.parameters);
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw error(400, 'parameters must be a JSON schema object');
			}
			parameters = raw;
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) throw e;
			throw error(400, 'parameters must be valid JSON');
		}
	}
	// With the plugin gate on the row starts disabled: the review below runs
	// after the response, and unvetted code must not be live in the gap between
	// creation and verdict. It is switched on only when the officer approves -
	// a refusal, an unreviewable plugin, or a dead review leaves it off, which
	// is where a routine lands while it awaits the police.
	const gated = policeSettings().checkPlugins;
	const plugin = createPlugin({
		name,
		description: strField(body, 'description', 500) ?? '',
		kind,
		hook_point: kind === 'hook' ? hookPoint : '',
		parameters,
		code,
		icon_svg: strField(body, 'icon_svg', 8000),
		author_bot_id: author,
		scope,
		enabled: gated ? 0 : 1
	});
	// The same gate the bot's own create_plugin tool passes through: a plugin
	// is code that will run inside a bot's sandbox, so the human's path is
	// reviewed too rather than being a way around the police. The review is a
	// sandbox self-test plus an officer's model call - tens of seconds on a
	// good day, a hang on a bad one - so it runs after the response rather
	// than holding it: the verdict lands on the row whenever it finishes, the
	// way a hook rewrite lands after the send that triggered it. A refusal is
	// not a success: the plugin is kept so it can be fixed, but it is switched
	// off. A plugin the police could not review is off as well - unsigned code
	// does not get the benefit of the doubt. With the gate off the plugin is
	// simply created, unsigned and unrefused.
	if (gated) {
		const bot = getBot(author);
		void (async () => {
			// The sandbox self-test runs in the author's machine; a shared
			// plugin has no author, so there is nowhere to run it and the
			// officer is told that rather than given a verdict built on a
			// failed boot.
			const test = bot
				? await selfTestPlugin(plugin)
				: { ok: true, output: '(not run - a shared plugin has no author machine)' };
			const tests = bot ? await runPluginTests(plugin, bot) : [];
			const review = await reviewPlugin({
				name: plugin.name,
				description: plugin.description,
				kind: plugin.kind,
				hookPoint: plugin.hook_point,
				parameters: plugin.parameters,
				code: plugin.code,
				selfTest: test,
				tests,
				model: policeModel()
			});
			setPluginVerification(plugin.id, verdictJson(review));
			// The row was born disabled while the review ran; approval is what
			// switches it on. A refusal or an unreviewable plugin stays off.
			if (review.verdict === 'approved') updatePlugin(plugin.id, { enabled: 1 });
		})().catch(() => {
			// A review that dies outright leaves the row unverified; the console
			// already reads an empty verdict as "not reviewed".
		});
	}
	return json(plugin, { status: 201 });
};

