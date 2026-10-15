import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	deleteSshRequest,
	getSshRequest,
	setSshRequestStatus,
	setSshRequestTarget,
	type SshRequest
} from '$lib/server/db';
import { materializeBotKey } from '$lib/server/ssh-keys';
import { machineExec } from '$lib/server/machine';
import { numField, readJson, strField } from '$lib/server/http';

/** What may reach a shell word: a bare host or name, nothing a quote could hide. */
const SAFE_TARGET = /^[A-Za-z0-9_.-]+$/;

/** One ssh word quoted for sh -lc: single quotes, with ' itself closed and reopened. */
function shq(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

function badTarget(host: string, username: string, port: number): string | null {
	if (!host || !SAFE_TARGET.test(host)) return 'host is a bare hostname or IP, no user@, port or path';
	if (!username || !/^[A-Za-z0-9_.-]+$/.test(username))
		return 'username has characters ssh cannot use';
	if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port is 1-65535';
	return null;
}

export const GET: RequestHandler = ({ params }) => {
	const req = getSshRequest(params.id);
	if (!req) throw error(404, 'no such request');
	return json({ request: req });
};

export const DELETE: RequestHandler = ({ params }) => {
	if (!getSshRequest(params.id)) throw error(404, 'no such request');
	if (!deleteSshRequest(params.id)) throw error(404, 'no such request');
	return new Response(null, { status: 204 });
};

/**
 * Run ssh from the bot's own machine and record the verdict. The human may
 * correct host/user/port first - until the first check the card's fields are
 * the ask, after it they are locked to what was tested. An optional body
 * carries those fields; without one the stored row is tested.
 *
 * The private key never leaves the server: it is written into the bot's
 * machine by materializeBotKey, and only `ssh ... true` runs there.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	let req: SshRequest | undefined = getSshRequest(params.id);
	if (!req) throw error(404, 'no such request');
	let host = req.host;
	let username = req.username;
	let port = req.port;
	const raw = await request.text().catch(() => '');
	if (raw.trim()) {
		const body = await readJson(request.clone());
		const h = strField(body, 'host', 253);
		const u = strField(body, 'username', 64);
		const p = numField(body, 'port');
		if (h !== undefined) host = h.trim();
		if (u !== undefined) username = u.trim();
		if (p !== undefined) port = p;
	}
	const bad = badTarget(host, username, port);
	if (bad) throw error(400, bad);
	if (req.status === 'pending') {
		setSshRequestTarget(req.id, host, username, port);
		req = getSshRequest(req.id) ?? req;
	}
	// The key the human installed with ssh-copy-id; without it ssh would prompt,
	// which BatchMode refuses - the failure below then says exactly that.
	await materializeBotKey(req.bot_id);
	let out: string;
	try {
		out = await machineExec(
			req.bot_id,
			`ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -p ${port} ${shq(`${username}@${host}`)} true`
		);
	} catch (e) {
		const msg = (e as Error).message.slice(0, 500);
		setSshRequestStatus(req.id, 'failed', msg);
		return json({ request: getSshRequest(req.id) });
	}
	const failed = /\(exit code (\d+)\)\s*$/.exec(out.trim());
	if (failed) {
		setSshRequestStatus(req.id, 'failed', out.trim().slice(-500));
	} else {
		setSshRequestStatus(req.id, 'ok', '');
	}
	return json({ request: getSshRequest(req.id) });
};
