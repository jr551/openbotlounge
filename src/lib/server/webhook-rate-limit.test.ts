import { afterEach, describe, expect, it } from 'vitest';
import { config } from './config';
import { checkWebhookRateLimit, resetWebhookRateLimits } from './webhook-rate-limit';

afterEach(() => {
	resetWebhookRateLimits();
});

describe('checkWebhookRateLimit', () => {
	it('allows up to the configured count within one minute', () => {
		const previous = config.webhookMaxPerMinute;
		config.webhookMaxPerMinute = 3;
		try {
			const t0 = 1_000_000;
			expect(checkWebhookRateLimit('tok-a', t0).allowed).toBe(true);
			expect(checkWebhookRateLimit('tok-a', t0 + 1).allowed).toBe(true);
			expect(checkWebhookRateLimit('tok-a', t0 + 2).allowed).toBe(true);
			const blocked = checkWebhookRateLimit('tok-a', t0 + 3);
			expect(blocked.allowed).toBe(false);
			expect(blocked.retryAfterSec).toBeGreaterThan(0);
		} finally {
			config.webhookMaxPerMinute = previous;
		}
	});

	it('tracks tokens independently', () => {
		const previous = config.webhookMaxPerMinute;
		config.webhookMaxPerMinute = 1;
		try {
			const t0 = 2_000_000;
			expect(checkWebhookRateLimit('one', t0).allowed).toBe(true);
			expect(checkWebhookRateLimit('two', t0).allowed).toBe(true);
			expect(checkWebhookRateLimit('one', t0 + 1).allowed).toBe(false);
		} finally {
			config.webhookMaxPerMinute = previous;
		}
	});

	it('opens the window again after a minute', () => {
		const previous = config.webhookMaxPerMinute;
		config.webhookMaxPerMinute = 1;
		try {
			const t0 = 3_000_000;
			expect(checkWebhookRateLimit('tok', t0).allowed).toBe(true);
			expect(checkWebhookRateLimit('tok', t0 + 1000).allowed).toBe(false);
			expect(checkWebhookRateLimit('tok', t0 + 60_001).allowed).toBe(true);
		} finally {
			config.webhookMaxPerMinute = previous;
		}
	});

	it('is a no-op when the limit is zero', () => {
		const previous = config.webhookMaxPerMinute;
		config.webhookMaxPerMinute = 0;
		try {
			for (let i = 0; i < 20; i++) {
				expect(checkWebhookRateLimit('tok', i).allowed).toBe(true);
			}
		} finally {
			config.webhookMaxPerMinute = previous;
		}
	});
});
