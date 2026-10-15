import { describe, expect, it } from 'vitest';
import { isSilence } from './silence';

describe('isSilence', () => {
	it('reads the sentinel and its spellings as silence', () => {
		for (const s of ['(silent)', 'SILENT.', 'silent', 'no reply', 'shh', '…', '...']) {
			expect(isSilence(s), s).toBe(true);
		}
	});

	it('reads a deliberate shrug emoji as silence', () => {
		for (const s of ['🤫', '👻', '🤷', '🤷‍♀️', '💤']) {
			expect(isSilence(s), s).toBe(true);
		}
	});

	it('does not read a numeric or emoji answer as silence', () => {
		// The live bug: normalization stripped everything that was not a
		// letter, so '42' and '👍' collapsed to '' and were swallowed as the
		// sentinel - the reply never posted and the task errored.
		for (const s of ['42', '👍', '🧠💭', '3.14', 'yes 👍']) {
			expect(isSilence(s), s).toBe(false);
		}
	});

	it('does not read a sentence containing a silence word as silence', () => {
		expect(isSilence('the room went quiet after the deploy')).toBe(false);
		expect(isSilence('still working on it')).toBe(false);
	});
});
