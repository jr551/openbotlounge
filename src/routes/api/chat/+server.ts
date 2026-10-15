import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addMessage,
	conversationBots,
	createConversation,
	deleteLastAssistantMessage,
	deleteMessage,
	getBot,
	getConversation,
	getMessage,
	listTasks,
	recentUserMessage,
	setMessageContent
} from '$lib/server/db';
import { boolField, readJson, strField } from '$lib/server/http';
import { cancelTask, startTask, steerTask } from '$lib/server/tasks';
import { classifyInterruption } from '$lib/server/steering';
import { runHooks } from '$lib/server/plugins';

/**
 * Queue a reply. The turn itself runs as a background task, so this returns as
 * soon as the work is handed off - the client watches `/api/tasks` for progress
 * and the conversation for the finished message.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);

	// Validate through the shared helpers: a non-string would otherwise reach
	// `.trim()` and surface as a 500 rather than a bad request. Every field is
	// read before the first write, so a body that is going to be refused cannot
	// leave a stored message or a deleted reply behind.
	const contentField = strField(body, 'content', 40_000);
	let convId = strField(body, 'conversation_id', 200) ?? '';
	const botId = strField(body, 'bot_id', 200) ?? '';
	const regenerate = boolField(body, 'regenerate') === true;
	const think = boolField(body, 'think');
	const replyTo = strField(body, 'reply_to', 200) ?? '';
	/** Force a new subtask instead of steering the running turn. */
	const branch = boolField(body, 'branch') === true;
	const messageId = strField(body, 'message_id', 200);

	const existing = convId ? getConversation(convId) : undefined;
	if (!existing && (convId || regenerate)) throw error(404, 'conversation not found');
	// A bots-only room is a spectator sport: the user watches it, and the only
	// line they can add is through `inject`, spoken as one of the bots.
	if (existing?.private) throw error(400, 'this room is private');
	// A reply points at the message it answers inside this conversation. An id
	// from anywhere else would render a quote the reader could never open, so it
	// is refused before the send is written rather than stored dangling.
	if (replyTo) {
		const quoted = existing ? getMessage(replyTo) : undefined;
		if (!quoted || quoted.conversation_id !== convId) {
			throw error(400, 'reply_to must name a message in this conversation');
		}
	}

	let members = existing ? conversationBots(existing.id) : [];
	if (existing && !members.length) throw error(400, 'conversation has no bots');
	// An explicit bot_id narrows the reply to that bot. One that is not in the
	// room would otherwise be ignored, and every member would answer instead.
	if (existing && botId && !members.some((b) => b.id === botId)) {
		throw error(400, `bot "${getBot(botId)?.name ?? botId}" is not in this conversation`);
	}
	if (!existing && !getBot(botId)) throw error(400, 'bot_id required for a new conversation');

	/**
	 * The member hooks are still running. They run inside the bots' sandboxes, so
	 * on a cold one - a container to create, boot and provision - awaiting them
	 * held this request open for half a minute, long past the point where a
	 * client gives up and loses the task ids it was waiting for. The turns wait
	 * on this instead, so a message is always rewritten before it is read.
	 */
	let hooksReady: Promise<void> | undefined;

	// The row the human's own line was stored as, when this is a send and not a
	// regenerate: it rides back with a steer so the client can mark exactly the
	// line that steered, by id, rather than guessing from the words it typed.
	let sentId = '';

	if (regenerate) {
		// In group chats the newest assistant message may belong to another bot,
		// so only fall back to it when the client did not name the reply.
		const msg = messageId ? getMessage(messageId) : undefined;
		if (messageId && (!msg || msg.conversation_id !== convId || msg.role !== 'assistant')) {
			throw error(400, 'message_id must be an assistant message in this conversation');
		}
		if (msg) deleteMessage(msg.id);
		else deleteLastAssistantMessage(convId);
	} else {
		const content = (contentField ?? '').trim();
		if (!content) throw error(400, 'empty message');
		if (!existing) {
			convId = createConversation([botId], 'direct').id;
			members = conversationBots(convId);
		}
		// A send that fires twice - a retried fetch, a double-submitted form -
		// must not write the line twice or answer it twice. The same words
		// landing in the same conversation moments later is the duplicate; a
		// user genuinely repeating themselves says it again after the window.
		if (recentUserMessage(convId, content, 10_000)) {
			return json({ conversation_id: convId, tasks: [], duplicate: true }, { status: 202 });
		}
		const stored = addMessage(convId, 'user', content, '', '', 0, '', replyTo);
		sentId = stored.id;
		hooksReady = rewriteWithHooks(convId, stored.id, content);
	}

	const conv = getConversation(convId)!;

	// Direct chats reply with the requested bot (or the sole member); group
	// chats let every member answer. An explicit bot_id narrows to that one.
	const requested = botId ? members.find((b) => b.id === botId) : undefined;
	// Cold storage is a lock only the human holds: an archived bot never gets a
	// turn, and a message meant for it is answered by a note, not a reply.
	const responders = (requested ? [requested] : conv.kind === 'group' ? members : [members[0]]).filter(
		(b) => !b.archived
	);
	if (responders.length === 0 && !regenerate) {
		const note = addMessage(
			convId,
			'user',
			'this bot is in cold storage - only the human can unlock it',
			'',
			'',
			0,
			'app'
		);
		// The note rides back with the send so the client can put it in the open
		// thread at once, instead of the reader seeing nothing until a poll.
		return json({ conversation_id: convId, tasks: [], archived: true, note }, { status: 202 });
	}

	if (regenerate) {
		// A regenerate replaces the reply, so a turn still writing one has to be
		// stopped first: left running, it finishes after the new task and the
		// transcript ends with two answers to one message.
		for (const t of listTasks({ conversationId: conv.id })) {
			if (t.status === 'running' && responders.some((b) => b.id === t.bot_id)) {
				cancelTask(t.id);
			}
		}
	}

	const prompt = regenerate ? 'regenerate' : (contentField ?? '').trim();
	// A regenerate rewrites the reply, it does not redo the turn: running with
	// tools would re-fire whatever the first turn did - a send_message would
	// deliver the relay a second time - so this turn composes text only.
	// A message sent while a bot is mid-task either steers the work in flight
	// or starts a task of its own. The classifier makes that call per
	// responder: a correction is queued into the running turn's tool loop and
	// needs no new task, while a separate ask runs in parallel rather than
	// interrupting. A turn that has already settled refuses the steer, and the
	// message takes the normal path.
	const tasks = await Promise.all(
		responders.map(async (bot) => {
			// A turn still working in this conversation is the first match: the
			// reply plainly belongs to the thread the human is typing in. When
			// the bot is busy somewhere else - a routine, a wake, a webhook, a
			// room of its own - that turn is still this bot mid-task, and a
			// correction aimed at it should steer the work in flight rather than
			// start a second turn beside it. `listTasks` lists running rows
			// first, newest first, so this is the newest work of the bot's.
			const inRoom = listTasks({ conversationId: conv.id, botId: bot.id }).find(
				(t) => t.status === 'running'
			);
			const away = inRoom ?? listTasks({ botId: bot.id }).find((t) => t.status === 'running');
			if (!regenerate && away && !branch) {
				// In this conversation the classifier's failure default is a safe
				// answer: the worst case is the running turn reading the human's
				// line in the thread they are already looking at. Reaching into
				// another conversation takes a real verdict - on a guess the
				// human's words land in a room they are not reading and their own
				// is left with no answer at all.
				const inThisThread = away.conversation_id === conv.id;
				let taken = false;
				try {
					const verdict = await classifyInterruption(away.prompt, prompt);
					taken =
						verdict.kind === 'steer' &&
						(inThisThread || verdict.confident) &&
						steerTask(away.id, prompt, conv);
				} catch (err) {
					// A verdict that cannot be reached, or a channel that throws, is
					// no reason to drop the send: it takes the normal path below and
					// gets a task of its own.
					console.error('steer attempt failed:', err);
				}
				if (taken) {
					// The steer has to be visible where the work is: when the turn
					// belongs to another conversation, the human's line is written
					// into that one too, so the reply it changed reads under the
					// message that changed it. In this conversation the row is the
					// send itself, stored before the classifier was asked.
					if (!inThisThread) {
						addMessage(away.conversation_id, 'user', prompt, '', '', 0, 'steer');
					}
					// `message_id` names the human's own line, so the client marks
					// that row and no other - two lines can read alike, their ids
					// cannot.
					return { id: away.id, bot_id: bot.id, steered: true, message_id: sentId };
				}
			}
			const task = startTask(conv, bot, prompt, {
				think,
				ready: hooksReady,
				noTools: regenerate
			});
			return { id: task.id, bot_id: task.bot_id };
		})
	);

	return json({ conversation_id: conv.id, tasks }, { status: 202 });
};


/**
 * Run every member's `before_reply` hooks over a message and store the result.
 *
 * Every member, not just the responder: that is what the request used to do
 * inline, and a room whose bots each rewrite the message should keep behaving
 * the same way. The turns are given this promise so that none of them reads the
 * conversation before the rewrite has landed.
 */
async function rewriteWithHooks(
	convId: string,
	messageId: string,
	content: string
): Promise<void> {
	try {
		let text = content;
		let ok = true;
		for (const b of conversationBots(convId)) {
			const r = await runHooks('before_reply', b.id, { message: text });
			text = r.message;
			ok = ok && r.ok;
		}
		// All-or-nothing: a message rewritten by only some of its hooks is not a
		// state anyone asked for, so a failed hook keeps the user's own words.
		if (ok && text !== content) setMessageContent(messageId, text);
	} catch (err) {
		// A hook that fails is already reported by runHooks; the message simply
		// stays as the user wrote it, and the turns must not be left waiting.
		console.error('before_reply hooks failed:', err);
	}
}
