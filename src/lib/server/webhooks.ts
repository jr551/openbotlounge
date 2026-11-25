import { randomUUID } from 'node:crypto';
import {
	addMessage,
	createWebhook as insertWebhook,
	deleteWebhook,
	getBot,
	getConversation,
	getWebhookByRoutine,
	getWebhookByToken,
	listWebhooks,
	logActivity,
	type Webhook
} from './db';
import { startTask } from './tasks';
import { fireWatchByToken } from './wake';
import { getRoutine } from './db';
import { runRoutineNow } from './scheduler';

// Re-exported so the API layer only needs this module.
export { deleteWebhook, listWebhooks };

/** Public URL path an external service POSTs to. */
export function webhookUrl(token: string): string {
	return `/api/hooks/${token}`;
}

/**
 * Register a webhook that wakes the bot in the given conversation - or, with
 * a routine id, one that runs that routine instead. The routine keeps its own
 * prompt and conversation; the template only applies to plain webhooks.
 */
export function createWebhook(
	botId: string,
	conversationId: string,
	name: string,
	promptTemplate = '',
	routineId = ''
): Webhook {
	if (routineId && !getRoutine(routineId)) throw new Error('no such routine');
	return insertWebhook({
		token: randomUUID(),
		bot_id: botId,
		conversation_id: conversationId,
		name,
		prompt_template: promptTemplate,
		enabled: 1,
		routine_id: routineId
	});
}

/** The webhook bound to a routine, if it has one. */
export function routineWebhook(routineId: string): Webhook | undefined {
	return getWebhookByRoutine(routineId);
}

/**
 * Deliver an inbound POST to the owning bot: injects the payload as a user
 * message and runs a bot turn. Never throws — returns false on a missing or
 * disabled webhook, or when the turn fails.
 */
export async function fireWebhook(token: string, payload: string): Promise<boolean> {
	try {
		// A token that belongs to a watch is the watch's business first: the bot
		// may be waiting for one particular payload, and a POST that does not
		// carry it must leave the watch armed instead of spending a turn.
		if (await fireWatchByToken(token, payload)) return true;
		const hook = getWebhookByToken(token);
		if (!hook || !hook.enabled) return false;
		// A routine-bound hook runs that routine - the same firing the clock
		// would produce, plus the POST body as a note. A switched-off routine
		// refuses the same way a disabled hook does.
		if (hook.routine_id) {
			const taskId = runRoutineNow(hook.routine_id, payload.slice(0, 500));
			if (!taskId) return false;
			logActivity(hook.bot_id, 'webhook', `Webhook "${hook.name}" fired its routine`);
			return true;
		}
		const bot = getBot(hook.bot_id);
		const conv = getConversation(hook.conversation_id);
		if (!bot || !conv) return false;
		const text = hook.prompt_template
			// The payload is attacker-controlled text, so it goes in through a
			// function: `$&`, `$'` and friends in a replacement *string* would
			// otherwise be expanded and corrupt the body the bot sees.
			? hook.prompt_template.replace(/\{payload\}/g, () => payload)
			: `[Webhook ${hook.name}] ${payload}`;
		addMessage(conv.id, 'user', text, '', '', 0, 'webhook');
		// The reply runs as a background task, not inside this request: awaiting
		// it held the POST open for the whole turn and, when the turn failed,
		// returned 404 for a payload that was already stored - a sender that
		// retries on failure would deliver the same message twice.
		startTask(conv, bot, text.slice(0, 200));
		logActivity(bot.id, 'webhook', `Webhook "${hook.name}" fired`);
		return true;
	} catch {
		return false;
	}
}
