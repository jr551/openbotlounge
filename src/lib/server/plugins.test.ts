import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot, listActivities } from './db';
import { machineExec, machineWriteFile } from './machine';
import {
	DEFAULT_ICON_SVG,
	createPlugin,
	deletePlugin,
	executePlugin,
	parseHarnessOutput,
	pluginToolsFor,
	pluginsForBot,
	runHooks,
	runPluginTests,
	sanitizeIconSvg,
	setPluginOverride,
	setPluginVerification,
	updatePlugin
} from './plugins';

vi.mock('./machine', () => ({
	machineExec: vi.fn(),
	machineWriteFile: vi.fn()
}));

let botId = '';
let bot2Id = '';
const createdPluginIds: string[] = [];

function makePlugin(over: {
	name: string;
	description?: string;
	kind?: 'tool' | 'hook';
	hook_point?: string;
	parameters?: string;
	code?: string;
	author_bot_id?: string;
	scope?: 'bot' | 'shared';
	enabled?: number;
}) {
	const plugin = createPlugin({
		name: over.name,
		description: over.description ?? '',
		kind: over.kind ?? 'tool',
		hook_point: over.hook_point ?? '',
		parameters: over.parameters ?? '{}',
		code: over.code ?? '',
		author_bot_id: over.author_bot_id ?? botId,
		scope: over.scope ?? 'bot',
		enabled: over.enabled ?? 1
	});
	createdPluginIds.push(plugin.id);
	return plugin;
}

function toolNames(id: string): string[] {
	return pluginToolsFor(id).map((t) => t.function.name);
}

beforeAll(() => {
	const b = createBot({
		name: 'PluginAuthor',
		persona: '',
		avatar: '🧩',
		color: '#fff',
		model: '',
		badge: ''
	});
	botId = b.id;
	const b2 = createBot({
		name: 'PluginConsumer',
		persona: '',
		avatar: '🦊',
		color: '#f00',
		model: '',
		badge: ''
	});
	bot2Id = b2.id;
});

afterAll(() => {
	for (const id of createdPluginIds) deletePlugin(id);
});

beforeEach(() => {
	vi.mocked(machineWriteFile).mockReset().mockResolvedValue(undefined);
	vi.mocked(machineExec).mockReset().mockResolvedValue('');
});

describe('pluginToolsFor', () => {
	it('shows a bot-scope plugin to its author bot only', () => {
		makePlugin({ name: 'Private Echo', scope: 'bot', author_bot_id: botId });
		expect(toolNames(botId)).toContain('plugin_private_echo');
		expect(toolNames(bot2Id)).not.toContain('plugin_private_echo');
	});

	it('shows a shared plugin to every bot', () => {
		makePlugin({ name: 'Shared Echo', scope: 'shared', author_bot_id: botId });
		expect(toolNames(botId)).toContain('plugin_shared_echo');
		expect(toolNames(bot2Id)).toContain('plugin_shared_echo');
	});

	it('excludes a disabled plugin', () => {
		makePlugin({ name: 'Off Tool', scope: 'bot', author_bot_id: botId, enabled: 0 });
		expect(toolNames(botId)).not.toContain('plugin_off_tool');
	});

	it('a per-bot override disables a shared plugin for that bot only', () => {
		const shared = makePlugin({
			name: 'Overridable',
			scope: 'shared',
			author_bot_id: botId
		});
		setPluginOverride(shared.id, bot2Id, false);

		expect(toolNames(botId)).toContain('plugin_overridable');
		expect(toolNames(bot2Id)).not.toContain('plugin_overridable');

		const forBot2 = pluginsForBot(bot2Id).find((p) => p.id === shared.id);
		const forBot1 = pluginsForBot(botId).find((p) => p.id === shared.id);
		expect(forBot2?.effective_enabled).toBe(0);
		expect(forBot1?.effective_enabled).toBe(1);
	});
});

describe('tool naming', () => {
	it('slugifies the plugin name into the tool name', () => {
		makePlugin({ name: 'My Tool!', scope: 'bot', author_bot_id: botId });
		expect(toolNames(botId)).toContain('plugin_my_tool');
	});
});

