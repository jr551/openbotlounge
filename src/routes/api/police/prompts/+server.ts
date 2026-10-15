import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPolicePrompts } from '$lib/server/db';

/**
 * Unresolved police prompts for the modal. The officer creates one (see
 * police.ts `emitPolicePrompt`), the UI polls here, and an answer POSTs to
 * /api/police/prompts/[id]/answer. Resolved rows are history and are not sent.
 */
export const GET: RequestHandler = () => {
	const prompts = listPolicePrompts({ unresolvedOnly: true });
	return json({ prompts });
};
