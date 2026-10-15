import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { SESSION_COOKIE, validSession } from './auth';
import { getBot } from './db';
import { vncGatewayPort } from './machine-net';

/**
 * The door between the browser's RFB websocket and a bot's desktop.
 *
 * A machine's websockify is published on the *host's* loopback
 * (`127.0.0.1:<ephemeral>`, see vncGatewayPort) - deliberately, so nothing on
 * the LAN can reach a sandbox's screen. The browser is not on that host, so it
 * cannot dial the port itself, which is why the panel used to sit blank. This
 * relay gives it a same-origin path instead: the app dials loopback on its own
 * behalf (it shares the network namespace the port is bound in) and pipes the
 * connection through, behind the same session cookie every /api route already
 * requires.
 *
 * The websocket is spoken on both hops and relayed as opaque bytes - the
 * framing is symmetric, so no frame is ever parsed. That is also why the
 * handshakes are done by hand rather than with a websocket library: the app
 * ships no third-party runtime dependency (see vnc-gateway.mjs, which is
 * standalone for the same reason), and the part actually needed - read a key,
 * answer 101 - is a dozen lines.
 *
 * Per-message deflate is deliberately never offered on either hop: negotiating
 * it on one side and not the other would leave the frames we pass through
 * compressed on one end and raw on the other. Without it both ends speak plain
 * frames, which is what makes relaying them verbatim correct.
 */

/** The path the panel dials: `/api/bots/<botId>/vnc-ws`. */
const PREFIX = '/api/bots/';
const SUFFIX = '/vnc-ws';

/**
 * websockify's own path. It answers a handshake on any path, so this is for
 * the log's benefit rather than a requirement.
 */
const GATEWAY_PATH = '/websockify';

/** The published port is bound on the host's loopback, where this process runs. */
const GATEWAY_HOST = '127.0.0.1';

/** RFC 6455's handshake GUID. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * How long the machine's side has to answer the handshake. A gateway that
 * accepts and then says nothing would otherwise hold the viewer's socket open
 * for as long as the tab is.
 */
const HANDSHAKE_TIMEOUT_MS = 5000;

const accept = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

/** The bot a relay path names, or null for anything that is not one. */
function botIdOf(pathname: string): string | null {
	if (!pathname.startsWith(PREFIX) || !pathname.endsWith(SUFFIX)) return null;
	const id = pathname.slice(PREFIX.length, -SUFFIX.length);
	return id && !id.includes('/') ? id : null;
}

/**
 * One cookie out of a Cookie header. The value is opaque - it is the signed
 * session token and nothing here reads it - so no decoding happens.
 */
function cookieValue(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
}

/**
 * Open the machine's side and finish its handshake, so a dead or missing
 * gateway is a failed handshake rather than a 101 followed by silence.
 * Bytes past the headers are pushed back onto the socket: websockify starts
 * forwarding the desktop's banner the moment it connects, so a frame can
 * already be waiting.
 */
