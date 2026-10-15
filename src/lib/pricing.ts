/**
 * What a model's tokens cost, and what a bot's running totals come to.
 *
 * Kept free of server imports so the chat header can price a bot in the
 * browser from the same numbers the server fetched off the provider's /models
 * listing (see $lib/server/pricing).
 */

/** Per-token costs for one model, in the provider's currency (USD). */
export interface ModelPricing {
	/** Cost of one prompt (input) token. */
	prompt: number;
	/** Cost of one reply (output) token. */
	completion: number;
	/** Cost of one prompt token served from the provider's cache; 0 when the provider does not price it. */
	cacheRead: number;
}

/** The token totals a cost is computed from. */
export interface TokenTotals {
	/** Prompt tokens, cache reads included - the shape the provider reports. */
	input: number;
	output: number;
	/** Prompt tokens the provider's cache served; only ever provider-reported. */
	cacheRead?: number;
}

/**
 * The model a bot's spend is priced against: its own override when it has one,
 * otherwise the configured default. A bot with no model of its own is served
 * by the default, so pricing it against anything else would be a guess.
 */
export function resolveModel(botModel: string | undefined, defaultModel: string): string {
	return botModel || defaultModel;
}

/**
 * What `tokens` cost at `pricing`. Cache reads are billed at their own rate
 * when the provider prices them, and at the prompt rate otherwise; the prompt
 * total already includes them, so only the uncached remainder pays full price.
 */
export function costOf(pricing: ModelPricing, tokens: TokenTotals): number {
	const cacheRead = Math.max(0, tokens.cacheRead ?? 0);
	const cacheRate = pricing.cacheRead || pricing.prompt;
	return (
		Math.max(0, tokens.input - cacheRead) * pricing.prompt +
		cacheRead * cacheRate +
		Math.max(0, tokens.output) * pricing.completion
	);
}

/**
 * A money string for a cost. Two decimals read well for real money; below a
 * cent they would round a genuine charge to $0.00, so the readout keeps four
 * decimals there and says "less than" for anything smaller still. Zero is a
 * real answer - a bot that has spent nothing - and reads as $0.00.
 */
export function formatCost(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return '$0.00';
	if (total < 0.0001) return '<$0.0001';
	if (total < 0.01) return `$${total.toFixed(4).replace(/0+$/, '')}`;
	return `$${total.toFixed(2)}`;
}
