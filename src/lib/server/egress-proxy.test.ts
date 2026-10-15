import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { connect as tcpConnect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

/**
 * The egress proxy is the only door the bot machines have to the network, so
 * every refusal below is a thing a machine inside the lounge cannot reach, and
 * the two allows are traffic the machines exist to make. The script is
 * standalone and starts listening on import, so it is tested the way it is
 * deployed: spawned as a child process on a port nothing else holds, driven
 * over real sockets, and killed when the file is done.
 *
 * A plain-HTTP refusal is read from the body the proxy writes; a CONNECT
 * refusal is the status line of the tunnel answer, which arrives before any
 * payload, so the client hangs up as soon as it has the head.
 */

const PROXY = fileURLToPath(new URL('../../../egress-proxy.mjs', import.meta.url));
// A path that does not exist would make every spawn below fail, which the
// start-up below would read as "no proxy here" and skip the whole file: the
// suite would then go green having tested nothing. The script is named, so it
// is here or the file is wrong.
if (!existsSync(PROXY)) throw new Error(`egress proxy not found at ${PROXY}`);

/** How long to give the child to bind, and any one proxy answer to arrive. */
const READY_TIMEOUT = 10_000;
const ANSWER_TIMEOUT = 10_000;

/** Whether a TCP connection to host:port completes - nothing is sent. */
function canConnect(port: number, host: string, timeoutMs = 4_000): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = tcpConnect(port, host);
	const finish = (ok: boolean) => {
		socket.destroy();
		resolve(ok);
	};
	socket.setTimeout(timeoutMs, () => finish(false));
	socket.once('connect', () => finish(true));
	socket.once('error', () => finish(false));
	return promise;
}

/** A plain-HTTP proxy request: the request line carries the absolute URI. */
function proxyGet(port: number, absoluteUri: string): Promise<{ status: number; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
	const req = http.request(
		{
			host: '127.0.0.1',
			port,
			method: 'GET',
			path: absoluteUri,
			agent: false,
			headers: { host: new URL(absoluteUri).host, connection: 'close' }
		},
		(res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
		}
	);
	req.on('error', reject);
	req.end();
	return promise;
}

/**
 * A CONNECT attempt, read by hand: the answer comes as a status line and the
 * socket is closed as soon as the head is in - for an allowed target too, so
 * no payload is ever sent to the far end.
 */
function proxyConnect(port: number, authority: string, timeoutMs = ANSWER_TIMEOUT): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const socket = tcpConnect(port, '127.0.0.1');
	let head = '';
	let settled = false;
	const finish = (err?: Error) => {
		if (settled) return;
		settled = true;
		socket.destroy();
		if (err) reject(err);
		else resolve(head);
	};
	socket.setTimeout(timeoutMs, () =>
		finish(new Error(`no answer for CONNECT ${authority} in ${timeoutMs}ms`))
	);
	socket.on('data', (chunk) => {
		head += chunk.toString('utf8');
		if (head.includes('\r\n\r\n')) finish();
	});
	socket.on('error', (e) => finish(e));
	socket.once('close', () => finish(new Error(`socket closed before an answer for ${authority}`)));
	socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
	return promise;
}

/** Whether this port is unheld on this address right now. */
function isFree(port: number, host: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const probe = createServer();
	probe.once('error', () => resolve(false));
	probe.listen(port, host, () => probe.close(() => resolve(true)));
	return promise;
}

/**
 * A port nothing holds on either the wildcard address the proxy binds or the
 * loopback the tests dial. Both are asked for because the two can be held at
 * once: a listener on 127.0.0.1:P does not stop one on 0.0.0.0:P, and it is
 * the loopback client that would then reach the stranger.
 */
async function pickPort(): Promise<number | null> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const candidate = 40_000 + Math.floor(Math.random() * 20_000);
		if ((await isFree(candidate, '0.0.0.0')) && (await isFree(candidate, '127.0.0.1'))) return candidate;
	}
	return null;
}

/**
 * Wait until the child is serving. The script announces itself from inside its
 * listen callback, so that line is the signal: a child that failed to bind -
 * the port was not free after all - exits instead of printing it. Nothing
 * in-process can hurry a real child, so the deadline below is a real clock; it
 * bounds the wait, it does not pace it.
 */
