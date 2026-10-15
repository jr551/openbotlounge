import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { addBotFile, deleteBotFile, type BotFile } from './db';

/**
 * Files the user hands a bot. The bytes live under DATA_DIR/files/<bot_id>/ and
 * a bot_files row describes each one, so the inventory can be listed without
 * opening the directory.
 *
 * A folder is a `/` in a name, and nothing else: there is no second store and no
 * directory to walk, so "notes/2026/plan.md" is one row whose name reads as a
 * path, and a tree of rows is what the browser in Settings shows. Filing a file
 * into a folder this way means the disk layout never depends on a name a client
 * sent - every file is still `<row id><suffix>` in the bot's own directory -
 * which is what keeps a crafted name from being able to reach anywhere.
 *
 * Nothing a client sends is trusted as a path. The name is only ever stored, in
 * `bot_files.name`, and shown back; the bytes are written under `bot_files.file`,
 * which is a row id we minted plus the file's suffix. A name that is not a
 * sequence of plain filenames is refused outright, and the one place a row's
 * stored name is turned back into a path re-checks that it is a bare basename
 * inside the bot's own directory, so a hand-edited row cannot reach anywhere
 * else either.
 */

/**
 * The most bytes one file may be. Uploads arrive base64-encoded in a JSON body,
 * which inflates them by a third, and adapter-node refuses a body over its
 * default BODY_SIZE_LIMIT of 512 KB before any of our code runs. 256 KiB
 * encodes to ~342 KB, so an over-sized upload is rejected here, with a message
 * naming the limit, instead of dying as an opaque 413 at the server's edge.
 */
export const MAX_FILE_BYTES = 256 * 1024;

/** The base64 length of MAX_FILE_BYTES, plus room for a `data:…;base64,` prefix. */
const MAX_ENCODED_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 64;

/** A filename a user can recognize; longer than this is a mistake, not a name. */
const MAX_NAME_CHARS = 128;

/** NUL and the other C0 controls, which no filename needs and no log wants. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The name a file arrived with, or null when it is not a plain filename.
 *
 * A separator, a control character, a bare "." or ".." or an over-long name all
 * mean the caller is naming a path rather than a file, and each is answered with
 * null so the route can say so: silently rewriting one of these into something
 * harmless is how "the file I downloaded is not the file I uploaded" happens.
 * Surrounding whitespace is trimmed - a browser never sends a name with any, so
 * one that has it came from somewhere else - and everything else, unicode
 * included, is kept exactly as given.
 */
export function safeFileName(raw: string): string | null {
	const name = raw.trim();
	if (!name || [...name].length > MAX_NAME_CHARS) return null;
	if (name === '.' || name === '..') return null;
	if (CONTROL_CHARS.test(name) || name.includes('/') || name.includes('\\')) return null;
	return name;
}

/** How many folders deep a name may be filed. Deeper is a mistake, or a walk. */
const MAX_PATH_DEPTH = 8;

/** The whole path a file may be filed under, separators included. */
const MAX_PATH_CHARS = 200;

/**
 * The path a file or a folder is named by, or null when it is not one that stays
 * inside the agent's files.
 *
 * Every segment has to be a plain filename, which is what refuses an absolute
 * path, a `..`, an empty or whitespace-padded segment and a backslash - each
 * refused outright rather than quietly rewritten, because a name silently turned
 * into a different name is how "the file I uploaded is not the file I got back"
 * happens. `''` is the root folder: a folder a caller may list, but never a name
 * a file may have, which is why saveFile treats a falsy result as a refusal.
 *
 * The result is a normalised path rather than a filesystem path: nothing here is
 * ever joined onto DATA_DIR, and the folder it names is found by reading rows.
 */
export function safeFilePath(raw: string): string | null {
	const path = raw.trim();
	if (!path) return '';
	if ([...path].length > MAX_PATH_CHARS) return null;
	const segments = path.split('/');
	if (segments.length > MAX_PATH_DEPTH) return null;
	// A segment that survives safeFileName unchanged is one: an empty segment, a
	// dot, a `..`, a padded name and an over-long one all come back different.
	for (const segment of segments) {
		if (segment !== safeFileName(segment)) return null;
	}
	return segments.join('/');
}

/** A folder in the inventory: what it is called, and the path that opens it. */
export interface FolderEntry {
	name: string;
	path: string;
}

/**
 * The rows one folder holds, as a file browser reads them.
 *
 * `dir` is a path safeFilePath has already allowed, and `''` is the root. A row
 * belongs to the folder when its name starts with the folder's path and is one
 * segment longer, and to a subfolder of it when it is longer than that - which is
 * the folder entry rather than a row, however many files are under it. The disk
 * is never walked: a directory someone made by hand is not in the inventory, and
 * a row whose name is not a path at all is left out rather than shown as a
 * folder with no name.
 */
