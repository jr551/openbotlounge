import { describe, expect, it } from 'vitest';
import { createBot, createConversation, createRoutine, deleteRoutine } from '$lib/server/db';
import { DELETE, GET, POST } from '../../routes/api/routines/[id]/webhook/+server';

// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.

const getCtx = (id: string) => ({ params: { id } }) as Parameters<typeof GET>[0];
const postCtx = (id: string) => ({ params: { id } }) as Parameters<typeof POST>[0];
const delCtx = (id: string) => ({ params: { id } }) as Parameters<typeof DELETE>[0];

async function statusOf(call: () => Response | Promise<Response>): Promise<number> {
	try {
		return (await call()).status;
	} catch (e) {
		return (e as { status?: number }).status ?? 500;
	}
}

describe('routine webhooks', () => {
	function makeRoutine() {
		const bot = createBot({ name: 'HookRoutineBot', persona: '', avatar: '🤖', color: '#fff', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		return createRoutine({
			bot_id: bot.id,
			conversation_id: conv.id,
			name: 'Nightly check',
			prompt: 'check the thing',
			interval_min: 60,
			cron: '',
			enabled: 1
		});
	}

	it('creates, reads and revokes a routine webhook', async () => {
		const routine = makeRoutine();
		expect(await (await GET(getCtx(routine.id))).json()).toEqual({ webhook: null });

		const created = await POST(postCtx(routine.id));
		expect(created.status).toBe(201);
		const first = (await created.json()) as { id: string; url: string };
		expect(first.url).toMatch(/^\/api\/hooks\//);

		// Creating again returns the same hook rather than stacking a second.
		const again = await POST(postCtx(routine.id));
		expect(((await again.json()) as { id: string }).id).toBe(first.id);

		const seen = (await (await GET(getCtx(routine.id))).json()) as unknown as { webhook: { url: string } | null };
		expect(seen.webhook?.url).toBe(first.url);

		expect(await statusOf(() => DELETE(delCtx(routine.id)))).toBe(204);
		expect(await (await GET(getCtx(routine.id))).json()).toEqual({ webhook: null });

		deleteRoutine(routine.id);
	});

	it('404s unknown routines and missing hooks', async () => {
		expect(await statusOf(() => GET(getCtx('no-such-routine')))).toBe(404);
		expect(await statusOf(() => POST(postCtx('no-such-routine')))).toBe(404);

		const routine = makeRoutine();
		expect(await statusOf(() => DELETE(delCtx(routine.id)))).toBe(404);
		deleteRoutine(routine.id);
	});
});
