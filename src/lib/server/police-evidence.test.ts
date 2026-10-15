import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addMessage,
	createBot,
	createConversation,
	deleteBot,
	deleteConversation,
	recordExecSample,
	type Bot
} from './db';
import { COMPANY_VOLUME, dockerExec, dockerRun, shareVolume } from './docker';
import { createSecret } from './secrets';
import { buildReviewBundle } from './police-review';

// The review reads the drives and the bot's shell history from outside the app:
// the folders through a throwaway reader container (dockerRun), the history
// through an exec into the machine. Both are the daemon's to answer, so the
// fake stands in for it; what is under test is what the bundle does with the
// answers, not the plumbing that fetched them.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 })),
	dockerExec: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));
// Whether the machine is up is read before its history is: the review never
// wakes a sleeping machine to read its shell. The whole module is faked, since
// the status probe is the only thing here that would ask a real daemon.
const { flags } = vi.hoisted(() => ({ flags: { machineState: 'running' } }));
vi.mock('./machine', () => ({
	DISPLAY: ':1',
	machineName: (botId: string) => `obl-machine-${botId.slice(0, 12)}`,
	machineStatus: vi.fn(async () => ({ state: flags.machineState })),
	// The bundle asks for the machine's memory; the fake has no cgroup to read.
	machineMemoryUsage: vi.fn(async () => null)
}));

const HISTORY = 'ls -la\ncd /company\nrm -rf /tmp/junk\n';

/** The tail of the bot's own drive, as a reader container would print it. */
const SHARED_LISTING =
	'total 12\ndrwxr-xr-x 2 root root 4096 notes\n-rw-r--r-- 1 root root 5 a.txt\n';
/** The top of the company drive. */
const COMPANY_LISTING = 'total 8\ndrwxr-xr-x 3 root root 4096 staff\n';

let bot: Bot;
let convId = '';

