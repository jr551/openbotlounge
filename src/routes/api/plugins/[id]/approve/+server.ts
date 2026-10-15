import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlugin, setPluginVerification, updatePlugin } from '$lib/server/plugins';
import { humanVerdict, verdictJson } from '$lib/server/police';
import { boolField, readJson } from '$lib/server/http';

/**
 * The human's ruling on a plugin the police refused: the "Approve anyway"
 * button on a card whose attempts ran out. Approving signs the row off as the
 * human's verdict - never the officer's - and switches the plugin on; denying
 * it writes the refusal as the human's own and leaves it off. Either way the
 * verdict carries by:'human', so a console ruling can never be mistaken for
 * the police's word.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const plugin = getPlugin(params.id);
	if (!plugin) throw error(404, 'plugin not found');
	const body = await readJson(request);
	const approve = boolField(body, 'approve') === true;
	const verdict = humanVerdict(
		approve,
		approve ? 'approved by the human' : 'refused by the human'
	);
	setPluginVerification(plugin.id, verdictJson(verdict));
	updatePlugin(plugin.id, { enabled: approve ? 1 : 0 });
	return json(getPlugin(params.id));
};
