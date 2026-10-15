import { COMPANY_VOLUME, dockerRun, shareVolume } from './docker';
import { getBot } from './db';
import { isTextMime, mimeFor } from './files';
import { redactEverySecret } from './secrets';

/**
 * The bots' drives, as the human sees them in Settings.
 *
 * /company and each bot's /shared are Docker volumes mounted into the machines
 * - the app container has neither, deliberately, because the only thing that
 * needs a bot's files is the bot. Reading them from here therefore means
 * borrowing a container that has the volume: one throwaway reader per request,
 * read-only, with no network, removed whatever happens.
 *
 * Nothing here writes, and no path a request sends is ever a path this process
 * opens: it goes into `find` as an argument inside the reader container, and
 * the parser refuses `..`, absolute paths and anything that is not a plain
 * segment before that.
 */

/** Where the volume hangs inside the reader container. */
const MOUNT = '/vol';
/** Entries one listing or the all-files view may return. */
const MAX_ENTRIES = 400;
/** Bytes of one file a preview shows. */
const PREVIEW_BYTES = 64 * 1024;
/** Directories whose contents are never previewed: credentials live there. */
const SECRET_DIRS: Record<string, true> = { '.secrets': true, '.ssh': true };
/** What a preview can say about a file. */
export type Preview =
	| { kind: 'text'; text: string; size: number; truncated: boolean }
	| { kind: 'binary'; size: number; mime: string }
	| { kind: 'missing' };

/** One row of a drive: what it is called, how big, and when it changed. */
export interface MountEntry {
	name: string;
	/** Path relative to the drive's root, which is what a request sends back. */
	path: string;
	dir: boolean;
	size: number;
	mtime: number;
}

export interface MountTarget {
	volume: string;
	label: string;
}

/**
 * The drive a request names, or null when it names one that does not exist. A
 * bot's drive is named by the bot, so a deleted bot's volume is not browsable
 * by guessing: the row has to be there.
 */
export function mountTarget(kind: string, botId: string): MountTarget | null {
	if (kind === 'company') {
		return { volume: COMPANY_VOLUME, label: 'Company drive (/company)' };
	}
	if (kind !== 'shared') return null;
	const bot = botId ? getBot(botId) : undefined;
	if (!bot) return null;
	return { volume: shareVolume(bot.id), label: `${bot.name}’s drive (/shared)` };
}

/**
 * A relative path inside a drive, or null when it is not one. Every request
 * path comes through here first: `..`, a leading slash, a control character,
 * an empty or over-long segment is refused rather than handed to the reader.
 */
export function safeMountPath(raw: string): string | null {
	const path = raw.trim().replace(/\/+$/, '');
	if (!path) return '';
	if (path.startsWith('/') || path.length > 400) return null;
	for (const segment of path.split('/')) {
		if (segment === '.' || segment === '..') return null;
		if (!/^[A-Za-z0-9._@+-]{1,64}$/.test(segment)) return null;
	}
	return path;
}

/** True for a path that holds credentials, at any depth. */
export function isSecretPath(path: string): boolean {
	return path.split('/').some((segment) => SECRET_DIRS[segment] === true);
}

/** The folder a file sits in, as the browser shows it. */
export function parentOf(path: string): string {
	const at = path.lastIndexOf('/');
	return at < 0 ? '' : path.slice(0, at);
}

/**
 * The image a reader container is made from: the same box the machines use, so
 * it is already on any host that has ever woken one.
 */
const READER_IMAGE = process.env.MACHINE_IMAGE ?? 'alpine:latest';

/** One command in a reader container with this volume mounted read-only. */
function inVolume(volume: string, cmd: string[]): Promise<{ output: string; exitCode: number }> {
	return dockerRun({
		image: READER_IMAGE,
		cmd,
		binds: [`${volume}:${MOUNT}:ro`],
		timeoutMs: 30_000
	});
}

/**
 * `stat -c '%F\t%s\t%Y\t%n'` lines as entries. The type column is the only
 * thing that says what a name is, so a symlink reads as neither a folder nor a
 * file the reader can follow.
 */
function parseEntries(output: string): Omit<MountEntry, 'path'>[] {
	const rows: Omit<MountEntry, 'path'>[] = [];
	for (const line of output.split('\n')) {
		const [type, size, mtime, ...rest] = line.split('\t');
		const full = rest.join('\t');
		if (!type || !full) continue;
		const name = full.slice(full.lastIndexOf('/') + 1);
		if (!name) continue;
		rows.push({
			name,
			dir: type === 'directory',
			size: Number(size) || 0,
			mtime: (Number(mtime) || 0) * 1000
		});
	}
	return rows;
}

/** Folders first, then files, each by name: what a file browser shows. */
function ordered(entries: MountEntry[]): MountEntry[] {
	return entries.sort((a, b) =>
		a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
	);
}