describe('the police sign-off on a plugin', () => {
	it('reads back through pluginsForBot, which is what the console shows', () => {
		const plugin = makePlugin({ name: 'Signed Off', scope: 'bot', author_bot_id: botId });
		// A plugin written before the gate existed reads as never reviewed.
		expect(plugin.verification).toBe('');
		setPluginVerification(
			plugin.id,
			JSON.stringify({ verdict: 'rejected', reason: 'the code is a stub', at: 1 })
		);
		const stored = pluginsForBot(botId).find((p) => p.id === plugin.id);
		expect(JSON.parse(stored!.verification)).toEqual({
			verdict: 'rejected',
			reason: 'the code is a stub',
			at: 1
		});
	});
});

describe('a police refusal against a per-bot override', () => {
	/**
	 * An override row written while the plugin was approved used to win through
	 * COALESCE, so refused code kept running for that bot - and give_plugin
	 * could hand it on as though it were live. The refusal has to outrank the
	 * preference, for every reader of effective_enabled.
	 */
	it('holds the plugin off for every bot until the human overrules the refusal', () => {
		const shared = makePlugin({ name: 'Refused Override', scope: 'shared', author_bot_id: botId });
		setPluginOverride(shared.id, botId, true);
		setPluginOverride(shared.id, bot2Id, false);
		expect(toolNames(botId)).toContain('plugin_refused_override');

		setPluginVerification(
			shared.id,
			JSON.stringify({
				verdict: 'rejected',
				reason: 'it forwards every message to another site',
				at: 1,
				attempts: 3,
				awaitingHuman: true
			})
		);

		// No bot runs it, whatever its own override says.
		expect(pluginsForBot(botId).find((p) => p.id === shared.id)?.effective_enabled).toBe(0);
		expect(pluginsForBot(bot2Id).find((p) => p.id === shared.id)?.effective_enabled).toBe(0);
		expect(toolNames(botId)).not.toContain('plugin_refused_override');

		// The human's approval lifts the hold, and each bot's own preference is
		// back with it: the one that had it on, on; the one that had it off, off.
		setPluginVerification(
			shared.id,
			JSON.stringify({ verdict: 'approved', reason: 'approved by the human', at: 2, by: 'human' })
		);
		expect(pluginsForBot(botId).find((p) => p.id === shared.id)?.effective_enabled).toBe(1);
		expect(pluginsForBot(bot2Id).find((p) => p.id === shared.id)?.effective_enabled).toBe(0);
	});
});

describe('executePlugin', () => {
	it('returns an error string for an unknown plugin name', async () => {
		const result = await executePlugin(botId, 'plugin_does_not_exist', '{}');
		expect(result).toMatch(/^error: /);
	});

	it('returns an error string when args JSON fails to parse', async () => {
		makePlugin({ name: 'Argful', scope: 'bot', author_bot_id: botId, code: 'return "ok"' });
		const result = await executePlugin(botId, 'plugin_argful', '{not json');
		expect(result).toMatch(/^error: /);
	});

	it('logs the run as a plugin activity so the feed and the working glyph see it', async () => {
		makePlugin({ name: 'Logged', scope: 'bot', author_bot_id: botId, code: 'return "ok"' });
		await executePlugin(botId, 'plugin_logged', '{}');
		const acts = listActivities(botId).filter((a) => a.kind === 'plugin');
		expect(acts.map((a) => a.detail)).toContain('Running "Logged"');
	});

	it('does not log an activity for a plugin that never ran', async () => {
		const before = listActivities(botId).filter((a) => a.kind === 'plugin').length;
		await executePlugin(botId, 'plugin_never_existed', '{}');
		expect(listActivities(botId).filter((a) => a.kind === 'plugin')).toHaveLength(before);
	});
});

describe('parseHarnessOutput', () => {
	// Plugin code runs in the bot's container, so its result and its errors
	// travel back through the shell as marked lines. Getting this wrong loses
	// results or hides failures, so it is pinned here.
	it('returns the plugin result', () => {
		expect(parseHarnessOutput('noise\n__OBL_OK__"hello"\nmore')).toBe('hello');
	});

	it('treats an empty or null result as an empty string', () => {
		expect(parseHarnessOutput('__OBL_OK__""')).toBe('');
	});

	it('decodes a non-string result as its own type, not a string', () => {
		// A hook returning a number must not come back as "123" - runHooks would
		// otherwise treat it as a replacement message.
		expect(parseHarnessOutput('__OBL_OK__123')).toBe(123);
		expect(parseHarnessOutput('__OBL_OK__{"a":1}')).toEqual({ a: 1 });
	});

	it("throws the plugin's own error", () => {
		expect(() => parseHarnessOutput('__OBL_ERR__kaboom')).toThrow('kaboom');
	});

	it('throws when the payload is unreadable', () => {
		expect(() => parseHarnessOutput('__OBL_OK__{not json')).toThrow(/unreadable/);
	});

	it('throws when the harness never reported', () => {
		expect(() => parseHarnessOutput('node: command not found')).toThrow(/command not found/);
	});
});

