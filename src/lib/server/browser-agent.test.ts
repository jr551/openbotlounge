import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResult, ToolCall } from './llm';
import { streamChat } from './llm';
import { createBot, type Bot } from './db';
import { browseAction, machineScreenshot, navigateBrowser } from './machine';
import { runBrowserTask } from './browser-agent';

// The model is faked: each mockImplementationOnce is one step of the
// sub-agent's loop, and what the tests assert is what the loop fed it and
// which tools ran - the walk-first flow, the look-before-pixels gate, the
// fallback - not the browser itself.
vi.mock('./llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

vi.mock('./machine', () => ({
	machineExec: vi.fn(async () => 'machine output'),
	shellExec: vi.fn(async () => 'shell output'),
	machineScreenshot: vi.fn(async () => 'base64png'),
	desktopInput: vi.fn(async () => {}),
	captureShot: vi.fn(async () => 'shot.png'),
	navigateBrowser: vi.fn(async () => 'Title: Page\n\npage text'),
	browseAction: vi.fn(async () => ({ text: 'Title: Page\n\npage text', url: 'https://example.com/' })),
	setupDesktop: vi.fn(async () => 'desktop set up'),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(async () => 'running'),
	machineStatus: vi.fn(async () => ({ state: 'running' })),
	machineTier: vi.fn(() => 'full'),
	normalizeSite: vi.fn((s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]),
	readPointer: vi.fn(async () => ({ x: 0, y: 0, w: 1280, h: 1024 })),
	clampRegion: vi.fn(),
	exportCookies: vi.fn(async () => []),
	importCookies: vi.fn(async () => 0),
	IDLE_MINUTES: 9
}));

// The fallback model is the police's pick; the tests only need it named, not
// the officer behind it. A factory mock keeps the runner graph - which
// imports this module back - out of the load order entirely.
vi.mock('./police', () => ({
	policeModel: vi.fn(() => 'police-model'),
	// What the fallback asks; see the reroute test below.
	visionModel: vi.fn(() => 'vision-model')
}));

// The site documenter is a background model loop; these tests exercise the
// browser agent's own loop, so the visit hook stands in as a no-spawn no-note.
vi.mock('./site-docs', () => ({
	noteDomainVisit: vi.fn((opts: { domain: string }) => ({ domain: opts.domain, spawned: false }))
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
	bot = createBot({ name: 'WalkBot', persona: '', avatar: '', color: '', model: '', badge: '' });
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(machineScreenshot).mockResolvedValue('base64png');
	vi.mocked(navigateBrowser).mockResolvedValue('Title: Page\n\npage text');
	vi.mocked(browseAction).mockResolvedValue({
		text: 'Title: Page\n\npage text',
		url: 'https://example.com/'
	});
});

/** The image parts one streamChat call was handed. */
function imageParts(call: unknown): unknown[] {
	const messages = (call as { messages: { content: unknown }[] }).messages;
	return messages.flatMap((m) =>
		Array.isArray(m.content) ? m.content.filter((p: { type?: string }) => p.type === 'image_url') : []
	);
}

describe('runBrowserTask', () => {
	it('browses by walk, not by screenshot: no image is fed unless it looks', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('n1', 'browser_navigate', { url: 'https://example.com' })]
				})
			)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('c1', 'browser_click', { index: 2 })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'found it', toolCalls: [] }));

		const report = await runBrowserTask({
			botId: bot.id,
			botName: bot.name,
			goal: 'read example.com',
			model: 'm1'
		});

		expect(report).toBe('found it');
		expect(navigateBrowser).toHaveBeenCalledWith(bot.id, 'https://example.com');
		expect(browseAction).toHaveBeenCalledWith(bot.id, { kind: 'click', index: 2 });
		// The walk is text: no screenshot was taken and no image part reached
		// the model, so a text-only model can browse.
		expect(machineScreenshot).not.toHaveBeenCalled();
		for (const call of vi.mocked(streamChat).mock.calls) {
			expect(imageParts(call[0])).toHaveLength(0);
		}
	});

	it('feeds a gridded screenshot when the agent asks to look', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('l1', 'screen_look', {})]
				})
			)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('m1', 'mouse_click', { x: 100, y: 200 })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'clicked the canvas', toolCalls: [] }));

		const report = await runBrowserTask({
			botId: bot.id,
			botName: bot.name,
			goal: 'click the game piece',
			model: 'm1'
		});

		expect(report).toBe('clicked the canvas');
		// The look took the grid-labelled frame, and the step after it carried
		// the picture so the click's coordinates came off the grid.
		expect(machineScreenshot).toHaveBeenCalledWith(bot.id, undefined, 100);
		expect(imageParts(vi.mocked(streamChat).mock.calls[1][0])).toHaveLength(1);
	});

	it('reroutes to the vision model when the bot model refuses the screenshot', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('l1', 'screen_look', {})]
				})
			)
			.mockImplementationOnce(() =>
				failingStream('this model does not support image input')
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'saw the board', toolCalls: [] }));

		const report = await runBrowserTask({
			botId: bot.id,
			botName: bot.name,
			goal: 'look at the board',
			model: 'm1'
		});

		expect(report).toBe('saw the board');
		expect(vi.mocked(streamChat).mock.calls[2][0].model).toBe('vision-model');
	});

	it('refuses the shell - the browser toolbox has no computer tools', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'shell_exec', { command: 'curl example.com' })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'cannot shell', toolCalls: [] }));

		const report = await runBrowserTask({
			botId: bot.id,
			botName: bot.name,
			goal: 'read a page',
			model: 'm1'
		});

		expect(report).toBe('cannot shell');
		const toolMsg = vi.mocked(streamChat).mock.calls[1][0].messages.at(-1);
		expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 's1' });
		expect((toolMsg as { content: string }).content).toMatch(/no shell/);
	});

	it('stops at the step limit instead of browsing forever', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream([], {
				text: '',
				toolCalls: [toolCall('w', 'browser_walk', {})]
			})
		);

		const report = await runBrowserTask({
			botId: bot.id,
			botName: bot.name,
			goal: 'keep reading',
			model: 'm1'
		});

		expect(report).toMatch(/16-step limit/);
	});
});
