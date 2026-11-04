import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * Guardrails for the H4 dependency uplift: pinned overrides must stay in place
 * and npm audit must not regress on the packages we explicitly targeted.
 */
describe('dependency uplift (H4)', () => {
	const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
		devDependencies: Record<string, string>;
		overrides: Record<string, string>;
	};

	it('pins undici, cookie and deepmerge overrides', () => {
		expect(pkg.overrides.undici).toBe('$undici');
		expect(pkg.overrides.cookie).toBe('$cookie');
		expect(pkg.overrides.deepmerge).toBe('$deepmerge');
		expect(pkg.devDependencies.undici).toMatch(/^[\^~]?8\.12/);
		expect(pkg.devDependencies.cookie).toMatch(/^[\^~]?0\.7/);
	});

	it('resolves undici at or above 8.12.2 in the lockfile tree', () => {
		const out = execSync('npm ls undici --depth=10 2>/dev/null || true', {
			encoding: 'utf8'
		});
		const versions = [...out.matchAll(/undici@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
		expect(versions.length).toBeGreaterThan(0);
		for (const v of versions) {
			const [maj, min, patch] = v.split('.').map(Number);
			expect(maj).toBe(8);
			expect(min).toBeGreaterThanOrEqual(12);
			if (min === 12) expect(patch).toBeGreaterThanOrEqual(2);
		}
	});
});
