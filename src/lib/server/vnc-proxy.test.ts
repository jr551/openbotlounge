import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';

/**
 * The screen panel's websocket relay, driven over real sockets.
 *
 * The bug this defends against is the one the panel shipped with: the browser
 * dialled the machine's gateway port directly, and that port is published on
 * the app host's loopback, so the socket could never open and the screen stayed
 * blank. The relay is what makes the panel work, so the tests below are the
 * panel's own path: an upgrade on /api/bots/<id>/vnc-ws, the same session
 * cookie the rest of the app checks, and bytes carried both ways.
 *
 * Everything is a real socket - a real http server, a real upstream standing in
 * for websockify - because the parts that broke here were the parts a mocked
 * stream would not have had: a paused socket that never emitted its handshake,
 * and a pair where one end closing left the other held open.
 */

// auth.ts derives its signing secret at import time, so config has to be pinned
// before the module - and the relay that imports it - is evaluated. That is the
// one thing here a static import cannot do.
config.sessionSecret = 'relay-test-secret';
config.password = 'relay-test-pw';

const { gatewayPort } = vi.hoisted(() => ({ gatewayPort: { value: 0 } }));
const { knownBots } = vi.hoisted(() => ({ knownBots: new Set<string>() }));

vi.mock('./machine-net', () => ({
	// The real one asks Docker; the port it would answer with is what matters.
	vncGatewayPort: vi.fn(async (botId: string) => (knownBots.has(botId) ? gatewayPort.value : 0))
}));

const { attachVncProxy } = await import('./vnc-proxy');
const { createBot } = await import('./db');

/**
 * The two bots every test dials: one whose machine has a gateway, and one that
 * has none. Real rows, because the relay asks the database whether a bot exists
 * before it dials anything - an unknown id is refused, not dialled for.
 */
const BOT = createBot({ name: 'Has a gateway', persona: '', avatar: '', color: '', model: '', badge: '' }).id;
const OTHER = createBot({ name: 'No gateway', persona: '', avatar: '', color: '', model: '', badge: '' }).id;
const PASSWORD = 'relay-test-pw';

/**
 * How long any one step below is given before it is called a failure. The
 * upgrade, the byte relay and the teardown are each awaited on a real socket
 * rather than slept on, but a loaded machine still stretches the handshake
 * well past the 5s default - and a timeout there is indistinguishable from a
 * relay that never answered, which is the one thing these tests exist to
 * detect. So every step that dials gets this budget explicitly.
 */
const STEP_TIMEOUT = 8000;

/**
 * What the two hooks get. They bind and unbind two servers; on a loaded
 * machine that can outrun the 10s default, and a hook that times out takes the
 * whole file down with it - including the tests that never ran.
 */
const HOOK_TIMEOUT = 20_000;

/**
 * How long the close in afterAll is given before the leftover connections are
 * destroyed out from under it. Well past any clean close, short enough that a
 * leaked pair fails the file rather than hanging the run.
 */
const CLOSE_TIMEOUT = 5000;

/**
 * How long the teardown below waits for the machine's side to be dropped
 * before calling it a leak. Long enough that a loaded machine cannot produce a
 * false failure, short enough that a real leak fails the test rather than the
 * file's own timeout.
 */
const TEARDOWN_TIMEOUT = 4000;

/** A stand-in for websockify: answers the upgrade, greets, then echoes. */
function fakeGateway(): Server {
	const server = createServer();
	server.on('upgrade', (req, socket) => {
		const key = req.headers['sec-websocket-key'] as string;
		const accept = createHash('sha1')
			.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
			.digest('base64');
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
		);
		// The desktop's first message, the way websockify sends it.
		socket.write(Buffer.from('RFB 003.008\n', 'latin1'));
		// Anything the viewer sends comes back, so a frame that reached the
		// machine can be recognised on its return.
		socket.on('data', (chunk) => socket.write(chunk));
		// Nothing here closes on its own. A real server holds its side open
		// until something tears it down - an upgraded socket is created with
		// allowHalfOpen, so a peer hanging up only ends this side - and taking
		// the machine's side down is the relay's job, which is what the drop
		// test below watches for. A socket that closed itself here would do
		// the relay's work for it and hide a leak.
		socket.on('error', () => {});
	});
	return server;
}

/** A signed session cookie, forged with the secret pinned above. */
function cookie(): string {
	const ts = Date.now().toString();
	return `obl_session=${ts}.${createHmac('sha256', 'relay-test-secret').update(ts).digest('hex')}`;
}

/** A cookie signed with a timestamp far outside its window. */
function expiredCookie(): string {
	const ts = (Date.now() - 40 * 24 * 60 * 60 * 1000).toString();
	return `obl_session=${ts}.${createHmac('sha256', 'relay-test-secret').update(ts).digest('hex')}`;
}

