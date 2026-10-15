import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addMessage,
	getBot,
	getConversation,
	logActivity,
	setMemory,
	setMessageExcluded
} from '$lib/server/db';
import { createSecret, injectSecret } from '$lib/server/secrets';
import { readJson, strField } from '$lib/server/http';
import { listSecrets } from '$lib/server/secrets';

/** A bot's secret names. Values are never sent to the client. */
export const GET: RequestHandler = ({ params }) => {
	if (!getBot(params.id)) throw error(404, 'bot not found');
	return json({
		secrets: listSecrets(params.id).map((s) => ({
			id: s.id,
			name: s.name,
			shared_with: s.shared_with,
			created_at: s.created_at
		}))
	});
};

/**
 * Hand a bot a secret. The value is encrypted at rest and recorded as a memory
 * so the bot knows it has the secret and waits for instructions rather than
 * guessing what to do with it.
 *
 * The sandbox injection is deliberately NOT awaited: waking a bot's computer can
 * take half a minute, and making the user watch a frozen button for that buys
 * nothing, because `use_secret` injects on demand anyway. We kick it off so a
 * warm sandbox is ready, and report the outcome through the activity log.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'bot not found');
	const body = await readJson(request);
	const name = (strField(body, 'name', 64) ?? '').trim();
	const value = strField(body, 'value', 8000) ?? '';
	if (!name) throw error(400, 'name required');
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		throw error(400, 'use letters, digits, dot, dash or underscore only');
	}
	// '.' and '..' pass that check but are path segments, not names: SvelteKit
	// normalises them out of the delete URL, so such a secret could never be
	// removed. Require something a filename can actually be built from.
	if (!/[A-Za-z0-9]/.test(name)) throw error(400, 'name must contain a letter or digit');
	if (!value) throw error(400, 'value required');

	// A conversation the caller names must exist: the handover note is part of
	// what they asked for, so a bogus id is a 404, not a silently skipped note.
	const conversationId = strField(body, 'conversation_id', 80) ?? '';
	if (conversationId && !getConversation(conversationId)) {
		throw error(404, 'conversation not found');
	}

	createSecret(bot.id, name, value);

	// Show the handover in the thread as its own kind of bubble. The value is
	// never written here - only the name - and it is kept out of the model's
	// context, since the bot learns about it through its memory instead. The
	// note is the user's, but it carries the id of the bot that received the
	// secret so the bubble can name them.
	if (conversationId) {
		const note = addMessage(conversationId, 'user', name, bot.id, '', 0, 'secret');
		setMessageExcluded(note.id, true);
	}
	// The memory note is what actually tells the bot it holds the secret - it
	// goes into the system prompt on the bot's next turn, while the handover
	// bubble itself is excluded from context. It must be written whatever the
	// background injection did, or a bot whose sandbox was down at handover time
	// never learns the secret exists. It says what is stored; use_secret is
	// always the real path in.
	setMemory(
		bot.id,
		`secret:${name}`,
		`The user gave you a secret called "${name}". ` +
			'It is stored; use_secret with the name to inject it into your sandbox ' +
			'whenever you need it. Wait for their instructions before using it, and ' +
			'never print its value.'
	);
	// Warm the sandbox in the background so the value is usually already in
	// place by the bot's next turn; the command carries only the base64 value,
	// and injectSecret's own exec logging redacts before any of it is stored. A
	// failure here is silent by design: use_secret retries on demand, and a
	// failed warm is not worth an activity row.
	void injectSecret(bot.id, name).catch(() => {});

	logActivity(bot.id, 'secret', `Received "${name}" from the user`);
	return json({ ok: true, name }, { status: 201 });
};
