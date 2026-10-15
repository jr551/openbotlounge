import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import type { ToolDef } from './llm';
import type { Plugin } from './db';
import {
	db,
	getBot,
	logActivity,
	pluginsForBot,
	createPlugin as dbCreatePlugin,
	updatePlugin as dbUpdatePlugin
} from './db';
import { machineExec, machineWriteFile } from './machine';
import { decrypt } from './secrets';
import { decryptedConfig, connectorOf, ensureTailscale } from './connectors';
import { refusedByPolice } from '$lib/plugin-verdict';

export {
	deletePlugin,
	getPlugin,
	listPlugins,
	pluginsForBot,
	setPluginOverride,
	setPluginVerification
} from './db';

// icon_svg arrived after the plugins table; backfill older databases the same
// way db.ts's ADDED_COLUMNS does, since that file is owned elsewhere.
if (
	!(db.prepare('PRAGMA table_info(plugins)').all() as unknown as { name: string }[]).some(
		(c) => c.name === 'icon_svg'
	)
) {
	db.exec(`ALTER TABLE plugins ADD COLUMN icon_svg TEXT NOT NULL DEFAULT ''`);
}

const ICON_SVG_MAX = 8000;

/**
 * The icon a plugin draws inside its puzzle badge: one self-contained <svg>.
 * Anything that can run code or fetch a resource is rejected outright rather
 * than stripped - a half-broken icon is worse than none. SMIL animation is
 * fine; scripts, event handlers, <style> (it applies document-wide, not to the
 * badge), foreignObject, raster <image>s and every reference that leaves the
 * document (href/src/url()/image-set() must point at an internal #id) are not.
 */
