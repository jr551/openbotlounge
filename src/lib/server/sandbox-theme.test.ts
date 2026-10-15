import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createBot, logActivity, setMemory } from './db';
import {
	CURSOR_EDGE,
	CURSOR_FILL,
	CURSOR_SIZE,
	CURSOR_THEME,
	SCREEN_HEIGHT,
	SCREEN_WIDTH,
	SUBJECTS,
	THEME_DIR,
	botPalette,
	cursorFiles,
	contrast,
	deriveSubject,
	drawWallpaper,
	sandboxSkin,
	subjectText,
	themeManifest,
	wallpaperCommand,
	type Rgb
} from './sandbox-theme';

/**
 * The skin is what makes a sandbox look like its bot, so these tests are about
 * the two things that can silently go wrong: colours that make text unreadable,
 * and a picture or archive that is not the shape the rest of the system thinks
 * it is.
 */

/** Colours a bot can actually be given, including the ones that are hardest to theme. */
const COLOURS = [
	'#8a8a93', // the database default, near-grey
	'#ff4400',
	'#ffd400', // light and saturated: black text, not white
	'#0033aa',
	'#101014', // almost black
	'#ffffff',
	'#22aa55',
	'#7a4fd0'
];

/** A minimal PNG reader: enough to prove the bytes are a real image. */
function decodePng(png: Buffer): { width: number; height: number; pixels: Buffer } {
	expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	let at = 8;
	let width = 0;
	let height = 0;
	const idat: Buffer[] = [];
	while (at + 8 <= png.length) {
		const length = png.readUInt32BE(at);
		const type = png.toString('latin1', at + 4, at + 8);
		const data = png.subarray(at + 8, at + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			expect(data[8]).toBe(8); // bit depth
			expect(data[9]).toBe(2); // truecolour
		}
		if (type === 'IDAT') idat.push(data);
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 3;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		// Rows use the Sub filter, so each byte is a delta from its left neighbour.
		expect(raw[y * (stride + 1)]).toBe(1);
		for (let i = 0; i < stride; i++) {
			const left = i >= 3 ? pixels[y * stride + i - 3] : 0;
			pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + left) & 255;
		}
	}
	return { width, height, pixels };
}

function pixelAt(pixels: Buffer, x: number, y: number): [number, number, number] {
	const at = (y * SCREEN_WIDTH + x) * 3;
	return [pixels[at], pixels[at + 1], pixels[at + 2]];
}

function nearColour(pixels: Buffer, x: number, y: number, colour: Rgb): number {
	const got = pixelAt(pixels, x, y);
	return Math.max(
		Math.abs(got[0] - colour.r),
		Math.abs(got[1] - colour.g),
		Math.abs(got[2] - colour.b)
	);
}

/** Every distinct colour in a sampled region, for "is anything actually drawn there?". */
function coloursIn(pixels: Buffer, fromY: number, toY: number): Set<string> {
	const seen = new Set<string>();
	for (let y = fromY; y < toY; y += 3) {
		for (let x = 0; x < SCREEN_WIDTH; x += 3) seen.add(pixelAt(pixels, x, y).join(','));
	}
	return seen;
}

describe('botPalette', () => {
	it('keeps every text colour legible on the surface it sits on', () => {
		// The bot takes screenshots of its own screen: a tab title or a new tab
		// link it cannot read is a real failure, not a cosmetic one.
		for (const colour of COLOURS) {
			const palette = botPalette(colour);
			expect(contrast(palette.tabText, palette.frame), colour).toBeGreaterThanOrEqual(4.5);
			expect(contrast(palette.tabText, palette.toolbar), colour).toBeGreaterThanOrEqual(4.5);
			expect(contrast(palette.ntpText, palette.sky), colour).toBeGreaterThanOrEqual(4.5);
			expect(contrast(palette.ntpLink, palette.sky), colour).toBeGreaterThanOrEqual(4.5);
			// The colours Chrome actually draws its new tab with, read off the live
			// page (#1f1f1f and #0b57d0 - it ignores a theme's own ntp_* keys), have
			// to be legible on the pale band the picture puts under them.
			expect(contrast({ r: 0x1f, g: 0x1f, b: 0x1f }, palette.sky), colour).toBeGreaterThanOrEqual(4.5);
			expect(contrast({ r: 0x0b, g: 0x57, b: 0xd0 }, palette.sky), colour).toBeGreaterThanOrEqual(4.5);
		}
	});

	it('uses the bot colour itself, not a colour of its own choosing', () => {
		// A blue bot must not come out green: the frame keeps the given hue.
		const hueOf = ({ r, g, b }: Rgb): number => {
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			if (max === min) return 0;
			const d = max - min;
			const raw = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
			return raw / 6;
		};
		for (const colour of ['#ff4400', '#0033aa', '#22aa55', '#7a4fd0']) {
			const palette = botPalette(colour);
			const delta = Math.abs(hueOf(palette.frame) - hueOf(palette.base));
			expect(Math.min(delta, 1 - delta), colour).toBeLessThan(0.02);
		}
	});

	it('stays grey when the bot is grey', () => {
		// Boosting saturation off a zero hue would invent a colour the bot was
		// never given.
		const { r, g, b } = botPalette('#8a8a93').frame;
		expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(12);
	});

	it('falls back to the default colour rather than throwing on nonsense', () => {
		expect(botPalette('not a colour')).toEqual(botPalette('#8a8a93'));
	});
});

