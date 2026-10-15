import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteFinishedTasks, listConversations, listTasks } from '$lib/server/db';

/**
 * Task tray feed: running work first, then recently finished. The Lounge's
 * own rounds are the bots talking among themselves on a schedule - stored
 * like any other task, but not the human's work to watch, so they are left
 * out of the tray rather than deleted.
 */
export const GET: RequestHandler = ({ url }) => {
	const conversationId = url.searchParams.get('conversation_id') ?? undefined;
	const botId = url.searchParams.get('bot_id') ?? undefined;
	const lounge = listConversations().find(
		(c) => c.kind === 'group' && c.title === 'Lounge' && c.private
	);
	const tasks = listTasks({ conversationId, botId }).filter(
		(t) => t.kind !== 'lounge' && t.conversation_id !== lounge?.id
	);
	return json({ tasks });
};

/** Clear the tray: finished tasks go; anything still running stays. */
export const DELETE: RequestHandler = () => {
	return json({ cleared: deleteFinishedTasks() });
};
