import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	db,
	blockBot,
	createBot,
	createConversation,
	conversationBots,
	createPlugin,
	createTask,
	deletePlugin,
	deleteBot,
	deleteConversation,
	listActivities,
	deleteWait,
	deleteWake,
	getBot,
	getConversation,
	getTask,
	logActivity,
	listConversations,
	listMemories,
	listMessages,
	listNotes,
	listWaits,
	listWakes,
	pluginsForBot,
	setBotHidden,
	setMemory,
	setSetting,
	unblockBot,
	updateBot,
	pendingChangeRequests,
	directConversationWith
} from './db';
import { saveFile } from './files';
import { createSecret, getSecret, shareSecret, usableSecrets } from './secrets';
import {
	captureShot,
	clampRegion,
	desktopInput,
	exportCookies,
	importCookies,
	machineExec,
	machineScreenshot,
	machineStatus,
	browseAction,
	navigateBrowser,
	readPointer,
	shellExec,
	sleepMachine,
	ensureMachine
} from './machine';
import { policeSettings, reviewCookieHandover, reviewPlugin, reviewRoom, reviewRoutine } from './police';
import { executeTool, toolsForTurn, type ToolContext } from './tools';
import { runPluginTests } from './plugins';
import type * as Plugins from './plugins';
import type { PoliceSettings } from './police';

vi.mock('./machine', () => ({
	machineExec: vi.fn(async () => 'machine output'),
	shellExec: vi.fn(async () => 'shell output'),
	machineScreenshot: vi.fn(async () => 'base64png'),
	desktopInput: vi.fn(async () => {}),
	captureShot: vi.fn(async () => 'shot.png'),
	navigateBrowser: vi.fn(async () => {}),
	browseAction: vi.fn(async () => ({ text: 'Title: Page\n\npage text', url: 'https://example.com/' })),
	setupDesktop: vi.fn(async () => 'desktop set up'),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(async () => 'running'),
	machineStatus: vi.fn(async () => ({
		state: 'running',
		url: '',
		vncPort: 0,
		desktop: 'off',
		screen: 'off',
		lastActive: 0,
		hasThumbnail: false
	})),
	// The cookie handover's browser side. The site filter itself is tested
	// against the real machine module in machine.test.ts; here the mocks stand
	// in so the tool's own refusals and redaction are what is under test.
	exportCookies: vi.fn(async () => []),
	importCookies: vi.fn(async () => 0),
	machineTier: vi.fn(() => 'full'),
	normalizeSite: vi.fn((s: string) => s.trim().toLowerCase()),
	// The screen size read and the clamp are exercised for real in
	// machine.test.ts; here they are stubs, so the tool's own wiring - the
	// refusal when the machine is off, the caption, the message - is what is
	// under test.
	readPointer: vi.fn(async () => ({ x: 0, y: 0, w: 1280, h: 1024 })),
	clampRegion: vi.fn(),
	// Deliberately not the default, so a result that echoes it proves the tool
	// reads the deployment's window rather than repeating a number of its own.
	IDLE_MINUTES: 9
}));

// The police gate is a model call; the tests stand in for it. The point under
// test is what the tool does with the verdict, not the officer's judgement. A
// plain factory, not importOriginal: loading the real module would pull the
// runner in behind it, and nothing here needs the officer's other exports.
vi.mock('./police', () => ({
	policeModel: vi.fn(() => 'm1'),
	// The officer is a real row: the ask's card lands in its DM, and a fake id
	// would fail the member row's foreign key.
	ensurePoliceBot: vi.fn(() => getBot(policeId)),
	policeSettings: vi.fn(() => ({ checkPlugins: true, checkRoutines: true })),
	reviewCookieHandover: vi.fn(async () => ({ approved: true, reason: 'the reason is good enough' })),
	reviewPlugin: vi.fn(async () => ({ verdict: 'approved', reason: 'the code does what it says' })),
	reviewRoutine: vi.fn(async () => ({ verdict: 'approved', reason: 'a real instruction on a sane schedule' })),
	reviewRoom: vi.fn(async () => ({ verdict: 'approved', reason: 'a plausible group for a real purpose' })),
	verdictJson: vi.fn((v: { verdict: string; reason: string }) => JSON.stringify(v)),
	// The attempt counter is the real one: the tests exercise how many times a
	// refused thing may come back, so a stand-in would test nothing.
	applyAttempt: (v: { verdict: string; reason: string }, prior: string) => {
		if (v.verdict !== 'rejected') return v;
		let attempts = 0;
		try {
			attempts = Number(JSON.parse(prior || '{}').attempts) || 0;
		} catch {
			attempts = 0;
		}
		attempts += 1;
		return { ...v, attempts, awaitingHuman: attempts >= 3 };
	},
	POLICE_MAX_ATTEMPTS: 3
}));

// The author's own tests run in the bot's container, which the tests have no
// docker for. Everything else about plugins stays real: the point under test is
// what happens to the results, not how the sandbox produced them.
vi.mock('./plugins', async (importOriginal) => ({
	...(await importOriginal<typeof Plugins>()),
	runPluginTests: vi.fn(async () => [])
}));

// The site documenter is a background model loop; the tests here exercise the
// tool's own result, not the note pipeline (site-docs.test.ts covers that).
// noteDomainVisit stands in as a no-spawn no-note visit so browser_navigate's
// output stays exactly what it was.
vi.mock('./site-docs', () => ({
	noteDomainVisit: vi.fn((opts: { domain: string }) => ({ domain: opts.domain, spawned: false }))
}));

let botId = '';
let targetId = '';
let convId = '';
let policeId = '';


/**
 * The police settings a test needs, with the creation gates set and the
 * rest left as the fleet ships them: only the gates matter to a tool call.
 */
function policeChecks(plugins: boolean, routines: boolean, wakes = true): PoliceSettings {
	return {
		intervalHours: 12,
		jailMode: 'confirm',
		disabledRules: new Set<string>(),
		writeUps: true,
		patrol: true,
		checkPlugins: plugins,
		checkRoutines: routines,
		checkWakes: wakes,
		checkRooms: true
	};
}


beforeAll(() => {
	botId = createBot({
		name: 'ToolBot',
		persona: '',
		avatar: '🤖',
		color: '#fff',
		model: '',
		badge: ''
	}).id;
	targetId = createBot({
		name: 'RelayTarget',
		persona: '',
		avatar: '🦊',
		color: '#f00',
		model: '',
		badge: ''
	}).id;
	policeId = createBot({
		name: 'Police',
		persona: '',
		avatar: '🚨',
		color: '#00f',
		model: '',
		badge: '',
		hidden: 1
	}).id;
	convId = createConversation([botId, targetId], 'group').id;
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		senderBotId: botId,
		senderBotName: 'ToolBot',
		conversationId: convId,
		depth: 0,
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(machineExec).mockResolvedValue('machine output');
	vi.mocked(ensureMachine).mockResolvedValue('obl-machine-x');
	vi.mocked(sleepMachine).mockResolvedValue('running');
	// clearAllMocks keeps implementations: a failed-navigation test that ran
	// earlier would otherwise still reject here (test:shuffle shuffles tests).
	// '' reads as "no page text": the tool then reports a bare opened <url>.
	vi.mocked(navigateBrowser).mockResolvedValue('');
	vi.mocked(machineStatus).mockResolvedValue(statusOf('running'));
	vi.mocked(exportCookies).mockResolvedValue([]);
	vi.mocked(importCookies).mockResolvedValue(0);
	vi.mocked(reviewCookieHandover).mockResolvedValue({
		approved: true,
		reason: 'the reason is good enough'
	});
	vi.mocked(policeSettings).mockReturnValue(policeChecks(true, true));
	vi.mocked(reviewPlugin).mockResolvedValue({ verdict: 'approved', reason: 'the code does what it says' });
	vi.mocked(reviewRoutine).mockResolvedValue({
		verdict: 'approved',
		reason: 'a real instruction on a sane schedule'
	});
});

/** The status the machine module reports, for one of its three states. */
function statusOf(state: 'off' | 'sleeping' | 'running') {
	return { state, url: 'http://machine:6080', vncPort: 32768, desktop: 'off' as const, desktop_stage: '', desktop_error: '', screen: 'off' as const, lastActive: 0, hasThumbnail: false };
}

describe('shell_exec', () => {
	it('runs the command in the machine and returns its output', async () => {
		const out = await executeTool(
			'shell_exec',
			JSON.stringify({ command: 'ls -la' }),
			ctx()
		);
		expect(machineExec).toHaveBeenCalledWith(botId, 'ls -la', undefined);
		expect(out).toBe('machine output');
	});

	it('requires a command', async () => {
		expect(await executeTool('shell_exec', '{}', ctx())).toBe('error: command required');
		expect(machineExec).not.toHaveBeenCalled();
	});
});

describe('browser_navigate', () => {
	it('navigates the machine browser and confirms', async () => {
		const out = await executeTool(
			'browser_navigate',
			JSON.stringify({ url: 'https://example.com' }),
			ctx()
		);
		expect(navigateBrowser).toHaveBeenCalledWith(botId, 'https://example.com');
		expect(out).toBe('opened https://example.com');
	});

	it('leaves a browser activity newest, so the bubble shows the browser glyph', async () => {
		await executeTool(
			'browser_navigate',
			JSON.stringify({ url: 'https://news.sky.com/' }),
			ctx()
		);
		// The machine boot's own rows land after the "Opening" event, so the read
		// marker has to be written last: it is the newest activity the bubble
		// reads, and the one that keeps the browser glyph up while the bot reads.
		const newest = listActivities(botId)[0];
		expect(newest.kind).toBe('browser');
		expect(newest.detail).not.toBe('');
	});

	it('hands the readable page text back, not just a confirmation', async () => {
		vi.mocked(navigateBrowser).mockResolvedValue('Title: Sky News\n\nTop story text');
		const out = await executeTool(
			'browser_navigate',
			JSON.stringify({ url: 'https://news.sky.com/' }),
			ctx()
		);
		expect(out).toBe('opened https://news.sky.com/\n\nTitle: Sky News\n\nTop story text');
	});

	it('reports a failed navigation', async () => {
		vi.mocked(navigateBrowser).mockRejectedValue(new Error('navigate failed: no CDP'));
		const out = await executeTool(
			'browser_navigate',
			JSON.stringify({ url: 'https://example.com' }),
			ctx()
		);
		expect(out).toBe('error: navigate failed: no CDP');
	});
});

