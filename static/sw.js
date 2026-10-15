// Minimal service worker: required for installability, and what lets the
// installed app open with no network at all.
//
// Only content-hashed assets under /_app/immutable/ are cached on the way past,
// and only they are served cache-first. Everything else - the document,
// /_app/version.json, the manifest, icons - goes to the network and falls back
// to the cache only when the network is unavailable.
//
// This matters for version.json above all: SvelteKit polls it (at a stable URL,
// so a cache-first rule would pin it forever) to notice that a new build was
// deployed and reload the tab. Caching it means a rebuilt app is never picked
// up by a tab that is already open.
//
// The document is the one non-immutable thing worth keeping a copy of: a
// launcher icon that opens to "no internet" is not an app. The copy is only
// ever *read* when the network has already failed, so an open tab still gets
// the new build the moment one is deployed.
const CACHE = 'obl-v3';
/** The app is client-routed, so every navigation is served the one shell. */
const SHELL = '/';

self.addEventListener('install', (e) => {
	// Pre-cached rather than only cached in passing: a first visit's own
	// navigation is not intercepted (there was no worker yet), so without this
	// the very first offline launch after installing would have nothing to show.
	e.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).catch(() => {}));
	self.skipWaiting();
});

self.addEventListener('activate', (e) => {
	// Drop every earlier cache: its entries were stored under the old policy,
	// and a stale version.json would keep defeating update detection.
	e.waitUntil(
		caches
			.keys()
			.then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
			.then(() => self.clients.claim())
	);
});

/** Content-hashed build output: safe to serve from cache without checking. */
function isImmutable(url) {
	return url.pathname.startsWith('/_app/immutable/');
}

/** Last resort: the shell was never cached and the network is gone. */
function offlinePage() {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
		<meta name="theme-color" content="#0e0e10"><title>Offline</title><style>
			html,body{height:100%;margin:0;background:#0e0e10;color:#ececee;
				font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
			main{height:100%;display:flex;flex-direction:column;align-items:center;
				justify-content:center;gap:.6rem;padding:2rem;text-align:center}
			h1{font-size:1.1rem;margin:0}
			p{margin:0;color:#8a8a93;font-size:.9rem;line-height:1.5;max-width:22rem}
			button{margin-top:.6rem;padding:.55rem 1.2rem;background:#1b1b1e;color:#ececee;
				border:1px solid #2c2c30;border-radius:999px;font-size:.9rem;font-family:inherit}
		</style></head><body><main>
			<h1>You're offline</h1>
			<p>OpenBotLounge needs one connection to load. After that it opens from here.</p>
			<button onclick="location.reload()">Try again</button>
		</main></body></html>`,
		{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
	);
}

self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
	// API answers are the truth or they are nothing. A cached task list would
	// show work that has already finished and a cached conversation list would
	// hide new messages, so /api/ is never stored and never served.
	if (url.pathname.startsWith('/api/')) return;

	if (isImmutable(url)) {
		e.respondWith(
			caches.match(e.request).then(
				(cached) =>
					cached ??
					fetch(e.request).then((res) => {
						if (res.ok) {
							const clone = res.clone();
							caches.open(CACHE).then((c) => c.put(e.request, clone));
						}
						return res;
					})
			)
		);
		return;
	}

	// A navigation: the live document if the server answers, the stored shell if
	// it does not. Every navigation is stored under the same key because the
	// route lives in the client router, not in the HTML.
	if (e.request.mode === 'navigate') {
		e.respondWith(
			fetch(e.request)
				.then((res) => {
					if (res.ok) {
						const clone = res.clone();
						caches.open(CACHE).then((c) => c.put(SHELL, clone));
					}
					return res;
				})
				.catch(async () => (await caches.match(SHELL)) ?? offlinePage())
		);
		return;
	}

	// Everything else: the network is the truth. The cache is only a fallback
	// for when it is not there.
	e.respondWith(
		fetch(e.request).catch(() => caches.match(e.request).then((cached) => cached ?? Promise.reject(new Error('offline'))))
	);
});
