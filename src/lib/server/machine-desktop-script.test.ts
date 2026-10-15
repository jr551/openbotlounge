import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The Docker socket is faked: every dockerRequest lands in `fakeDocker`, which
// answers from `containers` the way the daemon would. The exec endpoints are
// stubbed to a fixed output; this file only ever wants one thing out of the
// whole dance - the setup script the module writes into the machine - and then
// runs that script for real, which is the one thing the fake cannot do.
const { fakeDocker, execCalls, containers, networks, flags, execResult } = vi.hoisted(() => {
	const containers: Record<string, unknown>[] = [];
	const networks: { Name: string; Id: string }[] = [];
	const execCalls: { cmd: string[] }[] = [];
	// The stage file the probe reads back, as the script left it. It is held as
	// a string rather than read from disk because this factory is hoisted above
	// the imports; the test reads the file the script really wrote and hands
	// the text over.
	const flags = { stageText: '' };
	let seq = 0;
	/** `tail -n 3`, which is the slice of the stage file the probe asks for. */
	const tail3 = (text: string) => {
		const lines = text.split('\n');
		while (lines.length && lines[lines.length - 1] === '') lines.pop();
		return lines.slice(-3).map((l) => `${l}\n`).join('');
	};
	const execResult = (cmd: string[]) => {
		const joined = cmd.join(' ');
		// The status probe: its own one-word answer, the splitter, then the
		// stage markers. Exactly the shape desktopProbe parses. The state is
		// 'starting' because the script is, by construction, mid-run: a probe
		// that said otherwise would change the state, not the markers, and the
		// markers are what this file is about.
		if (joined.includes('__OBL_PROBE__')) {
			return { output: `starting\n__OBL_PROBE__\n${tail3(flags.stageText)}`, exitCode: 0 };
		}
		if (joined.includes('command -v tmux')) return { output: '/usr/bin/tmux', exitCode: 0 };
		// The proxy-capable netcat check: 0 means the drop-in is already usable.
		if (joined.includes('-X connect')) return { output: '', exitCode: 0 };
		if (joined.includes('npm install')) return { output: '', exitCode: 0 };
		// `test -d /opt/pw/node_modules/playwright || test -f /opt/pw/.nodriver`:
		// 1 means the driver is not installed yet, which is the fresh-container
		// path. It comes after the npm check because both name that directory.
		if (joined.includes('.nodriver')) return { output: '', exitCode: 1 };
		if (joined.includes('OBL_KEY_INSTALLED')) return { output: 'OBL_KEY_INSTALLED', exitCode: 0 };
		return { output: '', exitCode: 0 };
	};
	const fakeDocker = async (method: string, path: string, body?: unknown) => {
		const create = path.match(/^\/containers\/create\?name=(.+)$/);
		if (method === 'POST' && create) {
			const spec = body as {
				Labels?: Record<string, string>;
				HostConfig?: { NetworkMode?: string };
			};
			const net = spec.HostConfig?.NetworkMode ?? '';
			const c = {
				Id: `id${++seq}`,
				Names: [`/${decodeURIComponent(create[1])}`],
				State: 'created',
				Labels: spec.Labels ?? {},
				Network: net,
				NetworkID: net ? `net-${net}` : ''
			};
			containers.push(c);
			return { status: 201, body: Buffer.from(JSON.stringify({ Id: c.Id })) };
		}
		if (method === 'POST' && path === '/networks/create') {
			const name = (body as { Name?: string } | undefined)?.Name ?? '';
			if (!networks.some((n) => n.Name === name)) networks.push({ Name: name, Id: `net-${name}` });
			return { status: 201, body: Buffer.from('{}') };
		}
		if (method === 'GET' && path === '/networks') {
			return { status: 200, body: Buffer.from(JSON.stringify(networks)) };
		}
		const netOp = path.match(/^\/networks\/([^/]+)\/(connect|disconnect)$/);
		if (method === 'POST' && netOp) {
			const spec = body as { Container?: string } | undefined;
			const c = containers.find((x) => x.Id === spec?.Container || (x.Names as string[]).includes(`/${spec?.Container}`));
			if (c) {
				if (netOp[2] === 'connect') {
					c.Network = decodeURIComponent(netOp[1]);
					c.NetworkID = `net-${c.Network}`;
				} else {
					c.NetworkID = '';
				}
			}
			return { status: 200, body: Buffer.from('{}') };
		}
		const inspect = path.match(/^\/containers\/([^/?]+)\/json$/);
		if (method === 'GET' && inspect) {
			const c = containers.find((x) => x.Id === inspect[1]);
			// The app's own container is not one of ours, so selfImage falls back
			// to the machine image rather than resolving the host's id.
			if (!c) return { status: 404, body: Buffer.from('no such container') };
			const net = (c.Network as string) ?? '';
			const ep = (c.NetworkID as string) ?? '';
			return {
				status: 200,
				body: Buffer.from(
					JSON.stringify({
						Id: c.Id,
						// Init true, or ensureMachine reads the container as one
						// built before the reaper and rebuilds it every wake.
						HostConfig: { Init: true },
						State: { Running: c.State === 'running', StartedAt: '2026-01-01T00:00:00Z' },
						NetworkSettings: { Networks: net && ep ? { [net]: { NetworkID: ep } } : {} }
					})
				)
			};
		}
		const action = path.match(/^\/containers\/([^/]+)\/(start|stop)$/);
		if (method === 'POST' && action) {
			const c = containers.find((x) => x.Id === action[1]);
			if (!c) return { status: 404, body: Buffer.from('no such container') };
			c.State = action[2] === 'start' ? 'running' : 'exited';
			return { status: 204, body: Buffer.alloc(0) };
		}
		if (method === 'DELETE' && path.startsWith('/containers/')) {
			const id = path.slice('/containers/'.length).split('?')[0];
			const i = containers.findIndex((x) => x.Id === id);
			if (i >= 0) containers.splice(i, 1);
			return { status: 204, body: Buffer.alloc(0) };
		}
		if (method === 'GET' && path.startsWith('/containers/json')) {
			let filters: { name?: string[] } = {};
			try {
				filters = JSON.parse(new URLSearchParams(path.split('?')[1] ?? '').get('filters') ?? '{}');
			} catch {
				filters = {};
			}
			const names = filters.name ?? [];
			const list = containers.filter(
				(c) => !names.length || names.some((n) => (c.Names as string[]).some((cn) => cn.includes(n)))
			);
			return { status: 200, body: Buffer.from(JSON.stringify(list)) };
		}
		return { status: 200, body: Buffer.from('{}') };
	};
	return { fakeDocker, execCalls, containers, networks, flags, execResult };
});

