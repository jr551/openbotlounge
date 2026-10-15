import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listWakes, setWakeEnabled, setWakeVerification } from '$lib/server/db';
import { humanVerdict, verdictJson } from '$lib/server/police';
import { boolField, readJson } from '$lib/server/http';

/**
 * The human's ruling on a wake the police refused: the "Approve anyway"
 * button on a row whose attempts ran out. Approving signs the row off as the
 * human's verdict - never the officer's - and switches the wake on; denying
 * it writes the refusal as the human's own and leaves it off.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const wake = listWakes().find((w) => w.id === params.id);
	if (!wake) throw error(404, 'no such wake');
	const body = await readJson(request);
	const approve = boolField(body, 'approve') === true;
	const verdict = humanVerdict(
		approve,
		approve ? 'approved by the human' : 'refused by the human'
	);
	setWakeVerification(wake.id, verdictJson(verdict));
	setWakeEnabled(wake.id, approve);
	return json({ ok: true, verification: verdictJson(verdict) });
};
