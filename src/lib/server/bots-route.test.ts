import { describe, expect, it, vi } from 'vitest';
import { createBot, getBot, listBots, updateBot } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { GET as botsGET, POST } from '../../routes/api/bots/+server';
import { PATCH } from '../../routes/api/bots/[id]/+server';
import { GET as PRESENCE } from '../../routes/api/bots/presence/+server';
import { presenceForBots } from '$lib/server/machine';
import { listModels } from '$lib/server/llm';

// The model check asks the provider's endpoint what it serves; the test
// endpoint is a fixed list.
vi.mock('$lib/server/llm', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/llm')>();
	return { ...real, listModels: vi.fn(async () => ['good-model', 'other-model']) };
});

vi.mock('$lib/server/machine', () => ({
	destroyMachine: vi.fn(async () => {}),
	presenceForBots: vi.fn(async (ids: string[]) => ({}))
}));

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

function makeBot(name: string) {
	return createBot({ name, persona: '', avatar: '', color: '', model: '', badge: '' });
}

describe('POST /api/bots model validation', () => {
	it('refuses a model the provider does not serve, creating nothing', async () => {
		const res = await status(() =>
			POST({ request: request({ name: 'Newbie', model: 'not-a-model' }) } as Parameters<typeof POST>[0])
		);
		expect(res.status).toBe(400);
		expect(res.message).toContain('not-a-model');
		expect(listBots().some((b) => b.name === 'Newbie')).toBe(false);
	});

	it('accepts a served model and an empty one', async () => {
		const named = await status(() =>
			POST({ request: request({ name: 'Picked', model: 'good-model' }) } as Parameters<typeof POST>[0])
		);
		expect(named.status).toBe(201);
		const blank = await status(() =>
			POST({ request: request({ name: 'Defaulted' }) } as Parameters<typeof POST>[0])
		);
		expect(blank.status).toBe(201);
	});
});

describe('POST /api/bots concurrent creates', () => {
	// The name check runs once before the provider round-trip and again on the
	// spot: a create that waited out a slow provider must not land a second
	// bot on a name another request took while it waited.
	it('refuses the second create when the name was taken mid-flight', async () => {
		const { promise: slow, resolve: answer } = Promise.withResolvers<string[]>();
		// Flag-gated, not Once: a background turn's own model lookup must not
		// steal the parked answer meant for this request.
		let parked = true;
		vi.mocked(listModels).mockImplementation(() =>
			parked ? slow : Promise.resolve(['good-model', 'other-model'])
		);
		try {
			const first = status(() =>
				POST({ request: request({ name: 'Twin', model: 'good-model' }) } as Parameters<typeof POST>[0])
			);
			// The first create is parked on the provider; a second one lands the name.
			makeBot('Twin');
			answer(['good-model']);

			const res = await first;
			expect(res.status).toBe(409);
			expect(listBots().filter((b) => b.name === 'Twin')).toHaveLength(1);
		} finally {
			parked = false;
			vi.mocked(listModels).mockResolvedValue(['good-model', 'other-model']);
		}
	});

	it('fails fast with a clear error when the provider cannot be reached', async () => {
		// Persistent, not Once: the create above fired a background task whose
		// own model lookups must not eat the refusal meant for this request.
		vi.mocked(listModels).mockRejectedValue(new Error('aborted'));
		try {
			const res = await status(() =>
				POST({ request: request({ name: 'Unverifiable', model: 'good-model' }) } as Parameters<typeof POST>[0])
			);
			expect(res.status).toBe(503);
			expect(listBots().some((b) => b.name === 'Unverifiable')).toBe(false);
		} finally {
			vi.mocked(listModels).mockResolvedValue(['good-model', 'other-model']);
		}
	});
});

describe('PATCH /api/bots/[id] hat', () => {
	function patch(id: string, body: unknown) {
		return PATCH({ params: { id }, request: request(body) } as Parameters<typeof PATCH>[0]);
	}

	it('refuses a hat the library does not carry instead of clearing it', async () => {
		const bot = makeBot('Hatted');
		updateBot(bot.id, { hat: 'wizard' });
		const res = await status(() => patch(bot.id, { hat: 'sombrero' }));
		expect(res.status).toBe(400);
		expect(getBot(bot.id)?.hat).toBe('wizard');
	});

	it('still takes a real hat and a bare head', async () => {
		const bot = makeBot('Hatter');
		expect((await status(() => patch(bot.id, { hat: 'crown' }))).status).toBe(200);
		expect(getBot(bot.id)?.hat).toBe('crown');
		expect((await status(() => patch(bot.id, { hat: '' }))).status).toBe(200);
		expect(getBot(bot.id)?.hat).toBe('');
	});
});

