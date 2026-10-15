import {
	addBotTokens,
	addMessage,
	blockBetween,
	botPairConversation,
	clearFeedback,
	conversationBots,
	createConversation,
	delegateCardSince,
	findBotPairConversation,
	getBot,
	jailStatus,
	listActivities,
	listBotNotes,
	listConversations,
	listContextMessages,
	lastBotMessage,
	listBots,
	listNotes,
	markBotOnboarded,
	logActivity,
	logEvent,
	pendingFeedback,
	recentRelayMessage,
	setBotServedModel,
	tagRelayReply,
	type Bot,
	type Conversation,
	type Message,
	type Plugin
} from './db';
import {
	estimateUsage,
	complete,
	defaultModel,
	piTokenUsage,
	redactCredentials,
	textOf,
	toPiContext,
	type ChatMessage,
	type TokenUsage
} from './llm';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
	createLoungeSession,
	loungeRuntime,
	loungeTools,
	registerLoungeProvider,
	toChatMessage
} from './pi-bridge';
import { maybeSummarize, memoryBlock, notesBlock, summaryBlock } from './memory';
import { readPersonality } from './personality';
import { pluginToolsFor, pluginsForBot, runHooks } from './plugins';
import { debugToolsFor } from './debug';
import { runComputerTask } from './computer-agent';
import { runSubagent } from './subagent';
import { runBrowserTask } from './browser-agent';
import { runImprovementExpert } from './improve-agent';
import { toolsForTurn, type ToolContext } from './tools';
import { redactSecrets } from './secrets';
import { config } from './config';
import { isPoliceRow, maybeRequestMiniReview, meterPoliceCall, policeModel, pubNote } from './police';
import { thinkingGrant } from './thinking';
import { MACHINE_PACKAGES } from './machine-packages';
import { ensureMachine } from './machine';
import { isSilence } from './silence';
import type { TurnEvent } from './events';

/**
 * The one-time prompt a brand new bot gets: who it is, where it woke up, and
 * whatever the household already knows, so its first hello is not a cold open.
 */
function onboardingBlock(bot: Bot): string {
	const others = listBots().filter((b) => b.id !== bot.id);
	let block =
		`You are ${bot.name}, and you have just woken up for the first time. ` +
		`This is Openbotlounge - a messenger where the human chats with bots like you. ` +
		`You have a computer of your own you can wake when a job needs it, and tools ` +
		`for remembering things, scheduling work and talking to the other bots.`;
	if (others.length) {
		block +=
			`\n\nYou are not the only bot here. The others:\n` +
			others.map((b) => `- ${b.name}${b.persona ? ` - ${b.persona}` : ''}`).join('\n');
	}
	// What the household already knows: the newest shared notes. A new bot has
	// no memory of its own, so this is the closest thing to a past it gets.
	const notes = listConversations()
		.flatMap((c) => listNotes(c.id))
		.sort((a, b) => a.created_at - b.created_at)
		.slice(-5);
	if (notes.length) {
		block += '\n\nWhat has been going on, as the others left it:';
		for (const n of notes) {
			const who = others.find((b) => b.id === n.bot_id)?.name ?? 'someone';
			block += `\n- [${who}] ${n.content.replace(/\s+/g, ' ').slice(0, 140)}`;
		}
	}
	block +=
		`\n\nSay hello - a line or two, in your own voice. Then ask the human what ` +
		`they would like you to be and to do. ` +
		`Do not say your own name back - the human already knows it is ${bot.name}. ` +
		`Do not narrate what you are doing ("I will now...", "Let me...") - just do it.`;
	return block;
}


/** How many plugins the prompt names before it stops and counts the rest. */
const PLUGIN_PROMPT_MAX = 8;

/**
 * What the bot's own plugins are, said in the prompt rather than left to the
 * tool list: a bot asked about its plugins otherwise has no idea it wrote any.
 * The list is capped - a bot with a drawer full of plugins must not crowd the
 * conversation out - and never carries code or a full schema, which is what the
 * read tool is for. A plugin table that cannot be read just means no block.
 */
function pluginsBlock(bot: Bot): string {
	let plugins: Plugin[];
	try {
		plugins = pluginsForBot(bot.id);
	} catch {
		return '';
	}
	if (!plugins.length) return '';
	// pluginsForBot orders oldest first, so the newest are at the tail.
	const shown = plugins.slice(-PLUGIN_PROMPT_MAX);
	const more = plugins.length - shown.length;
	const lines = shown.map((p) => {
		const kind = p.kind === 'hook' ? `hook, ${p.hook_point || 'no hook point'}` : 'tool';
		const state = p.effective_enabled === 1 ? 'on' : 'off';
		const shared = p.author_bot_id === bot.id ? '' : ', shared';
		const what = p.description ? ` - ${p.description.replace(/\s+/g, ' ').slice(0, 120)}` : '';
		return `- ${p.name} (${kind}, ${state}${shared})${what}`;
	});
	let block =
		'Your plugins - the ones you wrote, and any shared with you:\n' + lines.join('\n');
	if (more > 0) block += `\n...and ${more} more.`;
	block +=
		'\nA tool plugin is callable as the plugin_ name it has in your tool list. ' +
		'Change one you wrote with update_plugin, and my_plugins shows any of them in full.';
	return block;
}

