import { config } from './config';

/** Sliding-window timestamps (ms) for each hook token. */
const hits = new Map<string, number[]>();

const WINDOW_MS = 60_000;

/** Drop entries older than the window and cap map size so memory stays bounded. */
function prune(token: string, now: number): number[] {
	const kept = (hits.get(token) ?? []).filter((t) => now - t < WINDOW_MS);
	if (kept.length) hits.set(token, kept);
	else hits.delete(token);
	return kept;
}

/** Test seam: clear all counters between cases. */
export function resetWebhookRateLimits(): void {
	hits.clear();
}

export interface WebhookRateLimitResult {
	allowed: boolean;
	/** Seconds until the oldest hit in the window falls out; only when !allowed. */
	retryAfterSec: number;
}

/**
 * Whether another POST to this hook token may run in the current minute.
 * Limit is per token; unknown tokens share the same key as their URL segment.
 * When `webhookMaxPerMinute` is 0, limiting is disabled.
 */
export function checkWebhookRateLimit(token: string, now = Date.now()): WebhookRateLimitResult {
	const max = config.webhookMaxPerMinute;
	if (max <= 0) return { allowed: true, retryAfterSec: 0 };

	const window = prune(token, now);
	if (window.length < max) {
		window.push(now);
		hits.set(token, window);
		return { allowed: true, retryAfterSec: 0 };
	}
	const oldest = window[0] ?? now;
	const retryAfterMs = Math.max(0, WINDOW_MS - (now - oldest));
	return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) || 1 };
}
