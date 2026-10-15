import { getBot } from './db';
import { COMPANY_VOLUME, shareVolume } from './docker';
import { readFile, writeFile } from './mounts';

/**
 * The files a bot keeps at the root of its own drive (the volume its machine
 * sees as /shared). They replaced the database scratchpad, so the bot can read
 * and rewrite them with the same file tools it uses for everything else - and
 * the app can reach them without waking the machine, through the mounts
 * reader/writer containers.
 *
 *  - personality.md: who the bot has become - seeded from its persona,
 *    rewritten by the bot itself and by its pre-compaction dreams.
 *  - scratchpad.md: working notes - what the Settings panel edits, and where
 *    the bot's `remember` writes land as a mirror of its knowledge store.
 *  - accounts.md: the bot's own ledger of accounts it has created or manages -
 *    references and notes, never plaintext secrets.
 */
const PERSONALITY_PATH = 'personality.md';
const SCRATCHPAD_PATH = 'scratchpad.md';
const ACCOUNTS_PATH = 'accounts.md';

/** What a fresh personality file starts with: a header, then the persona. */
function seedText(name: string, persona: string): string {
	return `# ${name}\n\n${persona.trim()}\n`;
}

const SCRATCHPAD_SEED = '# Scratchpad\n\nWorking notes. The human can edit this from Settings.\n';

const ACCOUNTS_SEED =
	'# Accounts\n\n' +
	'One line per account you create or manage: the service, the username, and ' +
	'where the credential lives (a secret name, a file) - never the secret itself.\n';

/**
 * One drive file's text, or null when the drive cannot be read (no Docker, a
 * volume that does not exist yet). A missing file is seeded on the way out,
 * so the first read is also the first write.
 */
async function readBotFile(botId: string, path: string, seed: string): Promise<string | null> {
	const bot = getBot(botId);
	if (!bot) return null;
	const volume = shareVolume(botId);
	const existing = await readFile(volume, path);
	if (existing !== null) return existing;
	await writeFile(volume, path, seed);
	return seed;
}

/** Replace one drive file. Null bot or an unwritable drive surfaces as an error. */
async function writeBotFile(botId: string, path: string, content: string): Promise<void> {
	const bot = getBot(botId);
	if (!bot) throw new Error('bot not found');
	await writeFile(shareVolume(botId), path, content);
}

export async function readPersonality(botId: string): Promise<string | null> {
	const bot = getBot(botId);
	if (!bot) return null;
	return readBotFile(botId, PERSONALITY_PATH, seedText(bot.name, bot.persona));
}

export async function writePersonality(botId: string, content: string): Promise<void> {
	return writeBotFile(botId, PERSONALITY_PATH, content);
}

export async function readScratchpad(botId: string): Promise<string | null> {
	return readBotFile(botId, SCRATCHPAD_PATH, SCRATCHPAD_SEED);
}

export async function writeScratchpad(botId: string, content: string): Promise<void> {
	return writeBotFile(botId, SCRATCHPAD_PATH, content);
}

/**
 * Add one line to the scratchpad without losing what is there: read, append,
 * write back. Last write wins on a race - a note mirrored twice is worth more
 * than a lock the drive cannot give us.
 */
export async function appendScratchpad(botId: string, line: string): Promise<void> {
	const existing = (await readScratchpad(botId)) ?? SCRATCHPAD_SEED;
	const text = existing.endsWith('\n') ? existing + line + '\n' : `${existing}\n${line}\n`;
	await writeScratchpad(botId, text);
}

export async function readAccounts(botId: string): Promise<string | null> {
	return readBotFile(botId, ACCOUNTS_PATH, ACCOUNTS_SEED);
}

export async function writeAccounts(botId: string, content: string): Promise<void> {
	return writeBotFile(botId, ACCOUNTS_PATH, content);
}

/**
 * The bot's page in the company directory on the shared company drive
 * (`/company/directory/<botId>.md`): what the human keeps on it, shown in its
 * card. Seeded from the persona on first read like the drive files above, but
 * it lives on the company volume because it is about the workplace, not the bot.
 */
export async function readDirectoryProfile(botId: string): Promise<string | null> {
	const bot = getBot(botId);
	if (!bot) return null;
	const path = `directory/${botId}.md`;
	const existing = await readFile(COMPANY_VOLUME, path);
	if (existing !== null) return existing;
	const seed = `# ${bot.name}\n\n${bot.persona || 'A bot of the lounge.'}\n`;
	await writeFile(COMPANY_VOLUME, path, seed);
	return seed;
}

export async function writeDirectoryProfile(botId: string, content: string): Promise<void> {
	if (!getBot(botId)) throw new Error('bot not found');
	await writeFile(COMPANY_VOLUME, `directory/${botId}.md`, content);
}
