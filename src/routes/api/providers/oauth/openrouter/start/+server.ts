import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJson, requestIsSecure, strField } from '$lib/server/http';
import { beginFlow, encodeFlow, FLOW_COOKIE, FLOW_COOKIE_PATH } from '$lib/server/provider-oauth';
import { providerById } from '$lib/providers';

/**
 * Start OpenRouter's PKCE sign-in. The callback URL is this app's own origin,
 * not anything the caller supplies, so a code can only ever come back here.
 */
export const POST: RequestHandler = async ({ request, url, cookies }) => {
	const body = await readJson(request);
	const fallbackModel = providerById('openrouter')?.models[0] ?? '';
	const model = (strField(body, 'model', 120) ?? '').trim() || fallbackModel;

	const { authorizeUrl, flow } = beginFlow({
		// `url.origin` cannot be trusted for the scheme: adapter-node reports
		// https on a plain-HTTP LAN install, so the provider would redirect to a
		// URL this app never answers on and the flow could never finish.
		callbackUrl:
			`${requestIsSecure(request) ? 'https' : 'http'}://${url.host}` +
			`${FLOW_COOKIE_PATH}/openrouter/callback`,
		model
	});
	cookies.set(FLOW_COOKIE, encodeFlow(flow), {
		path: FLOW_COOKIE_PATH,
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600,
		secure: requestIsSecure(request)
	});
	return json({ authorize_url: authorizeUrl });
};
