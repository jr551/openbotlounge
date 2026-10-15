import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJson, strField } from '$lib/server/http';
import {
	conversationBots,
	deleteConversation,
	getConversation,
	getSummary,
	latestCompactionReview,
	listMessagesPage,
	listNotes,
	reactionsFor,
	updateConversation
} from '$lib/server/db';

export const GET: RequestHandler = ({ params, url }) => {
	const conv = getConversation(params.id);
	if (!conv) throw error(404, 'not found');
	// The transcript pages newest-first: `before`/`before_ts` are the oldest
	// message the client already holds, so a "load earlier" asks for what came
	// before it rather than re-downloading the whole thread.
	const limit = Number(url.searchParams.get('limit')) || undefined;
	const before = url.searchParams.get('before') || undefined;
	const beforeTs = Number(url.searchParams.get('before_ts')) || undefined;
	const page = listMessagesPage(conv.id, { beforeId: before, beforeTs, limit });
	return json({
		conversation: conv,
		messages: page.messages,
		has_more: page.hasMore,
		bots: conversationBots(conv.id),
		reactions: reactionsFor(conv.id),
		notes: listNotes(conv.id),
		// The running summary the folded backlog collapsed into, so the reader
		// can diff what was folded away against what replaced it.
		summary: getSummary(conv.id)?.summary ?? '',
		// The police's sign-off on the last fold: verdict and reason, shown when
		// the fold is opened and otherwise invisible.
		review: latestCompactionReview(conv.id) ?? null
	});
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const conv = getConversation(params.id);
	if (!conv) throw error(404, 'not found');
	const body = await readJson(request);
	const raw = strField(body, 'title', 120);
	const title = raw?.trim();
	// An empty title would show as a nameless row; the list already has a
	// derived name for one that was never given, so refuse rather than store ''.
	if (raw !== undefined && !title) throw error(400, 'title required');
	updateConversation(conv.id, { title });
	return json(getConversation(conv.id));
};

export const DELETE: RequestHandler = ({ params }) => {
	if (!deleteConversation(params.id)) throw error(404, 'no such conversation');
	return new Response(null, { status: 204 });
};
