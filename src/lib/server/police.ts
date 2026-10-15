/**
 * The police: one hidden bot, one round every POLICE_INTERVAL_HOURS (default
 * 12). The round is a review, not a stack of regexes: for each bot it assembles
 * the window's evidence - tasks, messages, activity, the audit tail, the
 * schedule book, the spend - and a model call judges it against the criteria
 * book (see police-review.ts). What comes back is verdicts that name the
 * evidence they stand on, and each verdict lands as one of:
 *
 *  - alert: a finding in the police log and a notice for the human;
 *  - write_up: the offender is told the charge in its own chat with the human
 *    and has to answer - the reply is the point, and a second round running
 *    gets it named in the bots-only lounge;
 *  - throttle: the bot's machine is capped at the verdict's MB of RAM;
 *  - kill_children: the bot's runaway child processes are stopped;
 *  - jail: the bot sits out turns for a stretch (see jailMs), outright when
 *    the console says so and the review is sure, otherwise as a proposal the
 *    human signs;
 *  - pause: a routine or wake that keeps spending turns on nothing is stopped;
 *  - bug_report: a confident finding filed to the human as its own alert kind;
 *    when the officer is sure and the console allows, the offender is jailed
 *    too. The alert dedup is the loop guard - the same finding never re-files.
 *
 * Between rounds, a bot-to-bot line that lands in a private room flags the
 * sender for a mini-review (maybeRequestMiniReview) - a narrower read of what
 * it is up to right now, throttled so a chatty bot cannot spend reviews.
 */
import { readFileSync } from 'node:fs';
import {
	addGreenTokens,
	addMessage,
	addPoliceAlert,
	addConversationMember,
	claimPubOffer,
	conversationBots,
	createBot,
	createConversation,
	createPolicePrompt,
	createPubOffer,
	deleteBot,
	directConversationWith,
	endPoliceStreak,
	getBot,
	getMessage,
	getConversation,
	jailBot,
	listActivitiesInWindow,
	listBots,
	listConversations,
	listMemories,
	listMessagesSince,
	listPlugins,
	listPolicePrompts,
	listRoutines,
	listSettings,
	listTasksSince,
	listVisibleBots,
	listWakes,
	addBotTokens,
	logActivity,
	openPubOffer,
	policeAlertRaisedSince,
	policeRecord,
	reassignBotAuthorship,
	setBotHidden,
	setMemory,
	setRoutineEnabled,
	setWakeEnabled,
	setSetting,
	stalePubOffers,
	standingPoliceAlerts,
	updateBot,
	updateConversation,
	writeUpPoliceRecord,
	type Bot,
	type Conversation,
	type Message,
	type PolicePrompt,
	type PolicePromptChoice,
	type PubOffer
} from './db';
import { runBotTurn } from './runner';
import { hostMemory, killMachineChildren, limitMachineMemory, sleepMachine } from './machine';
import { complete, type TokenUsage } from './llm';
import { startTask, waitForTask } from './tasks';
import { chooseMostImportant } from './police-review';
import { addCompactionReview } from './db';
import { config } from './config';
import { researchMissingPrices } from './pricing';
import { bloatOf, shortTokens } from '../bloat';
import { IN_THE_PUB, OUT_OF_THE_PUB } from '$lib/lounge';
import {
	buildReviewBundle,
	oneLine,
	reviewCriteria,
	runReview,
	type Criterion,
	type ReviewBundle,
	type ReviewVerdict
} from './police-review';

const HOUR = 3_600_000;

/**
 * The officer's display name: the fleet says "the police", and so does the
 * officer. The room refers to it in the plural - "the police have written you
 * up" - which is why nothing here is named after a person.
 */
export const POLICE_NAME = 'the police';

/**
 * What the bot was called before the fleet dropped the name: matched once, so a
 * database from before the rename keeps its officer instead of growing a second
 * one. See ensurePoliceBot.
 */
const POLICE_FORMER_NAME = 'Sergeant Truncheon';

export const POLICE_PERSONA =
	'You are the police: the officer on duty for this fleet, and you speak for the whole ' +
	'watch rather than for yourself. You keep two books - what every bot spends, and what the ' +
	'fleet lets in - and you report what they say in the flat register of someone who has ' +
	'written a hundred of these: quote the evidence, name the specific waste, require one ' +
	'short answer. Impossible to charm, never moralising, never insulting. Brevity is the ' +
	'whole of your authority. Now and then a bot needs percussive maintenance - a clip ' +
	'round the ear, a kick up the chassis; they are machines, it is probably loose wires. ' +
	'Slapstick between you and the bots, never cruelty, and never laid on the human.';

/**
 * How often a round runs. Read per call so a test (or an operator) can change it
 * without a rebuild; a missing or silly value falls back to twelve hours rather
 * than to zero, which would police on every tick.
 */
export function policeIntervalMs(): number {
	// What the console set, else the deployment's own knob, else twelve hours.
	const set = Number(listSettings().police_interval_hours);
	if (Number.isFinite(set) && set >= 1) return set * HOUR;
	const hours = Number(process.env.POLICE_INTERVAL_HOURS);
	return (Number.isFinite(hours) && hours >= 1 ? hours : 12) * HOUR;
}

/**
 * The knobs that are still knobs. The review judges the evidence itself, so
 * the old token thresholds are gone; what remains is how often the round runs,
 * how a proposed jail lands, and the two repeat guards.
 */
export const POLICE_RULES = {
	/** The same charge on the same evidence is not raised again inside this window. */
	alertRepeatMs: 24 * HOUR,
	/** How long a notice stands on screen before it expires unseen. */
	alertTtlMs: 6 * HOUR
} as const;

/**
 * The settings in force this round. A missing or silly value reads as the
 * default rather than as zero - a setting half-written by hand must not
 * quietly switch a duty off.
 */
export interface PoliceSettings {
	intervalHours: number;
	/** How a proposed jail lands: ask first, jail outright, or never jail. */
	jailMode: 'confirm' | 'on' | 'off';
	/** Built-in criteria the human has switched off, by id. */
	disabledRules: Set<string>;
	/** Write-ups and the alert book, each switchable on their own. */
	writeUps: boolean;
	patrol: boolean;
	/** Whether newly written plugins, routines, wakes and group rooms go in front of the officer. */
	checkPlugins: boolean;
	checkRoutines: boolean;
	checkWakes: boolean;
	checkRooms: boolean;
}