interface UpgradeResult {
	status: 'relayed' | 'refused' | 'timeout' | string;
	payload: string;
}

/**
 * Dial the relay's path and read what comes back. The handshake is spoken by
 * hand for the same reason the relay speaks it by hand: no websocket client is
 * available to either, and a real one would hide the framing.
 *
 * A live relay holds its socket open, so the happy path resolves as soon as the
 * desktop's bytes arrive rather than waiting for a close that never comes.
 */
function upgrade(
	port: number,
	botId: string,
	options: { cookie?: string; thenSend?: string } = {}
): Promise<UpgradeResult> {
	return new Promise((resolve) => {
		const key = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
		const socket = net.connect(port, '127.0.0.1');
		let payload = '';
		let upgraded = false;
		let headEnd = 0;
		const finish = (status: string) => {
			socket.destroy();
			resolve({ status, payload });
		};
		socket.setTimeout(STEP_TIMEOUT, () => finish('timeout'));
		socket.on('error', (e) => finish(`socket-error ${(e as NodeJS.ErrnoException).code ?? ''}`));
		socket.on('connect', () => {
			socket.write(
				`GET /api/bots/${botId}/vnc-ws HTTP/1.1\r\n` +
					`Host: 127.0.0.1:${port}\r\n` +
					'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
					`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
					(options.cookie ? `Cookie: ${options.cookie}\r\n` : '') +
					'\r\n'
			);
		});
		socket.on('data', (chunk) => {
			payload += chunk.toString('latin1');
			if (!upgraded) {
				const end = payload.indexOf('\r\n\r\n');
				if (end === -1) return;
				// Anything that is not a 101 is a refusal, which the close below
				// reports - the socket goes away without the handshake.
				if (!payload.startsWith('HTTP/1.1 101 ')) return;
				upgraded = true;
				headEnd = end + 4;
				if (options.thenSend) socket.write(options.thenSend);
			}
			// Past the handshake. The plain tests wait for the desktop's own
			// first bytes: they are a separate write from the 101, so resolving
			// on the handshake would hand them a payload the banner had not
			// reached yet. The round-trip test waits for its frame to come back.
			if (options.thenSend ? payload.includes(options.thenSend) : payload.length > headEnd) {
				finish('relayed');
			}
		});
		// A refusal is the socket closing with no 101 ever written.
		socket.on('close', () => finish(upgraded ? 'relayed' : 'refused'));
	});
}

/**
 * Every socket either server has accepted, upgraded ones included.
 *
 * `server.closeAllConnections()` cannot stand in for this: an upgrade takes
 * the socket out of the http server's connection tracking, so the relay's own
 * pair is invisible to it and `close()` then waits on it forever. Holding the
 * sockets here is what makes the teardown below reach them.
 */
const sockets = new Set<Socket>();
function trackConnections(server: Server): void {
	server.on('connection', (s: Socket) => {
		sockets.add(s);
		s.on('close', () => sockets.delete(s));
	});
}

/**
 * Close a server once nothing is holding it, bounded. Past CLOSE_TIMEOUT the
 * sockets are destroyed and the close is awaited to completion, so a leak in a
 * test above fails the file instead of hanging the hook - which is what the
 * pair this file is about did when nothing tore it down.
 */
async function closeServer(server: Server): Promise<void> {
	const closed = new Promise<void>((r) => server.close(() => r()));
	const { promise: expired, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, CLOSE_TIMEOUT);
	try {
		await Promise.race([closed, expired]);
	} finally {
		clearTimeout(timer);
	}
	for (const s of sockets) s.destroy();
	await closed;
}

let app: Server;
let gateway: Server;
let appPort = 0;

beforeAll(async () => {
	gateway = fakeGateway();
	trackConnections(gateway);
	await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
	gatewayPort.value = (gateway.address() as AddressInfo).port;

	app = createServer((_req, res) => res.end('ok'));
	attachVncProxy(app);
	trackConnections(app);
	await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
	appPort = (app.address() as AddressInfo).port;
}, HOOK_TIMEOUT);

afterAll(async () => {
	// Both closes are bounded and then forced, so a pair any test left behind
	// cannot hang this hook - the sockets are held above precisely because the
	// relay's own upgraded pair is invisible to closeAllConnections.
	await Promise.all([closeServer(app), closeServer(gateway)]);
}, HOOK_TIMEOUT);

beforeEach(() => {
	knownBots.clear();
	knownBots.add(BOT);
	config.password = PASSWORD;
});

afterEach(() => {
	config.password = PASSWORD;
});

describe('the relay the screen panel dials', () => {
	it('carries the desktop to an authenticated viewer', async () => {
		const result = await upgrade(appPort, BOT, { cookie: cookie() });
		// The banner is the desktop's own first message, relayed verbatim.
		expect(result.status).toBe('relayed');
		expect(result.payload).toContain('RFB 003.008');
	});

	it('relays in both directions, not just one', async () => {
		// The echo only comes back if the viewer-to-machine pipe is wired too.
		const result = await upgrade(appPort, BOT, {
			cookie: cookie(),
			thenSend: 'PING-FROM-VIEWER'
		});
		expect(result.status).toBe('relayed');
		expect(result.payload).toContain('PING-FROM-VIEWER');
	});

	it('refuses a viewer with no session cookie while the gate is on', async () => {
		const result = await upgrade(appPort, BOT);
		expect(result.status).toBe('refused');
		expect(result.payload).not.toContain('101');
	});

	it('refuses a forged cookie', async () => {
		const result = await upgrade(appPort, BOT, {
			cookie: `obl_session=${Date.now()}.${'0'.repeat(64)}`
		});
		expect(result.status).toBe('refused');
	});

	it('refuses an expired cookie', async () => {
		const result = await upgrade(appPort, BOT, { cookie: expiredCookie() });
		expect(result.status).toBe('refused');
	});

	it('refuses a bot that has no gateway, and keeps serving', async () => {
		const result = await upgrade(appPort, OTHER, { cookie: cookie() });
		expect(result.status).toBe('refused');
		// A refused upgrade is not a crash: the app still answers.
		expect(await fetch(`http://127.0.0.1:${appPort}/`).then((r) => r.status)).toBe(200);
	});

	it('refuses a bot that does not exist', async () => {
		const result = await upgrade(appPort, 'no-such-bot', { cookie: cookie() });
		expect(result.status).toBe('refused');
	});

	it('leaves an upgrade that is not its path to another listener', async () => {
		// Anything else must reach the app untouched, so a later websocket
		// feature still sees its own upgrades. The stand-in below ends the
		// socket the way an owner of the path would, which is also what makes
		// the dial below return instead of waiting for an answer nobody sends.
		const seen: string[] = [];
		const other = (req: { url?: string }, socket: Socket) => {
			seen.push(req.url ?? '');
			socket.destroy();
		};
		app.on('upgrade', other);
		try {
			const result = await upgrade(appPort, `${BOT}/extra`, { cookie: cookie() });
			expect(result.status).toBe('refused');
			expect(seen).toContain(`/api/bots/${BOT}/extra/vnc-ws`);
		} finally {
			app.off('upgrade', other);
		}
	});

	it('lets the viewer in with no cookie at all when no password is set', async () => {
		config.password = '';
		const result = await upgrade(appPort, BOT);
		expect(result.status).toBe('relayed');
		expect(result.payload).toContain('RFB 003.008');
	});

	it('drops the machine side when the viewer leaves', async () => {
		// A half-open pair would hold the machine's websockify connection open
		// after the viewer closed the tab - a leak per viewer. The viewer below
		// hangs up cleanly, the way a closing tab does.
		//
		// The relay's own socket for this viewer is what the test watches, and
		// it is the only observable that can show the leak: an upgraded socket
		// is created with allowHalfOpen, so the viewer's FIN merely *ends* it -
		// nothing closes it by itself. The relay's `end` handler is what
		// destroys the machine's side, and that upstream going away is in turn
		// what closes this socket. So this socket closing is proof the machine's
		// side was dropped, and a relay that wired no teardown leaves it open
		// for good - one dialled-in websockify per closed tab.
		const relaySocket = Promise.withResolvers<Socket>();
		const sawRelay = (s: Socket) => relaySocket.resolve(s);
		app.on('connection', sawRelay);
		try {
			const key = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
			const viewer = net.connect(appPort, '127.0.0.1');
			await once(viewer, 'connect');
			viewer.write(
				`GET /api/bots/${BOT}/vnc-ws HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
					'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
					`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
					`Cookie: ${cookie()}\r\n\r\n`
			);
			// The desktop's banner only arrives once the relay is fully wired,
			// so this is the point at which the pair is live.
			await once(viewer, 'data');
			const relay = await relaySocket.promise;
			viewer.end();
			// Awaited, not slept on: a teardown that never happens fails here
			// rather than passing on a quiet box and flaking under load. The wait
			// is bounded so the failure names the leak rather than being a bare
			// timeout, and the bound is cleared either way.
			const { promise: expired, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, TEARDOWN_TIMEOUT);
			const dropped = await Promise.race([
				once(relay, 'close').then(() => true),
				expired.then(() => false)
			]);
			clearTimeout(timer);
			expect(dropped).toBe(true);
		} finally {
			app.off('connection', sawRelay);
		}
	}, STEP_TIMEOUT);
});
