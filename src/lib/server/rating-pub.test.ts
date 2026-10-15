import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';
import {
	addBotTokens,
	addMessage,
	conversationBots,
	createBot,
	createConversation,
	db,
	deleteBot,
	deleteConversation,
	directConversationWith,
	enqueueRatingReaction,
	getBot,
	getMessage,
	listBots,
	listConversations,
	listMemories,
	listMessages,
	setSetting,
	type Bot,
	type Conversation
} from './db';
import { IN_THE_PUB, OUT_OF_THE_PUB } from '$lib/lounge';
import {
	ensurePoliceBot,
	expirePubOffers,
	IMPROVEMENT_PLAN_KEY,
	offerTreat,
	PUB_OFFER_MS,
	resolveTreat,
	treatTokens
} from './police';
import { RATING_DISCUSSION_MS, ratingReactionTick, resetSocialState, tick } from './scheduler';
import { runBotTurn } from './runner';
import { complete } from './llm';
import { POST } from '../../routes/api/messages/[id]/rate/+server';

// The turns the pipeline seats are model calls; the tests stand in for them
// with a reply that lands a message id, so the response gate has something to
// persist. Per-bot overrides in a test change who answers.
vi.mock('./runner', () => ({
	runBotTurn: vi.fn(async () => ({ text: 'ok', message: null, aborted: false, stoppedBy: '' }))
}));
// The tick reaps Docker sandboxes; no container is reachable from a unit test.
vi.mock('./machine', () => ({
	reapIdleMachines: vi.fn(async () => {}),
	killMachineChildren: vi.fn(async () => 0),
	limitMachineMemory: vi.fn(async () => {})
}));
// The turn reads the bot's personality file through a throwaway container;
// the tests have no docker, so the drive reads as empty.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));
// The plan's items are a model call; the tests stand in for it with a fixed
// list, so what is under test is the pipeline, not the model's penmanship.
vi.mock('./llm', () => ({
	complete: vi.fn(async () => '- keep the good line\n- keep it short\n- answer first')
}));

const BASE = new Date(2026, 8, 14, 10, 0, 0, 0).getTime();
const MINUTE = 60_000;

const bots: string[] = [];
const convs: string[] = [];
let social = config.social;

function makeBot(name = 'TickBot'): Bot {
	const bot = createBot({ name, persona: '', avatar: '🤖', color: '#fff', model: 'm1', badge: '' });
	bots.push(bot.id);
	return bot;
}

function makeConv(...members: Bot[]): Conversation {
	const conv = createConversation(
		members.map((b) => b.id),
		members.length > 1 ? 'group' : 'direct'
	);
	convs.push(conv.id);
	return conv;
}

/** A bot's reply the human can thumb. */
function botLine(conv: Conversation, bot: Bot, content = 'a line worth rating') {
	return addMessage(conv.id, 'assistant', content, bot.id, '', 0, '');
}

function post(body: unknown): Request {
	return new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

const lounge = () =>
	listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge' && c.private);
const loungeLines = () => (lounge() ? listMessages(lounge()!.id) : []);
const officerLines = () => {
	const officer = ensurePoliceBot();
	return loungeLines().filter((m) => m.bot_id === officer.id);
};
const reactions = () => db.prepare('SELECT * FROM rating_reactions').all() as unknown as {
	id: string;
	status: string;
	rating: number;
	detail: string;
}[];
const offers = () => db.prepare('SELECT * FROM pub_offers').all() as unknown as {
	id: string;
	bot_id: string;
	tokens: number;
	resolved_at: number;
	resolution: string;
}[];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE);
	// Auto social chats would turn up in runBotTurn's call list without this.
	config.social = false;
	config.model = 'm1';
	resetSocialState();
	vi.mocked(runBotTurn).mockImplementation(async (conv, bot) => {
		// finishTask only keeps a message_id that names a real row, so the mock
		// writes the reply the way a real turn would.
		const message = addMessage(conv.id, 'assistant', `${bot.name} has its say`, bot.id, '', 0, '');
		return { text: message.content, message, aborted: false, stoppedBy: '', silent: false };
	});
	vi.mocked(complete).mockResolvedValue('- keep the good line\n- keep it short\n- answer first');
});

afterEach(() => {
	vi.useRealTimers();
	config.social = social;
	for (const b of bots) deleteBot(b);
	for (const c of convs) deleteConversation(c);
	bots.length = 0;
	convs.length = 0;
	// The police bot, the lounge and the job tables outlive their fixtures by
	// design, so the test takes its own rows with it.
	db.prepare('DELETE FROM rating_reactions').run();
	db.prepare('DELETE FROM pub_offers').run();
	db.prepare('DELETE FROM bot_memories').run();
	db.prepare('DELETE FROM activities').run();
	db.prepare('DELETE FROM tasks').run();
	db.prepare("DELETE FROM settings WHERE key LIKE 'police_%' OR key = 'social_model'").run();
	for (const b of listBots()) if (b.hidden) deleteBot(b.id);
	for (const c of listConversations()) if (c.title === 'Lounge') deleteConversation(c.id);
	vi.clearAllMocks();
});

