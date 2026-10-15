import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dockerRequest, isRunning, NETWORK, type ContainerInfo } from './docker';

/**
 * The network boundary around a bot's machine.
 *
 * Each machine lives on its own `internal` Docker network - no gateway, so no
 * route to this app, the host, the LAN, or another bot's machine. It has two
 * sidecars as members. The egress proxy answers CONNECT and plain-HTTP for
 * public addresses on any port and refuses every private address; the proxy env
 * vars the machine is created with are what curl, apk, git, Node's fetch and
 * the browser use. The VNC gateway republishes the machine's websockify port
 * on the host's loopback (Docker drops port publishing on an internal
 * network, so the machine's own binding never binds) and forwards that one
 * port to that one machine, nothing else.
 *
 * These helpers live here rather than in docker.ts because they are machine
 * lifecycle, and because docker.ts's own calls to dockerRequest cannot be
 * stubbed in tests - module-internal calls bypass the mock.
 */

/**
 * The network one bot's machine lives on: `obl-net-<botId>`, created
 * `internal`, so the machine has no gateway at all - no route to the app, the
 * host, the LAN, or another bot's machine. Its only way out is the egress
 * proxy, which is the one other member of the network.
 */
export const machineNetwork = (botId: string) => `obl-net-${botId}`;

/** The egress proxy's container name and the port it listens on. */
export const EGRESS_NAME = 'obl-egress';
export const EGRESS_PORT = 3128;

/**
 * The proxy address machines are given. The name resolves inside each
 * machine's own network, where the proxy is the only other member.
 */
export const EGRESS_URL = `http://${EGRESS_NAME}:${EGRESS_PORT}`;

/**
 * The port the machine's websockify speaks on, and the port its gateway
 * republishes on the host's loopback. One constant because the two must be
 * the same number: the gateway forwards the port it listens on.
 */
export const WEBSOCKIFY_PORT = 6080;

/**
 * The bridge the VNC gateways sit on. Ordinary (not `internal`), because
 * Docker refuses to publish a port from an internal network - which is the
 * whole problem the gateways exist to solve. Nothing else joins it and no
 * machine can reach it, so it carries one loopback-bound forwarder per awake
 * desktop and nothing more.
 *
 * The trade this makes, deliberately: a bridge that can publish is a bridge
 * with a route out, so a gateway container itself can reach this host and the
 * LAN. That is harmless here because the gateway is a byte pipe with exactly
 * one listener that dials exactly one target - the bot's own machine - and
 * because the *machine* can never reach a gateway as a router (no route to
 * add, no CAP_NET_ADMIN to add one, and the gateway's ip_forward is 0). The
 * alternative, one publishable bridge per bot, would buy sidecar-to-sidecar
 * isolation that no machine-facing path can reach anyway.
 */
export const GATEWAY_NETWORK = 'obl-vnc';

/** The forwarder container that republishes one machine's desktop port. */
export const vncGatewayName = (botId: string) => `obl-vnc-${botId.slice(0, 12)}`;

/**
 * The environment a machine is created with: every common tool's proxy vars,
 * NODE_USE_ENV_PROXY so Node's fetch honours them (the plugin harness and the
 * CDP driver run on Node 24), and NO_PROXY for the loopback the CDP driver
 * and desktop pieces talk to. With MACHINE_EGRESS=off the machine gets none
 * of this and is fully offline.
 *
 * Ssh is the one client these variables cannot reach - it ignores them - so it
 * is pointed at the same proxy by its own config instead:
 * /etc/ssh/ssh_config.d/obl-proxy.conf, written at boot by ensureTmux.
 */
