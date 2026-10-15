import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { installConnector, listCatalog, listInstalled } from '$lib/server/connectors';
import { readJson, strField } from '$lib/server/http';

/** The connector catalog (with install state) plus the installed views. */
export const GET: RequestHandler = () => {
	return json({ catalog: listCatalog(), installed: listInstalled() });
};

/** Install a catalog connector: creates its shared tool plugin, disabled. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const connectorId = strField(body, 'connector_id', 80) ?? '';
	if (!connectorId) throw error(400, 'connector_id required');
	return json(installConnector(connectorId), { status: 201 });
};
