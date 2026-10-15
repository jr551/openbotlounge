import { redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, authEnabled, validSession } from '$lib/server/auth';
import { startScheduler } from '$lib/server/scheduler';
import { armShutdown } from '$lib/server/shutdown';
import { applyOverrides } from '$lib/server/config';
import { isCrossOrigin } from '$lib/server/http';
import { MOBILE_COOKIE, isMobileRequest, mobileFlag } from '$lib/mobile';
import { listBots, listSettings } from '$lib/server/db';
import { removeOrphanMachines, sweepOrphanShots } from '$lib/server/machine';
import { removeOrphanNetworks } from '$lib/server/machine-net';
import { attachVncProxyFrom } from '$lib/server/vnc-proxy';

// UI-edited settings outlive the container: the env vars are only defaults.
applyOverrides(listSettings());

startScheduler();

// SIGTERM must end in exit, not in systemd's SIGKILL: the scheduler interval
// and live turns hold the event loop open after the HTTP server has closed.
armShutdown();

// A sandbox container outlives everything that knows about it once its bot is
// deleted, so sweep the leftovers at boot. Fire-and-forget: the server must not
// wait on Docker to start serving.
void removeOrphanMachines(new Set(listBots().map((b) => b.id))).catch((e) => {
	console.error('sandbox sweep failed:', (e as Error).message);
});

// Machine networks outlive their bots the same way; the egress proxy's
// attachment is what keeps them undeletable until it is disconnected.
void removeOrphanNetworks(new Set(listBots().map((b) => b.id))).catch((e) => {
	console.error('network sweep failed:', (e as Error).message);
});

// Screen grabs the log no longer names pile up otherwise: the activity rows that
// pointed at them are trimmed away, their pictures never were.
void sweepOrphanShots().catch((e) => {
	console.error('shot sweep failed:', (e as Error).message);
});

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * An /api path whose handler threw an HttpError is rendered by SvelteKit as its
 * HTML error page - a body a JSON client cannot read. The status and the
 * message the route threw are both in that page (the message is its title), so
 * re-answer it as JSON. Only error pages are touched: a route's own JSON body
 * passes through untouched.
 */
async function jsonErrorForApi(response: Response): Promise<Response> {
	const html = await response.text();
	const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? 'error';
	const message = title
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
	return new Response(JSON.stringify({ error: message }), {
		status: response.status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	// The screen panel's RFB websocket. adapter-node hands the raw request over
	// as `platform.req`, and the http server that owns it is one property away;
	// the relay has to be attached from in here to share this module's session
	// signing key (see attachVncProxyFrom).
	attachVncProxyFrom(event.platform?.req);
	const { pathname } = event.url;

	/**
	 * Resolve, then re-answer an /api error page as JSON. SvelteKit catches a
	 * route's HttpError inside `resolve` and returns the rendered error page, so
	 * it cannot be caught here - it has to be recognized on the way out.
	 */
	const respond = async (): Promise<Response> => {
		const response = await resolve(event);
		if (
			pathname.startsWith('/api/') &&
			response.status >= 400 &&
			(response.headers.get('content-type') ?? '').includes('text/html')
		) {
			return jsonErrorForApi(response);
		}
		return response;
	};

	// Which shell this request gets. The override is a query away because a
	// desktop has to be able to preview the mobile UI; it is remembered in a
	// cookie because a tap on a link drops the query, and a preview that
	// evaporated the moment you navigated in it would be useless for checking
	// the actual screens. Set first, so an explicit choice outranks the sniff.
	const asked = mobileFlag(event.url.searchParams.get('mobile'));
	if (asked !== null) {
		event.cookies.set(MOBILE_COOKIE, asked ? '1' : '0', {
			path: '/',
			maxAge: 60 * 60 * 24 * 365,
			sameSite: 'lax',
			// It is a display preference, not a credential: the page has to be
			// able to read it (iPadOS in desktop mode sets it itself), and it
			// has to survive being served over plain HTTP on the LAN, where a
			// default Secure cookie would simply never come back.
			httpOnly: false,
			secure: false
		});
	}
	event.locals.mobile =
		mobileFlag(event.cookies.get(MOBILE_COOKIE)) ??
		isMobileRequest(
			event.request.headers.get('user-agent') ?? '',
			event.request.headers.get('sec-ch-ua-mobile')
		);

	// Inbound webhooks bypass both gates: the token in the URL is the
	// credential, not a session cookie, so cross-origin CSRF does not apply -
	// and a sender that does set an Origin (a browser-based hook tester, some
	// services) must not be refused for it. The route handler does the rest.
	if (pathname.startsWith('/api/hooks/')) return resolve(event);

	// Federated inboxes are the same story: the Ed25519 signature on the POST
	// is the credential, not a session cookie, and the inbox route does the rest.
	if (pathname.startsWith('/fed/')) return resolve(event);

	// Refuse a write aimed at us by another site. A page in the browser can POST
	// a form or a text/plain body across origins without a preflight, so without
	// this an open tab anywhere on the network could create or delete things.
	// Callers with no Origin are left alone: those are webhooks and scripts.
	if (STATE_CHANGING.has(event.request.method) && isCrossOrigin(event.request.headers.get('origin'), event.url.host)) {
		return new Response(JSON.stringify({ error: 'cross-origin request refused' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// An /api path that matches no route falls through to the SPA and answers
	// with the HTML index page - a 404 a JSON client cannot read. Answer it as
	// an API instead. `route.id` is null only when nothing matched, so real
	// endpoints are untouched.
	if (pathname.startsWith('/api/') && event.route.id === null) {
		return new Response(JSON.stringify({ error: 'not found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (!authEnabled()) return respond();

	if (pathname === '/login' || pathname.startsWith('/login/')) return respond();

	if (!validSession(event.cookies.get(SESSION_COOKIE))) {
		if (pathname.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		throw redirect(303, '/login');
	}
	return respond();
};
