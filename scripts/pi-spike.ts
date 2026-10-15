/**
 * SPIKE: drive one pi agent turn against the app's provider config.
 *   npx esbuild scripts/pi-spike.ts --bundle --platform=node --format=esm \
 *     --packages=external --alias:'$lib'=./src/lib --outfile=node_modules/.cache/pi-spike.mjs
 *   node node_modules/.cache/pi-spike.mjs [--codex]
 *
 * (Bare `node --experimental-strip-types` cannot resolve the app's
 * extensionless relative imports, so the script is bundled first.)
 *
 *
 * Reads the app's real providerConfig() (settings table over LLM_* env, in a
 * throwaway DATA_DIR), registers it on a pi ModelRuntime, and completes one
 * prompt through createAgentSession. With no live provider reachable, the
 * baseUrl is pointed at a local mock that speaks the matching wire protocol
 * and records the request - the registration path is identical either way.
 *
 * --codex seeds a fake OAuth session (provider_oauth + a JWT-shaped
 * provider_api_key) so the Codex responses-API mapping is exercised.
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'obl-pi-spike-'));

const codex = process.argv.includes('--codex');

// Dynamic imports are required here: db.ts opens the SQLite file at
// config.dataDir during module evaluation, so DATA_DIR must be assigned
// before it loads - static imports would hoist the evaluation above it.
const { setSetting, providerConfig } = await import('../src/lib/server/db.ts');
const { createLoungeRuntime, createLoungeSession, registerLoungeProvider } = await import(
	'../src/lib/server/pi-bridge.ts'
);


if (codex) {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const token = `${b64({ alg: 'RS256' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-demo' } })}.sig`;
	setSetting('provider_api_key', token);
	setSetting(
		'provider_oauth',
		JSON.stringify({ refresh_token: 'rt', account_id: 'acct-demo', expires_at: Date.now() + 3_600_000 })
	);
}

const cfg = providerConfig();
console.log(`app config: baseUrl=${cfg.baseUrl} apiKey=${cfg.apiKey ? '<set>' : '<unset>'} oauth=${cfg.oauth ? '<set>' : '<unset>'}`);

// Mock endpoint speaking the right protocol for the configured auth mode.
const events: Record<string, unknown>[] = codex
	? [
			{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
			{ type: 'response.output_text.delta', output_index: 0, delta: 'pi reached the codex seam' },
			{ type: 'response.completed', response: { status: 'completed', model: 'gpt-spike' } }
		]
	: [
			{ choices: [{ delta: { content: 'pi reached the completions seam' } }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] }
		];
const path = codex ? '/codex/responses' : '/v1/chat/completions';

const seen: { url: string; headers: Record<string, unknown>; body: string }[] = [];
const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		let body = Buffer.concat(chunks);
		if (req.headers['content-encoding'] === 'zstd') body = zstdDecompressSync(body);
		seen.push({ url: req.url ?? '', headers: req.headers, body: body.toString('utf8') });
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
		res.write('data: [DONE]\n\n');
		res.end();
	});
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const runtime = await createLoungeRuntime();
const { model, kind } = registerLoungeProvider(runtime, {
	// The app's configured baseUrl is unreachable here; the mock stands in for
	// it. Everything else - key, api choice, model id - is the app's config.
	baseUrl: `http://127.0.0.1:${port}${codex ? '/codex' : '/v1'}`,
	model: codex ? 'gpt-spike' : 'default'
});
console.log(`registered provider kind=${kind} model=${model.provider}/${model.id}`);

const { session } = await createLoungeSession({
	model,
	modelRuntime: runtime,
	systemPrompt: 'You are a spike bot.',
	transport: codex ? 'sse' : undefined
});
let reply = '';
session.subscribe((e) => {
	if (e.type === 'message_update') {
		const ev = e as { assistantMessageEvent?: { type: string; delta?: string } };
		if (ev.assistantMessageEvent?.type === 'text_delta') reply += ev.assistantMessageEvent.delta ?? '';
	}
});
await session.prompt('say hi');
session.dispose();
server.close();

console.log(`request: POST ${seen[0]?.url}`);
console.log(`  authorization: ${String(seen[0]?.headers.authorization).slice(0, 24)}…`);
if (codex) console.log(`  chatgpt-account-id: ${seen[0]?.headers['chatgpt-account-id']}`);
console.log(`reply: ${reply}`);
