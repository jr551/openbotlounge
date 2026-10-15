import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { allFiles, listDir, mountTarget, parentOf, safeMountPath } from '$lib/server/mounts';

/**
 * One folder of one of the bots' drives, or - with `all=1` - every file on it.
 *
 * Read-only, and safe by construction: the path is parsed into plain segments
 * here, and it reaches the reader container as an argv element rather than as
 * shell text, so a name can neither escape the drive nor become a command.
 */
export const GET: RequestHandler = async ({ url }) => {
	const kind = url.searchParams.get('volume') ?? 'company';
	const target = mountTarget(kind, url.searchParams.get('bot_id') ?? '');
	if (!target) throw error(400, 'volume must be "company", or "shared" with a bot_id that exists');

	try {
		if (url.searchParams.get('all')) {
			const { files, truncated } = await allFiles(target.volume);
			return json({
				volume: kind,
				label: target.label,
				all: true,
				files,
				truncated,
				limit: files.length
			});
		}
		const path = safeMountPath(url.searchParams.get('path') ?? '');
		if (path === null) throw error(400, 'path must be a folder inside the drive');

		const { entries, truncated } = await listDir(target.volume, path);
		return json({
			volume: kind,
			label: target.label,
			path,
			parent: path ? parentOf(path) : null,
			folders: entries.filter((e) => e.dir).map(({ name, path: p }) => ({ name, path: p })),
			files: entries
				.filter((e) => !e.dir)
				.map(({ name, path: p, size, mtime }) => ({ name, path: p, size, mtime })),
			truncated
		});
	} catch (e) {
		// A drive that cannot be read is the operator's to fix (no Docker socket,
		// no reader image) rather than a crash: say what it was.
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(502, (e as Error).message);
	}
};
