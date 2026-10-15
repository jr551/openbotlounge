import { beforeAll, describe, expect, it } from 'vitest';
import {
	addFeedback,
	addMessage,
	addReaction,
	conversationBots,
	createBot,
	createConversation,
	createPlugin,
	createRoutine,
	createTask,
	deleteBot,
	deleteMessage,
	listMemories,
	deleteConversation,
	deleteLastAssistantMessage,
	dueRoutines,
	listRoutines,
	finishTask,
	getBot,
	getPlugin,
	botPairConversation,
	listContextMessages,
	migrateRelayMessages,
	collapseContext,
	db,
	getTask,
	listActivities,
	listBots,
	listConversations,
	listMessages,
	listMessagesPage,
	listTasks,
	listVisibleBots,
	logActivity,
	pendingFeedback,
	reactionsFor,
	setMemory,
	setMessageRating,
	setRoutineEnabled,
	updateBot,
	taskModels,
	updateConversation
} from './db';
import { createSecret, getSecret, shareSecret } from './secrets';

let botId = '';
let bot2Id = '';
let convId = '';

beforeAll(() => {
	const b = createBot({
		name: 'TestBot',
		persona: 'test persona',
		avatar: '🤖',
		color: '#fff',
		model: 'm1',
		badge: ''
	});
	botId = b.id;
	const b2 = createBot({
		name: 'OtherBot',
		persona: '',
		avatar: '🦊',
		color: '#f00',
		model: '',
		badge: ''
	});
	bot2Id = b2.id;
	const c = createConversation([botId, bot2Id], 'group');
	convId = c.id;
});