export function machineEnv(): string[] {
	if ((process.env.MACHINE_EGRESS ?? '').trim().toLowerCase() === 'off') return [];
	return [
		`HTTP_PROXY=${EGRESS_URL}`,
		`HTTPS_PROXY=${EGRESS_URL}`,
		'http_proxy=' + EGRESS_URL,
		'https_proxy=' + EGRESS_URL,
		'NO_PROXY=localhost,127.0.0.1,::1',
		'no_proxy=localhost,127.0.0.1,::1',
		'NODE_USE_ENV_PROXY=1'
	];
}

/** Whether machine egress goes through the proxy at all. */
export const egressEnabled = () =>
	(process.env.MACHINE_EGRESS ?? '').trim().toLowerCase() !== 'off';

/**
 * The subnet a machine network gets. Docker's automatic pools run dry after
 * about thirty networks, so machine nets are numbered out of 10.0.0.0/8 -
 * 65k /24s keyed on the first two bytes of the bot id, which routes nowhere
 * the network can reach anyway (internal nets have no gateway, and the
 * egress proxy refuses private destinations outright). Two bytes, not one:
 * a single byte gives only 256 subnets, so two bots whose ids share a first
 * byte collide on the same /24 and the second create dies with "Pool
 * overlaps" - which the 403 below then misread as "already exists", leaving
 * a running machine on no network at all.
 */
function machineSubnet(botId: string): string {
	const hex = botId.replace(/-/g, '');
	// A /24's address is its .0; the bot id's first two bytes pick which of
	// the 65536 subnets in 10.0.0.0/8 this machine gets.
	const hi = parseInt(hex.slice(0, 2), 16) || 0;
	const lo = parseInt(hex.slice(2, 4), 16) || 0;
	return `10.${hi}.${lo}.0/24`;
}


/**
 * Create the bot's network when it does not exist. `internal` is what makes
 * it a boundary: Docker gives the network no gateway, so nothing inside it
 * can ARP for a way out.
 *
 * A failed create throws rather than answering with the name: the caller
 * names this network in the container's NetworkMode, and a create that never
 * ran leaves a container on no network at all - a machine that runs but can
 * resolve nothing, and that no later wake repairs on its own.
 */
export async function ensureMachineNetwork(botId: string): Promise<string> {
	const name = machineNetwork(botId);
	const res = await dockerRequest('POST', '/networks/create', {
		Name: name,
		Internal: true,
		IPAM: { Config: [{ Subnet: machineSubnet(botId) }] },
		Labels: { 'obl.managed': 'true', 'obl.bot': botId }
	});
	// 201 created it. 409/403 can mean it already exists - but 403 is also
	// how the daemon reports a subnet pool overlap, so "fine" has to be
	// proven by the network actually being there, not by the status alone.
	if (res.status !== 201) {
		if (res.status !== 409 && res.status !== 403) {
			throw new Error(`Docker network create failed ${res.status}: ${res.body.slice(0, 200)}`);
		}
		const check = await dockerRequest('GET', `/networks/${name}`).catch(() => null);
		if (!check || check.status !== 200) {
			throw new Error(`Docker network create failed ${res.status}: ${res.body.slice(0, 200)}`);
		}
	}
	if (egressEnabled()) await ensureEgressOn(name);
	return name;
}



/**
 * The image this app is running, so the sidecars can be built from it - it is
 * guaranteed present and already carries Node. Falls back when the inspect
 * fails, which is the bare-daemon deployment: the app is a systemd service on
 * the host rather than a container, so there is no image of its own to borrow.
 */
