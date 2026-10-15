import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { baseUrlField, readJson, strField } from '$lib/server/http';
import { probeProvider } from '$lib/server/provider-connect';
import { config } from '$lib/server/config';

/**
 * One small chat request to the candidate endpoint, so the form can say what is
 * actually wrong instead of leaving the user to guess. The key is read from
 * the typed field, never from the stored config, and is never echoed back. The
 * probe in provider-connect keeps the response a status and a generic message
 * - nothing the target says is repeated - and refuses private and link-local
 * addresses, so this open endpoint cannot be used to reach internal services.
 * PROVIDER_TEST_ALLOW_PRIVATE lifts that refusal for a self-hosted local model
 * server; it is read here and nowhere a bot can reach.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const baseUrl = baseUrlField(body, 'base_url', 300) ?? '';
	const model = (strField(body, 'model', 120) ?? '').trim();
	const apiKey = strField(body, 'api_key', 400) ?? '';
	if (!baseUrl) throw error(400, 'base_url required');
	if (!model) throw error(400, 'model required');
	return json(
		await probeProvider({
			baseUrl,
			apiKey,
			model,
			// The human's own button may reach a local model server when the
			// operator opts in; nothing else calls the probe, so no bot path
			// can turn this into an SSRF.
			allowPrivate: config.providerTestAllowPrivate
		})
	);
};
