import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResult, ToolCall } from './llm';
import { streamChat } from './llm';
import {
	createBot,
	createConversation,
	db,
	getSiteNote,
	listSiteObservations,
	type Bot
} from './db';
import { machineExec, navigateBrowser } from './machine';
import { executeTool, type ToolContext } from './tools';
import { runBrowserTask } from './browser-agent';
import { documenterFor, noteDomainVisit, NOTE_STALE_MS } from './site-docs';

// The model is faked: streamChat stands in for both loops, and which loop a
// call belongs to is told apart by the tools it was offered - the documenter
// is the only caller that gets save_note.
vi.mock('./llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

// The machine is faked: navigateBrowser returns a fixed page, machineExec a
// fixed fetch body. normalizeSite is the real one - the domain keying under
// test is exactly what it computes.
vi.mock('./machine', async (importOriginal) => {
	const real = await importOriginal<typeof import('./machine')>();
	return {
		machineExec: vi.fn(async () => '<html><body>Welcome to the site</body></html>'),
		shellExec: vi.fn(async () => 'shell output'),
		machineScreenshot: vi.fn(async () => 'base64png'),
		desktopInput: vi.fn(async () => {}),
		captureShot: vi.fn(async () => 'shot.png'),
		navigateBrowser: vi.fn(async () => 'Title: Page\n\npage text'),
		browseAction: vi.fn(async () => ({ text: 'Title: Page\n\npage text', url: '' })),
		setupDesktop: vi.fn(async () => 'desktop set up'),
		ensureMachine: vi.fn(async () => 'obl-machine-x'),
		sleepMachine: vi.fn(async () => 'running'),
		machineStatus: vi.fn(async () => ({ state: 'running' })),
		machineTier: vi.fn(() => 'full'),
		normalizeSite: real.normalizeSite,
		readPointer: vi.fn(async () => ({ x: 0, y: 0, w: 1280, h: 1024 })),
		clampRegion: vi.fn(),
		exportCookies: vi.fn(async () => []),
		importCookies: vi.fn(async () => 0),
		IDLE_MINUTES: 9
	};
});

// The police module is imported through tools.ts; a factory mock keeps the
// runner graph out of the load order, same as tools.test.ts.
vi.mock('./police', () => ({
	policeModel: vi.fn(() => 'police-model'),
	// The documenter's spend is billed to the system account; a stand-in id is
	// enough - addBotTokens just updates a row that need not exist here.
	ensurePoliceBot: vi.fn(() => ({ id: 'police-bot' }))
}));

vi.mock('./plugins', async (importOriginal) => ({
	...(await importOriginal<typeof import('./plugins')>()),
	runPluginTests: vi.fn(async () => [])
}));

/** A streamChat stand-in that never answers - a documenter still mid-step. */
function pendingStream(): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		await new Promise<never>(() => {});
		// Unreachable; the return type is what the signature needs.
		return { text: '', toolCalls: [] };
	})();
}

/** A streamChat stand-in: yields each delta, then returns the result. */
function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** The documenter's canned behaviour: save a draft, then finish with the note. */
function docStream(domain: string): AsyncGenerator<string, StreamResult>[] {
	return [
		fakeStream([], {
			text: '',
			toolCalls: [toolCall('d1', 'save_note', { note: `draft: ${domain} is a shop` })]
		}),
		fakeStream([], {
			text: `# ${domain}\nA shop. Login at /login; the cart is JS-heavy.`,
			toolCalls: []
		})
	];
}

/** Route streamChat calls: documenter calls carry save_note, actor calls don't. */
function mockDocThenActor(
	docSteps: AsyncGenerator<string, StreamResult>[],
	actorSteps: AsyncGenerator<string, StreamResult>[]
): void {
	vi.mocked(streamChat).mockImplementation((opts) => {
		const isDoc = (opts.tools ?? []).some(
			(t: { function: { name: string } }) => t.function.name === 'save_note'
		);
		const queue = isDoc ? docSteps : actorSteps;
		const next = queue.shift();
		return next ?? fakeStream([], { text: 'done', toolCalls: [] });
	});
}

