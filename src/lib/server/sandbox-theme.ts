/**
 * A sandbox that looks like its bot.
 *
 * What the image gives us is a blank one: Xvnc on :99, openbox (which draws no
 * wallpaper) and Chrome, whose own chrome is unthemed. Nothing in the image can
 * theme a *running* Chrome - the only way in is `--load-extension` at launch,
 * and Chrome reads that flag once, before anything of ours has run inside the
 * container. So the skin is built here and unpacked into the container while it
 * is still created-but-stopped (see `sandbox.ts`), and the picture half of it
 * is painted onto the X root window after the container starts.
 *
 * Everything in here is deterministic: a bot's colour and what it talks about
 * decide the result, never a random number, so a sandbox that is rebuilt looks
 * the same as the one it replaced.
 */
import { deflateSync } from 'node:zlib';
import { getBot, listActivities, listMemories } from './db';

/** Where a bot's skin is unpacked inside its sandbox; Chrome loads it from here. */
export const THEME_DIR = '/opt/obl-theme';

/**
 * The sandbox screen. Xvnc is fixed at this size by the image, and the
 * wallpaper is drawn at exactly this size so `display -window root` neither
 * tiles nor scales it.
 */
export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 1024;

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** The database default, and the colour a bot with an unusable one falls back to. */
const FALLBACK_COLOUR = '#8a8a93';

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function hexToRgb(hex: string): Rgb {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hexToRgb(FALLBACK_COLOUR);
	const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
	const n = Number.parseInt(digits, 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: Rgb): string {
	const part = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
	return `#${part(r)}${part(g)}${part(b)}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
	const rr = r / 255;
	const gg = g / 255;
	const bb = b / 255;
	const max = Math.max(rr, gg, bb);
	const min = Math.min(rr, gg, bb);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const hue =
		max === rr ? ((gg - bb) / d + (gg < bb ? 6 : 0)) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
	return [hue / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
	const hue = ((h % 1) + 1) % 1;
	if (s <= 0) {
		const v = l * 255;
		return { r: v, g: v, b: v };
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const channel = (t: number): number => {
		let tt = t;
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};
	return { r: channel(hue + 1 / 3) * 255, g: channel(hue) * 255, b: channel(hue - 1 / 3) * 255 };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
	const lin = (v: number) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 (invisible) to 21 (black on white). */
export function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of black or white reads better on this background. */
function bestInk(bg: Rgb): Rgb {
	return contrast(bg, BLACK) >= contrast(bg, WHITE) ? BLACK : WHITE;
}

/**
 * Nudge a colour until it reads on `bg`: `adjust` is applied repeatedly until
 * the pair reaches `ratio`, or gives up after eight steps.
 */
function legible(colour: Rgb, bg: Rgb, ratio: number, adjust: (c: Rgb) => Rgb): Rgb {
	for (let step = 0; step < 8 && contrast(colour, bg) < ratio; step++) colour = adjust(colour);
	return colour;
}

/**
 * A fill of the bot's own hue, and the text colour to sit on it.
 *
 * Colours are chosen so the pair is legible rather than pretty: start at the
 * most vivid lightness for the hue, ask which ink reads best on it, and if that
 * pair is short of WCAG's 4.5:1, walk the lightness away from the ink (darker
 * under white text, lighter under black) until it passes. A hue with any
 * saturation can always reach 4.5:1 this way; the ladder is bounded so it
 * cannot spin.
 */
function fillWithInk(h: number, s: number): { fill: Rgb; ink: Rgb } {
	let fill = hslToRgb(h, s, 0.5);
	let ink = bestInk(fill);
	for (let step = 1; step <= 15 && contrast(fill, ink) < 4.5; step++) {
		const away = ink === WHITE ? -0.03 : 0.03;
		fill = hslToRgb(h, s, clamp(0.5 + away * step, 0.06, 0.94));
		ink = bestInk(fill);
	}
	return { fill, ink };
}

export interface BotPalette {
	/** The colour the bot was given, untouched. */
	base: Rgb;
	frame: Rgb;
	frameInactive: Rgb;
	toolbar: Rgb;
	tabText: Rgb;
	/** Motif ink, drawn on the dark lower band of the picture. */
	accent: Rgb;
	/** The pale band across the top of the picture. */
	sky: Rgb;
	/** The dark the picture settles into. */
	wallBottom: Rgb;
	/** Flat stand-in for the picture, for `xsetroot` and for a missing image. */
	wallSolid: string;
	ntp: Rgb;
	ntpText: Rgb;
	ntpLink: Rgb;
}

/**
 * Derive the whole palette from the bot's colour.
 *
 * The frame keeps the bot's own hue and saturation so it reads as *that* bot's
 * colour, and only its lightness is spent on legibility. Grey bots stay grey:
 * saturation is nudged up a little for colour that is nearly grey, but a
 * colourless one is not given a hue it never had, which would be a lie about
 * the bot.
 *
 * The picture is pale at the top and dark at the bottom, and that split is
 * about Chrome rather than art. Chrome's new tab draws its own text - the two
 * links in its top corner, the page heading - in its light-theme colours
 * (#1f1f1f and #0b57d0; read off the live page's computed styles), and it
 * ignores a theme's own ntp_text/ntp_link keys entirely: setting them to
 * markers proves they never reach the page. Those dark colours have to land on
 * something pale to be readable, so the top of the picture is a wash of the
 * bot's hue and the motif lives on the dark band below it.
 */
export function botPalette(color: string): BotPalette {
	const base = hexToRgb(color);
	const [h, s] = rgbToHsl(base);
	const sat = s < 0.06 ? s : Math.min(1, s * 1.15 + 0.05);
	const { fill: frame, ink: tabText } = fillWithInk(h, sat);
	// The toolbar sits a shade off the frame, as it does in Chrome's own themes -
	// and always away from the text colour, so it cannot cost legibility.
	const toolbar = mix(frame, tabText === WHITE ? BLACK : WHITE, 0.1);
	const frameInactive = mix(hslToRgb(h, sat * 0.55, 0.34), BLACK, 0.15);

	// The pale band has to clear not just its own text colour but Chrome's two:
	// a bluish sky still sits close to Chrome's link blue, so it is lightened
	// until both of them pass.
	let sky = hslToRgb(h, sat * 0.3, 0.88);
	const chromeNtpInks: Rgb[] = [
		{ r: 0x1f, g: 0x1f, b: 0x1f },
		{ r: 0x0b, g: 0x57, b: 0xd0 }
	];
	for (let step = 1; step <= 8 && chromeNtpInks.some((ink) => contrast(ink, sky) < 4.5); step++) {
		sky = hslToRgb(h, sat * 0.3 * (1 - step / 8), Math.min(0.97, 0.88 + step * 0.015));
	}
	const wallBottom = hslToRgb(h, sat * 0.85, 0.06);
	const ntpText = bestInk(sky);
	const ntpLink = legible(hslToRgb(h, Math.min(1, sat), 0.32), sky, 4.5, (c) => mix(c, BLACK, 0.2));
	// Motif ink that vanishes into the background is not a picture.
	const accent = legible(hslToRgb(h, Math.min(1, sat * 0.9 + 0.1), 0.58), wallBottom, 3, (c) =>
		mix(c, WHITE, 0.25)
	);

	return {
		base,
		frame,
		frameInactive,
		toolbar,
		tabText,
		accent,
		sky,
		wallBottom,
		wallSolid: toHex(sky),
		ntp: sky,
		ntpText,
		ntpLink
	};
}

// ---------------------------------------------------------------- the picture

/**
 * A tiny RGB raster with just the primitives the motifs need.
 *
 * Round shapes are drawn with coverage taken from their distance field, so they
 * come out antialiased without a supersampled buffer (the wallpaper is 3.9MB of
 * pixels already); triangles are sampled on a 2x2 grid for the same reason.
 */
class Raster {
	readonly width: number;
	readonly height: number;
	/** 3 for an opaque picture, 4 for the pointer, which needs transparency. */
	readonly channels: number;
	readonly px: Uint8Array;

	constructor(width: number, height: number, channels: 3 | 4 = 3) {
		this.width = width;
		this.height = height;
		this.channels = channels;
		this.px = new Uint8Array(width * height * channels);
	}

	/** Blend `colour` into the pixel at (x, y), `alpha` of the way. */
	blend(x: number, y: number, colour: Rgb, alpha: number): void {
		if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		const a = Math.min(1, alpha);
		const at = (y * this.width + x) * this.channels;
		this.px[at] += (colour.r - this.px[at]) * a;
		this.px[at + 1] += (colour.g - this.px[at + 1]) * a;
		this.px[at + 2] += (colour.b - this.px[at + 2]) * a;
		// A transparent canvas starts at zero alpha, so this is also the coverage
		// of the shape drawn so far.
		if (this.channels === 4) this.px[at + 3] += (255 - this.px[at + 3]) * a;
	}

	private paint(
		x0: number,
		y0: number,
		x1: number,
		y1: number,
		colour: Rgb,
		coverage: (x: number, y: number) => number
	): void {
		const left = Math.max(0, Math.floor(x0));
		const top = Math.max(0, Math.floor(y0));
		const right = Math.min(this.width, Math.ceil(x1));
		const bottom = Math.min(this.height, Math.ceil(y1));
		for (let y = top; y < bottom; y++) {
			for (let x = left; x < right; x++) {
				const c = coverage(x + 0.5, y + 0.5);
				if (c > 0) this.blend(x, y, colour, c);
			}
		}
	}

	/**
	 * Vertical gradient through colour stops, `at` measured from the top. One
	 * pass, one colour per row: a backdrop wants nothing else.
	 */
	verticalGradient(stops: { at: number; colour: Rgb }[]): void {
		for (let y = 0; y < this.height; y++) {
			const t = y / (this.height - 1);
			let index = 0;
			while (index + 2 < stops.length && t > stops[index + 1].at) index++;
			const from = stops[index];
			const to = stops[index + 1] ?? from;
			const span = to.at - from.at || 1;
			const colour = mix(from.colour, to.colour, clamp((t - from.at) / span, 0, 1));
			const row = y * this.width * this.channels;
			for (let x = 0; x < this.width; x++) {
				const at = row + x * this.channels;
				this.px[at] = colour.r;
				this.px[at + 1] = colour.g;
				this.px[at + 2] = colour.b;
				if (this.channels === 4) this.px[at + 3] = 255;
			}
		}
	}

	disc(cx: number, cy: number, r: number, colour: Rgb, alpha = 1): void {
		const pad = r + 1;
		this.paint(cx - pad, cy - pad, cx + pad, cy + pad, colour, (x, y) => {
			const d = Math.hypot(x - cx, y - cy);
			return alpha * clamp(r + 0.5 - d, 0, 1);
		});
	}

	ellipse(cx: number, cy: number, rx: number, ry: number, colour: Rgb, alpha = 1, angle = 0): void {
		const pad = Math.max(rx, ry) + 1;
		const cos = Math.cos(-angle);
		const sin = Math.sin(-angle);
		this.paint(cx - pad, cy - pad, cx + pad, cy + pad, colour, (x, y) => {
			const dx = x - cx;
			const dy = y - cy;
			const u = (dx * cos - dy * sin) / rx;
			const v = (dx * sin + dy * cos) / ry;
			// Distance-to-edge in normalised units, converted back to pixels.
			const scale = Math.min(rx, ry);
			return alpha * clamp((1 - Math.hypot(u, v)) * scale + 0.5, 0, 1);
		});
	}

	line(x0: number, y0: number, x1: number, y1: number, width: number, colour: Rgb, alpha = 1): void {
		const pad = width / 2 + 1;
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len2 = dx * dx + dy * dy || 1;
		this.paint(
			Math.min(x0, x1) - pad,
			Math.min(y0, y1) - pad,
			Math.max(x0, x1) + pad,
			Math.max(y0, y1) + pad,
			colour,
			(x, y) => {
				const t = clamp(((x - x0) * dx + (y - y0) * dy) / len2, 0, 1);
				const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
				return alpha * clamp(width / 2 + 0.5 - d, 0, 1);
			}
		);
	}

	triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, colour: Rgb, alpha = 1): void {
		const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		if (area === 0) return;
		const sign = Math.sign(area);
		const inside = (x: number, y: number): boolean => {
			const s1 = sign * ((bx - ax) * (y - ay) - (by - ay) * (x - ax));
			const s2 = sign * ((cx - bx) * (y - by) - (cy - by) * (x - bx));
			const s3 = sign * ((ax - cx) * (y - cy) - (ay - cy) * (x - cx));
			return s1 >= 0 && s2 >= 0 && s3 >= 0;
		};
		this.paint(Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.max(ax, bx, cx), Math.max(ay, by, cy), colour, (x, y) => {
			let hits = 0;
			for (const [ox, oy] of [
				[-0.25, -0.25],
				[0.25, -0.25],
				[-0.25, 0.25],
				[0.25, 0.25]
			]) {
				if (inside(x + ox, y + oy)) hits++;
			}
			return (alpha * hits) / 4;
		});
	}

	band(y0: number, y1: number, colour: Rgb, alpha = 1): void {
		this.paint(0, y0, this.width, y1, colour, () => alpha);
	}

	/**
	 * A polygon, fanned from its first point. Every shape drawn here - the
	 * pointer's arrow - is star-shaped from that point, so the fan stays inside
	 * it.
	 */
	polygon(points: [number, number][], colour: Rgb, alpha = 1): void {
		const [ax, ay] = points[0];
		for (let i = 1; i + 1 < points.length; i++) {
			this.triangle(ax, ay, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], colour, alpha);
		}
	}

	/** Truecolour 8-bit PNG. Rows use the Sub filter, which flattens gradients to nothing. */
	png(): Buffer {
		const stride = this.width * this.channels;
		const raw = Buffer.alloc((stride + 1) * this.height);
		for (let y = 0; y < this.height; y++) {
			const from = y * stride;
			const to = y * (stride + 1);
			raw[to] = 1;
			for (let i = 0; i < stride; i++) {
				raw[to + 1 + i] = (this.px[from + i] - (i >= this.channels ? this.px[from + i - this.channels] : 0)) & 255;
			}
		}
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(this.width, 0);
		ihdr.writeUInt32BE(this.height, 4);
		ihdr[8] = 8;
		ihdr[9] = this.channels === 4 ? 6 : 2;
		return Buffer.concat([
			PNG_SIGNATURE,
			pngChunk('IHDR', ihdr),
			pngChunk('IDAT', deflateSync(raw, { level: 9 })),
			pngChunk('IEND', Buffer.alloc(0))
		]);
	}
}

/** A deterministic sequence from a string - motif placement must not drift between wakes. */
function seeded(seed: string): () => number {
	let h = 2166136261;
	for (const ch of seed) {
		h ^= ch.codePointAt(0) ?? 0;
		h = Math.imul(h, 16777619);
	}
	let state = h >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

// ------------------------------------------------------------------- subjects

/**
 * The subjects a bot can be given a picture of.
 *
 * The words are matched against everything the bot has written or remembered,
 * longest match wins by count, and the order here breaks ties, so the same bot
 * always lands on the same subject.
 */
export interface Subject {
	id: string;
	/** Plural, for the log line and the tests. */
	label: string;
	words: string[];
	draw(raster: Raster, palette: BotPalette, seed: string): void;
}

/**
 * Motifs are drawn in the lower half: the new tab's logo and shortcuts sit
 * above them, and the dark the sky falls into starts at the horizon.
 */
const MOTIF_TOP = Math.round(SCREEN_HEIGHT * 0.62);
const MOTIF_BOTTOM = Math.round(SCREEN_HEIGHT * 0.9);

export const SUBJECTS: Subject[] = [
	{
		id: 'orbit',
		label: 'orbits and stars',
		words: ['space', 'orbit', 'astronomy', 'cosmos', 'galaxy', 'planet', 'telescope', 'satellite', 'star', 'star', 'nasa', 'apollo', 'rocket'],
		draw: (r, p, seed) => {
			const rand = seeded(seed);
			for (let i = 0; i < 90; i++) {
				const x = rand() * SCREEN_WIDTH;
				const y = MOTIF_TOP - 120 + rand() * (MOTIF_BOTTOM - MOTIF_TOP + 120);
				r.disc(x, y, 1 + rand() * 2.2, i % 7 === 0 ? p.accent : WHITE, 0.55 + rand() * 0.4);
			}
			const cx = SCREEN_WIDTH * (0.35 + rand() * 0.3);
			const cy = (MOTIF_TOP + MOTIF_BOTTOM) / 2;
			r.ellipse(cx, cy, 300, 96, p.accent, 0.5, -0.35);
			r.ellipse(cx, cy, 210, 62, WHITE, 0.22, -0.35);
			r.disc(cx, cy, 46, mix(p.accent, WHITE, 0.35), 0.95);
		}
	},
	{
		id: 'waves',
		label: 'the sea',
		words: ['sea', 'ocean', 'wave', 'tide', 'sail', 'boat', 'ship', 'fish', 'swim', 'surf', 'harbour', 'harbor', 'coast', 'beach', 'tidal', 'maritime', 'vessel', 'anchor', 'reef', 'whale'],
		draw: (r, p) => {
			for (let i = 0; i < 7; i++) {
				const base = MOTIF_TOP + 22 + i * 34;
				const amp = 16 + i * 2.5;
				let prevX = 0;
				let prevY = base;
				for (let x = 8; x <= SCREEN_WIDTH; x += 8) {
					const y = base + Math.sin(x / (52 + i * 6) + i) * amp;
					r.line(prevX, prevY, x, y, 3.2, i % 2 === 0 ? p.accent : mix(p.accent, WHITE, 0.5), 0.75 - i * 0.06);
					prevX = x;
					prevY = y;
				}
			}
			// A sail, because a bot that talks about the sea probably likes boats.
			const sx = SCREEN_WIDTH * 0.68;
			r.triangle(sx, MOTIF_TOP - 150, sx, MOTIF_TOP + 60, sx + 150, MOTIF_TOP + 60, mix(p.accent, WHITE, 0.25), 0.9);
			r.line(sx, MOTIF_TOP - 165, sx, MOTIF_TOP + 90, 6, WHITE, 0.8);
		}
	},
	{
		id: 'peaks',
		label: 'mountains',
		words: ['mountain', 'hike', 'hiking', 'climb', 'summit', 'ridge', 'alpine', 'trail', 'peak', 'valley', 'glacier', 'snowdon', 'cairn', 'fell', 'scree'],
		draw: (r, p, seed) => {
			const rand = seeded(seed);
			const baseY = MOTIF_BOTTOM;
			r.disc(SCREEN_WIDTH * (0.2 + rand() * 0.6), MOTIF_TOP - 90, 58, mix(p.accent, WHITE, 0.5), 0.85);
			for (let i = 0; i < 4; i++) {
				const cx = (i + rand() * 0.6) * (SCREEN_WIDTH / 4);
				const w = 240 + rand() * 200;
				const h = 200 + rand() * 220;
				const ink = i % 2 === 0 ? p.accent : mix(p.accent, p.wallBottom, 0.35);
				r.triangle(cx - w / 2, baseY, cx + w / 2, baseY, cx, baseY - h, ink, 0.9);
				r.triangle(cx - 22, baseY - h + 44, cx + 22, baseY - h + 44, cx, baseY - h, WHITE, 0.75);
			}
		}
	},
	{
		id: 'garden',
		label: 'plants',
		words: ['plant', 'garden', 'flower', 'seed', 'seedling', 'tree', 'herb', 'botany', 'moss', 'fern', 'leaf', 'leaves', 'soil', 'compost', 'bloom', 'petal', 'root', 'greenhouse', 'allotment'],
		draw: (r, p, seed) => {
			const rand = seeded(seed);
			for (let i = 0; i < 5; i++) {
				const x = (i + 0.5) * (SCREEN_WIDTH / 5) + (rand() - 0.5) * 60;
				const top = MOTIF_TOP + 40 + rand() * 60;
				const ink = i % 2 === 0 ? p.accent : mix(p.accent, WHITE, 0.45);
				r.line(x, MOTIF_BOTTOM, x, top, 5, ink, 0.85);
				for (let leaf = 0; leaf < 3; leaf++) {
					const y = top + 40 + leaf * 66;
					r.ellipse(x - 34, y, 36, 16, ink, 0.8, -0.5);
					r.ellipse(x + 34, y + 33, 36, 16, ink, 0.8, 0.5);
				}
				r.disc(x, top - 6, 20 + rand() * 10, mix(p.accent, WHITE, 0.6), 0.9);
			}
		}
	},
	{
		id: 'music',
		label: 'music',
		words: ['music', 'song', 'guitar', 'piano', 'band', 'melody', 'drum', 'jazz', 'synth', 'chord', 'tune', 'album', 'vinyl', 'sing', 'singing', 'choir', 'bass', 'riff', 'note'],
		draw: (r, p) => {
			for (let i = 0; i < 5; i++) {
				r.line(0, MOTIF_TOP + 10 + i * 34, SCREEN_WIDTH, MOTIF_TOP + 10 + i * 34, 2, mix(p.accent, WHITE, 0.35), 0.35);
			}
			for (const [i, x] of [0.28, 0.5, 0.72].entries()) {
				const gx = SCREEN_WIDTH * x;
				const gy = MOTIF_TOP + 40 + (i % 2) * 40;
				const ink = i === 1 ? mix(p.accent, WHITE, 0.4) : p.accent;
				r.ellipse(gx, gy + 96, 34, 25, ink, 0.95, -0.3);
				r.line(gx + 30, gy + 88, gx + 30, gy - 40, 6, ink, 0.95);
				r.line(gx + 30, gy - 40, gx + 84, gy - 12, 5, ink, 0.9);
			}
		}
	},
	{
		id: 'code',
		label: 'code',
		words: ['code', 'coding', 'compiler', 'bug', 'debug', 'terminal', 'server', 'linux', 'regex', 'refactor', 'kernel', 'database', 'sql', 'python', 'javascript', 'typescript', 'rust', 'git', 'api', 'schema', 'function', 'deploy', 'docker'],
		draw: (r, p, seed) => {
			const rand = seeded(seed);
			r.line(SCREEN_WIDTH * 0.2, MOTIF_TOP + 60, SCREEN_WIDTH * 0.34, MOTIF_TOP + 150, 10, p.accent, 0.9);
			r.line(SCREEN_WIDTH * 0.34, MOTIF_TOP + 150, SCREEN_WIDTH * 0.2, MOTIF_TOP + 240, 10, p.accent, 0.9);
			r.line(SCREEN_WIDTH * 0.8, MOTIF_TOP + 60, SCREEN_WIDTH * 0.66, MOTIF_TOP + 150, 10, p.accent, 0.9);
			r.line(SCREEN_WIDTH * 0.66, MOTIF_TOP + 150, SCREEN_WIDTH * 0.8, MOTIF_TOP + 240, 10, p.accent, 0.9);
			for (let i = 0; i < 7; i++) {
				const y = MOTIF_TOP + 30 + i * 40;
				const indent = 0.06 + (i % 3) * 0.05 + rand() * 0.03;
				const width = 0.18 + rand() * 0.42;
				r.line(
					SCREEN_WIDTH * indent,
					y,
					SCREEN_WIDTH * (indent + width),
					y,
					12,
					i % 3 === 2 ? mix(p.accent, WHITE, 0.55) : mix(p.accent, p.wallBottom, 0.25),
					0.85
				);
			}
		}
	},
	{
		id: 'books',
		label: 'books',
		words: ['book', 'books', 'read', 'reading', 'library', 'poem', 'poetry', 'write', 'writing', 'story', 'novel', 'prose', 'journal', 'essay', 'chapter', 'fiction', 'author', 'manuscript', 'draft'],
		draw: (r, p) => {
			const shelf = MOTIF_BOTTOM;
			for (let i = 0; i < 11; i++) {
				const w = 54 + ((i * 37) % 40);
				const x = 40 + i * 106;
				const h = 190 + ((i * 71) % 130);
				const ink = i % 3 === 0 ? mix(p.accent, WHITE, 0.4) : p.accent;
				r.line(x, shelf, x, shelf - h, w, ink, 0.9);
				r.line(x, shelf - h + 26, x, shelf - h + 34, w, WHITE, 0.5);
			}
			r.band(shelf + 2, shelf + 12, mix(p.accent, WHITE, 0.5), 0.85);
		}
	},
	{
		id: 'coffee',
		label: 'coffee and cooking',
		words: ['coffee', 'tea', 'espresso', 'bake', 'baking', 'bread', 'cook', 'cooking', 'recipe', 'kitchen', 'cake', 'spice', 'dinner', 'roast', 'brew', 'sourdough', 'pastry', 'meal'],
		draw: (r, p) => {
			const cx = SCREEN_WIDTH / 2;
			const cy = (MOTIF_TOP + MOTIF_BOTTOM) / 2 + 10;
			r.ellipse(cx, cy + 96, 200, 30, mix(p.accent, WHITE, 0.4), 0.85);
			r.ellipse(cx - 40, cy + 40, 150, 96, p.accent, 0.95);
			r.ellipse(cx + 132, cy - 4, 54, 58, p.accent, 0.95);
			r.ellipse(cx + 132, cy - 4, 28, 32, p.wallBottom, 0.9);
			for (let i = 0; i < 3; i++) {
				const x = cx - 90 + i * 66;
				let prevX = x;
				let prevY = cy - 60;
				for (let t = 1; t <= 12; t++) {
					const y = cy - 60 - t * 16;
					const nx = x + Math.sin(t / 2 + i) * 20;
					r.line(prevX, prevY, nx, y, 4, mix(p.accent, WHITE, 0.7), 0.5);
					prevX = nx;
					prevY = y;
				}
			}
		}
	},
	{
		id: 'skyline',
		label: 'cities',
		words: ['city', 'street', 'bridge', 'architecture', 'train', 'subway', 'tube', 'tram', 'map', 'urban', 'london', 'tokyo', 'building', 'downtown', 'rooftop', 'commute', 'railway'],
		draw: (r, p, seed) => {
			const rand = seeded(seed);
			for (let i = 0; i < 12; i++) {
				const w = 60 + rand() * 70;
				const x = i * 106 + rand() * 20;
				const h = 150 + rand() * 320;
				const ink = i % 3 === 0 ? mix(p.accent, p.wallBottom, 0.3) : p.accent;
				for (let y = MOTIF_BOTTOM - h + 30; y < MOTIF_BOTTOM - 20; y += 34) {
					r.line(x, y, x + w, y, 12, ink, 0.95);
					for (let wx = x + 8; wx < x + w - 8; wx += 22) {
						r.disc(wx, y, 4.5, rand() > 0.45 ? mix(p.accent, WHITE, 0.6) : p.wallBottom, 0.75);
					}
				}
			}
		}
	},
	{
		id: 'weather',
		label: 'weather',
		words: ['weather', 'storm', 'rain', 'cloud', 'thunder', 'lightning', 'snow', 'wind', 'forecast', 'fog', 'drizzle', 'hail', 'gale', 'sunshine', 'rainbow'],
		draw: (r, p) => {
			const cx = SCREEN_WIDTH / 2;
			const cy = MOTIF_TOP + 70;
			r.disc(cx - 90, cy + 20, 78, mix(p.accent, WHITE, 0.25), 0.9);
			r.disc(cx + 10, cy - 20, 108, mix(p.accent, WHITE, 0.35), 0.9);
			r.disc(cx + 130, cy + 26, 76, mix(p.accent, WHITE, 0.25), 0.9);
			r.band(cy + 40, cy + 72, mix(p.accent, WHITE, 0.25), 0.9);
			for (let i = 0; i < 5; i++) {
				const x = cx - 150 + i * 78;
				r.line(x, cy + 110, x - 28, cy + 210, 7, p.accent, 0.85);
			}
		}
	},
	{
		id: 'cats',
		label: 'cats',
		words: ['cat', 'cats', 'kitten', 'feline', 'meow', 'purr', 'tabby', 'whiskers', 'moggy', 'claws'],
		draw: (r, p) => {
			const cx = SCREEN_WIDTH / 2;
			const cy = (MOTIF_TOP + MOTIF_BOTTOM) / 2;
			const ink = p.accent;
			r.triangle(cx - 128, cy - 30, cx - 52, cy - 150, cx - 24, cy - 20, ink, 0.95);
			r.triangle(cx + 128, cy - 30, cx + 52, cy - 150, cx + 24, cy - 20, ink, 0.95);
			r.disc(cx, cy + 10, 128, ink, 0.95);
			r.disc(cx - 46, cy, 15, p.wallBottom, 1);
			r.disc(cx + 46, cy, 15, p.wallBottom, 1);
			r.ellipse(cx, cy + 54, 12, 9, mix(p.accent, WHITE, 0.7), 1);
			for (const s of [-1, 1]) {
				for (let i = -1; i <= 1; i++) {
					r.line(cx + s * 26, cy + 54, cx + s * 150, cy + 54 + i * 26, 4, mix(p.accent, WHITE, 0.6), 0.8);
				}
			}
		}
	},
	{
		id: 'birds',
		label: 'birds',
		words: ['bird', 'birds', 'crow', 'raven', 'owl', 'sparrow', 'gull', 'feather', 'nest', 'robin', 'swift', 'birding', 'magpie', 'heron', 'kingfisher'],
		draw: (r, p, seed) => {
			const rand = seeded(seed);
			r.line(0, MOTIF_BOTTOM, SCREEN_WIDTH, MOTIF_BOTTOM, 8, mix(p.accent, WHITE, 0.45), 0.8);
			for (let i = 0; i < 9; i++) {
				const x = 90 + rand() * (SCREEN_WIDTH - 200);
				const y = MOTIF_TOP + 20 + rand() * (MOTIF_BOTTOM - MOTIF_TOP - 60);
				const span = 18 + rand() * 16;
				const ink = i % 3 === 0 ? mix(p.accent, WHITE, 0.5) : p.accent;
				r.line(x - span, y, x, y - span * 0.8, 4.5, ink, 0.9);
				r.line(x, y - span * 0.8, x + span, y, 4.5, ink, 0.9);
			}
		}
	},
	{
		id: 'maths',
		label: 'puzzles and proofs',
		words: ['math', 'maths', 'prime', 'proof', 'theorem', 'puzzle', 'chess', 'logic', 'geometry', 'algebra', 'equation', 'noughts', 'crossword', 'sudoku', 'combinatorics'],
		draw: (r, p) => {
			const line = mix(p.accent, WHITE, 0.3);
			const nodes: [number, number][] = [];
			for (let row = 0; row < 3; row++) {
				for (let col = 0; col < 6; col++) {
					const x = SCREEN_WIDTH * (0.16 + col * 0.136);
					const y = (MOTIF_TOP + MOTIF_BOTTOM) / 2 + (row - 1) * 84;
					nodes.push([x, y]);
				}
			}
			for (const [i, [x, y]] of nodes.entries()) {
				for (const j of [i + 1, i + 6]) {
					const to = nodes[j];
					if (to) r.line(x, y, to[0], to[1], 3, line, 0.4);
				}
			}
			for (const [i, [x, y]] of nodes.entries()) {
				r.disc(x, y, i % 4 === 0 ? 16 : 11, i % 4 === 0 ? mix(p.accent, WHITE, 0.5) : p.accent, 0.95);
			}
		}
	}
];

/** How much each source of a bot's words is worth when picking a subject. */
const SOURCE_WEIGHT = { persona: 3, memory: 1, activity: 1 } as const;

const MEMORY_CHARS = 400;
const ACTIVITY_CHARS = 200;

/**
 * The subject a bot has talked itself into.
 *
 * A tie goes to the earlier subject in `SUBJECTS`, and nothing here is random,
 * so a bot keeps the same picture until what it says changes.
 */
export function deriveSubject(text: string): Subject {
	const tokens = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

	let best: Subject = SUBJECTS[0];
	let bestScore = 0;
	for (const subject of SUBJECTS) {
		let score = 0;
		for (const word of subject.words) {
			for (const [token, count] of counts) {
				if (token === word || token.startsWith(word) || (word.startsWith(token) && token.length >= 4)) {
					score += count;
				}
			}
		}
		if (score > bestScore) {
			bestScore = score;
			best = subject;
		}
	}
	return best;
}

/** Everything a bot has said about itself, weighted so its identity outweighs its small talk. */
export function subjectText(botId: string): string {
	const bot = getBot(botId);
	const persona = bot?.persona ?? '';
	const memories = listMemories(botId)
		.map((m) => `${m.key} ${m.value.slice(0, MEMORY_CHARS)}`)
		.join('\n');
	const activities = listActivities(botId, 40)
		.map((a) => `${a.kind} ${a.detail.slice(0, ACTIVITY_CHARS)}`)
		.join('\n');
	return [
		...Array<string>(SOURCE_WEIGHT.persona).fill(persona),
		memories,
		activities
	].join('\n');
}

// ----------------------------------------------------------------- the pointer

/**
 * The pointer is the one part of the environment that is not the bot's colour:
 * it is a fixed, vivid pink, so that the thing under the bot's hand looks the
 * same everywhere and can never be mistaken for part of a window. The white
 * edge around it is what keeps it visible on a pale desktop, on a white page
 * and on a pink-ish wallpaper alike.
 */
export const CURSOR_FILL: Rgb = { r: 255, g: 45, b: 149 };
export const CURSOR_EDGE: Rgb = { r: 255, g: 255, b: 255 };

/** The name X clients resolve against the theme. */
export const CURSOR_THEME = 'obl';
/**
 * Nominal pointer size in pixels. 24 is the size every desktop ships, which is
 * what a pointer should look like when you are driving the machine yourself;
 * the theme's art is drawn on a 64px grid and scales to whatever this is.
 */
export const CURSOR_SIZE = 24;
/** Where the theme is unpacked; libXcursor is pointed here with XCURSOR_PATH. */
export const CURSOR_PATH = `${THEME_DIR}/cursors`;

/**
 * The names a browser and its toolkit actually ask for, and the shape each one
 * gets. Anything not listed is left to the theme's `Inherits` fallback.
 */
const CURSOR_NAMES: Record<string, 'arrow' | 'text'> = {
	left_ptr: 'arrow',
	default: 'arrow',
	arrow: 'arrow',
	top_left_arrow: 'arrow',
	pointer: 'arrow',
	hand: 'arrow',
	hand1: 'arrow',
	hand2: 'arrow',
	openhand: 'arrow',
	closedhand: 'arrow',
	grabbing: 'arrow',
	fleur: 'arrow',
	move: 'arrow',
	crosshair: 'arrow',
	cross: 'arrow',
	watch: 'arrow',
	wait: 'arrow',
	progress: 'arrow',
	left_ptr_watch: 'arrow',
	'not-allowed': 'arrow',
	question_arrow: 'arrow',
	'context-menu': 'arrow',
	size_all: 'arrow',
	'nwse-resize': 'arrow',
	'nesw-resize': 'arrow',
	'ns-resize': 'arrow',
	'ew-resize': 'arrow',
	'col-resize': 'arrow',
	'row-resize': 'arrow',
	text: 'text',
	xterm: 'text',
	'vertical-text': 'text'
};

/**
 * The arrow's tip, on the 64-unit grid the art is laid out on: the point the
 * pointer is pointing *from*, and therefore the spot the whole cursor hangs
 * off. Both the X cursor and the picture composited into screenshots take it
 * from here, so the two can never disagree about where the pointer is.
 */
const ARROW_TIP: [number, number] = [4, 3];

/** The art is laid out on a 64x64 grid, so a different CURSOR_SIZE needs no new geometry. */
const CURSOR_UNIT = CURSOR_SIZE / 64;

/** Where the pointer's hot spot sits in the drawn image, in pixels. */
export const CURSOR_HOTSPOT = {
	x: Math.round(ARROW_TIP[0] * CURSOR_UNIT),
	y: Math.round(ARROW_TIP[1] * CURSOR_UNIT)
};

/**
 * A pointer, drawn at the nominal size. `arrow` is the classic pointer with its
 * hot spot on the tip; `text` is an I-beam, which is symmetric enough to use its
 * own centre.
 */
function drawCursor(shape: 'arrow' | 'text'): { raster: Raster; x: number; y: number } {
	const raster = new Raster(CURSOR_SIZE, CURSOR_SIZE, 4);
	const unit = CURSOR_UNIT;
	const outline = (scale: number, colour: Rgb) => {
		if (shape === 'arrow') {
			const points: [number, number][] = [
				ARROW_TIP,
				[4, 45],
				[15, 34],
				[23, 55],
				[33, 50],
				[25, 30],
				[39, 30]
			];
			raster.polygon(
				points.map(([px, py]) => {
					const cx = 20;
					const cy = 26;
					return [(cx + (px - cx) * scale) * unit, (cy + (py - cy) * scale) * unit] as [number, number];
				}),
				colour
			);
			return;
		}
		const [w, h] = [23 * scale, 54 * scale];
		const cx = 32 * unit;
		const cy = 32 * unit;
		raster.line(cx, cy - (h / 2) * unit, cx, cy + (h / 2) * unit, 7 * unit * scale, colour);
		raster.line(cx - (w / 2) * unit, cy - (h / 2) * unit, cx + (w / 2) * unit, cy - (h / 2) * unit, 7 * unit * scale, colour);
		raster.line(cx - (w / 2) * unit, cy + (h / 2) * unit, cx + (w / 2) * unit, cy + (h / 2) * unit, 7 * unit * scale, colour);
	};

	// Edge first, body on top of it: a two-tone pointer reads on the pale sky and
	// on the dark ground alike, and under a white page or a black one.
	outline(1.34, CURSOR_EDGE);
	outline(1, CURSOR_FILL);
	if (shape === 'arrow') return { raster, x: CURSOR_HOTSPOT.x, y: CURSOR_HOTSPOT.y };
	return { raster, x: 32 * unit, y: 32 * unit };
}

/**
 * The arrow as a transparent PNG, for compositing into screenshots.
 *
 * The same art as the X cursor rather than a lookalike: a bot's screenshot and
 * the live screen have to be the same picture, down to the shape of the pointer.
 */
export function pointerPng(): Buffer {
	return drawCursor('arrow').raster.png();
}

/**
 * One Xcursor file: a `Xcur` header, a table of contents and one image chunk.
 *
 * Written by hand because the image has no `xcursorgen` and the theme has to be
 * built without a network. The format is fixed-size records followed by
 * premultiplied ARGB pixels; see Xcursor(3).
 */
function xcursorFile(raster: Raster, xhot: number, yhot: number): Buffer {
	const header = Buffer.alloc(16);
	header.write('Xcur', 0, 4, 'latin1');
	header.writeUInt32LE(16, 4); // header size
	header.writeUInt32LE(0x00010000, 8); // version 1.0
	header.writeUInt32LE(1, 12); // one table entry
	const toc = Buffer.alloc(12);
	toc.writeUInt32LE(0xfffd0002, 0); // image chunk
	toc.writeUInt32LE(CURSOR_SIZE, 4); // subtype: the nominal size
	toc.writeUInt32LE(28, 8); // chunk offset: header + table entry
	const chunk = Buffer.alloc(36);
	chunk.writeUInt32LE(36, 0); // chunk header size
	chunk.writeUInt32LE(0xfffd0002, 4);
	chunk.writeUInt32LE(CURSOR_SIZE, 8);
	chunk.writeUInt32LE(1, 12); // chunk version
	chunk.writeUInt32LE(raster.width, 16);
	chunk.writeUInt32LE(raster.height, 20);
	chunk.writeUInt32LE(Math.round(xhot), 24);
	chunk.writeUInt32LE(Math.round(yhot), 28);
	chunk.writeUInt32LE(0, 32); // delay: nothing here animates
	const pixels = Buffer.alloc(raster.width * raster.height * 4);
	for (let i = 0; i < raster.width * raster.height; i++) {
		const at = i * 4;
		const alpha = raster.px[at + 3];
		const premultiplied = (channel: number) => Math.round((raster.px[at + channel] * alpha) / 255);
		pixels.writeUInt32LE(
			(((alpha << 24) | (premultiplied(0) << 16) | (premultiplied(1) << 8) | premultiplied(2)) >>> 0),
			at
		);
	}
	return Buffer.concat([header, toc, chunk, pixels]);
}

/** A file to unpack in the container: contents, or a symlink to another entry. */
export interface SkinFile {
	/** Path in the archive, relative to the theme directory's parent. */
	name: string;
	data?: Buffer;
	link?: string;
}

/** The canonical cursor name each shape is stored under. */
const CURSOR_SHAPES = { arrow: 'left_ptr', text: 'xterm' } as const;

/**
 * The theme's own files: one cursor file per shape, a symlink per name that
 * aliases it (which is how real cursor themes are built), and an index so
 * anything unlisted falls back to a theme that exists in the image.
 */
export function cursorFiles(): SkinFile[] {
	const dir = `obl-theme/cursors/${CURSOR_THEME}/cursors`;
	const files: SkinFile[] = (
		Object.entries(CURSOR_SHAPES) as ['arrow' | 'text', string][]
	).map(([shape, name]) => {
		const cursor = drawCursor(shape);
		return { name: `${dir}/${name}`, data: xcursorFile(cursor.raster, cursor.x, cursor.y) };
	});
	for (const [name, shape] of Object.entries(CURSOR_NAMES)) {
		const canonical = CURSOR_SHAPES[shape];
		if (canonical !== name) files.push({ name: `${dir}/${name}`, link: canonical });
	}
	files.push({
		name: `obl-theme/cursors/${CURSOR_THEME}/index.theme`,
		data: Buffer.from(`[Icon Theme]\nName=${CURSOR_THEME}\nComment=the bot's pointer\nInherits=Adwaita\n`)
	});
	return files;
}

