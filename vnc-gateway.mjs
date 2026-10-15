/**
 * The one-port door onto a bot's desktop.
 *
 * A machine sits on its own `internal` network, so Docker refuses to publish
 * its websockify port: `docker inspect` reports the binding in HostConfig but
 * NetworkSettings.Ports comes back null and the browser's RFB websocket has
 * nowhere to go. This container is the fix - it is joined to the machine's
 * internal network (so `obl-machine-<id>:6080` resolves and answers) and to
 * one ordinary bridge network (so Docker can bind `127.0.0.1:<ephemeral>` on
 * the host for the browser).
 *
 * It is deliberately not a forwarder of anything else: one listener, one
 * fixed target, both baked in at create time. The machine gains nothing from
 * it - the machine cannot add a route to the bridge network (Docker does not
 * give containers CAP_NET_ADMIN, and the internal network has no default
 * route to add one to), this container does not route (`ip_forward` is 0, and
 * it never listens for anything but its one port), and the published port is
 * loopback-only, so nothing on the LAN can reach it either.
 *
 * Standalone on purpose: it runs inside the app image with `node
 * vnc-gateway.mjs`, so it may import nothing outside net:.
 */
import net from 'node:net';

const PORT = Number(process.env.GATE_PORT ?? 6080);
const TARGET = process.env.GATE_TARGET ?? '';
const cut = TARGET.lastIndexOf(':');
const HOST = cut > 0 ? TARGET.slice(0, cut) : '';
const TARGET_PORT = Number(TARGET.slice(cut + 1));
if (!HOST || !Number.isInteger(TARGET_PORT) || TARGET_PORT <= 0) {
	console.error(`GATE_TARGET must be host:port, got ${JSON.stringify(TARGET)}`);
	process.exit(1);
}

const server = net.createServer((client) => {
	// RFB is a thin stream of small frames; Nagle would add a round trip to
	// every mouse move.
	client.setNoDelay(true);
	const upstream = net.connect(TARGET_PORT, HOST);
	upstream.setNoDelay(true);
	// Either end going away takes the other with it: a half-open pair would
	// hold the machine's websockify connection open after the viewer left.
	const drop = () => {
		client.destroy();
		upstream.destroy();
	};
	client.on('error', drop);
	upstream.on('error', drop);
	client.on('close', () => upstream.destroy());
	upstream.on('close', () => client.destroy());
	client.pipe(upstream);
	upstream.pipe(client);
});

// A listener that cannot bind is fatal, not something to retry quietly: the
// published port would accept connections into a void. Docker's restart
// policy picks the container back up.
server.on('error', (e) => {
	console.error(`vnc gateway failed: ${e.message}`);
	process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`obl-vnc-gateway :${PORT} -> ${TARGET}`);
});
