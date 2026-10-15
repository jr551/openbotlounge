import { describe, expect, it, vi } from 'vitest';
import { createBot } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { GET, POST } from '../../routes/api/bots/[id]/shellbox/+server';

// Docker being unreachable must not look like a bug in the app: the keystroke
// path used to let the driver error escape as an opaque 500, and so did the
// screen capture.
vi.mock('$lib/server/machine', () => ({
	ensureMachine: vi.fn(async () => {
		throw new Error('Docker start failed 404');
	}),
	machineExec: vi.fn(async () => {
		throw new Error('Docker start failed 404');
	}),
	machineStatus: vi.fn(async () => ({ state: 'running' })),
	shellScreen: vi.fn(async () => {
		throw new Error('docker socket timed out');
	})
}));

function bot() {
	return createBot({ name: 'shell', persona: '', avatar: '', color: '', model: '', badge: '' }).id;
}

async function post(id: string, body: unknown): Promise<{ status: number; message: string }> {
	const request = new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	try {
		const res = await POST({ params: { id }, request } as Parameters<typeof POST>[0]);
		return { status: res.status, message: '' };
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') {
			const payload = 'body' in e ? e.body : undefined;
			const message =
				payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
					? payload.message
					: '';
			return { status: e.status, message };
		}
		throw e;
	}
}

describe('POST /api/bots/[id]/shellbox when Docker is down', () => {
	it('answers 503 for a keystroke instead of an opaque 500', async () => {
		const refused = await post(bot(), { action: 'type', data: 'ls\n' });
		expect(refused.status).toBe(503);
		expect(refused.message).toContain('keystroke');
	});

	it('still refuses an empty keystroke before touching Docker', async () => {
		const refused = await post(bot(), { action: 'type', data: '' });
		expect(refused.status).toBe(400);
	});
});

describe('GET /api/bots/[id]/shellbox when the capture fails', () => {
	it('degrades to an empty screen instead of an opaque 500', async () => {
		const res = await GET({
			params: { id: bot() },
			url: new URL('http://test/')
		} as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ state: 'running', screen: '' });
	});
});
