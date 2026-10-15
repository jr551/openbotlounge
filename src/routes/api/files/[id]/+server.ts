import { error } from '@sveltejs/kit';
import { basename } from 'node:path';
import type { RequestHandler } from './$types';
import { getBotFile, type BotFile } from '$lib/server/db';
import { readFileBytes, removeFile } from '$lib/server/files';

/** Types the browser may render in place, which the thumbnail needs. */
const PREVIEWABLE: Record<string, true> = {
	'image/png': true,
	'image/jpeg': true,
	'image/gif': true,
	'image/webp': true,
	'image/avif': true,
	'image/bmp': true,
	'image/x-icon': true
};

/** The filename for a Content-Disposition header, in both its forms. */
function disposition(file: BotFile, inline: boolean): string {
	// The file's own name, not the folder path it is filed under: a header is
	// not a place for a path, and the browser saves and shows this one.
	const base = basename(file.name);
	// A quote or a backslash would end the quoted-string early. The ASCII
	// fallback is for old clients; the RFC 5987 form carries the real name,
	// unicode included, which is why the parentheses and the apostrophe - the
	// three characters encodeURIComponent leaves behind - are escaped too.
	const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const utf8 = encodeURIComponent(base).replace(
		/['()!*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Download a file, or render it in place when it is an image and `inline=1`. */
export const GET: RequestHandler = async ({ params, url }) => {
	const file = getBotFile(params.id);
	if (!file) throw error(404, 'no such file');
	const bytes = await readFileBytes(file);
	if (!bytes) throw error(404, 'the stored file is missing');
	const inline = url.searchParams.get('inline') === '1' && PREVIEWABLE[file.mime] === true;
	return new Response(new Uint8Array(bytes), {
		headers: {
			'Content-Type': file.mime,
			'Content-Disposition': disposition(file, inline),
			// The bytes are the user's, and the type is ours rather than a
			// guess: a file whose name says .png but is really HTML must not be
			// sniffed into a document, and cannot reach our origin even if it is.
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox",
			'Cache-Control': 'private, max-age=3600'
		}
	});
};

/** Throw a file away. Its bytes go with it. */
export const DELETE: RequestHandler = async ({ params }) => {
	const file = getBotFile(params.id);
	if (!file) throw error(404, 'no such file');
	await removeFile(file);
	return new Response(null, { status: 204 });
};