async function selfImage(): Promise<string> {
	// The container's hostname is its own id prefix, which the Docker API
	// resolves like a name - no hardcoded compose project name needed.
	const res = await dockerRequest('GET', `/containers/${hostname()}/json`).catch(() => null);
	if (res && res.status === 200) {
		try {
			const info = JSON.parse(res.body.toString()) as { Image?: string; Config?: { Image?: string } };
			const img = info.Config?.Image ?? info.Image;
			if (img) return img;
		} catch {
			// fall through to the fallback image
		}
	}
	// The fallback has to carry Node. Both sidecars run a node script, and the
	// gateway can be left on the machine's internal network - no route, no
	// resolver - where the `apk add nodejs` in its command cannot run at all,
	// so a node-less image is a gateway that crash-loops instead of a desktop
	// anyone can watch. `obl-node` is the host's own node-bearing image and is
	// preferred; the machine image is the last resort, where that apk fallback
	// is the only thing left. Each candidate is probed first, so a fallback is
	// never a create that 404s on an image the host does not have.
	for (const image of ['obl-node:latest', process.env.MACHINE_IMAGE ?? 'alpine:latest']) {
		const probe = await dockerRequest('GET', `/images/${image}/json`).catch(() => null);
		if (probe && probe.status === 200) return image;
	}
	return 'alpine:latest';
}

/**
 * The proxy source, read from the app directory: the repo root in dev, /app in
 * the image (the Dockerfile copies it in). Read at create time so a rebuilt
 * file reaches the next proxy container without a rebuild of this module.
 */
function egressScript(): string {
	return readFileSync('egress-proxy.mjs', 'utf8');
}

/**
 * Make sure the egress proxy exists, is running, and is joined to the given
 * machine network. The proxy itself sits on the app's network so it can reach
 * the internet; each machine network gets it as a second attachment under the
 * fixed name the machines resolve.
 */
/**
 * Make sure the bridge the egress proxy sits on exists. Compose creates
 * `openbotlounge_default` for the app; running from source on a bare daemon
 * nothing does, and the proxy's container create would fail on the missing
 * network with no hint of why.
 */
async function ensureEgressNetwork(): Promise<void> {
	const res = await dockerRequest('POST', '/networks/create', {
		Name: NETWORK,
		Labels: { 'obl.managed': 'true' }
	}).catch(() => null);
	// 201 created it; 409/403 means it already exists, which is fine.
	if (res && res.status !== 201 && res.status !== 409 && res.status !== 403) {
		throw new Error(`Docker network create failed ${res.status}: ${res.body.slice(0, 200)}`);
	}
}

/**
 * A container's attachments as the inspect reports them: network name to the
 * endpoint's network id. Null when the inspect cannot be read - a caller that
 * treats "unknown" as "attached to nothing" would disconnect or rebuild a
 * healthy container on a dead socket.
 */
export async function networkAttachments(containerId: string): Promise<Record<string, string> | null> {
	const info = await dockerRequest('GET', `/containers/${containerId}/json`).catch(() => null);
	if (!info || info.status !== 200) return null;
	try {
		const container = JSON.parse(info.body.toString()) as {
			NetworkSettings?: { Networks?: Record<string, { NetworkID?: string }> };
		};
		const out: Record<string, string> = {};
		for (const [name, ep] of Object.entries(container.NetworkSettings?.Networks ?? {})) {
			out[name] = ep.NetworkID ?? '';
		}
		return out;
	} catch {
		return null;
	}
}

/**
 * The networks a container is attached to AND whose endpoint ids still match
 * a live network. A network deleted and recreated under the same name - a
 * reset, the boot sweep, Docker Desktop's resyncer - leaves an endpoint whose
 * name still reads as attached while the id it holds is dead. A name-only
 * check skips the rejoin and leaves a running container on nothing.
 */
export async function attachedLiveNetworks(containerId: string): Promise<Set<string>> {
	const [attached, nets] = await Promise.all([
		networkAttachments(containerId),
		dockerRequest('GET', '/networks').catch(() => null)
	]);
	const live = new Set<string>();
	if (!attached || !nets || nets.status !== 200) return live;
	try {
		const ids = new Set(
			(JSON.parse(nets.body.toString()) as { Id: string }[]).map((n) => n.Id)
		);
		for (const [name, id] of Object.entries(attached)) {
			if (ids.has(id)) live.add(name);
		}
	} catch {
		// An unreadable list answers with nothing live; the caller re-joins.
	}
	return live;
}

