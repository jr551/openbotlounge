import { describe, expect, it, vi } from 'vitest';
import {
	addMessage,
	conversationBots,
	createBot,
	createConversation,
	createTask,
	getMessage,
	listMessages,
	updateConversation
} from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/chat/+server';
import { startTask, steerTask } from '$lib/server/tasks';
import { classifyInterruption } from '$lib/server/steering';

// The turn itself runs in the background; this covers the request contract only.
vi.mock('$lib/server/tasks', () => ({
	startTask: vi.fn((_conv: unknown, bot: { id: string }) => ({ id: 'task-1', bot_id: bot.id })),
	steerTask: vi.fn(() => false),
	cancelTask: vi.fn(() => true)
}));
// The steer/new judgment is a model call; the route tests stand in for it.
vi.mock('$lib/server/steering', () => ({
	classifyInterruption: vi.fn(async () => ({ kind: 'steer', confident: true }))
}));
// Hooks are not what this file is about, and a plugin left behind by another
// test file in the shared DATA_DIR would otherwise wake a real sandbox here.
vi.mock('$lib/server/plugins', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/plugins')>()),
	runHooks: vi.fn(async (_point: string, _bot: string, payload: { message: string }) => payload.message),
	// The plugins route's review gate runs the sandbox self-test, which needs
	// a container the tests do not have.
	selfTestPlugin: vi.fn(async () => ({ ok: true, output: 'self-test ok' })),
	runPluginTests: vi.fn(async () => [])
}));
// The police gate is a model call; the route tests stand in for it.
vi.mock('$lib/server/police', () => ({
	policeModel: vi.fn(() => 'm1'),
	policeSettings: vi.fn(() => ({ checkPlugins: true, checkRoutines: true })),
	reviewPlugin: vi.fn(async () => ({ verdict: 'approved', reason: 'the code does what it says' })),
	verdictJson: vi.fn((v: { verdict: string; reason: string }) => JSON.stringify(v))
}));

function send(body: unknown) {
	const request = new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return POST({ request } as Parameters<typeof POST>[0]);
}