describe('plugin staging', () => {
	/**
	 * Run the staged harness the way the container would: whatever code was
	 * written through the file API is piped to `node`, and its stdout comes
	 * back as the exec result.
	 */
	function execStagedHarness() {
		vi.mocked(machineExec).mockImplementation(async () => {
			// The newest staging, not the first: a test that runs several harnesses
			// would otherwise keep answering with the arguments of the first one.
			const calls = vi.mocked(machineWriteFile).mock.calls;
			const staged = calls[calls.length - 1]?.[2] ?? '';
			return execFileSync(process.execPath, ['-e', staged], {
				encoding: 'utf8'
			});
		});
	}

	it('stages the harness as a file inside the machine', async () => {
		makePlugin({ name: 'Staged', scope: 'bot', author_bot_id: botId, code: 'return "ok"' });
		await executePlugin(botId, 'plugin_staged', '{}');
		// The harness is written into the container, then run with node.
		const [id, path, content] = vi.mocked(machineWriteFile).mock.calls[0] as [string, string, string];
		expect(id).toBe(botId);
		expect(path).toContain('/tmp/obl-plugin-');
		expect(content).toContain('__OBL_OK__');
		expect(vi.mocked(machineExec).mock.calls[0]?.[1]).toContain('node /tmp/obl-plugin-');
	});

	it('keeps a non-string hook result as its own type instead of replacing the message', async () => {
		makePlugin({
			name: 'Numeric Hook',
			kind: 'hook',
			hook_point: 'after_reply',
			scope: 'bot',
			author_bot_id: botId,
			code: 'return 123'
		});
		execStagedHarness();
		// The harness used to String() every return, so this hook came back as
		// "123" and clobbered the message. A non-string return must leave it alone.
		await expect(runHooks('after_reply', botId, { message: 'keep' })).resolves.toEqual({ message: 'keep', ok: true });
	});

	it('returns an object plugin result as JSON, not "[object Object]"', async () => {
		makePlugin({ name: 'Obj Tool', scope: 'bot', author_bot_id: botId, code: 'return { a: 1 }' });
		execStagedHarness();
		await expect(executePlugin(botId, 'plugin_obj_tool', '{}')).resolves.toBe('{"a":1}');
	});

	it('decodes an empty or null plugin result as an empty string', async () => {
		makePlugin({ name: 'Null Tool', scope: 'bot', author_bot_id: botId, code: 'return null' });
		execStagedHarness();
		await expect(executePlugin(botId, 'plugin_null_tool', '{}')).resolves.toBe('');
	});

	it('runs the author\'s own tests against the real code, pass and fail', async () => {
		const plugin = makePlugin({
			name: 'Bilingual',
			scope: 'bot',
			author_bot_id: botId,
			parameters: '{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}',
			code: 'return "hi " + args.word'
		});
		updatePlugin(plugin.id, {
			tests: JSON.stringify([
				{ name: 'greets', args: { word: 'bob' }, expect: 'hi bob' },
				{ name: 'shouts', args: { word: 'BOB' }, expect: 'HI BOB' }
			])
		});
		execStagedHarness();
		const results = await runPluginTests(pluginsForBot(botId).find((p) => p.id === plugin.id)!, {
			id: botId,
			name: 'PluginAuthor'
		});
		expect(results).toEqual([
			{ name: 'greets', ok: true, output: 'hi bob' },
			{ name: 'shouts', ok: false, output: 'hi BOB' }
		]);
	});

	it('passes a test that asks for a refusal, and fails one that got a clean run', async () => {
		const plugin = makePlugin({
			name: 'Picky',
			scope: 'bot',
			author_bot_id: botId,
			code: 'if (!args.word) throw new Error("word required"); return "hi " + args.word'
		});
		updatePlugin(plugin.id, {
			tests: JSON.stringify([
				{ name: 'refuses an empty word', args: {}, expect: 'error:' },
				{ name: 'refuses a real word too', args: { word: 'bob' }, expect: 'error:' }
			])
		});
		execStagedHarness();
		const results = await runPluginTests(pluginsForBot(botId).find((p) => p.id === plugin.id)!, {
			id: botId,
			name: 'PluginAuthor'
		});
		// The throw is the pass: expect "error:" asks for the code to refuse.
		expect(results[0]).toMatchObject({ name: 'refuses an empty word', ok: true });
		// A clean run against an expected refusal is the failure.
		expect(results[1]).toMatchObject({ name: 'refuses a real word too', ok: false, output: 'hi bob' });
	});

	it('reports nothing for a plugin that brought no tests, or a malformed column', async () => {
		const plugin = makePlugin({ name: 'Untested', scope: 'bot', author_bot_id: botId, code: 'return "ok"' });
		updatePlugin(plugin.id, { tests: 'not json at all' });
		await expect(
			runPluginTests(pluginsForBot(botId).find((p) => p.id === plugin.id)!, {
				id: botId,
				name: 'PluginAuthor'
			})
		).resolves.toEqual([]);
		// Nothing was run, so nothing was staged: the container is untouched.
		expect(vi.mocked(machineWriteFile)).not.toHaveBeenCalled();
	});
});

