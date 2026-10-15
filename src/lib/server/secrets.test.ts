import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot, type Bot } from './db';
import { machineExec } from './machine';
import {
	createSecret,
	decrypt,
	deleteSecret,
	encrypt,
	getSecret,
	injectSecret,
	listSecrets,
	redactSecrets,
	shareSecret
} from './secrets';

vi.mock('./machine', () => ({
	machineExec: vi.fn()
}));

let seq = 0;
function makeBot(name: string): Bot {
	return createBot({
		name: `${name}${++seq}`,
		persona: 'test persona',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

describe('encrypt/decrypt', () => {
	it('round-trips an arbitrary UTF-8 string', () => {
		const plain = 'pässwörd 🔑 with \'quotes\' and\nnewlines\t& symbols';
		expect(decrypt(encrypt(plain))).toBe(plain);
	});

	it('encrypts the same plaintext differently each time, both decrypting back', () => {
		const plain = 'same-secret-value';
		const a = encrypt(plain);
		const b = encrypt(plain);
		expect(a).not.toBe(b);
		expect(decrypt(a)).toBe(plain);
		expect(decrypt(b)).toBe(plain);
	});

	it('throws on a corrupted blob instead of returning garbage', () => {
		const blob = encrypt('integrity matters');
		// Flip one base64 character inside the ciphertext segment; the GCM auth
		// tag must reject it.
		const i = blob.lastIndexOf(':') + 1;
		const flipped = blob[i] === 'A' ? 'B' : 'A';
		const corrupted = blob.slice(0, i) + flipped + blob.slice(i + 1);
		expect(() => decrypt(corrupted)).toThrow();
	});
});

describe('createSecret', () => {
	it('re-using a name rotates the value, keeps one row and preserves sharing', () => {
		const owner = makeBot('owner');
		const other = makeBot('other');
		createSecret(owner.id, 'api_key', 'first-value');
		expect(shareSecret(owner.id, 'api_key', other.id)).toBe(true);

		createSecret(owner.id, 'api_key', 'second-value');

		const rows = listSecrets(owner.id);
		expect(rows).toHaveLength(1);
		expect(rows[0].shared_with).toContain(other.id);
		expect(decrypt(getSecret(owner.id, 'api_key')!.value)).toBe('second-value');
	});
});

describe('listSecrets', () => {
	it('never returns the value field', () => {
		const bot = makeBot('list');
		createSecret(bot.id, 'k1', 'v1');
		createSecret(bot.id, 'k2', 'v2');
		const rows = listSecrets(bot.id);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).not.toHaveProperty('value');
		}
	});
});

describe('deleteSecret', () => {
	it('removes the row', () => {
		const bot = makeBot('del');
		createSecret(bot.id, 'gone', 'v');
		expect(deleteSecret(bot.id, 'gone')).toBe(true);
		expect(listSecrets(bot.id)).toHaveLength(0);
	});

	it('reports false for an unknown name', () => {
		const bot = makeBot('del2');
		expect(deleteSecret(bot.id, 'nope')).toBe(false);
	});
});

describe('injectSecret', () => {
	beforeEach(() => {
		vi.mocked(machineExec).mockReset();
		vi.mocked(machineExec).mockResolvedValue('OBL_INJECTED');
	});

	it.each(['../escape', 'a/b', 'na me', 'key;rm -rf', '$(id)'])(
		'rejects unsafe name %s without calling machineExec',
		async (name) => {
			const bot = makeBot('inj');
			const result = await injectSecret(bot.id, name);
			expect(result).toMatch(/^error:/);
			expect(machineExec).not.toHaveBeenCalled();
		}
	);

	it('writes the secret base64-encoded to $HOME/.secrets/<name>, never inlining plaintext', async () => {
		const bot = makeBot('inj');
		createSecret(bot.id, 'api_key', 'super-secret-plaintext');

		const result = await injectSecret(bot.id, 'api_key');

		expect(result).toContain('~/.secrets/api_key');
		expect(machineExec).toHaveBeenCalledTimes(1);
		const command = vi.mocked(machineExec).mock.calls[0][1];
		expect(command).toContain('$HOME/.secrets/api_key');
		expect(command).not.toContain('super-secret-plaintext');
		expect(command).toContain(Buffer.from('super-secret-plaintext', 'utf8').toString('base64'));
	});

	it('returns an error for a secret the bot has no right to use', async () => {
		const owner = makeBot('owner');
		const stranger = makeBot('stranger');
		createSecret(owner.id, 'private_key', 'hidden');

		const result = await injectSecret(stranger.id, 'private_key');

		expect(result).toMatch(/^error:/);
		expect(machineExec).not.toHaveBeenCalled();
	});

	it('lets a bot inject a secret shared with it', async () => {
		const owner = makeBot('owner');
		const guest = makeBot('guest');
		createSecret(owner.id, 'shared_key', 'shared-value');
		shareSecret(owner.id, 'shared_key', guest.id);

		const result = await injectSecret(guest.id, 'shared_key');

		expect(result).toContain('~/.secrets/shared_key');
		expect(machineExec).toHaveBeenCalledTimes(1);
	});
});

describe('redactSecrets', () => {
	it('replaces a secret value with a named placeholder', () => {
		const bot = createBot({ name: 'Redactor', persona: '', avatar: '', color: '', model: '', badge: '' });
		createSecret(bot.id, 'api_key', 'sk-live-abcdef123456');

		const out = redactSecrets(bot.id, 'the key is sk-live-abcdef123456 ok');

		expect(out).not.toContain('sk-live-abcdef123456');
		expect(out).toContain('[secret:api_key]');
	});

	it('leaves unrelated text alone and tolerates a bot with no secrets', () => {
		const bot = createBot({ name: 'Empty', persona: '', avatar: '', color: '', model: '', badge: '' });
		expect(redactSecrets(bot.id, 'nothing to hide here')).toBe('nothing to hide here');
	});

	it('redacts a secret shared to the bot, not just its own', () => {
		const owner = createBot({ name: 'Owner', persona: '', avatar: '', color: '', model: '', badge: '' });
		const borrower = createBot({ name: 'Borrower', persona: '', avatar: '', color: '', model: '', badge: '' });
		createSecret(owner.id, 'shared_key', 'shared-value-xyz789');
		shareSecret(owner.id, 'shared_key', borrower.id);

		const out = redactSecrets(borrower.id, 'value: shared-value-xyz789');

		expect(out).not.toContain('shared-value-xyz789');
	});

	it('redacts a five-character secret, the shortest the floor allows', () => {
		const bot = createBot({ name: 'Shorty', persona: '', avatar: '', color: '', model: '', badge: '' });
		createSecret(bot.id, 'pin', '91827');

		const out = redactSecrets(bot.id, 'the pin is 91827 today');

		expect(out).not.toContain('91827');
		expect(out).toContain('[secret:pin]');
	});
});
