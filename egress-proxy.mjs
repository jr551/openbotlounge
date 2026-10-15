/**
 * The bot machines' only door to the network.
 *
 * Every machine sits on its own `internal` Docker network - no gateway, no
 * DNS for outside names, no route to the app, the host, or another bot's
 * machine. This container is the one other member of each of those networks,
 * and the machines reach the internet through it: HTTP(S)_PROXY env vars point
 * curl/wget/apk/git at it, NODE_USE_ENV_PROXY points Node's fetch at it, and
 * the browser is launched with --proxy-server. Ssh is the client that needs
 * telling twice, because it ignores those variables: the machine's ssh_config
 * points it here as well (machine.ts writes that at boot).
 *
 * It is deliberately not a forwarder to the inside. Any port to a public
 * address is honoured, both as a plain-HTTP request and as a CONNECT tunnel -
 * the operator opened the port list rather than keeping the machine web-only.
 * The lockdown is the destination, not the port: a bot asking for the app's
 * API, the Docker host's gateway, a LAN address, another machine, or a
 * metadata endpoint is refused on every port including 22 - the name is
 * resolved here and every answer is checked, which is also what keeps a
 * public name that resolves to a private address (rebinding) out.
 *
 * Standalone on purpose: it runs inside the app image with `node
 * egress-proxy.mjs`, so it may import nothing outside node:.
 */
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';

const PORT = Number(process.env.EGRESS_PORT ?? 3128);

/**
 * Whether an IPv4 address is public. Everything a machine should never reach -
 * loopback, RFC1918, link-local, CGNAT, multicast, the unspecified and
 * broadcast addresses, and the reserved/documentation ranges - answers false.
 */
function publicV4(ip) {
	const p = ip.split('.').map(Number);
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = p;
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 169 && b === 254) return false; // link-local, cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
	if (a >= 224) return false; // multicast, reserved, broadcast
	if (a === 192 && b === 0) return false; // IETF assignments
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarks
	if (a === 198 && b === 51) return false; // documentation
	if (a === 203 && b === 0) return false; // documentation
	return true;
}

/** Whether an IPv6 address is public: global unicast only. */
function publicV6(ip) {
	const s = ip.toLowerCase();
	if (s === '::' || s === '::1') return false;
	if (s.startsWith('fe80') || s.startsWith('fe90') || s.startsWith('fea0') || s.startsWith('feb0'))
		return false; // link-local
	if (s.startsWith('fc') || s.startsWith('fd')) return false; // unique-local
	if (s.startsWith('ff')) return false; // multicast
	if (s.startsWith('::ffff:')) {
		const v4 = s.slice(7);
		return publicV4(v4);
	}
	if (s.startsWith('2001:db8')) return false; // documentation
	return s.includes(':');
}

const publicIp = (ip) => (ip.includes(':') ? publicV6(ip) : publicV4(ip));

/**
 * The address a request may be opened to, or null when the destination is off
 * limits. Names are resolved here and every answer must be public; the socket
 * then dials the address itself rather than the name, so a name that changes
 * its answer between lookup and connect cannot smuggle a private target in.
 */
async function publicTarget(host) {
	if (!host || host.length > 253 || /[\s/@]/.test(host)) return null;
	if (net.isIP(host)) return publicIp(host) ? host : null;
	try {
		const answers = await dns.lookup(host, { all: true, verbatim: true });
		const addrs = answers.map((a) => a.address);
		if (!addrs.length || !addrs.every(publicIp)) return null;
		return addrs[0];
	} catch {
		return null;
	}
}

/** Split "host:port" (IPv6 in brackets) into its parts, or null. */
function parseAuthority(authority) {
	const m = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/.exec(authority) ?? /^([^:]+):(\d+)$/.exec(authority);
	if (!m) return null;
	return { host: m[1], port: Number(m[2]) };
}

const server = http.createServer();

/**
 * Plain-HTTP proxying, which is what apk's package fetches and any
 * `curl http://…` send. The request line carries the absolute URI; the
 * destination is checked exactly as a CONNECT target is. Any port on a
 * public host goes; the destination check is the whole policy.
 */
server.on('request', async (req, res) => {
	let url;
	try {
		url = new URL(req.url ?? '');
	} catch {
		res.writeHead(400).end('bad request');
		return;
	}
	if (url.protocol !== 'http:') {
		res.writeHead(403).end('plain HTTP proxying only');
		return;
	}
	const port = Number(url.port) || 80;
	const ip = await publicTarget(url.hostname);
	if (!ip) {
		res.writeHead(403).end('destination is not a public address');
		return;
	}
	const upstream = http.request(
		{
			host: ip,
			port,
			// The original Host header is what the site answers to; the dialled
			// address is ours, which is what keeps the checked IP the used IP.
			headers: { ...req.headers, host: req.headers.host ?? url.host },
			method: req.method,
			path: url.pathname + url.search,
			timeout: 60_000
		},
		(up) => {
			res.writeHead(up.statusCode ?? 502, up.headers);
			up.pipe(res);
		}
	);
	upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
	upstream.on('error', (e) => {
		if (!res.headersSent) res.writeHead(502);
		res.end(String(e.message ?? e));
	});
	req.pipe(upstream);
});

