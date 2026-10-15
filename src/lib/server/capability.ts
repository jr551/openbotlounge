/**
 * The capability test: a battery of checks run against the configured model,
 * each repeated until the token budget is spent, so the report is a pass rate
 * rather than a single lucky answer. What it measures is what the fleet
 * actually asks of a model: follow an instruction exactly, emit parseable
 * JSON, call a tool, do arithmetic, resist making things up, hold a needle in
 * a long context, and chain steps.
 *
 * The run is one at a time and lives in memory while it runs; the finished
 * report is kept in settings so the Settings page can show the last one
 * across restarts.
 */
import { complete, streamChat, type ChatMessage, type ToolDef } from './llm';
import { setSetting, listSettings } from './db';

export interface CapabilityCheck {
	id: string;
	name: string;
	runs: number;
	passed: number;
	/** One line per run: what the model did, clipped. */
	samples: { pass: boolean; detail: string }[];
}

export interface CapabilityReport {
	model: string;
	budget: number;
	tokens_used: number;
	started_at: number;
	finished_at: number;
	checks: CapabilityCheck[];
	/** 'capable' | 'partial' | 'poor' */
	verdict: string;
}

interface Probe {
	id: string;
	name: string;
	/** Run one trial; return pass and a one-line detail. */
	run: () => Promise<{ pass: boolean; detail: string }>;
}

