import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from './db';
import { machineExec, machineWriteFile } from './machine';
import { createPlugin, deletePlugin, selfTestPlugin } from './plugins';

vi.mock('./machine', () => ({
	machineExec: vi.fn(),
	machineWriteFile: vi.fn()
}));

// Every case here forks a real `node` to run the plugin's own code, which is
// seconds of work on a loaded machine rather than the milliseconds a stub
// costs. The default 5s budget is for tests that never leave this process.
const NODE_RUN_MS = 30_000;

let botId = '';
const createdPluginIds: string[] = [];

function makePlugin(over: {
	name: string;
	kind?: 'tool' | 'hook';
	hook_point?: string;
	parameters?: string;
	code: string;
}) {
	const plugin = createPlugin({
		name: over.name,
		description: '',
		kind: over.kind ?? 'tool',
		hook_point: over.hook_point ?? '',
		parameters: over.parameters ?? '{}',
		code: over.code,
		author_bot_id: botId,
		scope: 'bot',
		enabled: 1
	});
	createdPluginIds.push(plugin.id);
	return plugin;
}

/**
 * Run the staged harness the way the container would: whatever the plugin run
 * wrote through the file API is handed to a real `node`, and its stdout comes
 * back as the exec result.
 *
 * The plugin's own code really executes here. That is the whole point of these
 * tests: the self-test's job is to report what a run actually did, so a stubbed
 * reply from the machine would prove nothing about it.
 */
function runStagedHarness(): void {
	vi.mocked(machineExec).mockImplementation(async () => {
		const staged = vi.mocked(machineWriteFile).mock.calls.at(-1)?.[2] ?? '';
		return execFileSync(process.execPath, ['-e', staged], { encoding: 'utf8' });
	});
}

beforeAll(() => {
	botId = createBot({
		name: 'SelfTester',
		persona: '',
		avatar: '🧪',
		color: '#fff',
		model: '',
		badge: ''
	}).id;
});

afterAll(() => {
	for (const id of createdPluginIds) deletePlugin(id);
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(machineWriteFile).mockResolvedValue(undefined);
	runStagedHarness();
});

describe('selfTestPlugin', () => {
	it(
		'runs the code and reports what it produced',
		async () => {
			const plugin = makePlugin({ name: 'Greeter', code: 'return "hello from the plugin"' });

			await expect(selfTestPlugin(plugin)).resolves.toEqual({
				ok: true,
				output: 'hello from the plugin'
			});
		},
		NODE_RUN_MS
	);

	it(
		"reports a throwing plugin as failed, with the plugin's own error text",
		async () => {
			const plugin = makePlugin({
				name: 'Boom',
				code: 'throw new Error("kaboom: the flux capacitor is dry")'
			});

			const out = await selfTestPlugin(plugin);

			expect(out.ok).toBe(false);
			// The exact message, not a wrapper around it: the creator reads this
			// to find their bug, so a generic "the plugin failed" would be useless.
			expect(out.output).toBe('kaboom: the flux capacitor is dry');
		},
		NODE_RUN_MS
	);

	it(
		'clips a long result to 300 characters',
		async () => {
			const plugin = makePlugin({ name: 'Windbag', code: 'return "x".repeat(400)' });

			const out = await selfTestPlugin(plugin);

			expect(out.ok).toBe(true);
			// The reply carries the output inline, so one plugin that returns a
			// megabyte must not drag a megabyte into the tool result.
			expect(out.output).toBe('x'.repeat(300));
		},
		NODE_RUN_MS
	);

	it(
		'hands the code one dummy per required field, typed by the schema',
		async () => {
			// The code echoes the arguments it was actually handed. A schema the
			// runner misreads shows up here as the wrong value inside the output -
			// which is the one thing a mocked machine could never prove, because
			// the values only reach this assertion by really reaching the code.
			const plugin = makePlugin({
				name: 'Argful',
				parameters: JSON.stringify({
					type: 'object',
					properties: {
						n: { type: 'number' },
						flag: { type: 'boolean' },
						label: { type: 'string' },
						list: { type: 'array' },
						obj: { type: 'object' },
						mystery: {}
					},
					required: ['n', 'flag', 'label', 'list', 'obj', 'mystery']
				}),
				code: 'return JSON.stringify(args)'
			});

			const out = await selfTestPlugin(plugin);

			expect(out.ok).toBe(true);
			expect(JSON.parse(out.output)).toEqual({
				n: 1,
				flag: true,
				label: 'test',
				list: [],
				obj: {},
				// A field with no usable type still has to be given something: an
				// undefined arg would make a well-written plugin fail its own test.
				mystery: 'test'
			});
		},
		NODE_RUN_MS
	);

	it(
		'a schema type that only exists on the prototype still yields a string',
		async () => {
			// `type in DUMMY_BY_TYPE` walks the prototype chain, so a schema
			// declaring "type":"toString" found Object.prototype.toString and
			// handed the code a function - which JSON.stringify then dropped,
			// so the required argument arrived missing instead of as the string
			// the doc comment promises. Own-property lookup is the fix.
			const plugin = makePlugin({
				name: 'Prototype Type',
				parameters: JSON.stringify({
					type: 'object',
					properties: { k: { type: 'toString' }, other: { type: 'valueOf' } },
					required: ['k', 'other']
				}),
				code: 'return JSON.stringify(args)'
			});

			const out = await selfTestPlugin(plugin);

			expect(out.ok).toBe(true);
			expect(JSON.parse(out.output)).toEqual({ k: 'test', other: 'test' });
		},
		NODE_RUN_MS
	);

	it(
		'leaves an optional field out, so the run does not depend on it',
		async () => {
			const plugin = makePlugin({
				name: 'Optional Arg',
				parameters: JSON.stringify({
					type: 'object',
					properties: { name: { type: 'string' }, note: { type: 'string' } },
					required: ['name']
				}),
				code: 'return JSON.stringify(args)'
			});

			const out = await selfTestPlugin(plugin);

			expect(out.ok).toBe(true);
			// Only the required field: inventing a value for every property would
			// make the self-test a run no real caller could ever repeat.
			expect(JSON.parse(out.output)).toEqual({ name: 'test' });
		},
		NODE_RUN_MS
	);

	it(
		'gives a hook the message it reads, whatever its schema says',
		async () => {
			const plugin = makePlugin({
				name: 'Echo Hook',
				kind: 'hook',
				hook_point: 'after_reply',
				parameters: JSON.stringify({
					type: 'object',
					properties: { name: { type: 'string' } },
					required: ['name']
				}),
				code: 'return args.message'
			});

			// A hook is handed args.message, not its schema fields: testing it
			// with schema args would exercise a shape it never sees in a turn.
			await expect(selfTestPlugin(plugin)).resolves.toEqual({
				ok: true,
				output: 'self-test message'
			});
		},
		NODE_RUN_MS
	);
});