describe('drawWallpaper', () => {
	it('draws the screen-sized picture in the bot palette', () => {
		const palette = botPalette('#ff4400');
		const subject = SUBJECTS.find((s) => s.id === 'peaks')!;
		const { width, height, pixels } = decodePng(drawWallpaper(palette, subject, 'bot-a'));

		expect([width, height]).toEqual([SCREEN_WIDTH, SCREEN_HEIGHT]);
		// Down the middle of the screen the backdrop is the palette's gradient,
		// top to bottom; the corners are darker by design (the vignette).
		expect(nearColour(pixels, SCREEN_WIDTH / 2, 0, palette.sky)).toBeLessThan(8);
		expect(nearColour(pixels, SCREEN_WIDTH / 2, SCREEN_HEIGHT - 1, palette.wallBottom)).toBeLessThan(8);
		// And the subject is drawn over it: the lower band is not bare backdrop.
		const lower = coloursIn(pixels, Math.floor(SCREEN_HEIGHT * 0.62), SCREEN_HEIGHT - 40);
		expect(lower.size).toBeGreaterThan(60);
		let ink = 0;
		for (let y = Math.floor(SCREEN_HEIGHT * 0.62); y < SCREEN_HEIGHT - 40; y++) {
			for (let x = 0; x < SCREEN_WIDTH; x += 2) {
				const got = pixelAt(pixels, x, y);
				const near = [got[0] - palette.accent.r, got[1] - palette.accent.g, got[2] - palette.accent.b];
				if (Math.max(...near.map(Math.abs)) < 24) ink++;
			}
		}
		expect(ink).toBeGreaterThan(500);
	});

	it(
		'is the same picture every time, for the same bot',
		() => {
			// A sandbox that is rebuilt must look like the one it replaced, so
			// nothing here may depend on a random number.
			const subject = SUBJECTS.find((s) => s.id === 'peaks')!;
			const first = drawWallpaper(botPalette('#22aa55'), subject, 'bot-stable');
			expect(drawWallpaper(botPalette('#22aa55'), subject, 'bot-stable')).toEqual(first);
			// Two bots with the same colour and interest still differ, because the
			// placements are seeded from the bot rather than from chance.
			expect(drawWallpaper(botPalette('#22aa55'), subject, 'bot-one')).not.toEqual(
				drawWallpaper(botPalette('#22aa55'), subject, 'bot-two')
			);
		},
		// Rendering three wallpapers is real CPU; the default 5s is tight under load.
		30_000
	);
});

describe('deriveSubject', () => {
	it('picks the subject a bot actually talks about', () => {
		expect(deriveSubject('I spend my evenings sailing and watching the tide come in').id).toBe('waves');
		expect(deriveSubject('Another day debugging a compiler bug in the kernel').id).toBe('code');
		expect(deriveSubject('my cat sits on the keyboard while I work').id).toBe('cats');
		expect(deriveSubject('proof by induction, then a game of chess').id).toBe('maths');
	});

	it('lets a bot identity outweigh a passing mention', () => {
		// A bot whose persona is music should not be themed on the one time it
		// mentioned coffee, which is why the persona counts for more.
		const bot = createBot({ name: 'hum', persona: '', avatar: '', color: '#8a8a93', model: '', badge: '' });
		for (let i = 0; i < 3; i++) setMemory(bot.id, `taste-${i}`, 'guitar, bass and jazz records all day');
		setMemory(bot.id, 'practice', 'music practice: piano scales and singing');
		logActivity(bot.id, 'chat', 'had a coffee while tuning the guitar');

		expect(deriveSubject(subjectText(bot.id)).id).toBe('music');
	});

	it('falls back to a picture rather than nothing', () => {
		const bot = createBot({ name: 'plain', persona: '', avatar: '', color: '#8a8a93', model: '', badge: '' });
		expect(deriveSubject(subjectText(bot.id)).id).toBe(SUBJECTS[0].id);
	});
});

