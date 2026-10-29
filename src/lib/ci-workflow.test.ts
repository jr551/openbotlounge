import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Self-hosted runners must never execute fork PR workflows: untrusted code would
 * run on the operator's network with access to sibling job secrets.
 */
describe('github actions ci workflow', () => {
	const yaml = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

	it('skips self-hosted jobs for pull requests from forks', () => {
		const guard =
			"github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
		expect(yaml).toContain(guard);
		// Both jobs that touch the runner need the guard, not just verify.
		expect(yaml.match(new RegExp(guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBeGreaterThanOrEqual(
			2
		);
	});
});