vi.mock('./docker', async (importOriginal) => {
	const real = await importOriginal<typeof import('./docker')>();
	return {
		...real,
		dockerRequest: vi.fn(fakeDocker),
		// dockerExec and friends are module-internal to docker.ts, so stubbing
		// dockerRequest alone would leave them talking to the real socket.
		dockerExec: vi.fn(async (_c: string, cmd: string[]) => {
			execCalls.push({ cmd });
			return execResult(cmd);
		}),
		dockerExecDetached: vi.fn(async (_c: string, cmd: string[]) => {
			execCalls.push({ cmd });
		}),
		containerNetwork: vi.fn(async (id: string) => {
			const c = containers.find((x) => x.Id === id);
			return c && c.NetworkID ? ((c.Network as string) ?? '') : '';
		}),
		// The audit watcher and the shared drives have no docker here.
		ensureAuditWatcher: vi.fn(async () => {}),
		dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
	};
});
import { createBot, deleteBot } from './db';
import { ensureDesktop, machineStatus } from './machine';

/**
 * The shell the script is run under.
 *
 * `dash` is a strict POSIX shell and the nearest available relative of the
 * busybox ash the machine itself has; /bin/sh (bash in POSIX mode here) is the
 * fallback. Either way what runs is the text the container runs, under a shell
 * that is not bash-only - which is the point: nothing else in this repo proves
 * the generated script parses.
 */
const SH = existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';

/** Where the app's own node lives, so `node --check` is the real thing. */
const NODE_BIN = dirname(process.execPath);

/**
 * How long a test that runs the WHOLE generated script may take. Six phases
 * through real `sh`, each spawning stub processes, is well over the 5s default
 * on a loaded machine - and a timeout there is indistinguishable from a broken
 * script, which is the one thing these tests exist to detect.
 */
const SCRIPT_RUN_MS = 30_000;

/** One stubbed command: what it prints, and what it exits with. */
interface Fake {
	status?: number;
	/** Lines printed before exiting. Fixed literals: they go into the stub raw. */
	says?: string[];
}

/**
 * Every command the desktop script would really run, stubbed into `bin`.
 *
 * The script's phases install packages, start an X server, a window manager, a
 * browser and a websocket bridge - none of which a test may do, and none of
 * which the script's own contract depends on. What it depends on is what each
 * phase *reports*: the stage marker it writes as it starts and the failure
 * marker it writes when it exits non-zero. The stubs are what make those
 * outcomes controllable, one test at a time.
 */