export function listFolder(
	files: BotFile[],
	dir: string
): { folders: FolderEntry[]; files: BotFile[] } {
	const prefix = dir ? `${dir}/` : '';
	const below: BotFile[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		if (!file.name.startsWith(prefix)) continue;
		const rest = file.name.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash < 0) below.push(file);
		else if (slash > 0) seen.add(rest.slice(0, slash));
	}
	return {
		folders: [...seen].map((name) => ({ name, path: prefix + name })).sort(byName),
		files: below.sort(byName)
	};
}

/**
 * The order a browser reads names in. Numbers inside a name compare as numbers,
 * so a tenth file does not file itself between the first and the second, and
 * case is ignored, so a capital does not sort a file to somewhere unexpected.
 */
function byName(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
}

/** The directory holding every file the user has given one bot. */
export function botFilesDir(botId: string): string {
	return resolve(join(config.dataDir, 'files', botId));
}

/**
 * The absolute path of a stored basename, or null if it is not one.
 *
 * This is the only place a stored value becomes a path, and it is deliberately
 * suspicious of it: `basename` must give the value back unchanged, and the
 * result must resolve to a direct child of this bot's directory. A row reading
 * "../../chat.db" therefore reads nothing at all.
 */
function storedPath(botId: string, file: string): string | null {
	if (!file || file === '.' || file === '..' || basename(file) !== file) return null;
	if (CONTROL_CHARS.test(file)) return null;
	const dir = botFilesDir(botId);
	const path = resolve(dir, file);
	return path.startsWith(dir + sep) ? path : null;
}

/**
 * The suffix to read a name's type from, without the dot.
 *
 * `path.extname` reads a dotfile as having no extension at all, so ".env" would
 * otherwise be stored and described as an opaque blob - and a config file is
 * exactly what a bot is likely to be handed.
 */
function suffixOf(name: string): string {
	const ext = extname(name);
	if (ext) return ext.slice(1).toLowerCase();
	return /^\.[A-Za-z0-9]{1,10}$/.test(name) ? name.slice(1).toLowerCase() : '';
}

/** The suffix to store a name under: a short, ordinary one, or nothing. */
function storedExt(name: string): string {
	const suffix = suffixOf(name);
	return /^[a-z0-9]{1,10}$/.test(suffix) ? `.${suffix}` : '';
}

export type DecodedUpload =
	| { ok: true; bytes: Buffer }
	| { ok: false; reason: 'too large' | 'invalid base64' | 'empty' };

/**
 * Decode an upload body: plain base64, or the `data:…;base64,` form a browser's
 * FileReader produces.
 *
 * Buffer.from is far too forgiving to be the only check - it skips characters
 * it does not recognize and stops at the first one it cannot use, so a truncated
 * or corrupted payload would be stored as a shorter, plausible-looking file.
 * The alphabet and length are therefore checked first, and the byte count after,
 * which is also what keeps an over-sized string from being decoded at all.
 */
export function decodeUpload(payload: string): DecodedUpload {
	let encoded = payload;
	if (payload.startsWith('data:')) {
		const comma = payload.indexOf(',');
		if (comma < 0 || !/;base64$/i.test(payload.slice(5, comma))) {
			return { ok: false, reason: 'invalid base64' };
		}
		encoded = payload.slice(comma + 1);
	}
	if (encoded.length > MAX_ENCODED_CHARS) return { ok: false, reason: 'too large' };
	if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
		return { ok: false, reason: 'invalid base64' };
	}
	const bytes = Buffer.from(encoded, 'base64');
	if (bytes.length === 0) return { ok: false, reason: 'empty' };
	if (bytes.length > MAX_FILE_BYTES) return { ok: false, reason: 'too large' };
	return { ok: true, bytes };
}

/**
 * Write one file into a bot's directory and record it.
 *
 * The name may name a folder to file it under, and the folder is only ever a
 * part of the row's name: the bytes land in the bot's own directory under a name
 * we minted, so a nested name changes where the file reads from and never where
 * it is written.
 *
 * The bytes land on the disk before the row is inserted, so a failure between
 * the two has to be the kind that leaves nothing behind: the file is unlinked
 * again rather than orphaned.
 */
export async function saveFile(botId: string, name: string, bytes: Buffer): Promise<BotFile> {
	const safe = safeFilePath(name);
	if (!safe) throw new Error('name is not a path inside the bot files');
	const id = randomUUID();
	const file = `${id}${storedExt(safe)}`;
	const dir = botFilesDir(botId);
	await mkdir(dir, { recursive: true });
	const path = storedPath(botId, file);
	if (!path) throw new Error('refusing to write outside the bot directory');

	await writeFile(path, bytes);
	try {
		return addBotFile({
			id,
			bot_id: botId,
			name: safe,
			size: bytes.length,
			mime: mimeFor(safe),
			file
		});
	} catch (e) {
		await unlink(path).catch(() => {});
		throw e;
	}
}