let bot: Bot;
let convId = '';

beforeAll(() => {
	bot = createBot({ name: 'DocBot', persona: '', avatar: '', color: '', model: '', badge: '' });
	convId = createConversation([bot.id], 'direct').id;
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		senderBotId: bot.id,
		senderBotName: bot.name,
		conversationId: convId,
		depth: 0,
		model: 'm1',
		...overrides
	};
}

/** A domain name unique per test, so the shared DB never carries state over. */
let n = 0;
function freshDomain(): string {
	return `site-${++n}.test`;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(streamChat).mockReset();
	vi.mocked(navigateBrowser).mockResolvedValue('Title: Page\n\npage text');
	vi.mocked(machineExec).mockResolvedValue('<html><body>Welcome</body></html>');
});

describe('noteDomainVisit', () => {
	it('spawns a documenter on a new domain and writes a note keyed by it', async () => {
		const domain = freshDomain();
		mockDocThenActor(docStream(domain), []);

		const visit = noteDomainVisit({ botId: bot.id, botName: bot.name, domain, model: 'm1' });
		expect(visit.spawned).toBe(true);

		await vi.waitFor(() => {
			expect(getSiteNote(domain)?.status).toBe('ready');
		});
		const note = getSiteNote(domain)!;
		expect(note.domain).toBe(domain);
		expect(note.note).toContain(domain);
		expect(note.bot_id).toBe(bot.id);
	});

	it('does not respawn for a domain with a fresh note', async () => {
		const domain = freshDomain();
		mockDocThenActor(docStream(domain), []);
		noteDomainVisit({ botId: bot.id, botName: bot.name, domain });
		await vi.waitFor(() => expect(getSiteNote(domain)?.status).toBe('ready'));

		const calls = vi.mocked(streamChat).mock.calls.length;
		const second = noteDomainVisit({ botId: bot.id, botName: bot.name, domain });
		expect(second.spawned).toBe(false);
		expect(second.note?.note).toContain(domain);
		expect(vi.mocked(streamChat).mock.calls.length).toBe(calls);
	});

	it('runs only one documenter per domain at a time', async () => {
		const domain = freshDomain();
		// The documenter never finishes within the test: a stream that pends.
		vi.mocked(streamChat).mockImplementation(() => pendingStream());

		const first = noteDomainVisit({ botId: bot.id, botName: bot.name, domain });
		const second = noteDomainVisit({
			botId: bot.id,
			botName: bot.name,
			domain,
			conversationId: convId
		});
		expect(first.spawned).toBe(true);
		expect(second.spawned).toBe(false);
		expect(vi.mocked(streamChat).mock.calls.length).toBe(1);
	});

	it('re-documents a domain whose note is stale', async () => {
		const domain = freshDomain();
		mockDocThenActor(docStream(domain), []);
		noteDomainVisit({ botId: bot.id, botName: bot.name, domain });
		await vi.waitFor(() => expect(getSiteNote(domain)?.status).toBe('ready'));

		// Age the note past the staleness window.
		db.prepare('UPDATE site_notes SET updated_at = ? WHERE domain = ?').run(
			Date.now() - NOTE_STALE_MS - 1000,
			domain
		);
		mockDocThenActor(docStream(domain), []);
		const visit = noteDomainVisit({ botId: bot.id, botName: bot.name, domain });
		expect(visit.spawned).toBe(true);
		await vi.waitFor(() => expect(getSiteNote(domain)?.status).toBe('ready'));
	});
});

