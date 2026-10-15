import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, collapseBlankLines, oneLine } from './chat.svelte';
import type { Bot, Message, Routine } from '$lib/types';

function jsonRes(body: unknown, ok = true) {
	return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

const ROUTINE: Routine = {
	id: 'r1',
	bot_id: 'b1',
	conversation_id: 'c1',
	name: 'Morning',
	prompt: 'Summarise the inbox',
	interval_min: 30,
	cron: '',
	next_run_at: 1,
	enabled: 1,
	created_at: 1
};

const BOT = { id: 'b1', name: 'Bot' } as Bot;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('ChatStore.init', () => {
	it('hydrates social, interval and default model from /api/settings', async () => {
		// Fake timers so the activity interval init() starts never fires.
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/settings') {
					return jsonRes({
						social: false,
						social_interval_min: 15,
						default_model: 'server-model'
					});
				}
				if (url === '/api/models') return jsonRes({ models: ['m-a'], default: 'm-a' });
				if (url === '/api/bots') return jsonRes({ bots: [] });
				if (url === '/api/conversations') return jsonRes({ conversations: [] });
				return jsonRes({});
			})
		);

		await chat.init();

		// Declared defaults are social=true, interval=60, model from /api/models;
		// the stored settings must win or the next Save would clobber them.
		expect(chat.social).toBe(false);
		expect(chat.socialIntervalMin).toBe(15);
		expect(chat.defaultModel).toBe('server-model');
	});

	it('rejects when the server never answered, so the page can say so', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));

		// Resolving here would leave the lobby reading "no bots yet" - the same
		// words a working server with no bots produces - with no way back.
		await expect(chat.init()).rejects.toThrow();
	});
});

describe('ChatStore.updateRoutine', () => {
	it('hands back the route reason and leaves the row as it was when a save is refused', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonRes({ message: 'cron must be a 5-field expression' }, false))
		);
		chat.routines = [{ ...ROUTINE }];

		const reason = await chat.updateRoutine('r1', {
			prompt: 'Water the balcony plants',
			interval_min: 1440,
			cron: 'every morning',
			enabled: true
		});

		expect(reason).toBe('cron must be a 5-field expression');
		expect(chat.routines).toEqual([ROUTINE]);
	});

	it('re-reads the bot after a saved edit, so the row shows what was stored', async () => {
		chat.activeBots = [BOT];
		chat.routines = [{ ...ROUTINE }];
		const stored: Routine = {
			...ROUTINE,
			prompt: 'Water the balcony plants',
			cron: '0 9 * * 1-5',
			interval_min: 1440,
			enabled: 0
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/routines/r1') return jsonRes({ ok: true });
				if (url === '/api/bots/b1') return jsonRes({ routines: [stored] });
				return jsonRes({ wakes: [], waits: [] });
			})
		);

		const reason = await chat.updateRoutine('r1', {
			prompt: 'Water the balcony plants',
			interval_min: 1440,
			cron: '0 9 * * 1-5',
			enabled: false
		});

		expect(reason).toBeNull();
		expect(chat.routines).toEqual([stored]);
	});
});

