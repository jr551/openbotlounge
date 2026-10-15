import { describe, expect, it, vi } from 'vitest';
import { describeSchedule, shortAhead } from './format';

describe('shortAhead', () => {
	it('says how far ahead a moment sits, in the shortest unit that still says it', () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000_000_000);
		const now = Date.now();
		expect(shortAhead(now + 20_000)).toBe('any moment');
		expect(shortAhead(now + 5 * 60_000)).toBe('in 5m');
		expect(shortAhead(now + 6 * 3_600_000)).toBe('in 6h');
		expect(shortAhead(now + 72 * 3_600_000)).toBe('in 3d');
		vi.useRealTimers();
	});

	it('never reads a future stamp as just-now - the failure that made it exist', () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000_000_000);
		// Six hours out must say six hours, not clamp to the past like an
		// ago-formatter would ("Next round just now.").
		expect(shortAhead(Date.now() + 6 * 3_600_000)).not.toBe('any moment');
		expect(shortAhead(Date.now() + 6 * 3_600_000)).toBe('in 6h');
		vi.useRealTimers();
	});
});

describe('describeSchedule', () => {
	it('reads an interval in minutes, and in hours when it divides evenly', () => {
		expect(describeSchedule({ cron: '', interval_min: 30 })).toBe('every 30 min');
		expect(describeSchedule({ cron: '', interval_min: 60 })).toBe('every 1 hour');
		expect(describeSchedule({ cron: '', interval_min: 120 })).toBe('every 2 hours');
	});

	it('names the time a plain cron fires at', () => {
		expect(describeSchedule({ cron: '0 9 * * 1-5', interval_min: 0 })).toBe(
			'weekdays at 09:00'
		);
		expect(describeSchedule({ cron: '30 8 * * *', interval_min: 0 })).toBe('every day at 08:30');
		expect(describeSchedule({ cron: '0 9 * * 1', interval_min: 0 })).toBe('Mondays at 09:00');
	});

	it('describes a stepped cron by its interval instead of inventing a time', () => {
		// "*/5 * * * *" has no single minute or hour; the old code read it as
		// "every day at 0*:*/5".
		expect(describeSchedule({ cron: '*/5 * * * *', interval_min: 5 })).toBe('every 5 min');
		expect(describeSchedule({ cron: '0 9-17 * * *', interval_min: 60 })).toBe('every 1 hour');
	});

	it('says a stepped cron is custom when there is no interval to fall back on', () => {
		expect(describeSchedule({ cron: '*/5 * * * *', interval_min: 0 })).toBe(
			'on a custom schedule'
		);
	});
});
