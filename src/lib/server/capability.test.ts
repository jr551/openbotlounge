import { inflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityReport } from './capability';
import type { ChatMessage, ContentPart, StreamOptions, StreamResult, TokenUsage, ToolCall } from './llm';
import { complete, streamChat } from './llm';
import { capabilityRunning, lastCapabilityReport, runCapabilityTest } from './capability';
import { setSetting } from './db';

/**
 * The battery answers the one question the Settings page asks out loud - "can
 * this model actually do the job?" - and the vision probe is the least
 * forgiving check in it: a text-only provider does not answer it with a wrong
 * colour, it refuses the request at the door. So these tests drive the exported
 * entry point with a stubbed provider and then read the request the probe
 * built, because the wire format is the one thing a stub cannot fake.
 */
vi.mock('./llm', async (importOriginal) => ({
	// The real module's types and helpers stay; every provider call the battery
	// makes is replaced.
	...(await importOriginal<typeof import('./llm')>()),
	complete: vi.fn(),
	streamChat: vi.fn()
}));

const completeMock = vi.mocked(complete);
const streamMock = vi.mocked(streamChat);

/** The model every test runs the battery against. */
const MODEL = 'test-model';

/**
 * Four rounds of nine probes at 20 tokens each: enough that every check repeats,
 * small enough that the whole run is instant.
 */
const BUDGET = 400;

/** What a stubbed provider reports per call, so the budget loop can advance. */
const USAGE: TokenUsage = {
	input: 10,
	output: 10,
	source: 'provider',
	cacheRead: 0,
	cacheWrite: 0,
	cacheMiss: 0,
	cacheReported: false
};

/** A streamChat stand-in: yields each delta, then returns the result. */
function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

/** A provider that refuses the request before streaming anything. */
function rejectStream(message: string): AsyncGenerator<string, StreamResult> {
	return (async function* (): AsyncGenerator<string, StreamResult> {
		throw new Error(message);
	})();
}

/** The tool call the tool-use probe is looking for. */
const GET_WEATHER: ToolCall = {
	id: 'c1',
	type: 'function',
	function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
};

/** Whether a request carries an image, i.e. is the vision probe's. */
function carriesImage(messages: ChatMessage[]): boolean {
	return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

/** The request the vision probe made, as the provider saw it. */
function visionRequest(): StreamOptions | undefined {
	return streamMock.mock.calls.find(([opts]) => carriesImage(opts.messages))?.[0];
}

/** A provider that sees the image, and calls the tool the tool probe offers. */
function seesImages(): void {
	streamMock.mockImplementation((opts) =>
		carriesImage(opts.messages)
			? fakeStream(['Red'], { text: 'Red', toolCalls: [], usage: USAGE })
			: fakeStream([], { text: '', toolCalls: [GET_WEATHER], usage: USAGE })
	);
}

/** A provider that refuses image input, as a text-only one does. */
function refusesImages(message: string): void {
	streamMock.mockImplementation((opts) =>
		carriesImage(opts.messages)
			? rejectStream(message)
			: fakeStream([], { text: '', toolCalls: [GET_WEATHER], usage: USAGE })
	);
}

function check(id: string, report: CapabilityReport) {
	return report.checks.find((c) => c.id === id)!;
}

/**
 * A minimal PNG reader: enough to prove the attached bytes are a real image
 * rather than a URL that merely looks like one.
 */
function decodePng(png: Buffer): { width: number; height: number; pixels: Buffer } {
	expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	let at = 8;
	let width = 0;
	let height = 0;
	const idat: Buffer[] = [];
	while (at + 8 <= png.length) {
		const length = png.readUInt32BE(at);
		const type = png.toString('latin1', at + 4, at + 8);
		const data = png.subarray(at + 8, at + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			expect(data[8]).toBe(8); // bit depth
			expect(data[9]).toBe(2); // truecolour
		}
		if (type === 'IDAT') idat.push(data);
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 3;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		if (filter > 1) throw new Error(`unsupported PNG row filter ${filter}`);
		for (let i = 0; i < stride; i++) {
			// Filter 0 is the byte as written; filter 1 (Sub) is a delta from the
			// pixel to its left. Reading both keeps this a PNG reader rather than a
			// decoder for one particular file.
			const left = filter === 1 && i >= 3 ? pixels[y * stride + i - 3] : 0;
			pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + left) & 255;
		}
	}
	return { width, height, pixels };
}

beforeEach(() => {
	// The text probes are not what these tests are about: they answer plausibly
	// and report their cost, so the run reaches the vision probe and the budget
	// loop can finish.
	completeMock.mockReset().mockImplementation(async (_model, _messages, opts) => {
		opts?.onUsage?.(USAGE);
		return 'pong';
	});
	streamMock.mockReset();
});