async function writeStubs(bin: string, overrides: Record<string, Fake> = {}): Promise<void> {
	const names = [
		'apk',
		'Xvnc',
		'xdpyinfo',
		'websockify',
		'nc',
		'chromium',
		'openbox-session',
		'tint2',
		'xterm',
		'xsetroot',
		'xrdb',
		'display'
	];
	for (const name of names) {
		const fake = overrides[name] ?? {};
		const lines = ['#!/bin/sh'];
		for (const said of fake.says ?? []) lines.push(`printf '%s\\n' ${JSON.stringify(said)}`);
		lines.push(`exit ${fake.status ?? 0}`);
		const path = join(bin, name);
		await writeFile(path, lines.join('\n') + '\n');
		await chmod(path, 0o755);
	}
}

/** A private stand-in for the machine's /tmp, plus the stub PATH it runs with. */
interface Sandbox {
	dir: string;
	bin: string;
	stagePath: string;
	logPath: string;
	readyPath: string;
}

/** Every sandbox a test made, so the file can clean up after itself. */
const sandboxes: Sandbox[] = [];

async function newSandbox(overrides: Record<string, Fake> = {}): Promise<Sandbox> {
	const dir = await mkdtemp(join(tmpdir(), 'obl-desktop-script-'));
	const bin = join(dir, 'bin');
	await mkdir(bin);
	await writeStubs(bin, overrides);
	const sb: Sandbox = {
		dir,
		bin,
		stagePath: join(dir, 'obl-stage'),
		logPath: join(dir, 'obl-desktop.log'),
		readyPath: join(dir, 'obl-desktop-ready')
	};
	sandboxes.push(sb);
	return sb;
}

/**
 * The script writes to `/tmp/...` because that is a path inside the machine's
 * container. On this host /tmp is the developer's own scratch space: running
 * the script unrewritten would clobber it, and two runs of this file (or a
 * sibling test) would read each other's markers out of the fixed names.
 * Rewriting the prefix into a private directory is the whole sandbox - every
 * path the script names is data, and not one line of the shell changes.
 */
const rewrite = (script: string, dir: string): string => script.split('/tmp/').join(`${dir}/`);

function runIn(sb: Sandbox, file: string, args: string[]) {
	return spawnSync(SH, [file, ...args], {
		cwd: sb.dir,
		env: { PATH: `${sb.bin}:${NODE_BIN}:/usr/bin:/bin`, HOME: sb.dir },
		encoding: 'utf8',
		// A phase that wedged in a real wait loop would otherwise hold the file
		// for its full 40 x 0.5s; failing loudly is better than hanging.
		timeout: 30_000
	});
}

/** Run the generated setup script itself, under the shell the machine uses. */
async function runScript(script: string, overrides: Record<string, Fake> = {}) {
	const sb = await newSandbox(overrides);
	const path = join(sb.dir, 'obl-desktop.sh');
	await writeFile(path, rewrite(script, sb.dir));
	const res = runIn(sb, path, []);
	return {
		...sb,
		status: res.status,
		stdout: res.stdout ?? '',
		stderr: res.stderr ?? '',
		stage: await readFile(sb.stagePath, 'utf8').catch(() => '')
	};
}

/**
 * Drive `run_stage` directly, with phase bodies this file chooses.
 *
 * The helper is lifted out of the generated script by substring - never
 * retyped - so what runs is the text the machine runs. Its preamble comes along
 * whole, which is what puts the `exec >$DESKTOP_LOG` redirect and the stage
 * file's own `rm -f` in place exactly as the real run has them.
 *
 * This exists because the generated phases cannot all fail the way a test needs
 * them to: only the first one can be made to fail silently (a missing `apk`),
 * and the offset arithmetic that keeps a silent phase from inheriting the
 * previous phase's last line is invisible to a run that dies at phase one.
 */
async function runStage(script: string, calls: string[], overrides: Record<string, Fake> = {}) {
	const sb = await newSandbox(overrides);
	const lifted = rewrite(script, sb.dir);
	const at = lifted.indexOf('run_stage() {');
	const end = lifted.indexOf('\n}\n', at);
	if (at < 0 || end < 0) throw new Error('the generated script no longer defines run_stage');
	const harness = join(sb.dir, 'harness.sh');
	await writeFile(harness, `${lifted.slice(0, end + 3)}\n${calls.join('\n')}\n`);
	const res = runIn(sb, harness, []);
	return {
		...sb,
		status: res.status,
		stage: await readFile(sb.stagePath, 'utf8').catch(() => ''),
		log: await readFile(sb.logPath, 'utf8').catch(() => '')
	};
}

