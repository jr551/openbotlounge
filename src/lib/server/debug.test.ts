import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResult } from './llm';
import { streamChat } from './llm';
import {
	addMessage,
	createBot,
	createConversation,
	db,
	getBot,
	listActivities,
	setDebugAccess,
	setSetting,
	updateConversation,
	type Bot,
	type Conversation
} from './db';
import { askForDebugAccess, debugToolsFor, executeDebugTool } from './debug';
import { createSecret } from './secrets';
import { executeTool } from './tools';
import { runBotTurn } from './runner';
import { POST } from '../../routes/api/bots/[id]/debug/+server';

vi.mock('./llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));
// The turn reads the bot's personality file through a throwaway container;
// the tests have no docker, so the drive reads as empty.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	// The turn reads the bot's personality file through a throwaway container;
	// the tests have no docker, so the drive reads as empty.
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 })),
	// debug_info lists containers for its machine report; answer with none
	// instead of letting the call sit on the real socket until its deadline.
	dockerRequest: vi.fn(async () => ({ status: 200, body: Buffer.from('[]') }))
}));


function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

let seq = 0;
function makeBot(name: string): Bot {
	return createBot({
		name: `${name}${++seq}`,
		persona: 'test persona',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

/** The human's verdict, through the route the thread's card calls. */
function verdict(botId: string, body: Record<string, unknown>) {
	const request = new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return POST({ params: { id: botId }, request } as Parameters<typeof POST>[0]);
}

function toolsFor(botId: string): string[] {
	return debugToolsFor(botId).map((t) => t.function.name);
}

/** The tool names the runner actually put on the wire for one turn. */
async function wireTools(bot: Bot, conv: Conversation): Promise<string[]> {
	vi.mocked(streamChat).mockImplementation(() =>
		fakeStream(['ok'], { text: 'ok', toolCalls: [] })
	);
	await runBotTurn(conv, bot);
	const call = vi.mocked(streamChat).mock.calls.at(-1)?.[0];
	return (call?.tools ?? []).map((t) => t.function.name);
}

describe('debug access is asked for, never taken', () => {
	let bot: Bot;
	let conv: Conversation;

	beforeEach(() => {
		vi.mocked(streamChat).mockReset();
		bot = makeBot('Asker');
		conv = createConversation([bot.id], 'direct');
	});

	it('turns a request into a card for the human and grants nothing', async () => {
		const out = await executeTool(
			'request_debug_access',
			JSON.stringify({ reason: 'the scheduler is double-firing' }),
			{ senderBotId: bot.id, senderBotName: bot.name, conversationId: conv.id, depth: 0 }
		);
		expect(out).toContain('Approve');

		const after = getBot(bot.id)!;
		expect(JSON.parse(after.debug_request).reason).toBe('the scheduler is double-firing');
		// The whole point: asking is all a bot can do.
		expect(after.debug_grant).toBe('');
		expect(toolsFor(bot.id)).toEqual([]);
	});

	it('refuses to grant anything to a bot that names the tools anyway', async () => {
		await askForDebugAccess(bot.id, 'let me look');
		const ctx = { senderBotId: bot.id, senderBotName: bot.name, conversationId: conv.id, depth: 0 };

		for (const name of [
			'debug_settings',
			'debug_info',
			'debug_activity',
			'debug_tasks',
			'debug_chat'
		]) {
			const out = await executeTool(name, '{}', ctx);
			expect(out).toContain('debug access is not granted');
		}
		expect(getBot(bot.id)!.debug_grant).toBe('');
		expect(getBot(bot.id)!.debug_request).not.toBe('');
	});

	it('cannot be approved by a tool call: a grant only comes from the human route', async () => {
		await askForDebugAccess(bot.id, 'please');
		// No tool a bot can reach writes a grant, so the only writer is the route.
		await executeTool('debug_settings', JSON.stringify({ action: 'write', key: 'debug_grant', value: '{}' }), {
			senderBotId: bot.id,
			senderBotName: bot.name,
			conversationId: conv.id,
			depth: 0
		});
		expect(getBot(bot.id)!.debug_grant).toBe('');
		expect(toolsFor(bot.id)).toEqual([]);
	});

	it('a declined request grants nothing', async () => {
		await askForDebugAccess(bot.id, 'why not');
		const res = await verdict(bot.id, { approve: false });
		expect(res.status).toBe(200);

		const after = getBot(bot.id)!;
		expect(after.debug_request).toBe('');
		expect(after.debug_grant).toBe('');
		expect(toolsFor(bot.id)).toEqual([]);
	});

	it('approving with nothing pending is refused rather than handing out access', async () => {
		let thrown: { status?: number } = {};
		try {
			await verdict(bot.id, { approve: true });
		} catch (e) {
			thrown = e as { status?: number };
		}
		expect(thrown.status).toBe(409);
		expect(getBot(bot.id)!.debug_grant).toBe('');
	});

	it('an approved request yields the toolset, and revoking removes it', async () => {
		await askForDebugAccess(bot.id, 'checking the queue');
		await verdict(bot.id, { approve: true });

		expect(toolsFor(bot.id)).toContain('debug_chat');
		expect(toolsFor(bot.id)).toContain('debug_settings');
		expect(getBot(bot.id)!.debug_request).toBe('');

		await verdict(bot.id, { revoke: true });
		expect(toolsFor(bot.id)).toEqual([]);
		expect(getBot(bot.id)!.debug_grant).toBe('');
	});

	it('an expired grant yields no tools even though the row is still there', async () => {
		const at = Date.now();
		setDebugAccess(bot.id, {
			grant: JSON.stringify({ reason: 'old', granted_at: at - 60_000, expires_at: at - 1 })
		});
		expect(getBot(bot.id)!.debug_grant).not.toBe('');
		expect(toolsFor(bot.id)).toEqual([]);

		const out = await executeDebugTool('debug_info', '{}', bot.id);
		expect(out).toContain('debug access is not granted');
	});

	it('the tool list on the wire carries the debug tools only while granted', async () => {
		const plain = await wireTools(bot, conv);
		expect(plain).toContain('request_debug_access');
		expect(plain.some((t) => t.startsWith('debug_'))).toBe(false);

		await askForDebugAccess(bot.id, 'the task tray is lying');
		await verdict(bot.id, { approve: true });

		const granted = await wireTools(bot, conv);
		expect(granted).toContain('debug_settings');
		expect(granted).toContain('debug_chat');
		expect(granted).toContain('debug_info');

		// A minute past the grant, the next turn's list is back to the normal one.
		setDebugAccess(bot.id, {
			grant: JSON.stringify({ reason: 'x', granted_at: Date.now(), expires_at: Date.now() - 1 })
		});
		const lapsed = await wireTools(bot, conv);
		expect(lapsed.some((t) => t.startsWith('debug_'))).toBe(false);
	});
});

describe('a granted debug call reads real admin data', () => {
	let peeper: Bot;
	let other: Bot;
	let conv: Conversation;

	beforeEach(async () => {
		peeper = makeBot('Peeper');
		other = makeBot('Other');
		conv = createConversation([other.id], 'direct');
		updateConversation(conv.id, { title: "Marlow's room" });
		addMessage(conv.id, 'user', 'hello from the room Peeper is not in');
		addMessage(conv.id, 'assistant', 'the answer only other knows', other.id, '', 0, '');
		await askForDebugAccess(peeper.id, 'audit');
		await verdict(peeper.id, { approve: true, minutes: 15 });
	});

	it('reads every conversation, including rooms the bot is not a member of', async () => {
		const rooms = await executeDebugTool('debug_chat', '{}', peeper.id);
		expect(rooms).toContain(conv.id);

		const read = await executeDebugTool(
			'debug_chat',
			JSON.stringify({ conversation: conv.id }),
			peeper.id
		);
		expect(read).toContain('hello from the room Peeper is not in');
		expect(read).toContain(other.name);

		const found = await executeDebugTool(
			'debug_chat',
			JSON.stringify({ search: 'only other knows' }),
			peeper.id
		);
		expect(found).toContain(other.name);
		expect(found).toContain('the answer only other knows');

		// The audit rows name the room as the human knows it, not by its id.
		const details = listActivities(peeper.id, 3).map((a) => a.detail);
		expect(details).toContain('Read the chat "Marlow\'s room"');
		expect(details).toContain('Searched every chat for "only other knows"');
		expect(details.join(' ')).not.toContain(conv.id);
	});

	it('reads the settings and the system state', async () => {
		const settings = await executeDebugTool('debug_settings', '{}', peeper.id);
		expect(settings).toContain('social');
		expect(settings).toContain('default_model');

		const info = await executeDebugTool('debug_info', '{}', peeper.id);
		expect(info).toContain('Integrity: ok');
		expect(info).toContain('Machines');
		expect(info).toContain('Scheduler:');
		expect(info).toContain('Bots:');
	});

	it('writes a setting and says so in the audit trail', async () => {
		await executeDebugTool(
			'debug_settings',
			JSON.stringify({ action: 'write', key: 'social_interval_min', value: '45' }),
			peeper.id
		);
		// rowid breaks ties: the approval and the write can share a millisecond.
		const row = db
			.prepare(
				"SELECT detail FROM activities WHERE bot_id = ? AND kind = 'debug' ORDER BY created_at DESC, rowid DESC LIMIT 1"
			)
			.get(peeper.id) as { detail: string };
		expect(row.detail).toBe('Changed setting "social_interval_min" to "45"');
	});

	it('logs what every debug call read, so the human can audit the access', async () => {
		await executeDebugTool('debug_tasks', JSON.stringify({ bot: other.name }), peeper.id);
		const newest = listActivities(peeper.id, 1)[0];
		expect(newest.kind).toBe('debug');
		expect(newest.detail).toContain(other.name);

		// The grant itself and the ask are in the same log, in the human's words.
		const all = listActivities(peeper.id, 20).map((a) => a.detail);
		expect(all).toContain('Debug access granted for 15 minutes');
		expect(all).toContain('Requested debug access: audit');
	});
});

describe('debug access never exposes a secret value', () => {
	let peeper: Bot;
	let keeper: Bot;
	let conv: Conversation;

	beforeEach(async () => {
		peeper = makeBot('Peeper');
		keeper = makeBot('Keeper');
		conv = createConversation([keeper.id], 'direct');
		createSecret(keeper.id, 'stripe_key', 'sk-live-SUPERSECRET-123456');
		await askForDebugAccess(peeper.id, 'audit');
		await verdict(peeper.id, { approve: true });
	});

	it('lists secret names and metadata, never the value', async () => {
		const out = await executeDebugTool('debug_info', JSON.stringify({ section: 'secrets' }), peeper.id);
		expect(out).toContain('stripe_key');
		expect(out).toContain(keeper.name);
		expect(out).not.toContain('sk-live-SUPERSECRET-123456');
	});

	it('redacts a credential in the settings, and withholds it from the audit row', async () => {
		// The provider's key is a stored setting; the dump names it and withholds
		// the value, the same rule every credential key gets.
		setSetting('provider_api_key', 'sk-provider-SECRET-999');
		const out = await executeDebugTool('debug_settings', '{}', peeper.id);
		expect(out).toContain('provider_api_key = [redacted]');
		expect(out).not.toContain('sk-provider-SECRET-999');

		const written = await executeDebugTool(
			'debug_settings',
			JSON.stringify({ action: 'write', key: 'api_key', value: 'sk-written-SECRET-777' }),
			peeper.id
		);
		expect(written).toContain('[value withheld]');
		expect(written).not.toContain('sk-written-SECRET-777');
		expect(listActivities(peeper.id, 1)[0].detail).not.toContain('sk-written-SECRET-777');
	});

	it('masks another bot’s secret that leaked into a transcript', async () => {
		// A value that reached a message some other way still never leaves here.
		addMessage(conv.id, 'assistant', 'my key is sk-live-SUPERSECRET-123456 ok', keeper.id, '', 0, '');
		const out = await executeDebugTool(
			'debug_chat',
			JSON.stringify({ conversation: conv.id }),
			peeper.id
		);
		expect(out).toContain('[secret:stripe_key]');
		expect(out).not.toContain('sk-live-SUPERSECRET-123456');
	});

	it('reads nothing at all without a grant, even with a room full of data', async () => {
		const outsider = makeBot('Outsider');
		const out = await executeDebugTool('debug_chat', JSON.stringify({ conversation: conv.id }), outsider.id);
		expect(out).toContain('debug access is not granted');
		expect(out).not.toContain('stripe_key');
	});
});
