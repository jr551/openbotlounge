import { describe, expect, it } from 'vitest';
import { addPoliceRule, deletePoliceRule, listPoliceRules, MAX_POLICE_RULES } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST } from '../../routes/api/police/rules/+server';

/**
 * The status a request answered with and the message a refusal carried.
 * SvelteKit's error() throws an HttpError (not an Error), so the body is
 * narrowed by shape rather than trusted through a cast.
 */
async function post(body: unknown): Promise<{ status: number; message: string }> {
	const request = new Request('http://test/api/police/rules', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	try {
		const res = await POST({ request } as Parameters<typeof POST>[0]);
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

describe('POST /api/police/rules', () => {
	it('refuses a rule once the book is full', async () => {
		for (let i = 0; i < MAX_POLICE_RULES; i++) addPoliceRule(`r${i}`, `p${i}`, '');
		expect(listPoliceRules()).toHaveLength(MAX_POLICE_RULES);

		const refused = await post({ name: 'one more', pattern: 'x', summary: '' });
		expect(refused.status).toBe(409);
		expect(refused.message).toContain(String(MAX_POLICE_RULES));
		expect(listPoliceRules()).toHaveLength(MAX_POLICE_RULES);
	});

	it('still refuses a pattern that cannot compile', async () => {
		// The book is shared across this file's tests; start it empty so the cap
		// does not answer before the pattern check does.
		for (const r of listPoliceRules()) deletePoliceRule(r.id);
		const refused = await post({ name: 'bad', pattern: '([', summary: '' });
		expect(refused.status).toBe(400);
	});
});