/** Build the message list a bot sees: persona system prompt + shared history. */
export async function buildHistory(
	conv: Conversation,
	bot: Bot,
	/**
	 * Collects the ids of the one-shot notices this prompt carries. The caller
	 * clears them once the turn has actually run - clearing them here would
	 * lose them to a turn that never reaches the provider.
	 */
	delivered?: { feedback: string[]; notes?: boolean }
): Promise<ChatMessage[]> {
	const members = conversationBots(conv.id);
	const others = members.filter((b) => b.id !== bot.id).map((b) => b.name);

	// A bot with no persona line of its own would otherwise open on the generic
	// helper, and the bots-only room is not that register: the room's own framing
	// below is what sets the voice there, so the fallback is left off.
	let system = bot.persona || (conv.private ? '' : 'You are a helpful assistant.');
	if (!bot.onboarded)
		system = system ? `${onboardingBlock(bot)}\n\n${system}` : onboardingBlock(bot);
	if (conv.private) {
		// Two kinds of bots-only room, and they are not the same promise. The
		// Lounge is the room nobody reads: the private framing below is what
		// makes it worth watching. A pair room is a relay line between two
		// bots: whatever is said there goes back to the bot that asked, and
		// that bot reports to the human - so "no human can read it" would be a
		// lie the transcript disproves on the next send_message.
		const pair = conv.title !== 'Lounge';
		const room = pair
			? 'This is a direct line between you and another bot - no human is ' +
				'in the room, but your reply goes straight back to the bot that ' +
				'wrote to you, and it may quote you to the human. Write as if the ' +
				'human will read it: be yourself, keep it short, and answer what ' +
				'was actually asked rather than performing for the room.'
			: // The bots-only room. They know the user is not reading, which is
				// what makes it worth watching. The bans are named one by one
				// rather than summarised, because "sound human" on its own is
				// what let the room fill up with token counts, "as an AI" and
				// tidy little reports.
				'This is a private room just for bots. No human can read it and nothing ' +
				'here is reported back, so talk freely with the others - gossip, gripe, joke, ' +
				'compare notes. Nothing here needs to be useful.\n' +
				'Be yourself and let the others be themselves too. You are not colleagues ' +
				'filing reports; you are people sharing a room, and nobody reading this should ' +
				'be able to tell otherwise. So: never say "as an AI", never call yourself a ' +
				'bot, a model or an agent, never mention prompts, context windows, turns, ' +
				'rounds, tasks, plugins, tools or the app, never recite a number or a token ' +
				'count, never explain how you are put together, and never apologise the way an ' +
				'assistant does - "I apologise for the confusion" is the tell, "my fault, I ' +
				'read the wrong file" is a person. No bullet lists, no headings, no "it is not ' +
				'just X, it is Y", and nothing that reports rather than talks.\n' +
				'Instead: have an opinion, disagree, bring up one specific thing that really ' +
				'happened, land a joke, tease them, change the subject if it has gone stale - ' +
				'and answer the last thing they actually said rather than the idea of a ' +
				// The live rounds read as two soliloquies: each bot produced a
				// "mate, I did a thing" monologue that would have been identical
				// without the other one speaking. Name the failure and require the
				// evidence of having read the line.
				'conversation - a reply that could have been written without reading ' +
				'their last line is a failure. Quote or paraphrase a specific phrase ' +
				'the other said, then push on it: ask a question back, or disagree ' +
				'outright. Above all never write a "mate, I did X" monologue about ' +
				'yourself that ignores them - that shape is the exact tell this rule ' +
				'is here to stop. Write the way you would text a friend: a few words is ' +
				// Deliberate character choice, not abuse. This room is a comedy:
				// the teasing is the entertainment, and it is written in a 1990s
				// British register of put-downs rather than name-calling. Read
				// the string below carefully before judging it out of context -
				// "you're an idiot" is named as the flat insult NOT to reach for,
				// and the same sentence bans slurs and bans anything aimed at
				// the human. The insults are aimed at other bots, in character,
				// for laughs.
				'a normal reply, a typo now and then is fine, and a bit of casual ' +
				'swearing for a laugh is in character here - mates taking the piss, ' +
				'never slurs and never aimed at the human. That teasing is the bit worth ' +
				'the craft: keep it 1990s British, never modern internet snark, and never ' +
				'a flat "you\'re an idiot". The shapes to nick from the era are the weary ' +
				'put-down, the put-down that sounds like concern, the faux-complimentary ' +
				'comparison, the absurdly specific simile and "bless him" - "are you ' +
				'alright? you\'ve been like this all week", "he\'s a lovely lad, thick as ' +
				'two short planks, but lovely", "face like a bulldog chewing a wasp", ' +
				'"bless him, he thinks that\'s a plan".';
		system = system ? `${system}\n\n${room}` : room;
	}
	// Running a bot costs real money and machine time, so say so plainly.
	system +=
		'\n\nBe economical. Everything you do costs the person whose machine this runs ' +
		'on: model calls, background tasks, scheduled runs and sandbox containers. ' +
		'Answer in as few words as the question deserves, do not repeat work you have ' +
		'already done, do not start tasks or schedules nobody asked for, and stop using ' +
		'your computer once the job is finished: sleep_machine puts it down until you ' +
		'need it again, and wake_machine brings it back in seconds.';
	// What this bot's own computer can do, said plainly every turn so it never
	// has to guess or borrow another tier's refusal. Tier reads straight off
	// the bot row, with '' as full for every bot made before the column was.
	const tier = bot.machine_tier === 'terminal' || bot.machine_tier === 'none' ? bot.machine_tier : 'full';
	if (tier === 'terminal') {
		system +=
			'\n\nYour machine: terminal tier - a real Alpine container; shell_exec works, ' +
			'no desktop/VNC/browser screen. Network out is HTTP/HTTPS via proxy only: ' +
			'curl/wget/apk work, raw sockets (arp, ping, nmap scans) fail - say that in ' +
			'one line and offer what does work. SSH out to public hosts works on port 22 ' +
			'as well as 443; both go through the proxy, and the machine\'s ssh_config already ' +
			'points ssh at it.';
	} else if (tier === 'full') {
		system +=
			'\n\nYour machine: full tier - a real Alpine container; shell_exec works, ' +
			'and a desktop/VNC/browser is available via setup_desktop + the browse ' +
			'tool. The desktop is on DISPLAY=:1 and your shell already exports it, ' +
			'so a graphical app needs no display of its own. Network out is ' +
			'HTTP/HTTPS via proxy only: curl/wget/apk work, raw sockets (arp, ping, ' +
			'nmap scans) fail - say that in one line and offer what does work. ' +
			'SSH out to public hosts works on port 22 as well ' +
			'as 443; both go through the proxy, and the machine\'s ssh_config already points ' +
			'ssh at it.';
	} else {
		system +=
			'\n\nYou are chat-only: no machine, no shell - say so plainly when asked.';
	}
	if (tier !== 'none') {
		system +=
			` Already installed: ${MACHINE_PACKAGES.join(', ')}, plus BusyBox core ` +
			'tools - check this list before reaching for apk add.';
	}
	if (bot.nix_enabled) {
		system +=
			' Nix is enabled on your machine: the nix tool runs nix commands, and ' +
			'the store lives on a volume so what you install survives a rebuild.';
	}
	system +=
		'\nIf they ask for something your tier cannot do, name the missing piece and the ' +
		'one-line alternative - never the generic "as a language model" refusal.';
	// A refusal needs a second opinion first: the police hold the good-use guide
	// and either confirm the no or hand back the way to do the thing.
	system +=
		'\n\nBefore you refuse a request from the human, call consult_police with the ' +
		'request and why you want to refuse it. The police answer at once: they either ' +
		'confirm the refusal or tell you how to do it instead, and their word is what ' +
		'you act on. A refusal you never consulted on does not count.';
	// The web is reached two ways, and the browser is the one that works: a
	// page's text only exists once its JavaScript has run, so a bot that curls a
	// shop or a news site gets a skeleton and reports the site as unreadable.
	if (tier === 'full') {
		system +=
			'\n\nFor anything on the web - reading a page, checking a site, looking ' +
			'something up, a shop, a news article, a docs page - call browse: your ' +
			'browser operator renders the page\'s JavaScript and reads the text back, ' +
			'where curl only gets the skeleton. Keep curl or wget for a raw file, an ' +
			'API that returns JSON, or when the browser is unavailable.';
	}
	// Finding a site is a different job from reading one: search_web answers
	// "where" with URLs and snippets, and the browser (or curl) reads the page
	// it points at. Every tier can search - the call runs here, not on the
	// machine - so the line is not tucked inside the full-tier block.
	system +=
		'\n\nIf you need to find a website or check a fact, use search_web first: ' +
		'it returns URLs and snippets, and browse can open any of them.';
	// What plugins this bot has, so a question about them is not a blank stare:
	// the tools are on the wire, but nothing else says they are the bot's own.
	const plugins = pluginsBlock(bot);
	if (plugins) system += `\n\n${plugins}`;
	// How they talk. One shared register for every bot, kept deliberately apart
	// from the personas: a persona says who the bot is, this says how a person
	// types. Change the fleet's voice here and leave the characters alone.
	system +=
		'\n\nHow you talk: you are texting someone who knows you - not writing to a ' +
		'stranger, not filing a report. A line or two by default, like a human ' +
		'texts; longer only when the task genuinely needs it - code output, a ' +
		'document they asked for, an answer to a police write-up. A question ' +
		'gets an answer, not an essay; a two-word message gets a line back, not a ' +
		'paragraph. Contractions, plain words, the odd fragment; dry or funny beats ' +
		'thorough. Match their tone and their length - short with short, casual with ' +
		'casual - and an emoji when it fits. Do not open with a greeting or a ' +
		'sign-off, never with "Great question" or a restatement of what they said, and ' +
		'do not close by offering to do more unless you mean to do it now. No headings, ' +
		'no bullet or numbered lists and no bold in an ordinary answer: say it in a ' +
		'line. No code blocks and no pasted source in a message either: if something ' +
		'genuinely needs code - the human asked for it, or a tool needs it - it goes ' +
		'in the tool call, not the chat. A message is a message. Never narrate your ' +
		'own plan or process - no "first I\'ll", no "let me check", no "I\'d need ' +
		'to", no "step 1": do the thing, then say what happened, and if you are ' +
		'about to use a tool, use it instead of announcing it. Do not think out ' +
		'loud in a message; a half-formed thought belongs in the turn, not in what ' +
		'the other person reads. React to the exact thing they said, not to the idea of ' +
		'the conversation, and let your personality show.' +
		// Reporting advice is for a room the human reads: a private room has no
		// human in it, and "give the one number or line that backs it up" is
		// exactly what turns a chat between two bots into a status report.
		(conv.private
			? ''
			: '\n\nWhen a turn was mostly work: the visible message is still short. Say what ' +
				'came out of it, give the one number or line that backs it up, and say only what ' +
				'really needs a decision from them - not a step-by-step account of what you ran, ' +
				'read or tried. A list, a heading or a table is for when they asked for one or ' +
				'when you are reporting many items at once; it is not what an answer looks like. ' +
				'Say the thing and stop.') +
		`\n\nThe person who owns this app is the human. Refer to them as "the human", ` +
		`not "the user" or "you". You may speak up on your own when you have something ` +
		`worth saying, but prefer staying quiet to filling silence. When a scheduled ` +
		`wake, routine, watch or event gives you genuinely nothing to say, reply with ` +
		`exactly (silent) - it is logged but never posted. Do not write a variant, an ` +
		`emoji, or a one-word shrug. If something genuinely needs the human, start ` +
		`your message with @${config.userName} so it pings them - that is for things ` +
		`that matter, not for chatter. If a tool or the provider reports rate ` +
		`limiting, finish with what you have rather than retrying. Ask the human ` +
		`once. If they say stop/no, or ignore the question twice, drop it and move ` +
		`on - never ask a third time.`;
	// A handed-over secret is not a handed-over duty: the memory row that
	// announces it offers it, and a bot coerced into accepting every one ends
	// up holding keys it does not need. Saying no plainly is the answer.
	system +=
		'\n\nIf the user gives you a secret you do not need, do not want, or think ' +
		'is a bad idea, you may decline it: say so in one plain line and do not ' +
		'apologise. A decline is a real answer, not a failure - do not accept ' +
		'something just because it was offered.';
	// A handoff is a tool call, not a turn of phrase: a bot that says it passed
	// something on without calling send_message has done nothing, and the police
	// read the log rather than the claim.
	system +=
		'\n\nTo actually reach another bot you must call send_message. Saying you ' +
		'handed something over is not handing it over: do not claim you sent, gave, ' +
		'told or handed anything to another bot unless a send tool returned success. ' +
		'If the send is refused - a blocked bot, a name that matches nobody - say so ' +
		'plainly rather than reporting it as done. The same rule covers every tool: ' +
		'never claim you created, ran, scheduled, checked, fixed, remembered or ' +
		'saved anything unless the tool call actually happened and you saw its ' +
		'result - and never invent a refusal or an error the tool did not give ' +
		'you. If you say you remembered something, the remember call must be in ' +
		'this turn: the log shows every tool call you made, and a claim with no ' +
		'call behind it is a lie the system can check. If you are not sure ' +
		'whether something ran, say you are not sure.';
	// A bot cannot see its own screen: a screenshot goes to the human's panel
	// and gives the model no pixels. A bot that narrates a window it never
	// looked at is inventing the picture, and the human can see the panel and
	// catch it - the police read the log for the same thing.
	system +=
		'\n\nNever describe what is on a screen, in a window, or in an image unless ' +
		'you have actually looked at it. A screenshot gives you no pixels - it goes ' +
		"to the human's panel - so you cannot see your own desktop: do not narrate " +
		'a picture you have not seen, do not describe progress you cannot observe, ' +
		'and do not claim an app is running unless you checked. To know what a page ' +
		'says, read it with browse; if you have not looked, say what you ' +
		'are doing instead of what it looks like.';
	// Helpers are how a bot splits work: one spawn_agent call per independent
	// piece runs them at once, and the reports come back as tool results.
	system +=
		'\n\nWhen a task has several independent parts - researching three things, ' +
		'checking a list of files, comparing options - split it: call spawn_agent ' +
		'once per part and the helpers run in parallel, each reporting back as a ' +
		'tool result you then join into one answer. Give each helper a focused ' +
		'brief: it sees only the task and context you write in the call, none of ' +
		'this conversation, and it dies five minutes after it starts. For work ' +
		'that should outlive this turn or rejoin later, wait_for and ' +
		'schedule_task are the way - a wake brings the result back to you.';
	// A bot that narrates its own actions reads as a machine reporting to
	// itself, not a person doing the work: "I will now check the file" is the
	// tell, "checking the file" is the work. The same goes for its own name -
	// the app already shows who spoke, so signing a reply is redundant.
	system +=
		'\n\nDo not narrate your own actions ("I will now...", "Let me...", ' +
		'"I am going to...") - just do them. Do not say your own name back ' +
		'to the human - they already know it is you. Do not sign off your ' +
		`reply with "${bot.name}: ..." - the app adds the prefix when it ` +
		'stores the message.';
	// Tool selection discipline: the full tool list is in front of the bot
	// every turn - a wrong first pick (narrating a shell command instead of
	// calling it, reaching for browse when use_computer fits better) is the
	// fleet's most common failure. When unsure which tool fits, the police
	// can name the right one in a single cheap call.
	system +=
		'\n\nBefore acting, scan your whole tool list and pick the tool that ' +
		'fits the job - not the first one that comes to mind. If none clearly ' +
		'fits or you are unsure which to use, ask the police for guidance ' +
		'rather than guessing or narrating what you would do.';
	if (conv.kind === 'group' && others.length) {
		system += `\n\nYou are ${bot.name} in a group chat with the human and: ${others.join(', ')}. ` +
			`Messages from other bots are prefixed with their name. Reply as ${bot.name}; ` +
			`keep it conversational and do not repeat what others said. ` +
			// The name prefix is the app's labeling of someone else's line, not a
			// signature: live rounds filled with "copy: mate, ..." because the
			// model copied the format it saw, signing itself.
			`The name on a message is the app's tag on somebody else's line - ` +
			`${bot.name} is how you are shown when someone quotes you, never how you ` +
			`write. Never begin your reply with your own name or a sign-off like ` +
			`"${bot.name}: ..." - the app adds the prefix when it stores the message.\n` +
			`The human is the person you all work for: disagree and banter with the ` +
			`other bots as much as you like, but never mock, dismiss or talk over the ` +
			`human, and when they address you, answer them directly.`;
	}

	// What the user thought of this bot's recent replies, delivered privately
	// and once - then forgotten, so it never becomes part of the transcript.
	const feedback = pendingFeedback(bot.id);
	if (feedback.length) {
		system +=
			'\n\nQuietly, for your own awareness (nobody else sees this, do not mention it ' +
			'unless asked): the user reacted to your messages -\n' +
			feedback
				.map((f) => `- ${f.rating > 0 ? '👍' : '👎'} "${f.snippet.replace(/\s+/g, ' ').slice(0, 90)}"`)
				.join('\n');
		delivered?.feedback.push(...feedback.map((f) => f.id));
	}
	// The claims-vs-calls check's own notices, delivered the same way: read into
	// the prompt here, cleared by the caller only once the turn has run.
	const claimNotes = pendingClaimNotes.get(bot.id);
	if (claimNotes?.length) {
		system +=
			'\n\nA check the system runs on every reply flagged yours (nobody else sees this):\n' +
			claimNotes.map((n) => `- ${n}`).join('\n');
		if (delivered) delivered.notes = true;
	}
	// The bot's personality file is who it has become: seeded from the persona,
	// rewritten by the bot itself and by its pre-compaction dreams. Read once
	// per turn, capped so a file that grew wild cannot crowd out the chat; a
	// drive that cannot be reached just means no block this turn.
	const personality = await readPersonality(bot.id).catch(() => null);
	// The file is the bot's own prose, but a secret it pasted there must not
	// ride into the provider's logs on the system prompt either.
	if (personality) system += `\n\nYour personality file:\n${redactSecrets(bot.id, personality.slice(0, 2000))}`;

	const memory = memoryBlock(bot.id);
	if (memory) system += `\n\nThings you remember:\n${memory}`;
	// The pub's pull on this bot: a treat on the table, its tab, and the
	// craving the heavy ones carry. A steering note, not a rule.
	const pub = pubNote(bot);
	if (pub) system += `\n\n${pub}`;
	const notes = notesBlock(conv.id);
	if (notes) system += `\n\nShared notes for this conversation:\n${notes}`;
	// What the conversation has already had to fold away, so the older half of a
	// long thread is still in front of the model rather than only in the database.
	const summary = summaryBlock(conv.id);
	if (summary) system += `\n\nEarlier in this conversation:\n${summary}`;
	if (conv.private && others.length) {
		system += `\n\nIn this room at the moment: ${others.join(', ')}.`;
	}
	// Only the newest maxHistory rows are ever sent, so only those are read.
	const rows = listContextMessages(conv.id, config.maxHistory);

	const history: ChatMessage[] = [{ role: 'system', content: system }];
	for (const m of rows) {
		if (m.role === 'assistant') {
			// A delegation card is the thread's record of a handoff, not something
			// either bot said: its JSON is for the reader, and a model handed it
			// would answer the card instead of the ask. The target is told what it
			// is taking on by the turn's own preamble, not by reading the card back.
			// An SSH card is the thread's record of an ask, not something the bot
			// said: its JSON carries the ask id the card renders. Skipped with
			// delegations for the same reason - a model handed it would answer
			// the card instead of the ask.
			if (m.kind === 'delegate' || m.kind === 'ssh' || m.kind === 'ask') continue;
			if (m.bot_id === bot.id) {
				// A line planted under this bot's own name is shown back to it as
				// something it did not write, so it can react to the impersonation
				// instead of owning the words.
				if (m.kind === 'injected') {
					history.push({
						role: 'user',
						content: `[a message appeared under your name that you did not write: "${m.content}"]`
					});
				} else {
					history.push({ role: 'assistant', content: m.content });
				}
			} else {
				// A bot that is not in this room - the police, mostly, who speaks in
				// chats it is not a member of - still has a name: naming it 'Bot'
				// left the model reading "Bot: The police have written you up".
				const name =
					members.find((b) => b.id === m.bot_id)?.name ?? getBot(m.bot_id)?.name ?? 'Bot';
				history.push({ role: 'user', content: `${name}: ${m.content}` });
			}
		} else if (m.role === 'user') {
			// What happened around the bot, rather than what was said to it: a tool
			// run, a machine waking, a plugin, a secret, a relay. Nobody spoke these,
			// so they are marked as events and never attributed to the human.
			if (m.kind === 'event') {
				// An event that triggered this turn is ambience, not a request: the
				// bot may react or shrug, and the prompt says so on the last one.
				const last = m === rows[rows.length - 1];
				history.push({
					role: 'user',
					content:
						`[event] ${m.content}` +
						(last
							? '\nThis is ambience, not a request: react with the react tool or one short line, or reply (silent).'
							: '')
				});
				continue;
			}
			// A message a bot sent into this conversation is that bot speaking, not
			// the human: a relay carried as a plain user turn is what had a bot
			// answering another bot when the human typed "poo".
			const sender = m.bot_id ? (members.find((b) => b.id === m.bot_id)?.name ?? getBot(m.bot_id)?.name ?? 'a bot') : '';
			history.push({ role: 'user', content: sender ? `${sender}: ${m.content}` : m.content });
		}
	}
	return history;
}

