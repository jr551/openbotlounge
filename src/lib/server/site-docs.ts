import {
	addBotTokens,
	claimSiteNote,
	finishSiteNote,
	getSiteNote,
	listSiteObservations,
	logActivity,
	logEvent,
	saveSiteNoteDraft,
	type SiteNote
} from './db';
import {
	defaultModel,
	estimateUsage,
	streamChat,
	type ChatMessage,
	type StreamResult,
	type ToolDef
} from './llm';
import { machineExec } from './machine';
import { redactSecrets } from './secrets';
// The documenter's spend is the app's, not the actor's: its tokens are billed
// to the police bot, the fleet's system account, the same way meterPoliceCall
// bills the officer's own calls.
import { ensurePoliceBot } from './police';

/**
 * Cooperative browsing: when a bot's browser lands on a domain the fleet has
 * not documented, a second agent - the documenter - maps the site in the
 * background while the acting agent keeps working. The note it writes is
 * keyed by domain in site_notes, so the next agent to visit reads it instead
 * of rediscovering the site blind.
 *
 * The two agents cooperate through the database rather than a channel: the
 * actor's tool calls land as site_observations rows (written by the
 * computer-agent loop, tagged with the domain browser_navigate last set on
 * its context), and the documenter's draft sits in the site_notes row the
 * actor's next navigate reads back. Neither waits on the other.
 *
 * Notes live in the DB, not on /company: the app has no mount of the shared
 * drive - reading one file means borrowing a container - while the note's
 * readers (the tool result that serves it, the documenter that writes it) are
 * all server-side; the note reaches the bot through browser_navigate's
 * result, which is where it is needed.
 */

/** Hard ceiling on documenter steps, independent of the actor's budget. */
const MAX_DOC_STEPS = 8;

/** A ready note older than this is stale: the next visit re-documents. */
export const NOTE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** A 'writing' claim older than this is a crashed documenter, not a live one. */
export const WRITING_STALE_MS = 30 * 60 * 1000;

/** The documenter's tools: read-only fetches plus its own note and the actor's trail. */
const DOC_TOOLS: ToolDef[] = [
	{
		type: 'function',
		function: {
			name: 'fetch_page',
			description:
				'Fetch a URL and read its text. A plain GET through the machine\'s ' +
				'proxy: JavaScript does not run, so a JS-heavy page may come back ' +
				'thin - note that rather than fetching it again.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The URL to fetch' }
				},
				required: ['url']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'read_observations',
			description:
				'Read what the acting agent has tried on this domain so far and ' +
				'what came back - its clicks, commands and failures, newest last.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'save_note',
			description:
				'Save the site note draft. Save early and revise as you learn: ' +
				'the acting agent can read the draft while you work.',
			parameters: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'The note as it stands' }
				},
				required: ['note']
			}
		}
	}
];

/** Drain a streamChat generator, returning its assembled result. */
async function drain(gen: AsyncGenerator<string, StreamResult>): Promise<StreamResult> {
	for (;;) {
		const next = await gen.next();
		if (next.done) return next.value;
	}
}

/** Rough HTML to text: drop script/style, strip tags, collapse whitespace. */
function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim();
}

