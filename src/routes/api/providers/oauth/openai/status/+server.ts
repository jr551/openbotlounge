import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setSetting } from '$lib/server/db';
import { strField, readJson } from '$lib/server/http';
import { dropDeviceFlow, getDeviceFlow, pollDeviceFlow } from '$lib/server/provider-oauth';
import { CHATGPT_BASE_URL } from '$lib/providers';

/**
 * One poll of an in-flight device sign-in. The page calls this on the
 * interval the start route reported until the answer stops being 'pending'.
 * On success the provider config is written here: the tokens never touch the page.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const flowId = strField(body, 'flow_id', 80) ?? '';
	const flow = flowId ? getDeviceFlow(flowId) : undefined;
	if (!flow) {
		return json({
			status: 'failed',
			error: 'That sign-in has expired. Start the connection again.'
		});
	}

	const result = await pollDeviceFlow(flow);
	if (result.status === 'pending') return json({ status: 'pending' });

	// The flow is over either way; a second poll must not double-create.
	dropDeviceFlow(flow.id);
	if (result.status !== 'connected' || !result.tokens) {
		return json({ status: 'failed', error: result.error ?? 'The sign-in did not complete.' });
	}

	setSetting('provider_base_url', CHATGPT_BASE_URL);
	setSetting('provider_api_key', result.tokens.accessToken);
	setSetting(
		'provider_oauth',
		JSON.stringify({
			refresh_token: result.tokens.refreshToken,
			account_id: result.tokens.accountId,
			expires_at: result.tokens.expiresAt
		})
	);
	if (flow.model) setSetting('default_model', flow.model);
	return json({ status: 'connected' });
};
