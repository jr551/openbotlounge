/**
 * The hats a bot can wear.
 *
 * Kept here rather than inside the avatar so the bot's own tool, the avatar and
 * anything else that lists them all agree on one set. A bot wears at most one,
 * and the name in the database is one of these or '' for none.
 */
export const HATS = [
	'party',
	'top',
	'hard',
	'night',
	'wizard',
	'crown',
	'propeller',
	'halo',
	'antenna',
	'flower',
	'cap'
] as const;

export type HatName = (typeof HATS)[number];

/** A hat, or '' for a bare head. */
export type Hat = HatName | '';

export function isHat(value: string): value is HatName {
	return (HATS as readonly string[]).includes(value);
}

/**
 * What a bot wears when it has not chosen: a costume for what it is doing.
 * Everything not listed leaves it bare-headed, which is most of the time.
 */
const FOR_ACTIVITY: Record<string, HatName> = {
	thinking: 'propeller',
	dreaming: 'night',
	shell: 'hard',
	browser: 'hard',
	sandbox: 'hard',
	plugin: 'wizard',
	secret: 'wizard',
	wake: 'party',
	routine: 'party',
	schedule: 'party',
	group: 'party',
	webhook: 'party',
	reacted: 'crown',
	ping: 'crown',
	wait: 'cap',
	message: 'cap',
	task: 'hard',
	typing: 'hard'
};

export function hatForActivity(kind: string): Hat {
	return FOR_ACTIVITY[kind] ?? '';
}