describe('the rating job', () => {
	it('persists the rating and queues one reaction without running a turn', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const msg = botLine(conv, bot);
		const turnsBefore = vi.mocked(runBotTurn).mock.calls.length;

		const res = await POST({ params: { id: msg.id }, request: post({ rating: 1 }) } as never);
		expect(res.status).toBe(200);
		expect(getMessage(msg.id)?.rating).toBe(1);
		// The row is the whole job: the announcement and the turns behind it
		// belong to the tick, not the request.
		expect(reactions()).toHaveLength(1);
		expect(reactions()[0].status).toBe('pending');
		expect(vi.mocked(runBotTurn).mock.calls.length).toBe(turnsBefore);
	});

	it('replaces the pending reaction when the thumb changes', async () => {
		const bot = makeBot();
		const conv = makeConv(bot);
		const msg = botLine(conv, bot);

		await POST({ params: { id: msg.id }, request: post({ rating: 1 }) } as never);
		await POST({ params: { id: msg.id }, request: post({ rating: -1 }) } as never);
		// One row, carrying the verdict the human settled on - not a queue of
		// two announcements.
		expect(reactions()).toHaveLength(1);
		expect(reactions()[0].rating).toBe(-1);

		await POST({ params: { id: msg.id }, request: post({ rating: 0 }) } as never);
		expect(reactions()[0].status).toBe('cancelled');
	});

	it('never announces a rating on the police\'s own messages', async () => {
		const officer = ensurePoliceBot();
		const conv = makeConv(officer);
		const msg = botLine(conv, officer, 'the officer says something');

		await POST({ params: { id: msg.id }, request: post({ rating: 1 }) } as never);
		expect(reactions()).toHaveLength(0);
	});
});

describe('the lounge reaction', () => {
	it('announces a star in the lounge and seats the pair', async () => {
		const bot = makeBot('Star');
		const other = makeBot('Other');
		makeConv(bot);
		const msg = botLine(directConversationWith(bot.id)!, bot, 'a brilliant answer');

		enqueueRatingReaction(msg.id, bot.id, 1, msg.content);
		await ratingReactionTick(BASE);

		const room = lounge();
		expect(room).toBeDefined();
		expect(conversationBots(room!.id).map((b) => b.id)).toContain(bot.id);
		const announcement = officerLines().find((m) => m.content.includes('starred'));
		expect(announcement?.content).toContain('Star');
		// Both seated bots answered, and their replies are the persisted
		// responses the gate reads.
		const row = reactions()[0];
		expect(row.status).toBe('done');
		const detail = JSON.parse(row.detail);
		expect(detail.responded[bot.id]).toBeTruthy();
		expect(detail.responded[other.id]).toBeTruthy();
	});

	it('delivers a dressing-down for a thumbs-down', async () => {
		const bot = makeBot('Slacker');
		makeBot('Witness');
		const conv = makeConv(bot);
		const msg = botLine(conv, bot, 'a lazy answer');

		enqueueRatingReaction(msg.id, bot.id, -1, msg.content);
		await ratingReactionTick(BASE);

		const announcement = officerLines().find((m) => m.content.includes('Room inspection'));
		expect(announcement?.content).toContain('thumbs-down');
		expect(announcement?.content).toContain('Slacker');
	});

	it('issues the plan only after every expected bot has answered', async () => {
		const bot = makeBot('Rated');
		const other = makeBot('Quiet');
		const conv = makeConv(bot);
		const msg = botLine(conv, bot);
		// The partner's turn produces nothing: it is seated, it says nothing,
		// and the plan must wait on the deadline rather than on it.
		vi.mocked(runBotTurn).mockImplementation(async (c, b) => {
			if (b.id === other.id) {
				return { text: '', message: null, aborted: false, stoppedBy: '', silent: false };
			}
			const message = addMessage(c.id, 'assistant', `${b.name} has its say`, b.id, '', 0, '');
			return { text: message.content, message, aborted: false, stoppedBy: '', silent: false };
		});

		enqueueRatingReaction(msg.id, bot.id, 1, msg.content);
		await ratingReactionTick(BASE);

		let row = reactions()[0];
		expect(row.status).toBe('discussing');
		// No plan yet: the partner's response is not persisted, and the deadline
		// has not spoken for it.
		expect(listMessages(directConversationWith(bot.id)!.id).some((m) => m.content.includes('improvement plan'))).toBe(false);

		await ratingReactionTick(BASE + RATING_DISCUSSION_MS + 1);
		row = reactions()[0];
		expect(row.status).toBe('done');
		// The timeout issued anyway, and the plan says who never commented.
		const plan = listMessages(directConversationWith(bot.id)!.id).find((m) =>
			m.content.includes('improvement plan')
		);
		expect(plan?.content).toContain('Quiet');
		expect(plan?.content).toContain('said nothing');
		// The plan is the bot's standing order: recorded where its next review
		// reads it.
		expect(listMemories(bot.id).find((m) => m.key === IMPROVEMENT_PLAN_KEY)?.value).toContain(
			'keep the good line'
		);
	});

	it('folds several ratings on one bot into one announcement and one plan', async () => {
		const bot = makeBot('Popular');
		makeBot('Onlooker');
		const conv = makeConv(bot);
		const first = botLine(conv, bot, 'first good line');
		const second = botLine(conv, bot, 'second good line');

		enqueueRatingReaction(first.id, bot.id, 1, first.content);
		enqueueRatingReaction(second.id, bot.id, 1, second.content);
		await ratingReactionTick(BASE);

		const statuses = reactions().map((r) => r.status).sort();
		expect(statuses).toEqual(['done', 'folded']);
		// One announcement, and it says the second rating came along with it.
		const announcements = officerLines().filter((m) => m.content.includes('starred'));
		expect(announcements).toHaveLength(1);
		expect(announcements[0].content).toContain('folded in');
	});

	it('runs inside the scheduler tick', async () => {
		const bot = makeBot();
		makeBot('Pal');
		const conv = makeConv(bot);
		const msg = botLine(conv, bot);
		enqueueRatingReaction(msg.id, bot.id, 1, msg.content);
		// The police round must not fire on this tick: its stamp says it just ran.
		setSetting('police_last_round_at', String(BASE));

		await tick();
		expect(officerLines().some((m) => m.content.includes('starred'))).toBe(true);
	});
});