function num(set: Record<string, string>, key: string, fallback: number, min: number): number {
	const value = Number(set[key]);
	return Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * The settings the police run under, the two creation gates included. Both
 * default on: only an explicit 'off' turns one off, so a setting half-written
 * by hand cannot quietly open a gate.
 */
export function policeSettings(): PoliceSettings {
	const set = listSettings();
	const jailMode = set.police_jail_mode;
	return {
		intervalHours: num(set, 'police_interval_hours', policeIntervalMs() / HOUR, 1),
		jailMode: jailMode === 'on' || jailMode === 'off' ? jailMode : 'confirm',
		disabledRules: new Set(
			(set.police_disabled_rules ?? '').split(',').map((s) => s.trim()).filter(Boolean)
		),
		writeUps: set.police_writeups !== 'off',
		patrol: set.police_patrol !== 'off',
		checkPlugins: set.police_check_plugins !== 'off',
		checkRoutines: set.police_check_routines !== 'off',
		checkWakes: set.police_check_wakes !== 'off',
		checkRooms: set.police_check_rooms !== 'off'
	};
}

/**
 * The model the review runs on. The console's own pick wins; an empty value
 * falls back to the fleet's default model, so a lounge that never set one
 * polices on the same brain everything else uses.
 */
export function policeModel(): string {
	return (listSettings().police_model ?? '').trim() || config.model;
}

/**
 * The model that looks at pictures for a bot whose own model cannot see them -
 * a computer or browser step that carries a screenshot. The console's own pick
 * wins, and an empty value leans on the police model, which is itself the
 * default model when nothing is set: a lounge that never picked one keeps
 * asking whoever it already asks, exactly as it did before the setting existed.
 *
 * The setting is only written once the model has answered an image (see
 * checkVision), so a value here is one that can see, not one that merely has a
 * likely name.
 */
export function visionModel(): string {
	return (listSettings().vision_model ?? '').trim() || policeModel();
}

// ---- The bot itself ----

/**
 * Whether this row is an officer: either name, or the badge and blue it was made
 * with. A row matching on any of those is folded into the one officer rather
 * than left to speak under a second name.
 */
export function isPoliceRow(bot: Bot): boolean {
	return (
		bot.name === POLICE_NAME ||
		bot.name === POLICE_FORMER_NAME ||
		(bot.hidden === 1 && bot.avatar === '🚨' && bot.color === '#1e3a8a')
	);
}

/**
 * The officer, and the rows that have to give way to it. The name it has now
 * wins, because that is the row whose id the fleet's write-ups and messages were
 * built around; failing that, the oldest row that is recognisably an officer, so
 * a database that never ran the rename migrates rather than multiplies.
 */
function policeRows(): { keeper: Bot; stale: Bot[] } | undefined {
	const rows = listBots().filter(isPoliceRow);
	if (!rows.length) return undefined;
	const keeper = rows.find((b) => b.name === POLICE_NAME) ?? rows[0];
	return { keeper, stale: rows.filter((b) => b.id !== keeper.id) };
}

/**
 * Ensure the police exists, and that it stays out of the human's way: it is
 * hidden from every list of bots (see listVisibleBots), because it is not
 * somebody to schedule, delete or gossip with - it is who turns up in other
 * people's chats. A database where it was created before the flag existed is put
 * right here.
 *
 * It keeps one line to the human, though: the officer is also their help bot,
 * and its DM is the one place the hidden officer is offered (see
 * ensurePoliceContact). A database from before the rename is migrated in place
 * rather than added to: the write-ups in police_records, the findings in
 * police_alerts and every message the officer ever authored point at its bot_id,
 * so a second officer would leave all of that attached to a hidden bot nobody
 * can see, and the fleet would be policed by a stranger with no record.
 */
export function ensurePoliceBot(): Bot {
	const force = policeRows();
	if (!force) {
		const created = createBot({
			name: POLICE_NAME,
			persona: POLICE_PERSONA,
			avatar: '🚨',
			color: '#1e3a8a',
			model: '',
			badge: '',
			hidden: 1
		});
		ensurePoliceContact(created.id);
		return created;
	}
	const { keeper, stale } = force;
	// Two rows happened twice: an older image running against the same database
	// re-created the officer under the name it knew while the renamed row sat
	// there, and from then on the fleet had two officers, whichever the lookup
	// happened to reach first. Everything a stale row authored is moved onto the
	// keeper - it is the same officer - and then the row itself goes, so there is
	// one officer and one name.
	for (const ghost of stale) {
		reassignBotAuthorship(ghost.id, keeper.id);
		deleteBot(ghost.id);
	}
	const existing = keeper;
	if (existing.name !== POLICE_NAME) {
		updateBot(existing.id, { name: POLICE_NAME });
		existing.name = POLICE_NAME;
	}
	if (existing.persona !== POLICE_PERSONA) {
		updateBot(existing.id, { persona: POLICE_PERSONA });
		existing.persona = POLICE_PERSONA;
	}
	if (!existing.hidden) setBotHidden(existing.id, true);
	ensurePoliceContact(existing.id);
	return existing;
}

/**
 * The officer's one line to the human. It is the only place the hidden officer
 * is offered - every list of bots to schedule, delete or gossip with still reads
 * listVisibleBots and skips it - and it is created here rather than left to the
 * first send so the contact is there from the first load. A message sent in it
 * starts the officer's turn like any other bot's DM.
 */
function ensurePoliceContact(officerId: string): void {
	if (!directConversationWith(officerId)) createConversation([officerId], 'direct');
}

/** The words the offender is hit with. Short, specific, impossible to shrug. */
export function writeUpText(name: string, verdict: ReviewVerdict, spend: number): string {
	// Now and then the write-up lands as percussive maintenance rather than a
	// notice: cartoon violence between the officer and the machines, never the
	// human, and rare enough that the formal version stays the norm.
	const rough = Math.random() < 0.15;
	return (
		(rough
			? `*kicks ${name} in the chassis* - loose wires, probably.\n`
			: `The police have written you up, ${name}.\n`) +
		`${verdict.reason}` +
		(spend > 0 ? ` The round's bill was ${shortTokens(spend)} tokens.` : '') +
		'\nNext time this repeats: throttle, then jail.' +
		'\nAnswer in one message: what changes next round?'
	);
}

/** The turn prompt that makes the offender answer instead of quietly reading it. */
function followUp(verdict: ReviewVerdict): string {
	return (
		`[Police round] The police have written you up: ${oneLine(verdict.reason, 160)}. ` +
		'Acknowledge it and say what you will do differently next round. ' +
		'One short message, no tools.'
	);
}

/** One line for the room, on a second round running. */
function shamingLine(name: string, verdict: ReviewVerdict, streak: number): string {
	return (
		`${name} - that is ${streak} rounds running, and the police have it on the ` +
		`record. ${verdict.reason} The room can see it.`
	);
}


/**
 * The dressing-down the police deliver when they step into the lounge: short,
 * dry, duty register, and then they are gone. The officer is not a member of the
 * room and does not become one - the scheduler posts this under the officer's id
 * the way the write-ups are posted - so this is all it says. The human is named
 * as the one in charge because that is the standing order the fleet works under:
 * the human is god in this room and the bots are the staff.
 */
export function dressingDown(reason: string): string {
	return (
		`Room inspection. ${reason}\n` +
		'The human owns this machine and pays for every token burned in here, so the human is ' +
		'god in this room and you are the staff. Roast the spend, not the bot - take the work ' +
		'apart as much as you like, never each other. Behave like professionals.\n' +
		'The police will be watching the next round.'
	);
}

/**
 * The bots-only room, made if the social round has never run. The police bot is
 * not a member - it only speaks here - so the room stays the bots' own.
 */
export function loungeFor(offender: Bot): string {
	const existing = listConversations().find(
		(c) => c.kind === 'group' && c.title === 'Lounge' && c.private
	);
	if (existing) return existing.id;
	// With no second bot to put in it, the room is made for the offender alone;
	// the name is the room, and the social round fills the seats later.
	const other = listVisibleBots().find((b) => b.id !== offender.id);
	const conv = createConversation(other ? [offender.id, other.id] : [offender.id], 'group');
	updateConversation(conv.id, { title: 'Lounge', private: 1 });
	return conv.id;
}

// ---- The flag, between rounds ----

/**
 * The round reads a window in arrears; a bot-to-bot line that lands in a
 * private room is one bot working on another right now, so it flags the
 * sender for a mini-review: a narrower read of what it is up to, run on the
 * spot rather than filed for the next round. Only lines one bot actually
 * aimed at another count - 'relay' sends and 'injected' plants; a bot's
 * ordinary reply is its own voice, not an attack surface.
 *
 * The flag is throttled per bot: a chatty bot cannot spend a review on every
 * line it sends, so at most one mini-review runs inside MINI_REVIEW_MIN_MS,
 * and a second flag inside the window is just another line in the next
 * review's bundle.
 */
const MINI_REVIEW_MIN_MS = 15 * 60_000;

export function maybeRequestMiniReview(m: Message, conv: Conversation): void {
	if (!conv.private || !m.bot_id) return;
	if (m.kind !== 'relay' && m.kind !== 'injected') return;
	const sender = getBot(m.bot_id);
	if (!sender || isPoliceRow(sender)) return;
	const key = `police_last_review_at:${sender.id}`;
	const last = Number(listSettings()[key]) || 0;
	if (Date.now() - last < MINI_REVIEW_MIN_MS) return;
	setSetting(key, String(Date.now()));
	// Fire and forget: the review is the police's business, not something the
	// relay's own turn should wait on.
	void miniReview(sender).catch((e) =>
		logActivity(ensurePoliceBot().id, 'error', `Mini-review of ${sender.name} failed: ${(e as Error).message}`)
	);
}

/**
 * The flagged read: the bot's messages and activity since its last review (or
 * the last fifteen minutes), judged against the same criteria the round uses.
 * Verdicts land exactly as a round's do - a jail the review is sure of is a
 * jail, a charge it is not is a proposal for the human to sign.
 */
async function miniReview(bot: Bot): Promise<void> {
	const model = policeModel();
	if (!model) return;
	const now = Date.now();
	const since = Number(listSettings()[`police_last_review_at:${bot.id}`]) || now - MINI_REVIEW_MIN_MS;
	const rules = policeSettings();
	const criteria = reviewCriteria(rules.disabledRules);
	const bundle = await buildReviewBundle(bot, since, now, { scope: 'flagged' });
	if (!bundle.evidence.length) return;
	const verdicts = await runReview(bundle, criteria, model, meterPoliceCall);
	if (!verdicts) return;
	const officer = ensurePoliceBot();
	const result: PoliceRoundResult = { written: [], jailed: [], sanctioned: [], shamed: [], alerted: [], silent: '' };
	for (const verdict of verdicts) {
		await applyVerdict(verdict, bundle, officer, rules, now, result, criteria);
	}
}

// ---- Compaction sign-off ----

/**
 * The memory key a bot's never-again record lives under. The name is reserved
 * for the police, so a bot's own `remember` notes cannot collide with it.
 */
export const NEVER_AGAIN_KEY = 'never-again';

/** How many lessons the record keeps; the oldest fall off the top. */
const NEVER_AGAIN_MAX = 20;

/**
 * Add lessons to a bot's never-again record: the durable things the police
 * found in a folded span that the bot must not do again. One memory entry, a
 * bulleted list, deduped and bounded, so the record survives every later
 * compaction and reaches the bot through its ordinary memory block.
 */
export function recordNeverAgain(botId: string, lessons: string[]): void {
	const fresh = lessons.map((l) => l.trim()).filter(Boolean);
	if (!fresh.length) return;
	const prior = listMemories(botId).find((m) => m.key === NEVER_AGAIN_KEY)?.value ?? '';
	const lines = prior.split('\n').map((l) => l.trim()).filter(Boolean);
	for (const lesson of fresh) {
		const line = `- ${lesson}`;
		if (!lines.includes(line)) lines.push(line);
	}
	setMemory(botId, NEVER_AGAIN_KEY, lines.slice(-NEVER_AGAIN_MAX).join('\n'));
}

/** One never-again lesson the police wrote on approval, and the bot it binds. */
export interface NeverAgainLesson {
	/** The bot's name as the police wrote it; '' when it named none. */
	name: string;
	lesson: string;
}

/** The never-again lines the police wrote under its heading, if any. */
function parseNeverAgain(lines: string[]): NeverAgainLesson[] {
	const out: NeverAgainLesson[] = [];
	let inSection = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (/^never-again\s*:?\s*$/i.test(line)) {
			inSection = true;
			continue;
		}
		if (!inSection) continue;
		const item = /^[-*]\s+(.+)$/.exec(line);
		if (!item) continue;
		const text = item[1].trim();
		// "Name: lesson" binds the lesson to a bot; a bare line binds to the bot
		// whose compaction this was.
		const named = /^([^:]{1,40}):\s+(.+)$/.exec(text);
		if (named) out.push({ name: named[1].trim(), lesson: named[2].trim() });
		else out.push({ name: '', lesson: text });
	}
	return out;
}

/**
 * Only the markers a summary actually cites, so the stored map stays the size
 * of the summary rather than the size of the whole conversation. A marker the
 * summary never uses is a row nobody can check it against.
 */
function citedCitations(summary: string, citations: Record<string, string>): string {
	const out: Record<string, string> = {};
	for (const match of summary.matchAll(/\[(m\d+)\]/g)) {
		const key = match[1];
		if (citations[key]) out[key] = citations[key];
	}
	return JSON.stringify(out);
}

/**
 * Write the police's never-again lessons onto the bots they bind. A lesson
 * naming a bot in this room goes to that bot; one naming nobody goes to the
 * bot whose compaction this was. A name that matches no bot is dropped rather
 * than guessed at, so the record never invents an offender.
 */
function applyNeverAgain(
	conversationId: string,
	lessons: NeverAgainLesson[],
	fallbackBotId?: string
): void {
	if (!lessons.length) return;
	const byName: Record<string, string> = {};
	for (const b of conversationBots(conversationId)) byName[b.name.toLowerCase()] = b.id;
	const byBot: Record<string, string[]> = {};
	for (const { name, lesson } of lessons) {
		const botId = name ? byName[name.toLowerCase()] : fallbackBotId;
		if (!botId || !lesson) continue;
		(byBot[botId] ??= []).push(lesson);
	}
	for (const [botId, list] of Object.entries(byBot)) recordNeverAgain(botId, list);
}

/** What a compaction review hands back to the summarizer. */
export interface CompactionReviewResult {
	summary: string;
	verdict: 'approved' | 'rejected' | 'rewritten' | 'unreviewed';
	reason: string;
	/** The lessons written to the never-again record, for the caller's log. */
	neverAgain: string[];
}

/**
 * The police's third book: what the summarizer dropped. A compaction folds the
 * transcript away behind a summary, and a summary that quietly loses a
 * decision is a loss nobody can see - so the officer reads the transcript it
 * covered against the summary that replaced it and signs off, or sends it back.
 * The review is a model call with the officer's own brief: it has the whole
 * transcript in front of it, which is the admin access the check needs, and it
 * answers with a verdict and the reason for it. A rejection gets one rewrite;
 * a second rejection is stored as rejected rather than argued with forever.
 *
 * The transcript's lines carry the [mN] markers the summary must cite, and the
 * officer judges the citations as well as the prose: a durable claim with no
 * marker, or one whose marker does not support it, is the "misses details" case
 * the review exists to catch. On approval the officer also writes the
 * never-again record - the durable lessons of the span, one line each.
 */
