/**
 * Which shell a request gets.
 *
 * A phone-class user agent is the signal that needs no opt-in. Chromium's
 * `Sec-CH-UA-Mobile` hint is the second one: it is the browser's own answer to
 * the question, so it catches an emulated viewport and an Android tablet alike.
 * An explicit `?mobile=1|0` outranks both, which is what lets a desktop preview
 * the mobile shell and a phone escape it.
 *
 * iPadOS 13+ asks for the desktop site and is served a Macintosh user agent, so
 * no request header gives it away - only the touch screen does, and only from
 * inside the page (see isIPadOnMac). That check writes the override cookie, so
 * from the next request onwards the server has the answer too.
 */

/** The override cookie: what makes a preview stick across navigations. */
export const MOBILE_COOKIE = 'obl_mobile';

/** The one server-side rule: what the browser says about itself. */
export function isMobileRequest(ua: string, hint: string | null): boolean {
	// `?1` is Chrome's own answer to "is this a phone".
	if (hint === '?1') return true;
	return /iPhone|iPod|iPad|Android|Mobile|Windows Phone|IEMobile|Opera Mini/i.test(ua);
}

/**
 * A `?mobile=` query value or a stored cookie, as a decision. Only the two
 * exact values count - a typo is not a preference to be guessed at, it is
 * nothing, and letting it read as either one would be the wrong half the time.
 */
export function mobileFlag(value: string | null | undefined): boolean | null {
	if (value === '1') return true;
	if (value === '0') return false;
	return null;
}

const OVERRIDE_RE = new RegExp(`(?:^|;\\s*)${MOBILE_COOKIE}=([01])(?:;|$)`);

/** The override as the page sees it, for guards an override must outrank. */
export function overrideFromCookie(cookie: string): boolean | null {
	return mobileFlag(OVERRIDE_RE.exec(cookie)?.[1] ?? null);
}

/**
 * iPadOS in desktop mode: a Macintosh user agent on a multi-touch screen.
 * Nothing else reports both, so the pair is the tell. False off the browser,
 * which is also what keeps it out of the way of any server-side use.
 */
export function isIPadOnMac(): boolean {
	if (typeof navigator === 'undefined') return false;
	return navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent);
}