describe('ChatStore.loadEarlier', () => {
	function msg(id: string, created_at: number) {
		return {
			id,
			conversation_id: 'c1',
			role: 'user' as const,
			bot_id: '',
			content: id,
			model: '',
			rating: 0,
			created_at
		};
	}

	it('pages older messages in above the ones shown, without duplicating them', async () => {
		vi.useFakeTimers();
		const page1 = [msg('m3', 3), msg('m4', 4), msg('m5', 5)];
		const page0 = [msg('m1', 1), msg('m2', 2), msg('m3', 3)];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/conversations/c1') {
					return jsonRes({
						conversation: { id: 'c1' },
						messages: page1,
						has_more: true,
						bots: [],
						reactions: {},
						notes: [],
						marks: []
					});
				}
				if (url.startsWith('/api/conversations/c1?before=')) {
					return jsonRes({ messages: page0, has_more: false });
				}
				if (url.startsWith('/api/tasks')) return jsonRes({ tasks: [] });
				if (url.startsWith('/api/bot-proposals')) return jsonRes({ proposals: [] });
				return jsonRes({});
			})
		);

		await chat.select('c1');
		expect(chat.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5']);
		expect(chat.hasMoreMessages).toBe(true);

		await chat.loadEarlier();

		// The server answered with the overlap included (a deleted anchor leaves
		// only its timestamp, which bounds inclusively); what was already held
		// must not appear twice.
		expect(chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
		expect(chat.hasMoreMessages).toBe(false);
	});

	it('does nothing when the server says there is no earlier page', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (url: string) => {
			if (url === '/api/conversations/c1') {
				return jsonRes({
					conversation: { id: 'c1' },
					messages: [msg('m1', 1)],
					has_more: false,
					bots: [],
					reactions: {},
					notes: [],
					marks: []
				});
			}
			if (url.startsWith('/api/tasks')) return jsonRes({ tasks: [] });
			if (url.startsWith('/api/bot-proposals')) return jsonRes({ proposals: [] });
			return jsonRes({});
		});
		vi.stubGlobal('fetch', fetchMock);

		await chat.select('c1');
		await chat.loadEarlier();

		expect(chat.messages.map((m) => m.id)).toEqual(['m1']);
		expect(
			fetchMock.mock.calls.some(([url]) => String(url).includes('before='))
		).toBe(false);
	});
});

describe('ChatStore.send with a quote', () => {
	const quoted: Message = {
		id: 'm1',
		conversation_id: 'c1',
		role: 'assistant',
		bot_id: 'b1',
		content: 'the line it answers',
		model: '',
		rating: 0,
		excluded: 0,
		kind: '',
		reply_to: '',
		created_at: 1
	};

	it('sends the quoted id alongside clean content, and clears the draft', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
			url === '/api/tasks?conversation_id=c1' ? jsonRes({ tasks: [] }) : jsonRes({ ok: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = quoted;

		await chat.send('yes, that one');

		const post = fetchMock.mock.calls.find(([url]) => String(url) === '/api/chat');
		expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
			content: 'yes, that one',
			reply_to: 'm1'
		});
		// The optimistic bubble carries the quote too, so it reads right before
		// the stored row replaces it.
		expect(chat.messages[0].reply_to).toBe('m1');
		expect(chat.quoteDraft).toBeNull();
	});

	it('leaves reply_to off a send that answers nothing', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
			url === '/api/tasks?conversation_id=c1' ? jsonRes({ tasks: [] }) : jsonRes({ ok: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = null;

		await chat.send('just a line');

		const post = fetchMock.mock.calls.find(([url]) => String(url) === '/api/chat');
		const body = JSON.parse(String(post?.[1]?.body));
		expect(body.content).toBe('just a line');
		expect(body.reply_to).toBeUndefined();
	});

	it('puts a cold-storage refusal in the open thread with the send', async () => {
		const note: Message = {
			id: 'n1',
			conversation_id: 'c1',
			role: 'user',
			bot_id: '',
			content: 'this bot is in cold storage - only the human can unlock it',
			model: '',
			rating: 0,
			excluded: 0,
			kind: 'app',
			reply_to: '',
			created_at: 2
		};
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, _init?: RequestInit) =>
				url === '/api/chat'
					? jsonRes({ conversation_id: 'c1', tasks: [], archived: true, note })
					: jsonRes({ tasks: [] })
			)
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = null;

		await chat.send('are you there?');

		// The refusal is the answer to this send, so it is in the thread without
		// waiting for the next poll that would re-read the conversation.
		expect(chat.messages.map((m) => m.content)).toEqual(['are you there?', note.content]);
	});
});

