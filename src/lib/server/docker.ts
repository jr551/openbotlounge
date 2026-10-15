import http from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Shared Docker-socket plumbing for the per-bot machines: the desktop sandbox
 * (sandbox.ts) and the shell box (shellbox.ts) both talk to the same daemon.
 */

// The daemon's own address: a unix socket on Linux and macOS, the named pipe
// Docker Desktop exposes on Windows. DOCKER_SOCKET overrides either.
const DOCKER_SOCKET =
	process.env.DOCKER_SOCKET ??
	(process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');
/** The bridge network every managed container joins. */
export const NETWORK = process.env.SANDBOX_NETWORK ?? 'openbotlounge_default';
/**
 * Ceiling on one Docker API call. A wedged socket would otherwise hold the
 * caller forever, so every request carries this deadline; long-running calls
 * (exec waits, package installs) pass their own.
 */
const DOCKER_TIMEOUT_MS = positiveEnv('DOCKER_TIMEOUT_MS', 30_000);
/**
 * Ceiling on creating a reader container. Longer than the rest of a reader's
 * work on purpose: a create the client gave up on still happens, and the
 * container it leaves behind is one nothing knows the id of.
 */
const READER_CREATE_TIMEOUT_MS = positiveEnv('DOCKER_READER_CREATE_TIMEOUT_MS', 120_000);

/**
 * A positive numeric env var, or `fallback` when it is missing or unusable.
 * Shared by anything that reads a ceiling from the environment.
 */
export function positiveEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface ContainerInfo {
	Id: string;
	/** The list endpoint reports this as a string ("running"), not an object. */
	State: string;
	Names: string[];
	/** Unix seconds, as reported by the list endpoint. */
	Created?: number;
	/** Only the list endpoint with label filters carries these. */
	Labels?: Record<string, string>;
	Ports?: { PrivatePort: number; PublicPort?: number; Type: string }[];
}

export const isRunning = (c: ContainerInfo | null): boolean => c?.State === 'running';

/**
 * Whether the daemon answers at all. The settings page asks this so a host
 * without Docker shows a warning instead of machines that silently never
 * start. Cached briefly: the socket is pinged on every settings load, and a
 * daemon that is down should not be hammered by a polling tab.
 */
let dockerUp: { at: number; ok: boolean } = { at: 0, ok: false };
export async function dockerAvailable(): Promise<boolean> {
	if (Date.now() - dockerUp.at < 10_000) return dockerUp.ok;
	const ok = await dockerRequest('GET', '/_ping', undefined, undefined, 5_000)
		.then((r) => r.status === 200)
		.catch(() => false);
	dockerUp = { at: Date.now(), ok };
	return ok;
}

/** The named volume both of a bot's machines mount at /shared. */
export const shareVolume = (botId: string) => `obl-share-${botId}`;
/** The named volume a Nix-enabled bot's store lives on, mounted at /nix. */
export const nixVolume = (botId: string) => `obl-nix-${botId}`;
/** The company-wide drive every machine mounts at /company. */
export const COMPANY_VOLUME = 'obl-company';

/** Which network a container is attached to, or '' when unknown. */
export async function containerNetwork(id: string): Promise<string> {
	const res = await dockerRequest('GET', `/containers/${id}/json`).catch(() => null);
	if (!res || res.status !== 200) return '';
	try {
		const info = JSON.parse(res.body.toString()) as {
			NetworkSettings?: { Networks?: Record<string, unknown> };
		};
		return Object.keys(info.NetworkSettings?.Networks ?? {})[0] ?? '';
	} catch {
		return '';
	}
}

/**
 * One call to the Docker socket, answered as bytes.
 *
 * The daemon speaks plain HTTP/1.1 over the unix socket; keeping this raw
 * avoids a docker client dependency for a handful of endpoints. `timeoutMs`
 * overrides the default deadline for calls expected to run long.
 */
export function dockerRequest(
	method: string,
	path: string,
	body?: unknown,
	upload?: { data: Buffer; contentType: string },
	timeoutMs = DOCKER_TIMEOUT_MS,
	signal?: AbortSignal
): Promise<{ status: number; body: Buffer }> {
	const { promise, resolve, reject } = Promise.withResolvers<{
		status: number;
		body: Buffer;
	}>();
	const req = http.request(
		{
			socketPath: DOCKER_SOCKET,
			method,
			path,
			headers: upload
				? { 'Content-Type': upload.contentType, 'Content-Length': upload.data.length }
				: body
					? { 'Content-Type': 'application/json' }
					: {}
		},
		(res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
			// A daemon that drops the connection mid-body must reject now, not
			// when the request deadline happens to fire.
			res.on('error', reject);
		}
	);
	req.on('error', reject);
	// A daemon that accepts the connection and then never answers must not pin
	// the caller: abort the request and reject instead of waiting forever.
	req.setTimeout(timeoutMs, () => req.destroy(new Error('docker socket timed out')));
	// A caller that has been cancelled must not wait out the deadline either:
	// the request is destroyed and the promise rejects, and whatever the exec
	// was running is the caller's problem to clean up.
	const onAbort = () => req.destroy(new Error('aborted'));
	if (signal?.aborted) onAbort();
	else signal?.addEventListener('abort', onAbort, { once: true });
	if (upload) req.write(upload.data);
	else if (body) req.write(JSON.stringify(body));
	req.end();
	return promise.finally(() => signal?.removeEventListener('abort', onAbort));
}

/**
 * Undo Docker's stream multiplexing. An exec started without a TTY frames
 * every chunk as [stream, 0,0,0, size(4BE)] + payload; anything that does not
 * parse as frames is returned raw, which is what a TTY exec would produce.
 */
function demux(buf: Buffer): string {
	const out: Buffer[] = [];
	let off = 0;
	while (off + 8 <= buf.length) {
		const stream = buf[off];
		const size = buf.readUInt32BE(off + 4);
		if (stream > 2 || off + 8 + size > buf.length) return buf.toString();
		out.push(buf.subarray(off + 8, off + 8 + size));
		off += 8 + size;
	}
	if (off !== buf.length) return buf.toString();
	return Buffer.concat(out).toString();
}

/**
 * Run a command inside a container through the exec API and return its
 * combined stdout/stderr with the exit code. `timeoutMs` covers the start
 * call, which only answers once the command has finished. `signal` aborts
 * the wait early and puts the in-flight command down through its own pid.
 */
export async function dockerExec(
	container: string,
	cmd: string[],
	opts: { timeoutMs?: number; env?: string[]; signal?: AbortSignal } = {}
): Promise<{ output: string; exitCode: number }> {
	const created = await dockerRequest('POST', `/containers/${container}/exec`, {
		AttachStdout: true,
		AttachStderr: true,
		Cmd: cmd,
		...(opts.env ? { Env: opts.env } : {})
	});
	if (created.status !== 201) {
		throw new Error(`docker exec create failed ${created.status}: ${created.body.slice(0, 200)}`);
	}
	const createdJson: unknown = JSON.parse(created.body.toString());
	if (!createdJson || typeof createdJson !== 'object' || !('Id' in createdJson)) {
		throw new Error('docker exec create returned no id');
	}
	const Id = String(createdJson.Id);
	try {
		const started = await dockerRequest(
			'POST',
			`/exec/${Id}/start`,
			{ Detach: false, Tty: false },
			undefined,
			opts.timeoutMs ?? DOCKER_TIMEOUT_MS,
			opts.signal
		);
		if (started.status !== 200) {
			throw new Error(`docker exec start failed ${started.status}`);
		}
		// The start body carries the output but not the exit code; that is a
		// separate inspect once the command has run.
		let exitCode = -1;
		const inspect = await dockerRequest('GET', `/exec/${Id}/json`).catch(() => null);
		if (inspect && inspect.status === 200) {
			const info: unknown = JSON.parse(inspect.body.toString());
			if (info && typeof info === 'object' && 'ExitCode' in info && typeof info.ExitCode === 'number') {
				exitCode = info.ExitCode;
			}
		}
		return { output: demux(started.body), exitCode };
	} catch (e) {
		// An aborted start leaves the command running inside the container -
		// the exec API has no kill, so the process is put down through its own
		// pid: inspect names it, and one more exec sends the signal. Best
		// effort only; a dead container or a finished command fails quietly.
		if (opts.signal?.aborted) {
			try {
				const inspect = await dockerRequest('GET', `/exec/${Id}/json`);
				if (inspect.status === 200) {
					const info: unknown = JSON.parse(inspect.body.toString());
					if (info && typeof info === 'object' && 'Pid' in info && typeof info.Pid === 'number' && info.Pid > 0) {
						const kill = await dockerRequest('POST', `/containers/${container}/exec`, {
							AttachStdout: false,
							AttachStderr: false,
							Cmd: ['kill', '-9', String(info.Pid)]
						});
						if (kill.status === 201) {
							const j: unknown = JSON.parse(kill.body.toString());
							if (j && typeof j === 'object' && 'Id' in j) {
								await dockerRequest('POST', `/exec/${String(j.Id)}/start`, { Detach: true, Tty: false });
							}
						}
					}
				}
			} catch {
				// The kill is best effort: the abort itself is what the caller sees.
			}
		}
		throw e;
	}
}

/**
 * Run a command inside a container detached - fire and forget. Used for the
 * /company audit watcher, which must outlive the exec that starts it.
 */
export async function dockerExecDetached(container: string, cmd: string[]): Promise<void> {
	const created = await dockerRequest('POST', `/containers/${container}/exec`, {
		AttachStdout: false,
		AttachStderr: false,
		Cmd: cmd
	});
	if (created.status !== 201) {
		throw new Error(`docker exec create failed ${created.status}: ${created.body.slice(0, 200)}`);
	}
	const createdJson: unknown = JSON.parse(created.body.toString());
	if (!createdJson || typeof createdJson !== 'object' || !('Id' in createdJson)) {
		throw new Error('docker exec create returned no id');
	}
	const started = await dockerRequest('POST', `/exec/${String(createdJson.Id)}/start`, {
		Detach: true,
		Tty: false
	});
	if (started.status !== 200 && started.status !== 204) {
		throw new Error(`docker exec start failed ${started.status}`);
	}
}

/**
 * The audit watcher: a shell loop that snapshots file mtimes every few seconds
 * and appends the paths that changed to per-drive logs under
 * /company/.audit/ - company.log for the shared drive itself, <botId>.log for
 * each bot's own drive. It runs in its own small container rather than inside
 * each machine: one watcher per machine meant every change was logged once
 * per awake bot, each signed with that watcher's own name - the log said who
 * was awake, never who wrote. A single watcher cannot name the writer either
 * (file mtimes carry no author), so lines are `epoch path`; which bot acted
 * is what the activity feed is for.
 *
 * BusyBox-compatible: `find -printf` is GNU-only and silently produced empty
 * snapshots on the Alpine machines, so mtimes come from `stat -c`, which
 * BusyBox provides.
 */
const AUDIT_SCRIPT = `#!/bin/sh
mkdir -p /company/.audit
prev=/tmp/obl-audit.prev
mkdir -p "$prev"
# The baseline is seeded, not logged: files already on the drives were not
# changed while the watcher was down, so the first snapshot only starts the
# clock.
for d in /company /shared/*; do
\t[ -d "$d" ] || continue
\tname=$(basename "$d")
\tfind "$d" -type f ! -path '*/.audit/*' -exec stat -c '%Y %n' {} + 2>/dev/null | sort -k2 > "$prev/$name"
done
while :; do
\tsleep 3
\tfor d in /company /shared/*; do
\t\t[ -d "$d" ] || continue
\t\tname=$(basename "$d")
\t\tfind "$d" -type f ! -path '*/.audit/*' -exec stat -c '%Y %n' {} + 2>/dev/null | sort -k2 > "/tmp/obl-audit.cur.$name"
\t\ttouch "$prev/$name"
\t\tcomm -13 "$prev/$name" "/tmp/obl-audit.cur.$name" | cut -d' ' -f2- | while IFS= read -r p; do
\t\t\tprintf '%s %s\\n' "$(date +%s)" "$p" >> "/company/.audit/$name.log"
\t\tdone
\t\tmv "/tmp/obl-audit.cur.$name" "$prev/$name"
\tdone
done
`;

/** The one container the audit watcher lives in. */
const AUDIT_NAME = 'obl-audit';

/**
 * Run one command in a throwaway container and return its output, then remove
 * the container whatever happened.
 *
 * The app has no mount of the bots' drives - /company and each bot's /shared
 * live only in the machines - so reading them from here means borrowing a
 * container that has the volume. No network at all: a reader only reads.
 */
export async function dockerRun(opts: {
	image: string;
	cmd: string[];
	/** Volumes to mount, as Docker's own `source:/path[:ro]` strings. */
	binds?: string[];
	timeoutMs?: number;
}): Promise<{ output: string; exitCode: number }> {
	const name = `obl-reader-${randomUUID().slice(0, 12)}`;
	// The create is inside the try, its cleanup is by name rather than by id,
	// and it gets a deadline of its own. It is the one call here whose
	// abandonment leaves something behind: a daemon slow enough to miss the
	// request deadline still finishes the create, and the answer that carried
	// the id is gone by then. Cleaning up by id left one of those behind every
	// time, and enough of them make the daemon slow enough to lose the next
	// one, so the pile feeds itself. Everything after the create can be cut
	// short safely - the finally removes the container by name either way.
	try {
		const created = await dockerRequest(
			'POST',
			`/containers/create?name=${name}`,
			{
				Image: opts.image,
				Cmd: opts.cmd,
				HostConfig: {
					Binds: opts.binds ?? [],
					NetworkMode: 'none',
					// Removed by hand below: AutoRemove would race the log read
					// that carries the answer out of the container.
					AutoRemove: false
				},
				Labels: { 'obl.managed': 'true', 'obl.kind': 'reader' }
			},
			undefined,
			READER_CREATE_TIMEOUT_MS
		);
		if (created.status !== 201) {
			const why = created.body.toString().slice(0, 200);
			// The machine image is the operator's to pull; saying so beats a 500.
			throw new Error(
				created.status === 404
					? `reader image not available: docker pull ${opts.image}`
					: `could not create a reader container: ${why}`
			);
		}
		const id = (JSON.parse(created.body.toString()) as { Id: string }).Id;
		const started = await dockerRequest('POST', `/containers/${id}/start`, undefined, undefined, opts.timeoutMs);
		if (started.status >= 400) {
			throw new Error(`could not start a reader container: ${started.body.toString().slice(0, 200)}`);
		}
		const waited = await dockerRequest(
			'POST',
			`/containers/${id}/wait`,
			undefined,
			undefined,
			opts.timeoutMs
		);
		const exitCode =
			waited.status === 200
				? (JSON.parse(waited.body.toString()) as { StatusCode: number }).StatusCode
				: -1;
		const logs = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1`);
		return { output: demux(logs.body), exitCode };
	} finally {
		await dockerRequest('DELETE', `/containers/${name}?force=1`).catch(() => {});
	}
}

/**
 * Make sure the audit watcher is running, watching /company and every bot's
 * own drive. Called on every machine wake with the bots that exist; the
 * container is created once and then simply kept alive - a stopped one is
 * started, a missing one is built from the machine image (which the host is
 * guaranteed to have, since a machine is coming up right now). A watcher
 * whose drive set no longer matches the fleet is recreated, so a new bot's
 * log appears on the next wake rather than never. Best-effort: a watcher
 * that cannot start must not hold the wake.
 */
export async function ensureAuditWatcher(botIds: string[] = []): Promise<void> {
	const list = await dockerRequest(
		'GET',
		`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: [AUDIT_NAME] }))}`
	);
	let c: ContainerInfo | null = null;
	if (list.status === 200) {
		try {
			c = (JSON.parse(list.body.toString()) as ContainerInfo[])[0] ?? null;
		} catch {
			c = null;
		}
	}
	if (c) {
		// A watcher created before it went networkless still sits on the shared
		// network; recreate it so the boundary applies to existing installs.
		const net = await containerNetwork(c.Id);
		// The drives it watches are fixed at create time, so a fleet that gained
		// or lost a bot since then needs a new watcher: the label carries the
		// set it was built for.
		const wanted = [...botIds].sort().join(',');
		const watching = c.Labels?.['obl.auditing'] ?? '';
		if ((net && net !== 'none') || watching !== wanted) {
			await dockerRequest('POST', `/containers/${c.Id}/stop`).catch(() => {});
			await dockerRequest('DELETE', `/containers/${c.Id}?force=1`).catch(() => {});
			c = null;
		}
	}
	if (c && isRunning(c)) return;
	if (!c) {
		const script = Buffer.from(AUDIT_SCRIPT).toString('base64');
		const res = await dockerRequest('POST', `/containers/create?name=${AUDIT_NAME}`, {
			Image: process.env.MACHINE_IMAGE ?? 'alpine:latest',
			// The script is passed through the environment so no volume or exec
			// is needed to get it in; the container decodes and runs it.
			Cmd: ['sh', '-c', `echo "$OBL_AUDIT_SCRIPT" | base64 -d > /tmp/obl-audit.sh; exec sh /tmp/obl-audit.sh`],
			Env: [`OBL_AUDIT_SCRIPT=${script}`],
			HostConfig: {
				Binds: [
					`${COMPANY_VOLUME}:/company`,
					// Each bot's drive is mounted read-only under its id: the watcher
					// reads it and writes only to /company/.audit/.
					...botIds.map((id) => `${shareVolume(id)}:/shared/${id}:ro`)
				],
				// The watcher only reads the drives and writes /company/.audit;
				// giving it a network would hand it reach it has no use for.
				NetworkMode: 'none',
				RestartPolicy: { Name: 'unless-stopped' }
			},
			Labels: {
				'obl.managed': 'true',
				'obl.kind': 'audit',
				'obl.auditing': [...botIds].sort().join(',')
			}
		});
		if (res.status === 201) {
			const created: { Id: string } = JSON.parse(res.body.toString());
			c = { Id: created.Id, State: 'created', Names: [AUDIT_NAME] };
		} else if (res.status === 409) {
			// Another wake made it first; fall through and start that one.
			c = { Id: AUDIT_NAME, State: 'created', Names: [AUDIT_NAME] };
		} else {
			return;
		}
	}
	await dockerRequest('POST', `/containers/${c.Id}/start`).catch(() => {});
}
