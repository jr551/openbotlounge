import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResult, ToolCall } from './llm';
import { streamChat } from './llm';
import { createBot, type Bot } from './db';
import { desktopInput, machineScreenshot } from './machine';
import { isVisionRefusal, runComputerTask } from './computer-agent';

// The model is faked: each mockImplementationOnce is one step of the
// sub-agent's loop, and what the tests assert is what the loop fed it - the
// screenshot messages - and which model each step went to.
vi.mock('./llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

// The machine is faked: the screenshot is a fixed frame, the input path a
// spy. The point under test is what the loop does with them - the per-step
// feed, the look-before-act gate, the fallback - not the desktop itself.
vi.mock('./machine', () => ({
	machineExec: vi.fn(async () => 'machine output'),
	shellExec: vi.fn(async () => 'shell output'),
	machineScreenshot: vi.fn(async () => 'base64png'),
	desktopInput: vi.fn(async () => {}),
	captureShot: vi.fn(async () => 'shot.png'),
	navigateBrowser: vi.fn(async () => ''),
	setupDesktop: vi.fn(async () => 'desktop set up'),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(async () => 'running'),
	machineStatus: vi.fn(async () => ({ state: 'running' })),
	machineTier: vi.fn(() => 'full')
}));

// The fallback model is the police's pick; the tests only need it named, not
// the officer behind it. A factory mock keeps the runner graph - which
// imports this module back - out of the load order entirely.
vi.mock('./police', () => ({
	policeModel: vi.fn(() => 'police-model'),
	// The fallback looks through this one; it is a different pick from the
	// officer's model, which is why the retry asserts on it below.
	visionModel: vi.fn(() => 'vision-model'),
	// site-docs bills its documenter to the system account; a stand-in id is
	// enough for the tests that never reach it.
	ensurePoliceBot: vi.fn(() => ({ id: 'police-bot' }))
}));

/** A streamChat stand-in: yields each delta, then returns the result. */
function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

/** A streamChat stand-in that dies the way a provider refusal does. */
function failingStream(message: string): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		throw new Error(message);
	})();
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

let bot: Bot;

beforeAll(() => {
	bot = createBot({ name: 'VisionBot', persona: '', avatar: '', color: '', model: '', badge: '' });
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(machineScreenshot).mockResolvedValue('base64png');
	vi.mocked(desktopInput).mockResolvedValue(undefined);
});

/** The image parts one streamChat call was handed. */
function imageParts(call: unknown): unknown[] {
	const messages = (call as { messages: { content: unknown }[] }).messages;
	return messages.flatMap((m) =>
		Array.isArray(m.content)
			? m.content.filter((p: { type?: string }) => p.type === 'image_url')
			: []
	);
}