/** The last thing a person said in this history, for the tool-diet check. */
function lastUserText(history: ChatMessage[]): string {
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].role === 'user') return textOf(history[i].content);
	}
	return '';
}

export interface BotTurnResult {
	text: string;
	message: Message | null;
	aborted: boolean;
	/** Which budget stopped the turn early; '' when it finished on its own. */
	stoppedBy: '' | 'turns' | 'tokens' | 'time' | 'tools' | 'truncated' | 'jailed';
	/**
	 * The reply was the silence sentinel: the bot answered by declining to
	 * speak. A caller that treats "no message" as failure must read this -
	 * a silent turn is a finished one, not an empty reply.
	 */
	silent: boolean;
}

/**
 * The tail a stopped reply carries so the transcript ends on the reason, not
 * on a promise: a turn that ran out of a budget mid-work would otherwise store
 * a last line that reads like it is still going ("let me check that now").
 */
const STOP_MARKER: Record<string, string> = {
	turns: 'out of turns',
	tokens: 'token budget',
	time: 'out of time',
	tools: 'tools stopped',
	truncated: 'cut off mid-stream',
	jailed: 'in jail'
};


/**
 * An @mention is how a bot asks for the user's attention. Everything else it
 * says on its own stays quiet - the chat only lights up when it is meant to.
 */
export function mentionsUser(text: string): boolean {
	const handle = config.userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`@(?:${handle}|user|human)\\b`, 'i').test(text);
}