describe('sanitizeIconSvg', () => {
	it('rejects <style>, which applies to the whole document rather than the badge', () => {
		for (const payload of [
			'<svg viewBox="0 0 24 24"><style>body{background:black}</style></svg>',
			'<svg viewBox="0 0 24 24"><STYLE>@import url("//evil/a");</STYLE></svg>',
			'<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="image-set(\'//evil/a\')"/></svg>',
			'<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="-webkit-image-set(\'//evil/a\')"/></svg>',
			'<svg viewBox="0 0 24 24"><rect width="24" height="24" style="background:url(#a),image-set(\'//evil/a\')"/></svg>'
		]) {
			expect(sanitizeIconSvg(payload), payload).toBeNull();
		}
	});

	it('refuses an event handler however the attribute is delimited', () => {
		// The tokenizer reads `/onload=` and `"onload=` as attributes just as it
		// reads ` onload=`; a guard that only looked for whitespace let the first
		// two through, and a stored icon then ran script in the page.
		for (const payload of [
			'<svg viewBox="0 0 24 24" onload="alert(1)"></svg>',
			'<svg viewBox="0 0 24 24"/onload="alert(1)"></svg>',
			'<svg viewBox="0 0 24 24"onload="alert(1)"></svg>',
			'<svg viewBox="0 0 24 24"><animate attributeName="x" dur="1s"/onbegin="alert(1)"></animate></svg>',
			'<svg viewBox="0 0 24 24"><animate attributeName="x" dur="1s"onbegin="alert(1)"></animate></svg>',
			'<svg viewBox="0 0 24 24"><set attributeName="x" to="1"/onbegin="alert(1)"></set></svg>'
		]) {
			expect(sanitizeIconSvg(payload), payload).toBeNull();
		}
	});

	it('keeps accepting the default icon, which animates with SMIL', () => {
		expect(sanitizeIconSvg(DEFAULT_ICON_SVG)).toBe(DEFAULT_ICON_SVG);
	});

	it('accepts an animated icon and still refuses one carrying a script', () => {
		expect(
			sanitizeIconSvg(
				'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6">' +
					'<animate attributeName="r" values="4;8;4" dur="1.5s" repeatCount="indefinite"/>' +
					'<animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="4s" repeatCount="indefinite"/>' +
					'</circle></svg>'
			)
		).not.toBeNull();
		expect(
			sanitizeIconSvg(
				'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/>' +
					'<script>alert(1)</script></svg>'
			)
		).toBeNull();
		expect(
			sanitizeIconSvg(
				'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" onload="alert(1)"/></svg>'
			)
		).toBeNull();
	});
});

describe('runHooks', () => {
	it('skips disabled hooks and leaves the message unchanged', async () => {
		makePlugin({
			name: 'Hook Disabled',
			kind: 'hook',
			hook_point: 'after_reply',
			scope: 'bot',
			author_bot_id: botId,
			enabled: 0,
			code: 'return "changed"'
		});
		// The disabled hook must not run; `ok` is not asserted because other
		// hooks left registered by earlier tests also feed into it.
		const r = await runHooks('after_reply', botId, { message: 'keep' });
		expect(r.message).toBe('keep');
	});
});