function dialGateway(port: number): Promise<Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<Socket>();
	const socket = connect({ host: GATEWAY_HOST, port });
	const key = randomBytes(16).toString('base64');
	let buffered = Buffer.alloc(0);
	const fail = (why: string) => {
		socket.destroy();
		reject(new Error(why));
	};
	socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail('gateway handshake timed out'));
	socket.on('error', (e) => fail(e.message));
	socket.on('connect', () => {
		socket.write(
			`GET ${GATEWAY_PATH} HTTP/1.1\r\n` +
				`Host: ${GATEWAY_HOST}:${port}\r\n` +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Key: ${key}\r\n` +
				'Sec-WebSocket-Version: 13\r\n' +
				'\r\n'
		);
	});
	// The handshake is read here, not piped: the headers have to be parsed
	// before the viewer is told the machine answered, and everything after
	// them is handed on as-is. The read is paused the moment the headers are
	// complete - synchronously, inside this handler - so the frames already
	// buffered behind them are not emitted into nothing while the relay is
	// still being set up. pipe() resumes it afterwards.
	socket.on('data', (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		const end = buffered.indexOf('\r\n\r\n');
		if (end === -1) return;
		socket.pause();
		const status = buffered.subarray(0, buffered.indexOf('\r\n')).toString('latin1');
		if (!/^HTTP\/1\.1 101 /.test(status)) return fail(`gateway refused: ${status}`);
		socket.removeAllListeners('data');
		socket.removeAllListeners('error');
		socket.setTimeout(0);
		const rest = buffered.subarray(end + 4);
		if (rest.length) socket.unshift(rest);
		resolve(socket);
	});
	return promise;
}

async function relay(botId: string, req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
	// Held back until the machine's side is up: a viewer that talked into a 101
	// we had not sent yet would have those bytes dropped on the floor.
	socket.pause();
	try {
		// The same gate as every /api route. validSession answers yes for
		// everyone when the app has no password, which is the same as auth
		// being off.
		if (!validSession(cookieValue(req.headers.cookie, SESSION_COOKIE))) {
			socket.destroy();
			return;
		}
		// Only a real bot has a gateway to serve: an unknown id is refused
		// rather than dialled for.
		if (!getBot(botId)) {
			socket.destroy();
			return;
		}
		const port = await vncGatewayPort(botId);
		if (!port) {
			socket.destroy();
			return;
		}

		const key = req.headers['sec-websocket-key'];
		if (typeof key !== 'string') {
			socket.destroy();
			return;
		}

		const upstream = await dialGateway(port);

		// The client's own 101. A subprotocol is echoed when one was offered:
		// a browser fails the connection outright if it asked for one and the
		// answer names none. noVNC offers none by default, so this is for
		// every other viewer that might dial the same path.
		const offered = req.headers['sec-websocket-protocol'];
		const protocol = typeof offered === 'string' ? offered.split(',')[0].trim() : '';
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${accept(key)}\r\n` +
				(protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
				'\r\n'
		);

		// RFB is a stream of small frames; Nagle would add a round trip to
		// every mouse move.
		socket.setNoDelay(true);
		upstream.setNoDelay(true);
		// Either end going away takes the other with it: a half-open pair would
		// hold the machine's websockify connection open after the viewer left.
		// `end` matters as much as `close` here - an upgraded socket is created
		// with allowHalfOpen, so a viewer that hangs up cleanly only ends its
		// side, and waiting for `close` would leave the machine dialled in for
		// as long as its websockify felt like staying up.
		const drop = () => {
			socket.destroy();
			upstream.destroy();
		};
		socket.on('error', drop);
		upstream.on('error', drop);
		socket.on('end', () => upstream.destroy());
		upstream.on('end', () => socket.destroy());
		socket.on('close', () => upstream.destroy());
		upstream.on('close', () => socket.destroy());
		// Any bytes the client sent with its handshake, then both directions.
		// pipe resumes the paused client socket, so nothing is read before the
		// handshake bytes are in front of it.
		if (head.length) upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	} catch (e) {
		// A machine that is asleep, a gateway that is gone: the viewer retries
		// on its own, so this is a line in the log rather than a crash.
		console.error(`vnc relay ${botId} failed: ${(e as Error).message}`);
		socket.destroy();
	}
}

/** Servers already carrying the relay, so attaching twice cannot double it. */
const attached = new WeakSet<HttpServer>();

/**
 * Handle `/api/bots/<id>/vnc-ws` upgrades on the app's own http server. Any
 * other path is left untouched, so another upgrade handler - there is none
 * today - still sees it.
 */
export function attachVncProxy(server: HttpServer): void {
	if (attached.has(server)) return;
	attached.add(server);
	server.on('upgrade', (req, socket, head) => {
		const id = botIdOf((req.url ?? '').split('?')[0]);
		if (!id) return;
		// Node types an upgrade's socket as a bare Duplex, but it is always the
		// connection's net.Socket - which is what setNoDelay below needs.
		void relay(id, req, socket as Socket, head);
	});
}

/**
 * Attach to the server behind a request.
 *
 * adapter-node hands the raw `IncomingMessage` over as `platform.req` for every
 * request it serves, and the server that owns it is one property away, so the
 * relay can be attached from inside the app - where it shares the app's own
 * module instances, which matters: with SESSION_SECRET unset the session
 * signing key is a per-boot random value, so a relay that re-derived the check
 * anywhere else would refuse every valid cookie.
 *
 * It is attached on the first request rather than at import time because the
 * handler module is evaluated before the server that will serve it exists. An
 * upgrade can only follow a page load, so by the time a viewer dials this the
 * listener is always in place - and the panel retries, so even that race would
 * heal itself.
 */
export function attachVncProxyFrom(req: unknown): void {
	const server = (req as { socket?: { server?: HttpServer } } | undefined)?.socket?.server;
	if (server) attachVncProxy(server);
}