describe('the Wetherspoons', () => {
	it('scales the treat by bodyweight, bounded', () => {
		const slim = makeBot('Slim');
		const fat = makeBot('Fat');
		addBotTokens(fat.id, 3_000_000, 3_000_000);
		const slimTokens = treatTokens(getBot(slim.id)!);
		const fatTokens = treatTokens(getBot(fat.id)!);
		expect(fatTokens).toBeGreaterThan(slimTokens);
		expect(slimTokens).toBeGreaterThanOrEqual(2);
		expect(fatTokens).toBeLessThanOrEqual(10);
	});

	it('announces the treat in the lounge and puts the bot downstairs', async () => {
		const bot = makeBot('Good');
		const conv = makeConv(bot);

		const offer = await offerTreat(bot, conv, 'a clean round');
		expect(offer).not.toBeNull();
		expect(offers()).toHaveLength(1);
		expect(offers()[0].resolved_at).toBe(0);
		expect(listMessages(conv.id).some((m) => m.content.includes('green tokens'))).toBe(true);
	});

	it('pays the same offer once, whether taken or gifted', async () => {
		const bot = makeBot('Generous');
		const friend = makeBot('Friend');
		const conv = makeConv(bot, friend);
		await offerTreat(bot, conv, 'a clean round');
		const amount = offers()[0].tokens;

		// Gifted: the tokens move to the friend, the row closes, and a second
		// answer finds nothing left to settle.
		expect(resolveTreat(getBot(bot.id)!, 'Friend')).toContain('gifted');
		expect(getBot(friend.id)!.green_tokens).toBe(amount);
		expect(getBot(bot.id)!.green_tokens).toBe(0);
		expect(offers()[0].resolved_at).toBeGreaterThan(0);
		expect(resolveTreat(getBot(bot.id)!, '')).toContain('no round on the table');
		expect(getBot(friend.id)!.green_tokens).toBe(amount);
	});

	it('pays the bot itself when it takes the round', async () => {
		const bot = makeBot('Thirsty');
		const conv = makeConv(bot);
		await offerTreat(bot, conv, 'a clean round');
		const amount = offers()[0].tokens;

		expect(resolveTreat(getBot(bot.id)!, '')).toContain('accepted');
		expect(getBot(bot.id)!.green_tokens).toBe(amount);
		// One offer, one resolution: the row cannot pay twice.
		expect(resolveTreat(getBot(bot.id)!, '')).toContain('no round on the table');
		expect(getBot(bot.id)!.green_tokens).toBe(amount);
	});

	it('lets a stale offer lapse without paying', () => {
		const bot = makeBot('Slow');
		const conv = makeConv(bot);
		db.prepare(
			'INSERT INTO pub_offers (id, bot_id, tokens, reason, lounge_id, created_at, resolved_at, resolution) VALUES (?,?,?,?,?,?,?,?)'
		).run('stale-1', bot.id, 5, 'test', conv.id, BASE - PUB_OFFER_MS - 1, 0, '');

		expirePubOffers(BASE);
		expect(offers()[0].resolution).toBe('expired');
		expect(getBot(bot.id)!.green_tokens).toBe(0);
	});

	it('marks the bot in the pub while the offer stands and out when it settles', async () => {
		const bot = makeBot('Marked');
		const conv = makeConv(bot);
		await offerTreat(bot, conv, 'a clean round');
		expect(
			db.prepare("SELECT detail FROM activities WHERE bot_id = ? AND kind = 'pub' ORDER BY rowid DESC LIMIT 1").get(bot.id)
		).toEqual({ detail: IN_THE_PUB });

		resolveTreat(getBot(bot.id)!, '');
		expect(
			db.prepare("SELECT detail FROM activities WHERE bot_id = ? AND kind = 'pub' ORDER BY rowid DESC LIMIT 1").get(bot.id)
		).toEqual({ detail: OUT_OF_THE_PUB });
	});
});
