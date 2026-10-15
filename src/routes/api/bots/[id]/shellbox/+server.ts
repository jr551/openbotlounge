import { error, json } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { ensureMachine, machineExec, machineStatus, shellScreen } from '$lib/server/machine';
import { readJson } from '$lib/server/http';

/**
 * The bot's terminal: what state the machine is in and what its tmux pane
 * shows right now (scrollback included, ANSI escapes intact). `cols`/`rows`
 * resize the pane to the viewer's grid before it is captured, so wrapped
 * lines and full-screen apps render the way the user sees them.
 *
 * GET is read-only: it never boots the machine. A read-only verb that starts
 * a container is a resource-exhaustion vector (any <img> tag or crawler could
 * fire it), and a GET that blocks for a whole container boot wedges the
 * page's request queue behind it. Waking is POST's job.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	if (!getBot(params.id)) throw error(404, 'not found');
	const cols = Math.min(Math.max(0, Number(url.searchParams.get('cols')) || 0), 500);
	const rows = Math.min(Math.max(0, Number(url.searchParams.get('rows')) || 0), 200);
	const status = await machineStatus(params.id);
	const state: 'running' | 'sleeping' | 'none' =
		status.state === 'off' ? 'none' : status.state;
	// A container that stops between the status read and the capture degrades
	// to an empty screen rather than a 500.
	const screen = state === 'running' ? await shellScreen(params.id, cols, rows).catch(() => '') : '';
	return json({ state, screen });
};

/**
 * A keystroke is a paste into a pane that is already running, so it should
 * answer in well under a second. The machine's own exec timeout is minutes (a
 * cold boot), and a request that waits on that holds the terminal's connection
 * open long past the point the client gives up - so the route bounds the wait
 * itself and answers 503, leaving the paste to land if the machine comes up.
 */
const TYPE_TIMEOUT_MS = 20_000;

/**
 * Wake the machine for the terminal. The boot runs in the background - a
 * cold container can take minutes, and the terminal polls GET for the pane
 * rather than holding this request open. A short race still surfaces an
 * immediate failure (dead socket, missing image) as a 503.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!getBot(params.id)) throw error(404, 'not found');
	const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
	// 'type' injects raw terminal input into the pane: the bytes travel base64
	// (quoting-proof) into tmux's paste buffer, which writes them to the tty
	// verbatim - Enter, arrows and control keys included. The buffer is named
	// per keystroke: concurrent execs sharing tmux's *default* buffer is what
	// scrambled fast typing (`abcdefghij` came out `cccageffij`), because each
	// load-buffer overwrote the text the other exec had not pasted yet. The
	// session name is machine.ts's SESSION constant, duplicated here because
	// it is not exported.
	if (body.action === 'type') {
		const data = typeof body.data === 'string' ? body.data : '';
		if (!data) throw error(400, 'nothing to type');
		const b64 = Buffer.from(data, 'utf8').toString('base64');
		const buf = `obl-${randomBytes(6).toString('hex')}`;
		// Docker being unreachable, or the machine failing to start, is a
		// temporary condition rather than a bug: say so plainly instead of
		// letting the driver error surface as an opaque 500. The race bounds
		// the whole wait, since machineExec first waits on a boot that can run
		// for minutes.
		let outcome: 'done' | 'timeout';
		try {
			outcome = await Promise.race([
				machineExec(
					params.id,
					`echo ${b64} | base64 -d | tmux load-buffer -b ${buf} - ; ` +
						`tmux paste-buffer -b ${buf} -t obl ; tmux delete-buffer -b ${buf} 2>/dev/null ; true`
				).then(() => 'done' as const),
				delay(TYPE_TIMEOUT_MS).then(() => 'timeout' as const)
			]);
		} catch (e) {
			throw error(503, `the machine could not take that keystroke: ${String(e).split('\n')[0]}`);
		}
		if (outcome === 'timeout') {
			throw error(503, `the machine did not answer within ${TYPE_TIMEOUT_MS / 1000}s`);
		}
		// The keystroke's own answer carries the pane back: the terminal paints
		// it at once rather than waiting for the next poll, which is what made
		// typing feel a beat behind.
		const screen = await shellScreen(params.id).catch(() => '');
		return json({ ok: true, screen });
	}
	if (body.action !== 'wake') {
		try {
			return json(await machineStatus(params.id));
		} catch (e) {
			throw error(503, `the machine's state could not be read: ${String(e).split('\n')[0]}`);
		}
	}
	try {
		const boot = ensureMachine(params.id);
		void boot.catch(() => {});
		await Promise.race([boot, delay(12_000)]);
	} catch (e) {
		throw error(503, `Docker is not reachable, so the machine could not be started: ${String(e).split('\n')[0]}`);
	}
	return json(await machineStatus(params.id));
};
