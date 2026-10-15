import { createPublicKey, createPrivateKey } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBot, db, type Bot as BotRow } from './db';
import type { Bot } from '$lib/types';
import { decrypt } from './secrets';
import { ensureSshKey, generateSshKeyPair, materializeBotKey, sshPublicKey } from './ssh-keys';
import { machineExec, machineWriteFile } from './machine';
// Kept out of src/routes on purpose: SvelteKit reserves filenames starting with
// '+', so a test beside the route breaks `npm run build`.
import { GET as botsGET, POST as botsPOST } from '../../routes/api/bots/+server';
import { GET as botGET, PATCH as botPATCH } from '../../routes/api/bots/[id]/+server';

vi.mock('./machine', () => ({
	machineExec: vi.fn(async () => 'OBL_KEY_INSTALLED'),
	machineWriteFile: vi.fn(async () => {}),
	destroyMachine: vi.fn(async () => {})
}));

let seq = 0;
function makeBot(name: string): BotRow {
	return createBot({
		name: `${name}${++seq}`,
		persona: 'test persona',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

function request(body: unknown) {
	return new Request('http://test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('generateSshKeyPair', () => {
	it('writes a public key that really is the private key it came with', () => {
		const pair = generateSshKeyPair('cooper@openbotlounge');
		const [type, base64, comment] = pair.public_key.split(' ');
		expect(type).toBe('ssh-ed25519');
		expect(comment).toBe('cooper@openbotlounge');
		expect(pair.private_key).toContain('BEGIN PRIVATE KEY');

		// Decode the wire blob back: 4-byte length + string, twice.
		const blob = Buffer.from(base64, 'base64');
		const parts: Buffer[] = [];
		for (let at = 0; at < blob.length; ) {
			const length = blob.readUInt32BE(at);
			parts.push(blob.subarray(at + 4, at + 4 + length));
			at += 4 + length;
		}
		expect(parts).toHaveLength(2);
		expect(parts[0].toString()).toBe('ssh-ed25519');
		expect(parts[1]).toHaveLength(32);

		// Splice the raw key back into the SPKI header node exports and import
		// it: only a byte-exact encoding yields this private key's public half.
		const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), parts[1]]);
		const fromWire = createPublicKey({ key: spki, format: 'der', type: 'spki' });
		const fromPrivate = createPublicKey(createPrivateKey(pair.private_key));
		expect(fromWire.export({ type: 'spki', format: 'der' })).toEqual(
			fromPrivate.export({ type: 'spki', format: 'der' })
		);
	});
});

describe('ensureSshKey', () => {
	it('makes the key once and never replaces it', () => {
		const bot = makeBot('Cooper');
		const first = sshPublicKey(bot.id);
		expect(first).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+ cooper-?\d*@openbotlounge$/);
		expect(sshPublicKey(bot.id)).toBe(first);
		const count = db.prepare('SELECT COUNT(*) AS n FROM bot_ssh_keys WHERE bot_id = ?').get(bot.id) as {
			n: number;
		};
		expect(count.n).toBe(1);
	});

	it('stores the private half encrypted, in the same shape as a secret', () => {
		const bot = makeBot('Keeper');
		const row = ensureSshKey(bot.id)!;
		expect(row.private_key_enc).not.toContain('PRIVATE KEY');
		// iv:tag:ciphertext, so the PEM is not readable in the database.
		expect(row.private_key_enc.split(':')).toHaveLength(3);
		expect(decrypt(row.private_key_enc)).toContain('BEGIN PRIVATE KEY');
		expect(row.comment).toBe(`keeper${seq}@openbotlounge`);
	});

	it('scopes a key to its own bot', () => {
		const a = makeBot('Ann');
		const b = makeBot('Bob');
		expect(sshPublicKey(a.id)).not.toBe(sshPublicKey(b.id));
		expect(ensureSshKey(a.id)!.private_key_enc).not.toBe(ensureSshKey(b.id)!.private_key_enc);
		// Nothing takes a pair of bots, so one bot's id can only ever reach its
		// own row.
		const rowB = JSON.stringify(ensureSshKey(b.id));
		expect(rowB).not.toContain(ensureSshKey(a.id)!.public_key);
		expect(rowB).not.toContain(decrypt(ensureSshKey(a.id)!.private_key_enc));
	});

	it('has no key for a bot that does not exist', () => {
		expect(sshPublicKey('no-such-bot')).toBe('');
		expect(ensureSshKey('no-such-bot')).toBeUndefined();
	});
});

