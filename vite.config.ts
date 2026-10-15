import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * The screen panel's websocket relay, in dev.
 *
 * In production the relay attaches itself to the app's http server from inside
 * hooks.server.ts, where adapter-node hands the raw request over as
 * `platform.req`. The dev server hands nothing over, so the same attach is made
 * here against the dev server's own http server - through its module graph, so
 * the relay shares the app's session signing key rather than re-deriving it
 * (with SESSION_SECRET unset that key is a per-boot random value, and a relay
 * built from a second copy of the module would refuse every valid cookie).
 */
function vncRelay(): Plugin {
	return {
		name: 'obl-vnc-relay',
		apply: 'serve',
		async configureServer(server) {
			if (!server.httpServer) return;
			const { attachVncProxy } = await server.ssrLoadModule('/src/lib/server/vnc-proxy.ts');
			attachVncProxy(server.httpServer);
		}
	};
}

/**
 * pi-coding-agent's syntax highlighting imports highlight.js subpaths with a
 * .js suffix ('highlight.js/lib/core.js'), which the package's exports map
 * does not define - node crashes on boot resolving them. The build leaves
 * highlight.js external (it is a runtime dependency), so the bad specifier
 * reaches node verbatim. Resolving those imports to real file paths here
 * pulls them into the bundle, where the suffix is just a filename.
 */
function hljsSubpaths(): Plugin {
	return {
		name: 'obl-hljs-subpaths',
		enforce: 'pre',
		resolveId(source) {
			const m = /^highlight\.js\/lib\/(.+\.js)$/.exec(source);
			if (!m) return null;
			return this.resolve(`highlight.js/lib/${m[1].slice(0, -3)}`, undefined, {
				skipSelf: true
			});
		}
	};
}

export default defineConfig({
	plugins: [sveltekit(), vncRelay(), hljsSubpaths()]
});
