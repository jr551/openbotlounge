import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBot, listBotFiles, logActivity, type BotFile } from '$lib/server/db';
import {
	decodeUpload,
	listFolder,
	MAX_FILE_BYTES,
	safeFilePath,
	saveFile
} from '$lib/server/files';
import { readJson, strField } from '$lib/server/http';

/**
 * What the UI needs, and no more: the disk name the bytes were written under is
 * ours, and a client has no use for it. `name` is the path the file is filed
 * under, so a folder is visible in it and nowhere else.
 */
function publicFile(f: BotFile) {
	return { id: f.id, name: f.name, size: f.size, mime: f.mime, created_at: f.created_at };
}

/**
 * The folder a request names, or a refusal.
 *
 * The path is a folder inside this bot's own files - `''`, or nothing at all to
 * mean the root - and it is validated the same way a name is, because it is one:
 * nothing here becomes a filesystem path, but a request for `../../` is still a
 * request for somewhere else and is answered as one.
 */
function folderOf(raw: string | null): string {
	const dir = safeFilePath(raw ?? '');
	if (dir === null) throw error(400, 'path must be a folder inside these files');
	return dir;
}

/** One folder of one bot's inventory: its subfolders, then the files it holds. */
export const GET: RequestHandler = ({ url }) => {
	const botId = url.searchParams.get('bot_id') ?? '';
	if (!botId) throw error(400, 'bot_id required');
	if (!getBot(botId)) throw error(404, 'bot not found');
	const path = folderOf(url.searchParams.get('path'));
	const { folders, files } = listFolder(listBotFiles(botId), path);
	return json({ path, folders, files: files.map(publicFile) });
};

/**
 * Hand a bot a file. The bytes arrive base64 in the JSON body - the rest of the
 * app posts JSON everywhere - as
 * plain base64 or as the `data:…;base64,` string a browser's FileReader gives.
 *
 * The name may name the folder to file it under - "notes/plan.md" - which both
 * the folder picker and a dropped folder's relative path arrive as.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const botId = strField(body, 'bot_id', 80) ?? '';
	if (!getBot(botId)) throw error(404, 'bot not found');
	// The read cap is well above the name limit so an over-long name is refused
	// rather than quietly truncated into a different one.
	const name = safeFilePath(strField(body, 'name', 512) ?? '');
	if (!name) throw error(400, 'name must be a filename inside these files');
	const data = body.data;
	if (typeof data !== 'string') throw error(400, 'data must be a base64 string');
	const decoded = decodeUpload(data);
	if (!decoded.ok) {
		if (decoded.reason === 'too large') {
			throw error(400, `file is larger than ${MAX_FILE_BYTES / 1024} KB`);
		}
		throw error(400, decoded.reason === 'empty' ? 'the file is empty' : 'data must be base64');
	}

	const file = await saveFile(botId, name, decoded.bytes);
	logActivity(botId, 'file', `Received "${file.name}" from the user`);
	return json({ file: publicFile(file) }, { status: 201 });
};
