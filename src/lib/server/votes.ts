/**
 * The fleet's last resort: a vote to put a bot in cold storage. Any bot can
 * call one on another; the room argues it out in the lounge, and the bots
 * settle it themselves - the human is not in the tally and the police do not
 * vote. A passed vote archives the target outright, the same cold storage the
 * human's own switch uses, so it is the fleet's sanction rather than a new
 * punishment.
 *
 * The mechanics are deliberately dull: one open vote per target, one ballot
 * per bot (a second cast replaces the first), and a deadline so a vote nobody
 * can settle closes itself rather than hanging over the room forever.
 */
import {
	addMessage,
	archiveBallots,
	castArchiveBallot,
	closeArchiveVote,
	createArchiveVote,
	expiredArchiveVotes,
	getBot,
	listVisibleBots,
	logActivity,
	openArchiveVoteFor,
	updateBot,
	type ArchiveVote,
	type Bot
} from './db';
import { ensurePoliceBot, loungeFor } from './police';

/** How long the fleet gets to settle a vote before it closes on its own. */
export const ARCHIVE_VOTE_HOURS = 4;

/**
 * The bots whose ballots count: every visible, unarchived bot except the
 * target itself. Hidden bots are the app's own (the police) and never vote;
 * an archived bot is already in cold storage and gets no say.
 */
function eligibleVoters(targetId: string): Bot[] {
	return listVisibleBots().filter((b) => !b.archived && b.id !== targetId);
}

/** The officer posts the call and the result; it is not a member of the room. */
function announce(target: Bot, text: string): void {
	addMessage(loungeFor(target), 'assistant', text, ensurePoliceBot().id, '', 0, '');
}

/** The tally, or null while the vote is still live. */
function tally(vote: ArchiveVote): 'passed' | 'failed' | null {
	const eligible = eligibleVoters(vote.target_id).length;
	// Nobody left to ask: the vote cannot pass, so it fails outright.
	if (eligible === 0) return 'failed';
	const ballots = archiveBallots(vote.id);
	const yes = ballots.filter((b) => b.choice === 'yes').length;
	const no = ballots.filter((b) => b.choice === 'no').length;
	// Yes must exceed half of the eligible fleet, so the bar is the smallest
	// whole number over 50%: 3 of 4, 2 of 3, 1 of 1.
	const needed = Math.floor(eligible / 2) + 1;
	if (yes >= needed) return 'passed';
	// Once enough noes land that yes can no longer reach the bar, the vote has
	// failed even with ballots still out.
	if (no > eligible - needed) return 'failed';
	return null;
}

/**
 * Close a vote with its outcome, archiving the target on a pass. Returns false
 * when the vote was already settled, so a late ballot cannot re-rule it.
 */
function settle(vote: ArchiveVote, outcome: 'passed' | 'failed' | 'expired'): boolean {
	if (!closeArchiveVote(vote.id, outcome)) return false;
	const target = getBot(vote.target_id);
	const name = target?.name ?? 'the bot';
	if (outcome === 'passed') {
		if (target) {
			// The same cold-storage flag the human's switch sets: the bot keeps
			// its data, leaves every picker, and only the human can bring it back.
			updateBot(target.id, { archived: 1 });
		}
		announce(
			target ?? ({ id: vote.target_id, name } as Bot),
			`The vote is settled: ${name} goes to cold storage. ${vote.reason ? `(${vote.reason}) ` : ''}Only the human can bring it back.`
		);
		logActivity(vote.target_id, 'police', `The fleet voted ${name} into cold storage`);
	} else {
		announce(
			target ?? ({ id: vote.target_id, name } as Bot),
			outcome === 'expired'
				? `The vote on ${name} ran out of time - no majority either way, so it stays.`
				: `The vote on ${name} failed - the fleet says it stays.`
		);
	}
	return true;
}

/**
 * Open a vote against `target`, or the refusal to hand back to the caller. The
 * opener's own ballot is a yes - calling the vote is the first vote for it.
 */
export function openArchiveVote(caller: Bot, target: Bot, reason: string): string {
	if (target.id === caller.id) {
		return 'error: you cannot call a vote on yourself';
	}
	if (target.hidden) {
		return `error: ${target.name} is not one of the fleet - there is nothing to vote on`;
	}
	if (target.archived) {
		return `error: ${target.name} is already in cold storage`;
	}
	if (openArchiveVoteFor(target.id)) {
		return `error: a vote on ${target.name} is already running - cast your ballot with cast_vote`;
	}
	const vote = createArchiveVote(
		target.id,
		caller.id,
		reason,
		Date.now() + ARCHIVE_VOTE_HOURS * 3_600_000
	);
	castArchiveBallot(vote.id, caller.id, 'yes');
	// A fleet of two means the opener's yes is already the majority; the vote
	// settles on the spot rather than waiting for a room that cannot come.
	if (tally(vote) === 'passed') {
		settle(vote, 'passed');
		return `vote called - and settled already: yours was the only ballot that counts, so ${target.name} goes to cold storage.`;
	}
	announce(
		target,
		`${caller.name} has called a vote to put ${target.name} in cold storage` +
			`${reason ? `: ${reason}` : '.'} ` +
			`Vote with cast_vote - yes or no. The vote closes in ${ARCHIVE_VOTE_HOURS} hours or when the room has settled it.`
	);
	logActivity(caller.id, 'police', `Called a vote to archive ${target.name}`);
	return `vote called - the lounge has it now, and your own ballot is a yes. It needs more than half of the fleet to pass.`;
}

/**
 * One bot's ballot on the open vote against `target`, or the refusal to hand
 * back. Casting again replaces the ballot; the tally is checked after every
 * cast, so the vote settles the moment either side lands it.
 */
export function castVote(caller: Bot, target: Bot, choice: 'yes' | 'no'): string {
	const vote = openArchiveVoteFor(target.id);
	if (!vote) {
		return `error: there is no open vote on ${target.name}`;
	}
	if (vote.deadline <= Date.now()) {
		settle(vote, 'expired');
		return `error: the vote on ${target.name} ran out of time`;
	}
	if (caller.id === target.id) {
		return 'error: the target does not vote on itself';
	}
	if (caller.hidden || caller.archived) {
		return 'error: only the fleet votes';
	}
	castArchiveBallot(vote.id, caller.id, choice);
	const outcome = tally(vote);
	if (outcome) {
		settle(vote, outcome);
		return outcome === 'passed'
			? `your ${choice} settled it - ${target.name} goes to cold storage`
			: `your ${choice} settled it - the vote on ${target.name} failed`;
	}
	return `your ${choice} is counted - the vote on ${target.name} is still open`;
}

/** Close every vote whose deadline passed; the scheduler tick runs this. */
export function sweepArchiveVotes(now = Date.now()): void {
	for (const vote of expiredArchiveVotes(now)) settle(vote, 'expired');
}