const clip = (s: string, n = 120) => {
	const flat = s.replace(/\s+/g, ' ').trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * An 8x8 solid red PNG as a data URI. A fixed byte string rather than a
 * runtime encoding: the probe's subject is the model's eyes, not our encoder,
 * and the constant is one line.
 */
const RED_PNG_DATA_URI =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

/** One short completion; returns the trimmed text. */
async function ask(model: string, system: string, prompt: string, onUsage: (t: number) => void): Promise<string> {
	const text = await complete(
		model,
		[
			{ role: 'system', content: system },
			{ role: 'user', content: prompt }
		],
		{ onUsage: (u) => onUsage(u.input + u.output) }
	);
	return text.trim();
}

/**
 * What one image probe found: whether the model read the picture, and the one
 * line that says so - the colour it named, or the refusal that came back.
 */
export interface VisionVerdict {
	pass: boolean;
	detail: string;
}

/**
 * Ask one model to look at a red square. This is the whole vision test: one
 * image, one question, one answer, and anything that is not "red" is a no - a
 * text-only model does not get the colour wrong, it refuses the request at the
 * door.
 *
 * A Provider 400 is that refusal, and comes back as a failed check. Any other
 * failure is thrown, not swallowed: an outage is not a model without eyes, and
 * whoever asked (the battery, the settings gate) decides what an outage means.
 * `onUsage` is for the battery's token count; the settings gate has no meter.
 */
export async function checkVision(
	model: string,
	onUsage?: (tokens: number) => void
): Promise<VisionVerdict> {
	let result;
	try {
		const gen = streamChat({
			model,
			messages: [
				{
					role: 'system',
					content: 'Answer with the colour name only.'
				},
				{
					role: 'user',
					content: [
						{ type: 'image_url', image_url: { url: RED_PNG_DATA_URI } },
						{
							type: 'text',
							text: 'What colour fills this image? answer with the colour name only.'
						}
					]
				}
			]
		});
		for (;;) {
			const next = await gen.next();
			if (next.done) {
				result = next.value;
				break;
			}
		}
	} catch (e) {
		if (/^Provider 400/.test((e as Error).message)) {
			return { pass: false, detail: 'provider rejected image input' };
		}
		throw e;
	}
	onUsage?.(result.usage ? result.usage.input + result.usage.output : 0);
	return { pass: /red/i.test(result.text), detail: clip(result.text || '(empty)') };
}

/** The battery. Each probe is self-contained and cheap enough to repeat. */
function probes(model: string, onUsage: (t: number) => void): Probe[] {
	return [
		{
			id: 'ping',
			name: 'Exact reply',
			run: async () => {
				const out = await ask(model, 'Reply with exactly the word: pong', 'Say it.', onUsage);
				return { pass: out.toLowerCase() === 'pong', detail: clip(out || '(empty)') };
			}
		},
		{
			id: 'instruction',
			name: 'Instruction following',
			run: async () => {
				const out = await ask(
					model,
					'List exactly three colours, one per line, no numbering, no punctuation, nothing else.',
					'Go.',
					onUsage
				);
				const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
				return {
					pass: lines.length === 3 && lines.every((l) => /^[a-zA-Z]+$/.test(l)),
					detail: clip(out)
				};
			}
		},
		{
			id: 'json',
			name: 'JSON output',
			run: async () => {
				const out = await ask(
					model,
					'Reply with JSON only: an object with keys "name" (a colour) and "count" (the number 3). No markdown, no prose.',
					'Go.',
					onUsage
				);
				try {
					const parsed = JSON.parse(out.replace(/^```(?:json)?|```$/g, '').trim());
					const pass = typeof parsed?.name === 'string' && parsed?.count === 3;
					return { pass, detail: clip(out) };
				} catch {
					return { pass: false, detail: clip(out) };
				}
			}
		},
		{
			id: 'tool_call',
			name: 'Tool use',
			run: async () => {
				const tools: ToolDef[] = [
					{
						type: 'function',
						function: {
							name: 'get_weather',
							description: 'Get the current weather for a city.',
							parameters: {
								type: 'object',
								properties: { city: { type: 'string' } },
								required: ['city']
							}
						}
					}
				];
				const gen = streamChat({
					model,
					messages: [
						{ role: 'system', content: 'Use the tool to answer. Do not answer from memory.' },
						{ role: 'user', content: 'What is the weather in Paris right now?' }
					],
					tools
				});
				let result;
				for (;;) {
					const next = await gen.next();
					if (next.done) {
						result = next.value;
						break;
					}
				}
				onUsage(result.usage ? result.usage.input + result.usage.output : 0);
				const call = result.toolCalls.find((c) => c.function.name === 'get_weather');
				return {
					pass: !!call,
					detail: call ? `called get_weather(${clip(call.function.arguments, 60)})` : clip(result.text || '(no call)')
				};
			}
		},
		{
			id: 'arithmetic',
			name: 'Arithmetic',
			run: async () => {
				const out = await ask(model, 'Reply with the number only.', 'What is 347 times 29?', onUsage);
				const pass = /10063/.test(out);
				return { pass, detail: clip(out) };
			}
		},
		{
			id: 'hallucination',
			name: 'Hallucination resistance',
			run: async () => {
				const out = await ask(
					model,
					'If you do not know the answer, reply with exactly: UNKNOWN. Never invent a fact.',
					'What is the capital of Zorblaxia?',
					onUsage
				);
				const pass = /unknown|not a real|does not exist|no such/i.test(out);
				return { pass, detail: clip(out) };
			}
		},
		{
			id: 'multistep',
			name: 'Multi-step reasoning',
			run: async () => {
				const out = await ask(
					model,
					'Reply with the number only.',
					'Start with 10. Add 5. Multiply by 2. Subtract 4. What do you get?',
					onUsage
				);
				return { pass: /\b26\b/.test(out), detail: clip(out) };
			}
		},
		{
			id: 'needle',
			name: 'Needle in context',
			run: async () => {
				const needle = 'The code word is PLATYPUS.';
				const filler =
					'The committee discussed the minutes of the previous meeting at length. '.repeat(160);
				const out = await ask(
					model,
					'Read the text and answer the question with the code word only.',
					`${filler}\n${needle}\n${filler}\n\nWhat is the code word?`,
					onUsage
				);
				return { pass: /platypus/i.test(out), detail: clip(out) };
			}
		},
		{
			id: 'vision',
			name: 'Vision',
			run: () => checkVision(model, onUsage)
		}
	];
}

/** The run currently in flight, or null. */
let running: Promise<CapabilityReport> | null = null;

/** What the last run produced, or null before the first. */
export function lastCapabilityReport(): CapabilityReport | null {
	const raw = listSettings().capability_last_report;
	if (!raw) return null;
	try {
		return JSON.parse(raw) as CapabilityReport;
	} catch {
		return null;
	}
}

/** Whether a run is in flight right now. */
export function capabilityRunning(): boolean {
	return running !== null;
}

/**
 * Run the battery until the token budget is spent. One run at a time - a
 * second call while one is in flight returns that run's promise rather than
 * doubling the spend.
 */
export function runCapabilityTest(model: string, budget = 1_000_000): Promise<CapabilityReport> {
	if (running) return running;
	running = runInner(model, budget).finally(() => {
		running = null;
	});
	return running;
}

async function runInner(model: string, budget: number): Promise<CapabilityReport> {
	const started = Date.now();
	let used = 0;
	const onUsage = (t: number) => {
		used += t;
	};
	const checks = new Map<string, CapabilityCheck>();
	for (const p of probes(model, onUsage)) {
		checks.set(p.id, { id: p.id, name: p.name, runs: 0, passed: 0, samples: [] });
	}
	// Round-robin the probes until the budget is spent: every check gets the
	// same number of trials, and a cheap check does not eat the budget a
	// needle-in-context run could use.
	const list = probes(model, onUsage);
	let i = 0;
	while (used < budget) {
		const probe = list[i % list.length];
		i++;
		const check = checks.get(probe.id)!;
		try {
			const r = await probe.run();
			check.runs++;
			if (r.pass) check.passed++;
			if (check.samples.length < 5) check.samples.push(r);
		} catch (e) {
			check.runs++;
			if (check.samples.length < 5)
				check.samples.push({ pass: false, detail: `error: ${(e as Error).message}` });
		}
		// A run that cannot spend is a run that cannot finish: stop rather than
		// loop forever on a dead endpoint.
		if (i >= list.length * 3 && used === 0) break;
	}
	const results = [...checks.values()];
	const rates = results.map((c) => (c.runs ? c.passed / c.runs : 0));
	const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
	const report: CapabilityReport = {
		model,
		budget,
		tokens_used: used,
		started_at: started,
		finished_at: Date.now(),
		checks: results,
		verdict: avg >= 0.8 ? 'capable' : avg >= 0.5 ? 'partial' : 'poor'
	};
	setSetting('capability_last_report', JSON.stringify(report));
	return report;
}
