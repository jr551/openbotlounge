import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearedSessionCookie } from '$lib/server/auth';
import { requestIsSecure } from '$lib/server/http';

/** Sign out: drop the session cookie. Harmless when no password is configured. */
export const POST: RequestHandler = ({ cookies, request }) => {
	// Match the attributes it was set with, or the browser keeps a secure cookie
	// it will never send back and the session outlives the sign-out.
	const { name, value, options } = clearedSessionCookie(requestIsSecure(request));
	cookies.set(name, value, options as never);
	return json({ ok: true });
};