describe('bots', () => {
	it('creates and lists bots', () => {
		const bots = listBots();
		expect(bots.map((b) => b.name)).toContain('TestBot');
		expect(getBot(botId)?.persona).toBe('test persona');
	});

	it('updates a bot', () => {
		// Its own bot, not the shared one: renaming the fixture made the test
		// above fail whenever this one happened to run first.
		const own = createBot({
			name: 'RenameMe',
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		updateBot(own.id, { name: 'Renamed' });
		expect(getBot(own.id)?.name).toBe('Renamed');
	});
});

describe('conversations', () => {
	it('creates a group conversation with members', () => {
		const convs = listConversations();
		const c = convs.find((x) => x.id === convId);
		expect(c?.kind).toBe('group');
		expect(c?.bot_ids.split(',').sort()).toEqual([botId, bot2Id].sort());
		expect(conversationBots(convId)).toHaveLength(2);
	});

	it('renames a conversation', () => {
		updateConversation(convId, { title: 'Renamed chat' });
		expect(listConversations().find((c) => c.id === convId)?.title).toBe('Renamed chat');
	});
});

describe('messages', () => {
	it('stores messages with bot attribution', () => {
		// Its own conversation: counting messages in the shared one only worked
		// while no other test had written to it yet.
		const own = createConversation([botId], 'direct');
		addMessage(own.id, 'user', 'hello');
		addMessage(own.id, 'assistant', 'hi back', botId, 'm1');
		const msgs = listMessages(own.id);
		expect(msgs).toHaveLength(2);
		expect(msgs[1].bot_id).toBe(botId);
		expect(msgs[1].model).toBe('m1');
	});

	it('rates a message', () => {
		const m = addMessage(convId, 'assistant', 'rate me', botId);
		setMessageRating(m.id, 1);
		expect(listMessages(convId).find((x) => x.id === m.id)?.rating).toBe(1);
		setMessageRating(m.id, 0);
		expect(listMessages(convId).find((x) => x.id === m.id)?.rating).toBe(0);
	});

	// The 8-character cap is on emoji, not on UTF-16 units: slicing by index
	// cuts a multi-codepoint emoji in half and leaves a broken glyph behind.
	it('keeps a multi-codepoint emoji whole', () => {
		const m = addMessage(convId, 'assistant', 'react to me', botId);
		const family = '👨‍👩‍👧‍👦';
		addReaction(m.id, '', family);
		expect(reactionsFor(convId)[m.id][0].emoji).toBe(family);
	});

	// The cap counts grapheme clusters, not code points: a run of flags is one
	// cluster each but several code points, and the cut must land between them.
	it('truncates a long reaction on a grapheme boundary', () => {
		const m = addMessage(convId, 'assistant', 'react to me too', botId);
		const flags = '🇫🇷🇩🇪🇯🇵🇧🇷🇨🇦🇮🇹🇪🇸🇬🇧🇺🇸';
		addReaction(m.id, '', flags);
		expect(reactionsFor(convId)[m.id][0].emoji).toBe('🇫🇷🇩🇪🇯🇵🇧🇷🇨🇦🇮🇹🇪🇸🇬🇧');
	});

	it('deletes only the last assistant message', () => {
		addMessage(convId, 'assistant', 'first', botId);
		const last = addMessage(convId, 'assistant', 'second', bot2Id);
		deleteLastAssistantMessage(convId);
		const contents = listMessages(convId).map((m) => m.content);
		expect(contents).toContain('first');
		expect(contents).not.toContain('second');
		expect(listMessages(convId).find((m) => m.id === last.id)).toBeUndefined();
	});

	// A deleted reply used to leave its feedback and its task's message_id
	// pointing at a row that no longer exists.
	it('clears the feedback and task reference when a message is deleted', () => {
		const conv = createConversation([botId], 'direct');
		const reply = addMessage(conv.id, 'assistant', 'rate me', botId);
		addFeedback(botId, reply.id, 1, 'rate me');
		const task = createTask(conv.id, botId, 'a turn');
		finishTask(task.id, 'done', { messageId: reply.id });

		deleteMessage(reply.id);

		expect(pendingFeedback(botId)).toHaveLength(0);
		expect(getTask(task.id)?.message_id).toBe('');
	});

	it('does the same when the newest reply is deleted as a regeneration', () => {
		const conv = createConversation([botId], 'direct');
		const reply = addMessage(conv.id, 'assistant', 'regenerate me', botId);
		addFeedback(botId, reply.id, -1, 'regenerate me');
		const task = createTask(conv.id, botId, 'a turn');
		finishTask(task.id, 'done', { messageId: reply.id });

		deleteLastAssistantMessage(conv.id);

		expect(pendingFeedback(botId)).toHaveLength(0);
		expect(getTask(task.id)?.message_id).toBe('');
	});

	it('pages a long transcript newest-first and reports what is left', () => {
		const bot = createBot({ name: 'pager', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		for (let i = 0; i < 5; i++) addMessage(conv.id, 'user', `m${i}`);

		const first = listMessagesPage(conv.id, { limit: 3 });
		expect(first.messages.map((m) => m.content)).toEqual(['m2', 'm3', 'm4']);
		expect(first.hasMore).toBe(true);

		const rest = listMessagesPage(conv.id, {
			beforeId: first.messages[0].id,
			beforeTs: first.messages[0].created_at,
			limit: 3
		});
		expect(rest.messages.map((m) => m.content)).toEqual(['m0', 'm1']);
		expect(rest.hasMore).toBe(false);
	});

	// Messages written in the same millisecond share a created_at; a cursor that
	// only compared the timestamp would skip the ones stamped with the anchor's.
	it('pages messages that share the anchor’s millisecond', () => {
		const bot = createBot({ name: 'pager2', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const a = addMessage(conv.id, 'user', 'a');
		const b = addMessage(conv.id, 'user', 'b');
		const c = addMessage(conv.id, 'user', 'c');
		db.prepare('UPDATE messages SET created_at = ? WHERE id IN (?,?,?)').run(
			1000,
			a.id,
			b.id,
			c.id
		);

		const page = listMessagesPage(conv.id, { beforeId: c.id, beforeTs: 1000, limit: 10 });
		expect(page.messages.map((m) => m.content)).toEqual(['a', 'b']);
		expect(page.hasMore).toBe(false);
	});

	// A deleted anchor leaves only its timestamp; the bound is then inclusive so
	// same-millisecond neighbours are not lost, and the caller drops the overlap.
	it('pages by timestamp alone when the anchor message is gone', () => {
		const bot = createBot({ name: 'pager3', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const a = addMessage(conv.id, 'user', 'a');
		const b = addMessage(conv.id, 'user', 'b');
		const c = addMessage(conv.id, 'user', 'c');
		db.prepare('UPDATE messages SET created_at = ? WHERE id IN (?,?,?)').run(
			1000,
			a.id,
			b.id,
			c.id
		);
		deleteMessage(c.id);

		const page = listMessagesPage(conv.id, { beforeId: c.id, beforeTs: 1000, limit: 10 });
		expect(page.messages.map((m) => m.content)).toEqual(['a', 'b']);
	});

	// A cursor id from another conversation used to resolve to that message's
	// timestamp and silently skip the rows between; it is now ignored, and with
	// no timestamp to fall back on the page is empty rather than the newest rows
	// the caller already holds.
	it('ignores a cursor id that belongs to another conversation', () => {
		const bot = createBot({ name: 'pager6', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const mine = addMessage(conv.id, 'user', 'mine');
		// A different bot, so this is a genuinely separate conversation rather
		// than the same DM handed back.
		const otherBot = createBot({ name: 'pager7', persona: '', avatar: '', color: '', model: '', badge: '' });
		const other = createConversation([otherBot.id], 'direct');
		const foreign = addMessage(other.id, 'user', 'foreign');

		const page = listMessagesPage(conv.id, { beforeId: foreign.id, limit: 10 });
		expect(page.messages).toEqual([]);
		expect(page.hasMore).toBe(false);

		// With a timestamp the foreign id is ignored and the timestamp bounds the page.
		const byTs = listMessagesPage(conv.id, {
			beforeId: foreign.id,
			beforeTs: mine.created_at + 1,
			limit: 10
		});
		expect(byTs.messages.map((m) => m.content)).toEqual(['mine']);
	});

	// A regenerate deletes the reply while its task may still be running; the
	// task finishing afterwards must not write the dead id back.
	it('does not let a finishing task resurrect a deleted message id', () => {
		const bot = createBot({ name: 'pager4', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const reply = addMessage(conv.id, 'assistant', 'gone', botId);
		const task = createTask(conv.id, botId, 'a turn');

		deleteMessage(reply.id);
		finishTask(task.id, 'done', { messageId: reply.id });

		expect(getTask(task.id)?.message_id).toBe('');
	});

	it('still records the reply a finished task wrote', () => {
		const bot = createBot({ name: 'pager5', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const reply = addMessage(conv.id, 'assistant', 'here', botId);
		const task = createTask(conv.id, botId, 'a turn');

		finishTask(task.id, 'done', { messageId: reply.id });

		expect(getTask(task.id)?.message_id).toBe(reply.id);
	});

	// The spend breakdown prices a task against the model its reply names; a
	// task with no reply - still running, or its message deleted - has no
	// attribution and must not appear in the map at all.
	it('attributes a task to the model its reply names', () => {
		const bot = createBot({ name: 'pager6', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const served = addMessage(conv.id, 'assistant', 'priced reply', bot.id, 'served/m2');
		const priced = createTask(conv.id, bot.id, 'a turn');
		finishTask(priced.id, 'done', { messageId: served.id });
		const running = createTask(conv.id, bot.id, 'still going');

		const models = taskModels(bot.id);
		expect(models[priced.id]).toBe('served/m2');
		expect(models[running.id]).toBeUndefined();
	});
});

describe('routines', () => {
	it('creates, schedules, disables and deletes routines', () => {
		const r = createRoutine({
			bot_id: botId,
			conversation_id: convId,
			name: 'Ping',
			prompt: 'say ping',
			interval_min: 5,
			cron: '',
			enabled: 1
		});
		expect(listRoutines(botId).map((x) => x.id)).toContain(r.id);
		expect(dueRoutines(r.next_run_at + 1).map((x) => x.id)).toContain(r.id);
		expect(dueRoutines(r.next_run_at - 1).map((x) => x.id)).not.toContain(r.id);
		setRoutineEnabled(r.id, false);
		expect(dueRoutines(Date.now() + 10_000_000).map((x) => x.id)).not.toContain(r.id);
	});
});

describe('activities', () => {
	it('logs and lists activities per bot', () => {
		logActivity(botId, 'thinking', 'working on it');
		const acts = listActivities(botId);
		expect(acts[0].kind).toBe('thinking');
		expect(acts[0].detail).toBe('working on it');
	});

	// A turn outlives its bot: deleteBot clears the log, but work still running
	// for it would write fresh rows for a bot that no longer exists.
	it('drops an activity logged for a bot that is gone', () => {
		const ghost = createBot({ name: 'ghost', persona: '', avatar: '', color: '', model: '', badge: '' });
		deleteBot(ghost.id);
		logActivity(ghost.id, 'error', 'a turn finishing after the delete');
		expect(listActivities(ghost.id)).toHaveLength(0);
	});

	it('still logs the system’s own activities', () => {
		logActivity('', 'system', 'housekeeping');
		const rows = db
			.prepare("SELECT * FROM activities WHERE bot_id = '' AND kind = 'system'")
			.all() as unknown as { detail: string }[];
		expect(rows.some((r) => r.detail === 'housekeeping')).toBe(true);
	});
});

describe('deletion', () => {
	it('cascades conversation deletion to messages and members', () => {
		const c = createConversation([botId], 'direct');
		addMessage(c.id, 'user', 'bye');
		deleteConversation(c.id);
		expect(listMessages(c.id)).toHaveLength(0);
		expect(conversationBots(c.id)).toHaveLength(0);
	});

	// A direct chat exists only for its bot, so it must go with the bot or it
	// stays in the sidebar as a blank row nobody can open.
	it('takes the bot\'s direct conversation with it', () => {
		const solo = createBot({ name: 'solo', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([solo.id], 'direct');
		expect(listConversations().some((c) => c.id === conv.id)).toBe(true);

		deleteBot(solo.id);
		expect(listConversations().some((c) => c.id === conv.id)).toBe(false);
	});

	// Neither table has a foreign key onto bots, so nothing else ever cleared them.
	it('takes the bot\'s memories and activity log with it', () => {
		const solo = createBot({ name: 'forgetful', persona: '', avatar: '', color: '', model: '', badge: '' });
		setMemory(solo.id, 'colour', 'teal');
		logActivity(solo.id, 'replied', 'something it did');

		deleteBot(solo.id);

		expect(listMemories(solo.id)).toHaveLength(0);
		expect(listActivities(solo.id)).toHaveLength(0);
	});

	it('reports whether the bot was there, so the route can answer 404', () => {
		const solo = createBot({ name: 'gone', persona: '', avatar: '', color: '', model: '', badge: '' });
		expect(deleteBot(solo.id)).toBe(true);
		expect(deleteBot(solo.id)).toBe(false);
	});

	it('drops the deleted bot from the shares other bots granted it', () => {
		const owner = createBot({ name: 'shareowner', persona: '', avatar: '', color: '', model: '', badge: '' });
		const guest = createBot({ name: 'shareguest', persona: '', avatar: '', color: '', model: '', badge: '' });
		createSecret(owner.id, 'api_key', 'hunter2');
		expect(shareSecret(owner.id, 'api_key', guest.id)).toBe(true);
		expect(getSecret(owner.id, 'api_key')?.shared_with).toBe(guest.id);

		deleteBot(guest.id);

		// The share list is a CSV of bot ids; a deleted one must not linger in it
		// or the next read reports a grant to a bot that no longer exists.
		expect(getSecret(owner.id, 'api_key')?.shared_with).toBe('');
	});

	it('keeps a shared plugin but forgets the author that wrote it', () => {
		const author = createBot({ name: 'author', persona: '', avatar: '', color: '', model: '', badge: '' });
		const plugin = createPlugin({
			name: 'shared-but-orphaned',
			description: '',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: '',
			author_bot_id: author.id,
			scope: 'shared',
			enabled: 1
		});

		deleteBot(author.id);

		// The user owns a shared plugin, so it outlives the bot - but the row
		// must not keep naming an author that is gone.
		expect(getPlugin(plugin.id)).toBeDefined();
		expect(getPlugin(plugin.id)?.author_bot_id).toBe('');
	});
});


describe('task retention', () => {
	// One row per turn with nothing ever removing them; the tray only shows the
	// recent ones, so the rest were dead weight that grew without limit.
	it(
		'keeps a bounded number of finished tasks and drops the oldest',
		() => {
			const bot = createBot({ name: 'tasks', persona: '', avatar: '', color: '', model: '', badge: '' });
			const conv = createConversation([bot.id], 'direct');

			let firstId = '';
			for (let i = 0; i < 2100; i++) {
				const task = createTask(conv.id, bot.id, `turn ${i}`);
				if (i === 0) firstId = task.id;
				finishTask(task.id, 'done', { messageId: '' });
			}

			expect(listTasks().length).toBeLessThanOrEqual(2000);
			expect(getTask(firstId)).toBeUndefined();
		},
		// 2100 inserts each trigger a retention scan; that is the point, and it
		// needs real time under load - well past the default 5s.
		60_000
	);

	it(
		'never drops a task that is still running',
		() => {
			const bot = createBot({ name: 'tasks2', persona: '', avatar: '', color: '', model: '', badge: '' });
			const conv = createConversation([bot.id], 'direct');
			const running = createTask(conv.id, bot.id, 'still going');

			// Past the 2000-row retention cap so the trim really runs; the running
			// task is the oldest row, so it is the first thing it would delete.
			for (let i = 0; i < 2050; i++) {
				const task = createTask(conv.id, bot.id, `turn ${i}`);
				finishTask(task.id, 'done', { messageId: '' });
			}

			expect(getTask(running.id)?.status).toBe('running');
		},
		// 2050 inserts each trigger a retention scan; that is the point, and it
		// needs real time under load - well past the default 5s.
		60_000
	);
});

describe('bot-to-bot messages', () => {
	/** A human's DM with one bot, the way the chat route makes one. */
	function dmWith(botId: string) {
		return createConversation([botId], 'direct');
	}

	it('moves a relay and the reply it provoked out of the human DM', () => {
		const human = createBot({ name: 'DmOwner', persona: '', avatar: '', color: '', model: '', badge: '' });
		const other = createBot({ name: 'OtherBot', persona: '', avatar: '', color: '', model: '', badge: '' });
		const dm = dmWith(human.id);
		addMessage(dm.id, 'user', 'what are you working on?');
		addMessage(dm.id, 'assistant', 'a report', human.id);
		// What an earlier build wrote into the human's DM: another bot's message
		// and the answer it got.
		addMessage(dm.id, 'user', 'ping', other.id, '', 0, 'relay');
		addMessage(dm.id, 'assistant', 'pong', human.id);
		addMessage(dm.id, 'user', 'thanks');

		expect(migrateRelayMessages()).toBe(2);

		// The human's thread keeps its own lines, without the pair's exchange.
		expect(listMessages(dm.id).map((m) => m.content)).toEqual([
			'what are you working on?',
			'a report',
			'thanks'
		]);
		const room = botPairConversation(human.id, other.id);
		expect(room.private).toBe(1);
		// Named so the list cannot read it as another lounge.
		expect(room.title).toBe('DmOwner ⇄ OtherBot (bots only)');
		expect(conversationBots(room.id).map((b) => b.id).sort()).toEqual(
			[human.id, other.id].sort()
		);
		expect(listMessages(room.id).map((m) => m.content)).toEqual(['ping', 'pong']);
		// Running it again moves nothing: there are no relay rows left to find.
		expect(migrateRelayMessages()).toBe(0);
	});

	it('hands the model same-millisecond rows in a stable order', () => {
		const bot = createBot({ name: 'Ordering', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		// One timestamp, two rows: the police write-up and the app prompt under it
		// landed together, and without a tiebreak the model read them either way.
		db.prepare(
			'INSERT INTO messages (id, conversation_id, role, content, model, rating, created_at, bot_id, excluded, ping, kind, reply_to) VALUES (?,?,?,?,?,?,?,?,0,0,\'\',\'\')'
		).run('same-ms-1', conv.id, 'assistant', 'first', '', 0, 1_700_000_000_000, bot.id);
		db.prepare(
			'INSERT INTO messages (id, conversation_id, role, content, model, rating, created_at, bot_id, excluded, ping, kind, reply_to) VALUES (?,?,?,?,?,?,?,?,0,0,\'\',\'\')'
		).run('same-ms-2', conv.id, 'user', 'second', '', 0, 1_700_000_000_000, '');

		expect(listContextMessages(conv.id).map((m) => m.content)).toEqual(['first', 'second']);
	});

	it('shows the pair room’s relays in the resident’s DM page', () => {
		const human = createBot({ name: 'DmReader', persona: '', avatar: '', color: '', model: '', badge: '' });
		const other = createBot({ name: 'RelayPal', persona: '', avatar: '', color: '', model: '', badge: '' });
		const dm = dmWith(human.id);
		const room = botPairConversation(human.id, other.id);
		const mine = addMessage(dm.id, 'user', 'my own line');
		// The pair's ordinary chatter stays in the pair's room; only a relay
		// row is DM material, and it names its recipient.
		const chatter = addMessage(room.id, 'assistant', 'pair chatter', other.id);
		const relay = addMessage(room.id, 'user', 'Message from RelayPal: over here', other.id, '', 0, 'relay', '', human.id);
		db.prepare('UPDATE messages SET created_at = 1000 WHERE id = ?').run(mine.id);
		db.prepare('UPDATE messages SET created_at = 2000 WHERE id = ?').run(chatter.id);
		db.prepare('UPDATE messages SET created_at = 3000 WHERE id = ?').run(relay.id);

		const page = listMessagesPage(dm.id);
		expect(page.messages.map((m) => m.content)).toEqual(['my own line', 'Message from RelayPal: over here']);
		expect(page.messages[1].kind).toBe('relay');
		expect(page.messages[1].bot_id).toBe(other.id);
		expect(page.messages[1].relay_to).toBe(human.id);

		// Paging back from the relay crosses the room boundary seamlessly.
		const earlier = listMessagesPage(dm.id, { beforeId: relay.id, beforeTs: relay.created_at });
		expect(earlier.messages.map((m) => m.content)).toEqual(['my own line']);
		expect(earlier.hasMore).toBe(false);
	});

	it('keeps the newest exchange out of a full collapse', () => {
		const bot = createBot({ name: 'Folder', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		const oldQ = addMessage(conv.id, 'user', 'older question');
		const oldA = addMessage(conv.id, 'assistant', 'older answer', bot.id);
		const newQ = addMessage(conv.id, 'user', 'newest question');
		const newA = addMessage(conv.id, 'assistant', 'newest answer', bot.id);
		db.prepare('UPDATE messages SET created_at = 1000 WHERE id IN (?,?)').run(oldQ.id, oldA.id);
		db.prepare('UPDATE messages SET created_at = 2000 WHERE id IN (?,?)').run(newQ.id, newA.id);

		collapseContext(conv.id);

		const kept = listMessages(conv.id).filter((m) => !m.excluded).map((m) => m.content);
		expect(kept).toEqual(['newest question', 'newest answer']);
	});
});

describe('the contact list', () => {
	it('offers a hidden system bot\'s DM while keeping it out of the bots list', () => {
		// The police is a hidden bot with a direct chat. The sidebar reads
		// conversations, so the chat is offered as a contact, while every list
		// that offers a bot to schedule, delete or gossip with reads
		// listVisibleBots and skips it.
		const officer = createBot({
			name: 'the police',
			persona: '',
			avatar: '🚨',
			color: '#1e3a8a',
			model: '',
			badge: '',
			hidden: 1
		});
		const dm = createConversation([officer.id], 'direct');
		expect(listConversations().some((c) => c.id === dm.id)).toBe(true);
		expect(listVisibleBots().some((b) => b.id === officer.id)).toBe(false);
	});
});
