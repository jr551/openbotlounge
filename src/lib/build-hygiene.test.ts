import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SvelteKit reserves every file under `src/routes` whose name starts with `+`,
 * and it refuses to build if one is not a file it knows. A test placed beside
 * its route (`+server.test.ts`) therefore passes `npm test` and breaks
 * `npm run build` - which is exactly what happened, leaving a stale image
 * running for several commits because the build failure was easy to miss.
 *
 * This is a cheap guard for that specific failure: no test file may live in the
 * routes tree, and every `+`-prefixed file must be one SvelteKit recognises.
 */

const ROUTES = join(process.cwd(), 'src', 'routes');

const ALLOWED = new Set([
	'+page.svelte',
	'+page.ts',
	'+page.js',
	'+page.server.ts',
	'+page.server.js',
	'+layout.svelte',
	'+layout.ts',
	'+layout.js',
	'+layout.server.ts',
	'+layout.server.js',
	'+server.ts',
	'+server.js',
	'+error.svelte',
	'+hooks.ts',
	'+hooks.js'
]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

describe('sveltekit route tree', () => {
	const files = walk(ROUTES).map((f) => f.slice(ROUTES.length + 1));

	it('ships no test files (they break the build)', () => {
		const strays = files.filter((f) => f.includes('.test.'));
		expect(strays, `move these out of src/routes: ${strays.join(', ')}`).toEqual([]);
	});

	it('uses only +names sveltekit recognises', () => {
		const reserved = files.filter((f) => {
			const name = f.split('/').pop() ?? '';
			return name.startsWith('+') && !ALLOWED.has(name);
		});
		expect(reserved, `unrecognised +files: ${reserved.join(', ')}`).toEqual([]);
	});
});
