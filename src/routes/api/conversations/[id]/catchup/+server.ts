import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, getConversation, listMessages, listTasks } from '$lib/server/db';
import { complete, defaultModel } from '$lib/server/llm';

/**
 * What happened while the user was away. Used when a lot accumulated, so the
 * chat opens with a short account of it instead of a wall of messages.
 */
export const POST: RequestHandler = async ({ params, url }) => {
	const conv = getConversation(params.id);
	if (!conv) throw error(404, 'conversation not found');

	// The opener sends the read stamp it saw, because the request that marks
	// the chat read races this one: by the time a digest is asked for, the row
	// usually already says "read just now" and the backlog looks empty. A
	// caller that does not send one gets the row's stamp, as before.
	const asked = Number(url.searchParams.get('since'));
	const since = Number.isFinite(asked) && asked > 0 ? asked : conv.last_read_at;
	const messages = listMessages(conv.id).filter((m) => m.created_at > since);
	if (!messages.length) return json({ summary: '', count: 0 });
	if (!defaultModel()) return json({ summary: '', count: messages.length });

	// Durable work the bots did, which the messages may only allude to.
	const done = listTasks({ conversationId: conv.id })
		.filter((t) => t.status === 'done' && t.finished_at > since)
		.map((t) => t.prompt)
		.slice(0, 12);

	const transcript = messages
		.map((m) => {
			const who = m.bot_id ? (getBot(m.bot_id)?.name ?? 'bot') : 'user';
			return `${who}: ${m.content.slice(0, 400)}`;
		})
		.join('\n')
		.slice(0, 8000);

	try {
		const summary = await complete(defaultModel(), [
			{
				role: 'system',
				content:
					'Someone stepped away from a chat and is catching up. In at most 90 words, ' +
					'tell them what the bots did and decided while they were gone. ' +
					'Plain prose, no headings or bullet points, no mention of being an AI. ' +
					'If something needs their attention, say so last.'
			},
			{
				role: 'user',
				content:
					(done.length ? `Work completed: ${done.join('; ')}\n\n` : '') +
					`Messages:\n${transcript}`
			}
		]);
		return json({ summary, count: messages.length });
	} catch {
		// A digest is a nicety; the raw messages are still right there.
		return json({ summary: '', count: messages.length });
	}
};