describe('PATCH /api/bots/[id] model validation', () => {
	function patch(id: string, body: unknown) {
		return PATCH({ params: { id }, request: request(body) } as Parameters<typeof PATCH>[0]);
	}

	it('refuses a model the provider does not serve, storing nothing', async () => {
		const bot = makeBot('Keeper');
		const res = await status(() => patch(bot.id, { model: 'not-a-model' }));
		expect(res.status).toBe(400);
		expect(res.message).toContain('not-a-model');
		expect(getBot(bot.id)?.model).toBe('');
	});

	it('stores a model the provider serves', async () => {
		const bot = makeBot('Switcher');
		const res = await status(() => patch(bot.id, { model: 'other-model' }));
		expect(res.status).toBe(200);
		expect(getBot(bot.id)?.model).toBe('other-model');
	});

	it('still lets a bot be returned to the provider default', async () => {
		const bot = makeBot('Resetter');
		await status(() => patch(bot.id, { model: 'good-model' }));
		const res = await status(() => patch(bot.id, { model: '' }));
		expect(res.status).toBe(200);
		expect(getBot(bot.id)?.model).toBe('');
	});
});

describe('PATCH /api/bots/[id] archived flag', () => {
	function patch(id: string, body: unknown) {
		return PATCH({ params: { id }, request: request(body) } as Parameters<typeof PATCH>[0]);
	}

	it('rejects a non-boolean archived instead of treating it as truthy', async () => {
		const bot = makeBot('Truthy');
		const res = await status(() => patch(bot.id, { archived: 'yes' }));
		expect(res.status).toBe(400);
		expect(getBot(bot.id)?.archived).toBe(0);
	});

	it('archives on true and restores on false', async () => {
		const bot = makeBot('Coldstore');
		expect((await status(() => patch(bot.id, { archived: true }))).status).toBe(200);
		expect(getBot(bot.id)?.archived).toBe(1);
		expect((await status(() => patch(bot.id, { archived: false }))).status).toBe(200);
		expect(getBot(bot.id)?.archived).toBe(0);
	});
});

describe('PATCH /api/bots/[id] nix_enabled flag', () => {
	function patch(id: string, body: unknown) {
		return PATCH({ params: { id }, request: request(body) } as Parameters<typeof PATCH>[0]);
	}

	it('starts off and switches on and back off', async () => {
		const bot = makeBot('Nixless');
		// The default is off: a bot gets a package manager only when the human
		// asks for one.
		expect(getBot(bot.id)?.nix_enabled).toBe(0);
		expect((await status(() => patch(bot.id, { nix_enabled: true }))).status).toBe(200);
		expect(getBot(bot.id)?.nix_enabled).toBe(1);
		expect((await status(() => patch(bot.id, { nix_enabled: false }))).status).toBe(200);
		expect(getBot(bot.id)?.nix_enabled).toBe(0);
	});
});
describe('the bots API speaks booleans', () => {
	it('answers with true/false, not 1/0, and round-trips a PATCH', async () => {
		const bot = makeBot('Wire');
		const list = async () => {
			const res = (await botsGET({} as Parameters<typeof botsGET>[0])) as Response;
			return ((await res.json()) as { bots: { id: string; nix_enabled: unknown; archived: unknown }[] }).bots;
		};

		const off = (await list()).find((b) => b.id === bot.id)!;
		expect(off.nix_enabled).toBe(false);
		expect(off.archived).toBe(false);

		const res = (await PATCH({
			params: { id: bot.id },
			request: request({ nix_enabled: true })
		} as Parameters<typeof PATCH>[0])) as Response;
		const saved = (await res.json()) as { nix_enabled: unknown };
		expect(saved.nix_enabled).toBe(true);

		const on = (await list()).find((b) => b.id === bot.id)!;
		expect(on.nix_enabled).toBe(true);
	});
});


describe('GET /api/bots/presence', () => {
	it('says archived from the row itself, without asking Docker', async () => {
		const live = makeBot('LiveDot');
		const gone = makeBot('GoneDot');
		updateBot(gone.id, { archived: 1 });
		vi.mocked(presenceForBots).mockResolvedValue({ [live.id]: 'running', [gone.id]: 'sleeping' });

		const res = (await PRESENCE({} as Parameters<typeof PRESENCE>[0])) as Response;
		const data = (await res.json()) as { presence: Record<string, string> };

		expect(data.presence[live.id]).toBe('running');
		// A machine that happens to be stopped is not what an archived bot is:
		// the row outranks Docker, so the header can say cold storage.
		expect(data.presence[gone.id]).toBe('archived');
	});
});
