import { describe, expect, it, vi } from 'vitest';
import {
	conversationBots,
	createBot,
	createConversation,
	createTask,
	listMessages,
	updateConversation
} from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/conversations/[id]/inject/+server';
import { startTask, steerTask } from '$lib/server/tasks';
import { classifyInterruption } from '$lib/server/steering';

// The turn itself runs in the background; this covers the request contract only.
vi.mock('$lib/server/tasks', () => ({
	startTask: vi.fn((_conv: unknown, bot: { id: string }) => ({
		id: `task-${bot.id}`,
		bot_id: bot.id
	})),
	steerTask: vi.fn(() => false)
}));
// The steer/new judgment is a model call; the route tests stand in for it.
vi.mock('$lib/server/steering', () => ({
	classifyInterruption: vi.fn(async () => ({ kind: 'steer', confident: true }))
}));
// A planted line goes to the police's mini-review, which is a model call over
// the room; the route tests stand in for it.
vi.mock('$lib/server/police', () => ({ maybeRequestMiniReview: vi.fn() }));

/** A bots-only room of `count` fresh members, the shape `inject` serves. */
function lounge(count: number) {
	const ids = Array.from(
		{ length: count },
		(_, i) =>
			createBot({
				name: `lounge-${i}-${Math.random().toString(16).slice(2, 8)}`,
				persona: '',
				avatar: '',
				color: '',
				model: '',
				badge: ''
			}).id
	);
	const conv = createConversation(ids, 'group');
	updateConversation(conv.id, { private: 1 });
	return { id: conv.id, members: conversationBots(conv.id) };
}

function inject(id: string, body: unknown) {
	const request = new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return POST({ params: { id }, request } as Parameters<typeof POST>[0]);
}

describe('POST /api/conversations/[id]/inject', () => {
	// The control reads "steer the room", so a member already mid-round takes
	// the line as a steer: the round in progress changes instead of a second
	// turn starting beside it. A member that is idle is still woken, which is
	// the reaction the room has always staged.
	it('steers a member already mid-round and wakes the other', async () => {
		const room = lounge(3);
		const [speaker, busy, idle] = room.members;
		const running = createTask(room.id, busy.id, 'write the pub round');
		vi.mocked(startTask).mockClear();
		vi.mocked(steerTask).mockReturnValueOnce(true);

		const res = await inject(room.id, { bot_id: speaker.id, content: 'make it about the quiz' });
		const body = (await res.json()) as { ok: boolean; tasks: string[] };

		expect(steerTask).toHaveBeenCalledWith(running.id, 'make it about the quiz');
		// Only the idle member was woken: the busy one was steered, and the
		// steered member is not reported as a new task.
		expect(vi.mocked(startTask).mock.calls.map(([, bot]) => bot.id)).toEqual([idle.id]);
		expect(body).toEqual({ ok: true, tasks: [`task-${idle.id}`] });
		// What the human dropped in is in the room under the speaker's name.
		expect(listMessages(room.id).map((m) => [m.kind, m.bot_id, m.content])).toEqual([
			['injected', speaker.id, 'make it about the quiz']
		]);
	});

	it('starts tasks when nothing in the room is running', async () => {
		const room = lounge(3);
		const [speaker, one, two] = room.members;
		vi.mocked(startTask).mockClear();
		vi.mocked(steerTask).mockClear();

		const res = await inject(room.id, { bot_id: speaker.id, content: 'round two' });
		const body = (await res.json()) as { ok: boolean; tasks: string[] };

		expect(steerTask).not.toHaveBeenCalled();
		expect(vi.mocked(startTask).mock.calls.map(([, bot]) => bot.id)).toEqual([one.id, two.id]);
		expect(body).toEqual({ ok: true, tasks: [`task-${one.id}`, `task-${two.id}`] });
	});

	// The line is in the room before any of this runs. A steer that cannot be
	// taken - the channel throws, the verdict fails - must not leave it sitting
	// there with nobody reacting, and must not fail the request that made it.
	it('still wakes the member when the steer blows up', async () => {
		const room = lounge(3);
		const [speaker, busy, idle] = room.members;
		createTask(room.id, busy.id, 'write the pub round');
		vi.mocked(startTask).mockClear();
		vi.mocked(steerTask).mockImplementationOnce(() => {
			throw new Error('steer channel died');
		});

		const res = await inject(room.id, { bot_id: speaker.id, content: 'make it about the quiz' });
		const body = (await res.json()) as { ok: boolean; tasks: string[] };

		expect(body.ok).toBe(true);
		// Both members were woken; which of the two reach startTask first is the
		// classifier's race, not something the route promises.
		expect(vi.mocked(startTask).mock.calls.map(([, bot]) => bot.id).sort()).toEqual(
			[busy.id, idle.id].sort()
		);
		expect(body.tasks).toEqual([`task-${busy.id}`, `task-${idle.id}`]);
	});
});
