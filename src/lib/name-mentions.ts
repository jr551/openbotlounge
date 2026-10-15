/**
 * Plain-text name mentions: a bot's name written without the @, like "I
 * talked to Pook about it". The thread tints those so a name in prose reads
 * as the bot, not just a word - quieter than the @mention pill, which stays
 * the marker of an actual ping.
 *
 * The same regex caveat as mentionRegex applies: a /g pattern carries
 * lastIndex between .test() calls, so callers use matchAll (or the segment
 * helper below, which does it for them).
 */

export interface NameMentionSegment {
	text: string;
	/** True when this segment is a bot's name and should be tinted. */
	name: boolean;
}

/** The least a bot needs to be tintable by name. */
export interface NameMentionBot {
	name: string;
	color?: string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The bare-name pattern: any bot's name, case-insensitive, on a word
 * boundary - so "Pook" lights up but "Pookerville" does not - and never
 * straight after an @, where the mention chip already owns the text. \b is
 * ASCII-only, so the boundaries here are spelled out with unicode classes.
 */
export function nameMentionRegex(names: string[]): RegExp {
	const escaped = names
		.filter(Boolean)
		.map(escapeRe)
		// Longest first, so "Pook Two" wins over "Pook" when both are bots.
		.sort((a, b) => b.length - a.length);
	if (!escaped.length) return /$^/g;
	return new RegExp(`(?<![@\\p{L}\\p{N}\\p{M}_])(${escaped.join('|')})(?![\\p{L}\\p{N}\\p{M}_])`, 'giu');
}

/**
 * Text that must not be tinted: code spans and fenced blocks, markdown
 * links, URLs and addresses. On rendered markdown these are already elements
 * the DOM walk skips; on raw text (the user's own bubble) this pattern is
 * the only thing standing between a name and a tint inside `code`.
 */
const SKIP_RE =
	/```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s)]+|\S+@\S+\.\S+/g;

/** Split text into plain and bot-name segments. */
export function nameMentionSegments(text: string, names: string[]): NameMentionSegment[] {
	const nameRe = nameMentionRegex(names);
	const segments: NameMentionSegment[] = [];
	const pushText = (s: string) => {
		if (!s) return;
		const last = segments[segments.length - 1];
		if (last && !last.name) last.text += s;
		else segments.push({ text: s, name: false });
	};
	let pos = 0;
	for (const skip of text.matchAll(SKIP_RE)) {
		const idx = skip.index ?? 0;
		pushNameRuns(text.slice(pos, idx), nameRe, segments, pushText);
		pushText(skip[0]);
		pos = idx + skip[0].length;
	}
	pushNameRuns(text.slice(pos), nameRe, segments, pushText);
	return segments;
}

function pushNameRuns(
	chunk: string,
	nameRe: RegExp,
	segments: NameMentionSegment[],
	pushText: (s: string) => void
) {
	let last = 0;
	for (const match of chunk.matchAll(nameRe)) {
		const idx = match.index ?? 0;
		pushText(chunk.slice(last, idx));
		segments.push({ text: match[0], name: true });
		last = idx + match[0].length;
	}
	pushText(chunk.slice(last));
}

/**
 * Svelte action: tint every bare bot name under the node. Runs on the
 * rendered DOM, like the @mention pass, so it works inside paragraphs and
 * lists without touching the markdown source - and it skips code, links and
 * anything already chipped, so a real @Pook keeps its pill.
 */
export function nameMentions(node: HTMLElement, bots: NameMentionBot[]) {
	const paint = (list: NameMentionBot[]) => {
		const byName = new Map(list.map((b) => [b.name.toLowerCase(), b]));
		const re = nameMentionRegex(list.map((b) => b.name));
		const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
		const targets: Text[] = [];
		let t: Text | null;
		while ((t = walker.nextNode() as Text | null)) {
			// Code and links are quoted verbatim; a name inside them is text,
			// not a reference. .mention is the @ pill and .name-mention is our
			// own work - both are already spoken for.
			if (t.parentElement?.closest('code, pre, a, .mention, .name-mention')) continue;
			if ([...(t.nodeValue?.matchAll(re) ?? [])].length) targets.push(t);
		}
		for (const textNode of targets) {
			const frag = document.createDocumentFragment();
			let last = 0;
			const value = textNode.nodeValue ?? '';
			for (const match of value.matchAll(re)) {
				const idx = match.index ?? 0;
				if (idx > last) frag.append(document.createTextNode(value.slice(last, idx)));
				const chip = document.createElement('span');
				chip.className = 'name-mention';
				chip.textContent = match[0];
				const color = byName.get(match[0].toLowerCase())?.color;
				if (color) chip.style.setProperty('--nm', color);
				frag.append(chip);
				last = idx + match[0].length;
			}
			if (last < value.length) frag.append(document.createTextNode(value.slice(last)));
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	};
	paint(bots);
	return {
		update(next: NameMentionBot[]) {
			paint(next);
		}
	};
}