/**
 * A stopped container keeps its endpoint on a network that was deleted while
 * it was down, and Docker refuses to start it until the dead attachment is
 * gone. Drop every attachment whose network no longer exists.
 *
 * "No longer exists" is the endpoint's network *id*, not its name. A network
 * deleted and recreated under the same name - which is exactly what a wake
 * does, and what Docker Desktop's own resyncer leaves behind - keeps the name
 * and changes the id, and it is the id the endpoint holds that the start
 * resolves. Comparing names alone reads that container as attached and the
 * start then dies with "failed to set up container networking: network <old
 * id> not found": a machine that never comes back, however often it is woken.
 *
 * Returns true when something was dropped, because a start that finds no
 * endpoint does not build one from HostConfig.NetworkMode - the caller has to
 * join the container to the live network once it is up.
 *
 * The sweep is deliberately blind to which network it drops: a stale endpoint
 * is what blocks the start whatever it points at, so sparing the gateway's own
 * bridge here would trade a stranded gateway for one that never starts at all.
 * The caller re-attaches instead - ensureVncGateway joins whichever of its two
 * bridges is missing after every start, which is what makes the drop safe.
 */
export async function dropDeadNetworks(containerId: string): Promise<boolean> {
	const attached = await networkAttachments(containerId);
	const nets = await dockerRequest('GET', '/networks').catch(() => null);
	if (!attached || !nets || nets.status !== 200) return false;
	let dropped = false;
	try {
		const live: Record<string, string> = {};
		for (const n of JSON.parse(nets.body.toString()) as { Name: string; Id: string }[]) {
			live[n.Name] = n.Id;
		}
		for (const [name, id] of Object.entries(attached)) {
			if (live[name] && live[name] === id) continue;
			await dockerRequest('POST', `/networks/${name}/disconnect`, {
				Container: containerId,
				Force: true
			}).catch(() => {});
			dropped = true;
		}
	} catch {
		// An unreadable network list drops nothing; the start reports the rest.
	}
	return dropped;
}


export async function ensureEgressOn(network: string): Promise<void> {
	await ensureEgressNetwork();
	const list = await dockerRequest(
		'GET',
		`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: [EGRESS_NAME] }))}`
	);
	let c: ContainerInfo | null = null;
	if (list.status === 200) {
		try {
			c = (JSON.parse(list.body.toString()) as ContainerInfo[])[0] ?? null;
		} catch {
			c = null;
		}
	}
	if (!c) {
		const image = await selfImage();
		// The script travels through the environment, the way the audit
		// watcher's does, so the proxy does not depend on the image having the
		// file at a known path - only on a node binary, which the app image
		// always has and the fallback installs.
		const script = Buffer.from(egressScript()).toString('base64');
		const res = await dockerRequest('POST', `/containers/create?name=${EGRESS_NAME}`, {
			Image: image,
			Cmd: [
				'sh',
				'-c',
				'command -v node >/dev/null 2>&1 || apk add --no-cache nodejs >/dev/null 2>&1; ' +
					'echo "$OBL_EGRESS_SCRIPT" | base64 -d > /tmp/obl-egress.mjs; ' +
					'exec node /tmp/obl-egress.mjs'
			],
			Env: [`EGRESS_PORT=${EGRESS_PORT}`, `OBL_EGRESS_SCRIPT=${script}`],
			HostConfig: { NetworkMode: NETWORK, RestartPolicy: { Name: 'unless-stopped' } },
			Labels: { 'obl.managed': 'true', 'obl.kind': 'egress' }
		});
		if (res.status === 201) {
			const created: { Id: string } = JSON.parse(res.body.toString());
			c = { Id: created.Id, State: 'created', Names: [EGRESS_NAME] };
		} else if (res.status === 409) {
			c = { Id: EGRESS_NAME, State: 'created', Names: [EGRESS_NAME] };
		} else {
			throw new Error(`egress proxy create failed ${res.status}: ${res.body.slice(0, 200)}`);
		}
	}
	if (!isRunning(c)) {
		// A network deleted while the proxy was down leaves a dead endpoint
		// Docker refuses to start past.
		await dropDeadNetworks(c.Id);
		await dockerRequest('POST', `/containers/${c.Id}/start`).catch(() => {});
	}
	// Already-attached networks answer 403 "already exists"; anything else is
	// the join the machine is waiting for.
	await dockerRequest('POST', `/networks/${network}/connect`, {
		Container: c.Id,
		EndpointConfig: { Aliases: [EGRESS_NAME] }
	}).catch(() => {});
	// The proxy needs working DNS: bot nets are internal (no upstream), so it
	// also joins the shared app network where 127.0.0.11 resolves. Without
	// this every machine-side apk/curl/npm fails 403 not-a-public-address.
	await dockerRequest(`POST`, `/networks/${NETWORK}/connect`, {
		Container: c.Id,
		EndpointConfig: { Aliases: [EGRESS_NAME] }
	}).catch(() => {});
}

