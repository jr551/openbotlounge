import type { Verification } from './types';

/**
 * The police's sign-off on a plugin, read back from the row's JSON. Null means
 * it was never reviewed - the gate was switched off when it was written, or
 * the row predates the gate - and the console shows that as its own state
 * rather than as a card with no verdict on it at all.
 */
export function verificationOf(raw: string | undefined): Verification | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Verification;
		if (v.verdict === 'approved' || v.verdict === 'rejected' || v.verdict === 'unreviewed') {
			return v;
		}
	} catch {
		// A row written by hand or by an older shape reads as never reviewed.
	}
	return null;
}

/** What the police's verdict reads as on the card. */
export function verdictLabel(v: Verification): string {
	return v.verdict === 'approved' ? 'verified' : v.verdict === 'rejected' ? 'refused' : 'unverified';
}

/**
 * Whether a stored verdict is the police's refusal: the officer said no, and no
 * human has ruled since. Only a refusal of that kind holds the switch down - a
 * verdict the human wrote themselves (by:'human') is theirs to unmake - which
 * is what the console's re-enable guard and its Approve button both key off.
 */
export function refusedByPolice(raw: string | undefined): boolean {
	const v = verificationOf(raw);
	return v?.verdict === 'rejected' && v.by !== 'human';
}
