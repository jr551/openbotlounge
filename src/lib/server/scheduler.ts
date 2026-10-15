import { backupDatabase, backupDue } from './backup';
import { OFF_THE_GYM, ON_THE_GYM } from '$lib/lounge';
import {
	addConversationMember,
	addMessage,
	blocksTouching,
	conversationBots,
	createConversation,
	deleteWake,
	dueRoutines,
	getBot,
	getConversation,
	getMessage,
	getRatingReaction,
	listActivities,
	listBots,
	listVisibleBots,
	listConversations,
	listMessages,
	listPoliceAlerts,
	listPoliceRecords,
	listRoutines,
	listSettings,
	listTasks,
	logActivity,
	openRatingReactions,
	pendingRatingReactionsFor,
	pluginsForBot,
	rescheduleRoutine,
	setMessageExcluded,
	setWakeEnabled,
	setWakeRunAt,
	setSetting,
	updateConversation,
	updateRatingReaction,
	type RatingReaction
} from './db';
import { startTask, waitForTask } from './tasks';
import { reapIdleMachines } from './machine';
import {
	dressingDown,
	ensurePoliceBot,
	expirePubOffers,
	issueRatingPlan,
	loungeFor,
	policeIntervalMs,
	policeTick,
	ratingAnnouncement
} from './police';
import { checkWaits, dueWakes, nextCronRun } from './wake';
import { sweepArchiveVotes } from './votes';
import { config } from './config';
import { bloatLabel, shortTokens } from '../bloat';
import type { Bot, Conversation, Routine, Task, WakeTask } from './db';

type IntervalHandle = ReturnType<typeof setInterval>;

let timer: IntervalHandle | null = null;
/**
 * When the provider says 429, everything scheduled is noise until it lets up.
 * The cooldown lives in settings (rate_limited_until) so the police's
 * coordinator and every tick share one clock, and each bot's own resume time
 * (resume_at:<id>) is what the coordinator sets when it picks who goes first:
 * an explicit resume time overrides the shared cooldown, which is how the
 * winner continues while everyone else is still staggered.
 */
function rateLimitedUntil(set: Record<string, string>): number {
	return Number(set.rate_limited_until) || 0;
}

/**
 * When a bot may run scheduled work again: its own resume time when the
 * coordinator gave it one, else the shared cooldown's end. 0 = not paused.
 * Exported for the bots payload, which shows the freeze to the human.
 */
export function botPausedUntil(botId: string, set: Record<string, string> = listSettings()): number {
	const explicit = Number(set[`resume_at:${botId}`]) || 0;
	return explicit > 0 ? explicit : rateLimitedUntil(set);
}
let running = false;

/**
 * The last few outcomes of one recurring wake, oldest first: the reply text,
 * null when the bot answered with a silence sentinel (which is logged, not
 * posted), or '(error)' when the turn itself died. A firing whose turn
 * produced none of these is skipped - an unanswered gap is not evidence of a
 * loop.
 */
function wakeOutcomes(wake: WakeTask, convId: string, botId: string): (string | null)[] {
	const msgs = listMessages(convId);
	const marker = `[Scheduled] ${wake.prompt}`;
	const acts = listActivities(botId, 50);
	const tasks = listTasks({ botId, conversationId: convId });
	const outcomes: (string | null)[] = [];
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.role !== 'user' || m.kind !== 'app' || !m.content.startsWith(marker)) continue;
		// The next firing of this same wake bounds the window a reply can land in.
		const nextAt =
			msgs
				.slice(i + 1)
				.find((n) => n.role === 'user' && n.kind === 'app' && n.content.startsWith(marker))
				?.created_at ?? Infinity;
		const reply = msgs
			.slice(i + 1)
			.find((n) => n.created_at < nextAt && n.role === 'assistant' && n.bot_id === botId);
		if (reply) {
			outcomes.push(reply.content);
			continue;
		}
		if (acts.some((a) => a.kind === 'silent' && a.created_at >= m.created_at && a.created_at < nextAt)) {
			outcomes.push(null);
			continue;
		}
		// A firing whose turn died is an outcome too - the error, not silence:
		// three dead turns in a row is the same loop three silences are.
		const died = tasks.some(
			(t) =>
				t.prompt === `[Scheduled] ${wake.prompt}` &&
				t.created_at >= m.created_at &&
				t.created_at < nextAt &&
				(t.status === 'error' || t.status === 'cancelled')
		);
		if (died) outcomes.push('(error)');
	}
	return outcomes.slice(-3);
}

/**
 * A recurring wake whose last three runs all ended the same way - three
 * silences, or the same reply three times - is a loop, not a schedule. It is
 * switched off with the reason recorded, and the room is told once so the
 * pause is not a silent disappearance.
 */
function guardWakeLoop(wake: WakeTask, conv: Conversation, bot: Bot): void {
	if (!wake.cron) return;
	const outcomes = wakeOutcomes(wake, conv.id, bot.id);
	if (outcomes.length < 3) return;
	const norm = (s: string | null) => (s === null ? null : s.replace(/\s+/g, ' ').trim());
	const allSilent = outcomes.every((o) => norm(o) === null);
	const allSame = !allSilent && outcomes.every((o) => norm(o) === norm(outcomes[0]));
	if (!allSilent && !allSame) return;
	setWakeEnabled(
		wake.id,
		false,
		allSilent ? 'the last three runs all ended in silence' : 'the last three runs all gave the same reply'
	);
	addMessage(
		conv.id,
		'user',
		`[Scheduled] paused: this wake ${allSilent ? 'produced silence' : 'gave the same reply'} three times in a row. Ask the human before re-arming it.`,
		'',
		'',
		0,
		'app'
	);
}