describe('ChatStore.send that steered a running turn', () => {
	/** A row as the server holds it: the human's own line, no client fields. */
	function stored(id: string, content: string, created_at: number): Message {
		return {
			id,
			conversation_id: 'c1',
			role: 'user',
			bot_id: '',
			content,
			model: '',
			rating: 0,
			kind: '',
			reply_to: '',
			created_at
		};
	}

	it('marks the row the reply names, through every later reload', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === '/api/chat') {
					// The server decides per send: a correction into the running turn
					// rides back as `steered` plus the row the human's line was stored
					// as, a separate ask starts a task of its own.
					const { content } = JSON.parse(String(init?.body));
					const task: { id: string; bot_id: string; steered?: boolean; message_id?: string } = {
						id: 't1',
						bot_id: 'b1'
					};
					if (content === 'actually the blue one') {
						task.steered = true;
						task.message_id = 'm1';
					}
					return jsonRes({ conversation_id: 'c1', tasks: [task] });
				}
				if (url === '/api/conversations/c1') {
					// The reload that follows seconds later: what the server holds.
					return jsonRes({
						conversation: { id: 'c1' },
						messages: [stored('m1', 'actually the blue one', 2), stored('m2', 'also, what time is it?', 3)],
						has_more: false,
						bots: [],
						reactions: {},
						notes: [],
						marks: []
					});
				}
				return jsonRes({ tasks: [] });
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = null;
		chat.steeredIds = [];

		await chat.send('actually the blue one');
		await chat.send('also, what time is it?');

		// The marker is the human's own line saying it changed the turn in
		// flight; a send that started work of its own carries nothing.
		expect(chat.messages.map((m) => [m.content, !!m.steered])).toEqual([
			['actually the blue one', true],
			['also, what time is it?', false]
		]);

		// The thread is re-read a few seconds after every send, and again after
		// that: the stored rows carry no such field, so the mark has to come with
		// them every time - one reload is not enough, the second would drop it.
		await chat.select('c1');
		expect(chat.messages.map((m) => [m.id, !!m.steered])).toEqual([
			['m1', true],
			['m2', false]
		]);

		await chat.select('c1');
		expect(chat.messages.map((m) => [m.id, !!m.steered])).toEqual([
			['m1', true],
			['m2', false]
		]);
	});

	// The row exists server-side for the whole classifier call, so a reload can
	// land before the send's reply does. The reply is what says the send steered,
	// so the mark has to reach the row even then.
	it('marks the row when the reload beats the reply', async () => {
		vi.useFakeTimers();
		const held = Promise.withResolvers<Response>();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') return held.promise;
				if (url === '/api/conversations/c1') {
					return jsonRes({
						conversation: { id: 'c1' },
						messages: [stored('m1', 'actually the blue one', 2)],
						has_more: false,
						bots: [],
						reactions: {},
						notes: [],
						marks: []
					});
				}
				return jsonRes({ tasks: [] });
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = null;
		chat.steeredIds = [];

		const sending = chat.send('actually the blue one');
		// The thread is re-read while the send is still in flight: the human's row
		// is already stored, so the bubble lands and nothing knows yet that it
		// steered.
		await chat.select('c1');
		expect(chat.messages.map((m) => [m.id, !!m.steered])).toEqual([['m1', false]]);

		held.resolve(
			jsonRes({
				conversation_id: 'c1',
				tasks: [{ id: 't1', bot_id: 'b1', steered: true, message_id: 'm1' }]
			})
		);
		await sending;

		// The reply named the row, so the mark lands on it now - and stays.
		expect(chat.messages.map((m) => [m.id, !!m.steered])).toEqual([['m1', true]]);
		await chat.select('c1');
		expect(chat.messages.map((m) => [m.id, !!m.steered])).toEqual([['m1', true]]);
	});

	// Two lines can read alike; only the id tells them apart. Marking by words
	// would put the ⚡ on an older line that never steered anything.
	it('marks only the line the reply named when two lines read alike', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') {
					return jsonRes({
						conversation_id: 'c1',
						tasks: [{ id: 't1', bot_id: 'b1', steered: true, message_id: 'm2' }]
					});
				}
				if (url === '/api/conversations/c1') {
					return jsonRes({
						conversation: { id: 'c1' },
						messages: [stored('m1', 'stop', 2), stored('m2', 'stop', 3)],
						has_more: false,
						bots: [],
						reactions: {},
						notes: [],
						marks: []
					});
				}
				return jsonRes({ tasks: [] });
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = null;
		chat.steeredIds = [];

		await chat.send('stop');
		await chat.select('c1');

		expect(chat.messages.map((m) => [m.id, !!m.steered])).toEqual([
			['m1', false],
			['m2', true]
		]);
	});
});

