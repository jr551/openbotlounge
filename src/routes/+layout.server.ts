import type { LayoutServerLoad } from './$types';

/**
 * The shell decision, taken once per request on the server (see $lib/mobile)
 * and handed to the page, which is client-rendered - `ssr = false` in +page.ts.
 * Nothing on the client can outrank a server verdict that came from an explicit
 * override; the page re-checks the one signal a request cannot carry, iPadOS in
 * desktop mode, and only when no override is stored.
 */
export const load: LayoutServerLoad = ({ locals }) => ({ mobile: locals.mobile });
