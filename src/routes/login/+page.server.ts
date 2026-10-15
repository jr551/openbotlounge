import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { SESSION_COOKIE, authEnabled, checkPassword, sessionCookie, validSession } from '$lib/server/auth';
import { requestIsSecure } from '$lib/server/http';

// With no APP_PASSWORD the gate is off: /login must never render. And a
// signed-in visitor has nothing to do here either.
export const load: PageServerLoad = async ({ cookies }) => {
	if (!authEnabled() || validSession(cookies.get(SESSION_COOKIE))) throw redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		if (!authEnabled()) throw redirect(303, '/');
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		if (!checkPassword(password)) {
			return fail(401, { error: 'Wrong password' });
		}
		const c = sessionCookie(requestIsSecure(request));
		cookies.set(c.name, c.value, c.options as { path: string } & Record<string, unknown>);
		throw redirect(303, '/');
	}
};