describe('ChatStore.select', () => {
	const CONV = { id: 'c2', kind: 'direct', bot_ids: 'b2', unread: 0, last_read_at: 0 };

	function convPayload(id: string, messages: Message[] = []) {
		return {
			conversation: { id },
			messages,
			has_more: false,
			bots: [],
			reactions: {},
			notes: [],
			marks: []
		};
	}

	it('drops the old thread and drafts the moment a new chat is chosen', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/conversations/c2') return jsonRes(convPayload('c2'));
				if (url.startsWith('/api/tasks')) return jsonRes({ tasks: [] });
				if (url.startsWith('/api/bot-proposals')) return jsonRes({ proposals: [] });
				return jsonRes({});
			})
		);
		chat.activeId = 'c1';
		chat.conversations = [CONV as never];
		chat.messages = [
			{
				id: 'old1',
				conversation_id: 'c1',
				role: 'user',
				bot_id: '',
				content: 'the old room talking',
				model: '',
				rating: 0,
				kind: '',
				reply_to: '',
				created_at: 1
			}
		];
		chat.activeBots = [BOT];
		chat.quoteDraft = chat.messages[0];
		chat.secretDraft = true;
		chat.secretNote = 'storing…';

		const pending = chat.select('c2');
		// Before the fetch even answers, nothing from c1 may still be showing:
		// its messages, its panel bot, the reply bar, the secret card.
		expect(chat.messages).toEqual([]);
		expect(chat.activeBots).toEqual([]);
		expect(chat.quoteDraft).toBeNull();
		expect(chat.secretDraft).toBe(false);
		expect(chat.secretNote).toBe('');
		await pending;
	});

	it('does not mark a conversation read after the reader has left it', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (url: string) => {
			if (url === '/api/conversations/c1') return jsonRes(convPayload('c1'));
			if (url.startsWith('/api/tasks')) {
				// The reader moves on while the task list is still loading.
				chat.activeId = 'c2';
				return jsonRes({ tasks: [] });
			}
			if (url.startsWith('/api/bot-proposals')) return jsonRes({ proposals: [] });
			return jsonRes({});
		});
		vi.stubGlobal('fetch', fetchMock);
		chat.activeId = 'c1';
		chat.conversations = [
			{ id: 'c1', kind: 'direct', bot_ids: 'b1', unread: 3, last_read_at: 0 } as never
		];

		await chat.select('c1');

		expect(
			fetchMock.mock.calls.some(([url]) => String(url) === '/api/conversations/c1/read')
		).toBe(false);
	});

	it('says the load failed instead of rejecting when the fetch never answers', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/conversations/c1') return Promise.reject(new Error('offline'));
				if (url.startsWith('/api/tasks')) return jsonRes({ tasks: [] });
				if (url.startsWith('/api/bot-proposals')) return jsonRes({ proposals: [] });
				return jsonRes({});
			})
		);
		chat.activeId = 'c1';
		chat.conversations = [];
		chat.error = '';

		// A lost request must resolve, not reject: the click handler that fired
		// this has nothing to catch a throw with.
		await chat.select('c1');

		expect(chat.error).toBe('could not load this conversation');
	});
});

