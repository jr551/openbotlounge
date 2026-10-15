import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { BROWSER_RECIPES, DESKTOP_RECIPES } from '$lib/server/machine';

/** The desktop and browser recipes a bot's machine can be built with. */
export const GET: RequestHandler = () => {
	return json({
		desktops: Object.entries(DESKTOP_RECIPES).map(([id, r]) => ({ id, label: r.label })),
		browsers: Object.entries(BROWSER_RECIPES).map(([id, r]) => ({ id, label: r.label }))
	});
};
