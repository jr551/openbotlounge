import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createBot, deleteBot, getBotFile, listBotFiles, type Bot } from './db';
import {
	botFilesDir,
	decodeUpload,
	humanSize,
	isTextMime,
	joinCapped,
	MAX_FILE_BYTES,
	MAX_FILE_TOOL_CHARS,
	mimeFor,
	numberedLine,
	readFileBytes,
	removeFile,
	safeFileName,
	safeFilePath,
	saveFile,
	textLines
} from './files';

let seq = 0;

function makeBot(): Bot {
	return createBot({
		name: `files-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

const made: string[] = [];

function botWithDir(): string {
	const bot = makeBot();
	made.push(bot.id);
	return bot.id;
}

afterEach(() => {
	for (const id of made.splice(0)) deleteBot(id);
});

describe('safeFileName', () => {
	it.each([
		'../evil.txt',
		'../../chat.db',
		'a/b.txt',
		'a\\b.txt',
		'/etc/passwd',
		'sub/../x',
		'..',
		'.',
		'',
		'   ',
		'with\u0000nul.txt',
		'line\nbreak.txt',
		`${'x'.repeat(129)}.txt`
	])('refuses %j', (name) => {
		expect(safeFileName(name)).toBeNull();
	});

	it.each(['notes.txt', 'photo.png', '.env', 'weird name (1).md', 'ünïcode ✓.json', 'no-ext'])(
		'keeps %j as given',
		(name) => {
			expect(safeFileName(name)).toBe(name);
		}
	);

	it('trims surrounding whitespace, which no browser ever sends', () => {
		expect(safeFileName('  report.pdf  ')).toBe('report.pdf');
	});
});

describe('safeFilePath', () => {
	const depth8 = Array.from({ length: 8 }, (_, i) => `d${i}`).join('/');

	it('keeps a nested name, normalised, and trims the path as a whole', () => {
		expect(safeFilePath('notes/plan.md')).toBe('notes/plan.md');
		expect(safeFilePath('notes/2026/budget.csv')).toBe('notes/2026/budget.csv');
		expect(safeFilePath('  notes/plan.md  ')).toBe('notes/plan.md');
		expect(safeFilePath(depth8)).toBe(depth8);
	});

	it('takes the root, which is a folder and never a name', () => {
		// saveFile treats this as a refusal, which is why an empty name is not a
		// file called nothing.
		expect(safeFilePath('')).toBe('');
		expect(safeFilePath('   ')).toBe('');
	});

	it.each([
		'../evil.txt',
		'../../etc/passwd',
		'..',
		'.',
		'/etc/passwd',
		'notes/../../etc/passwd',
		'notes/../plan.md',
		'notes//plan.md',
		'notes/',
		'/',
		'notes\\plan.md',
		'a\\notes/plan.md',
		'notes /plan.md',
		'notes/ plan.md',
		'with\u0000nul.txt',
		`a/${'x'.repeat(129)}.txt`,
		Array.from({ length: 9 }, (_, i) => `d${i}`).join('/'),
		'x'.repeat(201)
	])('refuses %j', (path) => {
		expect(safeFilePath(path)).toBeNull();
	});
});

describe('decodeUpload', () => {
	it('accepts exactly the cap and refuses one byte more', () => {
		const at = Buffer.alloc(MAX_FILE_BYTES, 0x61);
		expect(decodeUpload(at.toString('base64'))).toMatchObject({ ok: true });

		const over = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
		expect(decodeUpload(over.toString('base64'))).toEqual({ ok: false, reason: 'too large' });
	});

	it('refuses an over-sized payload without decoding it', () => {
		// Twice the cap in characters: the length is checked before the decode,
		// so this never allocates the bytes it describes.
		expect(decodeUpload('A'.repeat(MAX_FILE_BYTES * 2))).toEqual({
			ok: false,
			reason: 'too large'
		});
	});

	it('keeps the cap inside the body limit the server enforces', () => {
		// Uploads are base64 in a JSON body, a third larger again, and
		// adapter-node refuses a body over its default 512 KB BODY_SIZE_LIMIT
		// before any of this runs. If the cap ever outgrows that the route stops
		// answering with its own message and starts dying at the edge instead.
		expect(Math.ceil((MAX_FILE_BYTES * 4) / 3)).toBeLessThan(512 * 1024);
	});

	it.each(['not base64!!', 'aGk', '====', 'aGk===', 'a b c d'])('refuses %j', (data) => {
		expect(decodeUpload(data)).toEqual({ ok: false, reason: 'invalid base64' });
	});

	it('refuses an empty payload', () => {
		expect(decodeUpload('')).toEqual({ ok: false, reason: 'empty' });
		expect(decodeUpload('data:text/plain;base64,')).toEqual({ ok: false, reason: 'empty' });
	});

	it('accepts a data URL, and refuses one that is not base64', () => {
		expect(decodeUpload('data:text/plain;base64,aGk=')).toEqual({
			ok: true,
			bytes: Buffer.from('hi')
		});
		expect(decodeUpload('data:text/plain,hi')).toEqual({ ok: false, reason: 'invalid base64' });
	});
});

describe('saveFile and readFileBytes', () => {
	it('round-trips bytes and records the name, size and type', async () => {
		const botId = botWithDir();
		const bytes = Buffer.from('hello ünïcode 😀', 'utf8');
		const file = await saveFile(botId, 'notes.txt', bytes);

		expect(file.name).toBe('notes.txt');
		expect(file.size).toBe(bytes.length);
		expect(file.mime).toBe('text/plain');
		// Stored under an id we minted, with only the suffix carried over.
		expect(file.file).toMatch(/^[0-9a-f-]{36}\.txt$/);
		expect(listBotFiles(botId).map((f) => f.id)).toEqual([file.id]);
		expect((await readFileBytes(file))?.equals(bytes)).toBe(true);
	});

	it('stores two files that arrived with the same name side by side', async () => {
		const botId = botWithDir();
		const first = await saveFile(botId, 'same.txt', Buffer.from('one'));
		const second = await saveFile(botId, 'same.txt', Buffer.from('two'));

		expect(first.file).not.toBe(second.file);
		expect((await readFileBytes(first))?.toString()).toBe('one');
		expect((await readFileBytes(second))?.toString()).toBe('two');
	});

	it('files a nested name under its folder without making one on the disk', async () => {
		const botId = botWithDir();
		const file = await saveFile(botId, 'notes/2026/plan.md', Buffer.from('# plan'));

		expect(file.name).toBe('notes/2026/plan.md');
		expect(file.mime).toBe('text/markdown');
		// The row reads as a path; the disk does not follow it. A folder is a `/`
		// in a name, so a name a client sent is never a directory we write into.
		expect(file.file).toMatch(/^[0-9a-f-]{36}\.md$/);
		expect(readdirSync(botFilesDir(botId))).toEqual([file.file]);
		expect((await readFileBytes(file))?.toString()).toBe('# plan');
	});

	it('keeps a name exactly as given, whatever it contains', async () => {
		const botId = botWithDir();
		const file = await saveFile(botId, 'ünïcode ✓.json', Buffer.from('{}'));

		expect(file.name).toBe('ünïcode ✓.json');
		expect(file.mime).toBe('application/json');
		expect(file.file).toMatch(/^[0-9a-f-]{36}\.json$/);
	});

	it('treats a dotfile as the file it is, suffix and all', async () => {
		const botId = botWithDir();
		const file = await saveFile(botId, '.env', Buffer.from('KEY=value'));

		expect(file.mime).toBe('text/plain');
		expect(file.file).toMatch(/^[0-9a-f-]{36}\.env$/);
		expect(isTextMime(file.mime)).toBe(true);
	});

	it('refuses a name that is not a plain filename', async () => {
		const botId = botWithDir();
		await expect(saveFile(botId, '../evil.txt', Buffer.from('x'))).rejects.toThrow();
		expect(listBotFiles(botId)).toEqual([]);
	});

	it('reads nothing from a row whose stored name is a path', async () => {
		const botId = botWithDir();
		const file = await saveFile(botId, 'notes.txt', Buffer.from('mine'));

		// The row is ours, but a name is a path the moment somebody reads it as
		// one - including a hand-edited row, which is the case this guards.
		expect(await readFileBytes({ ...file, file: '../../chat.db' })).toBeNull();
		expect(await readFileBytes({ ...file, file: '/etc/hosts' })).toBeNull();
		expect(await readFileBytes({ ...file, file: 'sub/other.txt' })).toBeNull();
		expect(await readFileBytes({ ...file, file: '..' })).toBeNull();
	});

	it('removes the row and the bytes together', async () => {
		const botId = botWithDir();
		const file = await saveFile(botId, 'gone.txt', Buffer.from('bye'));

		expect(await removeFile(file)).toBe(true);
		expect(getBotFile(file.id)).toBeUndefined();
		expect(listBotFiles(botId)).toEqual([]);
		expect(await readFileBytes(file)).toBeNull();
		// Nothing was removed a second time: the row was already gone.
		expect(await removeFile(file)).toBe(false);
	});

	it('leaves no bytes behind when the row cannot be written', async () => {
		// An id with no bot row: the bytes are written first and the INSERT then
		// fails its foreign key, which is the one moment a file could be born
		// with nothing pointing at it - no reader could find it and no delete.
		const orphan = 'no-such-bot-8f7e6d';
		await expect(saveFile(orphan, 'doomed.txt', Buffer.from('x'))).rejects.toThrow();

		const leftover = existsSync(botFilesDir(orphan)) ? readdirSync(botFilesDir(orphan)) : [];
		expect(leftover).toEqual([]);
	});
});

describe('deleteBot', () => {
	it('takes the bot\'s files and their directory with it', async () => {
		const botId = botWithDir();
		await saveFile(botId, 'mine.txt', Buffer.from('mine'));
		expect(existsSync(botFilesDir(botId))).toBe(true);

		expect(deleteBot(botId)).toBe(true);

		expect(existsSync(botFilesDir(botId))).toBe(false);
		expect(listBotFiles(botId)).toEqual([]);
	});

	it('does not reach outside DATA_DIR/files for an id that is a path', () => {
		// The directory is only removed for a bot that really existed, so an id
		// that is a path cannot delete an unrelated directory.
		expect(deleteBot('../../nope')).toBe(false);
	});
});

describe('mimeFor', () => {
	it('names a type from the suffix, whatever case it is written in', () => {
		expect(mimeFor('a.PNG')).toBe('image/png');
		expect(mimeFor('report.pdf')).toBe('application/pdf');
		expect(mimeFor('notes')).toBe('application/octet-stream');
		expect(mimeFor('.env')).toBe('text/plain');
	});

	it('treats text and markup as readable and a PNG as not', () => {
		expect(isTextMime(mimeFor('notes.md'))).toBe(true);
		expect(isTextMime(mimeFor('data.json'))).toBe(true);
		expect(isTextMime(mimeFor('drawing.svg'))).toBe(true);
		expect(isTextMime(mimeFor('photo.png'))).toBe(false);
		expect(isTextMime(mimeFor('blob'))).toBe(false);
	});
});

describe('humanSize', () => {
	it.each([
		[0, '0 B'],
		[512, '512 B'],
		[1024, '1.0 KB'],
		[8624, '8.4 KB'],
		[144_384, '141 KB']
	])('reads %i bytes as %s', (bytes, text) => {
		expect(humanSize(bytes)).toBe(text);
	});
});

describe('joinCapped', () => {
	it('returns everything when it fits, and reports nothing left out', () => {
		const page = joinCapped(['a', 'b', 'c']);
		expect(page).toEqual({ text: 'a\nb\nc', shown: 3, left: 0, cut: false });
	});

	it('stops at the cap and counts the lines it did not include', () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(100)}`);
		const page = joinCapped(lines, 500);
		expect(page.text.length).toBeLessThanOrEqual(500);
		expect(page.left).toBeGreaterThan(0);
		expect(page.shown + page.left).toBe(lines.length);
	});

	it('leaves a line out whole when the next one would not fit', () => {
		expect(joinCapped(['aaa', 'bbb'], 5)).toEqual({
			text: 'aaa',
			shown: 1,
			left: 1,
			cut: false
		});
	});

	it('cuts one over-long line and says it did, rather than dropping it', () => {
		const page = joinCapped([`start ${'x'.repeat(5000)}`], 200);
		expect(page.cut).toBe(true);
		expect(page.shown).toBe(1);
		expect(page.left).toBe(0);
		expect(page.text.endsWith('…')).toBe(true);
		expect(page.text.length).toBeLessThanOrEqual(200);
	});

	it('stays inside the default cap that a turn shares', () => {
		const lines = Array.from({ length: 400 }, (_, i) => `${i}| ${'y'.repeat(60)}`);
		expect(joinCapped(lines).text.length).toBeLessThanOrEqual(MAX_FILE_TOOL_CHARS);
	});
});

describe('textLines and numberedLine', () => {
	it('normalises CRLF endings so a stored line never carries a stray \\r', () => {
		expect(textLines('one\r\ntwo\r\nthree')).toEqual(['one', 'two', 'three']);
	});

	it('numbers a line so columns of numbers line up', () => {
		expect(numberedLine(7, 'seven')).toBe('   7| seven');
		expect(numberedLine(1234, 'many')).toBe('1234| many');
	});
});
