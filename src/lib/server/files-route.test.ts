import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBot, listBotFiles } from '$lib/server/db';
import { botFilesDir, MAX_FILE_BYTES } from '$lib/server/files';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { GET, POST } from '../../routes/api/files/+server';
import { DELETE, GET as DOWNLOAD } from '../../routes/api/files/[id]/+server';

let seq = 0;

function bot(): string {
	return createBot({
		name: `files-route-${++seq}`,
		persona: '',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	}).id;
}

function base64(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64');
}

function upload(body: unknown) {
	const request = new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return POST({ request } as Parameters<typeof POST>[0]);
}

function list(botId: string, path = '') {
	const query = `bot_id=${encodeURIComponent(botId)}&path=${encodeURIComponent(path)}`;
	return GET({ url: new URL(`http://test/api/files?${query}`) } as Parameters<typeof GET>[0]);
}

function download(id: string, query = '') {
	return DOWNLOAD({
		params: { id },
		url: new URL(`http://test/api/files/${id}${query}`)
	} as Parameters<typeof DOWNLOAD>[0]);
}

function remove(id: string) {
	return DELETE({ params: { id } } as Parameters<typeof DELETE>[0]);
}

/** The response, or the thrown SvelteKit error, as one shape to assert on. */
async function sent(
	fn: () => unknown
): Promise<{ status: number; message: string; res: Response | null }> {
	try {
		const res = (await fn()) as Response;
		return { status: res.status, message: '', res };
	} catch (e) {
		const err = e as { status: number; body?: { message?: string } };
		return { status: err.status, message: err.body?.message ?? '', res: null };
	}
}

async function inventory(botId: string) {
	const res = await sent(() => list(botId));
	return ((await res.res!.json()) as { files: { id: string; name: string }[] }).files;
}

