import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guardrails for the H4 dependency uplift: the pinned overrides must stay in
 * place, and the lockfile must keep resolving the targeted packages at or
 * above the floors their advisories were fixed in. Reads the lockfile
 * directly - no npm subprocess - so the guard is fast and cannot flake on a
 * cold cache.
 */
describe('dependency uplift (H4)', () => {
	const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
		devDependencies: Record<string, string>;
		overrides: Record<string, string>;
	};
	const lock = JSON.parse(
		readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')
	) as { packages: Record<string, { version?: string }> };

	const resolved = (name: string): string[] =>
		Object.entries(lock.packages)
			.filter(([path]) => path.endsWith(`node_modules/${name}`))
			.map(([, entry]) => entry.version ?? '')
			.filter(Boolean);

	const atLeast = (version: string, floor: [number, number, number]): boolean => {
		const parts = version.split('.').map(Number);
		for (let i = 0; i < 3; i++) {
			if ((parts[i] ?? 0) !== floor[i]) return (parts[i] ?? 0) > floor[i];
		}
		return true;
	};

	it('pins undici, cookie and deepmerge overrides', () => {
		expect(pkg.overrides.undici).toBe('$undici');
		expect(pkg.overrides.cookie).toBe('$cookie');
		expect(pkg.overrides.deepmerge).toBe('$deepmerge');
		expect(pkg.devDependencies.undici).toBeTruthy();
		expect(pkg.devDependencies.cookie).toBeTruthy();
		expect(pkg.devDependencies.deepmerge).toBeTruthy();
	});

	it('resolves undici and cookie at or above their fixed floors', () => {
		const undici = resolved('undici');
		expect(undici.length).toBeGreaterThan(0);
		for (const v of undici) expect(atLeast(v, [8, 12, 2])).toBe(true);

		const cookie = resolved('cookie');
		expect(cookie.length).toBeGreaterThan(0);
		for (const v of cookie) expect(atLeast(v, [0, 7, 0])).toBe(true);
	});
});
