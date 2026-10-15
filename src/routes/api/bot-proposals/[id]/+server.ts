import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { botDraftError, createBotFromDraft, type BotDraft } from '$lib/server/bot-draft';
import { deleteBotProposal, getBotProposal, type BotProposal } from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';

/** The proposal still waiting on the human, as the card shows it. */
export const GET: RequestHandler = ({ params }) => {
	const proposal = getBotProposal(params.id);
	if (!proposal) throw error(404, 'no such proposal');
	return json(proposal);
};

/** The proposed bot as a draft, or the error to answer an unreadable row with. */
function draftOf(proposal: BotProposal): BotDraft {
	try {
		const parsed = JSON.parse(proposal.payload);
		// A pitch names no machine, so an approved bot gets the full desktop.
		if (parsed && typeof parsed === 'object') return { machine_tier: 'full', ...parsed } as BotDraft;
	} catch {
		// fall through to the same answer
	}
	throw error(409, 'that proposal is unreadable - decline it and ask again');
}

/**
 * The human's verdict on a bot's pitch for a new bot. Approving creates the bot
 * through the same path the bots API uses and drops the proposal; declining
 * just drops it. The row is claimed by deleting it, and the claim is what makes
 * the answer final: two concurrent answers both read the card, but only the one
 * whose DELETE removes a row goes on to act, so a card can never be answered
 * twice and an approve racing a decline can never create a bot the human also
 * declined. A bot the human already has is only ever left alone: the draft is
 * checked again before the claim, so a name taken since the pitch was made
 * fails cleanly with the proposal still waiting to be declined.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const proposal = getBotProposal(params.id);
	if (!proposal) throw error(404, 'no such proposal');
	const body = await readJson(request);
	if (!boolField(body, 'approve')) {
		// The claim is the delete: a concurrent answer that already took the row
		// loses it and answers like any second caller.
		if (!deleteBotProposal(proposal.id)) throw error(404, 'no such proposal');
		return json({ declined: true });
	}
	const draft = draftOf(proposal);
	const bad = botDraftError(draft);
	if (bad) throw error(bad.status, bad.message);
	// Claim before creating: two concurrent approvals must not both pass the
	// draft check and create two bots.
	if (!deleteBotProposal(proposal.id)) throw error(404, 'no such proposal');
	const bot = createBotFromDraft(draft);
	return json(bot, { status: 201 });
};