describe('ChatStore.send failure and races', () => {
	it('reports failure and drops the optimistic bubble when the send is refused', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') return jsonRes({ message: 'nope' }, false);
				return jsonRes({ tasks: [] });
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = null;

		const ok = await chat.send('lost words');

		expect(ok).toBe(false);
		expect(chat.messages).toEqual([]);
		expect(chat.error).toBe('nope');
	});

	it('never files a cold-storage note under a chat the reader switched to', async () => {
		vi.useFakeTimers();
		const note: Message = {
			id: 'n1',
			conversation_id: 'c1',
			role: 'user',
			bot_id: '',
			content: 'this bot is in cold storage - only the human can unlock it',
			model: '',
			rating: 0,
			excluded: 0,
			kind: 'app',
			reply_to: '',
			created_at: 2
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') {
					// The reader opens another chat while the send is in flight.
					chat.activeId = 'c2';
					return jsonRes({ conversation_id: 'c1', tasks: [], archived: true, note });
				}
				return jsonRes({ tasks: [] });
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = null;

		const ok = await chat.send('are you there?');

		expect(ok).toBe(true);
		// c2's thread holds nothing of c1's: not the note, not the optimistic
		// bubble (select() cleared the thread when the reader moved).
		expect(chat.messages.some((m) => m.id === 'n1')).toBe(false);
	});

	it('keeps the optimistic bubble when a thread reload lands mid-send', async () => {
		vi.useFakeTimers();
		// The send's POST hangs until released, so a select() reload can land
		// between the optimistic append and the server's answer.
		let release: (r: Response) => void = () => {};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') {
					return new Promise<Response>((r) => (release = r));
				}
				if (url === '/api/conversations/c1') {
					return jsonRes({
						conversation: { id: 'c1' },
						messages: [
							{
								id: 'm1',
								conversation_id: 'c1',
								role: 'assistant',
								bot_id: 'b1',
								content: 'an older answer',
								model: '',
								rating: 0,
								kind: '',
								reply_to: '',
								created_at: 1
							}
						],
						has_more: false,
						bots: [],
						reactions: {},
						notes: [],
						marks: []
					});
				}
				if (url.startsWith('/api/tasks')) return jsonRes({ tasks: [] });
				if (url.startsWith('/api/bot-proposals')) return jsonRes({ proposals: [] });
				return jsonRes({});
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [
			{ id: 'c1', kind: 'direct', bot_ids: 'b1', unread: 0, last_read_at: 0 } as never
		];
		chat.quoteDraft = null;

		const sending = chat.send('still flying');
		expect(chat.messages.some((m) => m.id.startsWith('local-'))).toBe(true);

		// A reload of the same chat - new-topic, a sync poll, a finished task -
		// answers with what the server holds, which is everything but the
		// in-flight send. The bubble must not vanish while it is still pending.
		await chat.select('c1');
		expect(chat.messages.some((m) => m.id.startsWith('local-'))).toBe(true);

		release(jsonRes({ conversation_id: 'c1', tasks: [] }));
		await sending;
		// The bubble stays by design, but only for this test: a local bubble
		// left in the store rides pendingLocal into any later select of c1.
		chat.messages = [];
	});

	it('drops the optimistic bubble once the send has landed on the server', async () => {
		vi.useFakeTimers();
		const landed: Message = {
			id: 'm2',
			conversation_id: 'c1',
			role: 'user',
			bot_id: '',
			content: 'still flying',
			model: '',
			rating: 0,
			kind: '',
			reply_to: '',
			created_at: 2
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') return jsonRes({ conversation_id: 'c1', tasks: [] });
				if (url === '/api/conversations/c1') {
					return jsonRes({
						conversation: { id: 'c1' },
						messages: [
							{
								id: 'm1',
								conversation_id: 'c1',
								role: 'assistant',
								bot_id: 'b1',
								content: 'an older answer',
								model: '',
								rating: 0,
								kind: '',
								reply_to: '',
								created_at: 1
							},
							landed
						],
						has_more: false,
						bots: [],
						reactions: {},
						notes: [],
						marks: []
					});
				}
				if (url.startsWith('/api/tasks')) return jsonRes({ tasks: [] });
				if (url.startsWith('/api/bot-proposals')) return jsonRes({ proposals: [] });
				return jsonRes({});
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [
			{ id: 'c1', kind: 'direct', bot_ids: 'b1', unread: 0, last_read_at: 0 } as never
		];
		chat.quoteDraft = null;

		await chat.send('still flying');
		expect(chat.messages.some((m) => m.id.startsWith('local-'))).toBe(true);

		// The row is stored by the time the POST answers, so a later reload of
		// the thread brings the real bubble; the optimistic copy must go
		// instead of reading the message twice until the reader moves on.
		await chat.select('c1');
		expect(chat.messages.some((m) => m.id.startsWith('local-'))).toBe(false);
		expect(chat.messages.filter((m) => m.content === 'still flying')).toHaveLength(1);
	});

	it('keeps a quote the reader re-aimed while the send was in flight', async () => {
		vi.useFakeTimers();
		const other: Message = {
			id: 'm9',
			conversation_id: 'c1',
			role: 'assistant',
			bot_id: 'b1',
			content: 'a different line',
			model: '',
			rating: 0,
			excluded: 0,
			kind: '',
			reply_to: '',
			created_at: 9
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') {
					// The reader picked another message to answer while this send
					// was still travelling; that draft is not this send's to clear.
					chat.quoteDraft = other;
					return jsonRes({ conversation_id: 'c1', tasks: [] });
				}
				return jsonRes({ tasks: [] });
			})
		);
		chat.activeId = 'c1';
		chat.messages = [];
		chat.conversations = [];
		chat.quoteDraft = {
			id: 'm1',
			conversation_id: 'c1',
			role: 'assistant',
			bot_id: 'b1',
			content: 'the line it answers',
			model: '',
			rating: 0,
			excluded: 0,
			kind: '',
			reply_to: '',
			created_at: 1
		};

		await chat.send('yes, that one');

		expect(chat.quoteDraft).toBe(other);
	});
});

