import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot } from '$lib/server/db';
import { readMachineFile } from '$lib/server/machine';

/**
 * Serve the machine's noVNC assets through the app. The panel drives the
 * RFB client directly rather than framing vnc_lite.html, and a dynamic
 * `import()` of that module tree has to be same-origin.
 *
 * The files are read out of the container through the exec API rather than
 * fetched over HTTP: the machine's network is internal, so the app has no
 * route to it - and nothing the machine serves is ever trusted anyway.
 * websockify keeps them under /usr/share/novnc.
 */
const NOVNC_ROOT = '/usr/share/novnc';

const TYPES: Record<string, string> = {
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.html': 'text/html',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.json': 'application/json',
	'.map': 'application/json'
};

/** A path segment that can safely become part of an exec'd file path. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export const GET: RequestHandler = async ({ params }) => {
	if (!getBot(params.id)) throw error(404, 'not found');
	const path = params.path ?? '';
	// No traversal and nothing outside the noVNC tree: each segment must be a
	// plain filename, which refuses '..', empty segments and anything with a
	// shell metacharacter before it is ever joined onto the root.
	const segments = path.split('/');
	if (!path || segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) {
		throw error(404, 'not found');
	}
	const bytes = await readMachineFile(params.id, NOVNC_ROOT, segments.join('/'));
	if (!bytes) throw error(404, 'not found');
	const ext = path.slice(path.lastIndexOf('.'));
	return new Response(new Uint8Array(bytes), {
		headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream' }
	});
};
