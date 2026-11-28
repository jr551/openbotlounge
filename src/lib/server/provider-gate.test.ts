import { describe, expect, it } from 'vitest';
import { ProviderGate } from './provider-gate';

describe('ProviderGate', () => {
	it('queues callers above the limit and releases them in order', async () => {
		const gate = new ProviderGate(1);
		const first = await gate.acquire();
		let secondReleased = false;
		const second = gate.acquire().then((release) => {
			secondReleased = true;
			return release;
		});
		let thirdReleased = false;
		const third = gate.acquire().then((release) => {
			thirdReleased = true;
			return release;
		});

		await Promise.resolve();
		expect(secondReleased).toBe(false);
		expect(thirdReleased).toBe(false);
		first();
		const releaseSecond = await second;
		expect(secondReleased).toBe(true);
		expect(thirdReleased).toBe(false);
		releaseSecond();
		const releaseThird = await third;
		expect(thirdReleased).toBe(true);
		releaseThird();
	});

	it('removes an aborted waiter and gives its slot to the next caller', async () => {
		const gate = new ProviderGate(1);
		const first = await gate.acquire();
		const controller = new AbortController();
		const aborted = gate.acquire(controller.signal);
		const next = gate.acquire();
		controller.abort(new Error('caller left'));
		await expect(aborted).rejects.toThrow('caller left');

		first();
		const release = await next;
		release();
	});

	it('makes release idempotent so one caller cannot free two slots', async () => {
		const gate = new ProviderGate(1);
		const first = await gate.acquire();
		const second = gate.acquire();
		first();
		first();
		const releaseSecond = await second;
		let thirdReleased = false;
		const third = gate.acquire().then((release) => {
			thirdReleased = true;
			return release;
		});
		await Promise.resolve();
		expect(thirdReleased).toBe(false);
		releaseSecond();
		const releaseThird = await third;
		releaseThird();
	});

	it('rejects invalid limits', () => {
		expect(() => new ProviderGate(0)).toThrow(/positive integer/);
		expect(() => new ProviderGate(1.5)).toThrow(/positive integer/);
	});
});
