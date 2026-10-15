/**
 * The @mention pattern the thread chips with: every bot's name plus the
 * handles a bot uses to call for the human. Built per render so a renamed bot
 * chips under its new name at once.
 *
 * Callers must not reuse one regex across `.test()` calls - the `g` flag's
 * lastIndex carries between them and silently skips matches. `matchAll` is
 * safe: it clones the pattern internally.
 */
export function mentionRegex(names: string[]): RegExp {
	const handles = ['you', 'user', 'human'];
	const escaped = [...names.filter(Boolean), ...handles].map((n) =>
		n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	);
	return new RegExp(`@(${escaped.join('|')})\\b`, 'g');
}
