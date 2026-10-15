import { describe, expect, it, vi } from 'vitest';
import { complete } from './llm';
import { classifyInterruption } from './steering';

// The classifier is one cheap completion; the provider is not what is under
// test, the parsing and the failure default are.
vi.mock('./llm', () => ({ complete: vi.fn(async () => 'steer') }));
vi.mock('./police', () => ({
	policeModel: vi.fn(() => 'm1'),
	meterPoliceCall: vi.fn()
}));

describe('classifyInterruption', () => {
	it('steers when the model says the message belongs to the running task', async () => {
		vi.mocked(complete).mockResolvedValueOnce('steer');
		expect(await classifyInterruption('find the red file', 'actually the blue one')).toEqual({
			kind: 'steer',
			confident: true
		});
	});

	it('starts a new task when the model calls the message a separate ask', async () => {
		vi.mocked(complete).mockResolvedValueOnce('new');
		expect(await classifyInterruption('find the red file', 'also, what time is it?')).toEqual({
			kind: 'new',
			confident: true
		});
	});

	it('reads the verdict a reasoner puts after a lead-in', async () => {
		// A reasoning model can emit a word of its own before the verdict; the
		// first verdict token is the answer, not a failure.
		vi.mocked(complete).mockResolvedValueOnce('The message is a new ask.');
		expect(await classifyInterruption('find the red file', 'also, what time is it?')).toEqual({
			kind: 'new',
			confident: true
		});
	});

	// A reasoner spends its budget on hidden reasoning before the one-word
	// verdict: a cap sized for the word alone returns empty content and every
	// message is steered. The budget has to leave room for the reasoning.
	it('asks for enough tokens that a reasoning model can reach the verdict', async () => {
		await classifyInterruption('find the red file', 'wait');
		expect(vi.mocked(complete).mock.calls[0][2]?.maxTokens).toBeGreaterThanOrEqual(256);
	});

	// The default is still 'steer' - a turn in the same room reads the message
	// and decides for itself - but it is marked as a guess, because nothing may
	// be routed into another conversation on one.
	it('steers on any failure, and says the verdict is a guess', async () => {
		vi.mocked(complete).mockRejectedValueOnce(new Error('provider down'));
		expect(await classifyInterruption('find the red file', 'wait')).toEqual({
			kind: 'steer',
			confident: false
		});
		// An answer that never named a verdict is the same guess as an error.
		vi.mocked(complete).mockResolvedValueOnce('I think it depends');
		expect(await classifyInterruption('find the red file', 'wait')).toEqual({
			kind: 'steer',
			confident: false
		});
	});

	it('passes a bound on the provider call so a slow one cannot hold the send', async () => {
		vi.mocked(complete).mockResolvedValueOnce('steer');
		await classifyInterruption('find the red file', 'wait');
		const opts = vi.mocked(complete).mock.lastCall?.[2];
		// The route cannot wait out the provider's own ceiling; the signal is
		// what makes a stalled call fail into the safe default instead.
		expect(opts?.signal).toBeInstanceOf(AbortSignal);
	});
});
