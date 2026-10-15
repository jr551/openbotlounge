import { describe, expect, it, vi } from 'vitest';
import { createBot, createMachineResetRequest, getMachineReset } from '$lib/server/db';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { POST as approve } from '../../routes/api/police/resets/[id]/approve/+server';
import { POST as deny } from '../../routes/api/police/resets/[id]/deny/+server';
import { resetMachineKeepDocs } from '$lib/server/machine';

// The wipe needs Docker; the race is about the claim in front of it, so the
// wipe is a spy that never touches a container.
vi.mock('$lib/server/machine', () => ({
	resetMachineKeepDocs: vi.fn(async () => ({ kept: [] }))
}));

function bot() {
	return createBot({ name: 'reset-racer', persona: '', avatar: '', color: '', model: '', badge: '' }).id;
}

describe('a machine reset answered twice', () => {
	// Both answers used to read the pending row before either resolved it, so an
	// approve racing a deny could run the wipe and then record the denial. The
	// conditional UPDATE is now the lock: only one answer wins.
	it('lets only one of a racing approve and deny decide it', async () => {
		const req = createMachineResetRequest(bot(), 'please');
		const results = await Promise.allSettled([
			approve({ params: { id: req.id } } as never),
			deny({ params: { id: req.id } } as never)
		]);

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
		expect(loser.reason).toMatchObject({ status: 409 });
		expect(getMachineReset(req.id)?.resolved_at).toBeGreaterThan(0);
	});

	it('runs the wipe once when two approvals race', async () => {
		const req = createMachineResetRequest(bot(), 'please');
		const results = await Promise.allSettled([
			approve({ params: { id: req.id } } as never),
			approve({ params: { id: req.id } } as never)
		]);

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
		expect(resetMachineKeepDocs).toHaveBeenCalledTimes(1);
	});
});