async function status(fn: () => unknown): Promise<number> {
	try {
		const res = (await fn()) as Response;
		return res.status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

/**
 * The message a refusal carried. SvelteKit's error() throws an HttpError rather
 * than an Error, so the body is narrowed by shape instead of trusting a cast.
 */
async function refusalMessage(fn: () => unknown): Promise<string> {
	try {
		await fn();
	} catch (e) {
		if (e && typeof e === 'object' && 'body' in e) {
			const { body } = e;
			if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
				return body.message;
			}
		}
	}
	return '';
}

function conversation() {
	const bot = createBot({ name: 'c', persona: '', avatar: '', color: '', model: '', badge: '' });
	return createConversation([bot.id], 'direct').id;
}

describe('POST /api/chat validation', () => {
	// A non-string used to reach `.trim()` and surface as a 500.
	it('rejects a non-string content with 400 rather than throwing', async () => {
		const id = conversation();
		for (const content of [123, {}, [], true, 0.5, -1]) {
			expect(await status(() => send({ conversation_id: id, content }))).toBe(400);
		}
	});

	it('rejects malformed flag and id types', async () => {
		const id = conversation();
		expect(await status(() => send({ conversation_id: {}, content: 'hi' }))).toBe(400);
		expect(await status(() => send({ conversation_id: id, content: 'hi', think: 'yes' }))).toBe(400);
	});

	it('rejects a body that is not an object', async () => {
		expect(await status(() => send([1, 2]))).toBe(400);
		expect(await status(() => send('a string'))).toBe(400);
	});

	it('accepts a normal message', async () => {
		expect(await status(() => send({ conversation_id: conversation(), content: 'hello' }))).toBe(202);
	});

	// The body used to be validated field by field as it was used, so `think` was
	// only checked after the message had been stored.
	it('stores nothing when a later field turns out to be invalid', async () => {
		const id = conversation();
		expect(await status(() => send({ conversation_id: id, content: 'hello', think: 'yes' }))).toBe(400);
		expect(listMessages(id)).toHaveLength(0);
	});

	// Worse in the other order: the old code deleted the reply it was asked to
	// regenerate before ever looking at `think`, so a 400 lost the reply too.
	it('keeps the reply when a regeneration is refused', async () => {
		const id = conversation();
		const reply = addMessage(id, 'assistant', 'the old reply', '', 'm1');
		expect(
			await status(() => send({ conversation_id: id, regenerate: true, think: 1, message_id: reply.id }))
		).toBe(400);
		expect(getMessage(reply.id)).toBeDefined();
	});

	// A regenerate rewrites the reply rather than redoing the turn: the first
	// turn's send_message already delivered, so running tools again would fire
	// the relay a second time. The regenerated turn runs with no tools at all.
	it('regenerates with tools off so side-effects do not fire twice', async () => {
		const id = conversation();
		expect(await status(() => send({ conversation_id: id, content: 'hello' }))).toBe(202);
		expect(vi.mocked(startTask).mock.lastCall?.[3]?.noTools).toBe(false);

		const reply = addMessage(id, 'assistant', 'the old reply', '', 'm1');
		expect(
			await status(() => send({ conversation_id: id, regenerate: true, message_id: reply.id }))
		).toBe(202);
		expect(vi.mocked(startTask).mock.lastCall?.[3]?.noTools).toBe(true);
	});

	it('refuses to post into a private conversation', async () => {
		const id = conversation();
		updateConversation(id, { private: 1 });
		expect(await status(() => send({ conversation_id: id, content: 'hello' }))).toBe(400);
		expect(listMessages(id)).toHaveLength(0);
	});

	it('refuses a bot_id that is not in the conversation, naming it', async () => {
		const id = conversation();
		const outsider = createBot({
			name: 'outsider',
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		const message = await refusalMessage(() =>
			send({ conversation_id: id, content: 'hello', bot_id: outsider.id })
		);
		expect(message).toContain('outsider');
		expect(listMessages(id)).toHaveLength(0);
	});

	it('steers a running task instead of starting a new one when the message belongs to it', async () => {
		const id = conversation();
		const bot = conversationBots(id)[0];
		const running = createTask(id, bot.id, 'find the red file');
		vi.mocked(startTask).mockClear();
		vi.mocked(classifyInterruption).mockResolvedValueOnce({ kind: 'steer', confident: true });
		vi.mocked(steerTask).mockReturnValueOnce(true);

		const res = await send({ conversation_id: id, content: 'actually the blue one' });
		const body = (await res.json()) as {
			tasks: { id: string; steered?: boolean; message_id?: string }[];
		};

		expect(steerTask).toHaveBeenCalledWith(running.id, 'actually the blue one', expect.objectContaining({ id }));
		expect(startTask).not.toHaveBeenCalled();
		// The reply names the human's own line, so the client can mark that row.
		expect(body.tasks).toMatchObject([{ id: running.id, bot_id: bot.id, steered: true }]);
		expect(getMessage(body.tasks[0].message_id!)!.content).toBe('actually the blue one');
	});

	// The classifier's failure default is a safe steer in the thread the human
	// is looking at, and that has not changed.
	it('still steers in this conversation when the verdict is only a guess', async () => {
		const id = conversation();
		const bot = conversationBots(id)[0];
		const running = createTask(id, bot.id, 'find the red file');
		vi.mocked(startTask).mockClear();
		vi.mocked(classifyInterruption).mockResolvedValueOnce({ kind: 'steer', confident: false });
		vi.mocked(steerTask).mockReturnValueOnce(true);

		const res = await send({ conversation_id: id, content: 'wait' });
		const body = (await res.json()) as {
			tasks: { id: string; steered?: boolean; message_id?: string }[];
		};

		expect(steerTask).toHaveBeenCalledWith(running.id, 'wait', expect.objectContaining({ id }));
		expect(body.tasks).toMatchObject([{ id: running.id, bot_id: bot.id, steered: true }]);
	});

	it('starts a parallel task when the message is a separate ask', async () => {
		const id = conversation();
		const bot = conversationBots(id)[0];
		createTask(id, bot.id, 'find the red file');
		vi.mocked(startTask).mockClear();
		vi.mocked(classifyInterruption).mockResolvedValueOnce({ kind: 'new', confident: true });

		const res = await send({ conversation_id: id, content: 'also, what time is it?' });
		const body = (await res.json()) as { tasks: { id: string; steered?: boolean }[] };

		expect(steerTask).not.toHaveBeenCalled();
		expect(startTask).toHaveBeenCalledOnce();
		expect(body.tasks).toEqual([{ id: 'task-1', bot_id: bot.id }]);
	});

	it('starts a task when the running turn can no longer take the steer', async () => {
		const id = conversation();
		const bot = conversationBots(id)[0];
		createTask(id, bot.id, 'find the red file');
		vi.mocked(startTask).mockClear();
		vi.mocked(classifyInterruption).mockResolvedValueOnce({ kind: 'steer', confident: true });
		vi.mocked(steerTask).mockReturnValueOnce(false);

		const res = await send({ conversation_id: id, content: 'actually the blue one' });
		const body = (await res.json()) as { tasks: { id: string; steered?: boolean }[] };

		expect(startTask).toHaveBeenCalledOnce();
		expect(body.tasks).toEqual([{ id: 'task-1', bot_id: bot.id }]);
	});

	// A routine, a wake, a webhook: the bot is mid-task in a room the human is
	// not typing in. The correction is aimed at that work, so it steers it - and
	// it has to be readable where the work is, or the reply it changed arrives
	// in the room with nothing to explain it.
	it('steers a turn the bot is running in another conversation, and writes the line there', async () => {
		const id = conversation();
		const bot = conversationBots(id)[0];
		// A room the bot also answers in - the shape a routine, a webhook or a
		// relay leaves behind: one direct chat per bot means a *different*
		// conversation is a group, so it cannot reuse this thread.
		const other = createBot({ name: 'roommate', persona: '', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([bot.id, other.id], 'group').id;
		const running = createTask(room, bot.id, 'tidy the downloads folder');
		vi.mocked(startTask).mockClear();
		vi.mocked(classifyInterruption).mockResolvedValueOnce({ kind: 'steer', confident: true });
		vi.mocked(steerTask).mockReturnValueOnce(true);

		const res = await send({ conversation_id: id, content: 'actually the blue one' });
		const body = (await res.json()) as {
			tasks: { id: string; bot_id: string; steered?: boolean; message_id?: string }[];
		};

		// The origin conversation rides with the steer, so a turn that dies
		// before taking it can be answered in the thread the human is reading.
		expect(vi.mocked(steerTask).mock.calls[0][0]).toBe(running.id);
		expect(vi.mocked(steerTask).mock.calls[0][1]).toBe('actually the blue one');
		expect(vi.mocked(steerTask).mock.calls[0][2]?.id).toBe(id);
		expect(startTask).not.toHaveBeenCalled();
		expect(body.tasks).toMatchObject([{ id: running.id, bot_id: bot.id, steered: true }]);
		// The id names the line in *this* thread, not the note written into the
		// room, so the mark lands where the human typed it.
		expect(getMessage(body.tasks[0].message_id!)!.content).toBe('actually the blue one');
		expect(getMessage(body.tasks[0].message_id!)!.conversation_id).toBe(id);
		expect(listMessages(room).map((m) => [m.role, m.kind, m.content])).toEqual([
			['user', 'steer', 'actually the blue one']
		]);
		// The thread the human typed in keeps its own copy of what they said.
		expect(listMessages(id).map((m) => m.content)).toEqual(['actually the blue one']);
	});

	// The failure default is a guess. Reaching into another room on one would
	// post the human's words where they are not reading and leave their own
	// thread with no answer at all, so it stays a normal send here.
	it('will not reach into another conversation on a guessed verdict', async () => {
		const id = conversation();
		const bot = conversationBots(id)[0];
		const other = createBot({ name: 'roommate', persona: '', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([bot.id, other.id], 'group').id;
		createTask(room, bot.id, 'tidy the downloads folder');
		vi.mocked(startTask).mockClear();
		vi.mocked(steerTask).mockClear();
		vi.mocked(classifyInterruption).mockResolvedValueOnce({ kind: 'steer', confident: false });

		const res = await send({ conversation_id: id, content: 'actually the blue one' });
		const body = (await res.json()) as { tasks: { id: string; steered?: boolean }[] };

		expect(steerTask).not.toHaveBeenCalled();
		expect(listMessages(room)).toEqual([]);
		expect(startTask).toHaveBeenCalledOnce();
		expect(body.tasks).toEqual([{ id: 'task-1', bot_id: bot.id }]);
	});
});

describe('POST /api/plugins author rules', () => {
	it('refuses a bot-scoped plugin that names no bot, which would never run', async () => {
		const { POST: createPlugin } = await import('../../routes/api/plugins/+server');
		const req = (body: unknown) =>
			new Request('http://test/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
		// Each probe needs a name of its own: a plugin whose name is already
		// taken is refused with a 409 before its scope is ever looked at.
		const base = { kind: 'hook', hook_point: 'before_reply', code: 'return "";' };
		const named = (suffix: string, extra: Record<string, unknown>) => ({
			...base,
			name: `orphan-${suffix}`,
			...extra
		});

		expect(
			await status(() => createPlugin({ request: req(named('nobot', { scope: 'bot' })) } as never))
		).toBe(400);
		expect(
			await status(() =>
				createPlugin({ request: req(named('badbot', { scope: 'bot', author_bot_id: 'nope' })) } as never)
			)
		).toBe(404);

		// a shared plugin authored by the user is legitimate
		const bot = createBot({ name: 'p', persona: '', avatar: '', color: '', model: '', badge: '' });
		expect(
			await status(() => createPlugin({ request: req(named('shared', { scope: 'shared' })) } as never))
		).toBe(201);
		expect(
			await status(() =>
				createPlugin({ request: req(named('owned', { scope: 'bot', author_bot_id: bot.id })) } as never)
			)
		).toBe(201);
	});

	// Tools are dispatched by name, so a second plugin with the same one can
	// never be reached - the first match wins.
	it('refuses a second plugin with a name that is already taken', async () => {
		const { POST: createPlugin } = await import('../../routes/api/plugins/+server');
		const req = (body: unknown) =>
			new Request('http://test/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
		const name = 'duplicate-name-probe';
		const body = { name, kind: 'hook', hook_point: 'before_reply', scope: 'shared', code: 'return "";' };

		expect(await status(() => createPlugin({ request: req(body) } as never))).toBe(201);
		expect(await status(() => createPlugin({ request: req(body) } as never))).toBe(409);
	});
});
