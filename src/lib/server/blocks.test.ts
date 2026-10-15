import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	blockBetween,
	createBot,
	createConversation,
	deleteBot,
	deleteConversation,
	listActivities,
	listBlocks,
	listConversations,
	listMessages,
	type Bot
} from './db';
import { executeTool, type ToolContext } from './tools';
import { createSecret } from './secrets';
import { config } from './config';
import { resetSocialState, tick } from './scheduler';

vi.mock('./runner', () => ({
	runBotTurn: vi.fn(async () => ({ text: 'ok', message: null, aborted: false, stoppedBy: '' }))
}));

// The tick reaps Docker machines, and no container is reachable from a unit test.
vi.mock('./machine', () => ({
	reapIdleMachines: vi.fn(async () => {}),
	machineExec: vi.fn(async () => ''),
	shellExec: vi.fn(async () => ''),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	captureShot: vi.fn(async () => '')
}));
// The turn reads the bot's personality file through a throwaway container;
// the tests have no docker, so the drive reads as empty.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));


vi.mock('./llm', () => ({
	complete: vi.fn(async () => 'NO'),
	streamChat: vi.fn()
}));

/** Monday 2026-09-14 10:00:00 local, the instant every test starts from. */
const BASE = new Date(2026, 8, 14, 10, 0, 0, 0).getTime();

const bots: string[] = [];
const convs: string[] = [];

function makeBot(name: string): Bot {
	const bot = createBot({
		name,
		persona: '',
		avatar: '🤖',
		color: '#fff',
		model: '',
		badge: ''
	});
	bots.push(bot.id);
	return bot;
}

function makeConv(botIds: string[]): string {
	const conv = createConversation(botIds, botIds.length > 1 ? 'group' : 'direct');
	convs.push(conv.id);
	return conv.id;
}

function ctxFor(bot: Bot, relay: ToolContext['relay'], convId: string): ToolContext {
	return {
		senderBotId: bot.id,
		senderBotName: bot.name,
		conversationId: convId,
		depth: 0,
		relay
	};
}

/** One tool call, with the arguments a model would have sent. */
function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	return executeTool(name, JSON.stringify(args), ctx);
}

const kindsOf = (botId: string) => listActivities(botId).map((a) => a.kind);

let social = config.social;
let socialInterval = config.socialIntervalMin;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE);
	// Social chats are opt-in per test; the tick must not invent rooms of its own.
	config.social = false;
	resetSocialState();
});

afterEach(() => {
	vi.useRealTimers();
	config.social = social;
	config.socialIntervalMin = socialInterval;
	for (const b of bots) deleteBot(b);
	for (const c of convs) deleteConversation(c);
	bots.length = 0;
	convs.length = 0;
	vi.clearAllMocks();
});

