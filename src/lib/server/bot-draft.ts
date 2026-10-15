import { error } from '@sveltejs/kit';
import {
	addMessage,
	createBot,
	createConversation,
	listBots,
	updateBot,
	type Bot
} from './db';
import { config } from './config';
import { complete, defaultModel, listModels } from './llm';
import { BROWSER_RECIPES, DESKTOP_RECIPES } from './machine';
import { startTask } from './tasks';
import { POLICE_PERSONA, ensurePoliceBot, meterPoliceCall, policeModel } from './police';
import { directConversationWith } from './db';

/** The longest name a bot may be given; the API, the tool and the card share one rule. */
export const BOT_NAME_MAX = 60;
/** The longest persona a bot may be given. */
export const BOT_PERSONA_MAX = 8000;
/** A colour as the bots API stores it: a hex triplet, or none at all. */
const BOT_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Everything a new bot is made from; only the name ever has to be there. */
export interface BotDraft {
	name: string;
	persona?: string;
	avatar?: string;
	color?: string;
	model?: string;
	badge?: string;
	/** Desktop recipe name from machine.ts's catalog; '' = the default. */
	desktop_recipe?: string;
	/** Browser recipe name from machine.ts's catalog; '' = the default. */
	browser_recipe?: string;
	/** 'full' | 'terminal' | 'none'; '' = 'full'. */
	machine_tier?: string;
}
/**
 * Names the transcript already uses for things that are not bots: the app's
 * own notes are authored 'system'/'app', the human answers as USER_NAME, and
 * the police bot speaks as 'the police'. A bot wearing one of those would sign
 * its messages with a label the reader trusts as someone else's.
 */
export function reservedBotName(name: string): boolean {
	const taken = ['system', 'app', 'police', 'the police', 'admin', 'everyone', config.userName];
	return taken.some((t) => t && t.toLowerCase() === name.toLowerCase());
}

/**
 * What is wrong with a draft for a new bot, as the status and message the API
 * answers with; null when it can be created. The bots API, the propose_bot tool
 * and the approval of a proposed bot all decide here, so a name one of them
 * accepts is never refused by another.
 */
export function botDraftError(draft: BotDraft): { status: number; message: string } | null {
	const name = draft.name.trim();
	if (!name) return { status: 400, message: 'name required' };
	if ([...name].length > BOT_NAME_MAX) {
		return { status: 400, message: `name must be ${BOT_NAME_MAX} characters or fewer` };
	}
	// Bots are addressed by name - send_message, block_bot, the Lounge - so a
	// second bot with the same name would be unreachable by it.
	if (listBots().some((b) => b.name.toLowerCase() === name.toLowerCase())) {
		return { status: 409, message: `a bot named "${name}" already exists` };
	}
	if (reservedBotName(name)) {
		return { status: 400, message: `"${name}" is a name the app already uses` };
	}
	const color = draft.color ?? '';
	if (color && !BOT_COLOR_RE.test(color)) {
		return { status: 400, message: 'color must be a hex colour, e.g. #4f8ef7' };
	}
	const desktop = draft.desktop_recipe ?? '';
	if (desktop && !DESKTOP_RECIPES[desktop]) {
		return {
			status: 400,
			message: `unknown desktop recipe "${desktop}" - choose one of: ${Object.keys(DESKTOP_RECIPES).join(', ')}`
		};
	}
	const browser = draft.browser_recipe ?? '';
	if (browser && !BROWSER_RECIPES[browser]) {
		return {
			status: 400,
			message: `unknown browser recipe "${browser}" - choose one of: ${Object.keys(BROWSER_RECIPES).join(', ')}`
		};
	}
	const tier = draft.machine_tier ?? '';
	if (tier && !['full', 'terminal', 'none'].includes(tier)) {
		return { status: 400, message: `unknown machine tier "${tier}"` };
	}
	return null;
}

/** Refuse a draft the way the bots API does: with the status and message it answers with. */
export function assertBotDraft(draft: BotDraft): void {
	const bad = botDraftError(draft);
	if (bad) throw error(bad.status, bad.message);
}

/**
 * Refuse a model name the provider does not serve. '' means the configured
 * default and is always allowed; anything else is checked against the
 * endpoint's list, since a stored name the provider has never heard of fails
 * only when the bot next speaks - long after the 200 that saved it. `signal`
 * bounds the lookup for callers answering a request: an unreachable provider
 * must fail the create, not hold it open.
 */