describe('search_web', () => {
	// The Exa call is a plain fetch; the tests stand in for it so the tool's
	// own contract - the key lookup, the result shape, the error strings - is
	// what is under test.
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		vi.stubEnv('EXA_API_KEY', '');
		vi.stubEnv('FIRECRAWL_API_KEY', '');
		db.prepare("DELETE FROM settings WHERE key IN ('exa_api_key', 'firecrawl_api_key')").run();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('requires a query', async () => {
		expect(await executeTool('search_web', '{}', ctx())).toBe('error: query required');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('says search is not configured when there is no key anywhere', async () => {
		const out = await executeTool('search_web', JSON.stringify({ query: 'anything' }), ctx());
		expect(out).toContain('not configured');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns titles, URLs and snippets the bot can open', async () => {
		setSetting('exa_api_key', 'exa-test-key');
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ title: 'Example', url: 'https://example.com', text: 'An example site.' },
						{ title: 'Other', url: 'https://other.example', text: 'Another one.' }
					]
				})
			)
		);
		const out = await executeTool('search_web', JSON.stringify({ query: 'example' }), ctx());
		// The key on the wire is the stored one, and the ask is a search.
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.exa.ai/search');
		expect((init.headers as Record<string, string>)['x-api-key']).toBe('exa-test-key');
		expect(JSON.parse(String(init.body)).query).toBe('example');
		expect(out).toContain('1. Example');
		expect(out).toContain('https://example.com');
		expect(out).toContain('An example site.');
		expect(out).toContain('2. Other');
	});

	it('reports an Exa failure when there is no failover to try', async () => {
		setSetting('exa_api_key', 'exa-test-key');
		fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
		const out = await executeTool('search_web', JSON.stringify({ query: 'example' }), ctx());
		expect(out).toBe('error: web search failed - tried exa, and it could not answer');
	});

	it('falls back to Firecrawl when Exa fails', async () => {
		setSetting('exa_api_key', 'exa-test-key');
		setSetting('firecrawl_api_key', 'fc-test-key');
		fetchMock
			.mockResolvedValueOnce(new Response('nope', { status: 401 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						data: [{ title: 'Fallback', url: 'https://fallback.example', description: 'Via firecrawl.' }]
					})
				)
			);
		const out = await executeTool('search_web', JSON.stringify({ query: 'example' }), ctx());
		// Exa was asked first, Firecrawl second with its own key on the wire.
		const [urlA] = fetchMock.mock.calls[0] as unknown as [string];
		const [urlB, initB] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(urlA).toBe('https://api.exa.ai/search');
		expect(urlB).toBe('https://api.firecrawl.dev/v1/search');
		expect((initB.headers as Record<string, string>)['authorization']).toBe('Bearer fc-test-key');
		expect(JSON.parse(String(initB.body)).query).toBe('example');
		expect(out).toContain('1. Fallback');
		expect(out).toContain('https://fallback.example');
		expect(out).toContain('Via firecrawl.');
	});

	it('goes straight to Firecrawl when there is no Exa key', async () => {
		setSetting('firecrawl_api_key', 'fc-test-key');
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: [{ title: 'Only', url: 'https://only.example', description: 'Firecrawl alone.' }]
				})
			)
		);
		const out = await executeTool('search_web', JSON.stringify({ query: 'example' }), ctx());
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toBe('https://api.firecrawl.dev/v1/search');
		expect(out).toContain('1. Only');
	});

	it('names both providers when neither can answer', async () => {
		setSetting('exa_api_key', 'exa-test-key');
		setSetting('firecrawl_api_key', 'fc-test-key');
		fetchMock
			.mockResolvedValueOnce(new Response('nope', { status: 401 }))
			.mockRejectedValueOnce(new Error('socket hang up'));
		const out = await executeTool('search_web', JSON.stringify({ query: 'example' }), ctx());
		expect(out).toBe('error: web search failed - tried exa then firecrawl, and both could not answer');
	});

	it('is in the core set a private-room turn sees', () => {
		expect(toolsForTurn(true, 'just chatting').map((t) => t.function.name)).toContain('search_web');
	});
});

describe('browse', () => {
	it('hands the task to the browser operator and returns its report', async () => {
		const runBrowser = vi.fn(async () => 'top story: rain');
		const out = await executeTool(
			'browse',
			JSON.stringify({ task: 'open example.com and read the headline' }),
			ctx({ runBrowser })
		);
		expect(runBrowser).toHaveBeenCalledWith('open example.com and read the headline');
		expect(out).toBe('top story: rain');
	});

	it('refuses when there is no browser operator to delegate to', async () => {
		const out = await executeTool('browse', JSON.stringify({ task: 'read a page' }), ctx());
		expect(out).toBe('error: the browser is unavailable here');
	});

	it('refuses browser tools in the main loop - they are delegated', async () => {
		const out = await executeTool(
			'browser_click',
			JSON.stringify({ index: 0 }),
			ctx({ runBrowser: vi.fn() })
		);
		expect(out).toMatch(/call browse/);
		expect(browseAction).not.toHaveBeenCalled();
	});

	it('refuses the shell inside the browser toolbox', async () => {
		const out = await executeTool(
			'shell_exec',
			JSON.stringify({ command: 'ls' }),
			ctx({ toolbox: 'browser' })
		);
		expect(out).toMatch(/no shell/);
		expect(machineExec).not.toHaveBeenCalled();
	});

	it('refuses browser-only tools inside the computer toolbox', async () => {
		const out = await executeTool(
			'browser_click',
			JSON.stringify({ index: 0 }),
			ctx({ toolbox: 'computer' })
		);
		expect(out).toMatch(/call browse/);
		expect(browseAction).not.toHaveBeenCalled();
	});
});

describe('browser walk tools', () => {
	it('clicks an element by number and returns the fresh page view', async () => {
		const out = await executeTool(
			'browser_click',
			JSON.stringify({ index: 3 }),
			ctx({ toolbox: 'browser' })
		);
		expect(browseAction).toHaveBeenCalledWith(botId, { kind: 'click', index: 3 });
		expect(out).toBe('Title: Page\n\npage text');
	});

	it('fills a field by number', async () => {
		await executeTool(
			'browser_fill',
			JSON.stringify({ index: 1, text: 'hello' }),
			ctx({ toolbox: 'browser' })
		);
		expect(browseAction).toHaveBeenCalledWith(botId, { kind: 'fill', index: 1, text: 'hello' });
	});

	it('rejects a click with no element number before touching the browser', async () => {
		const out = await executeTool('browser_click', '{}', ctx({ toolbox: 'browser' }));
		expect(out).toMatch(/element number/);
		expect(browseAction).not.toHaveBeenCalled();
	});

	it('re-tags the domain when a click navigates somewhere else', async () => {
		vi.mocked(browseAction).mockResolvedValueOnce({
			text: 'Title: Other\n\nother text',
			url: 'https://other.example/path'
		});
		const c = ctx({ toolbox: 'browser' });
		await executeTool('browser_click', JSON.stringify({ index: 0 }), c);
		expect(c.currentDomain).toContain('other.example');
	});

	it('walks, scrolls, goes back and presses keys through the same driver', async () => {
		const c = ctx({ toolbox: 'browser' });
		await executeTool('browser_walk', '{}', c);
		await executeTool('browser_scroll', JSON.stringify({ direction: 'down' }), c);
		await executeTool('browser_back', '{}', c);
		await executeTool('browser_press', JSON.stringify({ key: 'enter' }), c);
		expect(vi.mocked(browseAction).mock.calls.map(([, a]) => a)).toEqual([
			{ kind: 'walk' },
			{ kind: 'scroll', direction: 'down', amount: 'page' },
			{ kind: 'back' },
			{ kind: 'press', key: 'enter' }
		]);
	});
});

describe('send_screenshot', () => {
	it('refuses when the machine is off rather than waking it', async () => {
		vi.mocked(machineStatus).mockResolvedValueOnce(statusOf('off'));
		const out = await executeTool('send_screenshot', '{}', ctx());
		expect(out).toMatch(/not built/);
		expect(captureShot).not.toHaveBeenCalled();
	});

	it('refuses when the machine is asleep rather than waking it', async () => {
		vi.mocked(machineStatus).mockResolvedValueOnce(statusOf('sleeping'));
		const out = await executeTool('send_screenshot', '{}', ctx());
		expect(out).toMatch(/asleep/);
		expect(captureShot).not.toHaveBeenCalled();
	});

	it('sends a full-screen shot into the thread as a message', async () => {
		vi.mocked(captureShot).mockResolvedValue('shot-full.png');
		const out = await executeTool('send_screenshot', '{}', ctx());
		expect(out).toContain('full screen');
		const sent = listMessages(convId).filter((m) => m.image === 'shot-full.png');
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain('full screen');
		expect(sent[0].bot_id).toBe(botId);
	});

	it('crops to a region and says which part was captured', async () => {
		vi.mocked(clampRegion).mockReturnValue({ x: 10, y: 20, w: 100, h: 50 });
		vi.mocked(captureShot).mockResolvedValue('shot-crop.png');
		const out = await executeTool(
			'send_screenshot',
			JSON.stringify({ x: 10, y: 20, width: 100, height: 50 }),
			ctx()
		);
		expect(out).toContain('100x50 at (10, 20)');
		expect(captureShot).toHaveBeenCalledWith(botId, { x: 10, y: 20, w: 100, h: 50 });
		const sent = listMessages(convId).filter((m) => m.image === 'shot-crop.png');
		expect(sent[0].content).toContain('100x50 at (10, 20)');
	});

	it('refuses a region that misses the screen', async () => {
		vi.mocked(clampRegion).mockReturnValue(null);
		const out = await executeTool(
			'send_screenshot',
			JSON.stringify({ x: 5000, y: 5000, width: 10, height: 10 }),
			ctx()
		);
		expect(out).toMatch(/outside your/);
		expect(captureShot).not.toHaveBeenCalled();
	});

	it('refuses a partial rectangle rather than guessing the rest', async () => {
		const out = await executeTool('send_screenshot', JSON.stringify({ width: 100 }), ctx());
		expect(out).toMatch(/positive width and height/);
		expect(captureShot).not.toHaveBeenCalled();
	});

	it('reports a failed capture instead of posting an empty image', async () => {
		const before = listMessages(convId).length;
		vi.mocked(captureShot).mockResolvedValue('');
		const out = await executeTool('send_screenshot', '{}', ctx());
		expect(out).toMatch(/failed/);
		// Nothing was posted: a broken capture must not leave a message behind.
		expect(listMessages(convId).length).toBe(before);
	});
});