// -------------------------------------------------------------------- the skin

/** The band split, as fractions of the screen height. */
const SKY_END = 0.44;
const HORIZON = 0.6;

/**
 * The picture itself: the bot's hue as a pale sky falling into a dark ground,
 * with its subject drawn on the ground.
 */
export function drawWallpaper(palette: BotPalette, subject: Subject, botId: string): Buffer {
	const raster = new Raster(SCREEN_WIDTH, SCREEN_HEIGHT);
	raster.verticalGradient([
		{ at: 0, colour: palette.sky },
		{ at: SKY_END, colour: palette.sky },
		{ at: HORIZON, colour: palette.wallBottom },
		{ at: 1, colour: palette.wallBottom }
	]);
	subject.draw(raster, palette, botId);
	// Corners darkened, but only below the horizon: the sky band is load-bearing
	// for Chrome's own dark text and stays as pale as it was drawn.
	const cx = SCREEN_WIDTH / 2;
	const cy = SCREEN_HEIGHT / 2;
	const radius = Math.hypot(cx, cy);
	for (let y = Math.round(SCREEN_HEIGHT * HORIZON); y < SCREEN_HEIGHT; y++) {
		for (let x = 0; x < SCREEN_WIDTH; x++) {
			const d = Math.hypot(x - cx, y - cy) / radius;
			if (d > 0.55) raster.blend(x, y, palette.wallBottom, (d - 0.55) * 0.5);
		}
	}
	return raster.png();
}

