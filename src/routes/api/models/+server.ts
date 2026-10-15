import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { defaultModel, listModels } from '$lib/server/llm';

export const GET: RequestHandler = async () => {
	const models = await listModels();
	return json({ models, default: defaultModel() || models[0] || '' });
};