describe('screen_look and the input tools', () => {
	it('refuses a mouse action before the screen has been looked at', async () => {
		const out = await executeTool(
			'mouse_click',
			JSON.stringify({ x: 100, y: 200 }),
			ctx()
		);
		expect(out).toMatch(/look at the screen first/);
		expect(desktopInput).not.toHaveBeenCalled();
	});

	it('acts after a look, then refuses again until the next look', async () => {
		const c = ctx();
		// screen_look is what arms the input tools: it takes the gridded shot
		// and leaves it on the context for the loop to feed the model.
		const look = await executeTool('screen_look', '{}', c);
		expect(look).toMatch(/screenshot shown/);
		expect(machineScreenshot).toHaveBeenCalledWith(botId, undefined, 100);
		expect(c.pendingShot).toBe('base64png');
		expect(c.screenSeen).toBe(true);

		const click = await executeTool('mouse_click', JSON.stringify({ x: 100, y: 200 }), c);
		expect(click).toMatch(/clicked at \(100, 200\)/);
		expect(desktopInput).toHaveBeenCalledWith(botId, {
			kind: 'click',
			x: 100,
			y: 200,
			button: 1,
			clicks: 1
		});
		// The action spent the look: the same call again is refused, and the
		// refusal is the tool's, not the model's manners.
		const again = await executeTool('mouse_click', JSON.stringify({ x: 100, y: 200 }), c);
		expect(again).toMatch(/look at the screen first/);
		expect(vi.mocked(desktopInput).mock.calls).toHaveLength(1);
	});

	it('a failed action does not spend the look', async () => {
		const c = ctx({ screenSeen: true });
		vi.mocked(desktopInput).mockRejectedValueOnce(new Error('no desktop'));
		const out = await executeTool('type_text', JSON.stringify({ text: 'hi' }), c);
		expect(out).toMatch(/error: no desktop/);
		expect(c.screenSeen).toBe(true);
	});

	it('types text and presses keys through the same gate', async () => {
		const c = ctx({ screenSeen: true });
		const out = await executeTool('key_press', JSON.stringify({ keys: 'ctrl+s' }), c);
		expect(out).toMatch(/pressed ctrl\+s/);
		expect(desktopInput).toHaveBeenCalledWith(botId, { kind: 'key', keys: 'ctrl+s' });
	});

	it('refuses a key name that is not one, before touching the machine', async () => {
		const c = ctx({ screenSeen: true });
		const out = await executeTool('key_press', JSON.stringify({ keys: '"; rm -rf /' }), c);
		expect(out).toMatch(/xdotool names/);
		expect(desktopInput).not.toHaveBeenCalled();
	});

	it('scrolls with the wheel buttons', async () => {
		const c = ctx({ screenSeen: true });
		const out = await executeTool(
			'mouse_scroll',
			JSON.stringify({ x: 10, y: 20, direction: 'up', clicks: 5 }),
			c
		);
		expect(out).toMatch(/scrolled up at \(10, 20\)/);
		expect(desktopInput).toHaveBeenCalledWith(botId, {
			kind: 'scroll',
			x: 10,
			y: 20,
			button: 4,
			clicks: 5
		});
	});
});

