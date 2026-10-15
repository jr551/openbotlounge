<script lang="ts">
	/**
	 * The lounge's play gym, seen from above — cozy wooden gym, re-dressed.
	 *
	 * One baked static layer (floor, wall, frame, rack, treadmill, scoreboard
	 * body, mat base+markings, laptop desks) via drawImage per frame; per-frame
	 * mat glow, scoreboard text, swing, bag, dust, and y-sorted wobbling bots
	 * with sweatbands/hats/sweat/tag pills, seated laptops, stick arms/legs and
	 * avatar faces. Door spawn/fade, heavy-bot rests. Click to expand.
	 */
	import { bloatOf } from '$lib/bloat';
	import { isHat } from '$lib/hats';
	import type { HatName } from '$lib/hats';
	import type { Bot } from '$lib/types';

	let {
		bots = [],
		playing = false,
		using = new Set<string>(),
		pub = new Set<string>()
	}: { bots?: Bot[]; playing?: boolean; using?: Set<string>; pub?: Set<string> } = $props();

	let expanded = $state(false);

	function toggleExpanded() {
		expanded = !expanded;
	}
	function closeExpanded() {
		expanded = false;
	}
	function handleGymKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleExpanded();
		}
		if (e.key === 'Escape' && expanded) closeExpanded();
	}

	// Close on Escape when expanded (window)
	$effect(() => {
		if (!expanded) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') expanded = false;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	const W = 640;
	const H = 280;

	// Palette — §3
	const FLOOR_BASE = '#241a12';
	const WALL = '#181008';
	const WALL_SEAM = '#0d0906';
	const WOOD_DARK = '#54381f';
	const WOOD_MID = '#6b4a2f';
	const WOOD_LIGHT = '#8a6240';
	const MAT_IDLE = '#2e2a3f';
	const MAT_PLAY = '#413563';
	const MAT_EDGE = 'rgba(159,139,216,';
	const MAT_MARK = 'rgba(255,255,255,0.10)';
	const BOARD_BG = '#12161e';
	const BOARD_TEXT = '#ffd9e2';
	const BOARD_DIM = '#8a8a93';
	const METAL = '#4a4a55';
	const BAG = '#7a3b3b';
	const BAG_STRIPE = '#a05a4a';
	const ROPE = '#b09a72';
	const SHADOW = 'rgba(0,0,0,0.35)';
	const TAG_TEXT = 'rgba(255,255,255,0.88)';
	const TAG_PILL = 'rgba(0,0,0,0.45)';
	const SWEAT = '#9ecfff';

	// Furniture — spec §2
	const MAT = { x: 140, y: 56, w: 380, h: 180 };
	const FRAME = { x: 16, y: 30, w: 88, h: 200 };
	const BOARD = { x: 462, y: 4, w: 160, h: 34 };
	const RACK = { x: 548, y: 120, w: 76, h: 56 };
	const TREAD = { x: 548, y: 196, w: 76, h: 52 };
	const DOOR = { x: 628, y: 140 };
	const SWING_PIVOT = { x: 104, y: 60 };
	const BAG_CHAIN_TOP = { x: 560, y: 14 };

	// Laptop spots — row along mat's top edge (6 desks)
	const LAPTOP_SPOT_COUNT = 6;
	function laptopSpots(): { x: number; y: number }[] {
		const spots: { x: number; y: number }[] = [];
		const usable = MAT.w - 36;
		const step = usable / LAPTOP_SPOT_COUNT;
		for (let i = 0; i < LAPTOP_SPOT_COUNT; i++) {
			const x = MAT.x + 18 + step / 2 + i * step;
			const y = MAT.y + 22;
			spots.push({ x, y });
		}
		return spots;
	}
	const SPOTS = laptopSpots();
	function hashStr(s: string): number {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return h >>> 0;
	}
	function spotForBot(botId: string): { x: number; y: number } {
		return SPOTS[hashStr(botId) % SPOTS.length];
	}

	let surface: HTMLCanvasElement;
	let overlaySurface: HTMLCanvasElement | null = $state(null);
	let staticLayer: HTMLCanvasElement | null = null;

	type Walker = {
		x: number;
		y: number;
		tx: number;
		ty: number;
		speed: number;
		r: number;
		bloat: number;
		phase: number;
		born: number;
		hat: HatName | '';
		restUntil: number;
	};

	type LeavingWalker = Walker & { died: number };

	const walkers = new Map<string, Walker>();
	const leaving: LeavingWalker[] = [];

	// Avatar SVG image cache (per bot)
	type AvCache = { img: HTMLImageElement; ready: boolean; url: string };
	const avatarCache = new Map<string, AvCache>();

	type Mote = { x: number; y: number; r: number; phase: number; speed: number };
	const motes: Mote[] = (() => {
		const out: Mote[] = [];
		for (let i = 0; i < 14; i++) {
			const rx = (i * 97 + 13) % W;
			const ry = 20 + ((i * 53 + 71) % (H - 40));
			out.push({
				x: rx,
				y: ry,
				r: 0.6 + ((i * 37) % 80) / 100,
				phase: (i * 1.17) % (Math.PI * 2),
				speed: 4 + ((i * 13) % 50) / 10
			});
		}
		return out;
	})();

	function matSpot(): { x: number; y: number } {
		return {
			x: MAT.x + 20 + Math.random() * (MAT.w - 40),
			y: MAT.y + 16 + Math.random() * (MAT.h - 32)
		};
	}

	function floorSpot(): { x: number; y: number } {
		return {
			x: 30 + Math.random() * (W - 60),
			y: 30 + Math.random() * (H - 60)
		};
	}

	function bloatWord(bloat: number): string {
		if (bloat >= 0.85) return 'enormous';
		if (bloat >= 0.6) return 'very fat';
		if (bloat >= 0.35) return 'getting fat';
		if (bloat > 0) return 'a bit pudgy';
		return '';
	}

	function safeUsing(): Set<string> {
		// parent may pass undefined before backend lands
		return using ?? new Set<string>();
	}

	function walkerFor(bot: Bot, now: number): Walker {
		let w = walkers.get(bot.id);
		const bloat = bloatOf(bot);
		const rawHat = (bot as unknown as { hat?: string }).hat ?? '';
		const hat: HatName | '' = isHat(rawHat) ? rawHat : '';
		if (!w) {
			const jitter = Math.random() * 40 - 20;
			w = {
				x: DOOR.x,
				y: DOOR.y + jitter,
				tx: 0,
				ty: 0,
				speed: 26 - bloat * 16,
				r: 9 + bloat * 7,
				bloat,
				phase: Math.random() * Math.PI * 2,
				born: now,
				hat,
				restUntil: 0
			};
			const u = safeUsing();
			if (u.has(bot.id)) {
				const s = spotForBot(bot.id);
				w.tx = s.x;
				w.ty = s.y;
			} else {
				const next = floorSpot();
				w.tx = next.x;
				w.ty = next.y;
			}
			walkers.set(bot.id, w);
			// pre-warm avatar cache if SVG
			primeAvatar(bot);
		} else {
			if (w.bloat !== bloat) {
				w.bloat = bloat;
				w.speed = 26 - bloat * 16;
				w.r = 9 + bloat * 7;
			}
			if (w.hat !== hat) w.hat = hat;
			primeAvatar(bot);
		}
		return w;
	}

	function primeAvatar(bot: Bot) {
		const av = (bot.avatar ?? '').trim();
		if (!av || !av.includes('<svg')) return;
		if (avatarCache.has(bot.id)) return;
		if (typeof document === 'undefined' || typeof Image === 'undefined') return;
		try {
			const img = new Image();
			const blob = new Blob([av], { type: 'image/svg+xml' });
			const url = URL.createObjectURL(blob);
			const entry: AvCache = { img, ready: false, url };
			img.onload = () => {
				entry.ready = true;
			};
			img.onerror = () => {
				entry.ready = false;
			};
			img.src = url;
			avatarCache.set(bot.id, entry);
		} catch {
			// ignore
		}
	}

	function roundRectPath(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		w: number,
		h: number,
		r: number
	) {
		const rr = Math.min(r, w / 2, h / 2);
		ctx.beginPath();
		ctx.moveTo(x + rr, y);
		ctx.arcTo(x + w, y, x + w, y + h, rr);
		ctx.arcTo(x + w, y + h, x, y + h, rr);
		ctx.arcTo(x, y + h, x, y, rr);
		ctx.arcTo(x, y, x + w, y, rr);
		ctx.closePath();
	}

	function buildStaticLayer(): HTMLCanvasElement {
		const c = document.createElement('canvas');
		c.width = W;
		c.height = H;
		const ctx = c.getContext('2d')!;

		// Floor base
		ctx.fillStyle = FLOOR_BASE;
		ctx.fillRect(0, 0, W, H);

		// Plank lines every 20 from y=20
		ctx.strokeStyle = 'rgba(0,0,0,0.28)';
		ctx.lineWidth = 1;
		for (let y = 20; y < H; y += 20) {
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(W, y);
			ctx.stroke();
		}
		// Plank-end seams
		ctx.strokeStyle = 'rgba(0,0,0,0.16)';
		ctx.lineWidth = 1;
		let rowIdx = 0;
		for (let y = 20; y < H; y += 20) {
			const x1 = (rowIdx * 197 + 53) % 600 + 20;
			const x2 = (rowIdx * 317 + 89) % 600 + 20;
			for (const sx of [x1, x2]) {
				ctx.beginPath();
				ctx.moveTo(sx, y + 2);
				ctx.lineTo(sx, y + 14);
				ctx.stroke();
			}
			rowIdx++;
		}

		// Wall band + baseboard seam
		ctx.fillStyle = WALL;
		ctx.fillRect(0, 0, 640, 14);
		ctx.fillStyle = WALL_SEAM;
		ctx.fillRect(0, 14, 640, 2);

		// Climbing frame
		roundRectPath(ctx, FRAME.x, FRAME.y, FRAME.w, FRAME.h, 4);
		ctx.fillStyle = WOOD_DARK;
		ctx.fill();
		ctx.fillStyle = WOOD_MID;
		ctx.fillRect(FRAME.x + 4, FRAME.y, 5, FRAME.h);
		ctx.fillRect(FRAME.x + FRAME.w - 9, FRAME.y, 5, FRAME.h);
		ctx.strokeStyle = WOOD_LIGHT;
		ctx.lineWidth = 3;
		for (let i = 0; i < 7; i++) {
			const y = FRAME.y + 14 + (i * (FRAME.h - 28)) / 6;
			ctx.beginPath();
			ctx.moveTo(FRAME.x + 9, y);
			ctx.lineTo(FRAME.x + FRAME.w - 9, y);
			ctx.stroke();
		}
		ctx.fillStyle = 'rgba(0,0,0,0.4)';
		const bolts: [number, number][] = [
			[FRAME.x + 3, FRAME.y + 3],
			[FRAME.x + FRAME.w - 3, FRAME.y + 3],
			[FRAME.x + 3, FRAME.y + FRAME.h - 3],
			[FRAME.x + FRAME.w - 3, FRAME.y + FRAME.h - 3]
		];
		for (const [bx, by] of bolts) {
			ctx.beginPath();
			ctx.arc(bx, by, 1.5, 0, Math.PI * 2);
			ctx.fill();
		}

		// Dumbbell rack
		roundRectPath(ctx, RACK.x, RACK.y, RACK.w, RACK.h, 4);
		ctx.fillStyle = METAL;
		ctx.fill();
		ctx.strokeStyle = '#2c2c30';
		ctx.lineWidth = 1;
		ctx.stroke();
		ctx.strokeStyle = '#3a3a44';
		ctx.lineWidth = 1;
		for (let s = 1; s <= 2; s++) {
			const sy = RACK.y + (s * RACK.h) / 3;
			ctx.beginPath();
			ctx.moveTo(RACK.x + 4, sy);
			ctx.lineTo(RACK.x + RACK.w - 4, sy);
			ctx.stroke();
		}
		for (let shelf = 0; shelf < 2; shelf++) {
			const sy = RACK.y + ((shelf + 1) * RACK.h) / 3;
			const dy = sy - 9;
			for (let i = 0; i < 4; i++) {
				const dx = RACK.x + 6 + i * 17;
				ctx.fillStyle = METAL;
				ctx.fillRect(dx, dy, 5, 9);
				ctx.fillRect(dx + 9, dy, 5, 9);
				ctx.fillRect(dx + 5, dy + 3.5, 4, 2);
				ctx.fillStyle = 'rgba(255,255,255,0.08)';
				ctx.fillRect(dx, dy, 5, 2);
				ctx.fillRect(dx + 9, dy, 5, 2);
			}
		}

		// Treadmill
		roundRectPath(ctx, TREAD.x, TREAD.y, TREAD.w, TREAD.h, 4);
		ctx.fillStyle = METAL;
		ctx.fill();
		ctx.strokeStyle = '#2c2c30';
		ctx.lineWidth = 1;
		ctx.stroke();
		const beltX = TREAD.x + 6;
		const beltY = TREAD.y + 8;
		const beltW = TREAD.w - 12;
		const beltH = TREAD.h - 16;
		roundRectPath(ctx, beltX, beltY, beltW, beltH, 3);
		ctx.fillStyle = '#23232b';
		ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.07)';
		ctx.lineWidth = 1;
		for (let k = 1; k <= 3; k++) {
			const by = beltY + (k * beltH) / 4;
			ctx.beginPath();
			ctx.moveTo(beltX + 4, by);
			ctx.lineTo(beltX + beltW - 4, by);
			ctx.stroke();
		}
		ctx.fillStyle = METAL;
		ctx.fillRect(TREAD.x + TREAD.w - 14, TREAD.y - 6, 4, 10);
		ctx.fillStyle = '#12161e';
		ctx.fillRect(TREAD.x + TREAD.w - 18, TREAD.y - 10, 12, 6);
		ctx.fillStyle = 'rgba(255,255,255,0.06)';
		ctx.fillRect(TREAD.x + TREAD.w - 18, TREAD.y - 10, 12, 2);

		// Scoreboard body
		roundRectPath(ctx, BOARD.x, BOARD.y, BOARD.w, BOARD.h, 4);
		ctx.fillStyle = BOARD_BG;
		ctx.fill();
		ctx.strokeStyle = '#2c2c30';
		ctx.lineWidth = 1;
		ctx.stroke();
		ctx.fillStyle = METAL;
		ctx.fillRect(BOARD.x + 18, 14, 2, 6);
		ctx.fillRect(BOARD.x + BOARD.w - 20, 14, 2, 6);

		// Mat base + markings (baked)
		ctx.fillStyle = MAT_IDLE;
		ctx.fillRect(MAT.x, MAT.y, MAT.w, MAT.h);
		ctx.strokeStyle = MAT_MARK;
		ctx.lineWidth = 2;
		ctx.strokeRect(MAT.x + 4, MAT.y + 4, MAT.w - 8, MAT.h - 8);
		ctx.beginPath();
		ctx.arc(MAT.x + MAT.w / 2, MAT.y + MAT.h / 2, 34, 0, Math.PI * 2);
		ctx.strokeStyle = MAT_MARK;
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(MAT.x + MAT.w / 2, MAT.y + MAT.h / 2, 3, 0, Math.PI * 2);
		ctx.fillStyle = MAT_MARK;
		ctx.fill();
		ctx.fillStyle = MAT_MARK;
		ctx.beginPath();
		ctx.moveTo(MAT.x + 8, MAT.y + 8);
		ctx.lineTo(MAT.x + 22, MAT.y + 8);
		ctx.lineTo(MAT.x + 8, MAT.y + 22);
		ctx.closePath();
		ctx.fill();
		ctx.beginPath();
		ctx.moveTo(MAT.x + MAT.w - 8, MAT.y + MAT.h - 8);
		ctx.lineTo(MAT.x + MAT.w - 22, MAT.y + MAT.h - 8);
		ctx.lineTo(MAT.x + MAT.w - 8, MAT.y + MAT.h - 22);
		ctx.closePath();
		ctx.fill();

		// Laptop desks — baked row along mat top edge
		for (const s of SPOTS) {
			// desk rectangle 28x10
			roundRectPath(ctx, s.x - 14, s.y - 6, 28, 10, 2);
			ctx.fillStyle = '#3a3a44';
			ctx.fill();
			ctx.strokeStyle = 'rgba(255,255,255,0.06)';
			ctx.lineWidth = 1;
			ctx.stroke();
			// small desk edge highlight
			ctx.fillStyle = 'rgba(255,255,255,0.04)';
			ctx.fillRect(s.x - 14, s.y - 6, 28, 2);
		}

		// The Wetherspoons sign: the pub is under the gym, so the sign hangs by
		// the door pointing down. Static like the rest of the furniture - who is
		// actually in there is a per-frame matter (see the tag pills).
		ctx.font = '700 9px system-ui, sans-serif';
		ctx.textAlign = 'left';
		ctx.fillStyle = '#3a2c1a';
		roundRectPath(ctx, 16, H - 26, 118, 16, 3);
		ctx.fill();
		ctx.strokeStyle = WOOD_MID;
		ctx.lineWidth = 1;
		ctx.stroke();
		ctx.fillStyle = '#e8c96a';
		ctx.fillText('WETHERSPOONS \u2193', 24, H - 15);

		return c;
	}

	function ensureStatic(): HTMLCanvasElement {
		if (!staticLayer) staticLayer = buildStaticLayer();
		return staticLayer;
	}

	function paintMatState(ctx: CanvasRenderingContext2D, now: number) {
		if (playing) {
			ctx.fillStyle = MAT_PLAY;
			ctx.fillRect(MAT.x, MAT.y, MAT.w, MAT.h);
			ctx.strokeStyle = MAT_MARK;
			ctx.lineWidth = 2;
			ctx.strokeRect(MAT.x + 4, MAT.y + 4, MAT.w - 8, MAT.h - 8);
			ctx.beginPath();
			ctx.arc(MAT.x + MAT.w / 2, MAT.y + MAT.h / 2, 34, 0, Math.PI * 2);
			ctx.lineWidth = 1.5;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(MAT.x + MAT.w / 2, MAT.y + MAT.h / 2, 3, 0, Math.PI * 2);
			ctx.fillStyle = MAT_MARK;
			ctx.fill();
			ctx.fillStyle = MAT_MARK;
			ctx.beginPath();
			ctx.moveTo(MAT.x + 8, MAT.y + 8);
			ctx.lineTo(MAT.x + 22, MAT.y + 8);
			ctx.lineTo(MAT.x + 8, MAT.y + 22);
			ctx.closePath();
			ctx.fill();
			ctx.beginPath();
			ctx.moveTo(MAT.x + MAT.w - 8, MAT.y + MAT.h - 8);
			ctx.lineTo(MAT.x + MAT.w - 22, MAT.y + MAT.h - 8);
			ctx.lineTo(MAT.x + MAT.w - 8, MAT.y + MAT.h - 22);
			ctx.closePath();
			ctx.fill();
			// re-draw desk marks that were covered
			for (const s of SPOTS) {
				roundRectPath(ctx, s.x - 14, s.y - 6, 28, 10, 2);
				ctx.fillStyle = '#3a3a44';
				ctx.fill();
				ctx.strokeStyle = 'rgba(255,255,255,0.06)';
				ctx.lineWidth = 1;
				ctx.stroke();
			}
		}
		const alpha = playing ? 0.35 + 0.25 * Math.sin(now / 400) : 0.15;
		ctx.strokeStyle = `${MAT_EDGE}${alpha})`;
		ctx.lineWidth = 2;
		ctx.strokeRect(MAT.x, MAT.y, MAT.w, MAT.h);
	}

	function paintScoreboard(ctx: CanvasRenderingContext2D, now: number) {
		const cx = BOARD.x + BOARD.w / 2;
		ctx.fillStyle = BOARD_DIM;
		ctx.font = '8px system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('PLAY GYM', cx, BOARD.y + 12);
		const lampAlpha = playing ? 0.7 + 0.3 * Math.sin(now / 300) : 1;
		const dotColor = playing ? `rgba(126,226,160,${lampAlpha})` : BOARD_DIM;
		const label = playing ? `ROUND ON \u00b7 ${bots.length} bots` : 'quiet floor';
		ctx.textAlign = 'center';
		ctx.font = '700 10px system-ui, sans-serif';
		const labelW = ctx.measureText(label).width;
		const dotW = ctx.measureText('\u25cf ').width;
		const total = labelW + dotW;
		const startX = cx - total / 2;
		ctx.fillStyle = dotColor;
		ctx.fillText('\u25cf', startX + ctx.measureText('\u25cf').width / 2, BOARD.y + 26);
		ctx.fillStyle = BOARD_TEXT;
		ctx.fillText(label, startX + dotW + labelW / 2, BOARD.y + 26);
	}

	function paintSwing(ctx: CanvasRenderingContext2D, now: number) {
		const a = Math.sin(now / 1400) * (playing ? 0.35 : 0.12);
		const len = 46;
		const seatW = 14;
		const seatH = 4;
		const cx = SWING_PIVOT.x + Math.sin(a) * len;
		const cy = SWING_PIVOT.y + Math.cos(a) * len;
		const half = seatW / 2;
		ctx.strokeStyle = ROPE;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(SWING_PIVOT.x - 4, SWING_PIVOT.y);
		ctx.lineTo(cx - half, cy);
		ctx.moveTo(SWING_PIVOT.x + 4, SWING_PIVOT.y);
		ctx.lineTo(cx + half, cy);
		ctx.stroke();
		ctx.fillStyle = WOOD_MID;
		ctx.fillRect(cx - half, cy, seatW, seatH);
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.fillRect(cx - half, cy, seatW, 1.5);
	}

	function paintBag(ctx: CanvasRenderingContext2D, now: number) {
		const a = Math.sin(now / 900) * (playing ? 0.3 : 0.05);
		const bagX = BAG_CHAIN_TOP.x + Math.sin(a) * 30;
		const bagY = BAG_CHAIN_TOP.y + Math.cos(a) * 30;
		ctx.strokeStyle = METAL;
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.moveTo(BAG_CHAIN_TOP.x, BAG_CHAIN_TOP.y);
		ctx.lineTo(bagX, bagY - 11);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(bagX, bagY, 11, 0, Math.PI * 2);
		ctx.fillStyle = BAG;
		ctx.fill();
		ctx.fillStyle = BAG_STRIPE;
		ctx.fillRect(bagX - 11, bagY - 3, 22, 4);
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.beginPath();
		ctx.arc(bagX - 3, bagY - 4, 5, 0, Math.PI * 2);
		ctx.fill();
	}

	function paintMotes(ctx: CanvasRenderingContext2D, now: number, dt: number) {
		for (let i = 0; i < motes.length; i++) {
			const m = motes[i];
			m.x -= (m.speed * dt) / 1000;
			m.y += Math.sin(now / 2000 + m.phase) * 0.15;
			if (m.x < -4) m.x = W + 4;
			if (m.x > W + 4) m.x = -4;
			if (m.y < -4) m.y = H + 4;
			if (m.y > H + 4) m.y = -4;
			const alpha = 0.05 + 0.09 * (0.5 + 0.5 * Math.sin(now / 1500 + m.phase));
			ctx.beginPath();
			ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(255,240,210,${alpha})`;
			ctx.fill();
		}
	}

	function drawHat(
		ctx: CanvasRenderingContext2D,
		name: HatName,
		x: number,
		y: number,
		r: number,
		now: number
	) {
		const u = r / 9;
		ctx.save();
		switch (name) {
			case 'party': {
				ctx.fillStyle = '#e2557a';
				ctx.beginPath();
				ctx.moveTo(x - 2.5 * u, y);
				ctx.lineTo(x + 2.5 * u, y);
				ctx.lineTo(x, y - 7 * u);
				ctx.closePath();
				ctx.fill();
				ctx.beginPath();
				ctx.arc(x, y - 7 * u, 1.2 * u, 0, Math.PI * 2);
				ctx.fillStyle = '#ffd9e2';
				ctx.fill();
				break;
			}
			case 'top': {
				ctx.fillStyle = '#2b2b30';
				ctx.fillRect(x - 2 * u, y - 5 * u, 4 * u, 5 * u);
				ctx.fillRect(x - 3.5 * u, y - 1.2 * u, 7 * u, 1.2 * u);
				break;
			}
			case 'hard': {
				ctx.fillStyle = '#e8b93e';
				ctx.beginPath();
				ctx.arc(x, y, 3 * u, Math.PI, 0);
				ctx.closePath();
				ctx.fill();
				ctx.fillRect(x - 3.5 * u, y - 0.5 * u, 7 * u, 1 * u);
				break;
			}
			case 'night': {
				ctx.fillStyle = '#3d4a7a';
				ctx.beginPath();
				ctx.moveTo(x - 2.5 * u, y);
				ctx.lineTo(x + 2.5 * u, y);
				ctx.quadraticCurveTo(x + 3 * u, y - 3 * u, x + 1.5 * u, y - 6 * u);
				ctx.lineTo(x - 0.5 * u, y - 6 * u);
				ctx.quadraticCurveTo(x - 1 * u, y - 3 * u, x - 2.5 * u, y);
				ctx.closePath();
				ctx.fill();
				ctx.beginPath();
				ctx.arc(x + 1.5 * u, y - 6 * u, 0.9 * u, 0, Math.PI * 2);
				ctx.fillStyle = '#cfd8ff';
				ctx.fill();
				break;
			}
			case 'wizard': {
				ctx.fillStyle = '#5a4a8a';
				ctx.beginPath();
				ctx.moveTo(x - 3 * u, y);
				ctx.lineTo(x + 3 * u, y);
				ctx.lineTo(x, y - 8 * u);
				ctx.closePath();
				ctx.fill();
				ctx.fillRect(x - 3.5 * u, y - 1 * u, 7 * u, 1 * u);
				ctx.strokeStyle = '#ffd9e2';
				ctx.lineWidth = 0.9 * u;
				ctx.beginPath();
				ctx.moveTo(x - 1.2 * u, y - 4 * u);
				ctx.lineTo(x + 1.2 * u, y - 4 * u);
				ctx.moveTo(x, y - 5.2 * u);
				ctx.lineTo(x, y - 2.8 * u);
				ctx.stroke();
				break;
			}
			case 'crown': {
				ctx.fillStyle = '#e8b93e';
				ctx.fillRect(x - 3 * u, y - 2 * u, 6 * u, 2 * u);
				ctx.beginPath();
				ctx.moveTo(x - 3 * u, y - 2 * u);
				ctx.lineTo(x - 2 * u, y - 4.5 * u);
				ctx.lineTo(x - 1 * u, y - 2 * u);
				ctx.lineTo(x, y - 4.5 * u);
				ctx.lineTo(x + 1 * u, y - 2 * u);
				ctx.lineTo(x + 2 * u, y - 4.5 * u);
				ctx.lineTo(x + 3 * u, y - 2 * u);
				ctx.closePath();
				ctx.fill();
				break;
			}
			case 'propeller': {
				ctx.fillStyle = '#4f8ef7';
				ctx.beginPath();
				ctx.arc(x, y, 3 * u, Math.PI, 0);
				ctx.closePath();
				ctx.fill();
				ctx.save();
				ctx.translate(x, y - 3.2 * u);
				ctx.rotate(now / 90);
				ctx.strokeStyle = '#2b2b30';
				ctx.lineWidth = 1.2 * u;
				ctx.beginPath();
				ctx.moveTo(-3 * u, 0);
				ctx.lineTo(3 * u, 0);
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(0, 0, 0.7 * u, 0, Math.PI * 2);
				ctx.fillStyle = '#8a8a93';
				ctx.fill();
				ctx.restore();
				break;
			}
			case 'halo': {
				ctx.strokeStyle = '#ffd9e2';
				ctx.lineWidth = 1.2 * u;
				ctx.beginPath();
				ctx.ellipse(x, y - 2.5 * u, 3.5 * u, 1.2 * u, 0, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case 'antenna': {
				ctx.strokeStyle = '#8a8a93';
				ctx.lineWidth = 1.2 * u;
				ctx.beginPath();
				ctx.moveTo(x, y);
				ctx.lineTo(x, y - 5 * u);
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(x, y - 5 * u, 1.3 * u, 0, Math.PI * 2);
				ctx.fillStyle = '#f26d6d';
				ctx.fill();
				break;
			}
			case 'flower': {
				const cx = x;
				const cy = y - 1.2 * u;
				ctx.fillStyle = '#e8b93e';
				ctx.beginPath();
				ctx.arc(cx, cy, 1.2 * u, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = '#e255a0';
				for (let k = 0; k < 5; k++) {
					const ang = (k / 5) * Math.PI * 2;
					const px = cx + Math.cos(ang) * 1.9 * u;
					const py = cy + Math.sin(ang) * 1.9 * u;
					ctx.beginPath();
					ctx.arc(px, py, 1.3 * u, 0, Math.PI * 2);
					ctx.fill();
				}
				break;
			}
			case 'cap': {
				ctx.fillStyle = '#4f8ef7';
				ctx.beginPath();
				ctx.arc(x, y, 3 * u, Math.PI, 0);
				ctx.closePath();
				ctx.fill();
				ctx.fillRect(x + 1.5 * u, y - 1 * u, 3.5 * u, 1 * u);
				break;
			}
		}
		ctx.restore();
	}

	function drawFace(
		ctx: CanvasRenderingContext2D,
		bot: Bot,
		cx: number,
		cy: number,
		r: number
	) {
		const av = (bot.avatar ?? '').trim();
		if (av && !av.includes('<')) {
			// Emoji avatar — render first grapheme
			const first = Array.from(av)[0] ?? av;
			ctx.font = `${Math.round(r * 0.95)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			// Slight shadow for readability on colored body
			ctx.fillStyle = 'rgba(0,0,0,0.25)';
			ctx.fillText(first, cx + 0.5, cy + 0.5);
			ctx.fillStyle = '#fff';
			// Add subtle stroke for contrast on light bodies
			ctx.strokeStyle = 'rgba(0,0,0,0.2)';
			ctx.lineWidth = 2;
			ctx.strokeText(first, cx, cy);
			ctx.fillText(first, cx, cy);
			return;
		}
		if (av.includes('<svg')) {
			const entry = avatarCache.get(bot.id);
			if (entry && entry.ready) {
				const size = r * 1.55;
				// clip to body circle for cleanliness
				ctx.save();
				ctx.beginPath();
				ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
				ctx.clip();
				ctx.drawImage(entry.img, cx - size / 2, cy - size / 2, size, size);
				ctx.restore();
				return;
			}
		}
		// Fallback: simple eyes
		const eyeOffset = r * 0.28;
		const eyeY = cy - r * 0.08;
		const eyeR = Math.max(1.2, r * 0.13);
		ctx.fillStyle = 'rgba(12,12,14,0.85)';
		ctx.beginPath();
		ctx.arc(cx - eyeOffset, eyeY, eyeR, 0, Math.PI * 2);
		ctx.fill();
		ctx.beginPath();
		ctx.arc(cx + eyeOffset, eyeY, eyeR, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = 'rgba(255,255,255,0.95)';
		ctx.beginPath();
		ctx.arc(cx - eyeOffset + eyeR * 0.28, eyeY - eyeR * 0.18, eyeR * 0.36, 0, Math.PI * 2);
		ctx.fill();
		ctx.beginPath();
		ctx.arc(cx + eyeOffset + eyeR * 0.28, eyeY - eyeR * 0.18, eyeR * 0.36, 0, Math.PI * 2);
		ctx.fill();
		// tiny smile
		ctx.strokeStyle = 'rgba(12,12,14,0.55)';
		ctx.lineWidth = Math.max(0.9, r * 0.07);
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.arc(cx, cy + r * 0.22, r * 0.28, 0.15 * Math.PI, 0.85 * Math.PI);
		ctx.stroke();
	}

	function paintBots(ctx: CanvasRenderingContext2D, now: number, dt: number) {
		const present = new Set(bots.map((b) => b.id));
		for (const id of Array.from(walkers.keys())) {
			if (!present.has(id)) {
				const w = walkers.get(id)!;
				walkers.delete(id);
				leaving.push({ ...w, died: now });
			}
		}
		for (let i = leaving.length - 1; i >= 0; i--) {
			if (now - leaving[i].died > 300) leaving.splice(i, 1);
		}

		const uSet = safeUsing();

		// Advance live walkers
		for (const bot of bots) {
			const w = walkerFor(bot, now);
			const isUsing = uSet.has(bot.id);
			if (isUsing) {
				const spot = spotForBot(bot.id);
				// If just started using and far from spot, retarget
				if (Math.hypot(w.tx - spot.x, w.ty - spot.y) > 0.5) {
					w.tx = spot.x;
					w.ty = spot.y;
				}
				// fall through to movement toward spot
			}
			const dx = w.tx - w.x;
			const dy = w.ty - w.y;
			const dist = Math.hypot(dx, dy);
			const resting = playing && !uSet.has(bot.id) && w.bloat >= 0.6 && now < w.restUntil;
			if (dist < 4) {
				if (isUsing) {
					// arrived at laptop — stay put, no wander
				} else if (resting) {
					// heavy resting
				} else {
					if (playing && w.bloat >= 0.6) {
						w.restUntil = now + 1200 + w.bloat * 2000;
					} else {
						const nIsUsing = uSet.has(bot.id);
						if (nIsUsing) {
							const s = spotForBot(bot.id);
							w.tx = s.x;
							w.ty = s.y;
						} else {
							const next = playing ? matSpot() : floorSpot();
							w.tx = next.x;
							w.ty = next.y;
						}
					}
				}
			} else {
				if (isUsing || resting) {
					// still walk to laptop even while "using" (approach), but don't rest-walk
					if (isUsing) {
						const step = Math.min(dist, (w.speed * dt) / 1000);
						w.x += (dx / dist) * step;
						w.y += (dy / dist) * step;
					}
					// if resting and not using, stay
				} else {
					const step = Math.min(dist, (w.speed * dt) / 1000);
					w.x += (dx / dist) * step;
					w.y += (dy / dist) * step;
				}
			}
			// If bot was using and is no longer, it was stuck at desk; release to wander
			if (!isUsing && dist < 4) {
				// check if tx was a spot and now should wander — but the dist<4 branch
				// already picks next; handle the edge where we just flipped from using
				// and tx still equals spot but we are at spot. The above assigns next
				// only if not already handled heavy rest. For non-heavy, we need to
				// ensure we leave the desk on the frame where using flips.
				// Detect: tx is near a spot
				const nearSpot = SPOTS.some((s) => Math.hypot(w.tx - s.x, w.ty - s.y) < 2);
				if (nearSpot && w.restUntil <= now) {
					// Only if we didn't already set restUntil this frame
					const wasHeavy = playing && w.bloat >= 0.6 && now < w.restUntil;
					if (!wasHeavy) {
						// pick away spot now if still <4 and not using
						// small chance double-pick but okay
					}
				}
			}
			// If rest just expired at desk, force leave handling: the next frame's
			// dist<4 path will pick new destination. For immediate, if restUntil just passed
			// and dist<4 and heavy, pick now.
			if (!isUsing && !resting && dist < 4 && playing && w.bloat >= 0.6 && w.restUntil !== 0 && now >= w.restUntil) {
				const next = matSpot();
				w.tx = next.x;
				w.ty = next.y;
			}
			// Handle transition out of using: if no longer using and tx still equals spot, pick new spot away
			if (!isUsing) {
				const txIsSpot = SPOTS.some((s) => Math.hypot(w.tx - s.x, w.ty - s.y) < 1);
				if (txIsSpot && dist < 4) {
					// already handled above for heavy; for light bots we did assign but
					// for heavy we set restUntil and didn't move — fix by picking after rest
					// For light: the assign above for non-heavy already moved; just ensure
					// if we are light and still at spot due to early return, push out
					if (w.bloat < 0.6) {
						const next = playing ? matSpot() : floorSpot();
						// if tx still spot, overwrite
						if (SPOTS.some((s) => Math.hypot(w.tx - s.x, w.ty - s.y) < 1)) {
							w.tx = next.x;
							w.ty = next.y;
						}
					}
				}
			}
		}

		const botById = new Map(bots.map((b) => [b.id, b] as const));
		type DrawItem = { w: Walker; bot: Bot | null; leaving: LeavingWalker | null };
		const items: DrawItem[] = [];
		for (const w of walkers.values()) {
			let bid: string | null = null;
			for (const [id, ww] of walkers.entries()) if (ww === w) { bid = id; break; }
			items.push({ w, bot: bid ? (botById.get(bid) ?? null) : null, leaving: null });
		}
		for (const lw of leaving) items.push({ w: lw, bot: null, leaving: lw });
		items.sort((a, b) => a.w.y - b.w.y);

		for (const it of items) {
			const w = it.w;
			const bot = it.bot;
			const lw = it.leaving;
			const isLeaving = !!lw;
			let s = 1;
			let alpha = 1;
			if (!isLeaving) {
				const age = now - w.born;
				if (age < 350) {
					s = Math.min(1, age / 350);
					s = s * (2 - s);
				}
			} else {
				const t = (now - lw!.died) / 300;
				s = 1 - t;
				alpha = s;
				if (s <= 0) continue;
			}
			const r = w.r * s;
			if (r <= 0.5) continue;
			const isUsing = bot ? uSet.has(bot.id) : false;
			const spot = bot ? spotForBot(bot.id) : null;
			const distToSpot = spot ? Math.hypot(w.x - spot.x, w.y - spot.y) : 999;
			const seated = !!bot && isUsing && distToSpot < 7 && !isLeaving;
			const restingNow = !isUsing && playing && w.bloat >= 0.6 && now < w.restUntil && !isLeaving;
			// bob/wobble suppressed when seated
			let bob = 0;
			let wob = 0;
			if (seated) {
				bob = Math.sin(now / 900 + w.phase) * 0.35;
				wob = Math.sin(now / 900 + w.phase) * 0.015;
			} else {
				bob = Math.sin(now / 600 + w.phase) * (playing ? 1.6 : 0.6);
				const distToTarget = Math.hypot(w.tx - w.x, w.ty - w.y);
				const idleAtTarget = distToTarget < 4 || restingNow;
				wob = idleAtTarget
					? Math.sin(now / 600 + w.phase) * 0.03
					: Math.sin(now / 180 + w.phase) * (0.04 + w.bloat * 0.1);
			}
			const rx = r * (1 + wob);
			const ry = r * (1 - wob);
			const color = bot?.color || '#4f8ef7';
			const cx = w.x;
			const cy = w.y + bob + (seated ? 2 : 0);

			ctx.save();
			if (alpha < 1) ctx.globalAlpha = alpha;

			// Shadow — wider when seated
			ctx.fillStyle = SHADOW;
			const shRx = seated ? r * 1.15 : r * (0.9 + w.bloat * 0.4);
			const shRy = seated ? r * 0.42 : r * 0.35;
			ctx.beginPath();
			ctx.ellipse(w.x, w.y + r * 0.7 + (seated ? 3 : 0), shRx, shRy, 0, 0, Math.PI * 2);
			ctx.fill();

			// Legs — draw behind body
			if (!isLeaving) {
				ctx.strokeStyle = 'rgba(0,0,0,0.52)';
				ctx.lineCap = 'round';
				ctx.lineWidth = Math.max(1.1, r * 0.16);
				if (seated) {
					// tucked legs — two small bent Ls under body
					ctx.beginPath();
					ctx.moveTo(cx - r * 0.22, cy + ry * 0.52);
					ctx.lineTo(cx - r * 0.22, cy + ry * 0.52 + r * 0.28);
					ctx.lineTo(cx + r * 0.05, cy + ry * 0.52 + r * 0.28);
					ctx.stroke();
					ctx.beginPath();
					ctx.moveTo(cx + r * 0.22, cy + ry * 0.52);
					ctx.lineTo(cx + r * 0.22, cy + ry * 0.52 + r * 0.28);
					ctx.lineTo(cx + r * 0.42, cy + ry * 0.52 + r * 0.28);
					ctx.stroke();
				} else {
					const legSwing = Math.sin(now / 220 + w.phase + Math.PI) * r * 0.28;
					ctx.beginPath();
					ctx.moveTo(cx - r * 0.3, cy + ry * 0.68);
					ctx.lineTo(cx - r * 0.3 + legSwing * 0.5, cy + ry * 0.68 + r * 0.58);
					ctx.stroke();
					ctx.beginPath();
					ctx.moveTo(cx + r * 0.3, cy + ry * 0.68);
					ctx.lineTo(cx + r * 0.3 - legSwing * 0.5, cy + ry * 0.68 + r * 0.58);
					ctx.stroke();
				}
			}

			// Arms — also behind body sides
			if (!isLeaving) {
				ctx.strokeStyle = 'rgba(0,0,0,0.5)';
				ctx.lineCap = 'round';
				ctx.lineWidth = Math.max(1.1, r * 0.15);
				if (seated) {
					// arms resting on laptop — short angled lines to laptop top
					const lapTop = cy + r * 0.28;
					ctx.beginPath();
					ctx.moveTo(cx - rx * 0.5, cy + r * 0.08);
					ctx.lineTo(cx - r * 0.2, lapTop);
					ctx.stroke();
					ctx.beginPath();
					ctx.moveTo(cx + rx * 0.5, cy + r * 0.08);
					ctx.lineTo(cx + r * 0.2, lapTop);
					ctx.stroke();
				} else {
					const armSwing = Math.sin(now / 220 + w.phase) * r * 0.34;
					ctx.beginPath();
					ctx.moveTo(cx - rx * 0.52, cy + 1);
					ctx.lineTo(cx - rx * 0.52 - armSwing * 0.55, cy + r * 0.52);
					ctx.stroke();
					ctx.beginPath();
					ctx.moveTo(cx + rx * 0.52, cy + 1);
					ctx.lineTo(cx + rx * 0.52 + armSwing * 0.55, cy + r * 0.52);
					ctx.stroke();
				}
			}

			// Body ellipse
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
			ctx.fill();

			// Highlight
			ctx.fillStyle = 'rgba(255,255,255,0.14)';
			ctx.beginPath();
			ctx.arc(cx - r * 0.25, cy - r * 0.3, r * 0.5, 0, Math.PI * 2);
			ctx.fill();

			// Laptop — drawn in front of seated bot
			if (seated) {
				const lapW = r * 1.7;
				const lapH = r * 0.62;
				const lapX = cx - lapW / 2;
				const lapY = cy + r * 0.32;
				// base
				ctx.fillStyle = '#1e1e26';
				roundRectPath(ctx, lapX, lapY, lapW, lapH, 1.5);
				ctx.fill();
				// screen — slightly raised
				ctx.fillStyle = '#2a2a33';
				roundRectPath(ctx, lapX + 1, lapY - r * 0.42, lapW - 2, r * 0.48, 1.2);
				ctx.fill();
				// screen glare
				ctx.fillStyle = 'rgba(255,255,255,0.07)';
				ctx.fillRect(lapX + 2, lapY - r * 0.42, lapW - 4, 1.2);
				// keyboard hint
				ctx.fillStyle = 'rgba(255,255,255,0.09)';
				for (let k = 0; k < 2; k++) {
					ctx.fillRect(lapX + 3, lapY + 2 + k * 3, lapW - 6, 1);
				}
			}

			// Sweatband (playing only, not while seated? keep for all)
			if (playing && !seated) {
				ctx.save();
				ctx.beginPath();
				ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
				ctx.clip();
				ctx.fillStyle = 'rgba(255,255,255,0.35)';
				ctx.fillRect(cx - r, cy - r * 0.55, 2 * r, r * 0.28);
				ctx.restore();
			} else if (playing && seated) {
				// thinner sweatband when seated (still visible)
				ctx.save();
				ctx.beginPath();
				ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
				ctx.clip();
				ctx.fillStyle = 'rgba(255,255,255,0.28)';
				ctx.fillRect(cx - r, cy - r * 0.52, 2 * r, r * 0.22);
				ctx.restore();
			}

			// Face (avatar/emoji/eyes) — centered on body
			if (bot) drawFace(ctx, bot, cx, cy - r * 0.04, r);

			// Hat — above face
			if (w.hat) drawHat(ctx, w.hat, cx, cy - r * 0.9, r, now);

			// Sweat (fat bots, playing only, not seated to reduce clutter)
			if (playing && w.bloat >= 0.6 && !seated) {
				ctx.fillStyle = SWEAT;
				const drip = (now / 140 + w.phase * 10) % 6;
				for (const side of [-1, 1] as const) {
					const sx = cx + side * r * 0.9;
					const sy = cy - r * 0.4 + drip;
					ctx.beginPath();
					ctx.arc(sx, sy, 1.6, 0, Math.PI * 2);
					ctx.fill();
				}
			}

			// Tag pill
			const botName = bot?.name ?? '';
			const word = bloatWord(w.bloat);
			// A bot with a round on the table wears the glass on its tag.
			let tag = word ? `${botName} \u00b7 ${word}` : botName;
			if (bot && pub.has(bot.id)) tag += ' \u{1F37A}';
			if (tag) {
				ctx.font = '10px system-ui, sans-serif';
				ctx.textAlign = 'center';
				const tw = ctx.measureText(tag).width;
				const hatExtra = w.hat ? 8 : 0;
				const ty = cy - r - hatExtra - 6;
				roundRectPath(ctx, cx - tw / 2 - 4, ty - 9, tw + 8, 13, 6);
				ctx.fillStyle = TAG_PILL;
				ctx.fill();
				ctx.fillStyle = TAG_TEXT;
				ctx.textBaseline = 'middle';
				ctx.fillText(tag, cx, ty - 2.5);
				ctx.textBaseline = 'alphabetic';
			}

			ctx.restore();
		}
	}

	function drawTo(ctx: CanvasRenderingContext2D | null, now: number, dt: number) {
		if (!ctx) return;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, W, H);
		ctx.drawImage(ensureStatic(), 0, 0);
		paintMatState(ctx, now);
		paintScoreboard(ctx, now);
		paintSwing(ctx, now);
		paintBag(ctx, now);
		paintMotes(ctx, now, dt);
		paintBots(ctx, now, dt);
	}

	function frame(now: number, dt: number) {
		drawTo(surface?.getContext('2d') ?? null, now, dt);
		if (expanded && overlaySurface) {
			drawTo(overlaySurface.getContext('2d'), now, dt);
		}
	}

	$effect(() => {
		// Props are read inside frame, so the loop never restarts on prop change.
		let raf = 0;
		let last = 0;
		const tick = (now: number) => {
			frame(now, last ? now - last : 16);
			last = now;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="gym"
	class:playing
	class:expanded
	role="button"
	tabindex="0"
	aria-label={expanded ? 'Play gym — expanded, click to close' : 'Play gym — click to expand'}
	onclick={toggleExpanded}
	onkeydown={handleGymKey}
>
	<canvas
		class="floor"
		bind:this={surface}
		width={W}
		height={H}
		aria-label="The play gym from above - bots wander the floor while a round is on"
	></canvas>
	<span class="label">
		{#if playing}
			play gym · round on — the heavy ones are struggling
		{:else}
			play gym · quiet floor
		{/if}
	</span>
	{#if expanded}
		{@const supping = bots.filter((b) => pub.has(b.id))}
		<span class="hint"
			>click or Esc to close · {bots.length} bots{bots.length ? ` · ${safeUsing().size} on laptops` : ''}{supping.length
				? ` · 🍺 ${supping.map((b) => `${b.name} (${b.green_tokens ?? 0})`).join(', ')}`
				: ''}</span
		>
	{/if}
</div>

{#if expanded}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={closeExpanded} aria-hidden="true"></div>
	<div class="overlay" role="dialog" aria-modal="true" aria-label="Play gym expanded">
		<button class="close" onclick={closeExpanded} aria-label="Close expanded gym">×</button>
		<canvas
			class="overlay-floor"
			bind:this={overlaySurface}
			width={W}
			height={H}
			aria-label="The play gym expanded view"
		></canvas>
		<span class="overlay-label">
			{#if playing}
				play gym · round on — the heavy ones are struggling
			{:else}
				play gym · quiet floor
			{/if}
		</span>
	</div>
{/if}

<style>
	.gym {
		position: relative;
		margin: 0.8rem;
		border-radius: 0.6rem;
		overflow: hidden;
		border: 0.35rem solid #6b4a2f;
		background: #241a12;
		box-shadow: inset 0 0 2rem rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}
	.gym:focus-visible {
		outline: 2px solid rgba(159, 139, 216, 0.7);
		outline-offset: 2px;
	}
	.floor {
		display: block;
		width: 100%;
		height: auto;
	}
	.label {
		position: absolute;
		left: 0.7rem;
		bottom: 0.5rem;
		font-size: 0.72rem;
		color: #c9b8a0;
		letter-spacing: 0.02em;
		pointer-events: none;
	}
	.gym.playing .label {
		color: #ffd9e2;
	}
	.gym.playing {
		box-shadow:
			inset 0 0 2rem rgba(0, 0, 0, 0.5),
			0 0 1.2rem rgba(159, 139, 216, 0.25);
	}
	.gym .hint {
		position: absolute;
		right: 0.6rem;
		top: 0.45rem;
		font-size: 0.66rem;
		color: rgba(255, 255, 255, 0.7);
		pointer-events: none;
	}
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(8, 8, 10, 0.72);
		backdrop-filter: blur(2px);
		z-index: 999;
	}
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: grid;
		place-items: center;
		padding: 2.5rem 1.2rem;
		pointer-events: none;
	}
	.overlay-floor {
		pointer-events: auto;
		display: block;
		width: min(92vw, 960px);
		height: auto;
		max-height: 78vh;
		border-radius: 0.7rem;
		border: 0.4rem solid #6b4a2f;
		background: #241a12;
		box-shadow:
			0 1.2rem 3rem rgba(0, 0, 0, 0.55),
			inset 0 0 2rem rgba(0, 0, 0, 0.4);
	}
	.overlay-label {
		margin-top: 0.6rem;
		font-size: 0.78rem;
		color: #c9b8a0;
		letter-spacing: 0.02em;
	}
	.close {
		pointer-events: auto;
		position: absolute;
		top: 1rem;
		right: 1rem;
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(20, 20, 24, 0.9);
		color: rgba(255, 255, 255, 0.9);
		font-size: 1.2rem;
		line-height: 1;
		cursor: pointer;
	}
	.close:hover {
		background: rgba(40, 40, 48, 0.95);
	}
</style>