describe('the vision probe', () => {
	it('passes a model that reads the image and names the colour', async () => {
		seesImages();

		const report = await runCapabilityTest(MODEL, BUDGET);

		const vision = check('vision', report);
		// Repeated, not one lucky answer: a pass rate is the point of the battery.
		expect(vision.runs).toBeGreaterThan(1);
		expect(vision.passed).toBe(vision.runs);
		expect(vision.samples[0]).toEqual({ pass: true, detail: 'Red' });
	});

	it('fails a model that accepts the image but does not read it', async () => {
		// Accepting array content is not seeing: a model that answers a colour it
		// was not shown is the case the check exists to catch.
		streamMock.mockImplementation((opts) =>
			carriesImage(opts.messages)
				? fakeStream(['Blue'], { text: 'Blue', toolCalls: [], usage: USAGE })
				: fakeStream([], { text: '', toolCalls: [GET_WEATHER], usage: USAGE })
		);

		const report = await runCapabilityTest(MODEL, BUDGET);

		const vision = check('vision', report);
		expect(vision.passed).toBe(0);
		expect(vision.samples[0]).toEqual({ pass: false, detail: 'Blue' });
	});

	it('reports a text-only provider as a clean reject, and finishes the rest of the battery', async () => {
		// The refusal is at the request level, not a wrong answer: this is what a
		// provider that will not take array content sends back.
		refusesImages('Provider 400: content must be a string');

		const report = await runCapabilityTest(MODEL, BUDGET);

		const vision = check('vision', report);
		// The refusal is a verdict on this check, not a reason to stop: the probe
		// was tried again on the next round of the battery.
		expect(vision.runs).toBeGreaterThan(1);
		expect(vision.passed).toBe(0);
		expect(vision.samples.length).toBeGreaterThan(0);
		expect(vision.samples.every((s) => s.detail === 'provider rejected image input')).toBe(true);

		// And it belongs to this check alone: the rest of the battery kept running
		// alongside it, including the other provider call in it.
		expect(report.checks.map((c) => c.id)).toEqual(
			expect.arrayContaining([
				'ping',
				'instruction',
				'json',
				'tool_call',
				'arithmetic',
				'hallucination',
				'multistep',
				'needle',
				'vision'
			])
		);
		expect(report.checks.every((c) => c.runs > 1)).toBe(true);
		expect(check('tool_call', report).passed).toBeGreaterThan(0);
	});

	it('records an unrelated provider failure as an error and carries on', async () => {
		refusesImages('Provider 500: upstream is down');

		const report = await runCapabilityTest(MODEL, BUDGET);

		// A broken provider is not a text-only one: degrading any error to "cannot
		// see" would hide an outage behind a capability verdict.
		const vision = check('vision', report);
		expect(vision.passed).toBe(0);
		expect(vision.samples[0].detail).toBe('error: Provider 500: upstream is down');

		// And one probe throwing does not end the run: every check was tried again.
		expect(report.checks.every((c) => c.runs > 1)).toBe(true);
		expect(check('ping', report).passed).toBeGreaterThan(0);
	});

	it('attaches the red test image as a data URI on the request', async () => {
		seesImages();

		await runCapabilityTest(MODEL, BUDGET);

		const call = visionRequest()!;
		expect(call.model).toBe(MODEL);
		const user = call.messages.find((m) => Array.isArray(m.content))!;
		const parts = user.content as ContentPart[];
		expect(parts.map((p) => p.type)).toEqual(['image_url', 'text']);

		const image = parts[0];
		const url = image.type === 'image_url' ? image.image_url.url : '';
		expect(url.startsWith('data:image/png;base64,')).toBe(true);

		// And the bytes behind the URI are a real 8x8 image, every pixel pure red.
		// The probe only means anything if the picture the model is shown is
		// actually the colour it is asked about.
		const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
		const { width, height, pixels } = decodePng(png);
		expect([width, height]).toEqual([8, 8]);
		const colours = new Set<string>();
		for (let i = 0; i < pixels.length; i += 3) {
			colours.add(pixels.subarray(i, i + 3).toString('hex'));
		}
		expect([...colours]).toEqual(['ff0000']);
	});
});

describe('runCapabilityTest', () => {
	it('keeps the finished report where the Settings page reads it', async () => {
		seesImages();

		const report = await runCapabilityTest(MODEL, BUDGET);

		expect(lastCapabilityReport()).toEqual(report);
	});

	it('runs one battery at a time, handing a second caller the run in flight', async () => {
		seesImages();

		expect(capabilityRunning()).toBe(false);
		const first = runCapabilityTest(MODEL, BUDGET);
		expect(capabilityRunning()).toBe(true);
		// The second caller gets that run rather than a second spend.
		expect(runCapabilityTest(MODEL, BUDGET)).toBe(first);

		await first;
		expect(capabilityRunning()).toBe(false);
	});

	it('reads a corrupt stored report as no report rather than throwing', () => {
		setSetting('capability_last_report', '{"model": "truncated');

		expect(lastCapabilityReport()).toBeNull();
	});
});