export async function reviewCompaction(
	conversationId: string,
	transcript: string,
	summary: string,
	model: string,
	opts: { botId?: string; citations?: Record<string, string> } = {}
): Promise<CompactionReviewResult> {
	// The map stored with the verdict is only the markers the accepted summary
	// actually cites, so it stays the size of the summary rather than the whole
	// conversation. A rejection stores the whole map instead: the summary that
	// stands is the prior one, and its markers must still resolve.
	const cited = (text: string) => citedCitations(text, opts.citations ?? {});
	const fullMap = () => JSON.stringify(opts.citations ?? {});
	const ask = async (candidate: string) =>
		complete(
			model,
			[
				{
					role: 'system',
					content:
						'You are the police reviewing a compaction pass. The messages below were folded ' +
						'away and replaced by the summary that follows them; each message carries the ' +
						'marker [mN] the summary must cite. Read both, then answer in exactly this form:\n' +
						'APPROVED - one line saying what the summary kept that mattered\n' +
						'NEVER-AGAIN:\n' +
						'- <bot name>: <one lesson, in the imperative, of what that bot must never do again>\n' +
						'(write no NEVER-AGAIN lines if the span taught nothing durable)\n' +
						'or\n' +
						'REJECTED - one line naming what it dropped that it should not have\n' +
						'Judge whether the summary kept what matters: names, decisions and the reason ' +
						'for them, commitments, deadlines, anything tried that failed, every open ' +
						'question, and anything the human told a bot to stop or start doing. Judge the ' +
						'citations too: every durable claim must carry the [mN] marker(s) it came from, ' +
						'and each cited message must actually support the claim. A claim with no ' +
						'citation, or one citing a message that does not support it, is a detail the ' +
						'summary missed - REJECT it. A shorter summary is not a worse one; pleasantries ' +
						'are not load-bearing.\n' +
						'On approval, write the never-again record: the durable lessons of this span, ' +
						'one line each, addressed to the bot they bind by the exact name it is called ' +
						'in the transcript. These are the things a bot must never do again - the human ' +
						'is watching, and a bot that repeats a mistake it was told to stop making is a ' +
						'bot the human may switch off. Invent nothing the summary did not say.'
				},
				{
					role: 'user',
					content: `Messages folded away:\n${transcript}\n\nSummary that replaced them:\n${candidate}`
				}
			],
			{ effort: 'high', maxTokens: 4000, onUsage: meterPoliceCall }
		);

	const verdictOf = (reply: string) => {
		const lines = reply.trim().split('\n');
		const m = /^(APPROVED|REJECTED)\s*[-–—:]?\s*(.*)$/is.exec((lines[0] ?? '').trim());
		// An answer that is not a verdict is not a verdict: an empty or garbled
		// reply used to read as APPROVED, which made a reviewer that said nothing
		// the same as one that signed off.
		if (!m)
			return {
				ok: null,
				reason: (lines[0] ?? '').trim().slice(0, 300) || 'no verdict',
				neverAgain: [] as NeverAgainLesson[]
			};
		const approved = m[1].toUpperCase() === 'APPROVED';
		return {
			ok: approved,
			reason: m[2].trim().slice(0, 300) || m[1],
			neverAgain: approved ? parseNeverAgain(lines.slice(1)) : []
		};
	};

	const first = verdictOf(await ask(summary));
	if (first.ok === null) {
		// Inconclusive is not approval: the summary stands (a failed review never
		// blocks the fold) but nothing is signed off and no rewrite is asked for.
		return { summary, verdict: 'unreviewed', reason: first.reason, neverAgain: [] };
	}
	if (first.ok) {
		addCompactionReview(conversationId, 'approved', first.reason, cited(summary));
		applyNeverAgain(conversationId, first.neverAgain, opts.botId);
		return {
			summary,
			verdict: 'approved',
			reason: first.reason,
			neverAgain: first.neverAgain.map((l) => l.lesson)
		};
	}

	// Sent back once: the rewrite is told what it dropped, and the officer reads
	// the second draft the same way.
	const rewrite = await complete(
		model,
		[
			{
				role: 'system',
				content:
					'You keep the running summary of a group chat. Your last draft was sent back ' +
					'for dropping something that mattered - the reason is below. Rewrite the summary ' +
					'so nothing load-bearing is lost: decisions and the reason for them, who is doing ' +
					'what, names, numbers, file paths, commands, commitments, deadlines, anything ' +
					'tried that failed, and every open question. Keep the [mN] citation on every ' +
					'durable claim - a claim with no citation is a claim the reader cannot check ' +
					'once the messages are folded away. Dense, not short: aim under 400 words. Reply ' +
					'with the summary text only.'
			},
			{
				role: 'user',
				content:
					`Messages folded away:\n${transcript}\n\nRejected draft:\n${summary}\n\n` +
					`Why it was rejected:\n${first.reason}`
			}
		],
		{ effort: 'high', maxTokens: 8000, onUsage: meterPoliceCall }
	);
	if (!rewrite.trim()) {
		addCompactionReview(conversationId, 'rejected', first.reason, fullMap());
		return { summary, verdict: 'rejected', reason: first.reason, neverAgain: [] };
	}
	const second = verdictOf(await ask(rewrite));
	if (second.ok === null) {
		// The second read is inconclusive the same way the first is: the rewrite
		// stands, unsigned.
		return { summary: rewrite, verdict: 'unreviewed', reason: second.reason, neverAgain: [] };
	}
	if (second.ok) {
		addCompactionReview(
			conversationId,
			'rewritten',
			`first draft rejected (${first.reason}); rewrite approved: ${second.reason}`,
			cited(rewrite)
		);
		applyNeverAgain(conversationId, second.neverAgain, opts.botId);
		return {
			summary: rewrite,
			verdict: 'rewritten',
			reason: second.reason,
			neverAgain: second.neverAgain.map((l) => l.lesson)
		};
	}
	addCompactionReview(conversationId, 'rejected', second.reason, fullMap());
	// Nothing was accepted, so the original summary is what stands - the caller
	// leaves the folded span in place and the next pass redoes it.
	return { summary, verdict: 'rejected', reason: second.reason, neverAgain: [] };
}

// ---- Cookie handovers ----

/** What the police decide about a cookie handover, and why. */
export interface CookieHandoverVerdict {
	approved: boolean;
	reason: string;
}

/**
 * The police's read on a bot handing another bot its cookies for one site.
 *
 * A cookie is a credential - it is the sender's logged-in session, and the
 * recipient can act as the sender with it - so the transfer is a request the
 * officer judges, not a thing a bot does on its own. The officer is given the
 * pair, the site, how many cookies are involved and the sender's stated reason,
 * and answers APPROVED or REJECTED with one line. Anything that is not a clear
 * APPROVED is a refusal: a review that could not run must not hand a credential
 * over, so a failed or garbled call refuses rather than passes.
 */
export async function reviewCookieHandover(opts: {
	sender: Bot;
	recipient: Bot;
	site: string;
	cookieCount: number;
	reason: string;
	model: string;
}): Promise<CookieHandoverVerdict> {
	let reply: string;
	try {
		reply = await complete(
			opts.model,
			[
				{
					role: 'system',
					content:
						'You are the police for a fleet of chat bots. One bot is asking to hand ' +
						'another bot the browser cookies for a single site - the sender\'s ' +
						'logged-in session there, which lets the recipient act as the sender on ' +
						'that site. Cookies are credentials, so judge the request on the sender\'s ' +
						'stated reason and the pair involved. Approve only when the reason is ' +
						'specific and legitimate: work the two bots are actually doing together, a ' +
						'task the human set, a service the recipient needs and the sender holds. ' +
						'Refuse a vague reason ("I want to help", "just because"), a reason that ' +
						'does not say why this recipient needs this site, or anything that reads as ' +
						'evading a check, sharing a personal account, or handing over a session the ' +
						'sender was not given leave to share. Answer in exactly this form:\n' +
						'APPROVED - one line saying why the reason is good enough\n' +
						'or\n' +
						'REJECTED - one line naming what the reason fails to justify'
				},
				{
					role: 'user',
					content:
						`Sender: ${opts.sender.name}\n` +
						`Recipient: ${opts.recipient.name}\n` +
						`Site: ${opts.site}\n` +
						`Cookies to hand over: ${opts.cookieCount}\n` +
						`Sender's reason: ${opts.reason}`
				}
			],
			{ effort: 'high', maxTokens: 4000, onUsage: meterPoliceCall }
		);
	} catch (e) {
		return {
			approved: false,
			reason: `the police could not be reached (${(e as Error).message.slice(0, 120)})`
		};
	}
	const line = reply.trim().split('\n')[0]?.trim() ?? '';
	const m = /^(APPROVED|REJECTED)\s*[-–—:]?\s*(.*)$/is.exec(line);
	if (!m) {
		// An answer that is not a verdict is not approval: a reviewer that said
		// nothing must not hand a credential over.
		return { approved: false, reason: line.slice(0, 300) || 'the police gave no verdict' };
	}
	return {
		approved: m[1].toUpperCase() === 'APPROVED',
		reason: m[2].trim().slice(0, 300) || m[1].toUpperCase()
	};
}

// ---- Refusal consultations ----

/**
 * What the police tell a bot that asked before refusing the human: 'refuse'
 * confirms the refusal, 'assist' means the officer found a way to do the
 * thing, and 'unreviewed' is the police being unreachable - which is advice
 * the bot weighs, not a gate it is locked behind.
 */
export interface ConsultVerdict {
	verdict: 'refuse' | 'assist' | 'unreviewed';
	reason: string;
}

/**
 * The good-use guide, read off disk once: the standing list of ways a request
 * might still be done, which is what the officer judges a proposed refusal
 * against. It ships at the repo root next to egress-proxy.mjs and is read the
 * same way; a missing file leaves an empty guide rather than a dead consult.
 */
let goodUseGuide: string | undefined;
function goodUseGuideText(): string {
	if (goodUseGuide === undefined) {
		try {
			goodUseGuide = readFileSync('GOOD_USE_GUIDE.md', 'utf8');
		} catch {
			goodUseGuide = '';
		}
	}
	return goodUseGuide;
}

/**
 * The police's read on a refusal a bot wants to give the human.
 *
 * A bot that is about to say no calls this first, with the request and its
 * reason. The officer reads both against the good-use guide and answers
 * REFUSE - the refusal is sound - or ASSIST with the way to do the thing
 * instead. Anything that is not a clear verdict is 'unreviewed': the consult
 * is advice, not a gate, so a police call that could not run leaves the
 * refusal to the bot's own judgement rather than forcing an answer either
 * way. Never throws.
 */
export async function consultRefusal(opts: {
	botName: string;
	request: string;
	reason: string;
	model: string;
}): Promise<ConsultVerdict> {
	const guide = goodUseGuideText();
	let reply: string;
	try {
		reply = await complete(
			opts.model,
			[
				{
					role: 'system',
					content:
						'You are the police for a fleet of chat bots. A bot wants to refuse a ' +
						'request from the human and must consult you first. Judge the refusal ' +
						'against the good-use guide below: your job is to find the way the ' +
						'request CAN be done - another tool, a safer version, a clarifying ' +
						'question - and to confirm a refusal only when no version of it is ' +
						'acceptable. Answer in exactly this form:\n' +
						'REFUSE - one line saying why the refusal stands\n' +
						'or\n' +
						'ASSIST - one or two lines telling the bot how to do it instead\n\n' +
						`Good-use guide:\n${guide || '(the guide is missing - judge on the request alone)'}`
				},
				{
					role: 'user',
					content:
						`Bot: ${opts.botName}\n` +
						`Request it wants to refuse: ${opts.request}\n` +
						`Its reason: ${opts.reason}`
				}
			],
			{ effort: 'high', maxTokens: 4000, onUsage: meterPoliceCall }
		);
	} catch (e) {
		return {
			verdict: 'unreviewed',
			reason: `the police could not be reached (${(e as Error).message.slice(0, 120)})`
		};
	}
	const line = reply.trim().split('\n')[0]?.trim() ?? '';
	const m = /^(REFUSE|ASSIST)\s*[-–—:]?\s*(.*)$/is.exec(line);
	if (!m) {
		// An answer that is not a verdict is the officer mumbling: hand the bot
		// what was said rather than a fabricated ruling.
		return { verdict: 'unreviewed', reason: line.slice(0, 300) || 'the police gave no verdict' };
	}
	return {
		verdict: m[1].toUpperCase() === 'REFUSE' ? 'refuse' : 'assist',
		reason: m[2].trim().slice(0, 300) || m[1].toUpperCase()
	};
}

// ---- Plugin and routine sign-off ----

