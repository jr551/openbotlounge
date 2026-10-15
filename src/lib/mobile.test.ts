import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_COOKIE, isIPadOnMac, isMobileRequest, mobileFlag, overrideFromCookie } from './mobile';

const IPHONE_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('isMobileRequest', () => {
	it('reads a phone user agent as a phone', () => {
		expect(isMobileRequest(IPHONE_UA, null)).toBe(true);
		expect(isMobileRequest('Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36', null)).toBe(true);
	});

	it('takes the browser at its word when it flags the device', () => {
		// What an emulated viewport in desktop Chrome reports: the hint is the
		// only signal an emulated UA cannot fake, which is what makes the mobile
		// preview work on a desktop.
		expect(isMobileRequest(MAC_UA, '?1')).toBe(true);
	});

	it('leaves a desktop alone', () => {
		expect(isMobileRequest(MAC_UA, null)).toBe(false);
		expect(isMobileRequest(MAC_UA, '?0')).toBe(false);
		expect(isMobileRequest('', null)).toBe(false);
	});
});

describe('mobileFlag', () => {
	it('reads only the two values it can mean', () => {
		expect(mobileFlag('1')).toBe(true);
		expect(mobileFlag('0')).toBe(false);
	});

	it('does not guess at anything else', () => {
		// A typo must not silently pick a shell: `?mobile=true` reading as
		// "mobile" would hand a desktop the phone UI for the rest of the year.
		for (const junk of ['', 'true', 'false', '2', 'yes', ' 1', null, undefined]) {
			expect(mobileFlag(junk)).toBeNull();
		}
	});
});

describe('overrideFromCookie', () => {
	it('finds the flag among the other cookies', () => {
		expect(overrideFromCookie(`${MOBILE_COOKIE}=1`)).toBe(true);
		expect(overrideFromCookie(`a=1; ${MOBILE_COOKIE}=0; b=2`)).toBe(false);
		expect(overrideFromCookie(`${MOBILE_COOKIE}=1; ${MOBILE_COOKIE}=0`)).toBe(true);
	});

	it('ignores a cookie whose name merely ends with the flag', () => {
		// Regression: an unanchored match reads `not_obl_mobile=1` as the
		// override, and then anything that can set a cookie decides the shell.
		expect(overrideFromCookie('not_obl_mobile=1')).toBeNull();
		expect(overrideFromCookie('obl_mobile_x=1')).toBeNull();
		expect(overrideFromCookie('')).toBeNull();
	});
});

describe('isIPadOnMac', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('reads a touch screen behind a Macintosh agent as an iPad', () => {
		// iPadOS in desktop mode: this is the one shell signal no request header
		// carries, so it is decided in the page and remembered in the cookie.
		vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: MAC_UA });
		expect(isIPadOnMac()).toBe(true);
	});

	it('leaves a Mac without a touch screen alone', () => {
		vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: MAC_UA });
		expect(isIPadOnMac()).toBe(false);
	});

	it('leaves a touch-screen phone to the user agent', () => {
		vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: IPHONE_UA });
		expect(isIPadOnMac()).toBe(false);
	});

	it('answers false where there is no browser at all', () => {
		vi.stubGlobal('navigator', undefined);
		expect(isIPadOnMac()).toBe(false);
	});
});
