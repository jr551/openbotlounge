import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addMessage, conversationBots, getBot, getConversation, listTasks, logActivity } from '$lib/server/db';
import { startTask, steerTask } from '$lib/server/tasks';
import { readJson, strField } from '$lib/server/http';
import { classifyInterruption } from '$lib/server/steering';
import { maybeRequestMiniReview } from '$lib/server/police';

/**
 * Slip a line into a bots-only room. The room is a spectator sport, so this is
 * the one thing the user can do in it - and the others react. Two modes:
 * 'as_bot' plants the words under a member's name (the default, and the joke);
 * 'director' speaks as the app itself - a guidance line the whole room sees,
 * attributed to nobody.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const conv = getConversation(params.id);
	if (!conv) throw error(404, 'conversation not found');
	if (!conv.private) throw error(400, 'this room is not private');

	const body = await readJson(request);
	const content = (strField(body, 'content', 2000) ?? '').trim();
	if (!content) throw error(400, 'content required');
	const mode = strField(body, 'mode', 20) ?? 'as_bot';
	if (mode !== 'as_bot' && mode !== 'director') throw error(400, 'mode must be as_bot or director');

	const members = conversationBots(conv.id);
	let prompt: string;
	if (mode === 'director') {
		// The director's line is the app's voice, not a bot's: kind 'app' keeps
		// it out of the spectator's reach and reads as the room itself speaking.
		addMessage(conv.id, 'user', `The human says: ${content}`, '', '', 0, 'app');
		logActivity('', 'inject', `Director note in ${conv.title}: ${content.slice(0, 80)}`);
		prompt = content.slice(0, 200);
	} else {
		const asBotId = strField(body, 'bot_id', 80) ?? '';
		const speaker = members.find((b) => b.id === asBotId) ?? getBot(asBotId);
		if (!speaker) throw error(400, 'pick a bot to speak as');
		const planted = addMessage(conv.id, 'assistant', content, speaker.id, speaker.model || '', 0, 'injected');
		// A line planted under a bot's name is still a bot-to-bot line: the
		// police's flag reads it the same way, and a suspicious one puts the name
		// it was planted under under review - which is the joke the human is
		// playing.
		maybeRequestMiniReview(planted, conv);
		logActivity(speaker.id, 'message', `(as ${speaker.name}) ${content.slice(0, 80)}`);
		prompt = content.slice(0, 200);
	}

	// Let up to two of the others react, which is the whole point. A director
	// note has no speaker to exclude, so any two members may answer it. A
	// member that is already mid-turn takes the line as a steer instead of a
	// second task beside it - which is what the human means by dropping it in
	// ("steer the room"), and the only way to change a round in progress.
	const speakers = mode === 'director' ? members : members.filter((b) => b.id !== (strField(body, 'bot_id', 80) ?? ''));
	const tasks = (
		await Promise.all(
			speakers.slice(0, 2).map(async (b) => {
				const running = listTasks({ conversationId: conv.id, botId: b.id }).find(
					(t) => t.status === 'running'
				);
				let steered = false;
				if (running) {
					try {
						// The room is this conversation, so the classifier's failure
						// default is a safe steer here - the running member reads the
						// line the human just dropped into the room they are watching.
						const verdict = await classifyInterruption(running.prompt, prompt);
						steered = verdict.kind === 'steer' && steerTask(running.id, prompt);
					} catch (err) {
						// The line is already in the room: a verdict or a channel that
						// throws must not leave it hanging with nobody reacting.
						console.error('lounge steer failed:', err);
					}
				}
				if (steered) {
					// '' marks a member the line steered rather than woke: it is
					// not a new task, so it has no id to report.
					return '';
				}
				return startTask(conv, b, prompt).id;
			})
		)
	).filter((id) => id !== '');

	return json({ ok: true, tasks });
};