describe('GET/POST/DELETE /api/files', () => {
	it('uploads, lists, downloads and deletes one file', async () => {
		const botId = bot();
		const up = await sent(() =>
			upload({ bot_id: botId, name: 'hello.txt', data: base64('hello world') })
		);
		expect(up.status).toBe(201);
		const created = (await up.res!.json()).file;
		// The disk name is ours: a client gets the metadata it can use and no
		// hint of where the bytes actually are.
		expect(Object.keys(created).sort()).toEqual([
			'created_at',
			'id',
			'mime',
			'name',
			'size'
		]);
		expect(created).toMatchObject({ name: 'hello.txt', size: 11, mime: 'text/plain' });

		const files = await inventory(botId);
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual(created);

		const dl = await sent(() => download(created.id));
		expect(dl.status).toBe(200);
		expect(dl.res!.headers.get('content-type')).toBe('text/plain');
		expect(dl.res!.headers.get('content-disposition')).toContain('attachment');
		expect(await dl.res!.text()).toBe('hello world');

		const gone = await sent(() => remove(created.id));
		expect(gone.status).toBe(204);
		expect(await inventory(botId)).toEqual([]);
		expect((await sent(() => download(created.id))).status).toBe(404);
	});

	it('serves an image inline for the thumbnail and anything else as a download', async () => {
		const botId = bot();
		const png = await sent(() =>
			upload({
				bot_id: botId,
				name: 'shot.png',
				data: `data:image/png;base64,${Buffer.from('not-really-a-png').toString('base64')}`
			})
		);
		const image = (await png.res!.json()).file;
		expect(image.mime).toBe('image/png');

		const inline = await sent(() => download(image.id, '?inline=1'));
		expect(inline.res!.headers.get('content-disposition')).toContain('inline');
		expect(inline.res!.headers.get('content-type')).toBe('image/png');
		// A stored file is the user's bytes served from our origin, so it is
		// served as the type it is, un-sniffed and sandboxed off that origin.
		expect(inline.res!.headers.get('x-content-type-options')).toBe('nosniff');
		expect(inline.res!.headers.get('content-security-policy')).toContain("default-src 'none'");

		const text = await sent(() =>
			upload({ bot_id: botId, name: 'notes.txt', data: base64('hello') })
		);
		const notes = (await text.res!.json()).file;
		expect((await sent(() => download(notes.id, '?inline=1'))).res!.headers.get('content-disposition')).toContain(
			'attachment'
		);
	});

	it('refuses a name that is a path out of the files, and writes nothing at all', async () => {
		const botId = bot();
		for (const name of ['../evil.txt', 'a\\b.txt', '/etc/passwd', '..', '.', 'notes/../../etc/x']) {
			const res = await sent(() => upload({ bot_id: botId, name, data: base64('x') }));
			expect(res.status, name).toBe(400);
			expect(res.message, name).toMatch(/inside these files/);
		}
		expect(listBotFiles(botId)).toEqual([]);
		expect(existsSync(botFilesDir(botId))).toBe(false);
	});

	it('files a name with folders in it, and lists one folder at a time', async () => {
		const botId = bot();
		for (const name of ['readme.md', 'notes/plan.md', 'notes/2026/budget.csv', 'photos/x.png']) {
			const res = await sent(() => upload({ bot_id: botId, name, data: base64('x') }));
			expect(res.status, name).toBe(201);
			// The path is kept exactly as it was sent: that is what the bot's own
			// tools read the file by, and what the browser draws the tree from.
			expect((await res.res!.json()).file.name, name).toBe(name);
		}

		const root = await (await sent(() => list(botId))).res!.json();
		expect(root.path).toBe('');
		expect(root.folders).toEqual([
			{ name: 'notes', path: 'notes' },
			{ name: 'photos', path: 'photos' }
		]);
		expect(root.files.map((f: { name: string }) => f.name)).toEqual(['readme.md']);

		const notes = await (await sent(() => list(botId, 'notes'))).res!.json();
		expect(notes.path).toBe('notes');
		expect(notes.folders).toEqual([{ name: '2026', path: 'notes/2026' }]);
		expect(notes.files.map((f: { name: string }) => f.name)).toEqual(['notes/plan.md']);

		const deep = await (await sent(() => list(botId, 'notes/2026'))).res!.json();
		expect(deep.folders).toEqual([]);
		expect(deep.files.map((f: { name: string }) => f.name)).toEqual(['notes/2026/budget.csv']);

		// Folders first, then files, and each group by name - the order a browser
		// reads a folder in.
		const other = bot();
		for (const name of ['b.txt', 'a.txt', 'z/inner.txt', 'a/first.txt', 'm/deep/tenth10.txt', 'm/deep/tenth9.txt']) {
			await sent(() => upload({ bot_id: other, name, data: base64('x') }));
		}
		const sorted = await (await sent(() => list(other))).res!.json();
		expect(sorted.folders.map((f: { name: string }) => f.name)).toEqual(['a', 'm', 'z']);
		expect(sorted.files.map((f: { name: string }) => f.name)).toEqual(['a.txt', 'b.txt']);
		const deepSorted = await (await sent(() => list(other, 'm/deep'))).res!.json();
		expect(deepSorted.files.map((f: { name: string }) => f.name)).toEqual([
			'm/deep/tenth9.txt',
			'm/deep/tenth10.txt'
		]);
	});

	it('refuses a path that is not a folder inside these files', async () => {
		const botId = bot();
		await sent(() => upload({ bot_id: botId, name: 'notes/plan.md', data: base64('x') }));
		for (const path of [
			'../../etc/passwd',
			'..',
			'../notes',
			'/etc/passwd',
			'notes/../..',
			'notes//../x',
			'a\\b',
			'notes/',
			'/',
			'x'.repeat(300),
			Array.from({ length: 9 }, (_, i) => `d${i}`).join('/')
		]) {
			const res = await sent(() => list(botId, path));
			expect(res.status, path).toBe(400);
			expect(res.message, path).toMatch(/inside these files/);
		}
		// A folder that simply is not there is empty, not an error: the tree is
		// the rows, so a folder exists once something is filed in it.
		const missing = await (await sent(() => list(botId, 'nowhere'))).res!.json();
		expect(missing).toMatchObject({ path: 'nowhere', folders: [], files: [] });
		// Nothing above was able to list the other folder's contents or the root.
		expect(listBotFiles(botId)).toHaveLength(1);
	});

	it('downloads a file filed in a folder under its own name, not its path', async () => {
		const botId = bot();
		const up = await sent(() =>
			upload({ bot_id: botId, name: 'notes/plan.md', data: base64('the plan') })
		);
		const file = (await up.res!.json()).file;

		const dl = await sent(() => download(file.id));
		expect(dl.status).toBe(200);
		expect(await dl.res!.text()).toBe('the plan');
		expect(dl.res!.headers.get('content-disposition')).toContain('filename="plan.md"');
		// A header is not a place for a path, whatever the row is called.
		expect(dl.res!.headers.get('content-disposition')).not.toContain('notes/');

		// Deleting through the same id still takes its bytes with it.
		expect((await sent(() => remove(file.id))).status).toBe(204);
		const after = await (await sent(() => list(botId, 'notes'))).res!.json();
		expect(after).toMatchObject({ folders: [], files: [] });
	});

	it('refuses a file over the cap, and takes one of exactly the cap', async () => {
		const botId = bot();
		const over = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61).toString('base64');
		const refused = await sent(() => upload({ bot_id: botId, name: 'big.txt', data: over }));
		expect(refused.status).toBe(400);
		expect(refused.message).toContain(`${MAX_FILE_BYTES / 1024} KB`);
		expect(listBotFiles(botId)).toEqual([]);

		const at = Buffer.alloc(MAX_FILE_BYTES, 0x61).toString('base64');
		expect((await sent(() => upload({ bot_id: botId, name: 'big.txt', data: at }))).status).toBe(201);
	});

	it('rejects a malformed payload rather than storing a short file', async () => {
		const botId = bot();
		for (const data of ['not base64!!', 'aGk', 'aGk===', '', 'data:text/plain,hi']) {
			expect((await sent(() => upload({ bot_id: botId, name: 'x.txt', data }))).status, data).toBe(
				400
			);
		}
		expect((await sent(() => upload({ bot_id: botId, name: 'x.txt', data: 42 }))).status).toBe(400);
		expect((await sent(() => upload({ bot_id: botId, name: '', data: base64('x') }))).status).toBe(400);
		expect((await sent(() => upload({ bot_id: botId, name: 7, data: base64('x') }))).status).toBe(400);
		expect(listBotFiles(botId)).toEqual([]);
	});

	it('answers 400 or 404 for the things that are not there', async () => {
		const botId = bot();
		expect((await sent(() => GET({ url: new URL('http://test/api/files') } as never))).status).toBe(400);
		expect((await sent(() => list('no-such-bot'))).status).toBe(404);
		expect(
			(await sent(() => upload({ bot_id: 'no-such-bot', name: 'x.txt', data: base64('x') }))).status
		).toBe(404);
		expect((await sent(() => upload({ name: 'x.txt', data: base64('x') }))).status).toBe(404);
		expect((await sent(() => download('no-such-file'))).status).toBe(404);
		expect((await sent(() => remove('no-such-file'))).status).toBe(404);
		expect((await sent(() => upload({ bot_id: botId }))).status).toBe(400);
		expect((await sent(() => upload({ bot_id: botId, name: 'x.txt' }))).status).toBe(400);
	});

	it('rejects a body that is not JSON at all', async () => {
		const request = new Request('http://test/', { method: 'POST', body: 'not json' });
		expect((await sent(() => POST({ request } as never))).status).toBe(400);
	});
});
