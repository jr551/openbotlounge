import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { baseUrlField, readJson, strField } from '$lib/server/http';
import { classifyNetworkError, isPrivateHost } from '$lib/server/provider-connect';
import { config } from '$lib/server/config';

const CHECK_TIMEOUT_MS = 15_000;

/** A 200 from a catch-all web server is not proof that a model answered. */
function isCompletionResponse(raw: string): boolean {
	try {
		const data = JSON.parse(raw) as {
			choices?: { message?: unknown; text?: unknown }[];
		};
		const choice = data?.choices?.[0];
		if (!choice || typeof choice !== 'object') return false;
		return (
			(choice.message !== null && typeof choice.message === 'object') ||
			typeof choice.text === 'string'
		);
	} catch {
		return false;
	}
}

/**
 * The cheapest real check that a base URL, key and model work together, run
 * when the provider form's model field changes - not on a button. A GET on
 * /models costs the provider nothing but a listing, so it is tried first: a
 * readable list proves the key was accepted and the model name is checked
 * against it. A missing or unreadable listing falls back to a one-token
 * completion, the smallest billable probe an OpenAI-compatible server offers.
 * Only an OpenAI-style completion counts as success; an arbitrary 200 page
 * does not.
 *
 * The same rules as the test route apply: the key comes from the typed field
 * and is never echoed, nothing the target says is repeated back, and private
 * or link-local addresses are refused unless PROVIDER_TEST_ALLOW_PRIVATE is
 * set - this open endpoint must not become an SSRF.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const baseUrl = (baseUrlField(body, 'base_url', 300) ?? '').replace(/\/+$/, '');
	const model = (strField(body, 'model', 120) ?? '').trim();
	const apiKey = strField(body, 'api_key', 400) ?? '';
	if (!baseUrl) throw error(400, 'base_url required');
	if (!model) throw error(400, 'model required');

	let endpoint: URL;
	try {
		endpoint = new URL(`${baseUrl}/models`);
	} catch {
		return json({ ok: false, message: 'That base URL is not a valid http(s) URL.' });
	}
	if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
		return json({ ok: false, message: 'The base URL must start with http:// or https://.' });
	}
	const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!config.providerTestAllowPrivate && (await isPrivateHost(host))) {
		return json({
			ok: false,
			message:
				'That is a private or link-local address, not a provider endpoint. ' +
				'Set PROVIDER_TEST_ALLOW_PRIVATE=true to check a local model server.'
		});
	}

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	// The free check first: a model listing costs no tokens.
	let res: Response;
	try {
		res = await fetch(endpoint, {
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
		});
	} catch (err) {
		return json({ ok: false, message: classifyNetworkError(err, endpoint.host, apiKey) });
	}
	if (res.ok) {
		const raw = (await res.text().catch(() => '')).slice(0, 200_000);
		let listed: string[] | null = null;
		try {
			const data = JSON.parse(raw);
			if (Array.isArray(data?.data)) {
				listed = data.data
					.map((m: unknown) => (typeof m === 'object' && m ? (m as { id?: unknown }).id : m))
					.filter((id: unknown): id is string => typeof id === 'string');
			}
		} catch {
			listed = null;
		}
		if (listed !== null) {
			if (listed.includes(model)) {
				return json({ ok: true, message: `${model} is served by ${endpoint.host}.` });
			}
			return json({
				ok: false,
				message: `Reached ${endpoint.host}, but ${model} is not in its model list. Check the model name.`
			});
		}
		// Some compatible servers have no listing, and a proxy may answer
		// /models with an HTML sign-in page. Let the completion probe decide.
	} else if (res.status === 401 || res.status === 403) {
		return json({
			ok: false,
			message: `The provider rejected the key (HTTP ${res.status}). Check the API key.`
		});
	} else if (res.status === 429) {
		return json({
			ok: false,
			message: 'The provider rate-limited the request (HTTP 429). Try again shortly.'
		});
	}
	// No usable listing on this endpoint (404, or a response we could not read):
	// fall back to the smallest billable probe - one token of completion.
	if (res.status !== 404 && !res.ok) {
		return json({
			ok: false,
			message: `The provider answered HTTP ${res.status}. Check the model name and the base URL.`
		});
	}
	let comp: Response;
	try {
		comp = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers,
			redirect: 'manual',
			body: JSON.stringify({
				model,
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1,
				stream: false
			}),
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
		});
	} catch (err) {
		return json({ ok: false, message: classifyNetworkError(err, endpoint.host, apiKey) });
	}
	if (comp.ok) {
		const raw = (await comp.text().catch(() => '')).slice(0, 2000);
		if (!isCompletionResponse(raw)) {
			return json({
				ok: false,
				message: `Reached ${endpoint.host}, but the reply was not an OpenAI-style completion. Check that the base URL points at an OpenAI-compatible server.`
			});
		}
		return json({ ok: true, message: `Reached ${endpoint.host}; ${model} answered a completion.` });
	}
	if (comp.status === 401 || comp.status === 403) {
		return json({
			ok: false,
			message: `The provider rejected the key (HTTP ${comp.status}). Check the API key.`
		});
	}
	if (comp.status === 404) {
		return json({
			ok: false,
			message: `Reached ${endpoint.host}, but the model was not found (HTTP 404). Check the model name.`
		});
	}
	if (comp.status === 429) {
		return json({
			ok: false,
			message: 'The provider rate-limited the request (HTTP 429). Try again shortly.'
		});
	}
	return json({
		ok: false,
		message: `The provider answered HTTP ${comp.status}. Check the model name and the base URL.`
	});
};
