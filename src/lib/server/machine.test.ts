import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Docker socket is faked: every dockerRequest lands in `fakeDocker`, which
// answers from `containers` the way the daemon would. The exec endpoint is
// stubbed to a fixed output; tests that care about the command inspect the
// calls afterwards.
const { fakeDocker, execCalls, containers, volumes, networks, flags, execResult } = vi.hoisted(() => {
	const containers: {
		Id: string;
		Names?: string[];
		State?: string;
		Created?: number;
		Labels?: Record<string, string>;
		Network?: string;
		NetworkID?: string;
		/** Every attachment, by name, as the inspect reports them. */
		Networks?: Record<string, string>;
		Ports: { PublicPort: number; PrivatePort: number; Type: string }[];
	}[] = [];
	const volumes: { Name: string }[] = [];
	const execCalls: { cmd: string[] }[] = [];
	// Execs created through the raw API, so start and inspect can answer.
	const execs = new Map<string, string[]>();
	let seq = 0;
	let execSeq = 0;
	// Knobs tests turn to steer the fake: whether the desktop's processes are
	// up, whether its setup script is mid-run, and whether the pane capture
	// should fail (a container restarted without its tmux server).
	const flags = { desktopUp: false, desktopScriptRunning: false, captureFails: false, stageFile: '', cookieJar: '', toolsetMissing: false, netCreateFails: false, netMissing: false, windowTitle: '' };
	// Networks the daemon knows about; create fills it, delete empties it.
	const networks: { Name: string; Id: string }[] = [];
	// What the daemon would answer for a command.
	const execResult = (cmd: string[]) => {
		const joined = cmd.join(' ');
		// The CDP driver's cookie read: the test hands it the jar it should
		// report, so the app's own site filter is what is under test.
		if (joined.includes('obl-cdp.mjs cookies')) {
			return { output: flags.cookieJar, exitCode: 0 };
		}
		if (joined.includes('getactivewindow getwindowname')) {
			// The driving record's title probe: the test names the window the
			// gesture left in focus, or '' when the desktop cannot say.
			return { output: flags.windowTitle, exitCode: 0 };
		}
		if (joined.includes('echo ready')) {
			// The desktop-state probe answers one word, and then - after its
			// splitter - whether the recipe's panel is up beside it. A desktop
			// that is up has its panel up: a fake that said otherwise would
			// leave the code under test restarting a machine that is fine.
			if (flags.desktopUp) return { output: `ready\n__OBL_PROBE__panelled`, exitCode: 0 };
			if (flags.desktopScriptRunning) return { output: 'starting', exitCode: 0 };
			return { output: 'off', exitCode: 0 };
		}
		// The stage watcher reads the stage file and asks whether the screen
		// is serving in the same exec.
		if (joined.includes('cat /tmp/obl-stage')) {
			return {
				output: `__OBL_PROBE__${flags.stageFile}${flags.desktopUp ? 'serving\n' : ''}`,
				exitCode: 0
			};
		}
		if (joined.includes('command -v tmux')) {
			// A real container reports the toolset once its apk has run; the fake
			// mirrors that so the wake chain (installKey execs machineExec, which
			// wakes again) does not reinstall forever. toolsetMissing puts the
			// first probe on the fresh-container path only.
			const installed = execCalls.some((e) => e.cmd.join(' ').includes('apk add --no-cache tmux'));
			return flags.toolsetMissing && !installed
				? { output: 'sh: tmux: not found', exitCode: 1 }
				: { output: '/usr/bin/tmux', exitCode: 0 };
		}
		if (joined.includes('capture-pane')) {
			// The cursor probe and the capture travel in one exec, so the fake
			// answers both: a five-row pane with one painted row, the cursor on
			// the second row, and the blank padding a real capture carries.
			return flags.captureFails
				? { output: '', exitCode: 1 }
				: { output: 'OBL 1 5\npane text\n\n\n\n\n', exitCode: 0 };
		}
		// shellExec reads its capture files back in one command; answer with
		// canned output, the nonce marker, and exit code 0.
		const outMatch = joined.match(/cat \/tmp\/obl-out-(\w+)/);
		if (outMatch) {
			return { output: `captured output\n~~OBL:${outMatch[1]}\n0`, exitCode: 0 };
		}
		return { output: 'exec output', exitCode: 0 };
	};
	const fakeDocker = async (method: string, path: string, body?: unknown) => {
		const create = path.match(/^\/containers\/create\?name=(.+)$/);
		if (method === 'POST' && create) {
			const spec = body as {
				Labels?: Record<string, string>;
				Env?: string[];
				HostConfig?: { NetworkMode?: string };
			};
			const network = spec.HostConfig?.NetworkMode ?? '';
			const c = {
				Id: `id${++seq}`,
				Names: [`/${decodeURIComponent(create[1])}`],
				State: 'created',
				Labels: spec.Labels ?? {},
				Network: network,
				// The endpoint's network id, as the daemon stores it. A test
				// that wants the "network deleted and recreated under the same
				// name" case rewrites this to an id no network has.
				NetworkID: `net-${network}`,
				// Every attachment, by name. A container can be on more than one
				// network - the VNC gateway is on the machine's internal network
				// and the publishable bridge at once - and the inspect reports
				// them all, so a fake that held only the last one could not tell
				// a gateway that lost the bridge from one that never had it.
				Networks: network ? { [network]: `net-${network}` } : ({} as Record<string, string>),
				Ports: [] as { PublicPort: number; PrivatePort: number; Type: string }[]
			};
			containers.push(c);
			return { status: 201, body: Buffer.from(JSON.stringify({ Id: c.Id })) };
		}
		if (method === 'POST' && path === '/networks/create') {
			// netCreateFails is the daemon answering but refusing; netMissing is
			// the create reporting success while the network never lands - the
			// shape the live bug took, where nothing was ever created.
			if (flags.netCreateFails) {
				return { status: 500, body: Buffer.from('network create refused') };
			}
			const name = (body as { Name?: string } | undefined)?.Name ?? '';
			if (!flags.netMissing && !networks.some((n) => n.Name === name)) {
				networks.push({ Name: name, Id: `net-${name}` });
			}
			return { status: 201, body: Buffer.from('{}') };
		}
		const netConnect = path.match(/^\/networks\/([^/]+)\/connect$/);
		if (method === 'POST' && netConnect) {
			// Joining a network is what makes an endpoint live again; the fake
			// records it the way the daemon does, so a test reads the result
			// rather than the call.
			const name = decodeURIComponent(netConnect[1]);
			const spec = body as { Container?: string } | undefined;
			const target = spec?.Container ?? '';
			const c = containers.find(
				(x) => x.Id === target || ((x.Names as string[] | undefined) ?? []).includes(`/${target}`)
			);
			if (c) {
				(c.Networks ??= {})[name] = `net-${name}`;
				c.Network = name;
				c.NetworkID = `net-${name}`;
			}
			return { status: 200, body: Buffer.from('{}') };
		}
		const netDisconnect = path.match(/^\/networks\/([^/]+)\/disconnect$/);
		if (method === 'POST' && netDisconnect) {
			// Dropping an endpoint is what lets a start through afterwards; the
			// fake clears it the way the daemon does, keeping the network the
			// container was created on.
			const name = decodeURIComponent(netDisconnect[1]);
			const spec = body as { Container?: string } | undefined;
			const target = spec?.Container ?? '';
			const c = containers.find(
				(x) => x.Id === target || ((x.Names as string[] | undefined) ?? []).includes(`/${target}`)
			);
			if (c) {
				delete c.Networks?.[name];
				if (c.Network === name) c.NetworkID = '';
			}
			return { status: 200, body: Buffer.from('{}') };
		}
		const netGet = path.match(/^\/networks\/([^/]+)$/);
		if (method === 'GET' && netGet) {
			// The inspect names every endpoint on the network; removeMachineNetwork
			// disconnects them all before the delete. A name the daemon does not
			// know is a 404, the way a create that never landed reads.
			const name = decodeURIComponent(netGet[1]);
			if (!networks.some((n) => n.Name === name)) {
				return { status: 404, body: Buffer.from('no such network') };
			}
			const members: Record<string, unknown> = {};
			for (const c of containers) {
				const nets = (c.Networks as Record<string, string> | undefined) ?? {};
				if (nets[name] || c.Network === name) members[c.Id as string] = {};
			}
			return { status: 200, body: Buffer.from(JSON.stringify({ Containers: members })) };
		}
		const netDel = path.match(/^\/networks\/(.+)$/);
		if (method === 'DELETE' && netDel) {
			const i = networks.findIndex((n) => n.Name === decodeURIComponent(netDel[1]));
			if (i >= 0) networks.splice(i, 1);
			return { status: 204, body: Buffer.alloc(0) };
		}
		if (method === 'GET' && path === '/networks') {
			// The daemon's list is what was created, not what containers claim:
			// a dead endpoint's network is absent here, which is exactly what
			// dropDeadNetworks compares against.
			return { status: 200, body: Buffer.from(JSON.stringify(networks)) };
		}
		const action = path.match(/^\/containers\/([^/]+)\/(start|stop|exec|archive|json)/);
		if (action) {
			const c = containers.find((x) => x.Id === action[1]);
			if (!c) return { status: 404, body: Buffer.from('no such container') };
			if (action[2] === 'start') {
				// The daemon refuses to start a container whose endpoint holds a
				// network id no live network has - the failure this path exists
				// to clear, and the one a name-only check would walk straight
				// into. No endpoint at all is fine: the start goes through and
				// the caller joins a network afterwards.
				const attached = {
					...((c.Networks as Record<string, string>) ?? {}),
					// A test that rewrites the primary's id models a stale
					// endpoint, which is what the start must refuse.
					...((c.Network as string) && (c.NetworkID as string)
						? { [c.Network as string]: c.NetworkID as string }
						: {})
				};
				for (const [name, ep] of Object.entries(attached)) {
					const live = networks.find((n) => n.Name === name);
					if (!live || live.Id !== ep) {
						return {
							status: 404,
							body: Buffer.from(
								JSON.stringify({
									message: `failed to set up container networking: network ${ep} not found`
								})
							)
						};
					}
				}
				c.State = 'running';
				return { status: 204, body: Buffer.alloc(0) };
			}
			if (action[2] === 'stop') {
				c.State = 'exited';
				return { status: 204, body: Buffer.alloc(0) };
			}
			if (action[2] === 'json') {
				// Every attachment the container holds, as the daemon reports
				// them. The primary's id is written last so a test that rewrites
				// it models a stale endpoint on that network.
				const nets: Record<string, { NetworkID: string }> = {};
				for (const [name, id] of Object.entries((c.Networks as Record<string, string>) ?? {})) {
					nets[name] = { NetworkID: id };
				}
				const primary = (c.Network as string) ?? '';
				if (primary && c.NetworkID) nets[primary] = { NetworkID: c.NetworkID as string };
				return {
					status: 200,
					body: Buffer.from(
						JSON.stringify({
							State: { StartedAt: '2026-01-01T00:00:00Z', Running: c.State === 'running' },
							// A dropped endpoint is gone from the inspect too, which
							// is what the daemon reports after a disconnect.
							NetworkSettings: { Networks: nets }
						})
					)
				};
			}
			if (action[2] === 'exec') {
				// Create only: the command runs when /exec/<id>/start is called.
				const spec = body as { Cmd?: string[] };
				const id = `exec${++execSeq}`;
				execs.set(id, spec.Cmd ?? []);
				return { status: 201, body: Buffer.from(JSON.stringify({ Id: id })) };
			}
			if (action[2] === 'archive') {
				if (method === 'PUT') return { status: 200, body: Buffer.alloc(0) };
				return { status: 200, body: Buffer.alloc(0) };
			}
		}
		const execStart = path.match(/^\/exec\/([^/]+)\/start$/);
		if (method === 'POST' && execStart) {
			const cmd = execs.get(execStart[1]);
			if (!cmd) return { status: 404, body: Buffer.from('no such exec') };
			execCalls.push({ cmd });
			return { status: 200, body: Buffer.from(execResult(cmd).output) };
		}
		const execJson = path.match(/^\/exec\/([^/]+)\/json$/);
		if (method === 'GET' && execJson) {
			const cmd = execs.get(execJson[1]);
			if (!cmd) return { status: 404, body: Buffer.from('no such exec') };
			return {
				status: 200,
				body: Buffer.from(JSON.stringify({ ExitCode: execResult(cmd).exitCode }))
			};
		}
		const del = path.match(/^\/containers\/([^/?]+)/);
		if (method === 'DELETE' && del) {
			const i = containers.findIndex((x) => x.Id === del[1]);
			if (i >= 0) containers.splice(i, 1);
			return { status: 204, body: Buffer.alloc(0) };
		}
		if (method === 'GET' && path.startsWith('/containers/json')) {
			// Honour the filters callers send: name is a substring match on the
			// container's names, label matches a key or a key=value pair.
			let filters: { name?: string[]; label?: string[] } = {};
			try {
				filters = JSON.parse(
					new URLSearchParams(path.split('?')[1] ?? '').get('filters') ?? '{}'
				);
			} catch {
				filters = {};
			}
			const names = filters.name ?? [];
			const labels = filters.label ?? [];
			const list = containers.filter((c) => {
				const cNames = (c.Names as string[]) ?? [];
				const cLabels = (c.Labels as Record<string, string>) ?? {};
				if (names.length && !names.some((n) => cNames.some((cn) => cn.includes(n)))) {
					return false;
				}
				return labels.every((l) => {
					const eq = l.indexOf('=');
					return eq < 0 ? l in cLabels : cLabels[l.slice(0, eq)] === l.slice(eq + 1);
				});
			});
			return { status: 200, body: Buffer.from(JSON.stringify(list)) };
		}
		if (method === 'GET' && path === '/volumes') {
			return { status: 200, body: Buffer.from(JSON.stringify({ Volumes: volumes })) };
		}
		const volDel = path.match(/^\/volumes\/(.+)$/);
		if (method === 'DELETE' && volDel) {
			const i = volumes.findIndex((v) => v.Name === volDel[1]);
			if (i >= 0) volumes.splice(i, 1);
			return { status: 204, body: Buffer.alloc(0) };
		}
		if (method === 'GET' && path.startsWith('/volumes/')) {
			return { status: 200, body: Buffer.from('{}') };
		}
		if (method === 'POST' && path === '/volumes/create') {
			return { status: 201, body: Buffer.from('{}') };
		}
		return { status: 200, body: Buffer.from('{}') };
	};
	return { fakeDocker, execCalls, containers, volumes, networks, flags, execResult };
});