describe('the bundle a sandbox is given', () => {
	/** Read a ustar archive the way Docker's archive endpoint does. */
	function readTar(bundle: Buffer): Record<string, Buffer> {
		const files: Record<string, Buffer> = {};
		for (let at = 0; at + 512 <= bundle.length; ) {
			const header = bundle.subarray(at, at + 512);
			const name = header.toString('latin1', 0, header.indexOf(0)).trim();
			if (!name) break;
			const size = Number.parseInt(header.toString('latin1', 124, 136).trim(), 8);
			files[name] = bundle.subarray(at + 512, at + 512 + size);
			at += 512 + Math.ceil(size / 512) * 512;
		}
		return files;
	}

	it('carries the theme and the wallpaper Chrome is told to load', async () => {
		const bot = createBot({
			name: 'tide',
			persona: 'a sailor who reads tide tables',
			avatar: '',
			color: '#0033aa',
			model: '',
			badge: ''
		});
		const skin = await sandboxSkin(bot.id);
		expect(skin).not.toBeNull();
		if (!skin) return;
		expect(skin.subject.id).toBe('waves');

		// The archive Docker unpacks at / must hold the theme directory Chrome is
		// pointed at, with both files whole.
		const files = readTar(skin.bundle);
		expect(Object.keys(files)).toEqual(
			expect.arrayContaining(['obl-theme/manifest.json', 'obl-theme/wall.png'])
		);

		const manifest = JSON.parse(files['obl-theme/manifest.json'].toString()) as {
			name: string;
			theme: { colors: Record<string, unknown>; images: Record<string, string>; properties: Record<string, string> };
		};
		expect(manifest.name).toContain('tide');
		expect(manifest.theme.images.theme_ntp_background).toBe('wall.png');
		expect(manifest.theme.properties.ntp_background_alignment).toBe('bottom');
		expect(manifest.theme.colors.frame).toHaveLength(3);

		const { width, height } = decodePng(files['obl-theme/wall.png']);
		expect([width, height]).toEqual([SCREEN_WIDTH, SCREEN_HEIGHT]);
	});

	it('points the wallpaper command at the unpacked picture, with the colour as a floor', () => {
		const palette = botPalette('#0033aa');
		const command = wallpaperCommand(palette);
		expect(command).toContain(`xsetroot -solid '${palette.wallSolid}'`);
		expect(command).toContain(`display -window root ${THEME_DIR}/wall.png`);
		// Bounded, so a wedged X client cannot hold the wake that runs it.
		expect(command).toContain('timeout');
	});
});