/** What goes into a sandbox: the files to unpack, and the colours they were built from. */
export interface SandboxSkin {
	palette: BotPalette;
	subject: Subject;
	/** A ustar archive: Chrome's theme, the picture, and the cursor theme. */
	bundle: Buffer;
}

/**
 * Build a bot's skin. Never throws: a sandbox with no skin is a sandbox that
 * still works, and theming must not be able to stop a turn.
 */
export async function sandboxSkin(botId: string): Promise<SandboxSkin | null> {
	try {
		const bot = getBot(botId);
		const palette = botPalette(bot?.color ?? FALLBACK_COLOUR);
		const subject = deriveSubject(subjectText(botId));
		const files: SkinFile[] = [
			{
				name: 'obl-theme/manifest.json',
				data: Buffer.from(JSON.stringify(themeManifest(bot?.name ?? 'Bot', palette), null, 1))
			},
			{ name: 'obl-theme/wall.png', data: drawWallpaper(palette, subject, botId) },
			{ name: 'obl-theme/pointer.png', data: pointerPng() },
			...cursorFiles()
		];
		return { palette, subject, bundle: tarBundle(files) };
	} catch (err) {
		console.warn(`sandbox skin for ${botId} failed:`, err);
		return null;
	}
}

/**
 * Chrome's theme for the bot.
 *
 * `theme_ntp_background` is the same picture as the desktop wallpaper, so the
 * bot's own new tab shows what it likes; `ntp_background_alignment` is bottom
 * because the picture is composed for that: its pale top band lands where
 * Chrome draws its own dark text. The ntp_* colour keys are set for the sake of
 * clients that do read them, but Chrome itself ignores them (see botPalette),
 * so nothing legibility-critical depends on them.
 */