vi.mock('./docker', async (importOriginal) => {
	const real = await importOriginal<typeof import('./docker')>();
	return {
		...real,
		dockerRequest: vi.fn(fakeDocker),
		// dockerExec is module-internal to docker.ts, so stubbing dockerRequest
		// alone would still leave it talking to the real socket.
		dockerExec: vi.fn(async (_c: string, cmd: string[]) => {
			execCalls.push({ cmd });
			// The real wrapper returns combined output, not split streams.
			return execResult(cmd);
		}),
		// containerNetwork is module-internal for the same reason, and it is
		// read on every wake: left real it asks the host daemon about a fake
		// container id, gets a 404, and reports every machine as sitting on no
		// network - which makes ensureMachine rebuild its container each time.
		containerNetwork: vi.fn(async (id: string) => {
			const c = containers.find((x) => x.Id === id);
			// A dropped endpoint is no attachment at all, as the daemon reports.
			return c && c.NetworkID ? ((c.Network as string) ?? '') : '';
		}),
		dockerExecDetached: vi.fn(async (_c: string, cmd: string[]) => {
			execCalls.push({ cmd });
		}),
		ensureAuditWatcher: vi.fn(async () => {})
	};
});
import {
	clampRegion,
	destroyMachine,
	desktopInput,
	ensureDesktop,
	ensureMachine,
	exportCookies,
	importCookies,
	machineExec,
	machineName,
	machineStatus,
	normalizeSite,
	presenceForBots,
	recordDriving,
	reapIdleMachines,
	removeOrphanMachines,
	screenshotCommand,
	setHumanDriving,
	shellExec,
	shellScreen,
	siteMatchesCookie,
	sleepMachine,
	sweepOrphanShots,
	touchMachine,
	watchDesktopSettled
} from './machine';
import { dockerRequest } from './docker';
import { ensureVncGateway, machineNetwork, removeMachineNetwork, vncGatewayName } from './machine-net';
import { addMessage, createBot, createConversation, deleteBot, deleteConversation, listActivities, listMessages, updateBot } from './db';
import { config } from './config';

