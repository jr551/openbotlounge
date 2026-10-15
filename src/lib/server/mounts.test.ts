import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createBot, setSetting } from './db';
import { createSecret } from './secrets';
import { isSecretPath, mountTarget, parentOf, safeMountPath } from './mounts';
import { GET as listRoute } from '../../routes/api/mounts/+server';
import { GET as fileRoute } from '../../routes/api/mounts/file/+server';
import { dockerRun } from './docker';

vi.mock('./docker', async (importOriginal) => ({
	// The real module stays: the machine/secrets imports beside this one need
	// its other helpers. Only the reader container is stood in for.
	...(await importOriginal<typeof import('./docker')>()),
	dockerRun: vi.fn()
}));

/** The argv the reader container was asked to run, last call first. */
function lastCmd(): string[] {
	const calls = vi.mocked(dockerRun).mock.calls;
	return (calls.at(-1)?.[0] as { cmd: string[] }).cmd;
}

/** A drive that answers with these `stat` lines. */
function listing(lines: string[]) {
	vi.mocked(dockerRun).mockResolvedValue({ output: lines.join('\n'), exitCode: 0 });
}

function makeBot(name: string) {
	return createBot({ name, persona: '', avatar: '', color: '', model: '', badge: '' });
}

function url(params: Record<string, string>): URL {
	return new URL(`http://test/?${new URLSearchParams(params)}`);
}

/**
 * Call a route the way SvelteKit would, and answer with what it threw. Only
 * `url` is read, so the event is as much of a RequestEvent as the route uses.
 */
async function call(handler: unknown, params: Record<string, string>) {
	const route = handler as (event: { url: URL }) => Promise<Response>;
	try {
		return { status: 200, body: await (await route({ url: url(params) })).json() };
	} catch (e) {
		return { status: (e as { status?: number }).status ?? 0, body: null };
	}
}

describe('a path a request sends is never a path that escapes', () => {
	it('accepts plain segments and the root', () => {
		expect(safeMountPath('')).toBe('');
		expect(safeMountPath('notes')).toBe('notes');
		expect(safeMountPath('notes/2026/plan.md')).toBe('notes/2026/plan.md');
		expect(safeMountPath('.gitignore')).toBe('.gitignore');
		expect(safeMountPath('notes/')).toBe('notes');
	});

	it('refuses everything that leaves the drive', () => {
		for (const bad of [
			'..',
			'../etc/passwd',
			'a/../../b',
			'a/..',
			'/etc/passwd',
			'a//b',
			'a/./b',
			'.',
			'a\u0000b',
			'a/'.repeat(200) + 'x',
			'x'.repeat(65),
			'a b',
			'a\\b',
			'a;b',
			'a$(id)b'
		]) {
			expect(safeMountPath(bad), bad).toBeNull();
		}
	});

	it('knows the credential folders at any depth', () => {
		expect(isSecretPath('.secrets')).toBe(true);
		expect(isSecretPath('.secrets/github')).toBe(true);
		expect(isSecretPath('work/.ssh/id_ed25519')).toBe(true);
		expect(isSecretPath('work/notes/secrets.md')).toBe(false);
		expect(parentOf('a/b/c.txt')).toBe('a/b');
		expect(parentOf('c.txt')).toBe('');
	});

	it('names the drive, and only for a bot that exists', () => {
		const bot = makeBot('Mounty');
		expect(mountTarget('company', '')).toMatchObject({ volume: 'obl-company' });
		expect(mountTarget('shared', bot.id)).toMatchObject({ volume: `obl-share-${bot.id}` });
		expect(mountTarget('shared', 'nobody')).toBeNull();
		expect(mountTarget('shared', '')).toBeNull();
		expect(mountTarget('../etc', bot.id)).toBeNull();
	});
});