describe('browser_navigate hook', () => {
	it('spawns the documenter and says so in the result', async () => {
		const domain = freshDomain();
		mockDocThenActor(docStream(domain), []);

		const out = await executeTool(
			'browser_navigate',
			JSON.stringify({ url: `https://${domain}/home` }),
			ctx()
		);
		expect(out).toContain(`opened https://${domain}/home`);
		expect(out).toContain('documenter is mapping');

		await vi.waitFor(() => expect(getSiteNote(domain)?.status).toBe('ready'));
	});

	it('serves the note with the page on the next visit', async () => {
		const domain = freshDomain();
		mockDocThenActor(docStream(domain), []);
		await executeTool('browser_navigate', JSON.stringify({ url: `https://${domain}/` }), ctx());
		await vi.waitFor(() => expect(getSiteNote(domain)?.status).toBe('ready'));

		const out = await executeTool(
			'browser_navigate',
			JSON.stringify({ url: `https://${domain}/other` }),
			ctx()
		);
		expect(out).toContain(`[site note for ${domain}]`);
		expect(out).toContain('the cart is JS-heavy');
	});

	it('serves the in-progress draft while the documenter is still writing', async () => {
		const domain = freshDomain();
		// The documenter saves a draft, then pends forever on its next step.
		let saved = false;
		vi.mocked(streamChat).mockImplementation((opts) => {
			const isDoc = (opts.tools ?? []).some(
				(t: { function: { name: string } }) => t.function.name === 'save_note'
			);
			if (isDoc && !saved) {
				saved = true;
				return fakeStream([], {
					text: '',
					toolCalls: [toolCall('d1', 'save_note', { note: 'draft: login link is top right' })]
				});
			}
			return pendingStream();
		});

		await executeTool('browser_navigate', JSON.stringify({ url: `https://${domain}/` }), ctx());
		await vi.waitFor(() => expect(getSiteNote(domain)?.note).toContain('draft'));

		const out = await executeTool(
			'browser_navigate',
			JSON.stringify({ url: `https://${domain}/page2` }),
			ctx()
		);
		expect(out).toContain('still being written');
		expect(out).toContain('login link is top right');
	});
});

describe('actor observations', () => {
	it('tags the actor\'s tool calls to the domain for the documenter', async () => {
		const domain = freshDomain();
		// A ready note already exists, so no documenter spawns and every
		// streamChat call belongs to the actor's own loop.
		db.prepare(
			`INSERT INTO site_notes (domain, status, note, bot_id, created_at, updated_at)
			 VALUES (?, 'ready', 'existing note', ?, ?, ?)`
		).run(domain, bot.id, Date.now(), Date.now());
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('n1', 'browser_navigate', { url: `https://${domain}/` })]
				})
			)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('l1', 'screen_look', {})]
				})
			)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('c1', 'mouse_click', { x: 10, y: 20 })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'clicked it', toolCalls: [] }));

		const report = await runBrowserTask({
			botId: bot.id,
			botName: bot.name,
			goal: 'click the button',
			model: 'm1'
		});
		expect(report).toBe('clicked it');

		const obs = listSiteObservations(domain);
		expect(obs.map((o) => o.action.split(' ')[0])).toEqual([
			'browser_navigate',
			'screen_look',
			'mouse_click'
		]);
		expect(obs[0].outcome).toContain(`opened https://${domain}/`);
		expect(obs[2].outcome).toContain('clicked');
	});

	it('lets the documenter read the actor\'s trail', async () => {
		const domain = freshDomain();
		// Seed the trail the way a prior visit would have left it.
		db.prepare(
			`INSERT INTO site_observations (id, domain, bot_id, action, outcome, created_at)
			 VALUES ('o1', ?, ?, 'mouse_click {"x":5}', 'clicked at (5, 20)', ?)`
		).run(domain, bot.id, Date.now());

		let sawTrail = '';
		vi.mocked(streamChat).mockImplementation((opts) => {
			const isDoc = (opts.tools ?? []).some(
				(t: { function: { name: string } }) => t.function.name === 'save_note'
			);
			if (!isDoc) return fakeStream([], { text: 'done', toolCalls: [] });
			const last = opts.messages[opts.messages.length - 1];
			if (last.role === 'tool') {
				sawTrail = typeof last.content === 'string' ? last.content : '';
			}
			return fakeStream([], {
				text: '',
				toolCalls: [toolCall('d1', 'read_observations', {})]
			});
		});

		noteDomainVisit({ botId: bot.id, botName: bot.name, domain });
		await vi.waitFor(() => expect(sawTrail).toContain('mouse_click'));
		expect(sawTrail).toContain('clicked at (5, 20)');
	});
});
