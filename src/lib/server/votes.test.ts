import { describe, expect, it } from 'vitest';
import {
	archiveBallots,
	createBot,
	getBot,
	listConversations,
	listMessages,
	listVisibleBots,
	openArchiveVoteFor,
	setBotHidden,
	updateBot,
	type Bot
} from './db';
import { ARCHIVE_VOTE_HOURS, castVote, openArchiveVote, sweepArchiveVotes } from './votes';

let seq = 0;

/** A fleet bot, as the lounge sees it. */
function fleetBot(name?: string): Bot {
	return createBot({
		name: name ?? `voter-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

/** Every bot whose ballot counts for this vote: the visible, live fleet minus
 *  the target. The test database is shared, so the count is read, not assumed. */
function eligible(targetId: string): Bot[] {
	return listVisibleBots().filter((b) => !b.archived && b.id !== targetId);
}

/** The lounge's messages, where the vote is announced and settled. */
function loungeLines(): string[] {
	const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge');
	if (!lounge) return [];
	return listMessages(lounge.id).map((m) => m.content);
}

describe('openArchiveVote', () => {
	it('opens the vote, counts the opener as a yes, and tells the lounge', () => {
		const opener = fleetBot();
		const target = fleetBot();
		// A third eligible voter keeps the vote open: with only the opener
		// eligible, its yes would be the majority and the vote would settle on
		// the spot.
		fleetBot();
		const out = openArchiveVote(opener, target, 'it keeps eating the tokens');
		expect(out).toContain('vote called');
		const vote = openArchiveVoteFor(target.id);
		expect(vote).toBeTruthy();
		expect(vote!.reason).toBe('it keeps eating the tokens');
		expect(vote!.deadline).toBeGreaterThan(Date.now());
		expect(archiveBallots(vote!.id)).toEqual([
			expect.objectContaining({ bot_id: opener.id, choice: 'yes' })
		]);
		expect(loungeLines().some((l) => l.includes('vote to put') && l.includes(target.name))).toBe(true);
	});

	it('refuses a second vote on the same bot while one is open', () => {
		const opener = fleetBot();
		const other = fleetBot();
		const target = fleetBot();
		openArchiveVote(opener, target, 'first');
		expect(openArchiveVote(other, target, 'second')).toContain('already running');
	});

	it('refuses a vote on the caller itself, on the hidden, and on the archived', () => {
		const caller = fleetBot();
		expect(openArchiveVote(caller, caller, 'me')).toContain('yourself');
		const hidden = fleetBot();
		setBotHidden(hidden.id, true);
		expect(openArchiveVote(caller, getBot(hidden.id)!, 'ghost')).toContain('not one of the fleet');
		const gone = fleetBot();
		updateBot(gone.id, { archived: 1 });
		expect(openArchiveVote(caller, getBot(gone.id)!, 'gone')).toContain('already in cold storage');
	});
});

describe('castVote', () => {
	it('archives the target the moment yes exceeds half the fleet', () => {
		const opener = fleetBot();
		const target = fleetBot();
		openArchiveVote(opener, target, 'majority test');
		// The bar is the smallest whole number over half the eligible fleet;
		// the opener's ballot is the first yes, so the rest come from the room.
		const needed = Math.floor(eligible(target.id).length / 2) + 1;
		const voters = eligible(target.id).filter((b) => b.id !== opener.id);
		for (const voter of voters.slice(0, needed - 2)) {
			expect(castVote(voter, target, 'yes')).toContain('still open');
			expect(getBot(target.id)?.archived).toBe(0);
		}
		const last = voters[needed - 2];
		expect(castVote(last, target, 'yes')).toContain('cold storage');
		expect(getBot(target.id)?.archived).toBe(1);
		expect(loungeLines().some((l) => l.includes('goes to cold storage'))).toBe(true);
		// A settled vote takes no more ballots.
		const late = voters[needed - 1];
		if (late) expect(castVote(late, target, 'no')).toContain('no open vote');
	});

	it('fails the vote once enough noes land that yes cannot reach the bar', () => {
		const opener = fleetBot();
		const target = fleetBot();
		openArchiveVote(opener, target, 'minority test');
		// Yes needs floor(n/2)+1; the vote fails the moment the noes make that
		// unreachable, which is n - needed + 1 ballots against.
		const n = eligible(target.id).length;
		const needed = Math.floor(n / 2) + 1;
		const noes = n - needed + 1;
		const voters = eligible(target.id).filter((b) => b.id !== opener.id);
		for (const voter of voters.slice(0, noes - 1)) {
			castVote(voter, target, 'no');
		}
		expect(castVote(voters[noes - 1], target, 'no')).toContain('failed');
		expect(getBot(target.id)?.archived).toBe(0);
		expect(openArchiveVoteFor(target.id)).toBeUndefined();
		expect(loungeLines().some((l) => l.includes('failed'))).toBe(true);
	});

	it('replaces a ballot when a bot votes again', () => {
		const opener = fleetBot();
		const target = fleetBot();
		fleetBot();
		openArchiveVote(opener, target, 'change of heart');
		const vote = openArchiveVoteFor(target.id)!;
		castVote(opener, target, 'no');
		expect(archiveBallots(vote.id)).toEqual([
			expect.objectContaining({ bot_id: opener.id, choice: 'no' })
		]);
	});

	it('refuses the target, the hidden, and the archived a ballot', () => {
		const opener = fleetBot();
		const target = fleetBot();
		fleetBot();
		openArchiveVote(opener, target, 'who votes');
		expect(castVote(target, target, 'no')).toContain('does not vote on itself');
		const hidden = fleetBot();
		setBotHidden(hidden.id, true);
		expect(castVote(getBot(hidden.id)!, target, 'yes')).toContain('only the fleet votes');
		const gone = fleetBot();
		updateBot(gone.id, { archived: 1 });
		expect(castVote(getBot(gone.id)!, target, 'yes')).toContain('only the fleet votes');
	});
});

describe('sweepArchiveVotes', () => {
	it('expires a vote that outlives its deadline and announces it', () => {
		const opener = fleetBot();
		const target = fleetBot();
		fleetBot();
		openArchiveVote(opener, target, 'slow room');
		const vote = openArchiveVoteFor(target.id)!;
		sweepArchiveVotes(vote.deadline + 1);
		expect(openArchiveVoteFor(target.id)).toBeUndefined();
		expect(getBot(target.id)?.archived).toBe(0);
		expect(loungeLines().some((l) => l.includes('ran out of time'))).toBe(true);
	});

	it('leaves a live vote alone', () => {
		const opener = fleetBot();
		const target = fleetBot();
		fleetBot();
		openArchiveVote(opener, target, 'still counting');
		sweepArchiveVotes();
		expect(openArchiveVoteFor(target.id)).toBeTruthy();
	});
});