async function waitForListening(proc: ChildProcess, port: number): Promise<'listening' | 'gone'> {
	const announced = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	let exited = false;
	proc.stdout?.on('data', (chunk: Buffer) => {
		if (chunk.toString('utf8').includes(`listening on :${port}`)) announced.resolve();
	});
	// The DNS forwarder's failure to bind UDP 53 is not this file's business.
	proc.stderr?.on('data', () => {});
	proc.once('exit', () => {
		exited = true;
		stopped.resolve();
	});

	const deadline = setTimeout(() => stopped.resolve(), READY_TIMEOUT);
	await Promise.race([announced.promise, stopped.promise]);
	clearTimeout(deadline);
	return exited ? 'gone' : 'listening';
}

/**
 * Whether the port really answers as this proxy. The announce line is not
 * enough: a stranger bound to the loopback can hold the port alongside this
 * child bound to the wildcard, and its reply - a 200, say - would read as the
 * proxy failing a policy it in fact enforces. The proxy's own refusal, body
 * and all, is a signature no stranger answers with.
 */
async function isOurProxy(port: number): Promise<boolean> {
	try {
		const res = await proxyGet(port, 'http://127.0.0.1/');
		return res.status === 403 && res.body === 'destination is not a public address';
	} catch {
		return false;
	}
}

let child: ChildProcess | null = null;
let port = 0;
/** False when the proxy could not be started here; every test then skips. */
let ready = false;
/** Whether the far side of the allow test's tunnels is reachable from here. */
let webReachable = false;
let sshReachable = false;

/**
 * Start the proxy on a port of our own and leave it running.
 *
 * `ok` when it is up and answering as itself. `gone` when no port could be
 * had - the port was held by the time the child bound it, so it exited - which
 * is the environment's problem and leaves the tests to skip. `notours` when
 * something is on the port but does not answer as the proxy: with both
 * addresses checked free beforehand this is the proxy misbehaving rather than
 * a stranger, and the caller turns it into a failure instead of hiding it.
 */
