import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamOptions, StreamResult } from './llm';
import { streamChat } from './llm';
import {
	createBot,
	createConversation,
	db,
	deleteBot,
	deleteConversation,
	getTask,
	type Bot,
	type Conversation
} from './db';
import { cancelTask, startTask, waitForTask } from './tasks';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { GET } from '../../routes/api/tasks/stream/+server';

// The turn machinery is real here; only the provider, the sandbox and docker
// are stand-ins, the same way tasks.test.ts stands them in.
vi.mock('./llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

vi.mock('./machine', () => ({
	captureShot: vi.fn(),
	machineExec: vi.fn(),
	shellExec: vi.fn(),
	machineScreenshot: vi.fn(),
	navigateBrowser: vi.fn(),
	setupDesktop: vi.fn(),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(),
	reapIdleMachines: vi.fn(),
	machineStatus: vi.fn()
}));

vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));

/** One parsed SSE frame from the route's stream. */
interface Frame {
	event: string;
	data: Record<string, unknown>;
}

/**
 * Read the route's SSE body frame by frame. `until` resolves once `stop` sees
 * enough in the frames collected so far, so a test can wait for one delta and
 * then for the next without losing what already arrived.
 */
function frameReader(res: Response) {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	const frames: Frame[] = [];
	let buffer = '';
	return {
		frames,
		async until(stop: (frames: Frame[]) => boolean): Promise<Frame[]> {
			while (!stop(frames)) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let split: number;
				while ((split = buffer.indexOf('\n\n')) !== -1) {
					const raw = buffer.slice(0, split);
					buffer = buffer.slice(split + 2);
					const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
					const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? '{}');
					frames.push({ event, data });
				}
			}
			return frames;
		}
	};
}

/** Call the stream route the way the browser's EventSource does. */
function openStream(conversationId?: string, signal?: AbortSignal): Response {
	const url = new URL('http://test/api/tasks/stream');
	if (conversationId) url.searchParams.set('conversation_id', conversationId);
	return GET({
		url,
		request: new Request(url, { signal })
	} as Parameters<typeof GET>[0]) as Response;
}

/** A provider stand-in that yields `deltas`, pausing on `gate` between them. */
function gatedStream(deltas: string[], gate: Promise<void>): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (let i = 0; i < deltas.length; i++) {
			yield deltas[i];
			if (i < deltas.length - 1) await gate;
		}
		return { text: deltas.join(''), toolCalls: [] };
	})();
}

/** A provider stand-in that yields `deltas` and then blocks until aborted. */
function abortableStream(deltas: string[], opts: StreamOptions): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) {
			yield d;
			await new Promise<void>((resolve) => {
				if (!opts.signal || opts.signal.aborted) resolve();
				else opts.signal.addEventListener('abort', () => resolve(), { once: true });
			});
		}
		if (opts.signal?.aborted) throw new Error('provider aborted');
		return { text: deltas.join(''), toolCalls: [] };
	})();
}

let bot: Bot;
let conv: Conversation;
let seq = 0;

beforeEach(() => {
	vi.mocked(streamChat).mockReset();
	bot = createBot({
		name: `StreamProbe${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
	conv = createConversation([bot.id], 'direct');
});

afterEach(() => {
	db.prepare('DELETE FROM activities WHERE bot_id = ?').run(bot.id);
	deleteConversation(conv.id);
	deleteBot(bot.id);
});

describe('GET /api/tasks/stream', () => {
	it('answers as an event stream, not a buffered response', () => {
		const res = openStream();
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		// A proxy that buffers would hold every delta until the turn ended.
		expect(res.headers.get('x-accel-buffering')).toBe('no');
	});

	it('streams the partial reply as the turn writes it, then ends the task', async () => {
		const gate = Promise.withResolvers<void>();
		vi.mocked(streamChat).mockImplementation(() => gatedStream(['Hel', 'lo'], gate.promise));

		const task = startTask(conv, bot, 'say hello');
		const reader = frameReader(openStream());

		// The first word, whether it arrived as a delta or as the row's own tail.
		await reader.until((f) => f.some((x) => x.event === 'preview' && x.data.preview === 'Hel'));
		expect(reader.frames.every((f) => f.data.taskId === task.id)).toBe(true);

		gate.resolve();
		await reader.until((f) => f.some((x) => x.event === 'task_end'));

		const previews = reader.frames
			.filter((f) => f.event === 'preview')
			.map((f) => f.data.preview as string);
		// The text grows: 'Hel' then 'Hello', never the finished message alone.
		expect(previews).toContain('Hel');
		expect(previews.at(-1)).toBe('Hello');
		expect(reader.frames.some((f) => f.event === 'task_end' && f.data.taskId === task.id)).toBe(true);
	});

	it('replays the current partial to a client that connects mid-turn', async () => {
		const gate = Promise.withResolvers<void>();
		vi.mocked(streamChat).mockImplementation(() => gatedStream(['Half a ', 'reply'], gate.promise));

		const task = startTask(conv, bot, 'write an essay');
		// The turn is already talking by the time the client shows up.
		await vi.waitFor(() => expect(getTask(task.id)?.preview).toBe('Half a '));

		const reader = frameReader(openStream());
		await reader.until((f) => f.some((x) => x.event === 'preview' && x.data.preview === 'Half a '));
		expect(reader.frames[0]).toMatchObject({
			event: 'preview',
			data: { taskId: task.id, preview: 'Half a ' }
		});

		gate.resolve();
		await reader.until((f) => f.some((x) => x.event === 'task_end'));
	});

	it('ends the task on a cancelled turn, so a stale partial is not left looking finished', async () => {
		vi.mocked(streamChat).mockImplementation((opts) => abortableStream(['half'], opts));

		const task = startTask(conv, bot, 'stop me');
		const reader = frameReader(openStream());
		await reader.until((f) => f.some((x) => x.event === 'preview' && x.data.preview === 'half'));

		expect(cancelTask(task.id)).toBe(true);
		await reader.until((f) => f.some((x) => x.event === 'task_end'));
		expect(reader.frames.some((f) => f.event === 'task_end' && f.data.taskId === task.id)).toBe(true);
	});

	it('carries nothing for a turn that writes no text', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				return { text: '', toolCalls: [] } satisfies StreamResult;
			})()
		);

		const task = startTask(conv, bot, 'say nothing');
		const reader = frameReader(openStream());
		await reader.until((f) => f.some((x) => x.event === 'task_end'));

		expect(reader.frames.filter((f) => f.event === 'preview')).toEqual([]);
		expect(getTask(task.id)?.status).toBe('error');
	});

	it('only carries the conversation it was asked for', async () => {
		// A direct chat is reused per bot, so the other conversation needs a bot
		// of its own - otherwise it is the same thread and the filter is untested.
		const otherBot = createBot({
			name: `StreamProbeOther${++seq}`,
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		const other = createConversation([otherBot.id], 'direct');
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				yield 'hi';
				return { text: 'hi', toolCalls: [] } satisfies StreamResult;
			})()
		);

		// The stream is opened for a different conversation, then closed once the
		// turn has finished: whatever it buffered drains on close, so a frame that
		// leaked across the filter would be read here rather than missed.
		const ac = new AbortController();
		const reader = frameReader(openStream(other.id, ac.signal));
		const task = startTask(conv, bot, 'say hi');
		await waitForTask(task.id);
		ac.abort();
		await reader.until(() => false);

		expect(reader.frames).toEqual([]);

		deleteConversation(other.id);
		deleteBot(otherBot.id);
	});
});
