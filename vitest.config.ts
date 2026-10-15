import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// svelte() compiles the runes in *.svelte.ts modules (the chat store) so they
	// can be imported in tests; the alias mirrors SvelteKit's $lib.
	plugins: [svelte()],
	resolve: {
		alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
	},
	test: {
		environment: 'node',
		// One worker; per-file isolation so vi.mock in one file doesn't leak into another.
		fileParallelism: false,
		// Runs per test file, before that file's imports, and gives each file its
		// own DATA_DIR. See the file for why the `env` block that used to be here
		// was not enough.
		setupFiles: ['src/test-setup.ts']
	}
});
