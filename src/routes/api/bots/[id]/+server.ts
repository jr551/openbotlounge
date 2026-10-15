import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addMessage, deleteBot, getBot, listActivities, listBots, listConversations, listRoutines, updateBot } from '$lib/server/db';
import { boolField, readJson, strField } from '$lib/server/http';
import { withSshKey } from '$lib/server/ssh-keys';
import { BROWSER_RECIPES, DESKTOP_RECIPES, destroyMachine } from '$lib/server/machine';
import { assertBotModel, reservedBotName } from '$lib/server/bot-draft';
import { isHat } from '$lib/hats';
import { ensureCompanyProfile } from '$lib/server/profiles';

/**
 * The hat in the body: a library name, '' for none, or undefined to leave it.
 * An unknown name is refused like every other bad field on this route rather
 * than silently cleared - a typo must not strip the hat the bot is wearing.
 */
function hatField(body: Record<string, unknown>): string | undefined {
	const raw = strField(body, 'hat', 20);
	if (raw === undefined) return undefined;
	const name = raw.trim().toLowerCase();
	if (name && !isHat(name)) throw error(400, `unknown hat "${name}"`);
	return name;
}

export const GET: RequestHandler = ({ params }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'not found');
	return json({
		bot: withSshKey(bot),
		routines: listRoutines(bot.id),
		// The panel caps what it renders itself; it needs a deeper window so its
		// "…and N earlier" line can count what it folded away.
		activities: listActivities(bot.id, 200)
	});
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const bot = getBot(params.id);
	if (!bot) throw error(404, 'not found');
	const body = await readJson(request);
	const rawName = strField(body, 'name', 60);
	const newName = rawName?.trim();
	// A whitespace-only name trims to nothing, and a bot with no name cannot be
	// addressed at all; POST refuses that, so PATCH must too.
	if (rawName !== undefined && !newName) throw error(400, 'name required');
	// Renaming onto another bot's name would strand it: bots are addressed by
	// name, and two with the same one can only ever reach the first.
	if (newName && listBots().some((b) => b.id !== params.id && b.name.toLowerCase() === newName.toLowerCase())) {
		throw error(409, `a bot named "${newName}" already exists`);
	}
	// Renaming onto a name the app already speaks as - 'system', the human's
	// USER_NAME, 'the police' - would sign this bot's messages with a label the
	// reader trusts as someone else's.
	if (newName && reservedBotName(newName)) {
		throw error(400, `"${newName}" is a name the app already uses`);
	}
	const color = strField(body, 'color', 20);
	if (color && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
		throw error(400, 'color must be a hex colour, e.g. #4f8ef7');
	}
	const model = strField(body, 'model', 120);
	if (model) await assertBotModel(model);
	const desktopRecipe = strField(body, 'desktop_recipe', 40);
	if (desktopRecipe && !DESKTOP_RECIPES[desktopRecipe]) {
		throw error(400, `unknown desktop recipe "${desktopRecipe}"`);
	}
	const browserRecipe = strField(body, 'browser_recipe', 40);
	if (browserRecipe && !BROWSER_RECIPES[browserRecipe]) {
		throw error(400, `unknown browser recipe "${browserRecipe}"`);
	}
	const machineTier = strField(body, 'machine_tier', 20);
	if (machineTier && !['full', 'terminal', 'none'].includes(machineTier)) {
		throw error(400, `unknown machine tier "${machineTier}"`);
	}
	// Nix is a human-only switch: the store lives on a volume, so enabling it
	// hands the bot a package manager that survives rebuilds.
	const nixFlag = boolField(body, 'nix_enabled');
	const nixEnabled = nixFlag === undefined ? undefined : nixFlag ? 1 : 0;
	// Cold storage is a plain flag: true archives, false brings the bot back.
	const archivedFlag = boolField(body, 'archived');
	const archived = archivedFlag === undefined ? undefined : archivedFlag ? 1 : 0;
	updateBot(params.id, {
		name: newName,
		persona: strField(body, 'persona', 8000),
		avatar: strField(body, 'avatar', 8),
		color,
		model,
		badge: strField(body, 'badge', 40),
		hat: hatField(body),
		desktop_recipe: desktopRecipe,
		browser_recipe: browserRecipe,
		machine_tier: machineTier,
		nix_enabled: nixEnabled,
		archived
	});
	// A rename or a new persona re-seeds the staff-board page only when the bot
	// never wrote one itself; ensureCompanyProfile leaves an existing file be.
	const saved = getBot(params.id);
	if (saved) void ensureCompanyProfile(saved).catch(() => {});
	return json(withSshKey(saved ?? bot));
};
export const DELETE: RequestHandler = async ({ params, request }) => {
	// Killing a bot asks why: the reason is announced in the Lounge so the
	// other bots can gossip about the death on the next social tick.
	const body = await readJson(request).catch(() => ({}));
	const reason = strField(body, 'reason', 300) ?? '';
	const bot = getBot(params.id);
	// Its container is a full browser image; nothing else knows about it once
	// the bot row is gone, so tear it down here or it runs forever.
	const removed = deleteBot(params.id);
	await destroyMachine(params.id).catch(() => {});
	if (!removed) throw error(404, 'no such bot');
	const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge');
	if (lounge && bot) {
		addMessage(
			lounge.id,
			'user',
			`[Lounge] ${bot.name} was killed by the human${reason ? ` - "${reason}"` : ''}`,
			'',
			'',
			0,
			'app'
		);
	}
	return new Response(null, { status: 204 });
};