/** CONNECT tunnelling: any port to a public host - the tunnel is how ssh and everything else non-HTTP leaves. */
server.on('connect', async (req, client, head) => {
	const target = parseAuthority(req.url ?? '');
	const refuse = (why) => {
		client.write(`HTTP/1.1 403 Forbidden\r\n\r\n`);
		client.destroy();
		if (why) console.warn(`refused CONNECT ${req.url}: ${why}`);
	};
	if (!target || !Number.isInteger(target.port) || target.port <= 0 || target.port > 65535)
		return refuse('no usable port in the authority');
	const ip = await publicTarget(target.host);
	if (!ip) return refuse('destination is not a public address');
	const upstream = net.connect(target.port, ip);
	upstream.setTimeout(60_000);
	upstream.once('connect', () => {
		client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		if (head?.length) upstream.write(head);
		upstream.pipe(client);
		client.pipe(upstream);
	});
	upstream.once('timeout', () => upstream.destroy());
	upstream.once('error', () => client.destroy());
	client.once('error', () => upstream.destroy());
});

server.listen(PORT, () => {
	console.log(`obl-egress proxy listening on :${PORT}`);
});

// ---- DNS ----
//
// The machines' networks are internal, so Docker's embedded resolver has no
// upstream to forward to - a machine that wants a name resolved asks the one
// neighbour it has: this container. The forwarder is deliberately minimal:
// UDP only, A and AAAA only, and every answer is filtered through the same
// public-address check the proxy applies, so DNS cannot be used to learn or
// reach a private address either.

const DNS_PORT = 53;
/** A DNS message over UDP is 512 bytes by contract; larger asks for TCP, which we do not speak. */
const DNS_MAX_PACKET = 512;

const QTYPE_A = 1;
const QTYPE_AAAA = 28;

/** The question's name, decoded from the wire format into a dotted name, or null. */
function readQName(msg, offset) {
	const labels = [];
	let i = offset;
	// Pointers (0xC0) are refused outright: a forwarder that never asks for
	// them never has to follow one into a loop.
	for (;;) {
		if (i >= msg.length) return null;
		const len = msg[i];
		if (len === 0) return { name: labels.join('.'), end: i + 1 };
		if (len & 0xc0) return null;
		i += 1;
		if (i + len > msg.length) return null;
		labels.push(msg.subarray(i, i + len).toString('ascii'));
		i += len;
	}
}

/** One answer record pointing at the question's name (0xC00C) with a 60s TTL. */
function answerRecord(qtype, ip) {
	const head = Buffer.alloc(12);
	head.writeUInt16BE(0xc00c, 0); // name: pointer to the question
	head.writeUInt16BE(qtype, 2);
	head.writeUInt16BE(1, 4); // IN
	head.writeUInt32BE(60, 6); // TTL: short, so a changed answer is not stale for long
	if (qtype === QTYPE_A) {
		head.writeUInt16BE(4, 10);
		return Buffer.concat([head, Buffer.from(ip.split('.').map(Number))]);
	}
	head.writeUInt16BE(16, 10);
	const groups = ip.split(':').reduce((acc, part, idx, arr) => {
		if (part === '') {
			const missing = 8 - (arr.length - 1);
			for (let k = 0; k < missing; k++) acc.push(0);
		} else {
			acc.push(parseInt(part, 16));
		}
		return acc;
	}, []);
	const bytes = Buffer.alloc(16);
	groups.forEach((g, i) => bytes.writeUInt16BE(g & 0xffff, i * 2));
	return Buffer.concat([head, bytes]);
}

/** Build the response packet: header + the question echoed + answer records. */
function dnsResponse(query, qEnd, answers) {
	const header = Buffer.alloc(12);
	query.copy(header, 0, 0, 12);
	header[2] = 0x81; // QR + RD
	header[3] = answers === null ? 0x83 : 0x80; // NXDOMAIN when the name resolves to nothing public
	header.writeUInt16BE(answers?.length ?? 0, 6);
	const question = query.subarray(12, qEnd);
	if (!answers?.length) return Buffer.concat([header, question]);
	return Buffer.concat([header, question, ...answers]);
}

const dnsSocket = dgram.createSocket('udp4');

dnsSocket.on('message', async (msg, rinfo) => {
	try {
		if (msg.length < 12 || msg.length > DNS_MAX_PACKET) return;
		const qdcount = msg.readUInt16BE(4);
		if (qdcount !== 1) return; // one question is all a stub resolver sends
		const q = readQName(msg, 12);
		if (!q || q.end + 4 > msg.length) return;
		const qtype = msg.readUInt16BE(q.end);
		const qclass = msg.readUInt16BE(q.end + 2);
		if (qclass !== 1 || (qtype !== QTYPE_A && qtype !== QTYPE_AAAA)) {
			// Anything else gets an empty NOERROR: the name may exist, but this
			// door only answers for the web's two record types.
			dnsSocket.send(dnsResponse(msg, q.end + 4, []), rinfo.port, rinfo.address);
			return;
		}
		const resolve = qtype === QTYPE_A ? dns.resolve4 : dns.resolve6;
		let ips = [];
		try {
			ips = await resolve(q.name);
		} catch {
			ips = [];
		}
		const safe = ips.filter(publicIp);
		const answers = safe.length ? safe.map((ip) => answerRecord(qtype, ip)) : null;
		dnsSocket.send(dnsResponse(msg, q.end + 4, answers), rinfo.port, rinfo.address);
	} catch {
		// A malformed packet is dropped, never answered.
	}
});

dnsSocket.on('error', () => {});
dnsSocket.bind(DNS_PORT, () => {
	console.log(`obl-egress DNS forwarder listening on :${DNS_PORT}/udp`);
});
