import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { setSetting } from './db';
import { costOf, formatCost, modelPricing, resolveModel } from './pricing';

/**
 * A fake provider whose /models listing carries the pricing block, exactly as
 * the real endpoint sends it: per-token costs as strings, and models that
 * carry no pricing object at all.
 */
class FakeModels {
	baseUrl = '';
	hits = 0;
	private server: http.Server | null = null;

	constructor(private readonly body: unknown) {}

	async start(): Promise<void> {
		this.server = http.createServer((_req, res) => {
			this.hits++;
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(this.body));
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		const { port } = this.server!.address() as AddressInfo;
		this.baseUrl = `http://127.0.0.1:${port}/v1`;
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = null;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}
}

const running: FakeModels[] = [];

/** Point the provider config at a fresh fake listing and return it. */
async function serve(body: unknown): Promise<FakeModels> {
	const s = new FakeModels(body);
	await s.start();
	running.push(s);
	setSetting('provider_base_url', s.baseUrl);
	setSetting('provider_api_key', '');
	setSetting('provider_oauth', '');
	return s;
}

afterEach(async () => {
	for (const s of running.splice(0)) await s.stop();
});

const LISTING = {
	data: [
		{
			id: 'opencode-go/deepseek-flash',
			pricing: {
				prompt: '0.0000000500',
				completion: '0.0000002000',
				input_cache_read: '0.0000000010'
			}
		},
		{ id: 'unpriced-model' },
		{ id: 'half-priced', pricing: { prompt: '0.000001' } }
	]
};

describe('model pricing from the provider listing', () => {
	it('prices a known model and computes a known cost', async () => {
		await serve(LISTING);
		const p = (await modelPricing()).get('opencode-go/deepseek-flash');
		expect(p).toEqual({ prompt: 5e-8, completion: 2e-7, cacheRead: 1e-9 });
		// 1M prompt tokens, 200k of them cache reads, and 500k replies:
		// 800k * 5e-8 + 200k * 1e-9 + 500k * 2e-7 = 0.1402.
		expect(costOf(p!, { input: 1_000_000, output: 500_000, cacheRead: 200_000 })).toBeCloseTo(
			0.1402,
			10
		);
	});

	it('has no price for a model the provider does not price', async () => {
		await serve(LISTING);
		const byId = await modelPricing();
		expect(byId.get('unpriced-model')).toBeUndefined();
		// A model priced on one side only is not half-priced; it is unpriced.
		expect(byId.get('half-priced')).toBeUndefined();
		expect(byId.get('not-listed-at-all')).toBeUndefined();
	});

	it('fetches the listing once and serves the rest from cache', async () => {
		const s = await serve(LISTING);
		await modelPricing();
		await modelPricing();
		expect(s.hits).toBe(1);
	});

	it('degrades to no prices when the endpoint is unreachable', async () => {
		// A port nothing listens on: the fetch rejects rather than answering.
		setSetting('provider_base_url', 'http://127.0.0.1:1/v1');
		setSetting('provider_api_key', '');
		setSetting('provider_oauth', '');
		await expect(modelPricing()).resolves.toEqual(new Map());
		expect((await modelPricing()).get('opencode-go/deepseek-flash')).toBeUndefined();
	});
});

describe('cost formatting and model resolution', () => {
	it('never rounds a real charge to zero', () => {
		expect(formatCost(0)).toBe('$0.00');
		expect(formatCost(0.1402)).toBe('$0.14');
		expect(formatCost(0.0042)).toBe('$0.0042');
		expect(formatCost(0.001)).toBe('$0.001');
		expect(formatCost(0.00001)).toBe('<$0.0001');
	});

	it('prices a bot against its own model, falling back to the default', () => {
		expect(resolveModel('bot-model', 'default-model')).toBe('bot-model');
		expect(resolveModel('', 'default-model')).toBe('default-model');
	});
});
