/**
 * The police's sign-off on a creation: the review a freshly written or changed
 * plugin goes in front of, and the line its author reads the verdict back as.
 *
 * It lives here rather than in the tool registry because three callers need the
 * same review - the bot's create_plugin and update_plugin tools, and the
 * console's own "send it to the police" action on a plugin the gate never saw -
 * and a second copy of the review would be a second set of rules.
 */
import type { Plugin } from './db';
import { refusedByPolice, verificationOf } from '$lib/plugin-verdict';
import {
	runPluginTests,
	setPluginVerification,
	updatePlugin,
	type PluginTestResult
} from './plugins';
import {
	applyAttempt,
	policeModel,
	reviewPlugin,
	verdictJson,
	POLICE_MAX_ATTEMPTS,
	type CreationVerdict
} from './police';

/**
 * How a freshly written plugin or routine reads back to its author: the
 * self-test when there was one, the author's own unit tests when the plugin
 * brought any, then the police's verdict in the officer's own words. A refusal
 * says REFUSED and never reads as a success.
 */
export function signOff(
	test: { ok: boolean; output: string } | null,
	tests: { name: string; ok: boolean; output: string }[] | null,
	review: CreationVerdict
): string {
	const parts: string[] = [];
	if (test) parts.push(`self-test: ${test.ok ? 'PASS' : 'FAILED'} (${test.output || 'no output'})`);
	if (tests?.length) {
		const passed = tests.filter((t) => t.ok).length;
		parts.push(`unit tests: ${passed}/${tests.length} passed (${tests.map((t) => `${t.name} ${t.ok ? 'ok' : 'FAILED'}`).join(', ')})`);
	}
	parts.push(
		review.verdict === 'approved'
			? `police: VERIFIED - ${review.reason}`
			: review.verdict === 'rejected'
				? review.awaitingHuman
					? `police: REFUSED - ${review.reason} (attempt ${review.attempts ?? POLICE_MAX_ATTEMPTS} of ${POLICE_MAX_ATTEMPTS} - no attempts left; it stays off until the human decides)`
					: `police: REFUSED - ${review.reason} (attempt ${review.attempts ?? 1} of ${POLICE_MAX_ATTEMPTS} - fix it and resubmit)`
				: `police: UNREVIEWED - ${review.reason}`
	);
	return parts.join(' | ');
}

/**
 * Put a freshly written or changed plugin in front of the police and record
 * what they said. The police's sign-off is what makes a plugin usable: a
 * refusal switches it off, and an approval switches it back on for an author
 * who has fixed what was refused. 'unreviewed' leaves the switch where it was
 * on an update - a police outage must not change what the author or the human
 * chose - but a brand-new plugin (`fresh`) is switched off: unsigned code does
 * not get the benefit of the doubt.
 *
 * The author's own unit tests run first, in the same sandbox harness the
 * self-test uses, and their results go into the brief beside the code they
 * prove. No tests at all is not a refusal by itself; it is the officer being
 * told there is nothing to check the code against. A plugin with no author -
 * a shared one the human wrote - has no machine to run either in, so the
 * officer judges the code alone rather than a failed boot.
 *
 * A review that could not run must not weaken what the row already says. An
 * 'unreviewed' result where a refusal stands leaves the refusal standing -
 * exactly as the officers' own rounds do - because writing the outage over it
 * would turn refused code back into unsigned code, and unsigned code is what
 * the switch (and the console) is free to turn on.
 */
export async function policePlugin(
	plugin: Plugin,
	test: { ok: boolean; output: string },
	bot: { id: string; name: string } | null,
	fresh = false
): Promise<{ verdict: CreationVerdict; tests: PluginTestResult[]; line: string }> {
	const tests = bot ? await runPluginTests(plugin, bot) : [];
	const verdict = applyAttempt(
		await reviewPlugin({
			name: plugin.name,
			description: plugin.description,
			kind: plugin.kind,
			hookPoint: plugin.hook_point,
			parameters: plugin.parameters,
			code: plugin.code,
			selfTest: test,
			tests,
			model: policeModel()
		}),
		plugin.verification
	);
	const standing = refusedByPolice(plugin.verification);
	if (verdict.verdict === 'unreviewed' && standing) {
		// The officer was not reached. The row keeps the refusal it already
		// carries - untouched, attempts and awaitingHuman included - and the
		// switch is held down rather than left to an outage.
		updatePlugin(plugin.id, { enabled: 0 });
		return {
			verdict: verificationOf(plugin.verification)!,
			tests,
			line: `${signOff(test, tests, verdict)} | the refusal it already carries still stands`
		};
	}
	setPluginVerification(plugin.id, verdictJson(verdict));
	if (verdict.verdict === 'rejected' || (fresh && verdict.verdict === 'unreviewed')) {
		updatePlugin(plugin.id, { enabled: 0 });
	} else if (verdict.verdict === 'approved') updatePlugin(plugin.id, { enabled: 1 });
	return { verdict, tests, line: signOff(test, tests, verdict) };
}
