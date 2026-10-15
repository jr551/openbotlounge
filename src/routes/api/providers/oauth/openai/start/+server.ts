import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJson, strField } from '$lib/server/http';
import { beginDeviceFlow } from '$lib/server/provider-oauth';
import { providerById } from '$lib/providers';

/**
 * Start OpenAI's device-code sign-in. Unlike OpenRouter's redirect flow there
 * is no callback URL: the answer is the code the human types at
 * auth.openai.com/codex/device, and the status route polls for the result.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const fallbackModel = providerById('chatgpt')?.models[0] ?? '';
	const model = (strField(body, 'model', 120) ?? '').trim() || fallbackModel;

	const { flow, error } = await beginDeviceFlow({ model });
	if (!flow) return json({ error }, { status: 502 });
	return json({
		flow_id: flow.id,
		user_code: flow.userCode,
		verification_url: flow.verificationUrl,
		interval: flow.interval
	});
};