/**
 * One folder of a drive. `find` is given the path as its own argument, and the
 * command runs without a shell, so a name with a space or a quote is a name.
 */
export async function listDir(
	volume: string,
	path: string,
	limit = MAX_ENTRIES
): Promise<{ entries: MountEntry[]; truncated: boolean }> {
	const res = await inVolume(volume, [
		'find',
		path ? `${MOUNT}/${path}` : MOUNT,
		'-mindepth',
		'1',
		'-maxdepth',
		'1',
		'-exec',
		'stat',
		'-c',
		'%F\t%s\t%Y\t%n',
		'{}',
		'+'
	]);
	const parsed = parseEntries(res.output).map((e) => ({
		...e,
		path: path ? `${path}/${e.name}` : e.name
	}));
	// A folder that is not there and a folder with nothing in it are different
	// answers: the reader says so on stderr and exits non-zero for the first,
	// and showing it as empty would be a lie the human acts on.
	if (!parsed.length && res.exitCode !== 0) {
		throw new Error(
			`could not read that folder: ${res.output.trim().slice(0, 200) || 'the drive did not answer'}`
		);
	}
	return { entries: ordered(parsed).slice(0, limit), truncated: parsed.length > limit };
}

/** Every file on a drive, flat and capped: "show me everything in /company". */
export async function allFiles(
	volume: string,
	limit = MAX_ENTRIES
): Promise<{ files: { path: string; size: number }[]; truncated: boolean }> {
	const res = await inVolume(volume, [
		'find',
		MOUNT,
		'-type',
		'f',
		'-exec',
		'stat',
		'-c',
		'%s\t%n',
		'{}',
		'+'
	]);
	const files: { path: string; size: number }[] = [];
	for (const line of res.output.split('\n')) {
		const at = line.indexOf('\t');
		if (at < 0) continue;
		const full = line.slice(at + 1);
		if (!full.startsWith(`${MOUNT}/`)) continue;
		files.push({ path: full.slice(MOUNT.length + 1), size: Number(line.slice(0, at)) || 0 });
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files: files.slice(0, limit), truncated: files.length > limit };
}

/**
 * The start of one text file. The size and the bytes come back from one
 * container: the script is fixed and the path arrives as `$1`, so nothing a
 * request sends is ever parsed as shell.
 */
export async function previewFile(volume: string, path: string): Promise<Preview> {
	const mime = mimeFor(path);
	// `stat` prints nothing at all for a path that is not there, and
	// `Number('')` is 0 - which would read as an empty file rather than a
	// missing one, so the digits are checked before they are trusted.
	const sizeOf = (raw: string): number | null => (/^\d+$/.test(raw.trim()) ? Number(raw) : null);
	if (!isTextMime(mime)) {
		const stat = await inVolume(volume, ['stat', '-c', '%s', `${MOUNT}/${path}`]);
		const size = sizeOf(stat.output);
		if (size === null) return { kind: 'missing' };
		return { kind: 'binary', size, mime };
	}
	const res = await inVolume(volume, [
		'sh',
		'-c',
		`stat -c %s "$1" 2>/dev/null; printf '\\n--obl--\\n'; head -c ${PREVIEW_BYTES} "$1" 2>/dev/null`,
		'obl-reader',
		`${MOUNT}/${path}`
	]);
	const [sizeLine = '', text = ''] = res.output.split('\n--obl--\n');
	const size = sizeOf(sizeLine);
	if (size === null) return { kind: 'missing' };
	return {
		kind: 'text',
		// A bot's secret can sit in a file it wrote; the reader gets the same
		// masking any other path out of a bot's reach would.
		text: redactEverySecret(text),
		size,
		truncated: size > PREVIEW_BYTES
	};
}

/**
 * A whole text file, or null when it is not there. Same reader contract as
 * previewFile, minus the cap and the secret masking: callers that show this
 * to a person redact themselves.
 */
export async function readFile(volume: string, path: string): Promise<string | null> {
	const res = await inVolume(volume, ['cat', `${MOUNT}/${path}`]);
	if (res.exitCode !== 0) return null;
	return res.output;
}

/**
 * Write a whole text file. The content travels base64'd in argv - never
 * through a shell - and the mount is read-write for this one call, which is
 * why this is not part of the read-only reader contract above.
 */
export async function writeFile(volume: string, path: string, content: string): Promise<void> {
	const res = await dockerRun({
		image: READER_IMAGE,
		cmd: [
			'sh',
			'-c',
			'mkdir -p "$(dirname "$2")" && printf %s "$1" | base64 -d > "$2"',
			'obl-writer',
			Buffer.from(content, 'utf8').toString('base64'),
			`${MOUNT}/${path}`
		],
		binds: [`${volume}:${MOUNT}`],
		timeoutMs: 30_000
	});
	if (res.exitCode !== 0) {
		throw new Error(`could not write that file: ${res.output.trim().slice(0, 200) || 'the drive did not answer'}`);
	}
}