/** Read a file's bytes back. Null when the row's target is gone or is not ours. */
export async function readFileBytes(file: BotFile): Promise<Buffer | null> {
	const path = storedPath(file.bot_id, file.file);
	if (!path) return null;
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

/**
 * Drop a file: its row first, then its bytes.
 *
 * In that order a reader can never find a row whose file it cannot then delete;
 * the other way round a failed unlink would leave a file on the disk that
 * nothing lists and nothing can remove.
 */
export async function removeFile(file: BotFile): Promise<boolean> {
	const removed = deleteBotFile(file.id);
	const path = storedPath(file.bot_id, file.file);
	if (path) await unlink(path).catch(() => {});
	return removed;
}

/**
 * Content types, by suffix. The client's claimed type is refused rather than
 * believed: it is served back with the file (inline for images), so letting the
 * uploader choose it would let an uploader choose what our own origin serves.
 */
const MIME_BY_EXT: Record<string, string> = {
	txt: 'text/plain',
	log: 'text/plain',
	md: 'text/markdown',
	markdown: 'text/markdown',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	json: 'application/json',
	jsonl: 'application/x-ndjson',
	ndjson: 'application/x-ndjson',
	yaml: 'application/yaml',
	yml: 'application/yaml',
	toml: 'application/toml',
	xml: 'application/xml',
	pdf: 'application/pdf',
	zip: 'application/zip',
	gz: 'application/gzip',
	tgz: 'application/gzip',
	tar: 'application/x-tar',
	'7z': 'application/x-7z-compressed',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	svg: 'image/svg+xml',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	js: 'text/javascript',
	mjs: 'text/javascript',
	cjs: 'text/javascript',
	ts: 'text/plain',
	tsx: 'text/plain',
	jsx: 'text/plain',
	py: 'text/x-python',
	rb: 'text/x-ruby',
	go: 'text/x-go',
	rs: 'text/x-rust',
	java: 'text/x-java',
	c: 'text/x-c',
	h: 'text/x-c',
	cpp: 'text/x-c++',
	sh: 'text/x-sh',
	bash: 'text/x-sh',
	sql: 'text/x-sql',
	env: 'text/plain',
	ini: 'text/plain',
	conf: 'text/plain',
	cfg: 'text/plain'
};

/** The type to store and serve a file as, from its name alone. */
export function mimeFor(name: string): string {
	return MIME_BY_EXT[suffixOf(name)] ?? 'application/octet-stream';
}

/**
 * Types a model can usefully read as text. `image/svg+xml` counts: it is XML,
 * and describing a picture the bot cannot see would be less use than the markup.
 */
const TEXTUAL: Record<string, true> = {
	'application/json': true,
	'application/x-ndjson': true,
	'application/xml': true,
	'application/yaml': true,
	'application/toml': true,
	'image/svg+xml': true
};

export function isTextMime(mime: string): boolean {
	return mime.startsWith('text/') || TEXTUAL[mime] === true;
}

/**
 * How much of a file one tool result may put in the model's context.
 *
 * A file is not dumped in when it is handed over, and it is not dumped in when
 * it is read either: a turn's budget is shared by everything the model has been
 * shown, so one attachment must not be able to swallow it. The same order as a
 * shell result's cap.
 */
export const MAX_FILE_TOOL_CHARS = 8000;

/** The lines of a text file, with CRLF endings normalised away. */
export function textLines(text: string): string[] {
	return text.split('\n').map((line) => line.replace(/\r$/, ''));
}

/** How a tool result names a line: "  12| hello", so numbers line up. */
export function numberedLine(n: number, text: string): string {
	return `${String(n).padStart(4)}| ${text}`;
}

export interface CappedOutput {
	text: string;
	/** Lines the text stands for. A line cut in half still counts as shown. */
	shown: number;
	/** Lines left out altogether, so the caller can say so. */
	left: number;
	/** The last line shown was cut short, so the text is a fragment of it. */
	cut: boolean;
}

/**
 * Join lines under the character cap.
 *
 * A line too long to fit is cut and given a trailing ellipsis rather than
 * dropped - a fragment the reader can see is a fragment, but a fragment nobody
 * mentions gets reported as the whole file - and `left` and `cut` are what
 * callers count to say exactly how much was left out.
 */
export function joinCapped(
	lines: string[],
	maxChars = MAX_FILE_TOOL_CHARS
): CappedOutput {
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		const room = maxChars - used;
		if (room <= 1) break;
		if (line.length + 1 <= room) {
			out.push(line);
			used += line.length + 1;
			continue;
		}
		out.push(`${line.slice(0, room - 2)}…`);
		return {
			text: out.join('\n'),
			shown: out.length,
			left: lines.length - out.length,
			cut: true
		};
	}
	return { text: out.join('\n'), shown: out.length, left: lines.length - out.length, cut: false };
}

/** A size a person reads at a glance - "512 B", "8.4 KB", "141 KB". */
export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}
