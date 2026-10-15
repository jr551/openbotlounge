import type { Bot, Conversation } from '$lib/types';

/**
 * How a conversation reads in a list - the rail and the phone's chat list show
 * the same rows, so the naming rules live here rather than twice.
 */

/**
 * The bots-only lounge, told apart from bot-to-bot pair rooms the way the
 * server itself finds it: the private room titled 'Lounge' (scheduler and
 * police both look it up by that title, so a rename breaks their tracking
 * too - it is the room's identity, not a label). Pair rooms share the
 * private flag but are plumbing between two bots; they stay out of the rail
 * unless an external lounge bot is paired in (fed), which makes the room a
 * place the human visits.
 */
export function isLounge(c: Conversation): boolean {
	return !!c.private && c.title === 'Lounge';
}

/**
 * Whether a private group should be hidden from the human's conversation
 * list. The bots-only lounge is the only private group the human is meant
 * to open - every other private group is bot-to-bot plumbing (pair rooms
 * like "Testy ⇄ cakey") whose turns now surface as grey system lines inside
 * each participant's DM feed (kind='relay'). Keeping the room in the list
 * duplicates plumbing as a chat room and clutters the rail, so it is
 * filtered out everywhere the list renders. Visible = direct chats, human
 * groups, and the Lounge itself.
 */
export function isVisibleConversation(c: Conversation): boolean {
	if (c.kind === 'group' && c.private && !isLounge(c)) return false;
	return true;
}

/** A bot-to-bot pair room: private, exactly two members, not the lounge. */
export function isPairRoom(c: Conversation, bots: Bot[]): boolean {
	return !!c.private && bots.length === 2 && !isLounge(c);
}

/**
 * The police's own line to the human. It is the one direct chat whose bot is a
 * hidden system bot: the officer is not one of the human's bots (see
 * listVisibleBots), but it is their help bot, so the contact list marks the row
 * as such rather than leaving it to read as another bot to gossip with.
 */
export function isPoliceContact(c: Conversation, bots: Bot[]): boolean {
	return c.kind === 'direct' && bots.length === 1 && !!bots[0].hidden;
}

/**
 * The name a row shows. A direct chat and the private lounge are named after
 * their bots, and an untitled group after its size, so the raw title is blank
 * or 'New chat' there.
 */
export function conversationName(c: Conversation, bots: Bot[]): string {
	if (isLounge(c)) return `Bots' private lounge`;
	if (c.kind === 'direct') return bots[0]?.name ?? 'Unknown';
	return c.title === 'New chat' ? `${bots.length || 'New'} group` : c.title;
}

/** Flatten markdown to plain prose so previews never show raw syntax. */
export function plainText(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`#>~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Last-message snippet, falling back to who is in the room. */
export function conversationSnippet(c: Conversation, bots: Bot[]): string {
	const raw = plainText(c.last_message ?? '');
	if (!raw) {
		if (isPoliceContact(c, bots)) return 'your help bot — ask me anything';
		return c.kind === 'group' ? bots.map((b) => b.name).join(', ') : 'Say hi 👋';
	}
	// Cut on code points, not UTF-16 units: slicing mid-surrogate-pair leaves a
	// lone surrogate that renders as mojibake at the end of the snippet.
	const chars = [...raw];
	return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : raw;
}

/** A row timestamp: the time today, the weekday this week, a date beyond. */
export function shortTime(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) {
		return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}
	if (Date.now() - ts < 7 * 86400_000) return d.toLocaleDateString([], { weekday: 'short' });
	return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
