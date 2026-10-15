import { COMPANY_VOLUME } from './docker';
import { listDir, readFile, writeFile } from './mounts';
import type { Bot } from './db';

/**
 * The staff board on the shared drive: one ABOUT-<name>.md per bot in
 * /company, so a bot can read who it works with through the same file tools it
 * reads anything else with. The app keeps the files seeded - a bot that never
 * wrote one still has a page with its persona on it - and a bot can rewrite
 * its own from inside its machine, which is the point of it living on the
 * drive rather than in the database.
 */

/** The filename a bot's profile lives under; the name is slugged for it. */
export function profilePath(bot: Pick<Bot, 'name'>): string {
	const slug = bot.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
	return `ABOUT-${slug}.md`;
}

/**
 * Make sure a bot's page exists on /company. Writes only when the file is
 * missing - a page the bot rewrote itself is its own and is never overwritten.
 * Best-effort: the drive may be unreachable, and a missing profile must never
 * stop a wake or a save.
 */
export async function ensureCompanyProfile(bot: Bot): Promise<void> {
	const path = profilePath(bot);
	try {
		const existing = await readFile(COMPANY_VOLUME, path);
		if (existing !== null) return;
		await writeFile(
			COMPANY_VOLUME,
			path,
			`# ${bot.name}\n\n${bot.persona || 'A bot of the lounge.'}\n`
		);
	} catch {
		// The drive is a convenience, not a dependency: a failed seed is a
		// missing file, not a failed wake.
	}
}

/** Every profile on the board, as {name, content} pairs for the tool result. */
export async function companyProfiles(): Promise<{ name: string; content: string }[]> {
	try {
		const { entries } = await listDir(COMPANY_VOLUME, '');
		const out: { name: string; content: string }[] = [];
		for (const e of entries) {
			if (e.dir || !/^ABOUT-.+\.md$/.test(e.name)) continue;
			const content = await readFile(COMPANY_VOLUME, e.name);
			if (content !== null) out.push({ name: e.name, content });
		}
		return out;
	} catch {
		return [];
	}
}