/**
 * The egress proxy's address on one machine network, or null when it is not
 * attached. Machines point their resolver at it: the proxy's UDP forwarder is
 * the only DNS an internal network can reach.
 */
export async function egressIpOn(network: string): Promise<string | null> {
	const res = await dockerRequest('GET', `/networks/${network}`).catch(() => null);
	if (!res || res.status !== 200) return null;
	try {
		const info = JSON.parse(res.body.toString()) as {
			Containers?: Record<string, { Name?: string; IPv4Address?: string }>;
		};
		for (const ep of Object.values(info.Containers ?? {})) {
			if (ep.Name === EGRESS_NAME && ep.IPv4Address) return ep.IPv4Address.split('/')[0];
		}
	} catch {
		return null;
	}
	return null;
}

/** Make sure the bridge the VNC gateways live on exists. */
async function ensureGatewayNetwork(): Promise<void> {
	const res = await dockerRequest('POST', '/networks/create', {
		Name: GATEWAY_NETWORK,
		Labels: { 'obl.managed': 'true' }
	}).catch(() => null);
	// 201 created it; 409/403 means it already exists, which is fine.
	if (res && res.status !== 201 && res.status !== 409 && res.status !== 403) {
		throw new Error(`Docker network create failed ${res.status}: ${res.body.slice(0, 200)}`);
	}
}

/**
 * The networks a container is attached to, by name. The list endpoint does not
 * carry them, so this is the inspect - the same one dropDeadNetworks reads. An
 * unreadable inspect answers with an empty set, which reads as "attached to
 * nothing" and makes the caller re-join: a connect that was not needed answers
 * 403 and costs nothing, where a missed one is a gateway that cannot publish.
 */
async function attachedNetworks(containerId: string): Promise<Set<string>> {
	const res = await dockerRequest('GET', `/containers/${containerId}/json`).catch(() => null);
	if (!res || res.status !== 200) return new Set();
	try {
		const info = JSON.parse(res.body.toString()) as {
			NetworkSettings?: { Networks?: Record<string, unknown> };
		};
		return new Set(Object.keys(info.NetworkSettings?.Networks ?? {}));
	} catch {
		return new Set();
	}
}

