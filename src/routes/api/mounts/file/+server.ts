import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isSecretPath, mountTarget, previewFile, safeMountPath } from '$lib/server/mounts';
import { mimeFor } from '$lib/server/files';

/**
 * The start of one file on one of the bots' drives, for the human to look at.
 *
 * Two things are never shown. A path under `.secrets` or `.ssh` is refused
 * outright - what is in there is the point of there being a secrets feature.
 * Everything else is masked the way any other bot-written text is, so a value
 * that a bot wrote into a file cannot travel back out through this panel.
 */
export const GET: RequestHandler = async ({ url }) => {
	const target = mountTarget(
		url.searchParams.get('volume') ?? 'company',
		url.searchParams.get('bot_id') ?? ''
	);
	if (!target) throw error(400, 'volume must be "company", or "shared" with a bot_id that exists');

	const path = safeMountPath(url.searchParams.get('path') ?? '');
	if (!path) throw error(400, 'path must name a file inside the drive');
	if (isSecretPath(path)) {
		throw error(403, 'files under .secrets and .ssh are never shown here');
	}

	const name = path.slice(path.lastIndexOf('/') + 1);
	try {
		const preview = await previewFile(target.volume, path);
		if (preview.kind === 'missing') throw error(404, 'no such file');
		if (preview.kind === 'binary') {
			return json({
				kind: 'binary',
				name,
				path,
				mime: preview.mime,
				size: preview.size,
				note: 'not a text file - there is nothing to show'
			});
		}
		return json({
			kind: 'text',
			name,
			path,
			mime: mimeFor(name),
			size: preview.size,
			truncated: preview.truncated,
			text: preview.text
		});
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(502, (e as Error).message);
	}
};
