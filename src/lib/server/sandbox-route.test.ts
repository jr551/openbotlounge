import { describe, expect, it, vi } from 'vitest';
import { createBot } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/bots/[id]/sandbox/+server';
// The mock factory above owns this module; importing it here hands back the
// mock's own fn, so a test can assert the route called it.
import { setHumanDriving } from '$lib/server/machine';

// Docker being unreachable must not look like a bug in the app.
vi.mock('$lib/server/machine', () => ({
	ensureDesktop: vi.fn(async () => {
		throw new Error("connect ENOENT /var/run/docker.sock\n    at PipeConnectWrap");
	}),
	sleepMachine: vi.fn(async () => {}),
	readPointer: vi.fn(async () => null),
	machineStatus: vi.fn(async () => ({ state: 'off' })),
	setHumanDriving: vi.fn(() => {})
}));

function bot() {
	return createBot({ name: 's', persona: '', avatar: '', color: '', model: '', badge: '' }).id;
}

function request(body: unknown) {
	return new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function status(fn: () => unknown): Promise<{ status: number; message: string }> {
	try {
		const res = (await fn()) as Response;
		return { status: res.status, message: '' };
	} catch (e) {
		const err = e as { status: number; body?: { message?: string } };
		return { status: err.status, message: err.body?.message ?? '' };
	}
}

describe('POST /api/bots/[id]/sandbox when Docker is down', () => {
	it('answers 503 with a readable reason instead of an opaque 500', async () => {
		const id = bot();
		const res = await status(() =>
			POST({ params: { id }, request: request({ action: 'wake' }) } as Parameters<typeof POST>[0])
		);
		expect(res.status).toBe(503);
		expect(res.message).toContain('Docker is not reachable');
		// the driver noise should not be the whole message
		expect(res.message.length).toBeLessThan(200);
	});

	it('rejects an action it does not know instead of answering status', async () => {
		const id = bot();
		const res = await status(() =>
			POST({ params: { id }, request: request({ action: 'bogus' }) } as Parameters<typeof POST>[0])
		);
		expect(res.status).toBe(400);
		expect(res.message).toContain('bogus');
	});

	it('rejects a non-string action', async () => {
		const id = bot();
		const res = await status(() =>
			POST({ params: { id }, request: request({ action: 42 }) } as Parameters<typeof POST>[0])
		);
		expect(res.status).toBe(400);
	});

	it('treats a missing action as a status request', async () => {
		const id = bot();
		const res = await status(() =>
			POST({ params: { id }, request: request({}) } as Parameters<typeof POST>[0])
		);
		expect(res.status).toBe(200);
	});

	it('records a control flip as state and answers 204 without Docker', async () => {
		vi.mocked(setHumanDriving).mockClear();
		const id = bot();
		const res = await status(() =>
			POST({
				params: { id },
				request: request({ action: 'control', driving: true })
			} as Parameters<typeof POST>[0])
		);
		expect(res.status).toBe(204);
		expect(vi.mocked(setHumanDriving)).toHaveBeenCalledWith(id, true);
	});

	it('refuses a control report that carries no boolean driving field', async () => {
		const id = bot();
		const res = await status(() =>
			POST({ params: { id }, request: request({ action: 'control' }) } as Parameters<typeof POST>[0])
		);
		expect(res.status).toBe(400);
		expect(res.message).toContain('driving');
	});
});