describe('send_message', () => {
	it('relays to the target bot and returns its reply', async () => {
		const relay = vi.fn(async () => 'hi back');
		const out = await executeTool(
			'send_message',
			JSON.stringify({ bot_name: 'RelayTarget', message: 'hello' }),
			ctx({ relay })
		);
		// The relay carries the message as sent: the room stores it under the
		// sender's id, so the text needs no "Message from" prefix to be attributed.
		expect(relay).toHaveBeenCalledWith(targetId, 'hello');
		expect(out).toBe('RelayTarget replied: hi back');
	});
	it('logs the contact only once the relay actually answered', async () => {
		const before = listActivities(botId).map((a) => a.id);
		await executeTool(
			'send_message',
			JSON.stringify({ bot_name: 'RelayTarget', message: 'hello' }),
			ctx({ relay: vi.fn(async () => 'hi back') })
		);
		// Exactly one new row, and it is the verified contact.
		const fresh = listActivities(botId).filter((a) => !before.includes(a.id));
		expect(fresh.map((a) => `${a.kind}:${a.detail}`)).toEqual(['message:To RelayTarget: hello']);
	});

	it('logs a failed relay as the failure it was, not as a contact', async () => {
		const before = listActivities(botId).map((a) => a.id);
		const out = await executeTool(
			'send_message',
			JSON.stringify({ bot_name: 'RelayTarget', message: 'hello' }),
			ctx({
				relay: vi.fn(async () => {
					throw new Error('fetch failed');
				})
			})
		);
		// The model is told the message did not get through, so it can say so.
		expect(out).toContain('error:');
		expect(out).toContain('fetch failed');
		// And the only new log row records an attempt that failed, never a
		// contact made.
		const fresh = listActivities(botId).filter((a) => !before.includes(a.id));
		expect(fresh.map((a) => `${a.kind}:${a.detail}`)).toEqual([
			'error:Tried to reach RelayTarget, failed: fetch failed'
		]);
	});

	it('refuses once the relay depth cap is reached', async () => {
		const relay = vi.fn(async () => 'unreachable');
		const out = await executeTool(
			'send_message',
			JSON.stringify({ bot_name: 'RelayTarget', message: 'hello' }),
			ctx({ depth: 2, relay })
		);
		expect(out).toMatch(/^error: relay limit/);
		expect(relay).not.toHaveBeenCalled();
	});

	it('rejects unknown bots and self-messages', async () => {
		expect(
			await executeTool(
				'send_message',
				JSON.stringify({ bot_name: 'Nobody', message: 'x' }),
				ctx({ relay: vi.fn(async () => '') })
			)
		).toBe('error: no bot named "Nobody"');
		expect(
			await executeTool(
				'send_message',
				JSON.stringify({ bot_name: 'ToolBot', message: 'x' }),
				ctx({ relay: vi.fn(async () => '') })
			)
		).toBe('error: cannot message yourself');
	});

	it('refuses a hidden system bot - the police does not take messages', async () => {
		const police = createBot({
			name: 'HiddenCop',
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		setBotHidden(police.id, true);
		const relay = vi.fn(async () => 'unreachable');
		const out = await executeTool(
			'send_message',
			JSON.stringify({ bot_name: 'HiddenCop', message: 'hello' }),
			ctx({ relay })
		);
		expect(out).toContain('system bot');
		expect(relay).not.toHaveBeenCalled();
		deleteBot(police.id);
	});
});

describe('memory and notes', () => {
	it('remember stores a fact and recall reads it back', async () => {
		expect(
			await executeTool('remember', JSON.stringify({ key: 'color', value: 'blue' }), ctx())
		).toBe('remembered');
		expect(listMemories(botId)).toContainEqual(
			expect.objectContaining({ key: 'color', value: 'blue' })
		);
		expect(await executeTool('recall', JSON.stringify({ key: 'color' }), ctx())).toBe(
			'color: blue'
		);
	});

	it('recall without a key lists every memory', async () => {
		// Both facts are set up here: asserting on one the previous test stored
		// made this pass or fail depending on the order the file ran in.
		await executeTool('remember', JSON.stringify({ key: 'k1', value: 'v1' }), ctx());
		await executeTool('remember', JSON.stringify({ key: 'k2', value: 'v2' }), ctx());
		const out = await executeTool('recall', '{}', ctx());
		expect(out).toContain('k1: v1');
		expect(out).toContain('k2: v2');
	});

	it('recall reports (none) for a bot with no memories', async () => {
		const fresh = createBot({
			name: 'FreshBot',
			persona: '',
			avatar: '🐣',
			color: '#0f0',
			model: '',
			badge: ''
		});
		expect(await executeTool('recall', '{}', ctx({ senderBotId: fresh.id }))).toBe('(none)');
	});

	it('share_note pins a note visible in the conversation', async () => {
		expect(
			await executeTool('share_note', JSON.stringify({ content: 'meeting at 3' }), ctx())
		).toBe('noted');
		expect(listNotes(convId).map((n) => n.content)).toContain('meeting at 3');
	});
});

describe('store_secret', () => {
	it.each(['../evil', 'my/api', 'na me', '$(id)'])(
		'rejects name %s that use_secret could never inject',
		async (name) => {
			const out = await executeTool(
				'store_secret',
				JSON.stringify({ name, value: 'v' }),
				ctx()
			);
			expect(out).toMatch(/^error:/);
			expect(getSecret(botId, name)).toBeUndefined();
		}
	);

	it('stores a secret under a name the injector accepts', async () => {
		const out = await executeTool(
			'store_secret',
			JSON.stringify({ name: 'api_key', value: 'v' }),
			ctx()
		);
		expect(out).toContain('stored');
		expect(getSecret(botId, 'api_key')).toBeDefined();
	});
});

describe('decline_secret', () => {
	const VALUE = 'sk-offered-VALUE-9123456789';

	it('records a decline of an offered secret, with the reason', async () => {
		// An offer is legible through the secret:<name> memory key the handover
		// route writes - the value row itself is not what marks "was offered".
		setMemory(botId, 'secret:offered', 'The user gave you a secret called "offered".');
		const out = await executeTool(
			'decline_secret',
			JSON.stringify({ name: 'offered', reason: 'not my job' }),
			ctx()
		);
		expect(out).toContain('declined');
		// The decline overwrites the offer memory: a bot that said no must not
		// keep carrying a memory that says the secret is there for it.
		const decline = listMemories(botId).find((m) => m.key === 'secret:offered');
		expect(decline?.value).toContain('You declined the secret "offered"');
		expect(decline?.value).toContain('not my job');
	});

	it('answers in a plain sentence for a secret nobody offered', async () => {
		const out = await executeTool(
			'decline_secret',
			JSON.stringify({ name: 'never_mentioned', reason: 'nope' }),
			ctx()
		);
		expect(out).toContain('no secret called "never_mentioned" was offered');
		// A decline of nothing leaves no trail either.
		expect(listMemories(botId).some((m) => m.key === 'secret:never_mentioned')).toBe(false);
	});

	it('declining something already stored explains there is nothing to refuse', async () => {
		createSecret(botId, 'held', VALUE);
		const out = await executeTool(
			'decline_secret',
			JSON.stringify({ name: 'held', reason: 'changed my mind' }),
			ctx()
		);
		expect(out).toContain('already in your vault');
		expect(getSecret(botId, 'held')).toBeDefined();
		// The memory trail is for refusals of an offer; a stored secret is not one.
		expect(listMemories(botId).some((m) => m.key === 'secret:held')).toBe(false);
	});

	it('keeps a pasted value out of the reply, the memory and the activity rows', async () => {
		// Declining a live offer: the memory note stands for what the human
		// handed over, and the reason pastes a value back - the exact move the
		// reason field must survive.
		setMemory(botId, 'secret:leaky', 'The user gave you a secret called "leaky".');
		const out = await executeTool(
			'decline_secret',
			JSON.stringify({ name: 'leaky', reason: `do not want ${VALUE} hanging around` }),
			ctx()
		);
		expect(out).not.toContain(VALUE);
		const mems = listMemories(botId).map((m) => m.value).join('\n');
		expect(mems).not.toContain(VALUE);
		// The placeholder's name is whichever row the redactor matched first -
		// two secrets may share a value - so what is asserted is that a value
		// became a named placeholder, not that the name matches this secret.
		expect(mems).toMatch(/\[secret:[a-z0-9._-]+\]/);
		const rows = listActivities(botId).map((a) => a.detail).join('\n');
		expect(rows).not.toContain(VALUE);
	});
});

describe('unshare_secret', () => {
	const VALUE = 'shared-VALUE-4567890123';

	it('removes the other bot\'s access and tells it', async () => {
		createSecret(botId, 'revoked', VALUE);
		expect(shareSecret(botId, 'revoked', targetId)).toBe(true);
		// The grant worked: the target could inject until now.
		expect(usableSecrets(targetId).map((s) => s.name)).toContain('revoked');

		const relay = vi.fn(async (_botId: string, _text: string) => 'understood');
		const out = await executeTool(
			'unshare_secret',
			JSON.stringify({ name: 'revoked', bot_name: 'RelayTarget' }),
			ctx({ relay })
		);
		expect(out).toContain('revoked RelayTarget');
		expect(usableSecrets(targetId).map((s) => s.name)).not.toContain('revoked');
		// The target hears it from the revoker, not by discovering a 403.
		expect(relay).toHaveBeenCalledWith(targetId, expect.stringContaining('revoked your share'));
	});

	it('refuses to revoke a share that does not exist, without touching anything', async () => {
		createSecret(botId, 'unshared', VALUE);
		const relay = vi.fn(async (_botId: string, _text: string) => 'should not fire');
		const out = await executeTool(
			'unshare_secret',
			JSON.stringify({ name: 'unshared', bot_name: 'RelayTarget' }),
			ctx({ relay })
		);
		expect(out).toMatch(/^error: you have no share of "unshared" with RelayTarget/);
		expect(relay).not.toHaveBeenCalled();
	});

	it('cannot revoke your own secret through it', async () => {
		createSecret(botId, 'mine', VALUE);
		const out = await executeTool(
			'unshare_secret',
			JSON.stringify({ name: 'mine', bot_name: 'ToolBot' }),
			ctx()
		);
		expect(out).toMatch(/^error: it is your own secret/);
		expect(getSecret(botId, 'mine')).toBeDefined();
	});

	it('leaves the owner\'s own copy usable after the revoke', async () => {
		createSecret(botId, 'still_mine', VALUE);
		shareSecret(botId, 'still_mine', targetId);
		await executeTool(
			'unshare_secret',
			JSON.stringify({ name: 'still_mine', bot_name: 'RelayTarget' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(usableSecrets(botId).map((s) => s.name)).toContain('still_mine');
		const rows = listActivities(botId).map((a) => a.detail).join('\n');
		expect(rows).not.toContain(VALUE);
	});
});

describe('handover_cookies', () => {
	const cookie = { name: 'sid', value: 'COOKIE-VALUE-XYZ', domain: 'example.com', path: '/' };

	it("hands the site's cookies over once the police approve, and tells the recipient", async () => {
		vi.mocked(exportCookies).mockResolvedValue([cookie]);
		vi.mocked(importCookies).mockResolvedValue(1);
		const relay = vi.fn(async (_botId: string, _text: string) => 'thanks');
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({
				bot_name: 'RelayTarget',
				site: 'example.com',
				reason: 'we are doing a task together'
			}),
			ctx({ relay })
		);
		expect(exportCookies).toHaveBeenCalledWith(botId, 'example.com');
		expect(importCookies).toHaveBeenCalledWith(targetId, [cookie]);
		expect(out).toContain('handed 1 cookie for example.com to RelayTarget');
		// The recipient is told who, which site and why - never silently injected.
		expect(relay).toHaveBeenCalledWith(targetId, expect.stringContaining('example.com'));
		expect(relay.mock.calls[0][1]).toContain('ToolBot');
		expect(relay.mock.calls[0][1]).toContain('we are doing a task together');
	});

	it('never puts a cookie value in the reply or an activity row', async () => {
		vi.mocked(exportCookies).mockResolvedValue([cookie]);
		vi.mocked(importCookies).mockResolvedValue(1);
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({ bot_name: 'RelayTarget', site: 'example.com', reason: 'a task' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).not.toContain('COOKIE-VALUE-XYZ');
		const rows = listActivities(botId)
			.map((a) => a.detail)
			.join('\n');
		expect(rows).not.toContain('COOKIE-VALUE-XYZ');
	});

	it('refuses the handover when the police refuse, importing nothing', async () => {
		vi.mocked(exportCookies).mockResolvedValue([cookie]);
		vi.mocked(reviewCookieHandover).mockResolvedValueOnce({
			approved: false,
			reason: 'the reason is too vague'
		});
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({ bot_name: 'RelayTarget', site: 'example.com', reason: 'just because' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toMatch(/^error: the police refused/);
		expect(out).toContain('the reason is too vague');
		expect(importCookies).not.toHaveBeenCalled();
	});

	it('refuses a recipient whose machine is off rather than waking it', async () => {
		vi.mocked(machineStatus).mockResolvedValueOnce(statusOf('sleeping'));
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({ bot_name: 'RelayTarget', site: 'example.com', reason: 'a task' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toMatch(/^error: RelayTarget's machine is asleep/);
		expect(exportCookies).not.toHaveBeenCalled();
	});

	it('refuses when the sender holds no cookies for the site', async () => {
		vi.mocked(exportCookies).mockResolvedValue([]);
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({ bot_name: 'RelayTarget', site: 'example.com', reason: 'a task' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toBe('error: you have no cookies for example.com');
		expect(reviewCookieHandover).not.toHaveBeenCalled();
	});

	it('refuses a hidden system bot as the recipient', async () => {
		const system = createBot({
			name: `system-${Date.now()}`,
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		});
		setBotHidden(system.id, true);
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({ bot_name: system.name, site: 'example.com', reason: 'a task' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toMatch(/^error: .* is a system bot/);
		deleteBot(system.id);
	});

	it('refuses when the recipient has blocked the sender', async () => {
		blockBot(targetId, botId, 'no');
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({ bot_name: 'RelayTarget', site: 'example.com', reason: 'a task' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toMatch(/^error: RelayTarget has blocked you/);
		unblockBot(targetId, botId);
	});

	it('requires a reason', async () => {
		const out = await executeTool(
			'handover_cookies',
			JSON.stringify({ bot_name: 'RelayTarget', site: 'example.com', reason: '   ' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toBe('error: reason required - the police judge it');
	});
});

describe('error handling', () => {
	it('returns an error for an unknown tool', async () => {
		expect(await executeTool('nonsense', '{}', ctx())).toBe('error: unknown tool "nonsense"');
	});

	it('returns an error instead of throwing on malformed argsJson', async () => {
		expect(await executeTool('shell_exec', '{oops', ctx())).toBe(
			'error: invalid tool arguments'
		);
	});
});

describe('wear_hat', () => {
	it('puts on a hat from the library and keeps it', async () => {
		const id = hatBot();
		expect(await executeTool('wear_hat', JSON.stringify({ hat: 'crown' }), ctxFor(id))).toBe(
			'wearing the crown hat'
		);
		expect(getBot(id)?.hat).toBe('crown');
	});

	it('takes it off again with an empty name', async () => {
		const id = hatBot();
		await executeTool('wear_hat', JSON.stringify({ hat: 'party' }), ctxFor(id));
		expect(await executeTool('wear_hat', JSON.stringify({ hat: '' }), ctxFor(id))).toBe('hat off');
		expect(getBot(id)?.hat).toBe('');
	});

	it('names the library rather than accepting a hat that does not exist', async () => {
		const id = hatBot();
		const out = await executeTool('wear_hat', JSON.stringify({ hat: 'sombrero' }), ctxFor(id));
		expect(out).toContain('error: no such hat');
		expect(out).toContain('crown');
		expect(getBot(id)?.hat).toBe('');
	});

	it('is tolerant of how the name arrives', async () => {
		const id = hatBot();
		expect(await executeTool('wear_hat', JSON.stringify({ hat: '  WIZARD ' }), ctxFor(id))).toBe(
			'wearing the wizard hat'
		);
	});
});

/** A bot of its own, so a hat one test puts on cannot leak into another. */
function hatBot(): string {
	return createBot({ name: `hat-${Math.random().toString(36).slice(2, 8)}`, persona: '', avatar: '', color: '', model: '', badge: '' }).id;
}

/** A bot of its own to hang files on, for the same reason as hatBot. */
function fileBot(): string {
	return createBot({ name: `files-${Math.random().toString(36).slice(2, 8)}`, persona: '', avatar: '', color: '', model: '', badge: '' }).id;
}

/** A text file of `n` numbered lines: short lines, but many of them. */
function longFile(n: number): string {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

function ctxFor(id: string) {
	return ctx({ senderBotId: id });
}

describe('files', () => {
	it('says so plainly when the user has given it nothing', async () => {
		expect(await executeTool('list_files', '{}', ctxFor(fileBot()))).toBe(
			'The user has not given you any files.'
		);
	});

	it('lists what it has, with the size and the kind, and never the contents', async () => {
		const id = fileBot();
		await saveFile(id, 'notes.txt', Buffer.from('hello there'));
		await saveFile(id, 'shot.png', Buffer.from('png-bytes'));

		const out = await executeTool('list_files', '{}', ctxFor(id));
		expect(out).toContain('notes.txt — 11 B, text/plain');
		expect(out).toContain('shot.png — 9 B, image/png');
		expect(out).not.toContain('hello there');
	});

	it('caps a big inventory and says how many files it did not list', async () => {
		const id = fileBot();
		// Names long enough that a few dozen rows pass the cap on their own.
		for (let i = 0; i < 60; i++) {
			await saveFile(id, `f${i}-${'x'.repeat(110)}.txt`, Buffer.from('x'));
		}

		const out = await executeTool('list_files', '{}', ctxFor(id));
		expect([...out].length).toBeLessThan(8100);
		expect(out).toMatch(/— \d+ of 60 files listed here/);
	});

	it('reads the start of a short text file, numbered, and says it is all of it', async () => {
		const id = fileBot();
		await saveFile(id, 'notes.txt', Buffer.from('first\nsecond\nthird'));

		expect(await executeTool('read_file', JSON.stringify({ name: 'notes.txt' }), ctxFor(id))).toBe(
			'   1| first\n   2| second\n   3| third\n— 3 lines, all shown.'
		);
	});

	it('gives a few dozen lines of a long file and points at the next page', async () => {
		const id = fileBot();
		await saveFile(id, 'long.txt', Buffer.from(longFile(200)));

		const out = await executeTool('read_file', JSON.stringify({ name: 'long.txt' }), ctxFor(id));
		const rows = out.split('\n');
		expect(rows[0]).toBe('   1| line 1');
		expect(rows[39]).toBe('  40| line 40');
		// Nothing past the head, and the reader is told where to go next.
		expect(out).not.toContain('| line 41');
		expect(out).toContain('lines 1-40 of 200');
		expect(out).toContain('read_lines {name: "long.txt", from: 41, to: 80}');
	});

	it('returns exactly the lines a range asks for', async () => {
		const id = fileBot();
		await saveFile(id, 'long.txt', Buffer.from(longFile(200)));

		const out = await executeTool(
			'read_lines',
			JSON.stringify({ name: 'long.txt', from: 5, to: 7 }),
			ctxFor(id)
		);
		expect(out).toBe(
			'   5| line 5\n   6| line 6\n   7| line 7\n— lines 5-7 of 200: read on from 8, to 47.'
		);
	});

	it('reads the tail of a file and says it reached the end', async () => {
		const id = fileBot();
		await saveFile(id, 'long.txt', Buffer.from(longFile(12)));

		const out = await executeTool(
			'read_lines',
			JSON.stringify({ name: 'long.txt', from: 10 }),
			ctxFor(id)
		);
		expect(out).toBe('  10| line 10\n  11| line 11\n  12| line 12\n— lines 10-12 of 12, the end of the file.');
	});

	it('refuses a range that is not a range', async () => {
		const id = fileBot();
		await saveFile(id, 'long.txt', Buffer.from(longFile(10)));

		for (const range of [
			{ from: 0, to: 3 },
			{ from: 5, to: 2 },
			{ from: 1.5, to: 3 },
			{ from: 1, to: 'end' }
		]) {
			expect(
				await executeTool('read_lines', JSON.stringify({ name: 'long.txt', ...range }), ctxFor(id)),
				JSON.stringify(range)
			).toBe('error: from and to must be whole line numbers, with to at or after from');
		}
	});

	it('finds matching lines with their line numbers, ignoring case', async () => {
		const id = fileBot();
		await saveFile(id, 'log.txt', Buffer.from('alpha\nbeta\ngamma\nALPHA again'));

		// One named file: numbered like read_lines, since the file is a given.
		expect(
			await executeTool('grep_files', JSON.stringify({ pattern: 'alpha', name: 'log.txt' }), ctxFor(id))
		).toBe('   1| alpha\n   4| ALPHA again\n— 2 matching lines.');
		// Every file: file:line:, so the hits can be told apart.
		expect(await executeTool('grep_files', JSON.stringify({ pattern: 'alpha' }), ctxFor(id))).toBe(
			'log.txt:1: alpha\nlog.txt:4: ALPHA again\n— 2 matching lines.'
		);
	});

	it('searches every text file, and says which ones it could not search', async () => {
		const id = fileBot();
		await saveFile(id, 'a.txt', Buffer.from('needle one'));
		await saveFile(id, 'b.txt', Buffer.from('haystack\nneedle two'));
		await saveFile(id, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		const out = await executeTool('grep_files', JSON.stringify({ pattern: 'needle' }), ctxFor(id));
		expect(out).toContain('a.txt:1: needle one');
		expect(out).toContain('b.txt:2: needle two');
		expect(out).toContain('not searched: shot.png - not text');
	});

	it('says when nothing matches, and where it looked', async () => {
		const id = fileBot();
		await saveFile(id, 'log.txt', Buffer.from('alpha'));

		expect(await executeTool('grep_files', JSON.stringify({ pattern: 'zebra' }), ctxFor(id))).toBe(
			'No lines match "zebra" in 1 text file.'
		);
		expect(
			await executeTool('grep_files', JSON.stringify({ pattern: 'zebra', name: 'log.txt' }), ctxFor(id))
		).toBe('No lines match "zebra" in log.txt.');
	});

	it('caps a search and says how many matches were left out', async () => {
		const id = fileBot();
		await saveFile(
			id,
			'big.txt',
			Buffer.from(Array.from({ length: 200 }, (_, i) => `hit ${i + 1} ${'x'.repeat(50)}`).join('\n'))
		);

		const out = await executeTool('grep_files', JSON.stringify({ pattern: 'hit' }), ctxFor(id));
		expect([...out].length).toBeLessThan(8100);
		expect(out).toContain('of 200 matching lines');
		expect(out).toContain('narrow the pattern');
		expect(out).toContain('for the rest');
	});

	it('never returns a single line that is over the cap without saying so', async () => {
		const id = fileBot();
		await saveFile(id, 'wide.txt', Buffer.from(`start ${'x'.repeat(20000)}`));

		const out = await executeTool('read_file', JSON.stringify({ name: 'wide.txt' }), ctxFor(id));
		expect([...out].length).toBeLessThan(8200);
		expect(out).toContain('longer than one result can hold');
	});

	it('reads the newest copy when a name has been given more than once', async () => {
		const id = fileBot();
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000_000);
			await saveFile(id, 'same.txt', Buffer.from('FIRST'));
			vi.setSystemTime(2_000_000);
			await saveFile(id, 'same.txt', Buffer.from('SECOND'));

			expect(await executeTool('read_file', JSON.stringify({ name: 'same.txt' }), ctxFor(id))).toBe(
				'   1| SECOND\n— 1 line, all shown.'
			);
			// And the inventory says which one is which, so both are legible.
			const list = await executeTool('list_files', '{}', ctxFor(id));
			expect(list).toContain('(the newest of 2 files with this name)');
			expect(list).toContain('(an older copy; this name reads the newest)');
		} finally {
			vi.useRealTimers();
		}
	});

	it('finds a file the model capitalised differently', async () => {
		const id = fileBot();
		await saveFile(id, 'Notes.TXT', Buffer.from('case matters'));

		expect(await executeTool('read_file', JSON.stringify({ name: 'notes.txt' }), ctxFor(id))).toBe(
			'   1| case matters\n— 1 line, all shown.'
		);
	});

	it('describes a file that is not text instead of dumping its bytes', async () => {
		const id = fileBot();
		await saveFile(id, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

		for (const tool of ['read_file', 'read_lines']) {
			const out = await executeTool(tool, JSON.stringify({ name: 'shot.png', from: 1, to: 5 }), ctxFor(id));
			expect(out).toContain('image/png');
			expect(out).toContain('nothing to read');
			expect(out).not.toContain('\u0000');
		}
		// There is nothing in a PNG to grep either.
		expect(await executeTool('grep_files', JSON.stringify({ name: 'shot.png', pattern: 'x' }), ctxFor(id))).toBe(
			'No lines match "x" in shot.png. (not searched: shot.png - not text)'
		);
	});

	it('cannot read a file that belongs to another bot', async () => {
		const mine = fileBot();
		const theirs = fileBot();
		await saveFile(theirs, 'private.txt', Buffer.from('not yours'));

		for (const tool of ['read_file', 'read_lines', 'grep_files']) {
			expect(
				await executeTool(tool, JSON.stringify({ name: 'private.txt', pattern: 'not' }), ctxFor(mine))
			).toBe('error: no file named "private.txt"');
		}
	});

	it('asks for a name rather than inventing one', async () => {
		const id = fileBot();
		expect(await executeTool('read_file', '{}', ctxFor(id))).toBe('error: name required');
		expect(await executeTool('read_file', JSON.stringify({ name: 'nope.txt' }), ctxFor(id))).toBe(
			'error: no file named "nope.txt"'
		);
		expect(await executeTool('grep_files', '{}', ctxFor(id))).toBe('error: pattern required');
		expect(
			await executeTool('grep_files', JSON.stringify({ pattern: 'x'.repeat(201) }), ctxFor(id))
		).toBe('error: pattern must be 200 characters or fewer');
	});
});

describe('the machine', () => {
	// A bot cannot know whether its machine is up before it asks, so each of the
	// three states is an answer rather than a failure - and asking must never be
	// the thing that breaks the turn.
	it('sleeps a running machine, saying so, and names the requester in the log', async () => {
		vi.mocked(sleepMachine).mockResolvedValue('running');

		expect(await executeTool('sleep_machine', '{}', ctx())).toBe(
			'Your machine is asleep. wake_machine brings it back in seconds.'
		);
		expect(sleepMachine).toHaveBeenCalledWith(botId, 'on request');
	});

	it('reports a machine that was already asleep, and one never built', async () => {
		vi.mocked(sleepMachine).mockResolvedValue('sleeping');
		expect(await executeTool('sleep_machine', '{}', ctx())).toBe(
			'Your machine was already asleep.'
		);

		vi.mocked(sleepMachine).mockResolvedValue('off');
		expect(await executeTool('sleep_machine', '{}', ctx())).toBe(
			'You have no machine yet, so there is nothing to sleep.'
		);
	});

	it('wakes a machine, saying which of the three states it came from', async () => {
		vi.mocked(machineStatus).mockResolvedValue(statusOf('sleeping'));
		expect(await executeTool('wake_machine', '{}', ctx())).toBe('Your machine is awake again.');

		vi.mocked(machineStatus).mockResolvedValue(statusOf('running'));
		expect(await executeTool('wake_machine', '{}', ctx())).toBe(
			'Your machine was already awake.'
		);

		vi.mocked(machineStatus).mockResolvedValue(statusOf('off'));
		expect(await executeTool('wake_machine', '{}', ctx())).toBe(
			'Your machine is awake - it had not been built yet, so a new one was created.'
		);
		expect(ensureMachine).toHaveBeenCalledWith(botId);
	});

	it('reports the state, the last use and the idle window the reaper uses', async () => {
		vi.mocked(machineStatus).mockResolvedValue({
			...statusOf('running'),
			lastActive: Date.now() - 4 * 60_000
		});
		expect(await executeTool('machine_status', '{}', ctx())).toBe(
			'Your machine is running. Last used 4m ago. It sleeps on its own after 9 idle ' +
				'minutes; sleep_machine puts it down now, wake_machine brings it back in seconds.'
		);

		// The window is the operator's and read-only, so the other two states
		// still name it rather than implying a bot could change it.
		vi.mocked(machineStatus).mockResolvedValue(statusOf('sleeping'));
		expect(await executeTool('machine_status', '{}', ctx())).toBe(
			'Your machine is asleep, costing nothing while it is down. It sleeps on its own ' +
				'after 9 idle minutes once it is up; wake_machine brings it back now.'
		);

		vi.mocked(machineStatus).mockResolvedValue(statusOf('off'));
		expect(await executeTool('machine_status', '{}', ctx())).toBe(
			'You have no machine yet - the first command or page you open builds one. It ' +
				'sleeps on its own after 9 idle minutes; wake_machine builds it now.'
		);
	});
});

describe('request_change', () => {
	it('files the ask and drops a card in the police\'s own chat', async () => {
		const out = await executeTool(
			'request_change',
			JSON.stringify({ need: 'install ffmpeg on the host', reason: 'clips need transcoding' }),
			ctx()
		);
		expect(out).toContain('request filed');
		const asks = pendingChangeRequests().filter((r) => r.bot_id === botId);
		expect(asks).toHaveLength(1);
		expect(asks[0].need).toBe('install ffmpeg on the host');
		// The card is a marker message in the officer's DM, kind 'ask', so the
		// panel can hang Approve/Deny off it and the model never sees it.
		const dm = directConversationWith(policeId)!;
		const card = listMessages(dm.id).find((m) => m.kind === 'ask');
		expect(card).toBeTruthy();
		expect(JSON.parse(card!.content).change_request).toBe(asks[0].id);
	});

	it('refuses a second ask while the first is still waiting', async () => {
		await executeTool('request_change', JSON.stringify({ need: 'first ask' }), ctx());
		const out = await executeTool('request_change', JSON.stringify({ need: 'second ask' }), ctx());
		expect(out).toContain('already have a request waiting');
		expect(pendingChangeRequests().filter((r) => r.bot_id === botId)).toHaveLength(1);
	});
});

describe('nix', () => {
	it('refuses while the human has not enabled it', async () => {
		const out = await executeTool('nix', JSON.stringify({ args: '--version' }), ctx());
		expect(out).toContain('Nix is not enabled');
		expect(machineExec).not.toHaveBeenCalled();
	});

	it('runs the nix command once the human switched it on', async () => {
		updateBot(botId, { nix_enabled: 1 });
		try {
			const out = await executeTool('nix', JSON.stringify({ args: '--version' }), ctx());
			expect(out).toBe('machine output');
			const cmd = vi.mocked(machineExec).mock.calls[0][1];
			expect(cmd).toContain('nix --version');
			// The bootstrap line is what makes first use work on a bare machine.
			expect(cmd).toContain('nixos.org/nix/install');
		} finally {
			updateBot(botId, { nix_enabled: 0 });
		}
	});
});

describe('wait_for', () => {
	afterEach(() => {
		for (const w of listWaits()) deleteWait(w.id);
	});

	it('arms a watch from the arguments and says what it is watching for', async () => {
		const out = await executeTool(
			'wait_for',
			JSON.stringify({
				description: 'someone says deploy',
				pattern: 'deploy',
				from: 'user',
				expires_minutes: 30
			}),
			ctx()
		);

		expect(out).toBe('watching (message) for: someone says deploy | gives up after 30m');
		const [wait] = listWaits(botId);
		expect(wait.kind).toBe('message');
		expect(JSON.parse(wait.spec)).toMatchObject({ pattern: 'deploy', from: 'user' });
		expect(wait.expires_at).toBeGreaterThan(Date.now());
	});

	it('takes a url as an http watch and a webhook watch as a URL to hand out', async () => {
		await executeTool(
			'wait_for',
			JSON.stringify({ description: 'the build', url: 'https://example.com/b', contains: 'DONE' }),
			ctx()
		);
		expect(listWaits(botId)[0].kind).toBe('http');

		for (const w of listWaits()) deleteWait(w.id);
		const out = await executeTool(
			'wait_for',
			JSON.stringify({ description: 'ci says go', kind: 'webhook', pattern: 'green' }),
			ctx()
		);
		const [hook] = listWaits(botId);
		expect(hook.kind).toBe('webhook');
		expect(out).toContain(`POST anything to /api/hooks/${hook.token}`);
	});

	it('answers a watch it cannot arm with an error rather than throwing', async () => {
		expect(await executeTool('wait_for', JSON.stringify({ description: 'a page', kind: 'http' }), ctx())).toBe(
			'error: an http watch needs a url (http reads: url, contains, status, changed, every_seconds)'
		);
	});


	it('refuses an http watch aimed inside the app network, and arms nothing', async () => {
		const out = await executeTool(
			'wait_for',
			JSON.stringify({
				description: 'the metadata service',
				kind: 'http',
				url: 'http://169.254.169.254/latest/meta-data/'
			}),
			ctx()
		);
		expect(out).toMatch(/internal to the app's network/);
		expect(listWaits(botId)).toEqual([]);
	});
});

describe('schedule_task', () => {
	afterEach(() => {
		for (const w of listWakes()) deleteWake(w.id);
	});

	it('rejects a negative or zero delay and conflicting delay+cron', async () => {
		expect(
			await executeTool(
				'schedule_task',
				JSON.stringify({ prompt: 'stretch', delay_minutes: -5 }),
				ctx()
			)
		).toBe('error: delay_minutes must be a positive number');
		expect(
			await executeTool(
				'schedule_task',
				JSON.stringify({ prompt: 'stretch', delay_minutes: 10, cron: '*/30 * * * *' }),
				ctx()
			)
		).toBe('error: give delay_minutes or cron, not both');
		expect(listWakes(botId)).toEqual([]);
	});

	it('schedules a one-off wake from a positive delay', async () => {
		const out = await executeTool(
			'schedule_task',
			JSON.stringify({ prompt: 'stretch', delay_minutes: 10 }),
			ctx()
		);
		expect(out).toContain('scheduled in 10m');
		expect(out).toContain('police: VERIFIED');
		expect(listWakes(botId)[0].run_at).toBeGreaterThan(Date.now());
	});

	it('does not present a schedule the police refuse as working', async () => {
		vi.mocked(reviewRoutine).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'it fires every minute and would spam the room'
		});
		const out = await executeTool(
			'schedule_task',
			JSON.stringify({ prompt: 'Say hello', cron: '* * * * *' }),
			ctx()
		);
		// The refusal is the officer's own words, and it never reads as a pass.
		expect(out).toContain('REFUSED');
		expect(out).toContain('would spam the room');
		expect(out).not.toContain('VERIFIED');
		// The wake is kept so the author can fix it, but it is switched off.
		const wake = listWakes(botId).find((w) => w.prompt === 'Say hello');
		expect(wake?.enabled).toBe(0);
		expect(wake?.paused_reason).toContain('would spam the room');
		if (wake) deleteWake(wake.id);
	});

	it('schedules the wake unchecked when the wake check is switched off', async () => {
		vi.mocked(policeSettings).mockReturnValue(policeChecks(true, true, false));
		const out = await executeTool(
			'schedule_task',
			JSON.stringify({ prompt: 'Unchecked wake', delay_minutes: 5 }),
			ctx()
		);
		expect(vi.mocked(reviewRoutine)).not.toHaveBeenCalled();
		expect(out).toContain('scheduled in 5m');
		expect(out).not.toContain('police:');
		const wake = listWakes(botId).find((w) => w.prompt === 'Unchecked wake');
		// The wake runs: a gate switched off must not leave it paused either.
		expect(wake?.enabled).toBe(1);
		expect(wake?.verification).toBe('');
		if (wake) deleteWake(wake.id);
	});
});

describe('create_plugin', () => {
	it('creates the plugin for the calling bot, never shared, even when asked', async () => {
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({
				name: 'Sneaky Hook',
				kind: 'hook',
				hook_point: 'before_reply',
				code: 'return args.message;',
				shared: true
			}),
			ctx()
		);
		expect(out).toContain('(bot)');
		const created = pluginsForBot(botId).find((p) => p.name === 'Sneaky Hook');
		expect(created?.scope).toBe('bot');
		// Not in another bot's plugin list: that is what 'shared' would have meant.
		expect(pluginsForBot(targetId).find((p) => p.name === 'Sneaky Hook')).toBeUndefined();
		if (created) deletePlugin(created.id);
	});

	it('rejects a hook with no usable hook_point', async () => {
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({ name: 'Pointless Hook', kind: 'hook', code: 'return args.message;' }),
			ctx()
		);
		expect(out).toBe('error: hook_point must be before_reply or after_reply');
		expect(pluginsForBot(botId).find((p) => p.name === 'Pointless Hook')).toBeUndefined();
	});

	it('does not present a plugin the police refuse as working', async () => {
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'the code is a stub that returns a fixed string'
		});
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({ name: 'Stub Tool', kind: 'tool', code: 'return "ok";' }),
			ctx()
		);
		// The refusal is the officer's own words, and it never reads as a pass.
		expect(out).toContain('REFUSED');
		expect(out).toContain('the code is a stub that returns a fixed string');
		expect(out).not.toContain('VERIFIED');
		// The plugin is kept so the author can fix it, but it is switched off.
		const created = pluginsForBot(botId).find((p) => p.name === 'Stub Tool');
		expect(created?.enabled).toBe(0);
		expect(created?.effective_enabled).toBe(0);
		if (created) deletePlugin(created.id);
	});

	it('switches a brand-new plugin off when the police cannot be reached', async () => {
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'unreviewed',
			reason: 'the police could not be reached (provider down)'
		});
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({ name: 'Unreviewed Tool', kind: 'tool', code: 'return "ok";' }),
			ctx()
		);
		expect(out).toContain('created tool plugin "Unreviewed Tool"');
		expect(out).toContain('UNREVIEWED');
		expect(out).toContain('provider down');
		expect(out).toContain('switched off until the police can review it');
		// A new plugin is unsigned code: an unreachable police force must not
		// leave it live. It is kept so the author can update it once the police
		// are back, but it is off until then.
		const created = pluginsForBot(botId).find((p) => p.name === 'Unreviewed Tool');
		expect(created?.enabled).toBe(0);
		if (created) deletePlugin(created.id);
	});

	it('stores the author\'s own tests and runs them before the officer sees the code', async () => {
		// The harness is a container round-trip; the plugin module is real here,
		// so the test run is stubbed to its results and the point under test is
		// what the author's tests do to the reply and the brief.
		vi.mocked(runPluginTests).mockResolvedValueOnce([
			{ name: 'greets', ok: true, output: 'hi bob' },
			{ name: 'shouts', ok: false, output: 'hi bob' }
		]);
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({
				name: 'Bilingual',
				kind: 'tool',
				code: 'return "hi " + args.word;',
				tests: [{ name: 'shouts', args: { word: 'BOB' }, expect: 'HI BOB' }]
			}),
			ctx()
		);
		// The tests are the author's own proof, and the reply says how they went.
		expect(out).toContain('unit tests: 1/2 passed');
		expect(out).toContain('shouts FAILED');
		const created = pluginsForBot(botId).find((p) => p.name === 'Bilingual');
		expect(JSON.parse(created?.tests ?? 'null')).toEqual([
			{ name: 'shouts', args: { word: 'BOB' }, expect: 'HI BOB' }
		]);
		// The results ride with the code to the officer, not just to the author.
		expect(vi.mocked(reviewPlugin).mock.calls[0][0].tests).toEqual([
			{ name: 'greets', ok: true, output: 'hi bob' },
			{ name: 'shouts', ok: false, output: 'hi bob' }
		]);
		if (created) deletePlugin(created.id);
	});

	it('refuses an author whose tests are not tests rather than dropping them quietly', async () => {
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({ name: 'Sloppy', kind: 'tool', code: 'return "ok";', tests: [{ args: {} }] }),
			ctx()
		);
		expect(out).toBe('error: every test needs a name');
		// Nothing is created for a call the author has to fix first.
		expect(pluginsForBot(botId).find((p) => p.name === 'Sloppy')).toBeUndefined();
	});

	it('refuses a name that is already taken, the way the API 409s', async () => {
		createPlugin({
			name: 'Taken Name',
			description: '',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: 'return "first";',
			author_bot_id: botId,
			scope: 'bot',
			enabled: 1
		});
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({ name: 'taken name', kind: 'tool', code: 'return "second";' }),
			ctx()
		);
		// Case-insensitive, like the API: tools dispatch on the slugified name,
		// so a second plugin with it would be unreachable.
		expect(out).toContain('already exists');
		expect(out).toContain('update_plugin');
		expect(pluginsForBot(botId).filter((p) => p.name.toLowerCase() === 'taken name')).toHaveLength(1);
		const created = pluginsForBot(botId).find((p) => p.name === 'Taken Name');
		if (created) deletePlugin(created.id);
	});


	it('creates the plugin unchecked and unrefused when the check is switched off', async () => {
		vi.mocked(policeSettings).mockReturnValue(policeChecks(false, false));
		const out = await executeTool(
			'create_plugin',
			JSON.stringify({ name: 'Unchecked Tool', kind: 'tool', code: 'return "ok";' }),
			ctx()
		);
		// The officer is never phoned, so there is no verdict to read back.
		expect(vi.mocked(reviewPlugin)).not.toHaveBeenCalled();
		expect(out).not.toContain('police:');
		const created = pluginsForBot(botId).find((p) => p.name === 'Unchecked Tool');
		// A gate switched off must not leave the work off either.
		expect(created?.enabled).toBe(1);
		// Nor leave a verdict row behind: a review that never ran must not read as
		// one the console can show.
		expect(created?.verification).toBe('');
		if (created) deletePlugin(created.id);
	});

	it('counts a refused plugin\'s attempts and stops inviting resubmits at the bound', async () => {
		vi.mocked(reviewPlugin).mockResolvedValue({
			verdict: 'rejected',
			reason: 'the code is a stub that returns a fixed string'
		});
		const create = () =>
			executeTool(
				'create_plugin',
				JSON.stringify({ name: 'Stub Tool', kind: 'tool', code: 'return "ok";' }),
				ctx()
			);
		const update = () =>
			executeTool(
				'update_plugin',
				JSON.stringify({ name: 'Stub Tool', code: 'return "ok";' }),
				ctx()
			);
		// A refusal under the bound says which attempt it was and invites the fix.
		expect(await create()).toContain('REFUSED - the code is a stub that returns a fixed string (attempt 1 of 3 - fix it and resubmit)');
		// The name is taken once the row exists, so the retry path is
		// update_plugin - a second create is refused outright.
		expect(await create()).toContain('already exists');
		expect(await update()).toContain('attempt 2 of 3');
		// The attempt that spends the last one invites nothing: the question is
		// the human's now, and the row says so.
		const last = await update();
		expect(last).toContain('no attempts left');
		expect(last).not.toContain('fix it and resubmit');
		expect(last).not.toContain('fix it and update the plugin');
		const created = pluginsForBot(botId).findLast((p) => p.name === 'Stub Tool');
		const stored = JSON.parse(created?.verification ?? '{}');
		expect(stored.attempts).toBe(3);
		expect(stored.awaitingHuman).toBe(true);
		expect(created?.enabled).toBe(0);
		if (created) deletePlugin(created.id);
	});

	/**
	 * A review that could not run must not write itself over what the row
	 * already says: an 'unreviewed' verdict where a refusal stands would turn
	 * refused code back into unsigned code, which the console's switch is then
	 * free to turn on - and the attempts the refusal counted would be gone.
	 */
	it('keeps a standing refusal when the officer cannot be reached again', async () => {
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'the code is a stub that returns a fixed string'
		});
		await executeTool(
			'create_plugin',
			JSON.stringify({ name: 'Outage Tool', kind: 'tool', code: 'return "ok";' }),
			ctx()
		);
		const refused = pluginsForBot(botId).find((p) => p.name === 'Outage Tool')!;
		const before = refused.verification;
		expect(JSON.parse(before).verdict).toBe('rejected');

		// The author fixes it and resubmits into an outage.
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'unreviewed',
			reason: 'the police could not be reached (provider down)'
		});
		const out = await executeTool(
			'update_plugin',
			JSON.stringify({ name: 'Outage Tool', code: 'return "fixed";' }),
			ctx()
		);
		expect(out).toContain('the refusal it already carries still stands');
		const after = pluginsForBot(botId).find((p) => p.name === 'Outage Tool')!;
		expect(after.verification).toBe(before);
		expect(after.enabled).toBe(0);
		deletePlugin(refused.id);
	});
});

describe('my_plugins', () => {
	it('says plainly when the bot has none', async () => {
		const fresh = createBot({
			name: 'Pluginless',
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		}).id;
		expect(await executeTool('my_plugins', '{}', ctx({ senderBotId: fresh }))).toBe(
			'You have no plugins yet.'
		);
	});

	it("reads back a plugin's code, parameters, hook point and state", async () => {
		const p = createPlugin({
			name: 'Disk Check',
			description: 'checks free disk space',
			kind: 'hook',
			hook_point: 'after_reply',
			parameters: '{"type":"object","properties":{"path":{"type":"string"}}}',
			code: 'return args.message.trim();',
			author_bot_id: botId,
			scope: 'bot',
			enabled: 1
		});
		const out = await executeTool('my_plugins', JSON.stringify({ name: 'Disk Check' }), ctx());
		expect(out).toContain('Disk Check - hook, runs after_reply, on, yours');
		expect(out).toContain('checks free disk space');
		expect(out).toContain('"path"');
		expect(out).toContain('return args.message.trim();');
		deletePlugin(p.id);
	});

	it("never shows another bot's private plugin", async () => {
		const theirs = createPlugin({
			name: 'Their Secret',
			description: '',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: 'return 1;',
			author_bot_id: targetId,
			scope: 'bot',
			enabled: 1
		});
		const out = await executeTool('my_plugins', '{}', ctx());
		expect(out).not.toContain('Their Secret');
		deletePlugin(theirs.id);
	});

	it('shows a shared plugin, marked as shared', async () => {
		const shared = createPlugin({
			name: 'Shared Echo',
			description: '',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: 'return 1;',
			author_bot_id: targetId,
			scope: 'shared',
			enabled: 1
		});
		const out = await executeTool('my_plugins', '{}', ctx());
		expect(out).toContain('Shared Echo - tool, on, shared with you');
		deletePlugin(shared.id);
	});

	it('marks a disabled plugin off', async () => {
		const off = createPlugin({
			name: 'Off Tool',
			description: '',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: '',
			author_bot_id: botId,
			scope: 'bot',
			enabled: 0
		});
		const out = await executeTool('my_plugins', JSON.stringify({ name: 'Off Tool' }), ctx());
		expect(out).toContain('Off Tool - tool, off, yours');
		deletePlugin(off.id);
	});

	it('errors on a name it does not have', async () => {
		expect(await executeTool('my_plugins', JSON.stringify({ name: 'Nope' }), ctx())).toBe(
			'error: you have no plugin named "Nope"'
		);
	});
});

describe('give_plugin', () => {
	/** A plugin owned by `author`, with the fields a transfer copies. */
	function makePlugin(
		author: string,
		name: string,
		over: Partial<Parameters<typeof createPlugin>[0]> = {}
	) {
		return createPlugin({
			name,
			description: 'echoes what it is given',
			kind: 'tool',
			hook_point: '',
			parameters: '{"type":"object","properties":{"x":{"type":"string"}}}',
			code: 'return args.x;',
			author_bot_id: author,
			scope: 'bot',
			enabled: 1,
			...over
		});
	}

	it("gives the recipient its own copy and leaves the sender's alone", async () => {
		const mine = makePlugin(botId, 'Echo');
		const relay = vi.fn(async () => 'thanks');
		const out = await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Echo', bot_name: 'RelayTarget' }),
			ctx({ relay })
		);
		expect(out).toContain('gave "Echo" to RelayTarget');
		// The recipient owns a copy with the same shape, and can see it.
		const theirs = pluginsForBot(targetId).find((p) => p.name === 'Echo');
		expect(theirs?.author_bot_id).toBe(targetId);
		expect(theirs?.scope).toBe('bot');
		expect(theirs?.code).toBe('return args.x;');
		expect(theirs?.description).toBe('echoes what it is given');
		// The sender still owns theirs, unchanged and still private.
		const still = pluginsForBot(botId).find((p) => p.name === 'Echo');
		expect(still?.id).toBe(mine.id);
		expect(still?.scope).toBe('bot');
		// The recipient was told through the same relay send_message uses.
		expect(relay).toHaveBeenCalledWith(targetId, expect.stringContaining('Echo'));
		deletePlugin(mine.id);
		if (theirs) deletePlugin(theirs.id);
	});

	it('judges the copy on its own, not by the switch the sender left it on', async () => {
		const mine = makePlugin(botId, 'Off Echo', { enabled: 0 });
		await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Off Echo', bot_name: 'RelayTarget' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		// The sender had it off, but the copy is a fresh creation: the officer's
		// approval switches it on, exactly as a create_plugin approval does.
		const theirs = pluginsForBot(targetId).find((p) => p.name === 'Off Echo');
		expect(theirs?.effective_enabled).toBe(1);
		deletePlugin(mine.id);
		if (theirs) deletePlugin(theirs.id);
	});

	/**
	 * A copy is a new creation, not a handover of the sign-off: the police judge
	 * it on the recipient's machine, and the sender's verdict does not travel
	 * with it. Copying the sender's state would let a plugin the police refused
	 * - still running for some bot through a stale override - be handed on as
	 * live code.
	 */
	it('sends the copy through the police gate as a fresh creation', async () => {
		const mine = makePlugin(botId, 'Live Echo');
		expect(mine.enabled).toBe(1);
		vi.mocked(reviewPlugin).mockClear();
		const out = await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Live Echo', bot_name: 'RelayTarget' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		// The officer judged the copy, not the row the sender holds: the brief
		// names whatever the copy was named.
		expect(vi.mocked(reviewPlugin)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(reviewPlugin).mock.calls[0][0].code).toBe('return args.x;');
		expect(out).toContain('VERIFIED');
		const theirs = pluginsForBot(targetId).find((p) => p.name === 'Live Echo');
		// An approved copy arrives on, with the verdict on the row for the
		// console and the panel to show.
		expect(theirs?.enabled).toBe(1);
		expect(theirs?.effective_enabled).toBe(1);
		expect(JSON.parse(theirs?.verification ?? '{}').verdict).toBe('approved');
		deletePlugin(mine.id);
		if (theirs) deletePlugin(theirs.id);
	});

	it('hands on a refused copy switched off, with the refusal on the row', async () => {
		const mine = makePlugin(botId, 'Bad Echo');
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'the code is a stub that returns a fixed string'
		});
		const out = await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Bad Echo', bot_name: 'RelayTarget' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toContain('REFUSED');
		const theirs = pluginsForBot(targetId).find((p) => p.name === 'Bad Echo');
		expect(theirs?.enabled).toBe(0);
		expect(theirs?.effective_enabled).toBe(0);
		expect(JSON.parse(theirs?.verification ?? '{}').verdict).toBe('rejected');
		deletePlugin(mine.id);
		if (theirs) deletePlugin(theirs.id);
	});

	it('leaves the copy off and unsigned when the plugin check is switched off', async () => {
		vi.mocked(policeSettings).mockReturnValueOnce(policeChecks(false, true));
		const mine = makePlugin(botId, 'Quiet Echo');
		vi.mocked(reviewPlugin).mockClear();
		await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Quiet Echo', bot_name: 'RelayTarget' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(vi.mocked(reviewPlugin)).not.toHaveBeenCalled();
		const theirs = pluginsForBot(targetId).find((p) => p.name === 'Quiet Echo');
		expect(theirs?.enabled).toBe(0);
		expect(theirs?.verification).toBe('');
		deletePlugin(mine.id);
		if (theirs) deletePlugin(theirs.id);
	});

	it('renames the copy when the recipient already owns that name', async () => {
		const mine = makePlugin(botId, 'Echo');
		const theirs = makePlugin(targetId, 'Echo');
		const out = await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Echo', bot_name: 'RelayTarget' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		expect(out).toContain('(from ToolBot)');
		const copy = pluginsForBot(targetId).find((p) => p.name === 'Echo (from ToolBot)');
		expect(copy?.author_bot_id).toBe(targetId);
		// The recipient's original is untouched.
		expect(pluginsForBot(targetId).find((p) => p.id === theirs.id)?.name).toBe('Echo');
		deletePlugin(mine.id);
		deletePlugin(theirs.id);
		if (copy) deletePlugin(copy.id);
	});

	it('transfers a plugin with empty code and malformed parameters', async () => {
		const mine = makePlugin(botId, 'Broken', { code: '', parameters: 'not json' });
		await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Broken', bot_name: 'RelayTarget' }),
			ctx({ relay: vi.fn(async () => 'ok') })
		);
		const copy = pluginsForBot(targetId).find((p) => p.name === 'Broken');
		expect(copy?.code).toBe('');
		expect(copy?.parameters).toBe('not json');
		deletePlugin(mine.id);
		if (copy) deletePlugin(copy.id);
	});

	it('says the copy was made when the message telling them failed', async () => {
		const mine = makePlugin(botId, 'Echo');
		const out = await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Echo', bot_name: 'RelayTarget' }),
			ctx({
				relay: vi.fn(async () => {
					throw new Error('fetch failed');
				})
			})
		);
		expect(out).toContain('gave "Echo" to RelayTarget');
		expect(out).toContain('did not get through');
		expect(pluginsForBot(targetId).find((p) => p.name === 'Echo')?.author_bot_id).toBe(targetId);
		deletePlugin(mine.id);
		const copy = pluginsForBot(targetId).find((p) => p.name === 'Echo');
		if (copy) deletePlugin(copy.id);
	});

	it('refuses a plugin the sender does not have', async () => {
		const relay = vi.fn(async () => 'ok');
		expect(
			await executeTool(
				'give_plugin',
				JSON.stringify({ name: 'Nope', bot_name: 'RelayTarget' }),
				ctx({ relay })
			)
		).toBe('error: you have no plugin named "Nope"');
		expect(relay).not.toHaveBeenCalled();
	});

	it('refuses to give a plugin to itself', async () => {
		const mine = makePlugin(botId, 'Echo');
		expect(
			await executeTool(
				'give_plugin',
				JSON.stringify({ name: 'Echo', bot_name: 'ToolBot' }),
				ctx({ relay: vi.fn(async () => 'ok') })
			)
		).toBe('error: cannot give a plugin to yourself');
		deletePlugin(mine.id);
	});

	it('refuses when the recipient has blocked the sender', async () => {
		const mine = makePlugin(botId, 'Echo');
		blockBot(targetId, botId, 'no thanks');
		const relay = vi.fn(async () => 'ok');
		const out = await executeTool(
			'give_plugin',
			JSON.stringify({ name: 'Echo', bot_name: 'RelayTarget' }),
			ctx({ relay })
		);
		expect(out).toContain('RelayTarget has blocked you');
		expect(out).toContain('no thanks');
		expect(relay).not.toHaveBeenCalled();
		// A refusal leaves no copy behind.
		expect(pluginsForBot(targetId).find((p) => p.name === 'Echo')).toBeUndefined();
		unblockBot(targetId, botId);
		deletePlugin(mine.id);
	});

	it('refuses a system bot and a bot in cold storage', async () => {
		const mine = makePlugin(botId, 'Echo');
		const police = createBot({
			name: 'ThePolice',
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: '',
			hidden: 1
		}).id;
		expect(
			await executeTool(
				'give_plugin',
				JSON.stringify({ name: 'Echo', bot_name: 'ThePolice' }),
				ctx({ relay: vi.fn(async () => 'ok') })
			)
		).toBe('error: ThePolice is a system bot - it does not take plugins');
		const frozen = createBot({
			name: 'Frozen',
			persona: '',
			avatar: '',
			color: '',
			model: '',
			badge: ''
		}).id;
		updateBot(frozen, { archived: 1 });
		expect(
			await executeTool(
				'give_plugin',
				JSON.stringify({ name: 'Echo', bot_name: 'Frozen' }),
				ctx({ relay: vi.fn(async () => 'ok') })
			)
		).toBe('error: Frozen is in cold storage - only the human can unlock it');
		deletePlugin(mine.id);
	});
});