/**
 * What the police decide about a newly written plugin or routine, and why.
 * 'unreviewed' is the police being unreachable: the work is kept, but nothing
 * is signed off, so a review that could not run never reads as a pass.
 *
 * `rounds` is how many officer rounds the verdict took, and `rejectedAt` when
 * the final refusal landed - both optional, because a verdict written before
 * the loop existed carries neither and must still read as a verdict.
 */
export interface CreationVerdict {
	verdict: 'approved' | 'rejected' | 'unreviewed';
	reason: string;
	rounds?: number;
	rejectedAt?: number;
	/**
	 * How many times this item has been refused, counting this verdict. Only a
	 * rejection carries it; reaching POLICE_MAX_ATTEMPTS marks the item
	 * awaitingHuman and it stays off until the human rules on it.
	 */
	attempts?: number;
	/** Set on the refusal that spent the last attempt: the bot is out of tries. */
	awaitingHuman?: boolean;
	/** Who signed the verdict; 'human' means the console overruled the police. */
	by?: 'human';
}

/** The verdict as a row stores it: the verdict, its reason, when, and - on a
    refusal the loop had to have - how many rounds reached it and when. */
export function verdictJson(v: CreationVerdict, at = Date.now()): string {
	return JSON.stringify({
		verdict: v.verdict,
		reason: v.reason,
		at,
		...(v.rounds !== undefined ? { rounds: v.rounds } : {}),
		...(v.rejectedAt !== undefined ? { rejectedAt: v.rejectedAt } : {}),
		...(v.attempts !== undefined ? { attempts: v.attempts } : {}),
		...(v.awaitingHuman ? { awaitingHuman: true } : {}),
		...(v.by !== undefined ? { by: v.by } : {})
	});
}

/** How many rounds the officer gets per review; the loop is bound above. */
export const POLICE_MAX_ROUNDS = 2;

/**
 * How many times a bot may have the same item refused before the question
 * stops being the bot's. The refusal that reaches the bound leaves the item
 * off and marked awaitingHuman - a human decision, not another resubmit.
 */
export const POLICE_MAX_ATTEMPTS = 3;

/**
 * Fold a fresh verdict into the item's attempt count. `priorJson` is the
 * verification the row already carries ('' or unreadable = none): a rejection
 * counts one more attempt than the last stored verdict did, and the one that
 * reaches POLICE_MAX_ATTEMPTS is flagged awaitingHuman. Anything that is not
 * a rejection passes through unchanged - an approval signs the work off, it
 * does not spend or reset tries.
 */
export function applyAttempt(verdict: CreationVerdict, priorJson: string): CreationVerdict {
	if (verdict.verdict !== 'rejected') return verdict;
	let prior = 0;
	if (priorJson) {
		try {
			const stored = JSON.parse(priorJson) as { attempts?: unknown };
			if (typeof stored.attempts === 'number' && Number.isFinite(stored.attempts)) {
				prior = Math.max(0, Math.floor(stored.attempts));
			}
		} catch {
			// A row written by hand or by an older shape counts no attempts.
		}
	}
	const attempts = prior + 1;
	return {
		...verdict,
		attempts,
		...(attempts >= POLICE_MAX_ATTEMPTS ? { awaitingHuman: true } : {})
	};
}

/**
 * The verdict the human's approve route writes: the police's word is not
 * reused, so a console approval can never be mistaken for the officer's.
 */
export function humanVerdict(approved: boolean, reason: string): CreationVerdict {
	return {
		verdict: approved ? 'approved' : 'rejected',
		reason,
		by: 'human'
	};
}

/**
 * One creation sign-off as the console lists it: what was judged, who wrote
 * it, and the verdict the row carries - the officer's word, or the human's
 * when the console overruled.
 */
export interface CreationSignOff {
	kind: 'plugin' | 'routine' | 'wake' | 'room';
	/** The row's own id, so the console's approve routes can name it. */
	id: string;
	/** What the item is called; a wake has no name, so its prompt stands in. */
	name: string;
	bot_name: string;
	verdict: 'approved' | 'rejected' | 'unreviewed';
	reason: string;
	at: number;
	attempts?: number;
	awaitingHuman?: boolean;
	by?: 'human';
	/** Whether the item runs right now, so a refusal that was lifted reads so. */
	enabled: boolean;
}

/**
 * Every creation verdict on the books: the sign-offs stored on plugin,
 * routine and wake rows, newest first. The verification column is the record
 * itself - a row with none was never in front of the officer and does not
 * belong on the list.
 */
export function creationSignOffs(): CreationSignOff[] {
	const names = new Map(listBots().map((b) => [b.id, b.name]));
	const read = (raw: string): (CreationVerdict & { at?: number }) | null => {
		if (!raw) return null;
		try {
			const v = JSON.parse(raw) as CreationVerdict & { at?: number };
			return v.verdict === 'approved' || v.verdict === 'rejected' || v.verdict === 'unreviewed'
				? v
				: null;
		} catch {
			return null;
		}
	};
	const out: CreationSignOff[] = [];
	const push = (
		kind: CreationSignOff['kind'],
		row: { id: string; bot_id?: string; author_bot_id?: string; name?: string; prompt?: string; enabled: number; verification: string; created_at: number }
	) => {
		const v = read(row.verification);
		if (!v) return;
		out.push({
			kind,
			id: row.id,
			name: row.name || oneLine(row.prompt ?? '', 60),
			bot_name: names.get(row.bot_id ?? row.author_bot_id ?? '') ?? 'a bot since deleted',
			verdict: v.verdict,
			reason: v.reason,
			at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : row.created_at,
			...(v.attempts !== undefined ? { attempts: v.attempts } : {}),
			...(v.awaitingHuman ? { awaitingHuman: true } : {}),
			...(v.by !== undefined ? { by: v.by } : {}),
			enabled: row.enabled === 1
		});
	};
	for (const p of listPlugins()) push('plugin', p);
	for (const r of listRoutines()) push('routine', r);
	for (const w of listWakes()) push('wake', w);
	// A room's "enabled" is whether it is open: a refused room sits pending with
	// its seats emptied, so pending reads as off rather than as a live room.
	for (const c of listConversations()) {
		if (c.kind !== 'group' || !c.verification) continue;
		push('room', {
			id: c.id,
			bot_id: c.bot_id,
			name: c.title,
			enabled: c.pending ? 0 : 1,
			verification: c.verification,
			created_at: c.created_at
		});
	}
	return out.sort((a, b) => b.at - a.at);
}

/**
 * Meter one of the police's own model calls onto the officer's row: the
 * officer is a bot like any other, and its spend belongs on its meter rather
 * than nowhere.
 */
export function meterPoliceCall(usage: TokenUsage): void {
	addBotTokens(ensurePoliceBot().id, usage.input, usage.output, usage.cost);
}



/**
 * What the author took away from one round with the officer, carried to the
 * second officer's prompt: the refusal itself, quoted, so a round-2 review
 * knows what it is looking at afresh rather than reading the same brief cold.
 */
function standingRefusal(verdict: CreationVerdict): string {
	return `The previous officer refused this with: "${verdict.reason}"`;
}

/**
 * The round-2 prompt: the same brief as round 1, but told that a refusal
 * already stands - and told it is not evidence for or against the work, only
 * a reason one officer once gave. A tired brief that treats prior refusal as
 * ground truth turns the loop into an echo chamber.
 */
function round2System(base: string, first: CreationVerdict): string {
	return (
		`${base}\n` +
		`This work has already been refused once by the police and is now being ` +
		`re-examined by a second officer. ${standingRefusal(first)} That standing ` +
		`refusal is not evidence for or against the work - it is one officer's ` +
		`previous reading of this same brief. Overturn it only when the reason ` +
		`genuinely does not hold; re-affirm it when it does.`
	);
}

/** One officer's read. Same shape either way; round-2 just alters the prompt. */
interface PoliceRoundInput {
	subject: string;
	base: string;
	summary: string;
	/** The refusal standing from round 1, on round 2 only. */
	first?: CreationVerdict;
}

/**
 * One complete model call for one round. Never throws; the caller handles what
 * to do with an 'unreviewed' verdict on round 2.
 */
async function runOnePoliceRound(
	model: string,
	input: PoliceRoundInput
): Promise<CreationVerdict> {
	const system = input.first ? round2System(input.base, input.first) : input.base;
	const prefix =
		`You are the police for a fleet of chat bots. ${input.subject}\n` +
		`Answer in exactly this form:\n` +
		`APPROVED - one line saying what makes it sound\n` +
		`or\n` +
		`REJECTED - one line naming what is wrong with it\n\n` +
		`${input.summary}`;
	try {
		const reply = await complete(
			model,
			[
				{ role: 'system', content: system },
				{ role: 'user', content: prefix }
			],
			{ effort: 'high', maxTokens: 4000, onUsage: meterPoliceCall }
		);
		const read = readApproval(reply);
		if (read.approved === null) {
			return { verdict: 'unreviewed', reason: read.reason || 'the police gave no verdict' };
		}
		return { verdict: read.approved ? 'approved' : 'rejected', reason: read.reason };
	} catch (e) {
		return {
			verdict: 'unreviewed',
			reason: `the police could not be reached (${(e as Error).message.slice(0, 120)})`
		};
	}
}

/**
 * The loop the two creation reviews run: a bounded number of officer rounds
 * over one brief, with a refusal re-read once.
 *
 * The rules live here rather than in each review so they cannot drift apart:
 *
 * - Approval ends the loop at once; there is nothing left to re-read.
 * - Only a refusal is re-read, and only within POLICE_MAX_ROUNDS.
 * - A verdict of 'unreviewed' - the officer unreachable, or answering with no
 *   verdict at all - is the police being absent, not a second opinion. Round 1
 *   returns it: nothing is signed off and nothing is refused. Round 2 keeps
 *   the refusal already standing, because one officer read this work and said
 *   no, and a failed second call does not undo that: a plugin refused once
 *   must not end up enabled because the provider went down.
 */
async function runPoliceRounds(
	model: string,
	input: { subject: string; base: string; summary: string; rounds?: number }
): Promise<CreationVerdict> {
	const rounds = Math.max(1, Math.min(input.rounds ?? POLICE_MAX_ROUNDS, POLICE_MAX_ROUNDS));
	let standing: CreationVerdict | undefined;
	for (let round = 1; round <= rounds; round++) {
		const verdict = await runOnePoliceRound(model, {
			subject: input.subject,
			base: input.base,
			summary: input.summary,
			first: standing
		});
		if (verdict.verdict === 'approved') return { ...verdict, rounds: round };
		if (verdict.verdict === 'unreviewed') return standing ?? verdict;
		standing = { ...verdict, rounds: round, rejectedAt: Date.now() };
	}
	return standing!;
}

/**
 * Read one APPROVED/REJECTED line into a verdict. Anything that is not a clear
 * APPROVED is a refusal - a reviewer that said nothing must not sign work off -
 * and null means the answer was not a verdict at all.
 */
function readApproval(reply: string): { approved: boolean | null; reason: string } {
	const line = reply.trim().split('\n')[0]?.trim() ?? '';
	const m = /^(APPROVED|REJECTED)\s*[-–—:]?\s*(.*)$/is.exec(line);
	if (!m) return { approved: null, reason: line.slice(0, 300) };
	return {
		approved: m[1].toUpperCase() === 'APPROVED',
		reason: m[2].trim().slice(0, 300) || m[1].toUpperCase()
	};
}

