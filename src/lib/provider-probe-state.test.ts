import { describe, expect, it } from 'vitest';
import { ProviderProbeTracker } from './provider-probe-state';

describe('ProviderProbeTracker', () => {
	it('deduplicates a repeated endpoint and model', () => {
		const tracker = new ProviderProbeTracker();
		const first = tracker.begin('http://provider.test/v1|model-a');

		expect(first).not.toBeNull();
		expect(tracker.begin('http://provider.test/v1|model-a')).toBeNull();
		expect(tracker.isCurrent(first!)).toBe(true);
	});

	it('makes only the latest check current', () => {
		const tracker = new ProviderProbeTracker();
		const first = tracker.begin('http://provider.test/v1|model-a')!;
		const second = tracker.begin('http://provider.test/v1|model-b')!;

		expect(tracker.isCurrent(first)).toBe(false);
		expect(tracker.isCurrent(second)).toBe(true);
	});

	it('allows the same probe to run again after credentials change', () => {
		const tracker = new ProviderProbeTracker();
		const before = tracker.begin('http://provider.test/v1|model-a')!;

		tracker.invalidate();
		const after = tracker.begin('http://provider.test/v1|model-a')!;

		expect(tracker.isCurrent(before)).toBe(false);
		expect(tracker.isCurrent(after)).toBe(true);
	});

	it('keeps a successful unchanged probe deduplicated', () => {
		const tracker = new ProviderProbeTracker();
		const first = tracker.begin('http://provider.test/v1|model-a')!;

		tracker.complete(first, true);

		expect(tracker.begin('http://provider.test/v1|model-a')).toBeNull();
		expect(tracker.isCurrent(first)).toBe(true);
	});

	it('allows an unchanged probe to be retried after a failure', () => {
		const tracker = new ProviderProbeTracker();
		const first = tracker.begin('http://provider.test/v1|model-a')!;

		tracker.complete(first, false);
		const retry = tracker.begin('http://provider.test/v1|model-a');

		expect(retry).not.toBeNull();
		expect(tracker.isCurrent(first)).toBe(false);
		expect(tracker.isCurrent(retry!)).toBe(true);
	});

	it('does not let a stale failure unlock a newer probe', () => {
		const tracker = new ProviderProbeTracker();
		const first = tracker.begin('http://provider.test/v1|model-a')!;
		const second = tracker.begin('http://provider.test/v1|model-b')!;

		tracker.complete(first, false);

		expect(tracker.begin('http://provider.test/v1|model-b')).toBeNull();
		expect(tracker.isCurrent(second)).toBe(true);
	});
});
