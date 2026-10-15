import {
	getBot,
	logActivity,
	setThinkingAccess,
	type Bot,
	type ThinkingGrant,
	type ThinkingRequest
} from './db';

/**
 * Thinking hard: a bot's turns run at the provider's lowest effort by default,
 * and the maximum only while the human's grant is live. The shape is the debug
 * access flow's: a bot that wants it calls request_thinking, which leaves a
 * request the human answers with Approve/Decline in the thread. Approving is
 * the only thing that writes a grant, it is always time-limited, and the human
 * can revoke it early. While a grant is live the runner asks for the
 * provider's maximum effort on that bot's calls; the moment it lapses the bot
 * is back to low.
 */
/** How long one approval lasts. Short on purpose: hard thinking is a session,
 *  and a grant nobody remembers giving should be gone by dinner. */
export const THINKING_GRANT_MINUTES = 30;

// ---- The gate ----

/**
 * The grant a bot is holding, or null. An elapsed grant reads as none: the
 * clock is half the gate, so a bot handed hard thinking yesterday holds
 * nothing today even though the row is still in the database.
 */
export function thinkingGrant(bot: Pick<Bot, 'thinking_grant'> | undefined): ThinkingGrant | null {
	if (!bot?.thinking_grant) return null;
	try {
		const grant = JSON.parse(bot.thinking_grant) as ThinkingGrant;
		if (!Number.isFinite(grant.expires_at) || grant.expires_at <= Date.now()) return null;
		return grant;
	} catch {
		// An unreadable row is no grant, never a guessed one.
		return null;
	}
}

/** The ask a bot has outstanding, or null. */
export function thinkingRequest(bot: Pick<Bot, 'thinking_request'> | undefined): ThinkingRequest | null {
	if (!bot?.thinking_request) return null;
	try {
		return JSON.parse(bot.thinking_request) as ThinkingRequest;
	} catch {
		return null;
	}
}

/** What the request card shows: the ask, the grant, and whether it is live. */
export function thinkingState(bot: Bot): { request: ThinkingRequest | null; grant: ThinkingGrant | null } {
	return { request: thinkingRequest(bot), grant: thinkingGrant(bot) };
}

/** A bot's ask, replacing any earlier one so it can never leave two cards. */
export function askForThinking(botId: string, reason: string): string {
	const bot = getBot(botId);
	if (!bot) return 'error: bot not found';
	const reasonText = String(reason ?? '').trim().slice(0, 300);
	if (!reasonText) return 'error: a reason is required - say what needs the extra thinking and why';
	const held = thinkingGrant(bot);
	if (held) {
		return (
			'you already hold a thinking grant until ' +
			`${new Date(held.expires_at).toISOString().slice(11, 16)} UTC - ` +
			'use it rather than asking again'
		);
	}
	setThinkingAccess(botId, {
		request: JSON.stringify({ reason: reasonText, at: Date.now() } satisfies ThinkingRequest)
	});
	logActivity(botId, 'thinking', `Requested hard thinking: ${reasonText}`);
	return (
		'request sent - the human sees a card in this chat with Approve and Decline, and ' +
		'nothing changes until they answer. Hard thinking is never yours to grant.'
	);
}

/** The human's yes: a time-limited grant replaces the ask. */
export function approveThinking(botId: string, minutes: number): void {
	const ask = thinkingRequest(getBot(botId));
	const at = Date.now();
	const grant: ThinkingGrant = {
		reason: ask?.reason ?? '',
		granted_at: at,
		expires_at: at + minutes * 60_000
	};
	setThinkingAccess(botId, { grant: JSON.stringify(grant), request: '' });
	logActivity(botId, 'thinking', `Hard thinking granted for ${minutes} minutes`);
}

/** The human's no, or a later change of mind: nothing is granted either way. */
export function clearThinking(botId: string, why: 'declined' | 'revoked'): void {
	if (why === 'declined') setThinkingAccess(botId, { request: '' });
	else setThinkingAccess(botId, { request: '', grant: '' });
	logActivity(botId, 'thinking', `Hard thinking ${why} by the human`);
}