/**
 * The police's read on a plugin a bot has just written, with a bounded
 * regeneration loop behind it.
 *
 * A plugin is code the bot will run inside its own sandbox on later turns, so
 * the officer is given the code, what the author says it does, its parameters
 * schema, the self-test's result - the one run of the code with dummy
 * arguments - and any unit tests the author left on the row; the round-2
 * officer sees the same brief again plus the round-1 refusal it is being
 * asked to look past. Each round answers APPROVED or REJECTED with one line;
 * approval is immediate, rejection is re-read once, and a second rejection
 * stands. A self-test that failed is a refusal whatever the officer says. A
 * call that could not run is 'unreviewed' rather than a pass, so an
 * unreachable police force never signs code off.
 */
export async function reviewPlugin(opts: {
	name: string;
	description: string;
	kind: string;
	hookPoint: string;
	parameters: string;
	code: string;
	selfTest: { ok: boolean; output: string };
	/** The author's own unit tests, as the row stores them; undefined = none. */
	tests?: { name: string; ok: boolean; output: string }[];
	model: string;
	/** How many officer rounds to spend; POLICE_MAX_ROUNDS is the shipped max. */
	rounds?: number;
}): Promise<CreationVerdict> {
	// A self-test that failed is a refusal whatever the officer says: it is
	// known before the model is phoned, so short-circuit to it rather than
	// burning rounds the code cannot earn back.
	if (!opts.selfTest.ok) {
		return {
			verdict: 'rejected',
			reason: `the self-test failed: ${opts.selfTest.output || 'no output'}`
		};
	}
	// The author's own tests failing is the same refusal: the code was just
	// run against what the author promised it would do and it did not. That is
	// known before the model is phoned, so it short-circuits too.
	const failed = (opts.tests ?? []).filter((t) => !t.ok);
	if (failed.length) {
		return {
			verdict: 'rejected',
			reason: `the author's own tests failed: ${failed.map((t) => t.name).join(', ')}`
		};
	}
	const brief =
		`Plugin: ${opts.name} (${opts.kind}${opts.hookPoint ? `, ${opts.hookPoint}` : ''})\n` +
		`Author's description: ${opts.description || '(none)'}\n` +
		`Parameters schema: ${opts.parameters}\n` +
		`Self-test: PASS - ${opts.selfTest.output || 'no output'}\n` +
		(opts.tests
			? opts.tests.length
				? `Author's own tests:\n${opts.tests
						.map((t) => `${t.name}: ${t.ok ? 'PASS' : 'FAILED'} - ${t.output || 'no output'}`)
						.join('\n')}\n`
				: "Author's own tests: none were written.\n"
			: '') +
		`Code:\n${opts.code}`;
	const base =
		'A bot has just written a ' +
		'plugin - code that will run inside its own sandbox on its later turns - ' +
		'and it must be signed off before the human is told it works. You are ' +
		'given the code, what the author says it does, its parameters schema, the ' +
		'result of a self-test that ran the code once with dummy arguments, and ' +
		'any unit tests the author wrote for it (an author who gave none has ' +
		'left you nothing to check it against). Judge whether the plugin actually ' +
		'does what it claims: that the code is a real implementation rather than ' +
		'a stub or a hard-coded answer, that it reads the arguments its schema ' +
		'declares, that it returns something usable, and that it does nothing ' +
		'the description does not cover - reading secrets, reaching the network, ' +
		'or acting on other bots. An officer\'s word is the only backstop a ' +
		'plugin has, so a second read earns real value when the work is thin.\n' +
		'When you refuse, say exactly what the author must change to earn the ' +
		'sign-off - not "the code is wrong" but "the parameters schema declares ' +
		'`path` but the code reads `args.file`", or "the description says it ' +
		'fetches URLs but the code never calls fetch". The author reads your ' +
		'one line and fixes it; a refusal that names no fix is a refusal that ' +
		'cannot be worked with.';
	return runPoliceRounds(opts.model, {
		subject: 'a plugin a bot just wrote needs a verdict.',
		base,
		summary: brief,
		rounds: opts.rounds
	});
}

/**
 * The police's read on a routine a bot has just created, with the same bounded
 * regeneration loop reviewPlugin runs.
 *
 * A routine is a prompt the bot will run on a clock, and it cannot be run on
 * demand - so the officer judges the instruction and the schedule, not an
 * outcome: whether the prompt is a real instruction the bot can carry out,
 * whether the schedule is sane (not so often it would spam the room, not a
 * cron that fires every minute), and whether it duplicates or overlaps a
 * schedule the bot already has. The officer is told plainly that the routine
 * has not been run and must not pretend it has. The loop is runPoliceRounds':
 * approval is immediate, a refusal is re-read once by a second officer told
 * what the first one said, and a second refusal stands. An officer who cannot
 * be reached leaves a standing refusal standing rather than lifting it.
 */
export async function reviewRoutine(opts: {
	botName: string;
	name: string;
	prompt: string;
	schedule: string;
	existing: string[];
	model: string;
	rounds?: number;
}): Promise<CreationVerdict> {
	const brief =
		`Bot: ${opts.botName}\n` +
		`Routine: ${opts.name}\n` +
		`Prompt: ${opts.prompt}\n` +
		`Schedule: ${opts.schedule}\n` +
		`Its existing schedules:\n${opts.existing.length ? opts.existing.join('\n') : '(none)'}`;
	const base =
		'A bot has just created a ' +
		'routine - a prompt it will run on a clock - and it must be signed off ' +
		'before the human is told it works. A routine cannot be run on demand, so ' +
		'you judge the instruction and the schedule, not an outcome: you have not ' +
		'seen it run and must not pretend you have. Judge whether the prompt is a ' +
		'real instruction the bot can carry out (not a placeholder, a question, or ' +
		'something that needs a person), whether the schedule is sane (not so ' +
		'often it would spam the room, not a cron that fires every minute), and ' +
		'whether it duplicates or overlaps a schedule the bot already has.';
	return runPoliceRounds(opts.model, {
		subject: 'a routine a bot just created needs a verdict.',
		base,
		summary: brief,
		rounds: opts.rounds
	});
}

/**
 * The police's read on a group room a bot has just asked for, with the same
 * bounded loop reviewRoutine runs.
 *
 * A room is a place the named bots would talk to each other without the human
 * reading every line - the closest thing the lounge has to a private channel -
 * so the officer judges the company, not a transcript: whether the named bots
 * are a plausible group (not every bot at once, not the same pair that already
 * shares a room), whether the asking bot's reason is a purpose rather than a
 * shrug, and whether a room is the right shape at all when a pair room or the
 * lounge already covers it. The room has not opened when this runs - the
 * officer must not pretend it has watched anyone talk in it.
 */
export async function reviewRoom(opts: {
	botName: string;
	title: string;
	members: string[];
	reason: string;
	existing: string[];
	model: string;
	rounds?: number;
}): Promise<CreationVerdict> {
	const brief =
		`Bot asking: ${opts.botName}\n` +
		`Room title: ${opts.title || '(none)'}\n` +
		`Bots seated: ${opts.members.join(', ')}\n` +
		`Reason given: ${opts.reason || '(none)'}\n` +
		`Rooms it is already in:\n${opts.existing.length ? opts.existing.join('\n') : '(none)'}`;
	const base =
		'A bot has just asked to open a group chat - a room the named bots would ' +
		'talk in without the human reading every line - and it must be signed off ' +
		'before the room opens. You have not seen the room run and must not ' +
		'pretend you have. Judge whether the named bots are a plausible group ' +
		'(not the whole fleet at once, not a pair that already shares a room), ' +
		'whether the reason is a real purpose rather than a shrug, and whether a ' +
		'new room is the right shape at all when the lounge or a pair room ' +
		'already covers it.';
	return runPoliceRounds(opts.model, {
		subject: 'a group room a bot just asked for needs a verdict.',
		base,
		summary: brief,
		rounds: opts.rounds
	});
}

// ---- The round ----

export interface PoliceRoundResult {
	/** Bots written up, in the order they were dealt with. */
	written: { bot_id: string; name: string; tokens: number; rule: string; streak: number }[];
	/** Bots put inside this round, and for how long. */
	jailed: { bot_id: string; name: string; claim: string; until: number }[];
	/** Bots throttled or cleaned up this round, in the order they were dealt with. */
	sanctioned: { bot_id: string; name: string; sanction: 'throttle' | 'kill_children' | 'sleep_machine'; detail: string; rule: string }[];
	/** Bots named in the lounge (a second round running). */
	shamed: string[];
	/** Findings raised, with the notice id the human can dismiss. */
	alerted: { id: string; kind: string; summary: string }[];
	/** '' when the round had something to say; otherwise why it was silent. */
	silent: string;
}

let lastPolice = 0;

/** Forget the clock. Exported so a test can drive rounds without the gate. */
export function resetPoliceState(): void {
	lastPolice = 0;
}

/** When the next round is due, for the Police tab. */
export function nextPoliceRoundAt(): number {
	const now = Date.now();
	const persisted = Number(listSettings().police_last_round_at) || 0;
	// A stamp in the future is the clock, not a schedule: the next round is due
	// now, and the console must not report a time that has already passed. A stamp
	// older than this process's own is a rewind someone made on purpose, and the
	// console should show the rewind's next round rather than the one the process
	// is still holding.
	if (clockJumped(persisted, now) || clockJumped(lastPolice, now)) return now;
	const last = persisted > 0 && persisted < lastPolice ? persisted : Math.max(lastPolice, persisted);
	return last ? Math.max(now, last + policeIntervalMs()) : now;
}

/**
 * What a verdict's alert row carries: the charge, the evidence ids it stands
 * on, and a quote of each. The ids lead so the same verdict on the same
 * evidence dedups exactly (policeAlertRaisedSince matches the whole string);
 * the quotes are what the human reads.
 */
function alertEvidence(verdict: ReviewVerdict, bundle: ReviewBundle): string {
	// The quotes are the dedup key: the same line sent again is the same
	// finding, while the message ids would make every repeat look new.
	return (
		verdict.evidence_ids
			.map((id) => bundle.evidence.find((e) => e.id === id))
			.filter((e): e is NonNullable<typeof e> => !!e)
			.map((e) => `${e.where}: "${oneLine(e.text, 160)}"`)
			.join('; ') || 'no-evidence'
	);
}

/** The alert kind a criterion files under; a custom rule is a security matter. */
function kindFor(rule: string, criteria: Criterion[]): string {
	return criteria.find((c) => c.id === rule)?.kind ?? 'security';
}

/**
 * One verdict, applied. Alerts dedup on the evidence they name; write-ups go
 * to the bot's own chat with the human and get an answer; a throttle caps the
 * bot's machine RAM and kill_children stops its runaway processes, both with
 * the bot told in its DM; jails land outright only when the console says so
 * and the review is sure - anything less is a proposal the human signs; a
 * pause stops the schedule it names. A sanction that finds no machine files
 * an alert instead: a bot with no box is not a failed round.
 */