describe('ChatStore.refreshActivities', () => {
	it('does not hang one bot’s log on the panel after it moves to another', async () => {
		vi.useFakeTimers();
		const other = { id: 'b2', name: 'Other' } as Bot;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/bots/b1') {
					// The panel moved to b2 while b1's read was in flight.
					chat.activeBots = [other];
					return jsonRes({
						activities: [{ id: 'a1', bot_id: 'b1', kind: 'typing', created_at: 1 }],
						routines: [ROUTINE],
						bot: BOT
					});
				}
				return jsonRes({ wakes: [], waits: [] });
			})
		);
		chat.activeBots = [BOT];
		chat.activities = [];
		chat.routines = [];

		await chat.refreshActivities();

		expect(chat.activities).toEqual([]);
		expect(chat.routines).toEqual([]);
	});
});


describe('oneLine', () => {
	it('never cuts a surrogate pair in half at the clip point', () => {
		// 89 ascii chars then an emoji: a naive slice(0, 89) keeps the emoji's
		// lead surrogate and drops its trail, printing mojibake.
		const preview = oneLine('x'.repeat(89) + '🔥 tail', 90);
		expect(preview.endsWith('…')).toBe(true);
		for (const ch of preview) {
			const code = ch.codePointAt(0)!;
			expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
		}
	});
});

describe('ChatStore.rate', () => {
	const MSG: Message = {
		id: 'm1',
		conversation_id: 'c1',
		role: 'assistant',
		bot_id: 'b1',
		content: 'an answer',
		model: '',
		rating: 0,
		excluded: 0,
		kind: '',
		reply_to: '',
		created_at: 1
	};

	it('unlights the thumb when the vote is refused', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ message: 'nope' }, false)));
		chat.messages = [{ ...MSG }];

		await chat.rate('m1', 1);

		expect(chat.messages[0].rating).toBe(0);
	});

	it('unlights the thumb when the vote never arrives', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
		chat.messages = [{ ...MSG }];

		await chat.rate('m1', -1);

		expect(chat.messages[0].rating).toBe(0);
	});
});

describe('ChatStore.regenerate', () => {
	const MSG: Message = {
		id: 'm1',
		conversation_id: 'c1',
		role: 'assistant',
		bot_id: 'b1',
		content: 'the answer being replaced',
		model: '',
		rating: 0,
		excluded: 0,
		kind: '',
		reply_to: '',
		created_at: 1
	};

	it('puts the answer back when the regenerate is refused', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/chat') return jsonRes({ message: 'nope' }, false);
				return jsonRes({ tasks: [] });
			})
		);
		chat.activeId = 'c1';
		chat.messages = [{ ...MSG }];
		chat.conversations = [];

		await chat.regenerate(MSG);

		expect(chat.messages.map((m) => m.id)).toEqual(['m1']);
	});
});

describe('collapseBlankLines', () => {
	it('collapses a run of blank lines to one paragraph break', () => {
		expect(collapseBlankLines(`line1${'\n'.repeat(100)}line2`)).toBe('line1\n\nline2');
	});

	it('leaves ordinary spacing and non-newline whitespace alone', () => {
		expect(collapseBlankLines('a\nb')).toBe('a\nb');
		expect(collapseBlankLines('a\n\nb')).toBe('a\n\nb');
		expect(collapseBlankLines('a \n \n \n b')).toBe('a \n \n \n b');
	});
});