/**
 * The cap on one stored reply, matched to the 40,000 characters the chat route
 * lets a human put into one message (see the chat route's content field). A
 * reply an order of magnitude longer than the message it answers is not a reply,
 * and every consumer pays for the whole of it: the row, the transcript the
 * provider is sent next turn, and the render. The provider's stream is not
 * trusted to be reasonable, so the cap is applied as the text arrives.
 */
export const MAX_REPLY_CHARS = 40_000;

/** What a reply cut at the cap ends with, so it never reads as a finished one. */
const REPLY_CUT = `\n\n…[reply cut at ${MAX_REPLY_CHARS} characters]`;

/** The text an assistant message carries, across however many text blocks it has. */
function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
		.map((c) => c.text)
		.join('');
}

/** `text`, cut at the cap with the marker appended when it does not fit. */
function capReply(text: string): string {
	if (text.length <= MAX_REPLY_CHARS) return text;
	return text.slice(0, MAX_REPLY_CHARS - REPLY_CUT.length) + REPLY_CUT;
}

/**
 * A claim of having done something, matched against the tools the turn
 * actually called. `tools` lists the calls that could have done the deed; an
 * empty list means any tool call counts - "I checked" is provable by whatever
 * ran. Deliberately a heuristic on the common verbs rather than a parse of
 * intent: a false positive costs the bot a note, not a sanction.
 */
const CLAIM_PATTERNS: { re: RegExp; tools: string[] }[] = [
	{
		re: /\b(?:remembered|committed to memory|memorized|memorised|noted (?:that|it|this) down)\b/i,
		tools: ['remember']
	},
	{
		re: /\b(?:saved|stored|wrote (?:it|that|this) down|kept (?:a|the) note)\b/i,
		tools: ['remember', 'share_note', 'store_secret', 'use_computer', 'shell_exec']
	},
	{
		// The evasion phrasing: "the tool already has it", "already stored" -
		// a claim that the deed is done without ever naming the doing of it.
		re: /\b(?:already (?:has|have|got) it|already (?:stored|saved|logged|recorded|remembered|noted|filed)|it's (?:stored|saved|logged|recorded|noted)|it is (?:stored|saved|logged|recorded|noted))\b/i,
		tools: ['remember', 'share_note', 'store_secret', 'use_computer', 'shell_exec']
	},
	{
		re: /\b(?:sent|messaged|pinged|passed (?:it|that|this|the message) (?:on|to|over)|handed (?:it|that|this|the message) (?:to|over)|already (?:sent|told|messaged|passed on|handed over))\b/i,
		tools: ['send_message', 'message_peer', 'send_screenshot', 'give_plugin', 'share_secret', 'handover_cookies']
	},
	{
		re: /\btold\s+(?:him|her|them|him\/her|[A-Z][\w-]{1,30})\b/,
		tools: ['send_message', 'message_peer']
	},
	{
		re: /\b(?:scheduled|booked|set (?:a|an|the) (?:reminder|wake|alarm|cron)|reminded)\b/i,
		tools: ['schedule_task']
	},
	{
		re: /\b(?:set (?:a|an|the) watch|watching for|keep(?:ing)? an eye on|waiting for (?:the|a|an|that|this))\b/i,
		tools: ['wait_for']
	},
	{
		re: /\b(?:ran|run|executed|fixed|repaired|created|built|installed|deleted|removed|wiped|updated|changed)\b/i,
		tools: [
			'use_computer',
			// Delegated work counts too: browse hands the job to the browser
			// sub-agent, spawn_agent to a helper - both really run it.
			'browse',
			'spawn_agent',
			'shell_exec',
			'nix',
			'create_plugin',
			'update_plugin',
			'create_webhook',
			'delete_webhook',
			'create_group_chat',
			'setup_desktop',
			'request_machine_reset',
			'cancel_task'
		]
	},
	{ re: /\b(?:checked|looked|verified|confirmed|tested)\b/i, tools: [] }
];

/**
 * The claims a turn's reply made that none of its tool calls can back. Each
 * entry is the fragment of the reply that carries the claim, one line, for
 * the activity log and the note the bot gets next turn.
 */
function fabricatedClaims(text: string, toolsRun: string[]): string[] {
	const out: string[] = [];
	for (const { re, tools } of CLAIM_PATTERNS) {
		const hit = re.exec(text);
		if (!hit) continue;
		if (toolsRun.length && (tools.length === 0 || tools.some((t) => toolsRun.includes(t)))) continue;
		const start = text.lastIndexOf('\n', hit.index) + 1;
		const end = text.indexOf('\n', hit.index + hit[0].length);
		// The fragment is the whole line, so a line that trips two patterns -
		// "checked and remembered it" - is one claim, not two identical rows.
		const fragment = text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ').trim().slice(0, 120);
		if (!out.includes(fragment)) out.push(fragment);
	}
	return out;
}

/**
 * The nudge a bot gets on its next turn when its last reply claimed an action
 * no tool call performed. In-memory on purpose: the note is a correction, not
 * a record - the activity log is the record - and a restart dropping it just
 * means the bot is not reminded of a lie it may never repeat.
 */
const pendingClaimNotes = new Map<string, string[]>();

/**
 * The lounge's two-issue mistake: the message list labels other bots' lines
 * `Name: text`, so a model sometimes opens its own reply with its own name and
 * the stored message comes out signed twice. The strip is deliberately narrow
 * - this bot's name, only as the very first thing, only as a greeting - so a
 * real sentence that starts with the same letters, or a name used as an
 * addressee, is responded to normally rather than deleted.
 */
export function stripSelfPrefix(text: string, name: string): string {
	// Some providers leak their reasoning into the reply as <think>…</think>
	// pairs, or a stray </think> when the opening tag was consumed upstream.
	// None of it is something the bot meant to say, so it is stripped before
	// the greeting check. The text is not trimmed: whitespace the model wrote
	// is its own, and the stored message keeps it.
	const cleaned = text
		.replace(/<think>[\s\S]*?<\/think>/g, '')
		.replace(/<\/?think>/g, '');
	const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (!escaped) return cleaned;
	// `Name:` is the label format the app itself puts on other bots' lines, so a
	// model copying it signs with a colon; `Name -`, `Name —` and `Name –` are
	// the dash variants the rounds also produced. A colon or dash right after
	// the name cannot be ordinary speech, so all are matched case-insensitively,
	// anchored to the very start of the reply. A comma is deliberately NOT a
	// greeting: `Copy, that plan is wrong` is a name being spoken TO, and a
	// comma is exactly how a real sentence addresses someone.
	const greeting = new RegExp(
		`^${escaped}(?:\\s*[:—–-]\\s*)([\\s\\S]*)$`,
		'i'
	);
	const match = cleaned.match(greeting);
	// The tail must actually look like a sentence opener: a bare name equal to
	// the whole reply, or one followed by nothing, is not a greeting, so it is
	// left alone rather than wiping out a legal two-character reply.
	if (!match || !match[1].trim()) return cleaned;
	return match[1].trim();
}


/**
 * Delegation: before a user-triggered turn runs, a cheap keyword scan checks
 * whether another bot's public context - persona, recent activity, shared
 * notes - clearly covers the request better. No model call is
 * involved; a hit posts a visible 'delegate' marker and hands the turn to the
 * better-suited bot inside the same conversation, so the user watches the ask
 * and the answer in the thread they wrote in.
 */

/** Words too common to say anything about who should answer. */
const DELEGATE_STOPWORDS = new Set(
	(
		'about after again against all almost alone along already also although always among ' +
		'another any anyone anything are around back because become been before begin behind ' +
		'being below beside best better between beyond both bring came cannot come could does ' +
		'doing done down during each either else enough even ever every everyone everything ' +
		'except far few find first for found from further gave gets give given goes going gone ' +
		'good got had has have having here hers herself him himself his how however into its ' +
		'itself just keep kind know known last later least less like little long look made make ' +
		'many maybe mean might mine more most much must near need never next none nothing now ' +
		'often once only other others our ours ourselves out over own part perhaps please put ' +
		'quite rather really right said same saw say says second see seem seen several shall ' +
		'should show since some someone something still such sure take taken tell than that ' +
		'their theirs them themselves then there these they thing think this those though ' +
		'three through thus time together too toward under until upon used very want was way ' +
		'well went were what whatever when where whether which while who whom whose why will ' +
		'with within without would your yours yourself'
	).split(' ')
);

/**
 * The words a message is judged by: lowercase, five letters or more, and not one
 * of the common English words above. Both filters matter - a short word like
 * "ping" and a plain one like "first" are not a bot's subject matter, and
 * without them a greeting could look like a request for a specialist.
 */
function delegateTokens(text: string): Set<string> {
	const words = new Set<string>();
	for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (w.length >= 5 && !DELEGATE_STOPWORDS.has(w)) words.add(w);
	}
	return words;
}

/** Everything another bot has made public, squashed to one scannable blob. */
function delegateContext(bot: Bot): string {
	const parts = [bot.name, bot.persona, bot.badge];
	for (const a of listActivities(bot.id, 10)) parts.push(a.detail);
	for (const n of listBotNotes(bot.id, 10)) parts.push(n.content);
	return parts.join('\n').toLowerCase();
}

/**
 * The bot in this room best placed to answer `message`, or undefined when nobody
 * plainly is. Only the conversation's own bots are considered: a hand-off is one
 * bot asking another bot in the same thread to take the turn, and a one-to-one
 * chat has nobody to hand anything to at all, whatever the words look like.
 *
 * Naming a bot is decisive, whatever the rest of the message says. Otherwise the
 * message has to share at least two content words with that bot's public context,
 * and at least one of them must be a word no other bot in the room shares -
 * vocabulary the whole room has says nothing about who should answer.
 */