async function startProxy(): Promise<'ok' | 'gone' | 'notours'> {
	const candidate = await pickPort();
	if (candidate === null) return 'gone';
	const proc = spawn(process.execPath, [PROXY], {
		env: { ...process.env, EGRESS_PORT: String(candidate) },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	if ((await waitForListening(proc, candidate)) === 'gone') return 'gone';
	if (await isOurProxy(candidate)) {
		port = candidate;
		child = proc;
		ready = true;
		return 'ok';
	}
	proc.kill('SIGKILL');
	return 'notours';
}

beforeAll(async () => {
	const attempts: ('ok' | 'gone' | 'notours')[] = [];
	for (let attempt = 0; attempt < 3 && !ready; attempt++) attempts.push(await startProxy());
	if (!ready) {
		// A free port that the proxy then failed to answer on is a real fault,
		// not a missing one: skipping here would report a broken proxy as a
		// clean run. Only an environment with no port at all gets to skip.
		if (attempts.includes('notours')) {
			throw new Error('the egress proxy came up but did not answer as itself');
		}
		console.warn('egress proxy did not start here; its tests are skipped');
		return;
	}
	webReachable = await canConnect(443, '1.1.1.1');
	sshReachable = await canConnect(22, 'github.com');
}, 60_000);

afterAll(async () => {
	const proc = child;
	if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
	// SIGKILL: the script installs no signal handlers, and a test run must not
	// be left holding a live listener because a graceful exit was ignored.
	const exited = Promise.withResolvers<void>();
	proc.once('exit', () => exited.resolve());
	proc.kill('SIGKILL');
	await exited.promise;
});

/** A test that needs the proxy: skipped wholesale if it never came up. */
function itProxied(
	name: string,
	fn: (ctx: TestContext) => Promise<void>,
	timeout = ANSWER_TIMEOUT
) {
	it(
		name,
		async (ctx) => {
			if (!ready) return ctx.skip();
			await fn(ctx);
		},
		timeout
	);
}

/** A refusal is the 403 line, and nothing was tunneled. */
function expectRefused(head: string) {
	expect(head.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
	expect(head).not.toContain('200 Connection Established');
}

const firstLine = (head: string) => head.split('\r\n')[0];

describe('egress proxy', () => {
	describe('plain HTTP', () => {
		itProxied('refuses a destination that is not a public address', async () => {
			// The lounge's own gateway is the address a machine would reach the
			// app, the panel and every other machine through.
			const res = await proxyGet(port, 'http://192.168.1.1/');
			expect(res.status).toBe(403);
			expect(res.body).toBe('destination is not a public address');
		});

		itProxied('allows a non-web port on a public host', async () => {
			// The port list is gone: any port to a public host is honoured, and
			// what used to refuse 8080 is now the destination check - which a
			// public address passes. The socket dials the public host on 8080,
			// and whatever answers on the far side answers this proxy request.
			const res = await proxyGet(port, 'http://1.1.1.1:8080/');
			// The upstream may be unreachable from the test host; what is under
			// test is that the proxy did not refuse the port.
			expect(res.status).not.toBe(403);
			expect(res.body).not.toBe('destination is not a public address');
		});
	});

	describe('CONNECT', () => {
		itProxied('refuses a private host even on 22, where ssh used to be the carve-out', async () => {
			// Port 22 lost its special status with the port list: every port now
			// answers to the destination check alone, so a LAN sshd is refused
			// exactly as a LAN web server is.
			expectRefused(await proxyConnect(port, '192.168.1.1:22'));
		});

		// The addresses a machine must never reach: loopback (the proxy itself
		// and anything else on the host), RFC1918 and CGNAT (the LAN and the
		// tunnel range), and the link-local metadata endpoint. The metadata one
		// is asked for on 22 as well, since ssh is a tunnel port now.
		const OFF_LIMITS: [string, number][] = [
			['127.0.0.1', 443],
			['10.0.0.1', 443],
			['172.16.0.1', 443],
			['192.168.1.1', 443],
			['169.254.169.254', 22],
			['100.64.0.1', 443]
		];
		for (const [host, targetPort] of OFF_LIMITS) {
			itProxied(`refuses ${host}:${targetPort}`, async () => {
				expectRefused(await proxyConnect(port, `${host}:${targetPort}`));
			});
		}

		// The opens-egress behaviour: with the port list gone, any port to a
		// public host tunnels. 22 is still the port a machine needs by name
		// (ssh ignores the proxy environment), but it is no longer the only
		// non-web one. If the public ones are refused, the machines' egress is
		// broken wholesale.
		itProxied(
			'opens a tunnel to a public host on 443, on ssh 22, and on an arbitrary port',
			async (ctx) => {
				if (!webReachable && !sshReachable) {
					return ctx.skip('no route to the upstreams from here');
				}
				if (webReachable) {
					expect(firstLine(await proxyConnect(port, '1.1.1.1:443'))).toBe(
						'HTTP/1.1 200 Connection Established'
					);
				}
				if (sshReachable) {
					// By name, the way ssh asks: the name is resolved and checked,
					// and the tunnel is opened to the checked address.
					expect(firstLine(await proxyConnect(port, 'github.com:22'))).toBe(
						'HTTP/1.1 200 Connection Established'
					);
				}
				// Not web, not ssh: 8080 on a public address answers 200 (the
				// tunnel opens) or closes - but never the 403 the port list used
				// to answer.
				if (webReachable) {
					expect(
						['HTTP/1.1 200 Connection Established', 'socket closed before an answer for 1.1.1.1:8080']
					).toContain(firstLine(await proxyConnect(port, '1.1.1.1:8080', 4_000)));
				}
			},
			30_000
		);

		// IPv6 is refused unless it is global unicast: the loopback, the
		// link-local range, unique-local (the IPv6 LAN), multicast, the
		// unspecified address, and an IPv4-mapped private address dressed up as
		// IPv6.
		const OFF_LIMITS_V6 = [
			'[::1]:443',
			'[fe80::1]:443',
			'[fd00::1]:443',
			'[ff02::1]:443',
			'[::]:443',
			'[::ffff:10.0.0.1]:443'
		];
		for (const authority of OFF_LIMITS_V6) {
			itProxied(`refuses ${authority}`, async () => {
				expectRefused(await proxyConnect(port, authority));
			});
		}

		itProxied('refuses a name that resolves to a private address', async () => {
			// Anti-rebinding: the name is resolved here and every answer must be
			// public, so a name that points at the loopback is refused even
			// though the name itself says nothing about where it goes.
			expectRefused(await proxyConnect(port, 'localhost:443'));
		});
	});
});