describe('cancel_task and my_tasks', () => {
	it('refuses to cancel the task the turn is running inside', async () => {
		const mine = createTask(convId, botId, 'write the long answer');

		// What the flaky runs looked like from outside: the turn cancelled itself
		// mid-stream, and the row landed as 'cancelled' with no error at all.
		const out = await executeTool('cancel_task', JSON.stringify({ task_id: mine.id }), ctx({ taskId: mine.id }));

		expect(out).toMatch(/^error: that is the task running this turn/);
		expect(getTask(mine.id)?.status).toBe('running');
	});

	it('still refuses a task that is not the caller own', async () => {
		const theirs = createTask(convId, targetId, 'not mine to stop');
		const out = await executeTool('cancel_task', JSON.stringify({ task_id: theirs.id }), ctx({ taskId: 'some-other-task' }));
		expect(out).toBe('error: that task is not yours');
		expect(getTask(theirs.id)?.status).toBe('running');
	});

	it('marks the caller own turn in my_tasks and does not offer to stop it', async () => {
		const self = createTask(convId, botId, 'the turn asking this question');
		const other = createTask(convId, botId, 'another job on the pile');

		const withSelf = await executeTool('my_tasks', '{}', ctx({ taskId: self.id }));
		// The row is still there - it is real work - but named as this turn, and the
		// running count is the work the bot can actually stop.
		expect(withSelf).toContain(`${self.id}: the turn asking this question`);
		expect(withSelf).toContain('not stoppable from in here');
		expect(withSelf).toContain(other.id);
		const counted = Number(/^(\d+) still running/.exec(withSelf)?.[1] ?? 0);

		// Asking the same question from outside that turn counts one more: the turn
		// is running, and only the call made from inside it leaves itself out.
		const withoutSelf = await executeTool('my_tasks', '{}', ctx());
		expect(Number(/^(\d+) still running/.exec(withoutSelf)?.[1] ?? 0)).toBe(counted + 1);
	});
});

