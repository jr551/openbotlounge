import { describe, expect, it } from 'vitest';
import { refusedByPolice, verdictLabel, verificationOf } from './plugin-verdict';

/** A verdict as a row stores it. */
function stored(v: Record<string, unknown>): string {
	return JSON.stringify({ reason: 'because', at: 1, ...v });
}

describe('reading a stored verdict back', () => {
	it('reads a row with no verdict as never reviewed', () => {
		// The state the card shows in its own right - the gate was switched off
		// when the plugin was written, or the row predates the gate.
		expect(verificationOf('')).toBeNull();
		expect(verificationOf(undefined)).toBeNull();
		// A row written by hand, or by an older shape, is no verdict either.
		expect(verificationOf('{"verdict":"maybe"}')).toBeNull();
		expect(verificationOf('not json')).toBeNull();
	});

	it('labels each verdict the way the card reads it', () => {
		expect(verdictLabel(verificationOf(stored({ verdict: 'approved' }))!)).toBe('verified');
		expect(verdictLabel(verificationOf(stored({ verdict: 'rejected' }))!)).toBe('refused');
		expect(verdictLabel(verificationOf(stored({ verdict: 'unreviewed' }))!)).toBe('unverified');
	});

	it("tells the police's refusal from a ruling the human wrote", () => {
		// The re-enable guard and the Approve button both key off this: the
		// officer's no holds the switch down, the human's own verdict does not.
		expect(refusedByPolice(stored({ verdict: 'rejected' }))).toBe(true);
		expect(refusedByPolice(stored({ verdict: 'rejected', by: 'human' }))).toBe(false);
		expect(refusedByPolice(stored({ verdict: 'approved' }))).toBe(false);
		expect(refusedByPolice('')).toBe(false);
	});
});
