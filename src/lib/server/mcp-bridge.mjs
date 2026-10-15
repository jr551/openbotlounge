#!/usr/bin/env node
/**
 * OpenBotLounge MCP bridge — stdio JSON-RPC 2.0 server.
 *
 * Exposes bot state/actions so external MCP clients can drive the bot system:
 *   list_bots / get_bot / list_conversations / read_conversation /
 *   send_message / list_tasks / cancel_task
 *
 * Transport: stdio lines of JSON. No external deps — only node: built-ins.
 * Security: only runs when invoked via `.omp/mcp.json` by a trusted pi/omp
 * client; no network listener. Mutating tools validate inputs the same way the
 * HTTP routes do (see `src/routes/api/chat/+server.ts`).
 *
 * System prompt preservation: `send_message` reuses `startTypedTask` →
 * `startTask` → `runBotTurn` → `buildHistory`, so the bespoke
 * `bot.persona + voice + memory` prompt is always built first; the bridge
 * preamble is appended, never substituted.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// The bridge runs under plain `node` (see `.omp/mcp.json`), but the app modules
// it imports are TypeScript written for Vite: extensionless relative imports
// (`./config`) and the `$lib` alias. Node's native type-stripping runs the .ts
// files fine, but its ESM resolver rejects those specifiers, so every tool call
// failed with "could not load db.ts". Register a resolve hook that mirrors the
// two Vite behaviours before anything is imported.
const REPO_ROOT = process.cwd();
function resolveWithExtensions(base, context, nextResolve) {
	const candidates = [base, `${base}.ts`, `${base}/index.ts`, `${base}.mjs`, `${base}.js`];
	let lastError;
	for (const candidate of candidates) {
		try {
			return nextResolve(candidate.startsWith('file:') ? candidate : pathToFileURL(candidate).href, context);
		} catch (e) {
			lastError = e;
		}
	}
	throw lastError;
}
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '$lib' || specifier.startsWith('$lib/')) {
			return resolveWithExtensions(join(REPO_ROOT, 'src/lib', specifier.slice(4)), context, nextResolve);
		}
		try {
			return nextResolve(specifier, context);
		} catch (e) {
			// A relative specifier must be resolved against the importing module,
			// not the process cwd — `./config` in src/lib/server/db.ts means
			// src/lib/server/config.ts, never <cwd>/config.ts.
			if (specifier.startsWith('.') && context.parentURL) {
				const base = new URL(specifier, context.parentURL).href;
				return resolveWithExtensions(base, context, nextResolve);
			}
			throw e;
		}
	}
});

// Lazy-load DB helpers via dynamic import once DATA_DIR is resolved.
// The bridge runs as a child of the Pi agent, not the SvelteKit server, so
// it must locate `chat.db` itself.
let dbHelpers = null;
async function getHelpers() {
	if (dbHelpers) return dbHelpers;
	// Resolve DATA_DIR relative to repo root (parent of src/); honour env.
	const candidates = [
		process.env.DATA_DIR,
		join(process.cwd(), 'data'),
		join(import.meta.dirname ?? '.', '../../../data'),
		'./data'
	].filter(Boolean);
	let dataDir = candidates[0];
	for (const c of candidates) {
		if (existsSync(join(c, 'chat.db'))) { dataDir = c; break; }
	}
	if (!process.env.DATA_DIR) process.env.DATA_DIR = dataDir;
	// Import after DATA_DIR is set so `db.ts` opens the right file.
	// Use a file URL relative to this file's location.
	const dbUrl = new URL('./db.ts', import.meta.url).href;
	try {
		dbHelpers = await import(dbUrl);
	} catch (e) {
		// Surface the real cause — a bare "could not load" hides whether it was
		// the resolver, a syntax error, or a missing dependency.
		throw new Error(
			`mcp-bridge: could not load src/lib/server/db.ts from ${dbUrl}: ` +
			`${e instanceof Error ? e.message : String(e)}`
		);
	}
	return dbHelpers;
}

// Tool definitions — shape mirrors Pi SDK `defineTool` + MCP `tools/list`.
const TOOLS = [
	{
		name: 'list_bots',
		description: 'List bots. Hidden/police bots are omitted by default; pass include_hidden=true to see them. Use to pick a bot_id for send_message/read_conversation.',
		inputSchema: {
			type: 'object',
			properties: {
				include_hidden: { type: 'boolean', description: 'Include hidden/system bots (default false)' }
			}
		}
	},
	{
		name: 'get_bot',
		description: 'Get one bot by id or name. Returns persona, model, hat, token totals, and jail state.',
		inputSchema: {
			type: 'object',
			properties: {
				bot_id: { type: 'string', description: 'Bot id or exact name' }
			},
			required: ['bot_id']
		}
	},
	{
		name: 'list_conversations',
		description: 'List conversations (DMs + group rooms). Each entry includes members, last_message preview, and unread count.',
		inputSchema: {
			type: 'object',
			properties: {
				bot_id: { type: 'string', description: 'Filter to conversations containing this bot id' }
			}
		}
	},
	{
		name: 'read_conversation',
		description: 'Read the transcript of a conversation (paged, newest last). Requires conversation_id.',
		inputSchema: {
			type: 'object',
			properties: {
				conversation_id: { type: 'string' },
				limit: { type: 'number', description: 'Messages to return (1-200, default 50)' },
				before_id: { type: 'string', description: 'Paging cursor: message id to page before' }
			},
			required: ['conversation_id']
		}
	},
	{
		name: 'send_message',
		description: 'Send a message as the human to a bot (DM) or a group conversation. Starts a bot turn and returns task ids. The bot replies via its normal turn pipeline — poll list_tasks or read_conversation to see the reply. Always pass `context` saying what the job is for and who asked, so the task row carries its reason.',
		inputSchema: {
			type: 'object',
			properties: {
				content: { type: 'string', description: 'Message text (1-40000 chars)' },
				conversation_id: { type: 'string', description: 'Existing conversation id. Omit to start a new DM with bot_id.' },
				bot_id: { type: 'string', description: 'Target bot id (required for new DMs; optional to narrow group replies)' },
				reply_to: { type: 'string', description: 'Message id to quote-reply to (must be in the same conversation)' },
				think: { type: 'boolean', description: 'Enable per-turn reasoning flag' },
				context: { type: 'string', description: 'Why this job exists: what it is for and who asked. Stored on the task row and shown to the bot.' }
			},
			required: ['content']
		}
	},
	{
		name: 'list_tasks',
		description: 'List recent tasks (bot turns) — running first, then most recent. Filter by conversation_id or bot_id.',
		inputSchema: {
			type: 'object',
			properties: {
				conversation_id: { type: 'string' },
				bot_id: { type: 'string' },
				since_ms: { type: 'number', description: 'Only tasks created at/after this epoch ms (0 = last 24h default)' }
			}
		}
	},
	{
		name: 'cancel_task',
		description: 'Cancel a running task. Returns false if already finished.',
		inputSchema: {
			type: 'object',
			properties: { task_id: { type: 'string' } },
			required: ['task_id']
		}
	}
];

async function handleToolsCall(name, args) {
	const h = await getHelpers();
	switch (name) {
		case 'list_bots': {
			const includeHidden = Boolean(args?.include_hidden);
			const bots = includeHidden ? h.listBots() : h.listVisibleBots();
			const slim = bots.map(b => ({
				id: b.id, name: b.name, persona: (b.persona ?? '').slice(0, 300),
				model: b.model, hat: b.hat, badge: b.badge, color: b.color,
				archived: !!b.archived, hidden: !!b.hidden,
				created_at: b.created_at
			}));
			return { content: [{ type: 'text', text: JSON.stringify(slim, null, 2) }] };
		}
		case 'get_bot': {
			const raw = String(args?.bot_id ?? '').trim();
			if (!raw) throw new Error('bot_id required');
			let bot = h.getBot(raw);
			if (!bot) {
				bot = h.listBots().find(b => b.name.toLowerCase() === raw.toLowerCase());
			}
			if (!bot) throw new Error(`bot not found: ${raw}`);
			const jail = h.jailStatus ? h.jailStatus(bot) : { jailed: false };
			return { content: [{ type: 'text', text: JSON.stringify({ ...bot, jail }, null, 2) }] };
		}
		case 'list_conversations': {
			const botId = String(args?.bot_id ?? '').trim();
			let convs = h.listConversations();
			if (botId) convs = convs.filter(c => (c.bot_ids ?? '').split(',').includes(botId));
			return { content: [{ type: 'text', text: JSON.stringify(convs.slice(0, 100), null, 2) }] };
		}
		case 'read_conversation': {
			const convId = String(args?.conversation_id ?? '').trim();
			if (!convId) throw new Error('conversation_id required');
			const conv = h.getConversation(convId);
			if (!conv) throw new Error('conversation not found');
			const limit = Math.min(200, Math.max(1, Math.floor(Number(args?.limit ?? 50))));
			const beforeId = String(args?.before_id ?? '').trim() || undefined;
			const page = h.listMessagesPage(convId, { beforeId, limit });
			return { content: [{ type: 'text', text: JSON.stringify({ conversation: conv, ...page }, null, 2) }] };
		}
		case 'send_message': {
			const content = String(args?.content ?? '').trim();
			if (!content) throw new Error('content required');
			if (content.length > 40_000) throw new Error('content too long');
			const convId = String(args?.conversation_id ?? '').trim();
			const botId = String(args?.bot_id ?? '').trim();
			const replyTo = String(args?.reply_to ?? '').trim();
			const think = Boolean(args?.think);
			const context = String(args?.context ?? '').trim();

			// Dynamic import of the typed task runner to avoid a cycle at startup.
			// `startTypedTask` delegates to `startTask` (the only DB writer) and
			// appends the bridge preamble to the system prompt built by
			// `buildHistory` — the bot's persona/voice/memory are never replaced.
			const { startTypedTask } = await import(new URL('./pi-task-runner.ts', import.meta.url).href);
			// Reuse the same validation the HTTP route does, but as library calls.

			let conv = convId ? h.getConversation(convId) : undefined;
			if (!conv && !botId) throw new Error('bot_id required for a new conversation');
			if (conv && conv.private) throw new Error('this room is private — use a direct conversation');
			if (replyTo) {
				const q = h.getMessage(replyTo);
				if (!q || q.conversation_id !== (conv?.id ?? '')) throw new Error('reply_to must name a message in this conversation');
			}
			if (!conv) {
				const bot = h.getBot(botId);
				if (!bot) throw new Error(`bot not found: ${botId}`);
				conv = h.createConversation([bot.id], 'direct');
			}
			// Dedup window like the chat route.
			if (h.recentUserMessage && h.recentUserMessage(conv.id, content, 10_000)) {
				return { content: [{ type: 'text', text: JSON.stringify({ conversation_id: conv.id, tasks: [], duplicate: true }) }] };
			}
			const stored = h.addMessage(conv.id, 'user', content, '', '', 0, '', replyTo);
			// Members for this conversation.
			const members = h.conversationBots(conv.id);
			const requested = botId ? members.find(b => b.id === botId) : undefined;
			const responders = (requested ? [requested] : conv.kind === 'group' ? members : [members[0]]).filter(b => !b.archived);
			if (!responders.length) {
				h.addMessage(conv.id, 'user', 'this bot is in cold storage - only the human can unlock it', '', '', 0, 'app');
				return { content: [{ type: 'text', text: JSON.stringify({ conversation_id: conv.id, tasks: [], archived: true }) }] };
			}
			// The caller's reason rides on the task row (`context`) and reaches the
			// bot in the preamble, so a bridge job is never an unexplained ping.
			const preamble =
				'This message arrived through the MCP bridge from an external client.' +
				(context ? ` Context for this job: ${context}` : '');
			const tasks = responders.map(bot =>
				startTypedTask(
					conv,
					bot,
					{ prompt: content, kind: 'chat', think, context },
					{ preamble }
				)
			);
			return {
				content: [{ type: 'text', text: JSON.stringify({ conversation_id: conv.id, message_id: stored.id, tasks: tasks.map(t => ({ id: t.id, bot_id: t.bot_id })) }, null, 2) }]
			};
		}
		case 'list_tasks': {
			const opts = {};
			if (args?.conversation_id) opts.conversationId = String(args.conversation_id);
			if (args?.bot_id) opts.botId = String(args.bot_id);
			if (args?.since_ms != null) opts.since = Number(args.since_ms);
			const tasks = h.listTasks(opts);
			return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
		}
		case 'cancel_task': {
			const taskId = String(args?.task_id ?? '').trim();
			if (!taskId) throw new Error('task_id required');
			const { cancelTask } = await import(new URL('./tasks.ts', import.meta.url).href);
			const ok = cancelTask(taskId);
			return { content: [{ type: 'text', text: JSON.stringify({ cancelled: ok }) }] };
		}
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

// ---- JSON-RPC loop -------------------------------------------------------

function reply(id, result) {
	const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
	process.stdout.write(msg + '\n');
}
function fail(id, code, message) {
	const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
	process.stdout.write(msg + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
	const raw = line.trim();
	if (!raw) return;
	let req;
	try { req = JSON.parse(raw); } catch { return; }
	const id = req.id;
	const method = req.method;
	const params = req.params ?? {};
	try {
		if (method === 'initialize') {
			reply(id, {
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'openbotlounge-bridge', version: '0.1.0' },
				// Guidance for the agent driving the bots, not the bots themselves:
				// bots keep their own memory via their remember/recall tools, so
				// pi-memory is for the client's side of the bridge — what it was
				// asked to do, which bot it used, and what came back.
				instructions:
					'You are driving OpenBotLounge bots. Use your pi-memory tools ' +
					'(memory_write/memory_read/memory_search) to remember what each ' +
					'bot was asked and what it reported back across sessions. Always ' +
					'pass `context` on send_message saying what the job is for and ' +
					'who asked — it is stored on the task row and shown to the bot.'
			});
		} else if (method === 'notifications/initialized') {
			// no-op
		} else if (method === 'tools/list') {
			reply(id, { tools: TOOLS });
		} else if (method === 'tools/call') {
			const name = params.name;
			const args = params.arguments ?? {};
			const result = await handleToolsCall(name, args);
			reply(id, result);
		} else if (method === 'ping') {
			reply(id, {});
		} else {
			fail(id, -32601, `Method not found: ${method}`);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		fail(id, -32603, msg);
	}
});

rl.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
