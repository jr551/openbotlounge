import { describe, expect, it, vi } from 'vitest';
import { listSettings } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/settings/+server';
import { checkVision } from '$lib/server/capability';

// The image check is a provider call. What is under test is the gate's own
// decision - stored on a pass, refused on anything else - not the probe.
vi.mock('$lib/server/capability', () => ({
	checkVision: vi.fn(async () => ({ pass: true, detail: 'Red' }))
}));

function request(body: unknown) {
	return new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function status(fn: () => unknown): Promise<number> {
	try {
		return ((await fn()) as Response).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

describe('POST /api/settings acknowledge_recovery', () => {
	it('rejects a truthy value that is not a boolean', async () => {
		// Whatever a sibling test left behind, a refused write must not move it.
		const seen = listSettings().db_recovery_seen;
		for (const value of ['yes', 1, 'true']) {
			expect(await status(() => POST({ request: request({ acknowledge_recovery: value }) } as Parameters<typeof POST>[0]))).toBe(400);
		}
		expect(listSettings().db_recovery_seen).toBe(seen);
	});

	it('marks the recovery seen only for a real true', async () => {
		expect(
			await status(() => POST({ request: request({ acknowledge_recovery: true }) } as Parameters<typeof POST>[0]))
		).toBe(200);
		expect(listSettings().db_recovery_seen).toBe('1');
	});
});

describe('POST /api/settings provider key', () => {
	// The write response used to echo listSettings() raw, which carries the
	// provider key in plaintext - a save the UI made to change the model handed
	// the key back to the page. The GET redacts it; the POST must too.
	it('never returns the stored provider key', async () => {
		const res = await POST({
			request: request({ provider_base_url: 'http://example.test/v1', provider_api_key: 'sk-soak-secret' })
		} as Parameters<typeof POST>[0]);
		const body = (await res.json()) as { settings: Record<string, string> };
		expect(body.settings.provider_api_key).toBe('');
		expect(listSettings().provider_api_key).toBe('sk-soak-secret');
	});
});

describe('POST /api/settings provider_base_url', () => {
	// Every provider call dials this value, so a scheme fetch cannot reach -
	// or a URL pointing back at this app - must be refused, not saved in.
	it('rejects a non-http(s) scheme', async () => {
		expect(
			await status(() => POST({ request: request({ provider_base_url: 'ftp://evil' }) } as Parameters<typeof POST>[0]))
		).toBe(400);
	});

	it('rejects a URL that points back at this server', async () => {
		const req = new Request('http://test/api/settings', {
			method: 'POST',
			headers: { 'content-type': 'application/json', host: '192.168.1.95:3000' },
			body: JSON.stringify({ provider_base_url: 'http://192.168.1.95:3000' })
		});
		expect(await status(() => POST({ request: req } as Parameters<typeof POST>[0]))).toBe(400);
	});

	it('accepts a real https endpoint and strips trailing slashes', async () => {
		const res = await POST({
			request: request({ provider_base_url: 'https://api.example.test/v1///' })
		} as Parameters<typeof POST>[0]);
		expect(res.status).toBe(200);
		expect(listSettings().provider_base_url).toBe('https://api.example.test/v1');
	});
});

describe('POST /api/settings exa key', () => {
	// Same rule as the provider key: the write response echoes listSettings(),
	// so the Exa key must be blanked there rather than handed back to the page.
	it('stores exa_api_key and never returns it', async () => {
		const res = await POST({
			request: request({ exa_api_key: 'exa-soak-secret' })
		} as Parameters<typeof POST>[0]);
		const body = (await res.json()) as { settings: Record<string, string> };
		expect(body.settings.exa_api_key).toBe('');
		expect(listSettings().exa_api_key).toBe('exa-soak-secret');
	});
});

describe('POST /api/settings police gates', () => {
	/**
	 * The two creation gates, written the way the console writes them. The value
	 * in force is the one the gates read - a console toggle that stored the
	 * wrong string would leave a gate stuck where it started.
	 */
	it('stores each creation gate from the console, and reads either on or off', async () => {
		await POST({
			request: request({ police_check_plugins: 'off', police_check_routines: 'on' })
		} as Parameters<typeof POST>[0]);
		expect(listSettings().police_check_plugins).toBe('off');
		expect(listSettings().police_check_routines).toBe('on');

		// Back to the shipped state: the gates read as on when the row is absent,
		// so leaving 'off' behind would shut a gate every later test inherits.
		await POST({
			request: request({ police_check_plugins: 'on' })
		} as Parameters<typeof POST>[0]);
	});

	it('ignores a gate value that is neither on nor off', async () => {
		await POST({
			request: request({ police_check_plugins: 'off' })
		} as Parameters<typeof POST>[0]);
		await POST({
			request: request({ police_check_plugins: 'maybe' })
		} as Parameters<typeof POST>[0]);
		// A refused write must not move the gate, in either direction.
		expect(listSettings().police_check_plugins).toBe('off');
		await POST({
			request: request({ police_check_plugins: 'on' })
		} as Parameters<typeof POST>[0]);
	});

	/**
	 * The console's Jailing select. The read side and the form both existed from
	 * the start, but no route ever stored the value, so the select saved nothing.
	 */
	it('stores how a proposed jail lands', async () => {
		await POST({
			request: request({ police_jail_mode: 'on' })
		} as Parameters<typeof POST>[0]);
		expect(listSettings().police_jail_mode).toBe('on');

		// A value the officer cannot act on is refused, and the stored one stands.
		await POST({
			request: request({ police_jail_mode: 'sometimes' })
		} as Parameters<typeof POST>[0]);
		expect(listSettings().police_jail_mode).toBe('on');

		await POST({
			request: request({ police_jail_mode: 'confirm' })
		} as Parameters<typeof POST>[0]);
		expect(listSettings().police_jail_mode).toBe('confirm');
	});
});

describe('POST /api/settings vision model', () => {
	/**
	 * The one setting that is a claim about a model rather than a preference, so
	 * it is only stored once the model has answered an image: a pick with a
	 * likely name but no eyes must not be readable as a stored value.
	 */
	it('stores the pick once it has answered an image, and hands the answer back', async () => {
		vi.mocked(checkVision).mockResolvedValueOnce({ pass: true, detail: 'Red' });
		const res = await POST({
			request: request({ vision_model: 'sees-things' })
		} as Parameters<typeof POST>[0]);
		expect(res.status).toBe(200);
		expect(listSettings().vision_model).toBe('sees-things');
		// The picker shows the check's own words as the confirmation, so the
		// route answers with them rather than making the page probe again.
		const body = (await res.json()) as { vision: { model: string; detail: string } };
		expect(body.vision).toEqual({ model: 'sees-things', detail: 'Red' });
	});

	it('refuses a model that cannot see, leaving the stored one alone', async () => {
		vi.mocked(checkVision).mockResolvedValueOnce({ pass: true, detail: 'Red' });
		await POST({
			request: request({ vision_model: 'kept-model' })
		} as Parameters<typeof POST>[0]);

		vi.mocked(checkVision).mockResolvedValueOnce({
			pass: false,
			detail: 'provider rejected image input'
		});
		await expect(
			POST({ request: request({ vision_model: 'blind-model' }) } as Parameters<typeof POST>[0])
		).rejects.toMatchObject({
			status: 400,
			body: { message: expect.stringContaining('provider rejected image input') }
		});
		// The refusal's own words reach the caller and nothing was written.
		expect(listSettings().vision_model).toBe('kept-model');
	});

	it('clears the setting on an empty pick, without spending a probe', async () => {
		vi.mocked(checkVision).mockResolvedValueOnce({ pass: true, detail: 'Red' });
		await POST({
			request: request({ vision_model: 'clear-me' })
		} as Parameters<typeof POST>[0]);
		vi.mocked(checkVision).mockClear();

		const res = await POST({
			request: request({ vision_model: '' })
		} as Parameters<typeof POST>[0]);
		expect(res.status).toBe(200);
		// Nothing to prove about nobody: the police model looks again.
		expect(listSettings().vision_model).toBe('');
		expect(vi.mocked(checkVision)).not.toHaveBeenCalled();
	});

	it('does not probe for a save that is not about the vision model', async () => {
		vi.mocked(checkVision).mockClear();
		await POST({ request: request({ theme: 'mono' }) } as Parameters<typeof POST>[0]);
		expect(vi.mocked(checkVision)).not.toHaveBeenCalled();
	});
});