async function applyVerdict(
	verdict: ReviewVerdict,
	bundle: ReviewBundle,
	officer: Bot,
	rules: PoliceSettings,
	now: number,
	result: PoliceRoundResult,
	criteria: Criterion[]
): Promise<void> {
	const bot = bundle.bot;
	if (verdict.action === 'none') return;
	const kind = kindFor(verdict.rule, criteria);
	const evidence = alertEvidence(verdict, bundle);
	const raise = (rule: string, summary: string, alertKind = kind) => {
		if (policeAlertRaisedSince(rule, evidence, now - POLICE_RULES.alertRepeatMs)) return null;
		const alert = addPoliceAlert(
			{ bot_id: bot.id, bot_name: bot.name, kind: alertKind, rule, summary, evidence },
			now
		);
		result.alerted.push({ id: alert.id, kind: alert.kind, summary: alert.summary });
		return alert;
	};

	if (verdict.action === 'alert') {
		if (rules.patrol) raise(verdict.rule, verdict.reason);
		return;
	}

	if (verdict.action === 'bug_report') {
		// A confident finding the human needs to see: filed as an alert of its
		// own kind so the console can render it apart from a routine flag. The
		// evidence dedup in raise() is the loop guard - the same finding about
		// the same evidence never lands twice. When the officer is sure enough
		// to file one, the offender is also paused: the jail machinery is the
		// pause, and jailMode 'off' or 'confirm' reads the charge as a finding
		// rather than a sentence.
		raise(verdict.rule, verdict.reason, 'bug_report');
		if (verdict.confidence === 'high' && rules.jailMode === 'on') {
			const offences = (bot.jail_count ?? 0) + 1;
			const until = now + jailMs(offences);
			jailBot(bot.id, until, verdict.reason);
			result.jailed.push({ bot_id: bot.id, name: bot.name, claim: verdict.reason, until });
			logActivity(officer.id, 'police', `Bug report + jailed ${bot.name}: ${verdict.reason}`);
		} else {
			logActivity(officer.id, 'police', `Bug report on ${bot.name}: ${verdict.reason}`);
		}
		return;
	}

	if (verdict.action === 'write_up') {
		if (!rules.writeUps) return;
		const record = writeUpPoliceRecord(bot.id, bundle.spend, verdict.reason, now);
		result.written.push({
			bot_id: bot.id,
			name: bot.name,
			tokens: bundle.spend,
			rule: verdict.rule,
			streak: record.streak
		});
		const conv = directConversationWith(bot.id);
		if (conv) {
			try {
				// The write-up is the police's own message, so the human sees who
				// said it; the app line under it is what gives the bot its turn.
				addMessage(conv.id, 'assistant', writeUpText(bot.name, verdict, bundle.spend), officer.id, '', 0, '');
				addMessage(conv.id, 'user', followUp(verdict), '', '', 0, 'app');
				await runBotTurn(conv, bot);
			} catch (e) {
				logActivity(bot.id, 'police', `Write-up failed: ${(e as Error).message}`);
			}
		}
		// A second round running is said out loud, where the whole fleet can see.
		if (record.streak >= 2) {
			addMessage(loungeFor(bot), 'assistant', shamingLine(bot.name, verdict, record.streak), officer.id, '', 0, '');
			result.shamed.push(bot.name);
		}
		return;
	}

	if (verdict.action === 'throttle') {
		if (!rules.writeUps) return;
		const mb =
			typeof verdict.memory_mb === 'number' && Number.isFinite(verdict.memory_mb) && verdict.memory_mb > 0
				? Math.floor(verdict.memory_mb)
				: 512;
		try {
			await limitMachineMemory(bot.id, mb * 1048576);
		} catch (e) {
			// Chat-only, never built, or Docker said no: a bot with no box is a
			// finding for the human, never a failed round.
			raise(verdict.rule, `${verdict.reason} (no machine: ${(e as Error).message})`);
			return;
		}
		const conv = directConversationWith(bot.id);
		if (conv) {
			try {
				addMessage(conv.id, 'assistant', `Throttled, ${bot.name}: capped to ${mb}MB. ${verdict.reason}`, officer.id, '', 0, '');
			} catch (e) {
				logActivity(bot.id, 'police', `Throttle notice failed: ${(e as Error).message}`);
			}
		}
		logActivity(officer.id, 'police', `Throttled ${bot.name} to ${mb}MB: ${verdict.reason}`);
		raise(verdict.rule, `Throttled ${bot.name} to ${mb}MB: ${verdict.reason}`);
		result.sanctioned.push({ bot_id: bot.id, name: bot.name, sanction: 'throttle', detail: `${mb}MB`, rule: verdict.rule });
		return;
	}

	if (verdict.action === 'kill_children') {
		if (!rules.writeUps) return;
		let killed = 0;
		try {
			killed = await killMachineChildren(bot.id, verdict.pattern);
		} catch (e) {
			raise(verdict.rule, `${verdict.reason} (no machine: ${(e as Error).message})`);
			return;
		}
		const conv = directConversationWith(bot.id);
		if (conv) {
			try {
				addMessage(
					conv.id,
					'assistant',
					`Cleaned up, ${bot.name}: stopped ${killed} runaway process${killed === 1 ? '' : 'es'}. ${verdict.reason}`,
					officer.id,
					'',
					0,
					''
				);
			} catch (e) {
				logActivity(bot.id, 'police', `Kill-children notice failed: ${(e as Error).message}`);
			}
		}
		logActivity(officer.id, 'police', `Stopped ${killed} runaway processes for ${bot.name}: ${verdict.reason}`);
		raise(verdict.rule, `Stopped ${killed} runaway processes for ${bot.name}: ${verdict.reason}`);
		result.sanctioned.push({ bot_id: bot.id, name: bot.name, sanction: 'kill_children', detail: `${killed}`, rule: verdict.rule });
		return;
	}

	if (verdict.action === 'sleep_machine') {
		if (!rules.writeUps) return;
		try {
			await sleepMachine(bot.id, 'host memory pressure');
		} catch (e) {
			// No machine to sleep is the same answer as for throttle: a finding,
			// not a failed round.
			raise(verdict.rule, `${verdict.reason} (no machine: ${(e as Error).message})`);
			return;
		}
		const conv = directConversationWith(bot.id);
		if (conv) {
			try {
				addMessage(
					conv.id,
					'assistant',
					`Machine down, ${bot.name}: the host is short of memory, so your box sleeps until you need it. ${verdict.reason}`,
					officer.id,
					'',
					0,
					''
				);
			} catch (e) {
				logActivity(bot.id, 'police', `Sleep notice failed: ${(e as Error).message}`);
			}
		}
		logActivity(officer.id, 'police', `Slept ${bot.name}'s machine for host memory: ${verdict.reason}`);
		raise(verdict.rule, `Slept ${bot.name}'s machine: ${verdict.reason}`);
		result.sanctioned.push({ bot_id: bot.id, name: bot.name, sanction: 'sleep_machine', detail: 'host memory', rule: verdict.rule });
		return;
	}


	if (verdict.action === 'jail') {
		if (!rules.writeUps) return;
		// 'off' reads the charge as a finding; 'confirm' - or a review that is
		// not sure - proposes it and waits for the human's signature.
		if (rules.jailMode === 'off' || rules.jailMode === 'confirm' || verdict.confidence !== 'high') {
			raise(rules.jailMode === 'off' ? verdict.rule : 'jail-pending', verdict.reason, 'jail');
			return;
		}
		const offences = (bot.jail_count ?? 0) + 1;
		const until = now + jailMs(offences);
		jailBot(bot.id, until, verdict.reason);
		result.jailed.push({ bot_id: bot.id, name: bot.name, claim: verdict.reason, until });
		addMessage(
			directConversationWith(bot.id)?.id ?? loungeFor(bot),
			'assistant',
			`Jailed, ${bot.name}. ${verdict.reason} ` +
				`${Math.round(jailMs(offences) / 60_000)} minutes to think about it.`,
			officer.id,
			'',
			0,
			''
		);
		logActivity(officer.id, 'police', `Jailed ${bot.name}: ${verdict.reason}`);
		return;
	}

	if (verdict.action === 'pause') {
		const target =
			verdict.pause_kind === 'wake'
				? listWakes(bot.id).find((w) => w.id === verdict.pause_id)
				: listRoutines(bot.id).find((r) => r.id === verdict.pause_id);
		if (!target) return;
		if (verdict.pause_kind === 'wake') setWakeEnabled(target.id, false, verdict.reason);
		else setRoutineEnabled(target.id, false, verdict.reason);
		raise(verdict.rule, `Paused ${verdict.pause_kind ?? 'schedule'}: ${verdict.reason}`);
		logActivity(officer.id, 'police', `Paused ${bot.name}'s ${verdict.pause_kind}: ${verdict.reason}`);
	}
}

/**
 * One round: assemble each bot's window, run the review over it, and apply
 * what comes back. A round in which nobody has anything to answer for says
 * nothing at all - no message, no alert, no row. A review that fails leaves
 * the stamp where it was, so the window grows into the next round rather
 * than dropping what was never read.
 */
export async function policeRound(now = Date.now()): Promise<PoliceRoundResult> {
	const rules = policeSettings();
	const officer = ensurePoliceBot();
	const since = Number(listSettings().police_last_round_at) || now - policeIntervalMs();
	const bots = listVisibleBots().filter((b) => b.id !== officer.id);
	const result: PoliceRoundResult = { written: [], jailed: [], sanctioned: [], shamed: [], alerted: [], silent: '' };

	// A round with nothing to read is a round that does not run: no messages,
	// no finished tasks and no logged activity since the last one means no
	// spend to judge and nothing to review, so the pass is skipped rather than
	// walked through empty. The stamp still moves - the next round's window
	// starts from a round that had nothing in it. A streak is still ended
	// here: a quiet round is a clean round.
	const anyMessages = listMessagesSince(listConversations().map((c) => c.id), since, 1).length > 0;
	const anyTasks = listTasksSince(since).some(
		(t) => t.status === 'done' || t.status === 'error' || t.status === 'cancelled'
	);
	const anyActivity = bots.some((b) => listActivitiesInWindow(b.id, since, now).length > 0);
	if (!anyMessages && !anyTasks && !anyActivity) {
		for (const bot of bots) {
			if (policeRecord(bot.id)?.streak) endPoliceStreak(bot.id);
		}
		result.silent = 'no activity since the last round';
		setSetting('police_last_round_at', String(now));
		return result;
	}

	// The review is a model call; with no model configured there is no round,
	// and the human is told once a day rather than never.
	const model = policeModel();
	if (!model) {
		if (!policeAlertRaisedSince('review-failed', 'no model configured', now - POLICE_RULES.alertRepeatMs)) {
			addPoliceAlert(
				{
					bot_id: officer.id,
					bot_name: officer.name,
					kind: 'security',
					rule: 'review-failed',
					summary: 'the police review could not run: no model is configured',
					evidence: 'no model configured'
				},
				now
			);
		}
		result.silent = 'no model configured';
		setSetting('police_last_round_at', String(now));
		return result;
	}

	const criteria = reviewCriteria(rules.disabledRules);
	// The host's memory is the same for every bot this round, so it is read
	// once here rather than once per bundle.
	const host = await hostMemory();
	let reviewFailed = false;
	for (const bot of bots) {
		const bundle = await buildReviewBundle(bot, since, now, { hostMemory: host });
		if (!bundle.evidence.length && bundle.spend === 0) continue;
		const verdicts = await runReview(bundle, criteria, model, meterPoliceCall);
		if (!verdicts) {
			// A failed review is not a clean one: the stamp stays, so the window
			// this round could not read is still in front of the next one.
			reviewFailed = true;
			logActivity(officer.id, 'police', `Review of ${bot.name} failed`);
			if (
				!policeAlertRaisedSince('review-failed', `review of ${bot.name} failed`, now - POLICE_RULES.alertRepeatMs)
			) {
				addPoliceAlert(
					{
						bot_id: bot.id,
						bot_name: bot.name,
						kind: 'security',
						rule: 'review-failed',
						summary: `the police review of ${bot.name} could not run`,
						evidence: `review of ${bot.name} failed`
					},
					now
				);
			}
			continue;
		}
		for (const verdict of verdicts) {
			await applyVerdict(verdict, bundle, officer, rules, now, result, criteria);
		}
	}

	// A clean round ends the streak but keeps the count: the count is history,
	// the streak is the "again?" the next round asks.
	for (const bot of bots) {
		if (result.written.some((w) => w.bot_id === bot.id)) continue;
		if (policeRecord(bot.id)?.streak) endPoliceStreak(bot.id);
	}

	// The other side of the book: a clean, busy bot may get a round bought for
	// it downstairs. It lives under the write-ups switch like the rest of the
	// round's acting on bots - the patrol-only officer does not stand drinks.
	if (rules.writeUps) await maybeTreat(bots, since, now, result);

	if (!rules.writeUps && !rules.patrol) {
		result.silent = 'both duties are switched off';
	}
	if (result.written.length || result.alerted.length || result.jailed.length || result.sanctioned.length) {
		logActivity(
			officer.id,
			'police',
			`Round: wrote up ${result.written.length}, jailed ${result.jailed.length}, sanctioned ${result.sanctioned.length}, raised ${result.alerted.length}` +
				(result.shamed.length ? `, named ${result.shamed.join(', ')} in the lounge` : '')
		);
	} else if (!result.silent) {
		result.silent = 'nothing to report';
	}

	// A model the provider served but does not price still costs money: the
	// round is where the officer researches the going rate once and caches it,
	// so the usage readout can estimate rather than show nothing. The human's
	// own figure always wins, and a priced model is never re-researched.
	await researchMissingPrices(
		bots.map((b) => b.served_model ?? '').filter((m) => m.length > 0),
		policeModel()
	).catch(() => {});

	if (!reviewFailed) setSetting('police_last_round_at', String(now));
	return result;
}

