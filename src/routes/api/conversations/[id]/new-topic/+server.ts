import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { collapseContext, getBot, getConversation, listMessages, logActivity } from '$lib/server/db';
import { summarizeNow } from '$lib/server/memory';
import { defaultModel } from '$lib/server/llm';

/**
 * Start a fresh topic: collapse everything said so far into the running summary,
 * then withhold those messages from the model's context. The transcript stays
 * readable; the model just no longer carries the raw backlog.
 */
export const POST: RequestHandler = async ({ params }) => {
	const conv = getConversation(params.id);
	if (!conv) throw error(404, 'conversation not found');

	let summarized = false;
	// Summarise with the model the last-speaking bot actually uses - its own
	// override, else the provider's configured model.
	const lastBotId = [...listMessages(conv.id)].reverse().find((m) => m.bot_id)?.bot_id;
	const lastBot = lastBotId ? getBot(lastBotId) : undefined;
	const model = lastBot?.model || defaultModel();
	if (model) {
		try {
			summarized = await summarizeNow(conv.id, model, { force: true });
		} catch {
			// A provider failure must not block the reset; the messages are still
			// dropped from context, we just lose the gist.
		}
	}
	collapseContext(conv.id);
	logActivity(
		'',
		'system',
		summarized ? 'New topic — older messages collapsed into the summary' : 'New topic — context cleared'
	);
	return json({ ok: true, summarized });
};