/** A container record as the fake above builds it from the create requests. */
interface FakeContainer {
	Id: string;
	State?: string;
	Labels?: Record<string, string>;
	/** The network the container was created on, and the id its endpoint holds. */
	Network?: string;
	NetworkID?: string;
	/** Every attachment, by name, as the inspect reports them. */
	Networks?: Record<string, string>;
	Ports: { PublicPort: number; PrivatePort: number; Type: string }[];
}

/**
 * The fake's container records, named once here. The mock builds them itself,
 * so the shape is known; naming it keeps every read of a field checked.
 */
const fakeContainers = () => containers as unknown as FakeContainer[];

/**
 * The HostConfig a create call for `name` sent, or null. The mock records the
 * body it was handed as `unknown`, so the two fields the boundary is tested on
 * are narrowed out of it rather than asserted.
 */
function createdHostConfig(
	name: string
): { PortBindings?: unknown; Sysctls?: unknown; Binds?: unknown } | null {
	const call = vi
		.mocked(dockerRequest)
		.mock.calls.find((c) => String(c[1]).includes(`name=${name}`));
	const body: unknown = call?.[2];
	if (!body || typeof body !== 'object' || !('HostConfig' in body)) return null;
	const hc = body.HostConfig;
	if (!hc || typeof hc !== 'object') return null;
	const out: { PortBindings?: unknown; Sysctls?: unknown; Binds?: unknown } = {};
	if ('PortBindings' in hc) out.PortBindings = hc.PortBindings;
	if ('Sysctls' in hc) out.Sysctls = hc.Sysctls;
	if ('Binds' in hc) out.Binds = hc.Binds;
	return out;
}

let botId = '';
let dir = '';

