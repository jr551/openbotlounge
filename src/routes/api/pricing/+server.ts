import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ModelPricing } from '$lib/pricing';
import { modelPricing } from '$lib/server/pricing';

/**
 * Per-token prices for the provider's models, so the client can price a bot's
 * token meter without a round-trip per render. The map is empty when the
 * provider lists no prices - the header then shows no money rather than a
 * fabricated one.
 */
export const GET: RequestHandler = async () => {
	const pricing: Record<string, ModelPricing> = {};
	for (const [id, p] of await modelPricing()) pricing[id] = p;
	return json({ pricing });
};
