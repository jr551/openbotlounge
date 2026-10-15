import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addFeedback,
	cancelRatingReaction,
	enqueueRatingReaction,
	getBot,
	getMessage,
	setMessageRating
} from '$lib/server/db';
import { numField, readJson } from '$lib/server/http';

export const POST: RequestHandler = async ({ params, request }) => {
	const message = getMessage(params.id);
	if (!message) throw error(404, 'message not found');
	const rating = numField(await readJson(request), 'rating');
	if (rating !== -1 && rating !== 0 && rating !== 1) {
		throw error(400, 'rating must be -1, 0 or 1');
	}
	setMessageRating(params.id, rating);
	// Tell the bot privately. Only real thumbs count, and only on a bot's own
	// reply - a cleared rating just stops counting.
	if (rating !== 0 && message.bot_id) {
		addFeedback(message.bot_id, message.id, rating, message.content);
	}
	// Queue the room's reaction: the row is the whole job, so the request
	// returns before the police have said a word. A changed thumb rewrites the
	// pending row rather than stacking a second announcement; a cleared one
	// cancels it. Ratings on a hidden bot's lines - the police's own messages
	// among them - are never announced.
	const author = message.bot_id ? getBot(message.bot_id) : undefined;
	if (rating === 0) {
		cancelRatingReaction(params.id);
	} else if (author && !author.hidden) {
		enqueueRatingReaction(params.id, author.id, rating, message.content);
	}
	return json({ ok: true });
};