describe('GET /api/mounts', () => {
	beforeEach(() => vi.mocked(dockerRun).mockReset());

	it('answers with folders first, then files, each named and measured', async () => {
		listing([
			'regular file\t1200\t1789310000\t/vol/notes.md',
			'directory\t4096\t1789310001\t/vol/reports',
			'regular file\t40\t1789310002\t/vol/a.txt'
		]);

		const { status, body } = await call(listRoute, { volume: 'company' });
		expect(status).toBe(200);
		expect(body.path).toBe('');
		expect(body.parent).toBeNull();
		expect(body.folders).toEqual([{ name: 'reports', path: 'reports' }]);
		expect(body.files.map((f: { name: string }) => f.name)).toEqual(['a.txt', 'notes.md']);
		expect(body.files[0]).toMatchObject({ path: 'a.txt', size: 40, mtime: 1789310002000 });
	});

	it('lists one folder of the drive, with its parent, as one argv element', async () => {
		listing(['regular file\t9\t1789310000\t/vol/reports/q3.csv']);

		const { body } = await call(listRoute, { volume: 'company', path: 'reports/2026' });
		expect(body.path).toBe('reports/2026');
		expect(body.parent).toBe('reports');
		expect(body.files[0].path).toBe('reports/2026/q3.csv');
		// The path is an argument, never shell text: no quoting, no expansion.
		expect(lastCmd()).toContain('/vol/reports/2026');
	});

	it('refuses a traversal path without ever calling the reader', async () => {
		const { status } = await call(listRoute, { volume: 'company', path: '../../etc' });
		expect(status).toBe(400);
		expect(vi.mocked(dockerRun)).not.toHaveBeenCalled();
	});

	it('refuses a drive that is not one of the bots', async () => {
		expect((await call(listRoute, { volume: 'shared', bot_id: 'nobody' })).status).toBe(400);
		expect((await call(listRoute, { volume: 'root', bot_id: '' })).status).toBe(400);
		expect(vi.mocked(dockerRun)).not.toHaveBeenCalled();
	});

	it('says so when a folder cannot be read, rather than calling it empty', async () => {
		vi.mocked(dockerRun).mockResolvedValue({
			output: 'find: /vol/nope: No such file or directory',
			exitCode: 1
		});
		expect((await call(listRoute, { volume: 'company', path: 'nope' })).status).toBe(502);
	});

	it('reads an empty folder as an empty folder', async () => {
		listing([]);
		const { status, body } = await call(listRoute, { volume: 'company', path: 'empty' });
		expect(status).toBe(200);
		expect(body.folders).toEqual([]);
		expect(body.files).toEqual([]);
	});

	it('shows every file on a drive when asked for all of them', async () => {
		listing(['30\t/vol/b.txt', '10\t/vol/dir/a.txt', '20\t/vol/.audit.log']);
		const { body } = await call(listRoute, { volume: 'company', all: '1' });
		expect(body.all).toBe(true);
		expect(body.files).toEqual([
			{ path: '.audit.log', size: 20 },
			{ path: 'b.txt', size: 30 },
			{ path: 'dir/a.txt', size: 10 }
		]);
		expect(body.truncated).toBe(false);
	});
});

describe('GET /api/mounts/file', () => {
	beforeEach(() => vi.mocked(dockerRun).mockReset());

	it('shows the start of a text file', async () => {
		vi.mocked(dockerRun).mockResolvedValue({
			output: '12\n--obl--\nhello there\n',
			exitCode: 0
		});
		const { status, body } = await call(fileRoute, { volume: 'company', path: 'notes/greet.txt' });
		expect(status).toBe(200);
		expect(body).toMatchObject({ kind: 'text', name: 'greet.txt', size: 12, truncated: false });
		expect(body.text).toContain('hello there');
	});

	it('never shows a file under .secrets or .ssh', async () => {
		for (const path of ['.secrets/github', 'work/.ssh/id_ed25519']) {
			const { status } = await call(fileRoute, { volume: 'company', path });
			expect(status, path).toBe(403);
		}
		expect(vi.mocked(dockerRun)).not.toHaveBeenCalled();
	});

	it('masks a bot secret that was written into a file', async () => {
		const bot = makeBot('Leaker');
		setSetting('any_setting', '1');
		createSecret(bot.id, 'stripe_key', 'sk-live-LEAKED-123456');
		vi.mocked(dockerRun).mockResolvedValue({
			output: '40\n--obl--\nmy key is sk-live-LEAKED-123456 ok\n',
			exitCode: 0
		});
		const { body } = await call(fileRoute, { volume: 'company', path: 'notes/leak.txt' });
		expect(body.text).toContain('[secret:stripe_key]');
		expect(body.text).not.toContain('sk-live-LEAKED-123456');
	});

	it('describes a file it cannot show rather than dumping it', async () => {
		vi.mocked(dockerRun).mockResolvedValue({ output: '2048', exitCode: 0 });
		const { body } = await call(fileRoute, { volume: 'company', path: 'pics/logo.png' });
		expect(body.kind).toBe('binary');
		expect(body.size).toBe(2048);
		expect(body.note).toContain('not a text file');
	});

	it('answers 404 for a file that is not there', async () => {
		vi.mocked(dockerRun).mockResolvedValue({ output: '', exitCode: 1 });
		expect((await call(fileRoute, { volume: 'company', path: 'gone.txt' })).status).toBe(404);
	});
});