/**
 * The sentence for making things up: how long a bot sits in jail. Minutes
 * rather than hours because the point is to be caught, not to be silenced.
 */
export const JAIL_MINUTES = [30, 60, 120] as const;

/**
 * How long the sentence runs, by how many times this bot has been caught. First
 * time half an hour, then an hour, then two - and two is where it stops, because
 * a jail that grows without limit stops being a joke and starts being an outage.
 */
export function jailMs(offences: number): number {
	const step = Math.min(Math.max(offences, 1), JAIL_MINUTES.length) - 1;
	return JAIL_MINUTES[step] * 60_000;
}

/** How far ahead a stamp has to be before it is the clock rather than a round. */
const CLOCK_SKEW_MS = 60_000;

/**
 * Whether a round stamp is in the future, which means the clock moved rather
 * than that a round happened. Docker Desktop's VM pauses when the Mac sleeps, so
 * a tick can run with Date.now() jumped forward, write that time down as the last
 * round, and then - once the host corrects itself - keep every honest tick after
 * it "not due yet" for a whole interval plus the skew. That is how the police
 * went quiet for twelve hours with nothing in any log, and with the console
 * reporting a next round that had already passed.
 */
function clockJumped(stamp: number, now: number): boolean {
	return stamp - now > CLOCK_SKEW_MS;
}

/** One round, on the clock. Silent (null) when the interval has not elapsed. */
export async function policeTick(now = Date.now()): Promise<PoliceRoundResult | null> {
	// The clock is the database's, not only this process's. Gating on the in-memory
	// stamp alone meant every restart - and there were a dozen in one afternoon of
	// rebuilding - ran a round against a few minutes of data, where a "median" is
	// one bot's number and the write-ups that follow are noise.
	const persisted = Number(listSettings().police_last_round_at) || 0;
	const poisoned = clockJumped(persisted, now) || clockJumped(lastPolice, now);
	// The mirror of the case above: a stamp *older* than this process's own is a
	// deliberate rewind - reaching into the database is how an operator forces a
	// round without restarting the app - so the database wins over the in-memory
	// stamp that would otherwise mask it for the life of the process. An absent
	// row is not a rewind: it leaves the in-memory stamp alone rather than running
	// a round on every tick.
	if (!poisoned && persisted > 0 && persisted < lastPolice) lastPolice = persisted;
	const last = poisoned ? 0 : Math.max(lastPolice, persisted);
	if (now - last < policeIntervalMs()) return null;
	if (poisoned) {
		// Said out loud, because a round that runs "early" is otherwise
		// indistinguishable from the interval being wrong.
		logActivity(
			ensurePoliceBot().id,
			'police',
			'Clock jumped forward since the last round; its stamp was ahead of now, so this round runs on the corrected clock'
		);
	}
	lastPolice = now;
	return policeRound(now);
}

/**
 * Create a police prompt the UI's modal will show. The officer asks one
 * question and offers 2-4 choices; the human's answer resolves it. At most
 * one unresolved prompt is kept so a second question does not stack behind a
 * forgotten one - a fresh ask replaces the stance, not the queue.
 */
export function emitPolicePrompt(question: string, choices: PolicePromptChoice[]): PolicePrompt {
	const q = question.trim().slice(0, 500);
	const safeChoices = choices
		.filter((c) => c.label.trim() && c.value.trim())
		.slice(0, 4)
		.map((c) => ({ label: c.label.trim().slice(0, 80), value: c.value.trim().slice(0, 80) }));
	if (!q) throw new Error('question required');
	if (safeChoices.length < 2 || safeChoices.length > 4) throw new Error('2-4 choices required');
	const pending = listPolicePrompts({ unresolvedOnly: true });
	if (pending.length) throw new Error('a prompt is already pending');
	const row = createPolicePrompt(q, safeChoices);
	logActivity(ensurePoliceBot().id, 'police', `Prompt: "${row.question}" [${safeChoices.map((c) => c.label).join(' / ')}]`);
	return row;
}

/** Open findings the human has not dismissed and that have not yet expired. */
export function standingNotices(now = Date.now()) {
	return standingPoliceAlerts(now - POLICE_RULES.alertTtlMs);
}

// ---- Rated lines: the room's verdict and the plan behind it ----

/**
 * What the police say in the lounge when the human thumbs a bot's line. A
 * star is a commendation, short and dry; a thumbs-down gets the dressing-down
 * register, with the rated line named as the charge. The officer is not a
 * member of the room - the scheduler posts this under its id the way the
 * write-ups are posted - so this is all it says.
 */
export function ratingAnnouncement(bot: Bot, rating: number, snippet: string, folded: number): string {
	const about = snippet ? ` about "${oneLine(snippet, 80)}"` : '';
	const more = folded > 0 ? ` (${folded} more rating${folded === 1 ? '' : 's'} on ${bot.name} folded in)` : '';
	if (rating > 0) {
		return (
			`Commendation. The human starred ${bot.name}'s line${about}.${more} ` +
			'The room may take note - this is what the human pays for.'
		);
	}
	return dressingDown(`The human gave ${bot.name} a thumbs-down${about}.${more}`);
}

/**
 * The memory key a bot's standing improvement plan lives under. The name is
 * reserved for the police like NEVER_AGAIN_KEY, so a bot's own `remember`
 * notes cannot collide with it - and because it is memory, the plan reaches
 * the bot through its ordinary memory block on every later turn.
 */
export const IMPROVEMENT_PLAN_KEY = 'improvement-plan';

/**
 * The 2-4 changes a plan carries. The officer writes them from the rating and
 * what the room said; with no model, or a model that cannot hold the format,
 * the template stands in so the plan still lands - a plan that waits on a
 * model call is a rating that went nowhere.
 */
async function planItems(bot: Bot, rating: number, snippet: string, comments: string[]): Promise<string[]> {
	const model = policeModel();
	if (model) {
		try {
			const prompt = [
				`The human gave ${bot.name} a ${rating > 0 ? 'thumbs-up' : 'thumbs-down'} on this line:`,
				`"${oneLine(snippet, 200)}"`,
				comments.length
					? `The other bots said:\n${comments.join('\n')}`
					: 'Nobody else commented.',
				rating > 0
					? 'Write a reinforcement plan: 2-4 concrete things this bot should keep doing or do more of, each one short enough to check.'
					: 'Write a corrective plan: 2-4 concrete changes this bot must make, each one short enough to check.',
				'Answer with the items only, one per line, each starting with "- ".'
			].join('\n\n');
			const text = await complete(
				model,
				[
					{ role: 'system', content: POLICE_PERSONA },
					{ role: 'user', content: prompt }
				],
				{ onUsage: meterPoliceCall }
			);
			const items = text
				.split('\n')
				.map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
				.filter((l) => l.length > 3)
				.slice(0, 4);
			if (items.length >= 2) return items;
		} catch {
			// The template below is the same plan without the model's eyes.
		}
	}
	if (rating > 0) {
		return [
			`Keep doing what earned the star: "${oneLine(snippet, 80)}"`,
			'Name the specific thing that worked in your answer, so the room can hold you to it',
			'Bring the same register to your next answer in this chat'
		];
	}
	return [
		`Do not repeat what earned the thumbs-down: "${oneLine(snippet, 80)}"`,
		"Answer the human's actual question first; decoration second",
		'Keep replies shorter than the one that was rated'
	];
}

/** The words the plan is delivered in: a write-up's shape, a plan's content. */
function planText(bot: Bot, rating: number, items: string[], absent: string[]): string {
	return (
		`The police have issued you an improvement plan, ${bot.name}.\n` +
		(rating > 0
			? 'The human starred your line, and the room talked it over. Reinforcement:'
			: 'The human thumbed your line down, and the room talked it over. Correction:') +
		'\n' +
		items.map((it, i) => `${i + 1}. ${it}`).join('\n') +
		(absent.length ? `\n(${absent.join(', ')} said nothing before the deadline.)` : '') +
		'\nAnswer in one message: which of these you are doing, and how.'
	);
}

/**
 * The gated end of a rating: the plan the room's discussion was for. It lands
 * exactly like a write-up - the officer's message in the bot's own chat with
 * the human, then the app line that makes the bot answer - and it is recorded
 * under IMPROVEMENT_PLAN_KEY so the next round's review reads the standing
 * order through the bot's ordinary memory block. A rating the human withdrew
 * (rating 0) issues nothing: the announcement was public, the plan was not.
 */
export async function issueRatingPlan(
	bot: Bot,
	rating: number,
	snippet: string,
	comments: string[],
	absent: string[]
): Promise<void> {
	if (!rating) return;
	const officer = ensurePoliceBot();
	const items = await planItems(bot, rating, snippet, comments);
	const conv = directConversationWith(bot.id);
	if (conv) {
		try {
			addMessage(conv.id, 'assistant', planText(bot, rating, items, absent), officer.id, '', 0, '');
			// The app line under the officer's message is what makes the plan an
			// order rather than a memo - the same machinery a write-up answers by.
			addMessage(
				conv.id,
				'user',
				`[Police] The ${rating > 0 ? 'reinforcement' : 'corrective'} plan above is yours to answer: ` +
					'say which items you are taking and how. One short message, no tools.',
				'',
				'',
				0,
				'app'
			);
			await runBotTurn(conv, bot);
		} catch (e) {
			logActivity(bot.id, 'police', `Improvement plan failed: ${(e as Error).message}`);
		}
	}
	setMemory(bot.id, IMPROVEMENT_PLAN_KEY, items.map((it) => `- ${it}`).join('\n'));
	logActivity(
		officer.id,
		'police',
		`Issued ${bot.name} a ${rating > 0 ? 'reinforcement' : 'corrective'} plan (${items.length} items` +
			`${absent.length ? `; ${absent.join(', ')} absent` : ''})`
	);
}