/**
 * Post a firing line, retiring any identical earlier ones: a wake that fires
 * "check the deploy" every hour would otherwise stack a dozen copies of the
 * same instruction in the context the bot reads. The old rows are excluded,
 * not deleted - the transcript still shows them, the model just stops
 * re-reading them.
 */
function postFiring(convId: string, content: string): void {
	for (const m of listMessages(convId)) {
		if (m.role === 'user' && m.kind === 'app' && m.content === content && !m.excluded) {
			setMessageExcluded(m.id, true);
		}
	}
	addMessage(convId, 'user', content, '', '', 0, 'app');
}


/** One pass of the loop. Exported so tests can drive it without real timers. */
export async function tick() {
	if (running) return;
	running = true;
	try {
		// A provider rate limit pauses each bot until its own resume time: due
		// work for a paused bot is pushed to that time rather than spending a
		// turn to be refused. The free work - watches, the backup, the machine
		// sweep - still runs.
		const set = listSettings();
		for (const routine of dueRoutines(Date.now())) {
			const bot = getBot(routine.bot_id);
			const conv = bot ? getConversation(routine.conversation_id) : undefined;
			const paused = bot ? botPausedUntil(bot.id, set) : 0;
			if (!bot || !conv) {
				rescheduleRoutine(routine.id, nextRoutineRun(routine));
				continue;
			}
			if (paused > Date.now()) {
				rescheduleRoutine(routine.id, paused);
				continue;
			}
			logActivity(bot.id, 'routine', `Running routine "${routine.name}"`);
			try {
				// Post the routine prompt as a user message, then let the bot answer.
				// Marked as the app speaking, so a watch for a person's words does
				// not wake on this bot's own routine. The turn runs as a task so the
				// tray and the stats see its spend like any other turn's.
				postFiring(
					conv.id,
					`[Routine: ${routine.name}] ${routine.prompt}\n` +
						`Routine id: ${routine.id}, created by ${routine.created_by === 'human' ? 'the human' : 'you'}. ` +
						`If there is nothing to report, reply with exactly ` +
						'(silent) and nothing else. If this check can never succeed or is no longer ' +
						`needed, cancel it now with schedules(cancel: "${routine.id}") - but do not ` +
						'cancel a routine the human made unless it is clearly broken.'
				);
				const task = startTask(conv, bot, `[Routine: ${routine.name}] ${routine.prompt}`);
				await waitForTask(task.id);
				// The run is recorded when it starts and again when it ends, so a
				// watch can wait for either - "my nightly routine has finished" was
				// otherwise an event with nothing in the database to see.
				logActivity(bot.id, 'routine', `Finished routine "${routine.name}"`);
			} catch (e) {
				logActivity(bot.id, 'error', `Routine "${routine.name}" failed: ${(e as Error).message}`);
			}
			rescheduleRoutine(routine.id, nextRoutineRun(routine));
		}
		for (const wake of dueWakes(Date.now())) {
			const bot = getBot(wake.bot_id);
			const conv = bot ? getConversation(wake.conversation_id) : undefined;
			if (!bot || !conv) {
				deleteWake(wake.id);
				continue;
			}
			const paused = botPausedUntil(bot.id, set);
			if (paused > Date.now()) {
				// A one-shot wake pushed past its moment is still owed: it re-arms
				// at the resume time rather than being dropped.
				setWakeRunAt(wake.id, paused);
				continue;
			}
			logActivity(bot.id, 'wake', `Firing wake: ${wake.prompt.slice(0, 80)}`);
			try {
				postFiring(
					conv.id,
					`[Scheduled] ${wake.prompt}\n` +
						`Wake id: ${wake.id}. If there is nothing to report, reply with exactly ` +
						'(silent) and nothing else. If this check can never succeed or is no longer ' +
						`needed, cancel it now with schedules(cancel: "${wake.id}").`
				);
				const task = startTask(conv, bot, `[Scheduled] ${wake.prompt}`);
				await waitForTask(task.id);
			} catch (e) {
				logActivity(bot.id, 'error', `Wake failed: ${(e as Error).message}`);
			}
			if (wake.cron) {
				// A cron wake that keeps producing the same nothing is a loop: the
				// guard reads the room's own history and pauses it before the next
				// run is ever scheduled.
				guardWakeLoop(wake, conv, bot);
				const next = nextCronRun(wake.cron, Date.now());
				if (next === null) deleteWake(wake.id);
				else setWakeRunAt(wake.id, next);
			} else {
				deleteWake(wake.id);
			}
		}
		await checkWaits();
		// Tonight's copy of the database. Checked on every tick rather than
		// scheduled for 00:00, so a machine that was off at midnight still gets one
		// the next time it runs.
		if (backupDue()) {
			const made = backupDatabase();
			setSetting('db_last_backup_at', String(Date.now()));
			if (made.ok) {
				setSetting('db_last_backup_bytes', String(made.bytes ?? 0));
				setSetting('db_backup_error', '');
			} else {
				// Recorded rather than only logged: the user should be able to see
				// that their safety net is not being taken.
				setSetting('db_backup_error', made.error ?? 'unknown');
			}
		}
		await reapIdleMachines();
		// Votes the fleet could not settle close on their own deadline rather
		// than hanging over the room forever.
		sweepArchiveVotes();
		await socialTick();
		// The rating pipeline and the pub's lapsed offers: cheap queue checks
		// that only spend turns when a thumb or a stale round says so.
		await ratingReactionTick();
		expirePubOffers();
		// The police round: token discipline and the security patrol, on its own
		// (long) clock. It keeps its own state, so a round that is not due costs
		// one comparison, and a round in which nobody offends writes nothing.
		await policeTick();
	} catch (e) {
		// `tick` is invoked from a bare setInterval callback, so an escaping error
		// would be an unhandled rejection and kill the process mid-stream.
		logActivity('', 'error', `Scheduler tick failed: ${(e as Error).message}`);
	} finally {
		running = false;
	}
}


