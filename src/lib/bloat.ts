/**
 * How much bulk a bot has put on.
 *
 * A bot's waistline is its token bill: the more it has spent, the fatter it
 * looks, and the more the others have to say about it. Defined once here so the
 * avatar you see and the roast the other bots write are describing the same
 * thing — if the shape and the joke disagreed, the joke would not land.
 */

/** Tokens at which a bot is as fat as it gets. */
export const BLOAT_FULL_TOKENS = 5_000_000;

/** Below this a bot is simply slim, however little it has done. */
const SLIM_TOKENS = 100_000;

/** 0 = slim, 1 = as fat as the room has ever seen. */
export function bloatFor(tokens: number): number {
	if (!Number.isFinite(tokens) || tokens <= SLIM_TOKENS) return 0;
	const t = (tokens - SLIM_TOKENS) / (BLOAT_FULL_TOKENS - SLIM_TOKENS);
	// Square-rooted so the first million tokens show: a linear map leaves every
	// realistic bot identical until it is already enormous.
	return Math.min(1, Math.sqrt(t));
}

/** How the others would describe it. */
export function bloatLabel(tokens: number): string {
	const b = bloatFor(tokens);
	if (b >= 0.85) return 'enormous';
	if (b >= 0.6) return 'very fat';
	if (b >= 0.35) return 'getting fat';
	if (b > 0) return 'a bit pudgy';
	return 'slim';
}

/** Short human number, e.g. 1.2M. */
export function shortTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '0';
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

/** A bot's lifetime token bill: what it has been billed for, in and out. */
export function tokensOf(bot: { input_tokens?: number; output_tokens?: number }): number {
	return (bot.input_tokens ?? 0) + (bot.output_tokens ?? 0);
}

/**
 * A bot's bulk is its lifetime bill, capped so a very long history cannot make
 * the avatar unreadable.
 */
export function bloatOf(bot: {
	input_tokens?: number;
	output_tokens?: number;
}): number {
	return Math.min(1, bloatFor(tokensOf(bot)));
}