/** Run one documenter tool; always returns a string result for the model. */
async function runDocTool(
	name: string,
	argsJson: string,
	opts: { botId: string; domain: string; signal?: AbortSignal }
): Promise<string> {
	let a: Record<string, unknown>;
	try {
		const parsed = JSON.parse(argsJson || '{}');
		a = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return 'error: invalid tool arguments';
	}
	switch (name) {
		case 'fetch_page': {
			const url = typeof a.url === 'string' ? a.url.trim() : '';
			if (!/^https?:\/\//i.test(url)) return 'error: url must start with http:// or https://';
			// The fetch runs on the actor's machine - the proxy env is already
			// set there - as a quiet exec, so it never touches the browser the
			// actor is driving. Capped before it leaves the machine. The
			// 'documenter' kind keeps it honest in the actor's feed: it is the
			// fleet's fetch, not a command the bot ran.
			const quoted = `'${url.replace(/'/g, `'\\''`)}'`;
			const out = await machineExec(
				opts.botId,
				`curl -sL --max-time 20 -A 'Mozilla/5.0' ${quoted} | head -c 200000`,
				opts.signal,
				'documenter'
			);
			const text = htmlToText(redactSecrets(opts.botId, out));
			return text.slice(0, 6000) || '(the page came back empty)';
		}
		case 'read_observations': {
			const obs = listSiteObservations(opts.domain);
			if (!obs.length) return 'no observations yet - the actor has not done much here';
			return obs.map((o) => `- ${o.action} -> ${o.outcome}`).join('\n').slice(0, 6000);
		}
		case 'save_note': {
			const note = typeof a.note === 'string' ? a.note.trim() : '';
			if (!note) return 'error: note required';
			saveSiteNoteDraft(opts.domain, note);
			return 'draft saved - keep exploring, or reply with the finished note';
		}
		default:
			return `error: unknown tool "${name}"`;
	}
}

interface DocumenterOpts {
	botId: string;
	domain: string;
	model: string;
	signal?: AbortSignal;
}

/**
 * The documenter's model loop. It never drives the actor's browser - two
 * agents on one mouse would fight - so its view of the site is read-only
 * fetches plus the actor's own observation trail. Never throws: the outcome
 * lands on the site_notes row either way.
 */
async function runDocumenter(opts: DocumenterOpts): Promise<void> {
	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				`You are the fleet's site documenter. Another agent is doing a task ` +
				`on ${opts.domain} right now; your job is to write the note that ` +
				'saves the NEXT agent from discovering the site blind.\n\n' +
				`Write a short markdown note on ${opts.domain}: what the site is, ` +
				'the key pages and their URLs, how navigation and any login flow ' +
				'work, selectors or labels that worked, and quirks - popups, ' +
				'cookie walls, JS-heavy pages, rate limits.\n\n' +
				'- fetch_page reads a URL as text. Stay on the domain; follow its ' +
				'own links rather than guessing URLs.\n' +
				'- read_observations is the acting agent\'s trail on this site: ' +
				'what it tried and what came back. It is your best evidence - ' +
				'fold it in, and read it again before you finish.\n' +
				'- save_note stores your draft; the actor reads it while you work, ' +
				'so save early and revise.\n' +
				'- When the note says what a newcomer needs, reply with the final ' +
				'note text and no tool calls. Under a page; facts over padding.'
		},
		{
			role: 'user',
			content: `Document ${opts.domain} for the fleet.`
		}
	];

	let draft = '';
	let tokensIn = 0;
	let tokensOut = 0;

	try {
		for (let step = 0; step < MAX_DOC_STEPS; step++) {
			if (opts.signal?.aborted) break;
			let result: StreamResult;
			try {
				result = await drain(
					streamChat({ model: opts.model, messages, signal: opts.signal, tools: DOC_TOOLS })
				);
			} catch (e) {
				logActivity(
					opts.botId,
					'browser',
					`Documenting ${opts.domain} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`
				);
				finishSiteNote(opts.domain, 'failed', draft);
				return;
			}
			const usage = result.usage ?? estimateUsage(messages, result.text, DOC_TOOLS);
			tokensIn += usage.input;
			tokensOut += usage.output;

			if (result.truncated) break;

			if (!result.toolCalls.length) {
				// The reply is the finished note; a saved draft stands if the
				// model ended on a tool-call-less remark instead.
				const final = result.text.trim() || draft;
				finishSiteNote(opts.domain, final ? 'ready' : 'failed', final);
				logActivity(opts.botId, 'browser', `Documented ${opts.domain} for the fleet`);
				return;
			}

			messages.push({ role: 'assistant', content: result.text, tool_calls: result.toolCalls });
			for (const call of result.toolCalls) {
				const out = await runDocTool(call.function.name, call.function.arguments, opts);
				messages.push({ role: 'tool', tool_call_id: call.id, content: out });
				if (call.function.name === 'save_note') {
					try {
						draft = (JSON.parse(call.function.arguments || '{}') as { note?: string }).note?.trim() ?? draft;
					} catch {
						// A malformed save already answered itself; the draft stands.
					}
				}
			}
		}
		// Step cap or cancellation: a draft is still worth keeping.
		finishSiteNote(opts.domain, draft ? 'ready' : 'failed', draft);
	} finally {
		// The documenter is the app's own agent, so its spend lands on the
		// system account rather than inflating the triggering bot's meter.
		if (tokensIn || tokensOut) addBotTokens(ensurePoliceBot().id, tokensIn, tokensOut);
	}
}

/** The documenters this process is running, keyed by domain. */
const running = new Map<string, Promise<void>>();

/** The live documenter for a domain, if this process is running one. Tests await it. */
export function documenterFor(domain: string): Promise<void> | undefined {
	return running.get(domain);
}

export interface SiteVisit {
	domain: string;
	/** Whether this visit spawned a documenter. */
	spawned: boolean;
	/** The note row as it stands - draft included - when there is one. */
	note?: SiteNote;
}

/**
 * Note that the actor's browser is on a domain: spawn the documenter when the
 * fleet has no fresh note and none is being written, and return whatever note
 * exists so the caller can serve it with the page. Synchronous and cheap -
 * the documenter runs in the background, never on the actor's critical path.
 */
export function noteDomainVisit(opts: {
	botId: string;
	botName: string;
	domain: string;
	model?: string;
	signal?: AbortSignal;
	conversationId?: string;
}): SiteVisit {
	const { domain } = opts;
	const note = getSiteNote(domain);
	if (note?.status === 'ready' && Date.now() - note.updated_at < NOTE_STALE_MS) {
		return { domain, spawned: false, note };
	}
	if (running.has(domain)) return { domain, spawned: false, note };
	// The claim is the cross-process lock: a live 'writing' row or a fresh
	// 'ready' note makes it update zero rows, and this visit moves on.
	if (!claimSiteNote(domain, opts.botId, Date.now() - WRITING_STALE_MS, Date.now() - NOTE_STALE_MS)) {
		return { domain, spawned: false, note };
	}
	const job = runDocumenter({
		botId: opts.botId,
		domain,
		model: opts.model || defaultModel(),
		signal: opts.signal
	});
	const tracked = job.finally(() => running.delete(domain));
	running.set(domain, tracked);
	// runDocumenter never throws by design; the catch is belt-and-braces so a
	// bug there can never surface as an unhandled rejection.
	void tracked.catch(() => {});
	logActivity(opts.botId, 'browser', `Documenting ${domain} for the fleet`);
	if (opts.conversationId) {
		logEvent(opts.conversationId, opts.botId, 'browser', `Documenting ${domain} for the fleet`);
	}
	return { domain, spawned: true, note: getSiteNote(domain) };
}