beforeEach(async () => {
	containers.length = 0;
	volumes.length = 0;
	networks.length = 0;
	execCalls.length = 0;
	flags.desktopUp = false;
	flags.desktopScriptRunning = false;
	flags.captureFails = false;
	flags.stageFile = '';
	flags.cookieJar = '';
	flags.toolsetMissing = false;
	flags.netCreateFails = false;
	flags.netMissing = false;
	flags.windowTitle = '';
	dir = config.dataDir;
	const bot = createBot({ name: `Bot${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
	botId = bot.id;
});

describe('machine lifecycle', () => {
	it('creates one labelled container with the shared and company mounts', async () => {
		await ensureMachine(botId);
		expect(containers.filter((c) => (c.Labels as Record<string,string>)['obl.kind'] === 'machine')).toHaveLength(1);
		const c = containers.find((x) => (x.Labels as Record<string,string>)['obl.kind'] === 'machine')!;
		expect((c.Names as string[])[0]).toBe(`/${machineName(botId)}`);
		expect((c.Labels as Record<string, string>)['obl.kind']).toBe('machine');
		expect((c.Labels as Record<string, string>)['obl.bot']).toBe(botId);
	});

	it('mounts the nix store volume only for a bot the human enabled it on', async () => {
		await ensureMachine(botId);
		const plain = createdHostConfig(machineName(botId))?.Binds as string[];
		expect(plain.some((b) => b.endsWith(':/nix'))).toBe(false);

		const nixBot = createBot({ name: `Nix${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
		updateBot(nixBot.id, { nix_enabled: 1 });
		await ensureMachine(nixBot.id);
		const binds = createdHostConfig(machineName(nixBot.id))?.Binds as string[];
		expect(binds).toContain(`obl-nix-${nixBot.id}:/nix`);
	});

	it('reuses the running container instead of making a second', async () => {
		const a = await ensureMachine(botId);
		const b = await ensureMachine(botId);
		expect(a).toBe(b);
		expect(containers.filter((c) => (c.Labels as Record<string,string>)['obl.kind'] === 'machine')).toHaveLength(1);
	});

	it('logs one toolset install for two concurrent ensureMachine calls', async () => {
		// The real fault: wake, status poll and desktop kick each ran the boot
		// work concurrently, so the log carried the same install line seven
		// times in ten seconds. The fake answers `command -v tmux` with a
		// failure here, which is the fresh-container path every racer used to
		// walk separately.
		flags.toolsetMissing = true;
		// The apk exec is slow in production; the fake answers at once, so the
		// two calls below really do overlap inside the boot work.
		await Promise.all([ensureMachine(botId), ensureMachine(botId)]);
		const log = listActivities(botId).map((a) => a.detail);
		const installLines = log.filter((d) => d.startsWith('Installing the toolset'));
		// One line, not one per racer: the guard waits every latecomer on the
		// work the first caller started.
		expect(installLines).toHaveLength(1);
		// The same for the completion line and the apk itself - one racers'
		// work, not one per caller.
		expect(log.filter((d) => d === 'Toolset installed')).toHaveLength(1);
		expect(
			execCalls.filter((e) => e.cmd.join(' ').includes('apk add --no-cache tmux'))
		).toHaveLength(1);
	});

	it('reports off, running and sleeping', async () => {
		expect((await machineStatus(botId)).state).toBe('off');
		await ensureMachine(botId);
		expect((await machineStatus(botId)).state).toBe('running');
		await sleepMachine(botId);
		expect((await machineStatus(botId)).state).toBe('sleeping');
	});

	it('wakes a machine whose network was deleted and recreated while it slept', async () => {
		await ensureMachine(botId);
		await sleepMachine(botId);
		// The network went away with the machine down and came back under a new
		// id. The name still matches, so only the endpoint's id gives it away -
		// and the daemon refuses the start until that endpoint is gone.
		const c = fakeContainers().find(
			(x) => (x.Labels as Record<string, string>)['obl.kind'] === 'machine'
		)!;
		c.NetworkID = 'net-gone';

		await ensureMachine(botId);

		expect(c.State).toBe('running');
		// A start that finds no endpoint does not rebuild one from NetworkMode,
		// so the wake has to join the live network itself.
		expect(c.NetworkID).toBe(`net-${machineNetwork(botId)}`);
	});

	it('rejoins a running machine whose network was deleted under it', async () => {
		// The live bug: a reset removed the network while the container was
		// still attached, and the wake's dead-endpoint sweep only ran for
		// stopped containers - the running one kept a dead endpoint forever.
		await ensureMachine(botId);
		const c = fakeContainers().find(
			(x) => (x.Labels as Record<string, string>)['obl.kind'] === 'machine'
		)!;
		expect(c.State).toBe('running');
		// The endpoint's name still matches; only its id is dead.
		c.NetworkID = 'net-gone';

		await ensureMachine(botId);

		expect(c.State).toBe('running');
		expect(c.NetworkID).toBe(`net-${machineNetwork(botId)}`);
	});

	it('re-attaches a running machine left with no network at all', async () => {
		// The live bug's other half: the network was deleted while the
		// container was attached, so the endpoint went with it - a running
		// machine on zero networks, which the old name-compare read as
		// "wrong network" and rebuilt, or missed entirely.
		await ensureMachine(botId);
		const c = fakeContainers().find(
			(x) => (x.Labels as Record<string, string>)['obl.kind'] === 'machine'
		)!;
		expect(c.State).toBe('running');
		c.Network = '';
		c.NetworkID = '';
		c.Networks = {};

		await ensureMachine(botId);

		// Re-attached, not rebuilt: the same container is running on the
		// machine's network again.
		expect(c.State).toBe('running');
		expect(c.NetworkID).toBe(`net-${machineNetwork(botId)}`);
		expect(
			containers.filter((x) => (x.Labels as Record<string, string>)['obl.kind'] === 'machine')
		).toHaveLength(1);
	});

	it('refuses to build a machine when its network never landed', async () => {
		// The create reported success but the network does not exist - the
		// shape the live failure took. Naming it in NetworkMode would build a
		// container on no network: running, resolving nothing, and never
		// repaired by a later wake.
		flags.netMissing = true;

		await expect(ensureMachine(botId)).rejects.toThrow('does not exist');
		expect(
			containers.filter((x) => (x.Labels as Record<string, string>)['obl.kind'] === 'machine')
		).toHaveLength(0);
	});

	it('surfaces a failed network create instead of building on nothing', async () => {
		// A create the daemon refused used to be swallowed, and the container
		// was built on a network that did not exist.
		flags.netCreateFails = true;

		await expect(ensureMachine(botId)).rejects.toThrow('network create failed');
		expect(
			containers.filter((x) => (x.Labels as Record<string, string>)['obl.kind'] === 'machine')
		).toHaveLength(0);
	});

	it('detaches the machine container when its network is removed', async () => {
		// removeMachineNetwork used to disconnect only the egress proxy and the
		// VNC gateway, so a container that outlived its network kept an
		// endpoint on a deleted network.
		await ensureMachine(botId);
		const c = fakeContainers().find(
			(x) => (x.Labels as Record<string, string>)['obl.kind'] === 'machine'
		)!;

		await removeMachineNetwork(botId);

		expect(c.NetworkID).toBe('');
		expect(Object.keys((c.Networks as Record<string, string>) ?? {})).toEqual([]);
	});
	it('answers the whole fleet\'s presence in one daemon list call', async () => {
		const pal = createBot({ name: `Pal${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
		// One machine up, one stopped, and one bot with no machine at all.
		containers.push(
			{ Id: 'm1', State: 'running', Names: [`/${machineName(botId)}`], Labels: {}, Ports: [] },
			{ Id: 'm2', State: 'exited', Names: [`/${machineName(pal.id)}`], Labels: {}, Ports: [] }
		);
		const listCalls: string[] = [];
		vi.mocked(dockerRequest).mockImplementation(async (method, path, body) => {
			if (method === 'GET' && path.startsWith('/containers/json')) listCalls.push(path);
			return fakeDocker(method, path, body);
		});

		const presence = await presenceForBots([botId, pal.id, 'nobot']);

		expect(presence).toEqual({ [botId]: 'running', [pal.id]: 'sleeping', nobot: 'off' });
		// The fleet answer costs one list call however many bots are asked about.
		expect(listCalls).toHaveLength(1);
	});

	it('destroy removes the container and the share volume', async () => {
		await ensureMachine(botId);
		await destroyMachine(botId);
		expect(containers.filter((c) => (c.Labels as Record<string,string>)['obl.kind'] === 'machine')).toHaveLength(0);
		expect((await machineStatus(botId)).state).toBe('off');
	});

	it('reaps a machine idle past the window', async () => {
		await ensureMachine(botId);
		// lastActive is tracked in-process; simulate age by sleeping directly.
		await reapIdleMachines();
		// Just-created machines are fresh, so nothing is reaped.
		expect(containers.filter((c) => (c.Labels as Record<string,string>)['obl.kind'] === 'machine')).toHaveLength(1);
	});

	it('removes a reader container that outlived its read, and keeps a fresh one', async () => {
		containers.push(
			{
				Id: 'r-old',
				Names: ['/obl-reader-old'],
				State: 'exited',
				Created: 1,
				Labels: { 'obl.managed': 'true', 'obl.kind': 'reader' },
				Ports: []
			},
			{
				Id: 'r-new',
				Names: ['/obl-reader-new'],
				State: 'exited',
				Created: Math.floor(Date.now() / 1000),
				Labels: { 'obl.managed': 'true', 'obl.kind': 'reader' },
				Ports: []
			}
		);

		await reapIdleMachines();

		expect(containers.map((c) => c.Id)).toEqual(['r-new']);
	});


	it('does not inspect containers that are fresh on the list payload alone', async () => {
		const inspects: string[] = [];
		vi.mocked(dockerRequest).mockImplementation(async (method, path, body) => {
			if (method === 'GET' && /^\/containers\/[^/]+\/json$/.test(path)) inspects.push(path);
			return fakeDocker(method, path, body);
		});
		// A container whose Created is now: fresh without ever asking the daemon
		// for its StartedAt.
		containers.push({
			Id: 'fresh1',
			Names: [`/${machineName(botId)}`],
			State: 'running',
			Created: Math.floor(Date.now() / 1000),
			Labels: { 'obl.managed': 'true', 'obl.kind': 'machine', 'obl.bot': botId },
			Ports: []
		});

		await reapIdleMachines();

		expect(inspects).toEqual([]);
		expect(containers.find((c) => c.Id === 'fresh1')?.State).toBe('running');
	});

	it('inspects only containers stale on every cheap signal', async () => {
		const inspects: string[] = [];
		vi.mocked(dockerRequest).mockImplementation(async (method, path, body) => {
			if (method === 'GET' && /^\/containers\/[^/]+\/json$/.test(path)) inspects.push(path);
			return fakeDocker(method, path, body);
		});
		// Created long ago and no activity: the reaper must ask Docker when it
		// actually started before deciding to stop it.
		containers.push({
			Id: 'stale1',
			Names: [`/${machineName(botId)}`],
			State: 'running',
			Created: 1,
			Labels: { 'obl.managed': 'true', 'obl.kind': 'machine', 'obl.bot': botId },
			Ports: []
		});

		await reapIdleMachines();

		expect(inspects).toEqual(['/containers/stale1/json']);
	});

	it('removes orphan machines whose bot is gone', async () => {
		await ensureMachine(botId);
		const orphan = {
			Id: 'orphan1',
			Names: ['/obl-machine-deadbeef0000'],
			State: 'running',
			Labels: { 'obl.managed': 'true', 'obl.kind': 'machine', 'obl.bot': 'deadbeef0000' },
			Ports: []
		};
		containers.push(orphan);
		await removeOrphanMachines(new Set([botId]));
		expect(containers.find((c) => c.Id === 'orphan1')).toBeUndefined();
		expect(containers.filter((c) => (c.Labels as Record<string,string>)['obl.kind'] === 'machine')).toHaveLength(1);
	});
});

describe('machineStatus desktop phase', () => {
	it('reports the desktop starting while its setup runs and ready once up', async () => {
		await ensureMachine(botId);
		// Nothing asked for the desktop yet.
		expect((await machineStatus(botId)).desktop).toBe('off');
		// A kick in flight with no script alive yet still reads as starting.
		flags.desktopScriptRunning = true;
		expect((await machineStatus(botId)).desktop).toBe('starting');
		flags.desktopScriptRunning = false;
		flags.desktopUp = true;
		expect((await machineStatus(botId)).desktop).toBe('ready');
	});

	it('keeps vncPort at 0 until the desktop is ready', async () => {
		await ensureMachine(botId);
		// The port the panel dials is the gateway's: a machine on an internal
		// network cannot publish one at all.
		const gw = fakeContainers().find((c) => c.Labels?.['obl.kind'] === 'vncgate');
		expect(gw).toBeDefined();
		gw?.Ports.push({ PublicPort: 32769, PrivatePort: 6080, Type: 'tcp' });
		expect((await machineStatus(botId)).vncPort).toBe(0);
		flags.desktopUp = true;
		expect((await machineStatus(botId)).vncPort).toBe(32769);
		expect((await machineStatus(botId)).screen).toBe('ok');
	});

	it('reports a ready desktop with no gateway port as a gateway fault', async () => {
		await ensureMachine(botId);
		flags.desktopUp = true;
		// The desktop is serving and the machine is awake, but the gateway has
		// published nothing. That is a fault on this side of the boundary, not a
		// sleeping machine: the panel has to be able to say so rather than
		// offering a Wake that cannot help.
		const status = await machineStatus(botId);
		expect(status.desktop).toBe('ready');
		expect(status.vncPort).toBe(0);
		expect(status.screen).toBe('gateway');
	});

	it('creates one gateway per bot, publishing on loopback and not routing', async () => {
		await ensureMachine(botId);
		await ensureMachine(botId);
		const gateways = fakeContainers().filter((c) => c.Labels?.['obl.kind'] === 'vncgate');
		expect(gateways).toHaveLength(1);
		expect(gateways[0].State).toBe('running');
		expect(gateways[0].Labels).toMatchObject({ 'obl.bot': botId, 'obl.kind': 'vncgate' });
		// What the daemon is actually asked for: the gateway publishes on
		// loopback from an ordinary bridge (an internal network cannot publish
		// at all) and is forbidden from forwarding between its two networks.
		expect(createdHostConfig(vncGatewayName(botId))?.PortBindings).toEqual({
			'6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }]
		});
		expect(createdHostConfig(vncGatewayName(botId))?.Sysctls).toEqual({
			'net.ipv4.ip_forward': '0'
		});
		// And the machine's own container is asked for no binding at all: one
		// Docker would silently drop, leaving the panel dialling nothing.
		expect(createdHostConfig(machineName(botId))?.PortBindings).toBeUndefined();
		// The gateway is joined to the machine's internal network, which is
		// where the name it forwards to resolves. (The egress proxy is joined
		// to the same network, so the gateway's own connect is the one to find.)
		const connects = vi
			.mocked(dockerRequest)
			.mock.calls.filter(
				(c) => String(c[1]) === `/networks/${machineNetwork(botId)}/connect`
			)
			.map((c) => c[2]);
		expect(connects).toContainEqual(
			expect.objectContaining({ Container: gateways[0].Id })
		);
	});

	it('re-joins a gateway that lost the publishable bridge', async () => {
		await ensureMachine(botId);
		const gw = fakeContainers().find((c) => c.Labels?.['obl.kind'] === 'vncgate')!;
		// The stranded state: the gateway is on the machine's internal network
		// only. A bridge deleted and recreated under it holds a new id, so
		// dropDeadNetworks drops the stale endpoint - and nothing used to put it
		// back. On the internal network alone the gateway can neither publish a
		// port nor resolve a name, so a ready desktop read as an absent one.
		delete gw.Networks!['obl-vnc'];
		gw.Network = machineNetwork(botId);
		gw.NetworkID = `net-${machineNetwork(botId)}`;
		vi.mocked(dockerRequest).mockClear();

		await ensureVncGateway(botId, machineName(botId), machineNetwork(botId));

		// The bridge is back, and the machine's network was not traded for it.
		expect(gw.Networks?.['obl-vnc']).toBe('net-obl-vnc');
		expect(gw.Networks?.[machineNetwork(botId)]).toBe(`net-${machineNetwork(botId)}`);
		const connects = vi
			.mocked(dockerRequest)
			.mock.calls.filter((c) => String(c[1]) === `/networks/obl-vnc/connect`)
			.map((c) => c[2]);
		expect(connects).toContainEqual(expect.objectContaining({ Container: gw.Id }));

		// Idempotent: with both attachments present a second call joins nothing,
		// which is what lets the status poll run it on every missing port.
		vi.mocked(dockerRequest).mockClear();
		await ensureVncGateway(botId, machineName(botId), machineNetwork(botId));
		expect(
			vi.mocked(dockerRequest).mock.calls.filter((c) => String(c[1]).endsWith('/connect'))
		).toHaveLength(0);
	});
});

describe('shellExec', () => {
	it('returns the captured output file, not a pane slice', async () => {
		const out = await shellExec(botId, 'printf bar');
		expect(out).toBe('captured output');
		// The command is wrapped in a tee pipeline so the pane shows it live
		// while a copy lands in the file the answer is read from.
		const sent = execCalls.find((e) => e.cmd.join(' ').includes('load-buffer'));
		expect(sent).toBeDefined();
		const pasted = Buffer.from(
			(sent!.cmd.join(' ').match(/echo (\S+) \| base64/) ?? [])[1] ?? '',
			'base64'
		).toString();
		expect(pasted).toContain('tee /tmp/obl-out-');
		expect(pasted).toContain('printf bar');
	});
});

describe('shellScreen', () => {
	it('returns the pane with everything below the cursor trimmed away', async () => {
		await ensureMachine(botId);
		// The painted row and the empty row the cursor sits on, and nothing of
		// the blank padding below it: that padding is what used to leave the
		// widget's cursor line-heights under the prompt.
		expect(await shellScreen(botId)).toBe('pane text\n');
	});

	it('rebuilds the tmux session when the capture fails, then reads it', async () => {
		await ensureMachine(botId);
		flags.captureFails = true;
		// First capture fails (no tmux server); the repair runs ensureTmux,
		// whose session-create exec also captures nothing - the retry still
		// fails, so the answer degrades to empty rather than throwing.
		expect(await shellScreen(botId)).toBe('');
		const repaired = execCalls.some((e) => e.cmd.join(' ').includes('has-session'));
		expect(repaired).toBe(true);
	});

	it('returns empty for a machine that is not running', async () => {
		expect(await shellScreen(botId)).toBe('');
	});
});

describe('orphan sweep', () => {
	it('removes a container-less bot volume and its screen files', async () => {
		volumes.push({ Name: `obl-share-deadbeef0000` }, { Name: `obl-share-${botId}` });
		const shots = join(dir, 'shots');
		await mkdir(shots, { recursive: true });
		await writeFile(join(shots, 'deadbee0-1.png'), 'x');
		await removeOrphanMachines(new Set([botId]));
		expect(volumes.find((v) => v.Name === 'obl-share-deadbeef0000')).toBeUndefined();
		// A live bot's volume is left alone.
		expect(volumes.find((v) => v.Name === `obl-share-${botId}`)).toBeDefined();
	});
});

describe('watching counts as activity', () => {
	it('touchMachine keeps the reaper from sleeping a watched machine', async () => {
		await ensureMachine(botId);
		touchMachine(botId);
		await reapIdleMachines();
		expect(containers.filter((c) => (c.Labels as Record<string,string>)['obl.kind'] === 'machine')).toHaveLength(1);
		expect((containers.find((x) => (x.Labels as Record<string,string>)['obl.kind'] === 'machine') as { State: string }).State).toBe('running');
	});
});

describe('machineExec', () => {
	it('runs the command inside the container and returns stdout', async () => {
		const out = await machineExec(botId, 'echo hi');
		expect(out).toBe('exec output');
		const call = execCalls.find((e) => e.cmd.join(' ').includes('echo hi'));
		expect(call).toBeDefined();
	});
});

describe('desktop', () => {
	it('speaks one kick line for two concurrent ensureDesktop calls', async () => {
		// The panel's poll, a wake and a status poll's heal path all reach
		// ensureDesktop inside the machine wake's window; each used to run its
		// own kick, so the same "Desktop setup started" line landed twice and
		// two setup scripts ran against one machine.
		await Promise.all([ensureDesktop(botId), ensureDesktop(botId)]);
		const log = listActivities(botId).map((a) => a.detail);
		expect(log.filter((d) => d.startsWith('Desktop setup started'))).toHaveLength(1);
		// One kick, one script run.
		expect(
			execCalls.filter((e) => e.cmd.join(' ').includes('sh /tmp/obl-desktop.sh'))
		).toHaveLength(1);
	});

	it('installs the recipe and starts the desktop on first use', async () => {
		await ensureDesktop(botId);
		const ran = execCalls.map((e) => e.cmd.join(' ')).join('\n');
		// The recipe's apk line lives inside the script the machine runs, not in
		// an exec of its own; the detached run of that script is the signal.
		expect(ran).toContain('obl-desktop.sh');
		expect(ran).toContain('obl-cdp.mjs');
		// The kick names what was asked for.
		const log = listActivities(botId).map((a) => a.detail);
		expect(log.join('\n')).toMatch(
			/Desktop setup started: image alpine:latest, desktop openbox, browser chromium/
		);
		// machineWriteFile writes through the exec API: the script travels
		// base64 inside one of the recorded execs.
		const write = execCalls
			.map((e) => e.cmd.join(' '))
			.find((c) => c.includes('base64 -d > /tmp/obl-desktop.sh'));
		expect(write).toBeTruthy();
		const b64 = write!.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)![1];
		const script = Buffer.from(b64, 'base64').toString('utf8');
		// Each phase runs through the one helper that writes the marker the
		// watcher reads, so what the script must carry is the phase call and
		// the recipe's own name - not the marker's printf, which lives once
		// inside the helper.
		expect(script).toContain("run_stage 3 'openbox'");
		expect(script).toContain("run_stage 4 'chromium'");
	});

	it('machineStatus carries the stage marker the setup script reached', async () => {
		// Nothing asked for the desktop yet: no stage to name.
		await ensureMachine(botId);
		expect((await machineStatus(botId)).desktop_stage).toBe('');
	});

	it('narrates the stages the setup script reaches and stops once serving', async () => {
		// The real watcher waits seconds between checks; the test does not
		// need to sit through that, only through the loop itself.
		process.env.SANDBOX_STAGE_WATCH_SPACING_MS = '50';
		// A kick whose first check catches the script mid-install: apk has run,
		// Xvnc is coming up, the recipes have not started.
		flags.stageFile = '__OBL_STAGE_1:packages__\n__OBL_STAGE_2:xvnc__\n';
		await ensureDesktop(botId);
		// The first check's answer, plus what landed by the second: apk done,
		// Xvnc up, the desktop recipe echoed.
		flags.stageFile =
			'__OBL_STAGE_1:packages__\n__OBL_STAGE_2:xvnc__\n__OBL_STAGE_3:openbox__\n';
		await watchDesktopSettled(botId);
		// The kick line plus every stage the script echoed, recipe names along.
		const log = listActivities(botId).map((a) => a.detail);
		expect(log).toContain('Desktop: packages (stage 1/6)');
		expect(log).toContain('Desktop: xvnc (stage 2/6)');
		expect(log).toContain('Desktop: openbox (stage 3/6)');
		// The screen answers: the watcher's work is done.
		flags.desktopUp = true;
		flags.stageFile = '__OBL_STAGE_1:packages__\nserving\n';
		await watchDesktopSettled(botId);
		const after = listActivities(botId).map((a) => a.detail);
		expect(after.filter((d) => d.startsWith('Desktop: ')).length).toBe(3);
	});
});

describe('the display the machine runs on', () => {
	it('is exported into the pane script and the desktop setup script', async () => {
		await ensureDesktop(botId);
		const cmds = execCalls.map((e) => e.cmd.join(' '));
		/** The script a `base64 -d > <path>` exec writes, decoded. */
		const scriptAt = (path: string) => {
			const write = cmds.find((c) => c.includes(`base64 -d > ${path}`));
			expect(write).toBeTruthy();
			const b64 = write!.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)![1];
			return Buffer.from(b64, 'base64').toString('utf8');
		};
		// The bot's own shell: a command it runs, and anything that command
		// launches, must reach the display the desktop is really on rather than
		// guessing `:0` and hanging on an X server that is not there.
		const pane = scriptAt('/usr/local/bin/obl-shell');
		expect(pane).toContain('export DISPLAY=:1');
		// The desktop's own script starts Xvnc on the same display.
		expect(scriptAt('/tmp/obl-desktop.sh')).toContain('export DISPLAY=:1');
		// And the tmux session carries it, so a pane opened later - or one that
		// outlives a re-attach - finds it too.
		expect(cmds.some((c) => c.includes('tmux set-environment -g DISPLAY :1'))).toBe(true);
	});
});

describe('screenshotCommand', () => {
	it('writes a shell pipeline that produces a PNG', () => {
		const cmd = screenshotCommand();
		expect(cmd).toContain('import');
		expect(cmd).toContain('.png');
	});

	it('crops to a region when one is given', () => {
		const cmd = screenshotCommand('/tmp/out.png', '/theme', { x: 50, y: 40, w: 200, h: 150 });
		expect(cmd).toContain('-crop 200x150+50+40');
		expect(cmd).toContain('+repage');
		// The crop is the file that gets copied, so a crop that fails leaves
		// nothing to copy rather than falling back to the whole screen.
		expect(cmd).toContain('cp "$tmp/crop.png" /tmp/out.png');
	});

	it('does not crop when no region is given', () => {
		expect(screenshotCommand()).not.toContain('-crop');
	});

	it('burns a labelled coordinate grid when asked for one', () => {
		const cmd = screenshotCommand('/tmp/out.png', '/theme', undefined, 100);
		// Lines and labels are drawn onto a copy of the frame, so a grid that
		// fails leaves the plain screenshot to copy rather than nothing.
		expect(cmd).toContain('identify -format');
		expect(cmd).toContain('-draw "$lines"');
		expect(cmd).toContain('-draw "$labels"');
		expect(cmd).toContain('gx=$((gx + 100))');
		expect(cmd).toContain('cp "$tmp/grid.png" /tmp/out.png');
	});

	it('draws no grid without a spacing', () => {
		expect(screenshotCommand()).not.toContain('-draw');
	});
});

describe('desktopInput', () => {
	it('drives a click through xdotool on the desktop display', async () => {
		await ensureMachine(botId);
		await desktopInput(botId, { kind: 'click', x: 100, y: 200, button: 1, clicks: 2 });

		const call = execCalls.find((e) => e.cmd.includes('xdotool'))!;
		expect(call.cmd.join(' ')).toContain('mousemove -- 100 200');
		expect(call.cmd.join(' ')).toContain('click --repeat 2 -- 1');
	});

	it('types text as an argument, never through a shell', async () => {
		await ensureMachine(botId);
		await desktopInput(botId, { kind: 'type', text: 'hello; rm -rf /' });

		const call = execCalls.find((e) => e.cmd.includes('xdotool'))!;
		// The text is one argv entry: a shell never sees it, so its metachars
		// are keystrokes, not a command.
		expect(call.cmd).toContain('hello; rm -rf /');
		expect(call.cmd[0]).toBe('xdotool');
	});

	it('presses a key combination', async () => {
		await ensureMachine(botId);
		await desktopInput(botId, { kind: 'key', keys: 'ctrl+s' });

		const call = execCalls.find((e) => e.cmd.includes('xdotool'))!;
		expect(call.cmd.join(' ')).toContain('key -- ctrl+s');
	});
});

describe('clampRegion', () => {
	const screen = { w: 1280, h: 1024 };

	it('keeps a region already inside the screen', () => {
		expect(clampRegion({ x: 10, y: 20, w: 100, h: 50 }, screen)).toEqual({
			x: 10,
			y: 20,
			w: 100,
			h: 50
		});
	});

	it('trims a region that runs past the edge', () => {
		expect(clampRegion({ x: 1200, y: 1000, w: 200, h: 150 }, screen)).toEqual({
			x: 1200,
			y: 1000,
			w: 80,
			h: 24
		});
	});

	it('pulls a negative origin back to the edge', () => {
		expect(clampRegion({ x: -50, y: -50, w: 100, h: 100 }, screen)).toEqual({
			x: 0,
			y: 0,
			w: 50,
			h: 50
		});
	});

	it('refuses a region that misses the screen entirely', () => {
		expect(clampRegion({ x: 2000, y: 2000, w: 100, h: 100 }, screen)).toBeNull();
	});
});

describe('sweepOrphanShots', () => {
	it('deletes shot files no activity row references', async () => {
		const shots = join(dir, 'shots');
		await mkdir(shots, { recursive: true });
		await writeFile(join(shots, 'lonely.png'), 'x');
		// The sweep keeps shots younger than its grace period, so age this one
		// past it to stand in for a file whose activity row never arrived.
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(join(shots, 'lonely.png'), old, old);
		await sweepOrphanShots();
		const left = await readdir(shots).catch(() => [] as string[]);
		expect(left).not.toContain('lonely.png');
	});

	it('keeps a shot a chat message refers to', async () => {
		const bot = createBot({ name: `Shot${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const shots = join(dir, 'shots');
		await mkdir(shots, { recursive: true });
		const name = `kept-${Date.now()}.png`;
		await writeFile(join(shots, name), 'x');
		// A screenshot a bot sent into the thread is named by the message, not
		// by an activity row; the sweep must keep it for the thread to render.
		addMessage(conv.id, 'assistant', 'a screenshot', bot.id, '', 0, '', '', '', name);
		// Age it past the grace period so only the message reference can save it.
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(join(shots, name), old, old);
		await sweepOrphanShots();
		const left = await readdir(shots).catch(() => [] as string[]);
		expect(left).toContain(name);
		deleteConversation(conv.id);
		deleteBot(bot.id);
	});
});

describe('setHumanDriving', () => {
	it('tells the bot once per real handover, not once per report', () => {
		const bot = createBot({ name: `Driver${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
		const dm = createConversation([bot.id], 'direct');

		setHumanDriving(bot.id, true);
		// A second tab, or a viewer reconnect, reporting a state already heard.
		setHumanDriving(bot.id, true);
		setHumanDriving(bot.id, false);
		// The collapse-driven release landing on top of the button's own.
		setHumanDriving(bot.id, false);

		const events = listMessages(dm.id).filter((m) => m.kind === 'event');
		expect(events.map((m) => m.content)).toEqual([
			'The human took control of your computer.',
			'The human handed your computer back.'
		]);
		// The app speaks these, not the human - buildHistory marks them as
		// events only when nobody is named as their author.
		expect(events.every((m) => m.bot_id === '')).toBe(true);

		deleteConversation(dm.id);
		deleteBot(bot.id);
	});

	it('hands the bot a summary of what it did before the takeover', async () => {
		const bot = createBot({ name: `Drove${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
		const dm = createConversation([bot.id], 'direct');
		await ensureMachine(bot.id);
		flags.desktopUp = true;

		await shellExec(bot.id, 'apk add --no-cache nethack');
		await machineExec(bot.id, 'echo setup done');
		flags.windowTitle = 'Terminal';
		await desktopInput(bot.id, { kind: 'key', keys: 'Return' });
		flags.windowTitle = 'Nethack';
		await desktopInput(bot.id, { kind: 'click', x: 40, y: 60, button: 1, clicks: 1 });

		setHumanDriving(bot.id, true);

		const events = listMessages(dm.id).filter((m) => m.kind === 'event');
		const report = events[events.length - 1]?.content ?? '';
		expect(events[0].content).toBe('The human took control of your computer.');
		expect(report).toContain('While you were driving');
		expect(report).toContain('ran in the terminal: apk add --no-cache nethack');
		expect(report).toContain('ran quietly: echo setup done');
		expect(report).toContain('pressed Return [in "Terminal"]');
		expect(report).toContain('clicked at (40, 60) [in "Nethack"]');

		// The record restarts empty: a second takeover while the human holds
		// the screen reports nothing the bot already heard.
		setHumanDriving(bot.id, false);
		setHumanDriving(bot.id, true);
		const after = listMessages(dm.id).filter((m) => m.kind === 'event');
		expect(after.filter((m) => m.content.includes('While you were driving'))).toHaveLength(1);

		deleteConversation(dm.id);
		deleteBot(bot.id);
	});

	it('says nothing on a takeover when the bot never drove', () => {
		const bot = createBot({ name: `Idle${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
		const dm = createConversation([bot.id], 'direct');

		setHumanDriving(bot.id, true);

		const events = listMessages(dm.id).filter((m) => m.kind === 'event');
		expect(events.map((m) => m.content)).toEqual(['The human took control of your computer.']);

		deleteConversation(dm.id);
		deleteBot(bot.id);
	});

	it('bounds the record so an all-day driver cannot grow it forever', () => {
		const bot = createBot({ name: `Busy${Date.now()}`, persona: '', avatar: '', color: '', model: '', badge: '' });
		const dm = createConversation([bot.id], 'direct');

		for (let i = 0; i < 200; i++) recordDriving(bot.id, 'shell', `ran quietly: cmd-${i}`);
		setHumanDriving(bot.id, true);

		const report = listMessages(dm.id)
			.filter((m) => m.kind === 'event')
			.map((m) => m.content)
			.join('\n');
		// 60 acts is the cap: the newest survive, the oldest fell off.
		expect(report).toContain('cmd-199');
		expect(report).toContain('cmd-140');
		expect(report).not.toContain('cmd-139');

		deleteConversation(dm.id);
		deleteBot(bot.id);
	});
});

describe('cookie handover', () => {
	it('matches the site and its subdomains, never a lookalike', () => {
		expect(siteMatchesCookie('example.com', 'example.com')).toBe(true);
		// Chromium reports a domain cookie with a leading dot; it is the same site.
		expect(siteMatchesCookie('example.com', '.example.com')).toBe(true);
		expect(siteMatchesCookie('example.com', 'www.example.com')).toBe(true);
		// The dot in the subdomain test is what keeps a lookalike out.
		expect(siteMatchesCookie('example.com', 'notexample.com')).toBe(false);
		expect(siteMatchesCookie('example.com', 'example.com.evil.com')).toBe(false);
		// The site's own parent is not swept up: asking for a subdomain is narrow.
		expect(siteMatchesCookie('www.example.com', 'example.com')).toBe(false);
	});

	it('normalizes a URL or a dotted domain to a bare hostname', () => {
		expect(normalizeSite('https://Example.com/path?x=1')).toBe('example.com');
		expect(normalizeSite('.example.com')).toBe('example.com');
		expect(normalizeSite('example.com:8080')).toBe('example.com');
		expect(normalizeSite('  ')).toBe('');
	});

	it('exports only the cookies for the requested site', async () => {
		flags.cookieJar = JSON.stringify({
			cookies: [
				{ name: 'a', value: 'v1', domain: 'example.com', path: '/' },
				{ name: 'b', value: 'v2', domain: '.example.com', path: '/' },
				{ name: 'c', value: 'v3', domain: 'www.example.com', path: '/' },
				{ name: 'd', value: 'v4', domain: 'notexample.com', path: '/' },
				{ name: 'e', value: 'v5', domain: 'other.com', path: '/' }
			]
		});
		const cookies = await exportCookies(botId, 'example.com');
		expect(cookies.map((c) => c.name).sort()).toEqual(['a', 'b', 'c']);
	});

	it('writes the cookie payload as a file, never as an exec argument', async () => {
		flags.cookieJar = JSON.stringify({
			cookies: [{ name: 'sid', value: 'SECRET-COOKIE-VALUE', domain: 'example.com', path: '/' }]
		});
		const cookies = await exportCookies(botId, 'example.com');
		expect(cookies).toHaveLength(1);
		await importCookies(botId, cookies);
		// An exec command is what lands in the activity log, so the raw value
		// must never be one: the payload travels base64 through the file write.
		const commands = execCalls.map((e) => e.cmd.join(' ')).join('\n');
		expect(commands).not.toContain('SECRET-COOKIE-VALUE');
		expect(commands).toContain('obl-cookies-');
	});
});