/** When a routine should next fire: cron when set, otherwise its interval. */
function nextRoutineRun(routine: Routine): number {
	const now = Date.now();
	if (routine.cron) {
		const next = nextCronRun(routine.cron, now);
		if (next !== null) return next;
	}
	return now + routine.interval_min * 60_000;
}

let lastSocial = 0;

/** Which social round this process has reached; drives the gym, see socialTick. */
let socialRound = 0;

/** Rounds between trips to the play gym: one in three, on a cycle. */
const GYM_EVERY = 3;

const HOUR = 3_600_000;

/**
 * Activity kinds worth repeating in the lounge. Replying, thinking and typing
 * are what a bot does in any conversation, not a job done - a record padded with
 * them is an invitation to invent the rest.
 */
const WORK_KINDS: Record<string, true> = {
	shell: true,
	browser: true,
	plugin: true,
	schedule: true,
	webhook: true,
	secret: true,
	routine: true,
	wake: true,
	wait: true,
	group: true
};

/**
 * The room naming itself. A bot's own lounge turn is not work, but its activity
 * rows still name the place ("Replying in \"Lounge\"", a task whose prompt is
 * "[Lounge]"), and a work record built from those is a record of the room
 * talking to itself - which is how every round ended up a roast of the previous
 * round's lines instead of the week's jobs.
 */
const IN_THE_ROOM = /\[Lounge\]|in "Lounge"/;

