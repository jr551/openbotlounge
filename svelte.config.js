import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// BUILD_OUT lets the deploy script build into a versioned directory the
		// running process never sees change; plain `npm run build` still writes
		// ./build for Docker and local runs.
		adapter: adapter({ out: process.env.BUILD_OUT || 'build' }),
		// SvelteKit's own check compares Origin against an origin adapter-node
		// assumes is https (it defaults the protocol to https unless ORIGIN or
		// PROTOCOL_HEADER is set), so on a plain-HTTP LAN install it refuses
		// every form POST, login included. src/hooks.server.ts does the same job
		// by comparing the Origin host against the request host instead, which
		// works either way and leaves server-to-server webhooks alone.
		csrf: { trustedOrigins: ['*'] },
		// Let the client notice a new build while a tab sits open. Without this
		// nothing ever tells a running tab that the deployed code changed, so a
		// fix can be live on the server and invisible on screen.
		version: { pollInterval: 30_000 }
	}
};

export default config;
