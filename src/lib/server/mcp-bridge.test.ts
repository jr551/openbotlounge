import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createBot, createConversation, db, deleteBot, deleteConversation, getTask, type Bot, type Conversation } from './db';

/**
 * The bridge is spawned by an external MCP client (see `.omp/mcp.json`), not by
 * the SvelteKit server, so the only honest test is to drive it the way that
 * client does: a real child process over stdio. It must load the app's
 * TypeScript modules under plain `node` — the resolve hook at the top of
 * `mcp-bridge.mjs` exists for exactly that, and without it every tool call
 * failed with "could not load db.ts".
 */

interface Rpc {
	jsonrpc: '2.0';
	id?: number;
	method?: string;
	params?: unknown;
	result?: { tools?: { name: string }[]; content?: { text: string }[] };
	error?: { code: number; message: string };
}

function driveBridge(requests: Rpc[]): Promise<Map<number, Rpc>> {
	const { promise, resolve, reject } = Promise.withResolvers<Map<number, Rpc>>();
	const child = spawn(process.execPath, ['src/lib/server/mcp-bridge.mjs'], {
		cwd: process.cwd(),
		// Blank the provider key so a started turn cannot reach a real model; the
		// child is killed on stdin end anyway, but this keeps the test hermetic.
		env: { ...process.env, LLM_API_KEY: '' },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const replies = new Map<number, Rpc>();
	let buf = '';
	child.stdout.on('data', (d) => {
		buf += d.toString();
		let idx: number;
		while ((idx = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			const msg = JSON.parse(line) as Rpc;
			if (typeof msg.id === 'number') replies.set(msg.id, msg);
		}
		// End stdin only once every request has been answered: the bridge exits on
		// stdin end, and a slow handler (send_message imports the task runner)
		// would otherwise be killed before it replies.
		if (replies.size >= requests.length) child.stdin.end();
	});
	child.on('error', reject);
	child.on('close', () => resolve(replies));
	for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n');
	return promise;
}

describe('mcp-bridge stdio server', () => {
	it('answers initialize, tools/list and a real list_bots call', async () => {
		const replies = await driveBridge([
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
			{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_bots', arguments: {} } }
		]);

		expect(replies.get(1)?.result).toMatchObject({ serverInfo: { name: 'openbotlounge-bridge' } });
		const names = replies.get(2)?.result?.tools?.map((t) => t.name) ?? [];
		expect(names).toEqual(
			expect.arrayContaining(['list_bots', 'get_bot', 'list_conversations', 'read_conversation', 'send_message', 'list_tasks', 'cancel_task'])
		);
		// The DB module loaded and answered: the payload is a JSON array of bots.
		const call = replies.get(3);
		expect(call?.error).toBeUndefined();
		const text = call?.result?.content?.[0]?.text ?? '';
		expect(Array.isArray(JSON.parse(text))).toBe(true);
	});

	it('reports a missing required argument as a JSON-RPC error, not a crash', async () => {
		const replies = await driveBridge([
			{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_conversation', arguments: {} } }
		]);
		expect(replies.get(1)?.error?.message).toBe('conversation_id required');
	});

	it('send_message validates input and starts a typed task for the target bot', async () => {
		const bot: Bot = createBot({ name: 'BridgeProbe', persona: 'probe', avatar: '', color: '', model: '', badge: '' });
		const conv: Conversation = createConversation([bot.id], 'direct');
		try {
			const replies = await driveBridge([
				{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { content: '   ' } } },
				{
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'send_message', arguments: { content: 'hello from the bridge test', conversation_id: conv.id, bot_id: bot.id, context: 'bridge test: checking a job carries its reason' } }
				}
			]);

			// Validation is unchanged: an empty message is refused before any write.
			expect(replies.get(1)?.error?.message).toBe('content required');

			const call = replies.get(2);
			expect(call?.error).toBeUndefined();
			const payload = JSON.parse(call?.result?.content?.[0]?.text ?? '{}') as {
				conversation_id: string;
				message_id: string;
				tasks: { id: string; bot_id: string }[];
			};
			expect(payload.conversation_id).toBe(conv.id);
			expect(payload.message_id).toBeTruthy();
			expect(payload.tasks).toHaveLength(1);
			expect(payload.tasks[0].bot_id).toBe(bot.id);

			// The typed runner really started the turn: the task row exists with the
			// message as its prompt. (The child is killed on stdin end, so the turn
			// itself does not finish — only its start is asserted.)
			const row = getTask(payload.tasks[0].id);
			expect(row).toMatchObject({ conversation_id: conv.id, bot_id: bot.id, prompt: 'hello from the bridge test', kind: 'chat', context: 'bridge test: checking a job carries its reason' });
		} finally {
			db.prepare('DELETE FROM tasks WHERE bot_id = ?').run(bot.id);
			db.prepare('DELETE FROM activities WHERE bot_id = ?').run(bot.id);
			deleteConversation(conv.id);
			deleteBot(bot.id);
		}
	});
});