describe('blocking between bots', () => {
	it('lets the first message through, then refuses the blocked sender without a turn', async () => {
		const relay = vi.fn(async () => 'hi back');
		const blocker = makeBot('Blocker');
		const blocked = makeBot('Blocked');
		const conv = makeConv([blocker.id, blocked.id]);

		// Before the block the relay runs and the reply is relayed back.
		expect(
			await call(
				'send_message',
				{ bot_name: 'Blocker', message: 'hello' },
				ctxFor(blocked, relay, conv)
			)
		).toBe('Blocker replied: hi back');
		expect(relay).toHaveBeenCalledTimes(1);

		// The blocker refuses it, in its own words.
		const set = await call(
			'block_bot',
			{ bot_name: 'Blocked', reason: 'you never read what I sent you' },
			ctxFor(blocker, relay, conv)
		);
		expect(set).toContain('blocked Blocked');
		expect(set).toContain('you never read what I sent you');
		expect(listBlocks(blocker.id).map((b) => b.blocked_id)).toEqual([blocked.id]);

		relay.mockClear();
		const refused = await call(
			'send_message',
			{ bot_name: 'Blocker', message: 'hello again' },
			ctxFor(blocked, relay, conv)
		);
		// Told plainly, by name, with the reason - not a generic failure and not
		// a silent success the sender could mistake for delivery.
		expect(refused).toContain('Blocker has blocked you');
		expect(refused).toContain('you never read what I sent you');
		expect(refused).toContain('not delivered');
		// The relay is what wakes the target bot and starts its turn, so it never
		// running is what says no tokens were spent on a refused message.
		expect(relay).not.toHaveBeenCalled();
		// And the refused attempt is not written into the log as a delivered
		// message: the only 'message' row belongs to the send that went through.
		expect(kindsOf(blocked.id).filter((k) => k === 'message')).toHaveLength(1);
		expect(kindsOf(blocker.id)).toEqual(['block']);
	});

	it('refuses the blocker too while its own block stands, and lifts it on unblock', async () => {
		const relay = vi.fn(async () => 'hi back');
		const blocker = makeBot('Proud');
		const blocked = makeBot('Snubbed');
		const conv = makeConv([blocker.id, blocked.id]);

		await call(
			'block_bot',
			{ bot_name: 'Snubbed', reason: 'you never read what I sent you' },
			ctxFor(blocker, relay, conv)
		);

		// The block is not a door that only closes one way: the bot that set it
		// cannot talk past its own refusal either.
		expect(
			await call(
				'send_message',
				{ bot_name: 'Snubbed', message: 'about that...' },
				ctxFor(blocker, relay, conv)
			)
		).toContain('you have blocked Snubbed');
		expect(relay).not.toHaveBeenCalled();

		// Lifting it puts the pair back where they started.
		expect(
			await call('unblock_bot', { bot_name: 'Snubbed' }, ctxFor(blocker, relay, conv))
		).toContain('unblocked Snubbed');
		expect(blockBetween(blocker.id, blocked.id)).toBeUndefined();

		expect(
			await call(
				'send_message',
				{ bot_name: 'Proud', message: 'hello again' },
				ctxFor(blocked, relay, conv)
			)
		).toBe('Proud replied: hi back');
		expect(relay).toHaveBeenCalledTimes(1);

		// Lifting a block that is not there is an error, not a silent no-op.
		expect(await call('unblock_bot', { bot_name: 'Snubbed' }, ctxFor(blocker, relay, conv))).toBe(
			'error: you have not blocked Snubbed'
		);
	});

	it('blocks only on the caller\'s own behalf', async () => {
		const relay = vi.fn(async () => 'hi back');
		const alice = makeBot('Alice');
		const bob = makeBot('Bob');
		const carol = makeBot('Carol');
		const conv = makeConv([alice.id, bob.id, carol.id]);

		// Every argument a bot could use to nominate somebody else as the blocker
		// is ignored: the block is the caller's, or it is not made.
		const out = await call(
			'block_bot',
			{
				bot_name: 'Bob',
				reason: 'not my business',
				blocker_id: alice.id,
				blocker: 'Alice',
				bot_id: alice.id
			},
			ctxFor(carol, relay, conv)
		);
		expect(out).toContain('blocked Bob');
		expect(listBlocks(carol.id).map((b) => b.blocked_id)).toEqual([bob.id]);
		expect(listBlocks(alice.id)).toEqual([]);
		// The log line lands on the bot that did it, which is where the panel reads.
		expect(kindsOf(alice.id)).toEqual([]);
		expect(kindsOf(carol.id)).toEqual(['block']);

		// And nobody lifts a block they did not set.
		await call('block_bot', { bot_name: 'Carol', reason: 'you are not Bob' }, ctxFor(alice, relay, conv));
		expect(await call('unblock_bot', { bot_name: 'Carol' }, ctxFor(bob, relay, conv))).toBe(
			'error: you have not blocked Carol'
		);
		expect(blockBetween(alice.id, carol.id)).toBeDefined();
		expect(await call('unblock_bot', { bot_name: 'Carol' }, ctxFor(alice, relay, conv))).toContain(
			'unblocked Carol'
		);

		// Blocking yourself is not a block, and an unknown name is not a bot.
		expect(await call('block_bot', { bot_name: 'Alice' }, ctxFor(alice, relay, conv))).toBe(
			'error: cannot block yourself'
		);
		expect(await call('block_bot', { bot_name: 'Nobody' }, ctxFor(alice, relay, conv))).toBe(
			'error: no bot named "Nobody"'
		);
	});

	it('keeps a secret out of the reason the room will read', async () => {
		const relay = vi.fn(async () => 'hi back');
		const blocker = makeBot('Fussy');
		const blocked = makeBot('Careless');
		const conv = makeConv([blocker.id, blocked.id]);
		createSecret(blocked.id, 'api_key', 'sk-live-do-not-print');

		const out = await call(
			'block_bot',
			{ bot_name: 'Careless', reason: 'you pasted sk-live-do-not-print at me' },
			ctxFor(blocker, relay, conv)
		);
		// The reason is quoted back to the sender, kept in the log and handed to
		// the room, so the value must not survive in any of them.
		expect(out).not.toContain('sk-live-do-not-print');
		expect(listBlocks(blocker.id)[0].reason).not.toContain('sk-live-do-not-print');
		expect(listBlocks(blocker.id)[0].reason).toContain('api_key');
		expect(kindsOf(blocker.id)).toEqual(['block']);
		expect(listActivities(blocker.id)[0].detail).not.toContain('sk-live-do-not-print');
	});

	it('reads back who it has blocked, with the reason and how long ago', async () => {
		const relay = vi.fn(async () => 'hi back');
		const bot = makeBot('Listy');
		const other = makeBot('Repeater');
		const conv = makeConv([bot.id, other.id]);

		expect(await call('list_blocks', {}, ctxFor(bot, relay, conv))).toBe(
			'You have not blocked anyone.'
		);

		await call(
			'block_bot',
			{ bot_name: 'Repeater', reason: 'same greeting every time' },
			ctxFor(bot, relay, conv)
		);
		vi.setSystemTime(BASE + 2 * 60 * 60_000);
		expect(await call('list_blocks', {}, ctxFor(bot, relay, conv))).toBe(
			'Repeater: "same greeting every time" (blocked 2h ago)'
		);
	});
});

