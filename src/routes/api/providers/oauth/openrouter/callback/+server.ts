import type { RequestHandler } from './$types';
import { setSetting } from '$lib/server/db';
import { OPENROUTER_BASE_URL } from '$lib/providers';
import {
	decodeFlow,
	exchangeCode,
	FLOW_COOKIE,
	FLOW_COOKIE_PATH
} from '$lib/server/provider-oauth';

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * The browser landed here directly, so the answer is a page rather than JSON.
 * It carries no key: the page only celebrates, posts a word to the dialog that
 * opened it, and closes. A failure shows whatever OpenRouter said, escaped.
 */
function page(title: string, detail: string, connected: boolean, status: number): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         background: #0e0e10; color: #ececee; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 24rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.05rem; margin: 0 0 0.5rem; }
  p { margin: 0; color: #8a8a93; font-size: 0.85rem; line-height: 1.5; }
  button { margin-top: 1.2rem; padding: 0.5rem 1.2rem; border: 1px solid #2c2c30; border-radius: 0.6rem;
           background: #1b1b1e; color: #ececee; font: inherit; font-size: 0.85rem; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  <button onclick="window.close()">Close</button>
</main>
<script>
  if (${connected ? 'true' : 'false'}) {
    if (window.opener) window.opener.postMessage('obl-oauth-done', window.location.origin);
    setTimeout(function () { window.close(); }, 900);
  }
</script>
</body>
</html>`;
	return new Response(html, {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/** OpenRouter redirected back here with the one-time code. */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const raw = cookies.get(FLOW_COOKIE);
	// One use only, whether or not the rest of the flow succeeds.
	cookies.delete(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });

	const flow = raw ? decodeFlow(raw) : null;
	if (!flow) {
		return page(
			'That sign-in has expired',
			'Open Settings → Models and start the connection again.',
			false,
			400
		);
	}
	const code = url.searchParams.get('code') ?? '';
	if (!code) {
		return page('Sign-in cancelled', 'OpenRouter returned no code, so nothing was changed.', false, 400);
	}

	const { key, error } = await exchangeCode(code, flow.verifier);
	if (!key) return page('Could not connect', error, false, 400);

	setSetting('provider_base_url', OPENROUTER_BASE_URL);
	setSetting('provider_api_key', key);
	setSetting('provider_oauth', '');
	if (flow.model) setSetting('default_model', flow.model);
	return page(
		'Connected',
		'The provider now holds the key OpenRouter issued to this app. You can close this window.',
		true,
		200
	);
};