/** The reason a failure marker carries, or null when there is no marker. */
const failReason = (stage: string): string | null => stage.match(/__OBL_STAGE_FAIL:\d+:[^:]*:(.*?)__/)?.[1] ?? null;

let botId = '';
/** The setup script the module wrote into the machine, decoded. */
let script = '';

beforeAll(async () => {
	const bot = createBot({
		name: `ScriptBot${Date.now()}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
	botId = bot.id;
	await ensureDesktop(botId);
	// machineWriteFile sends the content base64 inside one exec; that exec is
	// the only way to the module-private desktopScript, so the script is read
	// back out of it exactly as the machine would receive it.
	const write = execCalls
		.map((e) => e.cmd.join(' '))
		.find((c) => c.includes('base64 -d > /tmp/obl-desktop.sh'));
	if (!write) throw new Error('ensureDesktop never wrote /tmp/obl-desktop.sh');
	const b64 = write.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/);
	if (!b64) throw new Error(`could not read the script out of the write exec: ${write.slice(0, 120)}`);
	script = Buffer.from(b64[1], 'base64').toString('utf8');
});

afterAll(() => {
	if (botId) deleteBot(botId);
});

beforeEach(() => {
	flags.stageText = '';
});

afterEach(async () => {
	for (const sb of sandboxes.splice(0)) await rm(sb.dir, { recursive: true, force: true });
});

describe('the generated desktop setup script', () => {
	it('runs every phase to completion under a POSIX shell, marking each as it starts', async () => {
		const run = await runScript(script);
		// The script's shell is only proven valid by running it: the phases are
		// multi-line bodies, heredocs and subshells, and a syntax error in any of
		// them would take the whole desktop down before a marker was ever written.
		expect(run.status).toBe(0);
		expect(run.stage.split('\n').filter(Boolean)).toEqual([
			'__OBL_STAGE_1:packages__',
			'__OBL_STAGE_2:xvnc__',
			'__OBL_STAGE_3:openbox__',
			'__OBL_STAGE_4:chromium__',
			'__OBL_STAGE_5:websockify__',
			'__OBL_STAGE_6:cdp__'
		]);
		// Nothing failed, so nothing claims it did - the watcher treats a FAIL
		// marker as the end of the run and would stop narrating a healthy one.
		expect(run.stage).not.toContain('__OBL_STAGE_FAIL');
		// The sentinel the script touches last is what says the run finished.
		await expect(readFile(run.readyPath, 'utf8')).resolves.toBe('');
		// Everything the script and its phases print goes to the log file, not
		// to stdout: the script runs detached through the Docker API, so a phase
		// that wrote to stdout would take its own error message with it - and
		// the failure marker has nothing else to quote.
		expect(run.stdout).toBe('');
		expect(run.stderr).toBe('');
		// Running the whole script means six real phases through real `sh`; under
		// a loaded suite that comfortably outruns the 5s default, and a timing
		// failure here would read as a broken script.
	}, SCRIPT_RUN_MS);

	it('carries the failing phase\'s own last printed line into the marker and stops there', async () => {
		const run = await runScript(script, {
			apk: {
				status: 1,
				says: ['resolving dependencies...', 'ERROR: unable to select packages: tigervnc (no such package)']
			}
		});
		// The phase's status is the script's: run_stage exits with it.
		expect(run.status).toBe(1);
		expect(run.stage).toContain('__OBL_STAGE_1:packages__');
		// The marker is the terminal one - no later phase ran, so none is named.
		expect(run.stage).not.toContain('__OBL_STAGE_2:');
		// The last line, not the first: a phase that printed several says what
		// it died on, and the reason may carry colons of its own - which is why
		// the label group in the parser's regex excludes them and the reason's
		// does not.
		expect(run.stage).toContain(
			'__OBL_STAGE_FAIL:1:packages:ERROR: unable to select packages: tigervnc (no such package)__'
		);
		expect(run.stage).not.toContain('resolving dependencies');
	});

	it('names the command and its status when the phase fails without a word', async () => {
		// A phase whose command is not there exits without printing anything.
		// "exited 127 without a message" is the one answer this marker exists to
		// avoid, so the phase's own body is the explanation instead.
		const run = await runScript(script, { apk: { status: 127 } });
		expect(run.status).toBe(127);
		const why = failReason(run.stage);
		expect(why).not.toBeNull();
		expect(why).toContain('apk add --no-cache');
		expect(why).toContain('tigervnc');
		expect(why).toContain('exited 127 with no output');
		expect(why).not.toContain('without a message');
	});
});

describe('what the status probe makes of those markers', () => {
	it('reads a finished run as the newest stage and no failure', async () => {
		const run = await runScript(script);
		// The probe cats the stage file; hand it the one the script really wrote.
		flags.stageText = run.stage;
		const status = await machineStatus(botId);
		expect(status.desktop_stage).toBe('stage 6/6 cdp');
		expect(status.desktop_error).toBe('');
	}, SCRIPT_RUN_MS);

	it('reads a failed run as the stage, label and reason the panel shows', async () => {
		const run = await runScript(script, {
			apk: { status: 1, says: ['ERROR: unable to select packages: tigervnc (no such package)'] }
		});
		flags.stageText = run.stage;
		const status = await machineStatus(botId);
		// The whole parse - the stage number, the label and the reason - comes
		// back through the real path, so the marker the script writes and the
		// sentence the panel prints are proven to be the same contract.
		expect(status.desktop_error).toBe(
			'stage 1/6 packages: ERROR: unable to select packages: tigervnc (no such package)'
		);
		// The stage it died on, not a later one, and not the FAIL line itself.
		expect(status.desktop_stage).toBe('stage 1/6 packages');
	});
});

describe('run_stage', () => {
	it('leaves only the stage marker when the phase succeeds', async () => {
		const run = await runStage(script, [`run_stage 3 'openbox' -- 'echo phase-three-finished'`]);
		expect(run.status).toBe(0);
		expect(run.stage).toBe('__OBL_STAGE_3:openbox__\n');
		expect(run.log).toContain('phase-three-finished');
	});

	it('does not let a silent phase inherit the line the phase before it printed', async () => {
		const run = await runStage(
			script,
			[
				`run_stage 1 'packages' -- 'echo apk-installed-12-packages'`,
				`run_stage 2 'xvnc' -- 'apk add --no-cache tigervnc'`
			],
			{ apk: { status: 127 } }
		);
		expect(run.status).toBe(127);
		expect(run.stage).toContain('__OBL_STAGE_1:packages__');
		expect(run.stage).toContain('__OBL_STAGE_2:xvnc__');
		const why = failReason(run.stage);
		// The offset is in bytes from before the phase started, so the tail of
		// the phase before it - which is a *true* line about a *different*
		// phase - is not offered up as this one's reason.
		expect(why).not.toContain('apk-installed-12-packages');
		expect(why).toBe('apk add --no-cache tigervnc exited 127 with no output');
	});

	it('skips blank lines rather than quoting one as the reason', async () => {
		// A phase that prints, then prints an empty line, then fails has a
		// trailing blank as its literal last line. The marker's reason group is
		// non-greedy, so a blank there would read back as a failure with nothing
		// to say - which is the state this marker exists to end.
		const run = await runStage(script, [
			`run_stage 3 'openbox' -- 'printf "starting openbox\\n\\n"; false'`
		]);
		expect(run.status).toBe(1);
		expect(failReason(run.stage)).toBe('starting openbox');
	});

	it('strips carriage returns so the reason is one line the panel can show', async () => {
		// A phase whose output carries CRs - a progress bar, a tool writing over
		// its own line - would otherwise put a raw CR inside the marker and split
		// it across the panel's line. It is stripped, not escaped.
		const run = await runStage(script, [
			`run_stage 3 'openbox' -- 'printf "progress 10%%\\rprogress 90%%\\n"; false'`
		]);
		expect(run.status).toBe(1);
		expect(run.stage).not.toContain('\\r');
		expect(failReason(run.stage)).toBe('progress 10%progress 90%');
	});

	it('keeps the reason to one bounded line', async () => {
		// The marker is one line in a file the panel and the log both read, so a
		// phase that prints a wall of text must not push the next phase's marker
		// onto a line nobody parses, nor hand the panel an unbounded string.
		const long = await runStage(script, [
			`run_stage 3 'openbox' -- 'echo ${'B'.repeat(300)}; false'`
		]);
		expect(long.status).toBe(1);
		expect(failReason(long.stage)).toBe('B'.repeat(200));
		expect(long.stage.split('\n').filter(Boolean)).toEqual([
			'__OBL_STAGE_3:openbox__',
			`__OBL_STAGE_FAIL:3:openbox:${'B'.repeat(200)}__`
		]);
	});
});