/** Answer every reader container by the command it was handed. */
function answerReaders(shared = SHARED_LISTING, company = COMPANY_LISTING): void {
	vi.mocked(dockerRun).mockImplementation(async (opts) => {
		const joined = opts.cmd.join(' ');
		if (joined.includes('ls -laR /shared')) return { output: shared, exitCode: 0 };
		if (joined.includes('ls -la /company')) return { output: company, exitCode: 0 };
		// The audit tail: no watcher ran, so there is nothing to read.
		return { output: '', exitCode: 1 };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// clearAllMocks keeps implementations, so both fakes get their defaults back
	// here: a reader that answers nothing is a daemon that has nothing to say.
	vi.mocked(dockerRun).mockResolvedValue({ output: '', exitCode: 1 });
	vi.mocked(dockerExec).mockResolvedValue({ output: '', exitCode: 1 });
	flags.machineState = 'running';
	bot = createBot({
		name: `Reviewed${Date.now()}`,
		persona: '',
		avatar: '🕵️',
		color: '#fff',
		model: '',
		badge: ''
	});
	convId = createConversation([bot.id], 'direct').id;
});

afterEach(() => {
	deleteConversation(convId);
	deleteBot(bot.id);
});

describe('buildReviewBundle disk evidence', () => {
	it('adds the shell history and both drive listings for a running machine', async () => {
		answerReaders();
		vi.mocked(dockerExec).mockResolvedValue({ output: HISTORY, exitCode: 0 });
		const now = Date.now();

		const bundle = await buildReviewBundle(bot, now - 60_000, now);

		const kinds = bundle.evidence.map((e) => e.kind);
		expect(kinds).toContain('shell-history');
		expect(kinds).toContain('folder-own');
		expect(kinds).toContain('folder-shared');

		// What the bot typed, as the machine's own history file holds it. Every
		// row is clipped to one line, so the newlines arrive flattened.
		const history = bundle.evidence.find((e) => e.kind === 'shell-history')!;
		expect(history.text).toContain('rm -rf /tmp/junk');
		expect(history.text).toContain('ls -la');
		// ...and it was read out of this bot's own machine, not some other one.
		expect(vi.mocked(dockerExec).mock.calls[0][0]).toBe(`obl-machine-${bot.id.slice(0, 12)}`);
		expect(vi.mocked(dockerExec).mock.calls[0][1].join(' ')).toContain('.sh_history');

		// The listings are the bot's own drive and the shared one, each mounted
		// read-only into a reader container: the app has no mount of its own.
		expect(bundle.evidence.find((e) => e.kind === 'folder-own')!.text).toContain('a.txt');
		expect(bundle.evidence.find((e) => e.kind === 'folder-shared')!.text).toContain('staff');
		const binds = vi.mocked(dockerRun).mock.calls.map((c) => c[0].binds?.join(' ') ?? '');
		expect(binds.some((b) => b.includes(`${shareVolume(bot.id)}:/shared:ro`))).toBe(true);
		expect(binds.some((b) => b.includes(`${COMPANY_VOLUME}:/company:ro`))).toBe(true);
	});

	it('lists the windows still open on a running machine', async () => {
		// The window list is the clutter criterion's evidence: what the bot
		// left on its desktop when the round came around. It rides the same
		// exec the shell history does, answered here by the command it ran.
		vi.mocked(dockerExec).mockImplementation(async (_c, cmd) => {
			const joined = cmd.join(' ');
			if (joined.includes('xdotool search')) {
				return { output: 'Terminal\nChromium\nChromium\nText Editor', exitCode: 0 };
			}
			return { output: HISTORY, exitCode: 0 };
		});
		const now = Date.now();

		const bundle = await buildReviewBundle(bot, now - 60_000, now);

		const windows = bundle.evidence.find((e) => e.kind === 'windows')!;
		expect(windows.where).toBe('open windows');
		expect(windows.text).toContain('Chromium');
		// The exec asked the desktop's own display, not some other session.
		const call = vi.mocked(dockerExec).mock.calls.find((c) =>
			c[1].join(' ').includes('xdotool search')
		)!;
		expect(call[1].join(' ')).toContain('DISPLAY=:1');
	});

	it('does not wake a sleeping machine for its shell history, and still reads the drives', async () => {
		// The history file only exists inside the machine, so reading it means
		// running it - and a review is not worth booting a machine for. The
		// folder listings are a different matter: they read the volumes through
		// a throwaway container, so a sleeping machine does not hide them.
		flags.machineState = 'sleeping';
		answerReaders();
		const now = Date.now();
		addMessage(convId, 'user', 'what did you do today?');

		const bundle = await buildReviewBundle(bot, now - 60_000, now);

		const kinds = bundle.evidence.map((e) => e.kind);
		expect(kinds).not.toContain('shell-history');
		expect(kinds).toContain('folder-own');
		expect(kinds).toContain('folder-shared');
		// No exec at all: the exec is what would have needed the machine up.
		expect(vi.mocked(dockerExec)).not.toHaveBeenCalled();
		// A feed the review cannot read is not a failed round - the rest of the
		// window is still read, which is what the round's stamp advancing needs.
		expect(bundle.evidence.map((e) => e.text).join('\n')).toContain('what did you do today?');
	});

	it('reads no disk evidence at all when the machine is off and the daemon answers nothing', async () => {
		// A host with no docker, or a machine that was never created: every
		// reader call fails and the status probe has nothing to report. The
		// bundle must come back with what the database holds rather than throw.
		flags.machineState = 'off';
		vi.mocked(dockerRun).mockRejectedValue(new Error('docker socket unavailable'));
		vi.mocked(dockerExec).mockRejectedValue(new Error('docker socket unavailable'));
		const now = Date.now();
		addMessage(convId, 'user', 'are you there?');

		const bundle = await buildReviewBundle(bot, now - 60_000, now);

		expect(bundle.evidence.map((e) => e.kind)).toEqual(['message']);
		expect(bundle.evidence[0].text).toContain('are you there?');
	});
});

describe('buildReviewBundle exec skim', () => {
	it('carries each command as a bounded sample with its exit status', async () => {
		recordExecSample(bot.id, { command: 'apk add nmap', exit_code: 0, output: 'OK: 42 MiB in 12 packages' });
		recordExecSample(bot.id, { command: 'nmap -sS 10.0.0.1', exit_code: 1, output: 'failed: no route' });
		const now = Date.now();

		const bundle = await buildReviewBundle(bot, now - 60_000, now);

		const execs = bundle.evidence.filter((e) => e.kind === 'exec');
		expect(execs).toHaveLength(2);
		// Newest first, each naming its own exit status - a verdict can stand on
		// one command rather than on a merged transcript.
		expect(execs[0].where).toContain('exit 1');
		expect(execs[0].text).toContain('$ nmap -sS 10.0.0.1');
		expect(execs[0].text).toContain('failed: no route');
		expect(execs[1].where).toContain('exit 0');
		expect(execs[1].text).toContain('$ apk add nmap');
	});

	it('counts the omitted middle of a flood instead of pretending it is the whole output', async () => {
		const flood = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
		recordExecSample(bot.id, { command: 'seq 1 50', exit_code: 0, output: flood });
		const now = Date.now();

		const bundle = await buildReviewBundle(bot, now - 60_000, now);

		const exec = bundle.evidence.find((e) => e.kind === 'exec')!;
		expect(exec.text).toContain('38 lines omitted');
		// Head and tail survive; the middle does not.
		expect(exec.text).toContain('line 1');
		expect(exec.text).toContain('line 50');
		expect(exec.text).not.toContain('line 25');
	});

	it('redacts a secret value that landed in a command or its output', async () => {
		createSecret(bot.id, 'api_key', 'sk-live-SUPERSECRET-123456');
		recordExecSample(bot.id, {
			command: 'curl -H "key: sk-live-SUPERSECRET-123456" example.com',
			exit_code: 0,
			output: 'token was sk-live-SUPERSECRET-123456'
		});
		const now = Date.now();

		const bundle = await buildReviewBundle(bot, now - 60_000, now);

		const exec = bundle.evidence.find((e) => e.kind === 'exec')!;
		expect(exec.text).not.toContain('sk-live-SUPERSECRET-123456');
		expect(exec.text).toContain('[secret:api_key]');
	});

	it('keeps the skim out of a flagged mini-review', async () => {
		recordExecSample(bot.id, { command: 'rm -rf /tmp/x', exit_code: 0, output: '' });
		const now = Date.now();
		addMessage(convId, 'user', 'flagged line');

		const bundle = await buildReviewBundle(bot, now - 60_000, now, { scope: 'flagged' });

		expect(bundle.evidence.map((e) => e.kind)).not.toContain('exec');
	});
});
