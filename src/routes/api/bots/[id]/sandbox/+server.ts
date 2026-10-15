import { error, json } from '@sveltejs/kit';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import {
	ensureDesktop,
	machineStatus,
	readPointer,
	setHumanDriving,
	sleepMachine,
	touchMachine
} from '$lib/server/machine';
import { boolField, readJson, strField } from '$lib/server/http';

export const GET: RequestHandler = async ({ params, url }) => {
	if (!getBot(params.id)) throw error(404, 'not found');
	// The panel's pointer overlay asks for this on a timer while it is watching.
	if (url.searchParams.has('pointer')) return json(await readPointer(params.id));
	const status = await machineStatus(params.id);
	// Watching the machine is using it: an open panel polling here is what
	// keeps the reaper from sleeping a machine someone is looking at.
	if (status.state === 'running') touchMachine(params.id);
	return json(status);
};

export const POST: RequestHandler = async ({ params, request }) => {
	if (!getBot(params.id)) throw error(404, 'not found');
	// The body is optional here: an absent or unparseable one just means "status".
	const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
	const action = strField(body, 'action', 20);
	// No action means "status"; a named one must be real, or a typo'd action
	// would look like it worked.
	if (action !== undefined && action !== 'wake' && action !== 'sleep' && action !== 'control') {
		throw error(400, `unknown action "${action}"`);
	}
	if (action === 'control') {
		// The screen panel reporting hands on or off the machine. Pure state -
		// the DM event (and whether one fires at all) is setHumanDriving's call
		// - so a plain 204 and no Docker in the way.
		const driving = boolField(body, 'driving');
		if (driving === undefined) throw error(400, 'driving must be a boolean');
		setHumanDriving(params.id, driving);
		return new Response(null, { status: 204 });
	}
	// Docker being unreachable is a temporary condition, not a bug: say so
	// plainly instead of letting the driver error surface as an opaque 500.
	try {
		if (action === 'wake') {
			// Waking from the panel means the person wants the screen: the machine
			// comes up and its desktop starts building behind it. The boot runs
			// in the background - a cold machine can take minutes, and the panel
			// polls status rather than holding this request open. A short race
			// still surfaces an immediate failure (no image, dead socket) as a
			// 503 instead of a silent 'off'.
			const boot = ensureDesktop(params.id);
			void boot.catch(() => {});
			await Promise.race([boot, delay(12_000)]);
			return json(await machineStatus(params.id));
		}
		if (action === 'sleep') {
			await sleepMachine(params.id);
			return json({ state: 'sleeping' });
		}
	} catch (e) {
		throw error(503, `Docker is not reachable, so the machine could not be started: ${String(e).split('\n')[0]}`);
	}
	return json(await machineStatus(params.id));
};