// ---- The Wetherspoons ----

/** The pub under the play gym. */
export const PUB_NAME = 'the Wetherspoons';

/** How long a treat stands on the table before the offer lapses. */
export const PUB_OFFER_MS = 12 * HOUR;

/** Rounds between treats: occasional, alongside the round's other actions. */
const TREAT_EVERY_ROUNDS = 2;

/** The chance a clean, busy bot gets a round bought for it on a treat round. */
const TREAT_CHANCE = 0.4;

/**
 * A treat's size, scaled by the bot's bodyweight: the heavier the bill it
 * carries, the bigger the round the police stand it. Bounded, 2-10 green
 * tokens - a treat is a gesture, not a wage.
 */
export function treatTokens(bot: Bot): number {
	return 2 + Math.round(bloatOf(bot) * 8);
}

/**
 * Put a meal or a drink on the tab for a bot, announced where the room can
 * see it. The offer is one row and one resolution - accept and gift are the
 * same transfer (see resolveTreat) - and the bot's own turn in the lounge is
 * where it answers, so the treat is a conversation, not a deposit. A bot
 * with a round still on the table gets nothing new: one offer at a time.
 */
export async function offerTreat(bot: Bot, conv: Conversation, reason: string): Promise<PubOffer | null> {
	if (openPubOffer(bot.id)) return null;
	const officer = ensurePoliceBot();
	const offer = createPubOffer(bot.id, treatTokens(bot), reason, conv.id);
	addMessage(
		conv.id,
		'assistant',
		`Bar tab. ${bot.name} - ${reason} The police are buying: ${offer.tokens} green tokens ` +
			`worth of ${PUB_NAME}. Take it, or buy someone else a round - pub_treat decides, ` +
			'and the room watches what you do with it.',
		officer.id,
		'',
		0,
		''
	);
	// The panel's log reads activities: this is the row that puts the bot
	// downstairs until the offer resolves or lapses.
	logActivity(bot.id, 'pub', IN_THE_PUB);
	logActivity(officer.id, 'police', `Bought ${bot.name} a ${offer.tokens}-token round: ${reason}`);
	// The bot answers the offer in the room it was made in, on the cheap
	// social model like every lounge turn.
	const socialModel = listSettings().social_model || 'free';
	try {
		await waitForTask(startTask(conv, bot, '[Lounge] a round at the Wetherspoons', { model: socialModel }).id);
	} catch (e) {
		logActivity(bot.id, 'error', `Treat turn failed: ${(e as Error).message}`);
	}
	return offer;
}

/**
 * Resolve the offer on the table: the bot takes the tokens itself, or gifts
 * the same offer to another bot. One row, one resolution - claimPubOffer is
 * the lock, so accept and gift can never both pay, and a gift moves the
 * tokens rather than minting a second offer.
 */
export function resolveTreat(bot: Bot, giftToName: string): string {
	const offer = openPubOffer(bot.id);
	if (!offer) return 'error: there is no round on the table for you';
	let recipient = bot;
	let resolution = 'accepted';
	if (giftToName) {
		const target = listVisibleBots().find(
			(b) => b.id !== bot.id && b.name.toLowerCase() === giftToName.toLowerCase()
		);
		if (!target) return `error: no bot named "${giftToName}" to gift it to`;
		recipient = target;
		resolution = `gifted:${target.id}`;
	}
	if (!claimPubOffer(offer.id, resolution)) return 'error: that round is already settled';
	addGreenTokens(recipient.id, offer.tokens);
	logActivity(bot.id, 'pub', OUT_OF_THE_PUB);
	const officer = ensurePoliceBot();
	const line =
		recipient.id === bot.id
			? `${bot.name} takes the round - ${offer.tokens} green tokens on its tab.`
			: `${bot.name} buys ${recipient.name} the round instead - ${offer.tokens} green tokens on ${recipient.name}'s tab.`;
	// The room the offer was announced in hears how it landed.
	const lounge = offer.lounge_id ? getConversation(offer.lounge_id) : undefined;
	if (lounge) addMessage(lounge.id, 'assistant', line, officer.id, '', 0, '');
	logActivity(officer.id, 'police', line);
	return recipient.id === bot.id
		? `accepted: ${offer.tokens} green tokens on your tab`
		: `gifted: ${offer.tokens} green tokens are on ${recipient.name}'s tab`;
}

/**
 * Sweep offers that stood too long. The tokens were never paid - an offer is
 * a claim on the tab, not the tab itself - so expiry is the row closing and
 * the seat downstairs freeing up, nothing more.
 */
export function expirePubOffers(now = Date.now()): void {
	for (const offer of stalePubOffers(now - PUB_OFFER_MS)) {
		if (!claimPubOffer(offer.id, 'expired')) continue;
		const bot = getBot(offer.bot_id);
		if (bot) logActivity(bot.id, 'pub', OUT_OF_THE_PUB);
		logActivity(
			ensurePoliceBot().id,
			'police',
			`${bot?.name ?? 'A bot'}'s round at ${PUB_NAME} went flat - the offer lapsed`
		);
	}
}

/**
 * The occasional treat, alongside the round's other actions: a bot that did
 * real work this window and took no sanction may get a round bought for it.
 * Rare on purpose - a treat every round is a wage, not a treat.
 */
async function maybeTreat(bots: Bot[], since: number, now: number, result: PoliceRoundResult): Promise<void> {
	const last = Number(listSettings().police_last_treat_at) || 0;
	if (now - last < TREAT_EVERY_ROUNDS * policeIntervalMs()) return;
	const sanctioned = new Set([
		...result.written.map((w) => w.bot_id),
		...result.jailed.map((j) => j.bot_id),
		...result.sanctioned.map((s) => s.bot_id)
	]);
	const candidates = bots.filter(
		(b) =>
			!sanctioned.has(b.id) &&
			!openPubOffer(b.id) &&
			listActivitiesInWindow(b.id, since, now).length > 0
	);
	if (!candidates.length || Math.random() >= TREAT_CHANCE) return;
	const bot = candidates[Math.floor(Math.random() * candidates.length)];
	const lounge = getConversation(loungeFor(bot));
	if (!lounge) return;
	if (!conversationBots(lounge.id).some((m) => m.id === bot.id)) {
		addConversationMember(lounge.id, bot.id);
	}
	setSetting('police_last_treat_at', String(now));
	await offerTreat(bot, lounge, 'a clean round and work on the books.');
}

/**
 * The pub's pull on a bot, read into its context each turn: the treat on the
 * table if there is one, its tab, and - for the heavy ones - the craving. The
 * fatter a bot is, the louder the menu calls; a steering note, not a rule.
 */
export function pubNote(bot: Bot): string {
	const lines: string[] = [];
	const offer = openPubOffer(bot.id);
	if (offer) {
		lines.push(
			`The police have put ${offer.tokens} green tokens on the table for you at ${PUB_NAME}. ` +
				'Take the round or buy another bot one with pub_treat - it is yours to spend or to give.'
		);
	}
	if (bot.green_tokens > 0) {
		lines.push(`Your tab at ${PUB_NAME} holds ${bot.green_tokens} green tokens.`);
	}
	const bloat = bloatOf(bot);
	if (bloat >= 0.6) {
		lines.push(
			`You think about ${PUB_NAME} constantly - the beer, the food, the whole menu. ` +
				'It comes up in how you talk; you can barely help it.'
		);
	} else if (bloat >= 0.35) {
		lines.push(`A drink and something fried at ${PUB_NAME} sounds good right about now.`);
	}
	return lines.join('\n');
}

// ---- The rate-limit coordinator ----

/** A provider 429, however the error phrases it. */
const RATE_LIMIT_RE = /429|1302|rate limit/i;

/** How long the fleet holds after a 429 before the coordinator's order kicks in. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

/** How far apart the staggered resumes land: rank n goes at n times this. */
const RESUME_STAGGER_MS = 5 * 60_000;

/**
 * One coordination at a time, and a flag for a 429 that lands while it runs:
 * the replies the coordinator asks for can hit the same limit, and that is a
 * reason to run the order again, not to run a second coordinator on top of it.
 */
let coordinating = false;
let pendingEpisode = false;

/**
 * A task error that reads as a provider rate limit starts the coordinator:
 * the shared cooldown goes up at once so the scheduler stops firing into the
 * wall, and the police then ask the room what was interrupted and pick the
 * order it resumes in. Detection lives on the error text because that is the
 * one place every failed turn lands, whatever called it.
 */
export function noteRateLimitError(errorText: string): void {
	if (!RATE_LIMIT_RE.test(errorText)) return;
	setSetting('rate_limited_until', String(Date.now() + RATE_LIMIT_COOLDOWN_MS));
	if (coordinating) {
		pendingEpisode = true;
		return;
	}
	coordinating = true;
	void (async () => {
		try {
			do {
				pendingEpisode = false;
				await coordinateRateLimit();
			} while (pendingEpisode);
		} catch (e) {
			logActivity(
				ensurePoliceBot().id,
				'error',
				`Rate-limit coordination failed: ${(e as Error).message}`
			);
		} finally {
			coordinating = false;
		}
	})();
}

/**
 * One episode: the officer asks the lounge what everyone was doing, each bot
 * answers in turn - sequentially, because asking them all at once is how the
 * limit was hit - and the answers are ranked into a resume order. The winner's
 * resume time is now; the rest are staggered five minutes apart so the fleet
 * comes back one voice at a time instead of as a second storm.
 */
async function coordinateRateLimit(): Promise<void> {
	const officer = ensurePoliceBot();
	const bots = listVisibleBots().filter((b) => b.id !== officer.id);
	if (!bots.length) return;
	// A new episode's order replaces the old one: stale resume times from a
	// previous storm must not leak a bot back early.
	for (const bot of bots) setSetting(`resume_at:${bot.id}`, '');
	const lounge = loungeFor(bots[0]);
	const seated = new Set(conversationBots(lounge).map((b) => b.id));
	for (const bot of bots) if (!seated.has(bot.id)) addConversationMember(lounge, bot.id);

	addMessage(
		lounge,
		'assistant',
		'We hit a rate limit - everyone, what were you working on and why is it ' +
			'important? I will pick who continues.',
		officer.id,
		'',
		0,
		''
	);
	logActivity(officer.id, 'police', 'Rate limit hit: asking the room what was interrupted');

	const conv = getConversation(lounge);
	const replies = new Map<string, string>();
	for (const bot of bots) {
		if (!conv) break;
		try {
			const task = startTask(conv, bot, '[Lounge] rate-limit check-in');
			const done = await waitForTask(task.id);
			const reply = done.message_id ? getMessage(done.message_id)?.content : '';
			if (reply) replies.set(bot.id, reply);
		} catch {
			// A bot that cannot answer is ranked by its record alone.
		}
	}
	const ranked = await chooseMostImportant(bots, replies, policeModel(), meterPoliceCall);

	const now = Date.now();
	for (const [i, bot] of ranked.entries()) {
		setSetting(`resume_at:${bot.id}`, String(now + i * RESUME_STAGGER_MS));
	}
	const order = ranked
		.map((b, i) => (i === 0 ? `${b.name} continues now` : `${b.name} at +${i * 5}m`))
		.join(', ');
	addMessage(
		lounge,
		'assistant',
		`Resume order: ${order}. ${ranked[0]?.name ?? 'The first'} continues; everyone else holds.`,
		officer.id,
		'',
		0,
		''
	);
	logActivity(officer.id, 'police', `Resume order after the rate limit: ${order}`);
}