describe('bot API payloads', () => {
	it('carry the public key and never anything of the private one', async () => {
		const bot = makeBot('Profile');
		const pem = decrypt(ensureSshKey(bot.id)!.private_key_enc);

		const listed = (await (await botsGET({} as Parameters<typeof botsGET>[0])).json()) as {
			bots: Bot[];
		};
		const fromList = listed.bots.find((b) => b.id === bot.id)!;
		expect(fromList.ssh_public_key).toBe(sshPublicKey(bot.id));

		const single = (await (
			await botGET({ params: { id: bot.id } } as Parameters<typeof botGET>[0])
		).json()) as { bot: Bot };
		expect(single.bot.ssh_public_key).toBe(sshPublicKey(bot.id));

		for (const payload of [JSON.stringify(listed), JSON.stringify(single)]) {
			expect(payload).not.toContain('PRIVATE KEY');
			expect(payload).not.toContain(pem);
			expect(payload).not.toContain('private_key_enc');
		}
	});

	it('keep the public key on the bot a create or a save hands back', async () => {
		const created = (await (
			await botsPOST({
				request: request({ name: `Fresh${++seq}`, persona: 'test persona', machine_tier: 'none' })
			} as Parameters<typeof botsPOST>[0])
		).json()) as Bot;
		expect(created.ssh_public_key).toMatch(/^ssh-ed25519 /);

		const saved = (await (
			await botPATCH({
				params: { id: created.id },
				request: request({ name: `Fresh${++seq}` })
			} as Parameters<typeof botPATCH>[0])
		).json()) as Bot;
		expect(saved.ssh_public_key).toBe(created.ssh_public_key);
	});
});

describe('materializeBotKey', () => {
	it('writes the key by file write, so no logged command ever carries it', async () => {
		const bot = makeBot('Machine');
		vi.mocked(machineExec).mockClear();
		vi.mocked(machineWriteFile).mockClear();
		expect(await materializeBotKey(bot.id)).toBe(sshPublicKey(bot.id));

		// The private half reaches the machine as a file write - an exec of
		// the base64 PEM used to land verbatim in the exec log, which is an
		// activity row the whole feed can read.
		const pem = decrypt(ensureSshKey(bot.id)!.private_key_enc);
		const pemB64 = Buffer.from(pem, 'utf8').toString('base64');
		const writes = vi.mocked(machineWriteFile).mock.calls.map((c) => c[2]);
		expect(writes).toContain(pem);
		const config = writes.find((w) => w.includes('Host ')) ?? '';
		expect(config).toContain('StrictHostKeyChecking accept-new');
		expect(config).toContain('IdentitiesOnly yes');
		expect(config).toContain('UserKnownHostsFile /shared/.ssh/known_hosts');
		// The proxy allows any port to a public host, so github could be reached
		// on 22 as well; its 443 endpoint stays pinned because that is what its
		// own docs offer for locked-down networks.
		expect(config).toContain('HostName ssh.github.com');
		expect(config).toContain('ProxyCommand nc -X connect -x obl-egress:3128 %h %p');

		// The two execs stay keyless: directory prep, then modes and copy home.
		const commands = vi.mocked(machineExec).mock.calls.map((c) => c[1]);
		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain('mkdir -p /shared/.ssh "$HOME/.ssh"');
		const install = commands.at(-1)!;
		// Canonical copies on /shared, because the container's layer is not kept.
		expect(install).toContain('cp -f /shared/.ssh/id_ed25519');
		expect(install).toContain('"$HOME/.ssh');
		expect(install).not.toContain(pem);
		expect(install).not.toContain(pemB64);
		expect(install).not.toContain('BEGIN PRIVATE KEY');
		expect(install).toContain('OBL_KEY_INSTALLED');
	});

	it('gives up quietly when there is no machine, and still has the key', async () => {
		const bot = makeBot('Chatonly');
		vi.mocked(machineExec).mockRejectedValueOnce(new Error('this bot has no machine'));
		expect(await materializeBotKey(bot.id)).toBe('');
		expect(sshPublicKey(bot.id)).toMatch(/^ssh-ed25519 /);
	});
});