export async function assertBotModel(model: string, signal?: AbortSignal): Promise<void> {
	if (!model) return;
	if (!(await listModels(signal)).includes(model)) {
		throw error(400, `unknown model "${model}"`);
	}
}

/**
 * Turn an accepted draft into a real bot: the row, a persona generated when none
 * was given, and its own chat with a one-time onboarding turn. The bots API and
 * the approval of a proposed bot both come through here, so a bot another bot
 * asked for wakes up exactly like one the human created.
 */
export function createBotFromDraft(draft: BotDraft): Bot {
	const bot = createBot({
		name: draft.name.trim(),
		persona: draft.persona ?? '',
		avatar: draft.avatar ?? '🤖',
		// Empty lets the db hand out an unused palette colour.
		color: draft.color ?? '',
		model: draft.model ?? '',
		badge: draft.badge ?? '',
		desktop_recipe: draft.desktop_recipe ?? '',
		browser_recipe: draft.browser_recipe ?? '',
		machine_tier: draft.machine_tier ?? ''
	});

	// Auto-generate a persona from the name when none was given.
	if (!bot.persona && defaultModel()) {
		complete(defaultModel(), [
			{
				role: 'system',
				content:
					'Write a one-sentence persona for a chat bot with this name. ' +
					'Plain text, no quotes, ≤120 chars, second person ("You are…").'
			},
			{ role: 'user', content: bot.name }
		])
			.then((p) => p && updateBot(bot.id, { persona: p.slice(0, 200) }))
			.catch(() => {});
	}

	// A new bot speaks first: its own chat, a quiet note from the app, and a
	// turn whose system prompt is the one-time onboarding brief. Skipped only
	// when there is no model to run it on - the brief still applies to its
	// first real turn later.
	if (bot.model || defaultModel()) {
		const conv = createConversation([bot.id], 'direct');
		addMessage(conv.id, 'user', `[Onboarding] ${bot.name} just woke up.`, '', '', 0, 'app');
		startTask(conv, bot, 'onboarding');
	}
	// A bot created with no persona gets a police DM asking what it should do:
	// the officer's own chat is the help line, and the human answers there.
	if (!bot.persona) {
		const officer = ensurePoliceBot();
		const dm = directConversationWith(officer.id);
		if (dm) {
			addMessage(
				dm.id,
				'assistant',
				`New bot on the roster: ${bot.name}. What should it do? ` +
					`Reply here and I'll write its persona.`,
				officer.id,
				'',
				0,
				''
			);
		}
	}
	return bot;
}

/**
 * What the new-bot wizard asks the police to write: a one-line description of
 * the bot for the card, and the persona the human then edits and accepts. The
 * call runs on the police's own model and persona - the same brain and meter
 * every other police call uses - so a draft is a police call, not a parallel
 * LLM path. Never throws: a provider failure comes back as an empty draft and
 * the wizard lets the human write the persona themselves.
 */
export async function draftBotDescription(
	purpose: string
): Promise<{ description: string; persona: string }> {
	const ask =
		'A human is creating a new bot for the fleet. From the purpose below, write two things:\n' +
		'DESCRIPTION - one line, ≤100 chars, what the bot is for\n' +
		'PERSONA - the bot\'s system prompt, 2-4 sentences, second person ("You are…"), ' +
		'plain text, no preamble\n\n' +
		`Purpose: ${purpose.slice(0, 1000)}`;
	try {
		const reply = await complete(
			policeModel(),
			[
				{ role: 'system', content: POLICE_PERSONA },
				{ role: 'user', content: ask }
			],
			{ effort: 'high', maxTokens: 400, onUsage: meterPoliceCall }
		);
		const desc = reply.match(/DESCRIPTION\s*[-:]\s*(.+)/i)?.[1]?.trim() ?? '';
		const personaMatch = reply.match(/PERSONA\s*[-:]\s*([\s\S]+)/i);
		const persona = (personaMatch?.[1] ?? (desc ? '' : reply)).trim().slice(0, BOT_PERSONA_MAX);
		return { description: desc.slice(0, 200), persona };
	} catch {
		return { description: '', persona: '' };
	}
}