export function themeManifest(botName: string, palette: BotPalette): Record<string, unknown> {
	const rgb = (c: Rgb) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
	return {
		manifest_version: 3,
		name: `${botName} · colours`,
		version: '1.0',
		theme: {
			images: { theme_ntp_background: 'wall.png' },
			colors: {
				frame: rgb(palette.frame),
				frame_inactive: rgb(palette.frameInactive),
				toolbar: rgb(palette.toolbar),
				tab_text: rgb(palette.tabText),
				tab_background_text: rgb(palette.tabText),
				bookmark_text: rgb(palette.tabText),
				ntp_background: rgb(palette.ntp),
				ntp_text: rgb(palette.ntpText),
				ntp_link: rgb(palette.ntpLink),
				button_background: rgb(palette.tabText)
			},
			properties: {
				ntp_background_alignment: 'bottom',
				ntp_background_repeat: 'no-repeat'
			}
		}
	};
}

/**
 * The shell command that puts the skin's picture on the X root window and tells
 * the display about the pointer theme.
 *
 * Nothing in the image draws a wallpaper (openbox does not, and feh, nitrogen
 * and xfconf are all absent), so the picture is set with ImageMagick's `display
 * -window root`, which leaves the pixmap in place behind the root window once
 * the client exits - which is why this can be a bounded command rather than a
 * process that has to be kept alive. The flat colour runs first so a missing or
 * unreadable PNG still leaves the desktop in the bot's colour.
 *
 * Chrome picks the pointer up from its own environment at launch (see
 * sandbox.ts), but the display's resources are where every other X client -
 * xdotool-driven tools, a terminal the bot opens - reads it from.
 */