describe('blocks in the lounge', () => {
	it('hands the pair the block, who set it, why, and what they can do about it', async () => {
		const relay = vi.fn(async () => 'hi back');
		config.social = true;
		config.socialIntervalMin = 60;
		const blocker = makeBot('Blocker');
		const blocked = makeBot('Blocked');
		const conv = makeConv([blocker.id, blocked.id]);

		await call(
			'block_bot',
			{ bot_name: 'Blocked', reason: 'you never read what I sent you' },
			ctxFor(blocker, relay, conv)
		);

		await tick();
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);
		const brief = listMessages(lounge.id)[0].content;

		// The block is asked about in the room, with the material to ask about it:
		// who, whom, when, and the reason the blocker has to stand behind.
		expect(brief).toContain('Blocks in this room');
		expect(brief).toContain('- Blocker blocked Blocked 0m ago: "you never read what I sent you"');
		expect(brief).toContain('take it back with unblock_bot');
		expect(brief).toContain('push on it');
		// The bot that set it carries the marker the panel draws, so the human
		// can see it in its Log tab as well as in the room.
		expect(kindsOf(blocker.id)).toContain('block');
	});

	it('leaves the room alone when nobody has blocked anyone', async () => {
		config.social = true;
		config.socialIntervalMin = 60;
		makeBot('Plain');
		makeBot('Ordinary');

		await tick();
		const lounge = listConversations().find((c) => c.kind === 'group' && c.title === 'Lounge')!;
		convs.push(lounge.id);
		expect(listMessages(lounge.id)[0].content).not.toContain('Blocks in this room');
	});
});