/** The bot's gateway container, running or not, or null when it has none. */
async function findGateway(botId: string): Promise<ContainerInfo | null> {
	const res = await dockerRequest(
		'GET',
		`/containers/json?all=1&filters=${encodeURIComponent(
			JSON.stringify({ label: ['obl.kind=vncgate', `obl.bot=${botId}`] })
		)}`
	).catch(() => null);
	if (!res || res.status !== 200) return null;
	try {
		return (JSON.parse(res.body.toString()) as ContainerInfo[])[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Make sure the bot's VNC gateway exists, is running, and is joined to BOTH
 * the machine's network and the publishable bridge. `target` is the machine's
 * container name inside that network.
 *
 * The gateway is what makes the desktop watchable at all: a container on an
 * internal network cannot publish a port, so the machine's own binding for
 * websockify is silently dropped by Docker (`NetworkSettings.Ports` comes
 * back null). The gateway joins the internal network to reach the machine and
 * an ordinary bridge to be publishable, and forwards exactly one port to
 * exactly one target. It is not a route: Docker gives containers no
 * CAP_NET_ADMIN, so a machine cannot add a route towards the bridge even if
 * it wanted one, and the gateway's `ip_forward` is 0.
 *
 * Both attachments are re-checked on every call, not just at create: losing
 * the bridge is what strands a gateway on the internal network, and nothing
 * else in the lifecycle puts it back.
 */
export async function ensureVncGateway(
	botId: string,
	target: string,
	network: string
): Promise<void> {
	await ensureGatewayNetwork();
	const name = vncGatewayName(botId);
	let c = await findGateway(botId);
	if (!c) {
		const image = await selfImage();
		// The script travels through the environment, the way the egress
		// proxy's does, so the gateway does not depend on the image having the
		// file at a known path - only on a node binary, which the app image
		// always has and the fallback installs. Read at create time, so a
		// rebuilt forwarder reaches the next gateway without a rebuild here.
		const script = Buffer.from(readFileSync('vnc-gateway.mjs', 'utf8')).toString('base64');
		const res = await dockerRequest('POST', `/containers/create?name=${name}`, {
			Image: image,
			Cmd: [
				'sh',
				'-c',
				'command -v node >/dev/null 2>&1 || apk add --no-cache nodejs >/dev/null 2>&1; ' +
					'echo "$OBL_GATE_SCRIPT" | base64 -d > /tmp/obl-vncgate.mjs; ' +
					'exec node /tmp/obl-vncgate.mjs'
			],
			Env: [
				`GATE_PORT=${WEBSOCKIFY_PORT}`,
				`GATE_TARGET=${target}:${WEBSOCKIFY_PORT}`,
				`OBL_GATE_SCRIPT=${script}`
			],
			ExposedPorts: {
				[`${WEBSOCKIFY_PORT}/tcp`]: {}
			},
			HostConfig: {
				NetworkMode: GATEWAY_NETWORK,
				// Loopback only, like the machine's own binding used to be: the
				// viewer runs in a browser on this host, and nothing on the LAN
				// has any business reaching a sandbox's screen.
				PortBindings: {
					[`${WEBSOCKIFY_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }]
				},
				// Belt and braces on the one container that sits on both sides of
				// the boundary: it must never forward a packet between them.
				Sysctls: { 'net.ipv4.ip_forward': '0' },
				RestartPolicy: { Name: 'unless-stopped' }
			},
			Labels: { 'obl.managed': 'true', 'obl.kind': 'vncgate', 'obl.bot': botId }
		});
		if (res.status === 201) {
			const created: { Id: string } = JSON.parse(res.body.toString());
			c = { Id: created.Id, State: 'created', Names: [name] };
		} else if (res.status === 409) {
			// Another wake made it first; their container is the one we want.
			c = (await findGateway(botId)) ?? { Id: name, State: 'created', Names: [name] };
		} else {
			throw new Error(`vnc gateway create failed ${res.status}: ${res.body.slice(0, 200)}`);
		}
	}
	if (!isRunning(c)) {
		// Same dead-endpoint wedge as the egress proxy: a machine network
		// deleted while the gateway was down blocks its start.
		await dropDeadNetworks(c.Id);
		await dockerRequest('POST', `/containers/${c.Id}/start`).catch(() => {});
	}
	// The gateway must sit on BOTH bridges on every call, not just the
	// machine's. It is created on GATEWAY_NETWORK and joined to the machine
	// network afterwards, and dropDeadNetworks drops any attachment whose
	// network id no longer matches - so a bridge deleted and recreated under
	// the same name (a new id) leaves the gateway on the internal network
	// alone. There it can neither publish a port nor resolve a name, and the
	// panel reads a ready desktop as an absent one: the Wake button on an
	// awake machine, and a viewer torn down and rebuilt on every flap of the
	// port. Joining whichever is missing is idempotent - an attachment that is
	// already there answers 403 - so this runs on every wake and on every
	// status poll that finds no port. Docker maps the published port when the
	// bridge is joined, even on an already-running container, so the repair
	// needs no restart and the port the panel dials does not churn.
	const attached = await attachedLiveNetworks(c.Id);
	for (const net of [GATEWAY_NETWORK, network]) {
		if (attached.has(net)) continue;
		await dockerRequest('POST', `/networks/${net}/connect`, {
			Container: c.Id,
			EndpointConfig: { Aliases: [vncGatewayName(botId)] }
		}).catch(() => {});
	}
}

/**
 * The host port the bot's gateway is published on, or 0 when there is no
 * gateway, it is not running, or Docker bound nothing. The panel's RFB
 * websocket is what dials it, so a 0 has to mean "do not try".
 */
export async function vncGatewayPort(botId: string): Promise<number> {
	const c = await findGateway(botId);
	if (!c || !isRunning(c)) return 0;
	return (
		c.Ports?.find((p) => p.PrivatePort === WEBSOCKIFY_PORT && p.Type === 'tcp')?.PublicPort ?? 0
	);
}

/**
 * Drop a bot's network. Called when the bot is destroyed or reset. Every
 * endpoint on it goes first - the egress proxy, the VNC gateway, and the
 * machine container itself when one is still around: a network with live
 * endpoints cannot be deleted, and a stopped container's endpoint survives
 * the delete as a dead attachment the next start trips on.
 */
export async function removeMachineNetwork(botId: string): Promise<void> {
	const network = machineNetwork(botId);
	// The inspect names every endpoint, including the machine container the
	// caller may not have removed yet; the named pair below is the fallback
	// for a network the daemon will not show.
	const res = await dockerRequest('GET', `/networks/${network}`).catch(() => null);
	const endpoints: string[] = [];
	if (res && res.status === 200) {
		try {
			const info = JSON.parse(res.body.toString()) as {
				Containers?: Record<string, unknown>;
			};
			endpoints.push(...Object.keys(info.Containers ?? {}));
		} catch {
			// An unreadable inspect falls back to the known members below.
		}
	}
	for (const id of [...endpoints, EGRESS_NAME, vncGatewayName(botId)]) {
		await dockerRequest('POST', `/networks/${network}/disconnect`, {
			Container: id,
			Force: true
		}).catch(() => {});
	}
	await dockerRequest('DELETE', `/networks/${network}`).catch(() => {});
}

/**
 * Remove machine networks whose bot is gone. Part of the boot sweep alongside
 * orphaned containers and volumes.
 */
export async function removeOrphanNetworks(knownBotIds: Set<string>): Promise<number> {
	const res = await dockerRequest('GET', '/networks').catch(() => null);
	if (!res || res.status !== 200) return 0;
	let removed = 0;
	try {
		const nets = JSON.parse(res.body.toString()) as { Name: string; Id: string }[];
		for (const n of nets) {
			if (!n.Name.startsWith('obl-net-')) continue;
			const botId = n.Name.slice('obl-net-'.length);
			if (knownBotIds.has(botId)) continue;
			const before = await dockerRequest('GET', `/networks/${n.Id}`).catch(() => null);
			await removeMachineNetwork(botId);
			const after = await dockerRequest('GET', `/networks/${n.Id}`).catch(() => null);
			if (before?.status === 200 && (!after || after.status === 404)) removed++;
		}
	} catch {
		// An unreadable list removes nothing.
	}
	return removed;
}