export function wallpaperCommand(palette: BotPalette): string {
	return [
		`xsetroot -solid '${palette.wallSolid}'`,
		`[ -f ${THEME_DIR}/wall.png ] && timeout 3 display -window root ${THEME_DIR}/wall.png`,
		`command -v xrdb >/dev/null && printf 'Xcursor.theme: ${CURSOR_THEME}\\nXcursor.size: ${CURSOR_SIZE}\\n' | xrdb -merge`
	].join('; ');
}

// ------------------------------------------------------------ png and tar bits

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;

function crc32(buf: Buffer): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of buf) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 4, 'latin1');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/**
 * The first file in a ustar archive, as Docker's archive endpoint builds one.
 *
 * The mirror of `tarBundle`, for the pictures coming the other way: a capture
 * is read back out of the container through the same endpoint the skin went in
 * by, and its reply is a tar with the one file in it.
 */
export function tarEntry(archive: Buffer): Buffer | null {
	if (archive.length < 512) return null;
	const header = archive.subarray(0, 512);
	// An all-zero block is the archive's end marker: there is no file.
	if (!header.toString('latin1', 0, header.indexOf(0)).trim()) return null;
	const size = Number.parseInt(header.toString('latin1', 124, 136).trim(), 8);
	if (!Number.isFinite(size)) return null;
	return archive.subarray(512, 512 + size);
}

/**
 * A ustar archive, because the skin has to be inside the container *before*
 * Chrome starts and the container cannot be started, written to, and restarted
 * without losing the browser. Docker's archive endpoint accepts exactly this.
 */
export function tarBundle(files: SkinFile[]): Buffer {
	const blocks: Buffer[] = [];
	for (const file of files) {
		const data = file.data ?? Buffer.alloc(0);
		const header = Buffer.alloc(512);
		header.write(file.name, 0, 100, 'latin1');
		header.write('0000644\0', 100, 8, 'latin1');
		header.write('0000000\0', 108, 8, 'latin1');
		header.write('0000000\0', 116, 8, 'latin1');
		header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
		header.write('00000000000\0', 136, 12, 'latin1');
		header.write('        ', 148, 8, 'latin1');
		header.write(file.link ? '2' : '0', 156, 1, 'latin1');
		if (file.link) header.write(file.link, 157, 100, 'latin1');
		header.write('ustar\0', 257, 6, 'latin1');
		header.write('00', 263, 2, 'latin1');
		header.write('obl', 265, 32, 'latin1');
		header.write('obl', 297, 32, 'latin1');
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
		blocks.push(header);
		if (data.length) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}