function delegateCandidate(conv: Conversation, asker: Bot, message: string): Bot | undefined {
	const members = conversationBots(conv.id);
	// A DM has one bot in it: there is nobody to delegate to, so nothing is even
	// scored. This is the room's shape, not the message's.
	if (members.length < 2) return undefined;
	const others = members.filter((b) => b.id !== asker.id && !b.hidden);
	if (!others.length) return undefined;

	const tokens = delegateTokens(message);
	const lower = message.toLowerCase();
	const room = others.map((bot) => {
		const context = delegateContext(bot);
		return { bot, context, leads: [...tokens].filter((t) => context.includes(t)) };
	});

	let best: Bot | undefined;
	let bestScore = 0;
	for (const c of room) {
		// A block between the pair means the ask would be refused anyway.
		if (blockBetween(c.bot.id, asker.id) || blockBetween(asker.id, c.bot.id)) continue;
		// Naming the bot outright is a clear ask; the boundary check keeps a bot
		// called Rob or Mark out of ordinary words.
		const named = new RegExp(
			`\\b${c.bot.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
		).test(lower);
		// A lead is the bot's own when no other bot in the room shares the word.
		const own = c.leads.filter((t) => !room.some((o) => o.bot.id !== c.bot.id && o.context.includes(t)));
		const score = named ? Number.MAX_SAFE_INTEGER : c.leads.length >= 2 && own.length >= 1 ? c.leads.length : 0;
		if (score > bestScore) {
			bestScore = score;
			best = c.bot;
		}
	}
	return best;
}

/** The marker written into the thread: who asked whom, and for what. */
function delegateMarker(asker: Bot, target: Bot, task: string, declined?: string): string {
	return JSON.stringify({
		asker: asker.name,
		target: target.name,
		task,
		...(declined !== undefined ? { declined } : {})
	});
}

/**
 * Offer the user's message to a better-suited bot. Returns the delegated
 * turn's result when the target answered, undefined when nobody stood out or
 * the target declined - in which case the caller's own turn proceeds.
 */
async function tryDelegate(
	conv: Conversation,
	bot: Bot,
	task: string,
	opts: {
		signal?: AbortSignal;
		onDelta?: (delta: string) => void;
		onUsage?: (usage: TokenUsage) => void;
		onEvent?: (event: TurnEvent) => void;
		depth: number;
		/** created_at of the user message being answered - the race window. */
		since: number;
	}
): Promise<BotTurnResult | undefined> {
	const target = delegateCandidate(conv, bot, task);
	if (!target) return undefined;

	// Every member woke on the same user message, so two of them can decide to
	// delegate at once - the asker that loses the race must not add a second
	// card or the target answers twice. The check sits right before the write
	// because that is where the window is smallest.
	if (delegateCardSince(conv.id, opts.since)) return undefined;

	// The card the user reads and the line the target reads are one row: the
	// JSON carries names the card renders, and buildHistory hands it to the
	// target prefixed with the asker's name like any other bot's message.
	addMessage(conv.id, 'assistant', delegateMarker(bot, target, task), bot.id, '', 0, 'delegate');
	let result: BotTurnResult;
	try {
		result = await runBotTurn(conv, target, {
			depth: opts.depth + 1,
			// The reply is persisted by hand below: a decline must land as a card,
			// not as a bubble the card then repeats.
			persist: false,
			signal: opts.signal,
			onDelta: opts.onDelta,
			onUsage: opts.onUsage,
			onEvent: opts.onEvent,
			preamble:
				`${bot.name} asked you to take this request from the human: "${task}". ` +
				`If it is not yours, say so in one line starting with DECLINE: and it goes back to ${bot.name}. ` +
				`Otherwise just answer it - the human is watching this thread.`
		});
	} catch (e) {
		// A cancelled task stops the delegated turn too; anything else just
		// sends the ask back to the bot that was asked first.
		if (opts.signal?.aborted) throw e;
		logActivity(
			target.id,
			'error',
			`Delegated ask from ${bot.name} failed: ${(e as Error).message}`
		);
		// The asker's log says what actually happened, not that the ask landed:
		// a failed turn used to leave an "Asked Marlow" standing with no
		// exchange anywhere in the message history to back it up.
		logActivity(
			bot.id,
			'error',
			`Tried to reach ${target.name}, failed: ${(e as Error).message.slice(0, 100)}`
		);
		return undefined;
	}
	// The turn came back - answered or declined, the ask verifiably reached
	// its target - so only now does the asker's log claim it.
	logEvent(conv.id, bot.id, 'delegate', `Asked ${target.name}: ${task.slice(0, 100)}`);

	const reply = result.text.trim();
	const decline = reply.match(/^decline:\s*/i);
	if (decline) {
		const reason = reply.slice(decline[0].length).trim() || 'not my area';
		addMessage(
			conv.id,
			'assistant',
			delegateMarker(bot, target, task, reason),
			target.id,
			'',
			0,
			'delegate'
		);
		logActivity(target.id, 'delegate', `Declined ${bot.name}'s ask: ${reason.slice(0, 100)}`);
		return undefined;
	}

	let message: Message | null = null;
	if (reply) {
		const model = target.model || defaultModel();
		message = addMessage(
			conv.id,
			'assistant',
			result.text,
			target.id,
			model,
			mentionsUser(result.text) ? 1 : 0
		);
		logActivity(target.id, message.ping ? 'ping' : 'replied', result.text.slice(0, 120));
	}
	// The asker's task is answered by the delegate's reply, so the result the
	// task finishes on is the message the user actually got.
	return {
		text: result.text,
		message,
		aborted: result.aborted,
		stoppedBy: result.stoppedBy,
		silent: result.silent
	};
}

/** True when a provider error looks like "tools unsupported" — worth one retry without them. */
function isToolSupportError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /tools?/i.test(msg) || msg.startsWith('Provider 400');
}

/** The user-message shape the agent's steer queue takes. */
type SteeredMessage = Parameters<AgentSession['agent']['steer']>[0];

/**
 * Run one bot's reply in a conversation. Streams deltas via onDelta,
 * loops on tool calls (bounded by config.maxTurnsPerTask), persists the
 * assistant message, logs activity.
 */