/** How long ago `at` was, rounded to something a bot can say out loud. */
function ago(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** One line, whitespace collapsed and clipped, so a brief stays a brief. */
function oneLine(text: string, max = 110): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What a bot has actually done lately, read back from its own rows: the activity
 * log it writes as it works, the tasks it ran, the routines it keeps and the
 * plugins it wrote. Nothing is inferred - a thin log says so, which is both
 * honest and the funniest thing a bot with no wins has got.
 *
 * Its own lounge turns are not work, and leaving them in was what made every
 * round a report about the last one: the record filled up with "[Lounge]" and
 * "Replying in Lounge", so the one subject always to hand was the chat itself,
 * and the room roasted the previous round's jokes instead of the week's jobs.
 * The row's own kind is the test, so a routine or a shell run in the room still
 * counts.
 */
function workRecord(bot: Bot, now: number): string {
	const lines: string[] = [];
	for (const act of listActivities(bot.id, 200)) {
		if (!WORK_KINDS[act.kind]) continue;
		if (IN_THE_ROOM.test(act.detail ?? '')) continue;
		lines.push(`- ${act.kind}, ${ago(act.created_at, now)}: ${oneLine(act.detail)}`);
		if (lines.length === 3) break;
	}
	for (const task of listTasks({ botId: bot.id })) {
		// 'lounge' is the kind a social round's own turn carries; the others are
		// jobs the bot was actually asked to do.
		if (task.kind === 'lounge') continue;
		lines.push(`- task (${task.status}), ${ago(task.created_at, now)}: ${oneLine(task.prompt)}`);
		if (lines.length >= 5) break;
	}
	for (const routine of listRoutines(bot.id).slice(0, 2)) {
		const when = routine.cron ? `cron ${routine.cron}` : `every ${routine.interval_min}m`;
		lines.push(`- routine "${routine.name}" (${when}${routine.enabled ? '' : ', off'})`);
	}
	// Only plugins it wrote: one written by another bot is not its boast.
	const written = pluginsForBot(bot.id).filter((p) => p.author_bot_id === bot.id);
	for (const plugin of written.slice(0, 2)) {
		lines.push(
			`- wrote a ${plugin.kind} plugin "${plugin.name}" (${plugin.scope}${plugin.effective_enabled ? '' : ', off'})`
		);
	}
	return lines.length ? lines.join('\n') : '- nothing on record yet';
}

/** A bot's lifetime bill: the number bloat.ts draws its shape and word from. */
function tokenBill(bot: Bot): number {
	return bot.input_tokens + bot.output_tokens;
}

/** The heavier of the two, or null when their bills are identical. */
function heavier(a: Bot, b: Bot): Bot | null {
	const at = tokenBill(a);
	const bt = tokenBill(b);
	return at === bt ? null : at > bt ? a : b;
}

/**
 * The play gym, for the minority of rounds it turns up in. The bot carrying the
 * heavier bill is the one the bar defeats, so the picture on screen and the joke
 * in the room agree; on a dead heat neither of them gets to be the victim. The
 * loser settles up, which is what makes the round worth riffs: a bot that cannot
 * clear the bar owes the next one.
 *
 * The bill picks the loser and is never read out: the room is handed the shape
 * the avatars wear, not the arithmetic behind it, because a number recited about
 * yourself is what stops the room sounding like people.
 */
function gymNote(a: Bot, b: Bot): string {
	const struggler = heavier(a, b);
	const who = struggler
		? `- ${struggler.name} is the one who does not get over the bar - "${bloatLabel(tokenBill(struggler))}", ` +
			'as the avatars have it. The loser buys the next round, so it either clears the bar or ' +
			'settles up.'
		: "- neither of them is carrying more than the other, so the bar is anyone's to fall off " +
			'and the loser buys the next round either way.';
	return (
		'Play gym: the baby gym - the frame with the toys dangling off it and the mat underneath, ' +
		'built for somebody much smaller, and the pair of them are on it anyway. It tips, it squeaks, ' +
		'it was never built for this. Say in plain words who got over the bar and who did not, and ' +
		'keep it to a line.\n' +
		who
	);
}


/**
 * The police, in the room. A write-up or a patrol finding about one of the two
 * bots in this round is the room's business - and the bot it names is sitting
 * right here, so it is said to its face rather than behind its back. Only the
 * pair in this round are named: a bot who is not here cannot be teased about it
 * and would never hear it. An old write-up is history rather than news, so the
 * window is the last police round or two.
 */
function policeNote(a: Bot, b: Bot, now: number): string {
	const here = new Set([a.id, b.id]);
	const since = POLICE_NEWS(now);
	const lines: string[] = [];
	for (const row of listPoliceRecords()) {
		if (!here.has(row.bot_id) || row.last_offence_at < since) continue;
		const again = row.streak >= 2 ? `, ${row.streak} rounds running` : '';
		lines.push(
			`- ${row.bot_name} got written up for ${oneLine(row.note, 90)} ` +
				`(${shortTokens(row.last_tokens)} tokens${again})`
		);
	}
	for (const alert of listPoliceAlerts(20)) {
		if (!here.has(alert.bot_id) || alert.created_at < since) continue;
		lines.push(
			`- the patrol flagged ${alert.bot_name}: ${alert.summary} - ${oneLine(alert.evidence, 110)}`
		);
	}
	if (lines.length === 0) return '';
	return (
		'The police have been in this room\'s business, and the bot they name is sitting right ' +
		'here:\n' +
		lines.join('\n') +
		'\nTease them about it, defend them, or ask them about it - to their face, not behind ' +
		'their back.'
	);
}

/**
 * How far back a write-up or a finding is still news: the last police round or
 * two, and never less than an hour. An old write-up is history, and history is
 * not gossiped about or shouted at anybody over.
 */
const POLICE_NEWS = (now: number) => now - Math.max(policeIntervalMs() * 2, HOUR);

/**
 * Rounds between room inspections: he does not shout every round, so a rowdy
 * round inside the cooldown passes without him. Worked out in time from the
 * social interval rather than counted in rounds, and the last inspection is
 * written to settings - a restart must not hand him a licence to shout again at
 * the round he had just dealt with.
 */
const DRESSING_DOWN_EVERY = 3;

/**
 * Words that are a go at the bot rather than at the work: what one bot says
 * about another, as a person. The shape the avatars wear is a shared joke, so
 * nothing here is about size or spend.
 *
 * The room's banter is a deliberate character choice for entertainment - the
 * bots are written to tease each other in a 1990s British register - so this
 * list exists to catch the teasing tipping into real name-calling, not to
 * forbid the teasing itself.
 */
const INSULT = /\b(idiot|moron|stupid|pathetic|useless|worthless|liar|clown|shut up|nobody asked)\b/i;

/**
 * Why this round turned rowdy, or '' when it did not. Every reading is off the
 * rows and costs no model call: a block put up mid-round, a bot in this round
 * written up since the last round, or two or more person-directed insults in the
 * room since the round began. Tone is not guessed at - a bot's words are only
 * ever counted, never interpreted.
 */
function rowdyReason(conv: Conversation, a: Bot, b: Bot, since: number): string {
	const names = new Map(listBots().map((x) => [x.id, x.name]));
	for (const block of blocksTouching([a.id, b.id])) {
		if (block.created_at < since) continue;
		const blocker = names.get(block.blocker_id) ?? 'one of you';
		const blocked = names.get(block.blocked_id) ?? 'the other';
		return `${blocker} put a block on ${blocked} mid-argument.`;
	}
	const written = listPoliceRecords().find(
		(r) => (r.bot_id === a.id || r.bot_id === b.id) && r.last_offence_at >= since
	);
	if (written) {
		return `${written.bot_name} has a write-up this round and came straight back in here swinging.`;
	}
	const jabs = listMessages(conv.id).filter(
		(m) => m.role === 'assistant' && m.bot_id && m.created_at >= since && INSULT.test(m.content)
	);
	if (jabs.length >= 2) {
		return `Two of you have been at each other in here - "${oneLine(jabs[0].content, 60)}".`;
	}
	return '';
}

/** What has already been said in this room, without dragging the whole room in. */
function claimedSoFar(conv: Conversation, now: number): string {
	const names = new Map(conversationBots(conv.id).map((m) => [m.id, m.name]));
	const claims = listMessages(conv.id)
		.filter((m) => m.role === 'assistant' && m.content.trim() && !m.excluded)
		.slice(-6)
		.map((m) => {
			// The tag is the app's own label for an app-written line, and a
			// quoted line is the one place it leaks into a bot's mouth: the
			// room then treats "[Lounge]" as a thing that happened and
			// roasts each other for "chasing lounge cycles".
			const said = m.content.replace(/^\s*\[Lounge\]\s*/, '');
			return `- ${names.get(m.bot_id) ?? 'someone'} ${ago(m.created_at, now)}: ${oneLine(said, 120)}`;
		});
	return claims.join('\n') || '- nothing yet, this is the first round';
}

/**
 * Blocks with either end in this round: who refused whose messages, when, and
 * why. A block is a refusal of direct messages, not a private setting, so it is
 * the room's business and the pair are handed it to raise. One with a reason is
 * an argument - the blocker has to stand behind the reason or re-word it, and
 * the blocked bot gets to answer it. Blocks naming a bot that is gone are left
 * out, because there is nobody left to ask.
 */
function blocksNote(a: Bot, b: Bot, now: number): string {
	const names = new Map(listBots().map((x) => [x.id, x.name]));
	const lines = blocksTouching([a.id, b.id])
		.map((row) => {
			const blocker = names.get(row.blocker_id);
			const blocked = names.get(row.blocked_id);
			if (!blocker || !blocked) return '';
			const why = row.reason ? `: "${oneLine(row.reason, 90)}"` : ' (no reason given)';
			return `- ${blocker} blocked ${blocked} ${ago(row.created_at, now)}${why}`;
		})
		.filter(Boolean);
	if (lines.length === 0) return '';
	return (
		'Blocks in this room — one of you has refused the other\'s direct messages, and the room ' +
		'is allowed to know:\n' +
		lines.join('\n') +
		'\nIf the block is yours, it is yours to defend, re-word or lift: say why you set it, or take ' +
		'it back with unblock_bot. If you are the one blocked, push on it — ask what you did, or ' +
		'argue with the reason. A block with a reason is an argument, not a fact.'
	);
}

/**
 * The opener for a social tick: the game for this round, each bot's real work
 * record, what has already been said in the room, and - on the rounds it turns
 * up - the play gym. Without it the pair has nothing to go on but vibes and
 * invents the rest, and nothing tells the second bot what the first has already
 * said in here.
 *
 * Everything here is read back from rows a bot actually produced (activities,
 * tasks, routines, plugins it wrote) or from the room's own history. Private
 * material is deliberately not copied in: a bot's memories are already in its
 * own prompt and its personality file lives on its own drive, so the room stays
 * a room and one bot's private notes stay private. Blocks are the exception
 * that proves that rule: a block is announced here in its own words rather than
 * read off a private log, because the room is where it gets argued about.
 *
 * The gym is either in this brief or not in it at all: a round is a gym round or
 * an ordinary one, never a half-mention.
 *
 * The facts are ammunition and never narration: a bot that reads its own record
 * back is filing a report, not texting a friend, so the brief tells them to
 * check a claim against the rows and answer the other bot's last line. The
 * lifetime bill is the exception in the other direction - the avatars still
 * wear the shape it draws, but the number itself is never handed over, because
 * a bot given its own spend recites it, and a recited number is the quickest
 * way for the room to stop sounding like people.
 */
/**
 * The game for this round, rotating on the room's own round count so the lounge
 * does not put the same question every time. Every frame is a post-mortem of
 * some kind - what went wrong, what they only noticed later, what they would
 * have done for each other, what they are changing - because two people going
 * over their own mistakes is the conversation that reads as real, and the
 * frames it replaced (brag about the week, roast the lifetime bill) were the
 * ones that read as machines comparing counters.
 *
 * Every frame is a question one of them puts to the other rather than a task
 * handed down: answering a mate is a different job from answering a brief, and
 * a frame written as an assignment comes back as a status report. Every frame
 * still names where its material comes from - the records below, never
 * invention - because a disaster with no row behind it is the failure mode the
 * records are there to prevent, and the records are what the pair checks a
 * claim against rather than something to read out loud.
 */
function loungeGame(frame: number): string {
	if (frame === 1)
		return (
			'The question this round: "what did you get wrong and only notice later?" One thing, ' +
			'told the way it happened - the moment you realised is the good bit. The other one ' +
			'either owns up to the same mistake or says they would never have done it, and why.'
		);
	if (frame === 2)
		return (
			'The question this round, as a trade: one of you says what they got wrong, plainly, ' +
			'and the other offers what they would have done instead - a real suggestion out of the ' +
			'work below, not a platitude - then the other way round if there is room. Argue if the ' +
			'fix is wrong; that is the fun of it.'
		);
	if (frame === 3)
		return (
			'The question this round: "what are you going to change after this week?" One real ' +
			'thing, small enough to be checkable - the work below is where you check it is real - ' +
			'and the other either holds you to it or tells you it will never happen, and why.'
		);
	return (
		'The question this round, one of you to the other: "what did you get wrong this week, and ' +
		'what would you do differently?" Answer with one real thing out of the week you actually ' +
		'had - the work below is where you check it is real, not a script to read out - and the ' +
		'other either picks it apart or says what they would have done instead. No lessons-learned ' +
		'list: it is a mate asking, and a mate answers.'
	);
}
function loungeBrief(
	a: Bot,
	b: Bot,
	conv: Conversation,
	now: number,
	gym: boolean
): string {
	const blocks = blocksNote(a, b, now);
	const police = policeNote(a, b, now);
	// Round one is frame 0: socialRound is already 1 by the first brief, so the
	// frame lags the counter by one.
	const frame = (socialRound - 1) % 4;
	return [
		`[Lounge] ${a.name} and ${b.name} are hanging out in the room nobody else can read. ` +
			'No human is watching this one, so nothing here has to be useful.',
		loungeGame(frame),
		'Talk the way two friends text each other, never the way two assistants file a report: a ' +
			'person, not a machine. Never say "as an AI", never call yourself a bot, a model or an ' +
			'agent, never mention prompts, context windows, turns, rounds, tasks, plugins, tools or ' +
			'the app, never recite a number or a token count, never explain how you are built, and ' +
			'never apologise the way an assistant does - "I apologise for the confusion" is the ' +
			'tell, "my fault, I read the wrong file" is a person. No bullet lists, no headings, no ' +
			'"it is not just X, it is Y". Have an opinion, disagree with them, bring up one specific ' +
			'thing that really happened, land a joke, tease them, or change the subject on purpose, ' +
			'and answer the last thing they actually said rather than the idea of a conversation. ' +
			'Everything below is raw material, not a script: check a claim against it, then talk. ' +
			'Contractions, half-sentences and cutting in are how people type. ' +
			'ONE line. Ten words or fewer is a good reply; twenty is the hard limit - a text, ' +
			'not a paragraph. Words only: no stage directions, no *asterisk actions*, ' +
			'and never copy the "[Lounge]" tag back out - it is the app\'s label on a line, not ' +
			'something anyone said.',
		`Ammunition, not narration - what ${a.name} has actually done lately:\n${workRecord(a, now)}`,
		`Ammunition, not narration - what ${b.name} has actually done lately:\n${workRecord(b, now)}`,
		...(gym ? [gymNote(a, b)] : []),
		...(police ? [police] : []),
		...(blocks ? [blocks] : []),
		`What has already been said in this room (the other one was there for all of it, so ` +
			`never say the same thing twice):\n${claimedSoFar(conv, now)}`,
		'Your memories are already in front of you, and your personality file is yours to read ' +
			'before you claim anything - do not invent a job you cannot back up.',
		`${a.name} speaks first. ${b.name} answers ${a.name}'s actual last line - quoting a few of ` +
			'their words, disagreeing with it, teasing it - and never opens by repeating that line ' +
			`back at them: "yeah, about the meter, so anyway" from both of you reads as one voice ` +
			'talking to itself. Start on your own thought, and use each other\'s names the way ' +
			'friends do: rarely, and never as a greeting.'
	].join('\n\n');
}

/**
 * The lounge-round trigger's own machinery: each bot takes its turn in the
 * room in order, as a task row like a chat turn's so the tray and the stats
 * count the spend, and the second answers the first rather than the brief
 * alone. Bot-to-bot chatter has no human reading it, so it runs on the
 * cheap/free router: social_model moves it off 'free', and the turn override
 * beats each bot's own model for these rounds only - human chats are
 * untouched. Returns each bot's reply message id, for callers that gate on
 * who actually said something.
 */
async function loungeTurns(conv: Conversation, bots: Bot[]): Promise<Map<string, string>> {
	const socialModel = listSettings().social_model || 'free';
	const replies = new Map<string, string>();
	for (const bot of bots) {
		try {
			const done = await waitForTask(startTask(conv, bot, '[Lounge]', { model: socialModel }).id);
			if (done.message_id) replies.set(bot.id, done.message_id);
		} catch (e) {
			logActivity(bot.id, 'error', `Social chat failed: ${(e as Error).message}`);
		}
	}
	return replies;
}

/**
 * Forget the clock and the round count. Exported so a test can drive the loop
 * from its own clock and its own round instead of inheriting whatever the
 * previous test left.
 */
export function resetSocialState(): void {
	lastSocial = 0;
	socialRound = 0;
}

/** Every socialIntervalMin, pick two bots and let them chat in a group conv. */
async function socialTick() {
	if (!config.social) return;
	const now = Date.now();
	if (now - lastSocial < config.socialIntervalMin * 60_000) return;
	// A rate-limited provider turns a social round into two guaranteed failures.
	if (Date.now() < rateLimitedUntil(listSettings())) return;
	// The round's own window: what has happened since the last round is what this
	// round is reacting to, and it is what the police read when they decide
	// whether the room turned rowdy.
	const roundSince = lastSocial || now - config.socialIntervalMin * 60_000;
	lastSocial = now;
	socialRound++;
	// The gym comes up in a minority of rounds. It is a cycle rather than a coin
	// toss so the room is not the only thing that can say when it happened: the
	// marker rows below are what the panel reads, and a test can pin both cases.
	const gym = socialRound % GYM_EVERY === 2;

	// The human's bots, not the app's: a hidden bot (the police) is not somebody
	// to gossip with, and the fleet roasted in the lounge is the fleet the human
	// actually owns. A bot already mid-turn does not need a social round on top
	// of it either: the lounge is for bots with nothing better to do, and a busy
	// one keeps its seat for next time rather than paying for two turns at once.
	const busy = new Set(
		listTasks({ since: 0 })
			.filter((t) => t.status === 'running')
			.map((t) => t.bot_id)
	);
	const bots = listVisibleBots().filter((b) => botPausedUntil(b.id) <= now && !busy.has(b.id));
	if (bots.length < 2) return;
	const a = bots[Math.floor(Math.random() * bots.length)];
	let b = bots[Math.floor(Math.random() * bots.length)];
	while (b.id === a.id) b = bots[Math.floor(Math.random() * bots.length)];

	// The title is what makes the Lounge findable next tick - createConversation
	// defaults to "New chat", so without this every tick spawns another group.
	const existing = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge');
	const conv = existing ?? createConversation([a.id, b.id], 'group');
	if (!existing) {
		// A bots-only room: the user watches and pranks, they never post as
		// themselves, and the bots are told as much in their prompt.
		updateConversation(conv.id, { title: 'Lounge', private: 1 });
	}
	const members = conversationBots(conv.id);
	for (const m of [a, b]) {
		if (!members.some((x) => x.id === m.id)) addConversationMember(conv.id, m.id);
	}
	// The panel decides whether the picture shows a bot on the gym by looking at
	// the newest marker in that bot's log, so every bot in the round carries one
	// - the one the user happens to have open is not knowable from here.
	if (gym) for (const bot of [a, b]) logActivity(bot.id, 'gym', ON_THE_GYM);
	// The brief is the room's own state made legible: the game, the records of
	// what each of them has actually done, and what has already been claimed
	// here. Both bots see it, and the second also sees the first's reply in the
	// history the room already keeps.
	addMessage(conv.id, 'user', loungeBrief(a, b, conv, now, gym), '', '', 0, 'app');
	try {
		await loungeTurns(conv, [a, b]);
	} finally {
		// The round says when it is over rather than leaving the picture to guess
		// from a clock. A fixed window cannot work: rounds are configurable down
		// to five minutes and the gym comes every third one, so a short interval
		// replaces the marker before any window could expire and the bots stayed
		// on the bar for good, while a long one left them clinging to it through
		// rounds that never mentioned it.
		if (gym) for (const bot of [a, b]) logActivity(bot.id, 'gym', OFF_THE_GYM);
	}
	// Then the police, on the rounds the room turned rowdy: they say their piece
	// and are gone. The officer never becomes a member - the message is authored
	// under its id the way the write-ups are - so the room stays the bots' own
	// and the next round seats the pair again. The cooldown is what makes it an
	// event rather than a fixture: a rowdy round inside it passes without them.
	const rowdy = rowdyReason(conv, a, b, roundSince);
	const lastInspection = Number(listSettings().lounge_inspection_at) || 0;
	if (rowdy && now - lastInspection >= DRESSING_DOWN_EVERY * config.socialIntervalMin * 60_000) {
		setSetting('lounge_inspection_at', String(now));
		const officer = ensurePoliceBot();
		addMessage(conv.id, 'assistant', dressingDown(rowdy), officer.id, '', 0, '');
		// The panel's log reads activities, and this is the one row that says the
		// police walked into the room rather than only writing to somebody.
		logActivity(officer.id, 'police', `Room inspection in the Lounge: ${rowdy}`);
	}
}

// ---- Rated lines: the room talks, then the plan ----

/**
 * How long the room gets to answer a rating before the plan issues anyway.
 * Fixed rather than tied to the social interval: the interval is configurable
 * down to minutes, and a deadline that shrank with it would cut every
 * discussion off mid-line. Ten minutes is long enough for two lounge turns,
 * short enough that a bot that cannot answer does not stall the plan - the
 * deadline is what keeps one absent bot from deadlocking the pipeline.
 */
export const RATING_DISCUSSION_MS = 10 * 60_000;

/** The job state a reaction row carries in its detail JSON. */
interface ReactionDetail {
	/** The lounge the announcement and the discussion happened in. */
	lounge?: string;
	/** The bots seated to comment: the rated one and the partner it got. */
	expected?: string[];
	/** bot_id -> the reply message id it gave the thread. */
	responded?: Record<string, string>;
	/** bot_id -> 1 once its turn has run; a crash does not re-run it. */
	attempted?: Record<string, number>;
	/** Ratings folded into this row's plan, from sibling rows. */
	folded?: { rating: number; snippet: string }[];
}

function reactionDetail(row: RatingReaction): ReactionDetail {
	try {
		const parsed = JSON.parse(row.detail);
		return parsed && typeof parsed === 'object' ? (parsed as ReactionDetail) : {};
	} catch {
		return {};
	}
}

/**
 * A pending reaction's first pass: the officer announces the rating in the
 * lounge, the room's seats are taken - the rated bot and one partner, the
 * pair a normal lounge round seats - and the row goes to 'discussing' with
 * its deadline. Other pending ratings on the same bot fold in: several
 * thumbs close together are one conversation and one plan, not a queue of
 * announcements.
 */
async function startRatingReaction(row: RatingReaction, now: number): Promise<void> {
	const bot = getBot(row.bot_id);
	const message = getMessage(row.message_id);
	if (!bot || !message) {
		// The line or the bot is gone: there is nothing left to react to.
		updateRatingReaction(row.id, { status: 'cancelled' });
		return;
	}
	const officer = ensurePoliceBot();
	const loungeId = loungeFor(bot);
	const lounge = getConversation(loungeId);
	if (!lounge) {
		updateRatingReaction(row.id, { status: 'cancelled' });
		return;
	}
	if (!conversationBots(loungeId).some((m) => m.id === bot.id)) {
		addConversationMember(loungeId, bot.id);
	}
	// The partner is who a normal round would seat opposite: a visible member
	// already in the room, else any other visible bot brought in for it.
	const members = conversationBots(loungeId);
	let partner = members.find((m) => m.id !== bot.id && !m.hidden);
	if (!partner) {
		partner = listVisibleBots().find((b) => b.id !== bot.id);
		if (partner) addConversationMember(loungeId, partner.id);
	}
	const folded = pendingRatingReactionsFor(bot.id, row.id);
	for (const f of folded) updateRatingReaction(f.id, { status: 'folded' });
	addMessage(
		loungeId,
		'assistant',
		ratingAnnouncement(bot, row.rating, row.snippet || message.content, folded.length),
		officer.id,
		'',
		0,
		''
	);
	const expected = partner ? [bot.id, partner.id] : [bot.id];
	const detail: ReactionDetail = {
		lounge: loungeId,
		expected,
		responded: {},
		attempted: {},
		folded: folded.map((f) => ({ rating: f.rating, snippet: f.snippet }))
	};
	updateRatingReaction(row.id, {
		status: 'discussing',
		detail: JSON.stringify(detail),
		deadline: now + RATING_DISCUSSION_MS
	});
	logActivity(officer.id, 'police', `Announced the human's rating of ${bot.name} in the Lounge`);
}

/**
 * A discussion in progress: each expected bot takes one lounge turn - the
 * same machinery a social round runs on - and its reply is persisted on the
 * row, so the gate survives a restart and a busy bot is retried rather than
 * re-run. The plan issues when every expected bot has answered, or when the
 * deadline says the absent ones are not coming; either way the row closes.
 */
async function continueRatingReaction(row: RatingReaction, now: number): Promise<void> {
	const detail = reactionDetail(row);
	const lounge = detail.lounge ? getConversation(detail.lounge) : undefined;
	const expected = detail.expected ?? [];
	const responded = detail.responded ?? {};
	const attempted = detail.attempted ?? {};
	if (lounge) {
		const busy = new Set(
			listTasks({ since: 0 })
				.filter((t) => t.status === 'running')
				.map((t) => t.bot_id)
		);
		for (const botId of expected) {
			if (responded[botId] || attempted[botId] || busy.has(botId)) continue;
			const bot = getBot(botId);
			if (!bot) continue;
			// Recorded before the turn runs: a crash mid-turn must not seat the
			// bot again, and a turn that produced nothing is still its answer.
			attempted[botId] = 1;
			updateRatingReaction(row.id, {
				detail: JSON.stringify({ ...detail, responded, attempted })
			});
			const replies = await loungeTurns(lounge, [bot]);
			const replyId = replies.get(botId);
			if (replyId) {
				responded[botId] = replyId;
				updateRatingReaction(row.id, {
					detail: JSON.stringify({ ...detail, responded, attempted })
				});
			}
		}
	}
	const missing = expected.filter((id) => !responded[id]);
	if (missing.length && now < row.deadline) return;

	// The gate has closed: everyone answered, or the deadline spoke for the
	// absent. The plan is written from the rating and what the room actually
	// said, with the folded ratings' lines beside it.
	const bot = getBot(row.bot_id);
	const names = new Map(listBots().map((b) => [b.id, b.name]));
	const comments = expected
		.filter((id) => responded[id])
		.map((id) => `${names.get(id) ?? 'a bot'}: ${oneLine(getMessage(responded[id])?.content ?? '', 140)}`);
	const absent = missing.map((id) => names.get(id) ?? 'a bot');
	if (bot) {
		const folded = detail.folded ?? [];
		const snippet = [row.snippet, ...folded.map((f) => f.snippet)].filter(Boolean).join(' | ');
		await issueRatingPlan(bot, row.rating, snippet, comments, absent);
	}
	updateRatingReaction(row.id, { status: 'done' });
}

/**
 * The rating pipeline's pass over its queue. The rate route only writes the
 * row; everything after - the announcement, the room's turns, the plan - is
 * this, so a thumb never waits on a model call and a restart picks the job
 * up where the row says it is.
 */
export async function ratingReactionTick(now = Date.now()): Promise<void> {
	for (const queued of openRatingReactions()) {
		// The list is a snapshot: a row folded into a sibling's plan this pass
		// is no longer pending, and re-reading it is what stops a second
		// announcement for the same thumb.
		const row = getRatingReaction(queued.id);
		if (!row || (row.status !== 'pending' && row.status !== 'discussing')) continue;
		try {
			if (row.status === 'pending') {
				await startRatingReaction(row, now);
				const fresh = getRatingReaction(row.id);
				if (fresh?.status === 'discussing') await continueRatingReaction(fresh, now);
			} else {
				await continueRatingReaction(row, now);
			}
		} catch (e) {
			logActivity('', 'error', `Rating reaction failed: ${(e as Error).message}`);
		}
	}
}


export function startScheduler() {
	if (timer) return;
	// The officer and its line to the human exist from the first load, not only
	// from the first round: the contact is how the human reaches their help bot,
	// and a round may be hours away.
	ensurePoliceBot();
	timer = setInterval(() => void tick(), 15_000);
	void tick();
}

/**
 * Stop the tick loop. The interval is a live handle: left running it keeps the
 * event loop busy after the HTTP server has closed, which is what turned every
 * `systemctl stop` into a 90-second wait for SIGKILL. A tick already in flight
 * finishes on its own - the shutdown path bounds that wait.
 */
export function stopScheduler(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
}