describe('runComputerTask vision', () => {
	it('feeds a gridded screenshot into every step', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'shell_exec', { command: 'ls' })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'done', toolCalls: [] }));

		const report = await runComputerTask({ botId: bot.id, botName: bot.name, goal: 'list files', model: 'm1' });

		// One screenshot per step, taken with the grid on.
		expect(vi.mocked(machineScreenshot).mock.calls).toEqual([
			[bot.id, undefined, 100],
			[bot.id, undefined, 100]
		]);
		// ...and each call's newest message is the fresh frame, fed as an image
		// part the model can see.
		for (const call of vi.mocked(streamChat).mock.calls) {
			const messages = (call[0] as { messages: { content: unknown }[] }).messages;
			const last = messages[messages.length - 1].content;
			expect(
				Array.isArray(last) && last.some((p: { type?: string }) => p.type === 'image_url')
			).toBe(true);
		}
	});

	it('runs a text-only step when there is no screen to see', async () => {
		vi.mocked(machineScreenshot).mockRejectedValue(new Error('no desktop'));
		vi.mocked(streamChat).mockImplementationOnce(() =>
			fakeStream([], { text: 'no screen, used the shell', toolCalls: [] })
		);

		const report = await runComputerTask({ botId: bot.id, botName: bot.name, goal: 'ls', model: 'm1' });

		expect(report).toBe('no screen, used the shell');
		expect(imageParts(vi.mocked(streamChat).mock.calls[0][0])).toHaveLength(0);
	});

	it('refuses a second action in one step until the screen is looked at again', async () => {
		vi.mocked(streamChat)
			// Step one: two clicks in a single reply. The first runs on the
			// step's screenshot; the second must be refused by the tool layer.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [
						toolCall('c1', 'mouse_click', { x: 10, y: 20 }),
						toolCall('c2', 'mouse_click', { x: 30, y: 40 })
					]
				})
			)
			// Step two: the model looks again, then clicks once more.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [
						toolCall('l1', 'screen_look', {}),
						toolCall('c3', 'mouse_click', { x: 30, y: 40 })
					]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'clicked both', toolCalls: [] }));

		const report = await runComputerTask({ botId: bot.id, botName: bot.name, goal: 'click twice', model: 'm1' });

		expect(report).toBe('clicked both');
		// Two clicks reached the desktop: the first of each step, never the
		// second of step one.
		expect(vi.mocked(desktopInput).mock.calls).toHaveLength(2);
		// The refused call's tool result says why, in the transcript the model
		// reads next.
		const stepTwo = vi.mocked(streamChat).mock.calls[1][0];
		expect(stepTwo.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 'c2',
			content:
				'error: look at the screen first - call screen_look, then act on ' +
				'what it shows. Every action needs a fresh look before it.'
		});
		// screen_look's picture went into the conversation as an image of its
		// own: the third call carries every frame fed so far - one per step
		// plus the look's - and its newest message is the step's fresh shot.
		const stepThree = vi.mocked(streamChat).mock.calls[2][0] as {
			messages: { content: unknown }[];
		};
		expect(imageParts(stepThree)).toHaveLength(4);
		const newest = stepThree.messages[stepThree.messages.length - 1].content;
		expect(
			Array.isArray(newest) && newest.some((p: { type?: string }) => p.type === 'image_url')
		).toBe(true);
	});


	it('retries a vision-bearing call on the vision model when the bot model cannot see', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				failingStream('Provider 400: this model does not support image input')
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'saw it', toolCalls: [] }));

		const report = await runComputerTask({ botId: bot.id, botName: bot.name, goal: 'look', model: 'm1' });

		expect(report).toBe('saw it');
		const calls = vi.mocked(streamChat).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[0][0].model).toBe('m1');
		// The retry is the same messages - image included - on the model the
		// console picked for looking, not on the officer's own model.
		expect(calls[1][0].model).toBe('vision-model');
		expect(imageParts(calls[1][0])).toHaveLength(1);
	});

	it('does not fall back on a generic provider error', async () => {
		vi.mocked(streamChat).mockImplementationOnce(() =>
			failingStream('Provider 500: internal server error')
		);

		const report = await runComputerTask({ botId: bot.id, botName: bot.name, goal: 'look', model: 'm1' });

		expect(report).toMatch(/failed: Provider 500/);
		expect(vi.mocked(streamChat).mock.calls).toHaveLength(1);
	});

	it('does not fall back when the call carried no image', async () => {
		vi.mocked(machineScreenshot).mockRejectedValue(new Error('no desktop'));
		vi.mocked(streamChat).mockImplementationOnce(() =>
			failingStream('Provider 400: this model does not support image input')
		);

		const report = await runComputerTask({ botId: bot.id, botName: bot.name, goal: 'ls', model: 'm1' });

		// The refusal text matches, but nothing in the call was a picture, so
		// the error is the task's to report - not a reason to change models.
		expect(report).toMatch(/failed: Provider 400/);
		expect(vi.mocked(streamChat).mock.calls).toHaveLength(1);
	});
});

describe('isVisionRefusal', () => {
	it('names the capability refusals providers actually send', () => {
		for (const msg of [
			'Provider 400: this model does not support image input',
			'Provider 400: images are not supported for this model',
			'Provider 400: not a vision model',
			'Provider 400: unsupported modality: image',
			'Provider 422: invalid image_url content part'
		]) {
			expect(isVisionRefusal(msg), msg).toBe(true);
		}
	});

	it('never names an arbitrary failure', () => {
		for (const msg of [
			'Provider 500: internal server error',
			'Provider 429: rate limit exceeded',
			'Provider 401: invalid api key',
			'Provider stream ended before any content',
			'the desktop did not come up in time'
		]) {
			expect(isVisionRefusal(msg), msg).toBe(false);
		}
	});
});