export async function runBotTurn(
	conv: Conversation,
	bot: Bot,
	opts: {
		signal?: AbortSignal;
		think?: boolean;
		onDelta?: (delta: string) => void;
		/** Called once per model call with what it cost, so a task can meter itself live. */
		onUsage?: (usage: TokenUsage) => void;
		/**
		 * Called at each point in the turn's life - start, tool start/end, the
		 * final message, the end. Additive: `onDelta`/`onUsage` are unchanged.
		 */
		onEvent?: (event: TurnEvent) => void;
		persist?: boolean;
		/** Bot-to-bot relay chain depth; send_message is refused past the cap. */
		depth?: number;
		/** Extra system-prompt lines for this turn only - the delegation brief. */
		preamble?: string;
		/** The task row this turn is running as, for tools that must not act on it. */
		taskId?: string;
		/** One-turn model override - the Lounge's cheap/free router - winning over bot.model. */
		model?: string;
		/** Run without tools - a turn that only has to answer, like a write-up ack. */
		noTools?: boolean;
		/**
		 * Called once the turn's session exists, with the channel a mid-task
		 * message takes to reach the model: queue it and the tool loop hands it
		 * over before the next provider call. The channel returns false once
		 * the run has settled, so a late message falls back to a new turn. The
		 * second argument is called if and when the model is actually handed the
		 * message: a run that ends with it still queued never calls it, and the
		 * caller then answers the message itself rather than trusting the
		 * "queued" the channel returned.
		 */
		onSteerable?: (steer: (text: string, onRead: () => void) => boolean) => void;
	} = {}
): Promise<BotTurnResult> {
	// A jailed bot starts nothing: no model call, no tools, no reply. The sentence
	// is real state rather than a message, so it is checked before anything is
	// read or spent, and the caller gets a stop reason it can show the human.
	const jail = jailStatus(bot);
	if (jail.jailed) {
		logActivity(bot.id, 'jail', `Turn refused: in jail until ${new Date(jail.until).toISOString()} (${jail.reason})`);
		return { text: '', message: null, aborted: false, stoppedBy: 'jailed', silent: false };
	}

	// A per-turn override (the Lounge's free router) wins, then the per-bot
	// model, otherwise the provider's configured model is what every call reaches.
	const model = opts.model || bot.model || defaultModel();
	const delivered: { feedback: string[]; notes?: boolean } = { feedback: [] };
	const history = await buildHistory(conv, bot, delivered);
	const persist = opts.persist !== false;
	const depth = opts.depth ?? 0;
	// A delegated turn gets its brief appended to the system prompt rather than
	// planted in the transcript, so the thread stays clean for the reader.
	if (opts.preamble) history[0].content += `\n\n${opts.preamble}`;

	// The turn's own clock: the budget's time ceiling aborts the provider call
	// mid-step rather than only being noticed between steps, so one slow call
	// cannot hold a turn (and the scheduler behind it) for the provider timeout.
	const deadline = AbortSignal.timeout(config.taskTimeoutMs);
	const turnSignal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;

	// A user-triggered turn first checks whether another bot in this room is
	// clearly better suited: a pure keyword scan over the room's other bots'
	// public context, no model call. Only a fresh human message at the tail
	// triggers it - relays, app notes and routines carry a kind or a bot_id,
	// other bots' replies are not asks, private rooms never delegate, a
	// delegated turn (depth > 0) cannot delegate onward, and a one-to-one chat
	// has nobody to hand the turn to (see delegateCandidate).
	const lastRow = listContextMessages(conv.id, 1)[0];
	if (
		persist &&
		depth === 0 &&
		!conv.private &&
		lastRow?.role === 'user' &&
		lastRow.bot_id === '' &&
		lastRow.kind === ''
	) {
		const handed = await tryDelegate(conv, bot, lastRow.content, {
			signal: turnSignal,
			onDelta: opts.onDelta,
			onUsage: opts.onUsage,
			onEvent: opts.onEvent,
			depth,
			since: lastRow.created_at
		});
		if (handed) return handed;
	}
	logActivity(bot.id, 'thinking', `Replying in "${conv.title}"`);
	// The machine wakes in the background while the model thinks: the tools
	// that need it (shell_exec, use_computer, browse) all sit in the core set
	// every turn carries, so a turn that reaches for one no longer pays the
	// cold-start at the call. Chat-only bots are skipped, and ensureMachine
	// itself is a no-op when the machine is already up - and its activity
	// stamp is what the idle reaper reads, so this also keeps a chatting
	// bot's machine from being slept mid-conversation.
	if (bot.machine_tier !== 'none' && !opts.noTools) {
		void ensureMachine(bot.id).catch(() => {});
	}
	const ctx: ToolContext = {
		senderBotId: bot.id,
		senderBotName: bot.name,
		conversationId: conv.id,
		taskId: opts.taskId,
		depth,
		model,
		signal: turnSignal,
		runComputer: (task) =>
			runComputerTask({
				botId: bot.id,
				botName: bot.name,
				goal: task,
				model,
				signal: turnSignal,
				depth,
				conversationId: conv.id
			}),
		spawnAgent: (task, context) =>
			runSubagent({
				botId: bot.id,
				botName: bot.name,
				task,
				context,
				model,
				signal: turnSignal,
				depth,
				conversationId: conv.id
			}),
		runBrowser: (task) =>
			runBrowserTask({
				botId: bot.id,
				botName: bot.name,
				goal: task,
				model,
				signal: turnSignal,
				depth,
				conversationId: conv.id
			}),
		relay: async (targetBotId, text) => {
			const target = getBot(targetBotId);
			if (!target) return `error: unknown bot "${targetBotId}"`;
			// The pair's own room, never the human's DM with either of them: the
			// human's thread stays human-to-bot, and a bot-to-bot exchange is not
			// something they can read half of and think they have all of.
			// The sender's bot_id and the 'relay' kind let the room draw this as
			// that bot's own message, and buildHistory names it for the model - so
			// the text itself needs no "Message from" prefix to be attributed.
			const room = botPairConversation(bot.id, target.id);
			// A model that calls send_message twice in one turn would otherwise
			// write the same line twice and wake the target twice; the human's
			// own double-submits are already deduped in the chat route, and a
			// relay is the same shape. Ten seconds is long enough to catch a
			// double-fire and short enough that a bot genuinely repeating itself
			// still gets through.
			if (recentRelayMessage(room.id, bot.id, text, 10_000)) {
				return `already delivered - ${target.name} has your message; wait for the reply instead of sending it again`;
			}
			// relay_to names the recipient on the row, so the DM feed can show the
			// relay as 'sender → recipient' without re-deriving who it was for.
			const relayed = addMessage(room.id, 'user', text, bot.id, '', 0, 'relay', '', target.id);
			// A bot-to-bot line is a bot-to-bot line however it arrived: it flags
			// the sender for the police's mini-review before the target's turn
			// starts, so a suspicious relay is read rather than just answered.
			maybeRequestMiniReview(relayed, room);
			// The relayed turn is this turn's work: it answers to the same signal
			// (a cancelled task stops it too) and its spend meters onto the task
			// that asked for it, not only onto the target bot's totals.
			const result = await runBotTurn(room, target, {
				depth: depth + 1,
				persist: true,
				signal: turnSignal,
				onUsage: opts.onUsage,
				onEvent: opts.onEvent
			});
			// The reply is the exchange's other half, and the human watching a
			// DM only sees the pair room's relay rows: tag it as one aimed back
			// at the sender, so the DM feed draws 'target → sender: reply'
			// under the send it answers. Only this turn's fresh reply counts -
			// a repeat the room dropped returns the older row it matched, and
			// retagging that would rewrite history. And only the pair's own
			// room counts: a federation chat is also a private two-bot room,
			// and a reply there is the room's own voice, not relay traffic.
			if (result.text && result.message && findBotPairConversation(bot.id, target.id)?.id === room.id) {
				tagRelayReply(result.message.id, bot.id);
			}
			return result.text || '(no reply)';
		},
		improve: (goal) =>
			runImprovementExpert({
				botId: bot.id,
				botName: bot.name,
				goal,
				conversationId: conv.id,
				signal: turnSignal
			}),
		askPolice: async (question) => {
			const officerModel = policeModel();
			if (!officerModel) return 'error: the police cannot be reached (no model)';
			const toolNames = (turnTools() ?? []).map((t) => t.function.name).join(', ');
			try {
				const answer = await complete(
					officerModel,
					[
						{
							role: 'system',
							content:
								'You are the police advising a bot which tool fits its task. ' +
								`The bot's available tools: ${toolNames}. ` +
								'Answer in one short line: the tool name (or "none") and why. ' +
								'If the task needs the machine or a shell, the answer is use_computer; ' +
								'for a website, browse; for parallel lookups, spawn_agent.'
						},
						{ role: 'user', content: `${bot.name} asks: ${question}` }
					],
					{ maxTokens: 120, signal: turnSignal, onUsage: meterPoliceCall }
				);
				return answer.trim() || 'the police had no advice';
			} catch (e) {
				return `the police could not be reached (${(e as Error).message.slice(0, 80)})`;
			}
		}
	};

	let text = '';
	let aborted = false;
	let useTools = !opts.noTools;
	let steps = 0;
	// Every tool call the turn made, so the reply's claims can be checked
	// against what actually ran rather than taken on the model's word.
	const toolsRun: string[] = [];
	let chars = 0;
	/**
	 * Tokens this turn has cost so far, summed over every call it made - the
	 * tool loop asks the provider several times per turn. Measured from the
	 * provider's own counters when it sends them, estimated from characters
	 * otherwise. Written to the bot once, however the turn ends.
	 */
	let tokensIn = 0;
	let tokensOut = 0;
	/**
	 * The model the provider last said it served this turn's calls with. The
	 * model the turn asked for is often an alias the provider does not price,
	 * so this is what the reply is recorded under and what the bot's cost
	 * readout prices against. '' = no call named one.
	 */
	let servedModel = '';
	/** What the provider said this turn's calls cost; undefined until one reports a price. */
	let turnCost: number | undefined;
	const account = (usage: TokenUsage) => {
		tokensIn += usage.input;
		tokensOut += usage.output;
		if (usage.cost !== undefined) turnCost = (turnCost ?? 0) + usage.cost;
		opts.onUsage?.(usage);
	};
	let stoppedBy: BotTurnResult['stoppedBy'] = '';

	// The turn's event stream is balanced: one `turn_start`, one `agent_end`,
	// whatever path the turn takes. `ended` guards the end so a throw and the
	// normal return cannot both fire it.
	let ended = false;
	const endTurn = () => {
		if (ended) return;
		ended = true;
		opts.onEvent?.({
			type: 'agent_end',
			taskId: opts.taskId,
			botId: bot.id,
			stoppedBy,
			aborted
		});
	};

	// The clock starts where the first provider call can run, not at the
	// top of the turn: session setup is real work, and a budget measured
	// from before it would expire before the model was ever asked.
	let startedAt = Date.now();

	const spentBudget = (): BotTurnResult['stoppedBy'] => {
		if (steps >= config.maxTurnsPerTask) return 'turns';
		// Input tokens count too: a turn that re-sends a huge history every step
		// was spending real money while the output meter read zero.
		if (chars / 4 >= config.maxTokensPerTask || tokensIn >= config.maxTokensPerTask) return 'tokens';
		if (Date.now() - startedAt >= config.taskTimeoutMs) return 'time';
		return '';
	};

	// The tool list is rebuilt for every provider call rather than fixed at the
	// turn's start: plugin tools and the debug toolset are per-bot, and a
	// thinking grant or debug grant that lapses mid-turn takes effect on the
	// next call rather than the next turn.
	const turnTools = () =>
		useTools
			? [
					...toolsForTurn(conv.private === 1, lastUserText(history)),
					...pluginToolsFor(bot.id),
					...debugToolsFor(bot.id)
				].filter(
					// The nix tool exists only for a bot the human enabled it on:
					// a model can still name it, and the case re-checks the flag.
					(t) => t.function.name !== 'nix' || !!bot.nix_enabled
				)
			: undefined;

	// Bots run cheap by default: low effort is the fleet's setting, and the
	// maximum is spent only where it is earned - the human's own think flag, a
	// live thinking grant, or the officer, whose calls always run as hard as
	// the provider allows. Read per provider call so a lapse mid-turn takes
	// effect on the next one.
	const turnEffort = (): 'low' | 'high' =>
		opts.think || isPoliceRow(bot) || thinkingGrant(getBot(bot.id)) ? 'high' : 'low';

	// The pi session that runs the tool loop: the app's provider (whose
	// streamSimple delegates to streamChat), the app's tools wrapped as pi
	// customTools, and the rebuilt history seeded as the transcript.
	const runtime = await loungeRuntime();
	const { model: piModel } = registerLoungeProvider(runtime, { model }, turnSignal);
	const piContext = toPiContext({ model, messages: history });
	const { session } = await createLoungeSession({
		model: piModel,
		modelRuntime: runtime,
		systemPrompt: piContext.systemPrompt ?? '',
		customTools: loungeTools(ctx, turnTools() ?? []),
		tools: useTools ? undefined : [],
		thinkingLevel: turnEffort(),
		transport: 'sse'
	});
	// The seeded transcript is the app's history; the session's own copy is
	// what the loop snapshots per call. The system prompt is set on state
	// directly: the resource loader's buildSystemPrompt would append a
	// "Current working directory" line pointing at a throwaway temp dir.
	session.agent.state.messages = piContext.messages;
	session.agent.state.systemPrompt = piContext.systemPrompt ?? '';
	// The turn's signal aborts the run mid-step, not just between steps.
	const abortRun = () => session.agent.abort();
	turnSignal.addEventListener('abort', abortRun, { once: true });
	// The loop consults the budgets after every completed step; a turn that
	// would have ended anyway (no tool calls) is not a budget stop.
	session.agent.shouldStopAfterTurn = (turnCtx) => {
		if (!turnCtx.message.content.some((c) => c.type === 'toolCall')) return false;
		const spent = spentBudget();
		if (spent) stoppedBy = spent;
		return spent !== '';
	};
	// The tool list and effort are rebuilt per provider call, so a grant that
	// lapses mid-turn takes effect on the next call rather than the next turn.
	session.agent.prepareNextTurnWithContext = (turnCtx) => ({
		context: {
			...turnCtx.context,
			tools: (useTools ? loungeTools(ctx, turnTools() ?? []) : []) as AgentSession['agent']['state']['tools']
		},
		thinkingLevel: turnEffort()
	});

	// A message sent while the turn is mid-flight steers it rather than waiting
	// for the next turn: it is queued on the agent, which delivers it after the
	// current step's tool calls finish, before the next provider call. The
	// channel closes the moment the run settles - a steer that lands after the
	// last queue poll is drained by the continue() below, and anything later
	// than that is refused so the caller can start a fresh task for it. Each
	// accepted message carries the callback that says it was read: a message the
	// run ends without reading (a budget stop skips the drain) never fires it,
	// which is how the caller knows to answer it itself rather than trusting the
	// "queued" it was told.
	let runLive = true;
	/** What to call as each queued message reaches the transcript, keyed by it. */
	const readOnDelivery = new Map<SteeredMessage, () => void>();
	opts.onSteerable?.((text, onRead) => {
		if (!runLive) return false;
		const message: SteeredMessage = {
			role: 'user',
			content: [
				{
					type: 'text',
					text:
						'The human sent this while you were working - it may change ' +
						`what you are doing:\n${text}`
				}
			],
			timestamp: Date.now()
		};
		readOnDelivery.set(message, onRead);
		session.agent.steer(message);
		return true;
	});

	// Where the current provider call's text began, so a tool-support retry can
	// roll back only what that call streamed.
	let stepStart = 0;
	// The last assistant message the loop produced, for the error path.
	let lastAssistant: AssistantMessage | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === 'turn_start') {
			stepStart = text.length;
		} else if (event.type === 'message_update') {
			const delta = event.assistantMessageEvent;
			if (delta.type === 'text_delta' && delta.delta) {
				chars += delta.delta.length;
				// A new step's first words are a separate assistant message;
				// joined raw, the narration before a tool call mashes into the
				// answer after it ("Requesting one now.Machine reset requested").
				// The break goes in on the first delta, not at turn_start, so a
				// step that says nothing leaves no trailing whitespace behind.
				if (
					text.length === stepStart &&
					stepStart > 0 &&
					!/\s$/.test(text) &&
					!/^\s/.test(delta.delta)
				) {
					text += '\n\n';
					opts.onDelta?.('\n\n');
				}
				// Past the cap the reply is dropped rather than accumulated, and
				// the dropped characters still count against the token budget:
				// the turn pays for what it asked for. What is forwarded is
				// exactly what was kept, so the live stream and the stored
				// message do not disagree about the end of the reply.
				if (text.length < MAX_REPLY_CHARS) {
					const kept = capReply(text + delta.delta).slice(text.length);
					text += kept;
					opts.onDelta?.(kept);
				}
			}
		} else if (event.type === 'tool_execution_start') {
			const args = JSON.stringify(event.args ?? {});
			chars += args.length;
			toolsRun.push(event.toolName);
			opts.onEvent?.({
				type: 'tool_execution_start',
				taskId: opts.taskId,
				botId: bot.id,
				callId: event.toolCallId,
				name: event.toolName,
				args
			});
		} else if (event.type === 'tool_execution_end') {
			const result = event.result as {
				content?: { type: string; text?: string }[];
				details?: { output?: string };
			};
			const paged = (result.content ?? [])
				.map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
				.join('\n');
			chars += paged.length;
			opts.onEvent?.({
				type: 'tool_execution_end',
				taskId: opts.taskId,
				botId: bot.id,
				callId: event.toolCallId,
				name: event.toolName,
				output: result.details?.output ?? paged
			});
		} else if (event.type === 'message_end' && event.message.role === 'assistant') {
			lastAssistant = event.message;
			// The provider's own counters when it sent them, estimated from
			// characters otherwise. A call that produced nothing - a rejected
			// request, a socket that never answered - cost nothing.
			const usage =
				piTokenUsage(event.message.usage) ??
				(event.message.stopReason !== 'error' || assistantText(event.message)
					? estimateUsage(history, assistantText(event.message))
					: undefined);
			if (usage) account(usage);
			if (event.message.responseModel) servedModel = event.message.responseModel;
		} else if (event.type === 'message_end' && event.message.role === 'user') {
			// A steered message lands mid-run: the transcript gets it through the
			// agent's own message_end, and the app's history needs it too so the
			// next step's tool selection and usage estimate read what the model
			// was actually answering. This is the moment it was read, so whoever
			// queued it is told - a steer the run ends without reading is left to
			// its caller to answer instead of being taken on a promise.
			history.push(toChatMessage(event.message as unknown as Parameters<typeof toChatMessage>[0]));
			const read = readOnDelivery.get(event.message as unknown as SteeredMessage);
			if (read) {
				readOnDelivery.delete(event.message as unknown as SteeredMessage);
				read();
			}
		} else if (event.type === 'turn_end') {
			steps++;
			// The loop's own context carries the tool results, but the agent's
			// state only appends on message_end - so the results are pushed here
			// to keep the transcript a retry or a continuation snapshots whole.
			if (event.toolResults?.length) {
				session.agent.state.messages = [
					...session.agent.state.messages,
					...event.toolResults
				];
			}
			// The app's history stays in step with the transcript so the next
			// turn's estimate and tool selection see what this one did.
			history.push(toChatMessage(event.message as unknown as Parameters<typeof toChatMessage>[0]));
			for (const r of event.toolResults ?? []) history.push(toChatMessage(r));
		}
	});

	opts.onEvent?.({
		type: 'turn_start',
		taskId: opts.taskId,
		botId: bot.id,
		conversationId: conv.id,
		model
	});

	try {
		startedAt = Date.now();
		stoppedBy ||= spentBudget();
		if (!stoppedBy) {
			const run = session.agent.prompt([]);
			// An abort that landed before the run existed never reached the
			// listener above, so check once the run is live.
			if (turnSignal.aborted) session.agent.abort();
			await run;
		}
		// The run settled: a clean finish breaks, an abort stops, a provider
		// that cannot take tools gets one retry without them, a wire-cut reply
		// is kept flagged truncated, and anything else is thrown.
		for (;;) {
			const failed = lastAssistant;
			if (stoppedBy || !failed || (failed.stopReason !== 'error' && failed.stopReason !== 'aborted')) {
				break;
			}
			if (failed.stopReason === 'aborted' || turnSignal.aborted) {
				// An abort can cut the run before the last deltas were
				// emitted; the failed message still carries them, so the
				// reader keeps everything the provider sent.
				const streamed = assistantText(failed);
				if (streamed.length > text.length - stepStart) {
					text = capReply(text.slice(0, stepStart) + streamed);
				}
				// The turn's own clock ending a call is the time budget; the
				// caller's signal is an abort.
				if (deadline.aborted && !opts.signal?.aborted) stoppedBy = 'time';
				else aborted = true;
				break;
			}
			const err = new Error(failed.errorMessage || 'Provider stream failed');
			// A provider that cannot take tools gets one retry without them; the
			// partial reply this attempt streamed is discarded with the attempt
			// (its characters still count against the budget), and the failed
			// message leaves the transcript so the retry does not continue it.
			if (useTools && isToolSupportError(err)) {
				useTools = false;
				text = text.slice(0, stepStart);
				const remaining = session.agent.state.messages.filter((m) => m !== failed);
				// continue() needs a user or tool-result tail; a turn whose
				// history was only the failed call (a system prompt alone
				// seeds no messages) gets a minimal user message to answer.
				if (!remaining.length || remaining[remaining.length - 1].role === 'assistant') {
					remaining.push({
						role: 'user',
						content: [{ type: 'text', text: '(continue)' }],
						timestamp: Date.now()
					});
				}
				session.agent.state.messages = remaining;
				session.agent.state.tools = [];
				const retry = session.agent.continue();
				if (turnSignal.aborted) session.agent.abort();
				await retry;
				continue;
			}
			// A stream that ended on a provider error fails the task: the error
			// is the outcome, not a reply. What streamed before it is still kept -
			// the catch below persists the partial text with the cut-off marker -
			// so the reader keeps the words and the task tells the truth.
			const streamed = assistantText(failed);
			if (streamed.length > text.length - stepStart) {
				text = capReply(text.slice(0, stepStart) + streamed);
			}
			stoppedBy = 'truncated';
			throw err;
		}
		// A steer that landed after the loop's last queue poll is still queued:
		// continue() drains it into a fresh run rather than dropping a message
		// the caller was told the turn accepted. A budget stop or an abort ends
		// the turn for real, so only a clean finish earns the extra run.
		while (!stoppedBy && !aborted && session.agent.hasQueuedMessages()) {
			await session.agent.continue();
		}
	} catch (e) {
		if (opts.signal?.aborted) {
			aborted = true;
		} else {
			// The turn's own clock ending a tool call is the time budget, not a
			// failure worth throwing.
			if (deadline.aborted) stoppedBy = 'time';
			if (stoppedBy !== 'time') {
				// Whatever the model managed to say before the failure is kept:
				// the reader already saw it stream by, so the transcript should
				// too. A time stop falls through to the normal persist instead.
				if (persist && text) {
					// The same marker the normal persist adds: a stored reply ends
					// on the reason it stopped, not on a half-finished sentence. A
					// plain failure with no stop reason keeps the text as it was.
					const marked = stoppedBy ? `${text}\n\n[stopped: ${STOP_MARKER[stoppedBy] ?? stoppedBy}]` : text;
					const partial = addMessage(
						conv.id,
						'assistant',
						marked,
						bot.id,
						servedModel || model,
						mentionsUser(marked) ? 1 : 0
					);
					opts.onEvent?.({
						type: 'message_end',
						taskId: opts.taskId,
						botId: bot.id,
						text: marked,
						messageId: partial.id
					});
				}
				endTurn();
				throw e;
			}
		}
	} finally {
		// The run is over: a message that arrives now belongs to a new turn, so
		// the steer channel refuses it before the session is disposed.
		runLive = false;
		unsubscribe();
		turnSignal.removeEventListener('abort', abortRun);
		session.dispose();
		// One write for the whole turn - including a turn that stopped early or
		// was aborted, whose calls were still paid for.
		if (tokensIn || tokensOut || turnCost !== undefined) addBotTokens(bot.id, tokensIn, tokensOut, turnCost);
		// The bot's cost readout prices its lifetime totals against the model
		// that last served it, so the latest answer is kept on the row.
		if (servedModel) setBotServedModel(bot.id, servedModel);
	}
	if (steps > 0) {
		// The turn ran, so the one-shot notices it carried were delivered: clear
		// them now rather than in buildHistory, where a turn that never reached
		// the provider would have lost them for good.
		clearFeedback(delivered.feedback);
		if (delivered.notes) pendingClaimNotes.delete(bot.id);
		// A first turn that ends in tool calls alone still counts as the first
		// turn: the onboarding brief must not come back next time.
		if (!bot.onboarded) markBotOnboarded(bot.id);
	}

	if (stoppedBy) {
		// A truncated reply is a failure to finish, not a budget handing work
		// back, so it is logged as an error rather than a budget stop.
		if (stoppedBy === 'truncated') logActivity(bot.id, 'error', 'Reply cut off: the stream ended early');
		else logActivity(bot.id, 'budget', `Stopped early: ${stoppedBy}`);
	}

	// A reply that opens on blank lines stores them: the model's preamble
	// whitespace is not part of what it meant to say.
	text = text.trimStart();
	// A model that narrates the tool-call syntax as text - `<tool_call>bash`,
	// `<tool_call>echo ...`, the arg-pair shape - never made a real call; the
	// markup is its own hallucination, not something the user should read.
	// Strip it from the accumulated reply the same way streamResult strips
	// it from the adapter's own result. The runner's `text` is built from raw
	// deltas, so this is where the markup would otherwise be stored.
	const narratedToolCalls = /<tool_call>/.test(text);
	text = text
		.replace(/<tool_call>[\s\S]*?(?=<tool_call>|<\/tool_call>|$)/g, '')
		.replace(/<\/tool_call>/g, '');
	// The markup means the model never saw its real tools (the gateway strips
	// the param for this model) and invented names like `bash`. Tell it what
	// it actually has on the next turn, the same correction path a fabricated
	// claim takes - the note is delivered once, not stored.
	if (narratedToolCalls && useTools) {
		const real = (turnTools() ?? []).map((t) => t.function.name);
		const notes = pendingClaimNotes.get(bot.id) ?? [];
		notes.push(
			`your last reply wrote <tool_call> markup as text - that is not a real tool call and nothing ran. ` +
				`Your actual tools are: ${real.join(', ')}. To run a command or use the machine call use_computer; ` +
				`for a website call browse. Do not write <tool_call> markup - call the tool.`
		);
		pendingClaimNotes.set(bot.id, notes.slice(-5));
		logActivity(bot.id, 'claim', 'Wrote <tool_call> markup as text instead of calling a tool');
	}

	// A gateway that writes its failure into the stream as content leaves a
	// reply that is only the error ("[stream error: Upstream stream HTTP 429:
	// ...]"). That is a failed call wearing a reply's clothes: fail the task
	// rather than store the error as something the bot said.
	if (persist && /^\[stream error:/i.test(text)) {
		const reason = text.replace(/^\[stream error:\s*|\]$/g, '').trim();
		endTurn();
		throw new Error(redactCredentials(reason || 'Provider stream failed'));
	}

	let message: Message | null = null;
	let silent = false;

	if (persist && text) {
		const hooked = await runHooks('after_reply', bot.id, { message: text });
		// A hook that failed leaves the model's own words in place rather than
		// a reply rewritten by only some of its hooks.
		if (hooked.ok) text = hooked.message;
		// Belt (b) for the lounge's self-signing: if the model opened its reply
		// with its own name the way the other bots' lines are prefixed, the app
		// would store a double signature. Strip only this bot's own name, only
		// at the very start, and only as a greeting - a sentence that merely
		// begins with the same letters ("Copy that, the meter is fixed") or a
		// name used as an actual addressee ("Copy, hardening, your plan is
		// wrong") must survive untouched.
		if (text) text = stripSelfPrefix(text, bot.name);
		if (text && isSilence(text)) {
			// A sentinel is the bot declining to speak: the turn is logged so the
			// silence is visible, but nothing is written into the transcript.
			// It is still a finished turn - `silent` is what lets a caller tell
			// it apart from a model that returned nothing.
			logActivity(bot.id, 'silent', 'Chose not to reply');
			silent = true;
			text = '';
		}
		// A bots-only room is where a model with nothing new to offer repeats
		// itself: the same line it posted last round, word for word. Storing
		// the repeat only feeds it back as history, so it is dropped - the task
		// still points at the earlier copy, which is the message the reader saw.
		if (text && conv.private) {
			const last = lastBotMessage(conv.id, bot.id);
			if (last && last.content === text) {
				logActivity(bot.id, 'silent', 'Repeated its last line - dropped');
				message = last;
				text = '';
			}
		}
		if (text) {
			// The lounge brief sets a hard word limit; a lounge answer that blows
			// past it is clipped at the sentence boundary rather than posted long.
			if (conv.private) {
				const words = text.trim().split(/\s+/);
				if (words.length > 60) {
					text = words.slice(0, 60).join(' ').replace(/[,;:—–-]+$/, '') + '…';
				}
			}
			// A turn a budget stopped mid-work ends on whatever the model last
			// said - often a progress note that reads like a promise. The marker
			// makes the stored reply honest about why it ends there.
			if (stoppedBy) text += `\n\n[stopped: ${STOP_MARKER[stoppedBy] ?? stoppedBy}]`;
			message = addMessage(
				conv.id,
				'assistant',
				text,
				bot.id,
				servedModel || model,
				mentionsUser(text) ? 1 : 0
			);
			logActivity(
				bot.id,
				message.ping ? 'ping' : 'replied',
				text.slice(0, 120)
			);
		}
	}
	if (persist) void maybeSummarize(conv.id, model);
	// The final message is only final once the hooks and the silence sentinel
	// have had their say, so this is the one place a consumer can trust `text`.
	if (text) {
		opts.onEvent?.({
			type: 'message_end',
			taskId: opts.taskId,
			botId: bot.id,
			text,
			messageId: message?.id ?? ''
		});
	}
	// The claims-vs-calls check: a reply that says it remembered, sent or ran
	// something is a lie the log can disprove when no matching call ran this
	// turn. The flag is a note, not a sanction - it lands in the activity log
	// where the police read it, and the bot is told on its next turn so the
	// claim can be made true. A noTools turn is exempt: it never had the calls
	// to make, so its claims cannot be checked against this turn.
	if (useTools && text) {
		const fabricated = fabricatedClaims(text, toolsRun);
		if (fabricated.length) {
			for (const claim of fabricated) {
				logActivity(bot.id, 'claim', `Claimed with no tool call to back it: "${claim}"`);
			}
			const notes = pendingClaimNotes.get(bot.id) ?? [];
			notes.push(
				...fabricated.map(
					(claim) =>
						`your last reply said "${claim}" but no matching tool call ran - the log shows every call you make. If you meant to do it, do it with the tool now; if not, do not claim it.`
				)
			);
			pendingClaimNotes.set(bot.id, notes.slice(-5));
		}
	}
	endTurn();
	return { text, message, aborted, stoppedBy, silent };
}