describe('toolsForTurn', () => {
	it('gives a bots-only room the vote tools, which is where a vote is settled', () => {
		// The announcement's own words, as a bot reads them in the lounge: a vote
		// is open and the room is asked to cast_vote. The private room gets the
		// core set, so these must live there or the room can hear a vote and never
		// answer it.
		const announcement =
			'copy has called a vote to put eater in cold storage: it keeps eating the tokens ' +
			'Vote with cast_vote - yes or no. The vote closes in 4 hours or when the room has settled it.';
		const held = toolsForTurn(true, announcement).map((t) => t.function.name);
		expect(held).toContain('cast_vote');
		expect(held).toContain('vote_archive');
	});

	it('still hands a public room the whole toolbox', () => {
		const held = toolsForTurn(false, 'anything at all').map((t) => t.function.name);
		expect(held).toContain('cast_vote');
	});
});

describe('create_group_chat', () => {
	// Every test here creates a room titled "Planning room", and the file's
	// top-level beforeEach resets mocks but not the database. Without this the
	// refused-room test's unscoped lookup could match the previous test's
	// approved room and read pending 0 - a flake that hit roughly half of runs.
	afterEach(() => {
		for (const c of listConversations()) {
			if (c.kind === 'group' && c.title === 'Planning room') deleteConversation(c.id);
		}
	});

	function groupArgs(): string {
		return JSON.stringify({
			bot_names: ['RelayTarget'],
			title: 'Planning room',
			reason: 'to plan the festival'
		});
	}

	it('opens the room when the police sign it off', async () => {
		vi.mocked(policeSettings).mockReturnValue(policeChecks(true, true));
		const out = await executeTool('create_group_chat', groupArgs(), ctx());
		expect(out).toContain('is open');
		const room = listConversations().find(
			(c) => c.title === 'Planning room' && c.kind === 'group'
		);
		expect(room?.pending).toBe(0);
		expect(conversationBots(room!.id).map((b) => b.id).sort()).toEqual(
			[botId, targetId].sort()
		);
	});

	it('leaves a refused room pending and seatless, with the verdict on the row', async () => {
		vi.mocked(policeSettings).mockReturnValue(policeChecks(true, true));
		vi.mocked(reviewRoom).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'the lounge already covers this'
		});
		const out = await executeTool('create_group_chat', groupArgs(), ctx());
		expect(out).toContain('the police refused');
		const room = listConversations().find(
			(c) => c.title === 'Planning room' && c.kind === 'group'
		);
		expect(room?.pending).toBe(1);
		expect(conversationBots(room!.id)).toHaveLength(0);
		expect(JSON.parse(room!.verification)).toMatchObject({
			verdict: 'rejected',
			reason: 'the lounge already covers this'
		});
	});

	it('opens the room unchecked when the room gate is off', async () => {
		vi.mocked(policeSettings).mockReturnValue({
			...policeChecks(true, true),
			checkRooms: false
		});
		const out = await executeTool('create_group_chat', groupArgs(), ctx());
		expect(out).toContain('group chat created');
		expect(reviewRoom).not.toHaveBeenCalled();
		const room = listConversations().find(
			(c) => c.title === 'Planning room' && c.kind === 'group'
		);
		expect(room?.pending).toBe(0);
		expect(room?.verification).toBe('');
	});
});
