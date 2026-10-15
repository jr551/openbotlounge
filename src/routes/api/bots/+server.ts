import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listBots, listSettings } from '$lib/server/db';
import { botPausedUntil } from '$lib/server/scheduler';
import { assertBotDraft, assertBotModel, BOT_NAME_MAX, BOT_PERSONA_MAX, createBotFromDraft } from '$lib/server/bot-draft';
import { readJson, strField } from '$lib/server/http';
import { withSshKey } from '$lib/server/ssh-keys';
import { ensureCompanyProfile } from '$lib/server/profiles';

/**
 * How long a create waits on the provider to vouch for a model name. Long
 * enough for a slow endpoint to answer, short enough that a dead one fails
 * the request instead of holding it open until the client gives up - a
 * client that times out retries, and a retry after a silent create is how
 * duplicate bots arrive.
 */
const MODEL_CHECK_TIMEOUT_MS = 10_000;

export const GET: RequestHandler = () => {
	// Every bot carries its SSH public key: the bot page shows it, and nothing
	// else needs it. paused_until is when a rate-limited bot may run again - 0
	// or absent means free - so the UI can say "holding" instead of "broken".
	const set = listSettings();
	return json({ bots: listBots().map((b) => ({ ...withSshKey(b), paused_until: botPausedUntil(b.id, set) })) });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	// The rules a new bot has to pass live in bot-draft.ts: the propose_bot tool
	// and the approval of a proposed bot decide with the same ones.
	const draft = {
		name: strField(body, 'name', BOT_NAME_MAX) ?? '',
		persona: strField(body, 'persona', BOT_PERSONA_MAX) ?? '',
		avatar: strField(body, 'avatar', 8) ?? '🤖',
		// Empty lets the db hand out an unused palette colour.
		color: strField(body, 'color', 20) ?? '',
		model: strField(body, 'model', 120) ?? '',
		badge: strField(body, 'badge', 40) ?? '',
		desktop_recipe: strField(body, 'desktop_recipe', 40) ?? '',
		browser_recipe: strField(body, 'browser_recipe', 40) ?? '',
		machine_tier: strField(body, 'machine_tier', 20) ?? ''
	};
	assertBotDraft(draft);
	// A stored model the provider does not serve fails only when the bot next
	// speaks, so it is refused here rather than saved. The provider lookup is
	// bounded: a create that cannot be validated fails fast with a 503 the
	// client can show, rather than hanging into a retry that double-creates.
	try {
		await assertBotModel(draft.model, AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS));
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(503, 'the model provider cannot be reached to validate this model');
	}
	// The name check above ran before the provider round-trip; another create
	// may have landed the name while this one waited. Re-check on the spot so
	// the loser gets a 409 instead of two bots sharing a name.
	assertBotDraft(draft);
	const bot = createBotFromDraft(draft);
	// Its page on the /company staff board is seeded lazily here too, so a bot
	// that never wakes a machine still has one. Best-effort: the drive may be
	// unreachable and the bot exists either way.
	void ensureCompanyProfile(bot).catch(() => {});
	return json(withSshKey(bot), { status: 201 });
};