describe('the pointer', () => {
	/** Read back one Xcursor file the way libXcursor does. */
	function readXcursor(data: Buffer) {
		expect(data.toString('latin1', 0, 4)).toBe('Xcur');
		expect(data.readUInt32LE(4)).toBe(16); // header size
		expect(data.readUInt32LE(12)).toBe(1); // one table entry
		expect(data.readUInt32LE(16)).toBe(0xfffd0002); // an image
		const chunk = data.readUInt32LE(24);
		expect(data.readUInt32LE(chunk)).toBe(36); // chunk header size
		const [, size, , width, height, xhot, yhot] = [
			data.readUInt32LE(chunk + 4),
			data.readUInt32LE(chunk + 8),
			data.readUInt32LE(chunk + 12),
			data.readUInt32LE(chunk + 16),
			data.readUInt32LE(chunk + 20),
			data.readUInt32LE(chunk + 24),
			data.readUInt32LE(chunk + 28)
		];
		const pixels = data.subarray(chunk + 36);
		expect(pixels.length).toBe(width * height * 4);
		return { size, width, height, xhot, yhot, pixels };
	}

	const pixelAt = (pixels: Buffer, index: number) => {
		const argb = pixels.readUInt32LE(index * 4);
		return {
			a: (argb >>> 24) & 255,
			r: (argb >>> 16) & 255,
			g: (argb >>> 8) & 255,
			b: argb & 255
		};
	};

	it('draws one pink pointer at a normal desktop size, the same in every sandbox', () => {
		const files = cursorFiles();
		const arrow = files.find((f) => f.name.endsWith('/left_ptr'));
		expect(arrow?.data).toBeTruthy();
		const image = readXcursor(arrow!.data!);

		expect([image.width, image.height]).toEqual([CURSOR_SIZE, CURSOR_SIZE]);
		expect(image.size).toBe(CURSOR_SIZE);
		// The range every desktop draws its pointer in. A pointer much larger
		// than this is in the way when you are the one driving the machine.
		expect(CURSOR_SIZE).toBeGreaterThanOrEqual(16);
		expect(CURSOR_SIZE).toBeLessThanOrEqual(32);
		// The hot spot is the arrow's tip, not its centre, or clicks land wrong.
		expect(image.xhot).toBeLessThan(image.width / 4);
		expect(image.yhot).toBeLessThan(image.height / 4);

		// The body is the fixed pink and it is solid enough to see: premultiplied
		// by alpha, so undo that before comparing. The white edge is a ring around
		// the fill, so the fill has to be the commonest colour of the shape - an
		// assertion that holds at any pointer size, unlike a share of the pixels,
		// which antialiasing moves as the art gets smaller.
		let opaque = 0;
		const tally = new Map<string, number>();
		for (let i = 0; i < image.width * image.height; i++) {
			const { a, r, g, b } = pixelAt(image.pixels, i);
			if (a < 200) continue;
			opaque++;
			const key = [r, g, b]
				.map((channel, c) => Math.round((channel * 255) / a))
				.join(',');
			tally.set(key, (tally.get(key) ?? 0) + 1);
		}
		expect(opaque).toBeGreaterThan(CURSOR_SIZE * CURSOR_SIZE * 0.06);
		const commonest = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
		const fill = [CURSOR_FILL.r, CURSOR_FILL.g, CURSOR_FILL.b];
		const commonestRgb = commonest[0].split(',').map(Number);
		expect(
			commonestRgb.every((channel, c) => Math.abs(channel - fill[c]) < 6),
			`commonest colour was ${commonest[0]}`
		).toBe(true);
		// The tip is opaque, so the pointer is where the bot thinks it is.
		expect(pixelAt(image.pixels, image.yhot * image.width + image.xhot).a).toBe(255);
	});

	it('themes every name a browser asks for, and its own text cursor too', () => {
		const files = cursorFiles();
		const byName = new Map(files.map((f) => [f.name, f]));
		for (const name of ['left_ptr', 'default', 'pointer', 'hand2', 'crosshair', 'xterm', 'text']) {
			expect(byName.has(`obl-theme/cursors/${CURSOR_THEME}/cursors/${name}`), name).toBe(true);
		}
		// Aliases are links, not copies: the same bytes for every name would be
		// half a megabyte of archive for nothing.
		const alias = byName.get(`obl-theme/cursors/${CURSOR_THEME}/cursors/default`);
		expect(alias?.link).toBe('left_ptr');
		expect(alias?.data).toBeUndefined();
		const text = byName.get(`obl-theme/cursors/${CURSOR_THEME}/cursors/text`);
		expect(text?.link).toBe('xterm');
		// And the theme names a fallback for anything it does not define.
		expect(byName.get(`obl-theme/cursors/${CURSOR_THEME}/index.theme`)?.data?.toString()).toContain('Inherits=Adwaita');
	});

	it('keeps the pointer a fixture, not a per-bot colour', () => {
		// The pointer is the same in every sandbox on purpose: it is the one
		// thing the bot should never have to think about.
		const first = cursorFiles().find((f) => f.name.endsWith('/left_ptr'));
		expect(cursorFiles().find((f) => f.name.endsWith('/left_ptr'))?.data).toEqual(first?.data);
		// And pink on pink still reads, because of the white edge.
		expect(contrast(CURSOR_EDGE, CURSOR_FILL)).toBeGreaterThanOrEqual(3);
		expect(contrast(CURSOR_FILL, { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(3);
	});
});

describe('themeManifest', () => {
	it('describes a theme Chrome can load', () => {
		const manifest = themeManifest('ash', botPalette('#ff4400')) as {
			manifest_version: number;
			name: string;
			theme: { colors: Record<string, number[]> };
		};
		expect(manifest.manifest_version).toBe(3);
		expect(manifest.name).toContain('ash');
		// Every colour is an [r, g, b] triple: Chrome rejects anything else.
		for (const [key, value] of Object.entries(manifest.theme.colors)) {
			expect(value, key).toHaveLength(3);
			for (const channel of value) expect(Number.isInteger(channel) && channel >= 0 && channel <= 255).toBe(true);
		}
	});
});
