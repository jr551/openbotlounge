import { describe, expect, it, vi } from 'vitest';
import { createBot } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST as review } from '../../routes/api/plugins/[id]/review/+server';
import {
	createPlugin,
	getPlugin,
	runPluginTests,
	selfTestPlugin,
	setPluginVerification
} from '$lib/server/plugins';
import type * as Plugins from '$lib/server/plugins';
import { reviewPlugin } from '$lib/server/police';

// The police gate is a model call; the tests stand in for it. The point under
// test is what the route does with the verdict, not the officer's judgement.
vi.mock('$lib/server/police', () => ({
	policeModel: vi.fn(() => 'm1'),
	reviewPlugin: vi.fn(async () => ({ verdict: 'approved', reason: 'the code does what it says' })),
	verdictJson: vi.fn((v: { verdict: string; reason: string }) => JSON.stringify(v)),
	// The attempt counter is the author's resubmit loop, which this route does
	// not drive: passing the verdict through keeps what the officer said.
	applyAttempt: vi.fn((v: unknown) => v),
	POLICE_MAX_ATTEMPTS: 3
}));

// The sandbox runs are container round-trips the tests have no docker for.
vi.mock('$lib/server/plugins', async (importOriginal) => ({
	...(await importOriginal<typeof Plugins>()),
	selfTestPlugin: vi.fn(async () => ({ ok: true, output: 'self-test ok' })),
	runPluginTests: vi.fn(async () => [])
}));

let seq = 0;

function owner() {
	return createBot({
		name: `review-route-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

/**
 * A plugin on the row. No author means a shared one, which is how the route
 * meets a plugin with no machine to run a self-test in; `verdict`, when given,
 * is what the police have already left on it.
 */
function makePlugin(
	opts: { verdict?: Record<string, unknown>; author?: string; enabled?: number } = {}
) {
	const plugin = createPlugin({
		name: `Plugin ${++seq}`,
		description: '',
		kind: 'tool',
		hook_point: '',
		parameters: '{}',
		code: 'return "ok";',
		icon_svg: '',
		author_bot_id: opts.author ?? '',
		scope: opts.author ? 'bot' : 'shared',
		enabled: opts.enabled ?? 1
	});
	if (opts.verdict) setPluginVerification(plugin.id, JSON.stringify({ at: 1, ...opts.verdict }));
	return plugin;
}

/** A refusal as the officer leaves one: the reason, the attempts, the question. */
function refusedVerdict(): Record<string, unknown> {
	return {
		verdict: 'rejected',
		reason: 'the code is a stub that returns a fixed string',
		attempts: 3,
		awaitingHuman: true
	};
}

/** A POST to the review route, as the card's chip sends it. */
function send(id: string) {
	return review({ params: { id } } as Parameters<typeof review>[0]);
}

/**
 * The status and message a call answered with. SvelteKit's error() throws an
 * HttpError rather than an Error, so the body is narrowed by shape instead of
 * trusted through a cast.
 */
async function refusal(fn: () => unknown): Promise<{ status: number; message: string }> {
	try {
		const res = (await fn()) as Response;
		return { status: res.status, message: '' };
	} catch (e) {
		const err = e as { status?: number; body?: { message?: string } };
		return { status: err.status ?? 0, message: err.body?.message ?? '' };
	}
}

describe('the on-demand review of an unreviewed plugin', () => {
	it('runs the officer over it and stores the verdict on the row', async () => {
		const plugin = makePlugin({ author: owner().id });
		expect(plugin.verification).toBe('');
		const res = await send(plugin.id);
		expect(res.status).toBe(200);
		// The officer judged the code the row carries, and what they said is
		// what the row now says.
		expect(vi.mocked(reviewPlugin)).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'return "ok";' })
		);
		const stored = getPlugin(plugin.id)!;
		expect(JSON.parse(stored.verification).verdict).toBe('approved');
	});

	it('switches the plugin off when the officer refuses it', async () => {
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'rejected',
			reason: 'the code is a stub that returns a fixed string'
		});
		const plugin = makePlugin({ author: owner().id, enabled: 1 });
		const res = await send(plugin.id);
		expect(res.status).toBe(200);
		const stored = getPlugin(plugin.id)!;
		expect(JSON.parse(stored.verification).verdict).toBe('rejected');
		// Refused code does not keep running because the human asked for the
		// review rather than the author.
		expect(stored.enabled).toBe(0);
	});

	it('reviews a shared plugin with no author machine instead of failing on the missing bot', async () => {
		vi.mocked(selfTestPlugin).mockClear();
		vi.mocked(runPluginTests).mockClear();
		const plugin = makePlugin();
		const res = await send(plugin.id);
		expect(res.status).toBe(200);
		// Nothing to run the code in, so the officer judges the source alone -
		// the same stance the create route takes on a shared plugin.
		expect(vi.mocked(selfTestPlugin)).not.toHaveBeenCalled();
		expect(vi.mocked(runPluginTests)).not.toHaveBeenCalled();
		expect(JSON.parse(getPlugin(plugin.id)!.verification).verdict).toBe('approved');
	});

	it('answers 404 for a plugin that is not there', async () => {
		await expect(send('no-such-plugin')).rejects.toMatchObject({ status: 404 });
	});
});

describe('a review the officer cannot answer', () => {
	/**
	 * The state that most needs asking again: the officer was never reached, so
	 * the row is unsigned and off. Asking again while they are still down must
	 * leave it exactly there - never switched on by a review that did not run.
	 */
	it('leaves an unverified plugin unverified and off', async () => {
		vi.mocked(reviewPlugin).mockResolvedValueOnce({
			verdict: 'unreviewed',
			reason: 'the police could not be reached (provider down)'
		});
		const plugin = makePlugin({
			author: owner().id,
			enabled: 0,
			verdict: { verdict: 'unreviewed', reason: 'the police could not be reached' }
		});

		const res = await send(plugin.id);
		expect(res.status).toBe(200);
		const stored = getPlugin(plugin.id)!;
		expect(JSON.parse(stored.verification).verdict).toBe('unreviewed');
		expect(stored.enabled).toBe(0);
	});
});

describe('a plugin the police have already ruled on', () => {
	/**
	 * The route is the action for a plugin with no ruling on it. Re-running the
	 * officer over a decided one used to flip its switch on the way past: an
	 * approval switched on a plugin the human had turned off, and a refusal
	 * switched off a plugin the human was running.
	 */
	it('refuses the review instead of flipping the switch it inherited', async () => {
		vi.mocked(reviewPlugin).mockClear();
		const approved = makePlugin({
			author: owner().id,
			enabled: 0,
			verdict: { verdict: 'approved', reason: 'the code does what it says' }
		});
		const approvedRes = await refusal(() => send(approved.id));
		expect(approvedRes.status).toBe(409);
		expect(getPlugin(approved.id)!.enabled).toBe(0);

		const refused = makePlugin({ author: owner().id, enabled: 1, verdict: refusedVerdict() });
		const refusedRes = await refusal(() => send(refused.id));
		expect(refusedRes.status).toBe(409);
		expect(refusedRes.message).toContain('approve');
		expect(getPlugin(refused.id)!.enabled).toBe(1);
		// Nothing was sent to the officer for either of them.
		expect(vi.mocked(reviewPlugin)).not.toHaveBeenCalled();
	});
});