export function sanitizeIconSvg(svg: string): string | null {
	const raw = svg.trim();
	// Comments are inert; check the markup underneath so rule text like
	// "no url()" inside a comment can't trip the filters.
	const s = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
	if (!raw || raw.length > ICON_SVG_MAX) return null;
	if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
	if (!/\bviewBox\s*=/i.test(s)) return null;
	if (/<\?/.test(s) || /<!\s*(?:doctype|entity|\[cdata)/i.test(s)) return null;
	if (/<\/?\s*(?:script|style|foreignobject|iframe|object|embed|image|audio|video|a)\b/i.test(s))
		return null;
	// An event handler is an attribute, and an attribute starts at a real
	// boundary: whitespace, a quote, or the self-closing slash. Requiring
	// whitespace missed `<svg viewBox=…/onload=…>` and `…"onload=…`, which the
	// HTML/SVG tokenizer still reads as attributes - the bypass that let a
	// stored icon run script.
	if (/(?:^|[\s"'/])on[a-z]+\s*=/i.test(s)) return null;
	if (/javascript\s*:/i.test(s)) return null;
	if (/url\s*\(\s*(?!['"]?\s*#)/i.test(s)) return null;
	if (/(?:-webkit-)?image-set\s*\(/i.test(s)) return null;
	if (/\b(?:href|src)\s*=\s*(?!['"]?\s*#)/i.test(s)) return null;
	if (/@import|expression\s*\(/i.test(s)) return null;
	return raw;
}

/** The icon every drafted plugin starts with; its comment block is the rule
    list the sanitizer enforces, kept in the markup so whoever edits it (user
    or model) sees the contract. */
export const DEFAULT_ICON_SVG = `<!-- Icon rules: a single <svg> with viewBox="0 0 24 24", under 8KB.
     Animate with SMIL (<animate>, <animateTransform>). No <style> (CSS applies to the
     whole document, not the badge), scripts, event handlers, <image>/<foreignObject>, or
     external links - href/url()/image-set() may only reference #ids inside this file.
     Shown ~18px in a puzzle badge. -->
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <circle cx="12" cy="12" r="7">
    <animate attributeName="r" values="6;8;6" dur="2s" repeatCount="indefinite"/>
    <animate attributeName="stroke-opacity" values="1;.35;1" dur="2s" repeatCount="indefinite"/>
  </circle>
  <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>
</svg>`;

type PluginInput = Omit<Plugin, 'id' | 'created_at' | 'effective_enabled' | 'verification' | 'tests'> & {
	icon_svg?: string;
	/** Omitted reads as no tests; the gate is the police's, not the writer's. */
	tests?: string;
};

/** Validate an icon patch; '' clears the icon back to the emoji fallback. */
function checkIcon(svg: string | undefined): string | undefined {
	if (svg === undefined || svg === '') return svg;
	const clean = sanitizeIconSvg(svg);
	if (clean === null) {
		throw error(
			400,
			'icon_svg must be one self-contained <svg> with a viewBox - no scripts, handlers or external references'
		);
	}
	return clean;
}

// db.ts's createPlugin/updatePlugin whitelist their columns and predate
// icon_svg, so the icon rides alongside: validated here, written directly.
export function createPlugin(p: PluginInput): Plugin & { icon_svg: string } {
	const icon = checkIcon(p.icon_svg);
	const plugin = dbCreatePlugin(p);
	if (icon) db.prepare('UPDATE plugins SET icon_svg = ? WHERE id = ?').run(icon, plugin.id);
	return { ...plugin, icon_svg: icon ?? '' };
}

export function updatePlugin(id: string, patch: Partial<PluginInput>): void {
	const icon = checkIcon(patch.icon_svg);
	const { icon_svg: _icon, tests, ...rest } = patch;
	dbUpdatePlugin(id, { ...rest, ...(tests !== undefined ? { tests } : {}) });
	if (icon !== undefined) {
		db.prepare('UPDATE plugins SET icon_svg = ? WHERE id = ?').run(icon, id);
	}
}

/**
 * Refuse to switch a plugin back on while the police's refusal stands. The
 * officer's no is a verdict, not a default: a flip of the switch, or of a
 * bot's own override, must not quietly run refused code behind it. The one
 * thing that lifts it is the human's ruling - the approve route, which writes
 * a verdict of its own with by:'human' - and a plugin the police never
 * refused, or one the human already signed off, passes straight through.
 */
export function assertPluginMayBeEnabled(plugin: Plugin): void {
	if (!refusedByPolice(plugin.verification)) return;
	throw error(
		409,
		`the police refused "${plugin.name}" - overrule them by approving it yourself (POST /api/plugins/${plugin.id}/approve)`
	);
}

export type HookPoint = 'before_reply' | 'after_reply';

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

/**
 * Run a plugin's code as the body of an async function, inside the bot's own
 * sandbox container.
 *
 * It runs there rather than in this process on purpose. `node:vm` is a
 * convenience, not a security boundary: any host object handed to the context
 * exposes the host `Function` constructor, so `args.constructor.constructor(
 * 'return process')()` reaches this process - its environment, its database,
 * and the Docker socket mounted for the sandbox feature. The container is the
 * only real boundary, so plugin code lives with the rest of the bot's tools.
 */
async function runPluginCode(
	plugin: Plugin,
	bot: { id: string; name: string },
	args: Record<string, unknown>
): Promise<unknown> {
	const harness = `const args = ${JSON.stringify(args)};
const bot = ${JSON.stringify({ id: bot.id, name: bot.name })};
// Connector plugins carry their settings (credentials included, decrypted
// here server-side) as this object; ordinary plugins get an empty one.
const config = ${JSON.stringify(decryptedConfig(plugin))};
(async () => {
  try {
    const out = await (async () => { ${plugin.code} })();
    process.stdout.write('__OBL_OK__' + JSON.stringify(out === undefined || out === null ? '' : out));
  } catch (e) {
    process.stdout.write('__OBL_ERR__' + String((e && e.message) || e));
  }
})();
`;
	// A tailscale connector's job is the machine's tailnet link: the machine is
	// up now, so its sidecar can attach to the live netns. Best-effort - a
	// failed join must not break the plugin run itself.
	if (connectorOf(plugin)?.id === 'tailscale') {
		await ensureTailscale(bot.id, String(decryptedConfig(plugin).auth_key ?? '')).catch((e) =>
			console.warn(`tailscale join for ${bot.id} failed:`, e)
		);
	}
	// Unique per run, not per plugin: the command below deletes the file when it
	// is done, so two turns running the same plugin at once would otherwise race
	// and one of them would start node on a file the other had just removed.
	const path = `/tmp/obl-plugin-${plugin.id}-${randomUUID().slice(0, 8)}.js`;
	await machineWriteFile(bot.id, path, harness);
	const output = await machineExec(
		bot.id,
		// The exec answers only when the command does, and nothing on this side
		// aborts it, so a plugin that never returns would otherwise hold the
		// turn open for good. `timeout` is what stops the runaway process and
		// hands the turn back a plain error string.
		`timeout ${PLUGIN_TIMEOUT_S} node ${path}; rc=$?; rm -f ${path}; ` +
			`[ "$rc" -eq 124 ] && echo '${ERR}the plugin ran for more than ${PLUGIN_TIMEOUT_S}s and was stopped'`
	);
	return parseHarnessOutput(output);
}

/** Wall-clock ceiling for one plugin run, seconds. */
const PLUGIN_TIMEOUT_S = 30;

const OK = '__OBL_OK__';
const ERR = '__OBL_ERR__';

/**
 * Read the harness's marker line out of the container's output. The markers are
 * how a plugin's return value and its exceptions survive the shell round-trip.
 *
 * The value keeps its type: a hook has to be able to tell a replacement string
 * from a number or an object, and the caller decides what to do with either.
 */
export function parseHarnessOutput(output: string): unknown {
	const ok = output.indexOf(OK);
	if (ok !== -1) {
		const payload = output.slice(ok + OK.length).split('\n')[0];
		try {
			return JSON.parse(payload);
		} catch {
			throw new Error('the plugin returned something unreadable');
		}
	}
	const err = output.indexOf(ERR);
	if (err !== -1) throw new Error(output.slice(err + ERR.length).split('\n')[0]);
	throw new Error(output.trim() || 'the plugin produced no output');
}

/** Dummy values by JSON-schema type, enough to make a call real. */
const DUMMY_BY_TYPE: Record<string, unknown> = {
	number: 1,
	boolean: true,
	array: [],
	object: {}
};

/**
 * Args for a self-test run: a dummy value for every required field in the
 * plugin's parameters schema, nothing for the optional ones - the same shape
 * a careful caller would send.
 */
function argsFromSchema(parameters: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(parameters || '{}');
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const schema = parsed as { required?: string[]; properties?: Record<string, { type?: string }> };
			for (const key of schema.required ?? []) {
				const type = schema.properties?.[key]?.type ?? '';
				// Anything untyped or unknown reads as a string field. The
				// lookup must be own-property, not `in`: `in` walks the
				// prototype chain, so a schema declaring "type":"toString"
				// would find Object.prototype.toString, hand the code a
				// function, and JSON.stringify would drop it - the required
				// argument then arrives missing instead of as a string.
				args[key] = Object.hasOwn(DUMMY_BY_TYPE, type) ? DUMMY_BY_TYPE[type] : 'test';
			}
		}
	} catch {
		// A malformed schema still gets a run with no args - that is a finding
		// too, and the error lands in the output either way.
	}
	return args;
}

const SELF_TEST_MAX = 300;

/**
 * Run a freshly written plugin once with dummy arguments, so its creator sees
 * whether the code even runs - and what it returns - before wiring it into
 * real conversations. Never throws: a failure comes back as ok:false with the
 * error as the output.
 */
export async function selfTestPlugin(plugin: Plugin): Promise<{ ok: boolean; output: string }> {
	// A hook reads args.message, not schema fields; give it one line to chew on.
	const args: Record<string, unknown> =
		plugin.kind === 'hook'
			? { message: 'self-test message' }
			: argsFromSchema(plugin.parameters);
	try {
		const result = await runPluginCode(
			plugin,
			getBot(plugin.author_bot_id) ?? { id: plugin.author_bot_id, name: '' },
			args
		);
		let out: string;
		if (typeof result === 'string') out = result;
		else if (result === undefined || result === null) out = '';
		else {
			try {
				out = JSON.stringify(result);
			} catch {
				out = String(result);
			}
		}
		return { ok: true, output: out.slice(0, SELF_TEST_MAX) };
	} catch (e) {
		return { ok: false, output: String(e instanceof Error ? e.message : e).slice(0, SELF_TEST_MAX) };
	}
}

/** One test the author declared, and the result of running it. */
export interface PluginTest {
	name: string;
	args: Record<string, unknown>;
	expect: string;
}

/** How a test reads once it has run: whether it passed, and what came back. */
export interface PluginTestResult {
	name: string;
	ok: boolean;
	output: string;
}

/** The JSON shape a test arrives in, and the caps that keep one honest. */
const TEST_MAX = 50;
const TEST_NAME_MAX = 120;
const TEST_ARG_MAX = 500;
const TEST_EXPECT_MAX = 500;

/** How many tests one plugin may bring; enough to prove a behaviour, not a novel. */
const TESTS_MAX = 20;

/**
 * Parse a plugin's `tests` column into real tests. A malformed column, or one
 * test that is not what the runner can run, is dropped rather than invented
 * for - the honest reading of a test the author did not really write is that
 * it does not exist.
 */
export function parsePluginTests(raw: string): PluginTest[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: PluginTest[] = [];
	for (const entry of parsed.slice(0, TESTS_MAX)) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const t = entry as { name?: unknown; args?: unknown; expect?: unknown };
		const name = typeof t.name === 'string' ? t.name.trim().slice(0, TEST_NAME_MAX) : '';
		if (!name) continue;
		const args =
			t.args && typeof t.args === 'object' && !Array.isArray(t.args) ? (t.args as Record<string, unknown>) : {};
		const expect = typeof t.expect === 'string' ? t.expect.slice(0, TEST_EXPECT_MAX) : String(t.expect ?? '');
		if (expect.length > TEST_EXPECT_MAX) continue;
		out.push({ name, args, expect });
		if (out.length >= TEST_MAX) break;
	}
	return out;
}

/** How much of one test's output the result keeps; the verdict quotes it. */
const TEST_OUTPUT_MAX = 300;

/**
 * Run a plugin's own unit tests, in the same sandbox harness the self-test
 * uses - the plugin's code runs inside the author's container, so the proof
 * is produced under the same conditions a real call would be.
 *
 * Each test is one harness run with the author's arguments; the result is
 * stringified and compared to what they said they expected. A mismatch is
 * the test's failure, not an error: the plugin ran, and answered something
 * other than what the author promised.
 *
 * Never throws. A plugin with no tests, or tests that could not be parsed,
 * is an empty result - that is itself a finding, and the police's brief
 * says so.
 */
export async function runPluginTests(
	plugin: Plugin,
	bot: { id: string; name: string }
): Promise<PluginTestResult[]> {
	const tests = parsePluginTests(plugin.tests);
	const results: PluginTestResult[] = [];
	for (const test of tests) {
		try {
			const result = await runPluginCode(plugin, bot, test.args);
			let out: string;
			if (typeof result === 'string') out = result;
			else if (result === undefined || result === null) out = '';
			else {
				try {
					out = JSON.stringify(result);
				} catch {
					out = String(result);
				}
			}
			out = out.trim();
			// An expected throw is a test too: expect starting with "error:" asks
			// for the code to refuse, so a clean run is the failure here.
			if (test.expect.startsWith('error:')) {
				results.push({ name: test.name, ok: false, output: out || 'the plugin produced no output' });
				continue;
			}
			results.push({ name: test.name, ok: out === test.expect, output: out.slice(0, TEST_OUTPUT_MAX) });
		} catch (e) {
			const why = String(e instanceof Error ? e.message : e).slice(0, TEST_OUTPUT_MAX);
			results.push({
				name: test.name,
				ok: test.expect.startsWith('error:') && why.length > 0,
				output: why
			});
		}
	}
	return results;
}

/** Enabled tool-kind plugins visible to the bot, as OpenAI function defs. */
export function pluginToolsFor(botId: string): ToolDef[] {
	try {
		return pluginsForBot(botId)
			.filter((p) => p.kind === 'tool' && p.effective_enabled === 1)
			.map((p) => {
				let parameters: Record<string, unknown> = { type: 'object', properties: {} };
				try {
					const parsed: unknown = JSON.parse(p.parameters || '{}');
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						parameters = parsed as Record<string, unknown>;
					}
				} catch {
					// Malformed schema falls back to an empty object schema.
				}
				return {
					type: 'function' as const,
					function: {
						name: `plugin_${slugify(p.name) || p.id}`,
						description: p.description,
						parameters
					}
				};
			});
	} catch {
		return [];
	}
}

/** Execute a tool plugin by its exposed `plugin_<slug>` name; never throws. */
export async function executePlugin(
	botId: string,
	name: string,
	argsJson: string
): Promise<string> {
	try {
		const slug = name.startsWith('plugin_') ? name.slice('plugin_'.length) : name;
		const plugin = pluginsForBot(botId).find(
			(p) => p.kind === 'tool' && p.effective_enabled === 1 && (slugify(p.name) || p.id) === slug
		);
		if (!plugin) return `error: unknown plugin ${name}`;
		let args: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(argsJson || '{}');
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				args = parsed as Record<string, unknown>;
			}
		} catch {
			return 'error: invalid plugin arguments';
		}
		const bot = getBot(botId);
		// The run shows up in the bot's activity feed the same way a shell
		// command does; the name alone is the detail - arguments can carry
		// secrets and the feed is not the place for them.
		logActivity(botId, 'plugin', `Running "${plugin.name}"`);
		const result = await runPluginCode(plugin, bot ?? { id: botId, name: '' }, args);
		if (typeof result === 'string') return result;
		if (result === undefined || result === null) return '';
		try {
			return JSON.stringify(result);
		} catch {
			return String(result);
		}
	} catch (e) {
		const msg =
			e instanceof Error
				? e.message
				: e !== null && typeof e === 'object' && 'message' in e
					? String(e.message)
					: 'plugin failed';
		return `error: ${msg}`;
	}
}

/**
 * Run a bot's `before_reply`/`after_reply` hooks over a message. Each hook gets
 * args = { message } and may return a replacement string; empty or non-string
 * returns leave the message unchanged. Never throws.
 *
 * `ok` is false when any hook failed, so the caller can decide whether a
 * partial rewrite is safe to keep - a message rewritten by only some of its
 * hooks is not a state anyone asked for.
 */
export async function runHooks(
	point: HookPoint,
	botId: string,
	payload: { message: string }
): Promise<{ message: string; ok: boolean }> {
	let message = payload.message;
	let ok = true;
	try {
		const hooks = pluginsForBot(botId).filter(
			(p) => p.kind === 'hook' && p.hook_point === point && p.effective_enabled === 1
		);
		const bot = getBot(botId) ?? { id: botId, name: '' };
		for (const hook of hooks) {
			try {
				const result = await runPluginCode(hook, bot, { message });
				if (typeof result === 'string' && result.length > 0) message = result;
			} catch (e) {
				// Leave the message unchanged, but say so: a hook that quietly
				// does nothing is indistinguishable from one that is not
				// installed, and that is how long a broken path went unnoticed.
				ok = false;
				const why = e instanceof Error ? e.message : String(e);
				console.error(`plugin "${hook.name}" failed at ${point}: ${why}`);
				logActivity(botId, 'error', `Plugin "${hook.name}" failed: ${why}`);
			}
		}
	} catch {
		// Fall through with the original message.
	}
	return { message, ok };
}
