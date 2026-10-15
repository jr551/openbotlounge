<script lang="ts">
	/**
	 * A bot's face: a blob whose silhouette is derived from its id, so every bot
	 * looks distinct but identical everywhere it appears (list, header, bubbles).
	 *
	 * State:
	 *  - `talking`  voice-bubble pulse while it streams a reply
	 *  - `working`  sits it behind a keyboard while it drives its computer
	 *  - `hat`      an explicit costume; wins over `activity` when given
	 *  - `activity` the bot's newest activity kind, which picks the costume
	 */
	let {
		color = '#4f8ef7',
		size = 34,
		seed = '',
		talking = false,
		working = false,
		hat,
		bloat = 0,
		activity = '',
		usage,
		svg,
		police
	}: {
		color?: string;
		size?: number;
		seed?: string;
		talking?: boolean;
		working?: boolean;
		/** A hat name as stored on the bot; anything unknown is ignored. */
		hat?: string;
		/** 0 = slim, 1 = enormous. How much bulk the bot has put on. */
		bloat?: number;
		/** Newest activity kind for this bot; drives which hat it wears. */
		activity?: string;
		/**
		 * The bot's row, when this face should carry its lifetime token meter.
		 * Left out, the avatar is just a face: not every list needs a bill.
		 */
		usage?: { input_tokens?: number; output_tokens?: number };
		/**
		 * The bot's own face as inline SVG, when it has drawn one. Left out,
		 * the face is looked up by its seed - every bot avatar passes its id
		 * there - so a custom face follows the bot everywhere it is drawn.
		 */
		svg?: string;
		/**
		 * Whether this face is the app's system bot, which wears a police beacon
		 * on its roof. Left out, the face is looked up by its seed instead - every
		 * bot avatar passes its id there - so the light follows him everywhere he
		 * is drawn without each list having to remember.
		 */
		police?: boolean;
	} = $props();

	import { bloatOf, tokensOf } from '$lib/bloat';
	import { hatForActivity, isHat, type HatName } from '$lib/hats';
	// The officer's light is found by the bot row, so a face drawn anywhere can
	// put the beacon on him without every list knowing who he is.
	import { chat } from '$lib/stores/chat.svelte';

	// A hat the bot has chosen beats the costume for what it is doing; when it has
	// chosen none, its activity picks one. The name may have come from the
	// database, so an unknown one is treated as no hat rather than rendered as
	// nothing at all.
	const worn = $derived((hat && isHat(hat) ? hat : '') || hatForActivity(activity));

	/** Clamped, because the number arrives from a database column. */
	const bulk = $derived(Math.max(0, Math.min(1, bloat)));

	/**
	 * How tall each hat is drawn above the head, in avatar units — read off the
	 * hat rules at the bottom of this file, including how far its moving parts
	 * swing. A hat worn on a full-size head would lean over the row above, so the
	 * head gives up exactly that much room and the pair fits the square the
	 * layout handed us. A hatted face therefore sits a little lower in its slot
	 * than a bare one, which is what a hat does to a head; everything stays
	 * inside the avatar's own bounds at every size.
	 */
	const HAT_HEIGHT: Record<HatName, number> = {
		cap: 0.35,
		hard: 0.32,
		antenna: 0.4,
		crown: 0.44,
		halo: 0.38,
		top: 0.46,
		flower: 0.5,
		night: 0.55,
		// The cone is 0.56em, and its brim floats just over the tip.
		wizard: 0.68,
		party: 0.64,
		// The rotor is 0.4em across and turns on the spot, so it sweeps a disc
		// that reaches further up than the beanie under it.
		propeller: 0.6
	};

	/** No hat takes more than this off the head; a taller one is drawn smaller. */
	const HAT_ROOM_MAX = 0.4;

	/** Room kept spare above a hat for the wobble, so a nod never breaks the line. */
	const HAT_WOBBLE = 0.06;

	/** The room the officer's beacon takes off the top, in avatar units. */
	const BEACON_ROOM = 0.18;

	/**
	 * Whether this face is the app's system bot - the police - which wears a
	 * light bar on its roof. A call site may say so outright; otherwise the face
	 * is looked up by the seed it was drawn from, which every bot avatar passes
	 * its id as, so his light shows wherever he appears without each list having
	 * to remember. Never by name: what he is called is not how he is found.
	 */
	const siren = $derived(police ?? (!!seed && !!chat.botById(seed)?.hidden));

	/**
	 * The bot's own face, when it has drawn one and the human approved it. An
	 * explicit `svg` wins; otherwise the row behind `seed` answers, the same
	 * way the police beacon does. The markup is sanitized server-side, so it
	 * is rendered as the SVG it is rather than quoted or framed.
	 */
	const face = $derived(
		svg ?? (chat.botById(seed)?.avatar || '')
	);

	/** The room a hat claims off the top of the avatar, and none if it wears none. */
	const hatRoom = $derived(
		worn ? Math.min(HAT_HEIGHT[worn], HAT_ROOM_MAX) : siren ? BEACON_ROOM : 0
	);

	/** FNV-1a: small, stable, and good enough to scatter blob shapes. */
	function hash(s: string): number {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return h >>> 0;
	}

	/** Deterministic PRNG so a bot keeps the same shape forever. */
	function rng(seedValue: number): () => number {
		let a = seedValue || 1;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	/**
	 * Silhouettes, one per bot. Rounded ones are border-radius; the angular ones a
	 * clip-path, which is the only way to get a hexagon or a star. Corner rounding
	 * alone made every bot some kind of blob, however far the eight radii were
	 * spread, because a rounded rectangle still reads as a rounded rectangle.
	 */
	const SHAPES = [
		'blob',
		'circle',
		'squircle',
		'egg',
		'pill',
		'hex',
		'diamond',
		'pentagon',
		'triangle',
		'star'
	] as const;
	type ShapeName = (typeof SHAPES)[number];

	const CLIPS: Record<string, string> = {
		hex: 'polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0% 50%)',
		diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
		pentagon: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)',
		triangle: 'polygon(50% 4%, 98% 96%, 2% 96%)',
		star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)'
	};

	const shape = $derived.by(() => {
		const h = hash(seed || color);
		const r = rng(h);
		const pct = (min: number, max: number) => Math.round(min + r() * (max - min));
		const name: ShapeName = SHAPES[hash(`${seed || color}:shape`) % SHAPES.length];

		// How tall or wide this silhouette is allowed to be squashed. A circle that
		// is stretched is an ellipse, which is a different shape from the one the
		// bot was given, so the round ones barely move and the blob keeps its wobble.
		const stretch: Record<ShapeName, [number, number, number, number]> = {
			blob: [0.86, 1.16, 0.86, 1.16],
			circle: [0.97, 1.03, 0.97, 1.03],
			squircle: [0.92, 1.08, 0.92, 1.08],
			egg: [0.88, 0.98, 1.06, 1.2],
			pill: [1.12, 1.3, 0.74, 0.86],
			hex: [0.92, 1.08, 0.92, 1.08],
			diamond: [0.9, 1.06, 0.9, 1.06],
			pentagon: [0.92, 1.08, 0.92, 1.08],
			triangle: [0.95, 1.1, 0.9, 1.02],
			star: [0.92, 1.06, 0.92, 1.06]
		};
		const [sx1, sx2, sy1, sy2] = stretch[name];
		// Drawn whether or not it is used, so a circle's face is still made from
		// the same rolls as everyone else's.
		const turn = Math.round(-10 + r() * 20);

		const radius =
			name === 'circle'
				? '50%'
				: name === 'squircle'
					? `${pct(30, 38)}%`
					: name === 'egg'
						? '50% 50% 50% 50% / 62% 62% 38% 38%'
						: name === 'pill'
							? '50% / 46%'
							: // the organic one: eight independent radii
								`${pct(18, 78)}% ${pct(18, 78)}% ${pct(18, 78)}% ${pct(18, 78)}% / ${pct(18, 78)}% ${pct(18, 78)}% ${pct(18, 78)}% ${pct(18, 78)}%`;

		return {
			name,
			radius,
			clip: CLIPS[name] ?? '',
			// A circle looks the same however it is turned, so it is not turned:
			// that way it keeps its full width instead of paying for corners it
			// does not have.
			rotate: name === 'circle' ? 0 : turn,
			scaleX: sx1 + r() * (sx2 - sx1),
			scaleY: sy1 + r() * (sy2 - sy1),
			eyeGap: 0.24 + r() * 0.16,
			eyeSize: 0.3 + r() * 0.1,
			tilt: Math.round(-6 + r() * 12),
			// A triangle and a star carry their mass low, so eyes sit better nudged
			// down; on the others the middle is right.
			eyeDrop: name === 'triangle' ? 0.16 : name === 'star' ? 0.06 : 0
		};
	});

	/**
	 * The avatar's own geometry, in fractions of the square the layout gave us.
	 *
	 * Everything is drawn *inside* that square: the head is as big as its shape,
	 * its bulk and whatever a hat took leave, capped at the box on each side; it
	 * is drawn down until its tilted outline fits (a tilted square needs a wider
	 * berth than a circle, which needs none); and it is lifted until its lowest
	 * corner stands on the floor rather than through it. The eyes are sized off
	 * the head, not the box, so a wide-eyed face on a narrow head gets smaller
	 * eyes instead of eyes that cross its edge.
	 */
	const geometry = $derived.by(() => {
		const rad = (shape.rotate * Math.PI) / 180;
		const sin = Math.abs(Math.sin(rad));
		const cos = Math.abs(Math.cos(rad));
		const head = 1 - hatRoom;
		const wide = head * Math.min(1, shape.scaleX * (1 + 0.3 * bulk));
		const tall = head * Math.min(1, shape.scaleY * (1 + 0.07 * bulk));
		// The outline a tilted silhouette sweeps out: draw it down until that
		// outline, corners and all, fits the square the layout gave us.
		const spanW = wide * cos + tall * sin;
		const spanH = wide * sin + tall * cos;
		const fit = Math.min(1, 1 / Math.max(spanW, spanH));
		const w = wide * fit;
		const h = tall * fit;
		// Enough room for the eyes as drawn, the way this bot's eyes are set, plus
		// the tilt of the pair.
		const eyeRad = (shape.tilt * Math.PI) / 180;
		const eyeBox = 1 + Math.abs(Math.sin(eyeRad));
		const eyes = Math.min(
			1,
			w / (eyeBox * (2 * shape.eyeSize + shape.eyeGap)),
			h / (eyeBox * (shape.eyeSize * 1.3 + 2 * Math.abs(shape.eyeDrop)))
		);
		return {
			w,
			h,
			eyes,
			// Where the head's top lands, from the floor of the box: what a hat
			// stands on, and what is left above it is all the room a hat gets.
			roof: h + ((spanH - tall) * fit) / 2
		};
	});

	/**
	 * A hat is drawn down until it fits the room the head left it, so the tallest
	 * of them can be tall without leaning over the row above.
	 */
	const hatFit = $derived(
		worn ? Math.min(1, (1 - geometry.roof) / (HAT_HEIGHT[worn] + HAT_WOBBLE)) : 1
	);

	/**
	 * Each bot blinks on its own clock.
	 *
	 * The animation used to start when the avatar mounted, so every bot on screen
	 * began its cycle together and they blinked in unison. A negative delay starts
	 * each one part-way through, and the cycle length varies a little too, so they
	 * drift apart rather than staying offset by a fixed amount.
	 */
	const timing = $derived.by(() => {
		const key = seed || color;
		const unit = (salt: string) => (hash(key + salt) % 1000) / 1000;
		const blinkSeconds = 4.2 + unit(':blinklen') * 2.6;
		return {
			blinkSeconds,
			blinkDelay: -(unit(':blink') * blinkSeconds),
			// Two eyes never quite move as one, and how far behind the second one
			// lags is the bot's own. Some bots also blink slowly, so even two
			// neighbours that happen to start together do not stay together.
			eyeLag: 0.05 + unit(':eyelag') * 0.09,
			lazy: unit(':blinkstyle') < 0.45,
			squishDelay: -(unit(':squish') * 5),
			wobbleDelay: -(unit(':wobble') * 3.4)
		};
	});

	/**
	 * Eyes need to read on any fill: dark eyes vanish on purple/brown blobs and
	 * light eyes vanish on yellow/white ones, so pick by the fill's luminance.
	 * The meter uses the same ink, so it reads on the same fills, with the empty
	 * part of the bar a thin wash of it.
	 */
	function eyeColoursFor(c: string): { ink: string; track: string } {
		const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
		if (!m) return { ink: '#15151a', track: 'rgba(21, 21, 26, 0.32)' };
		let hex = m[1];
		if (hex.length === 3)
			hex = hex
				.split('')
				.map((ch) => ch + ch)
				.join('');
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		const ink = lum > 140 ? '21, 21, 26' : '242, 243, 247';
		return { ink: `rgb(${ink})`, track: `rgba(${ink}, 0.32)` };
	}

	const eye = $derived(eyeColoursFor(color));

	/**
	 * The bot's lifetime bill on the same yardstick as its waistline, so the bar
	 * and the shape agree: 0 empty, 1 as much as the lounge has ever seen. Null
	 * when this avatar was not asked to carry a meter.
	 */
	const meter = $derived(usage ? bloatOf(usage) : null);
	const meterTitle = $derived(
		usage
			? `${tokensOf(usage).toLocaleString()} tokens spent · ${(
					usage.input_tokens ?? 0
				).toLocaleString()} in · ${(usage.output_tokens ?? 0).toLocaleString()} out`
			: ''
	);
</script>

<span
	class="wrap"
	class:working
	class:hatted={!!worn}
	style:width="{size}px"
	style:height="{size}px"
	style:--blob={color}
	style:font-size="{size}px"
	style:--w={geometry.w}
	style:--h={geometry.h}
	style:--roof={geometry.roof}
	style:--beacon-lift={worn ? Math.min(HAT_HEIGHT[worn], HAT_ROOM_MAX) : 0}
	style:--eyes={geometry.eyes}
	style:--blink-len="{timing.blinkSeconds.toFixed(2)}s"
	style:--blink-delay="{timing.blinkDelay.toFixed(2)}s"
	style:--eye-lag="{timing.eyeLag.toFixed(2)}s"
	style:--squish-delay="{timing.squishDelay.toFixed(2)}s"
	style:--wobble-delay="{timing.wobbleDelay.toFixed(2)}s"
>
	<!-- A hat sits on the head, so it takes its room off the top of the avatar
	     and the head is drawn into what is left. That is what keeps the tallest
	     hat inside the row instead of leaning over the message above it. -->
	{#if worn === 'party'}
		<span class="hat party" style:font-size="{hatFit}em"><span class="pom"></span></span>
	{:else if worn === 'cap'}
		<span class="hat cap" style:font-size="{hatFit}em"
			><span class="peak"></span><span class="b"></span></span
		>
	{:else if worn === 'top'}
		<span class="hat top" style:font-size="{hatFit}em"><span class="brim"></span></span>
	{:else if worn === 'hard'}
		<span class="hat hard" style:font-size="{hatFit}em"><span class="brim"></span></span>
	{:else if worn === 'night'}
		<span class="hat night" style:font-size="{hatFit}em"><span class="tip"></span></span>
	{:else if worn === 'wizard'}
		<span class="hat wizard" style:font-size="{hatFit}em"
			><span class="brim"></span><span class="star"></span></span
		>
	{:else if worn === 'crown'}
		<span class="hat crown" style:font-size="{hatFit}em"
			><span class="pt"></span><span class="pt"></span><span class="pt"></span></span
		>
	{:else if worn === 'propeller'}
		<span class="hat beanie" style:font-size="{hatFit}em"
			><span class="rotor"><span class="blade"></span><span class="blade"></span></span></span
		>
	{:else if worn === 'halo'}
		<span class="hat halo" style:font-size="{hatFit}em"></span>
	{:else if worn === 'antenna'}
		<span class="hat antenna" style:font-size="{hatFit}em"
			><span class="stalk"></span><span class="bulb"></span></span
		>
	{:else if worn === 'flower'}
		<span class="hat flower" style:font-size="{hatFit}em"
			><span class="petal"></span><span class="petal"></span><span class="petal"></span><span
				class="petal"
			></span><span class="core"></span></span
		>
	{/if}

	{#if siren}
		<!-- The light bar: two lamps on the roof, flashing against each other, and
		     drawn above the head the way a hat is. Small enough that the face under
		     it stays the thing you recognise. -->
		<span class="beacon" aria-hidden="true">
			<span class="lamp blue"></span>
			<span class="lamp red"></span>
		</span>
	{/if}

	{#if face}
		<!-- A face the bot drew itself replaces the blob outright; the hat and
		     the beacon still sit on top of it, and the meter still rides its
		     foot. -->
		<span class="blob customface">
			{@html face}
			{#if meter !== null}
				<span class="meter" title={meterTitle}>
					<span class="fill" style:--fill={meter}></span>
				</span>
			{/if}
		</span>
	{:else}
	<span
		class="blob"
		class:talking
		style:background={color}
		style:border-radius={shape.radius}
		style:clip-path={shape.clip || null}
		style:rotate="{shape.rotate}deg"
		style:--eye={eye.ink}
		style:--eye-track={eye.track}
	>
		<span
			class="eyes"
			style:gap="{shape.eyeGap}em"
			style:rotate="{shape.tilt}deg"
			style:margin-top="{shape.eyeDrop}em"
		>
			<span
				class="eye"
				class:lazy={timing.lazy}
				style:width="{shape.eyeSize}em"
				style:height="{shape.eyeSize * 1.3}em"
			></span>
			<span
				class="eye"
				class:lazy={timing.lazy}
				style:width="{shape.eyeSize}em"
				style:height="{shape.eyeSize * 1.3}em"
			></span>
		</span>
		{#if meter !== null}
			<!-- The meter sits on the face's own foot: the silhouette clips it, and
			     it is held level however the blob beneath it is tilted. -->
			<span class="meter" title={meterTitle} style:rotate="{-shape.rotate}deg">
				<span class="fill" style:--fill={meter}></span>
			</span>
		{/if}
	</span>
	{/if}

	{#if working}
		<span class="desk">
			<span class="arm left"></span>
			<span class="arm right"></span>
			<span class="keyboard"></span>
		</span>
	{/if}
</span>

<style>
	.wrap {
		display: inline-grid;
		/* The box the layout gave us is the avatar's own bounds: a hat, however
		 * tall, must not stretch the row it sits in. */
		grid-template-rows: 100%;
		grid-template-columns: 100%;
		place-items: end center;
		flex-shrink: 0;
		position: relative;
		overflow: visible;
		/* The whole costume breathes, not just the face, and it breathes inward so
		 * the widest frame of the animation is still the resting one. */
		transform-origin: 50% 100%;
		animation: squish 5s ease-in-out infinite;
		animation-delay: var(--squish-delay, 0s);
	}
	.blob {
		/* Bottom-anchored, then lifted so the lowest corner of a tilted silhouette
		 * stands on the floor instead of dipping through it. */
		position: absolute;
		left: 0;
		right: 0;
		margin: 0 auto;
		bottom: calc((var(--roof, 1) - var(--h, 1)) * 100%);
		width: calc(100% * var(--w, 1));
		height: calc(100% * var(--h, 1));
		/* The eyes are drawn in em, so the head sets their size. */
		font-size: calc(var(--eyes, 1) * 1em);
		/* Clips the eyes and the meter to the silhouette, whatever shape that is. */
		overflow: hidden;
		display: grid;
		place-items: center;
		/* A lit rim plus a contact shadow lift the blob off the near-black UI;
		 * the rim does the work on dark fills, the shadow on light ones. */
		box-shadow:
			inset 0 0 0 1px rgba(255, 255, 255, 0.16),
			inset 0 -0.06em 0.14em rgba(0, 0, 0, 0.22),
			0 1px 3px rgba(0, 0, 0, 0.5);
	}
	/* A face the bot drew itself: the blob's box and shadow stay, the fill is
	   the markup it made. The svg fills the box; its own viewBox decides how. */
	.blob.customface {
		background: none;
		box-shadow: none;
		overflow: visible;
	}
	.blob.customface :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}
	.eyes {
		display: flex;
		align-items: center;
		transition: transform 0.18s ease;
	}
	.wrap:hover .eyes {
		transform: scale(1.06);
	}
	.eye {
		background: var(--eye, #0e0e10);
		border-radius: 50%;
		animation: blink var(--blink-len, 5s) infinite;
		animation-delay: var(--blink-delay, 0s);
	}
	/* A slow blink, for the bots whose hash says they take their time. A class
	 * rather than an animation-name in a custom property: the build renames
	 * keyframes per component, and a name that arrives at runtime misses. */
	.eye.lazy {
		animation-name: blink-lazy;
	}
	/* The second eye follows a beat behind, and how far behind is this bot's own
	 * — two eyes moving as one on every bot is the tell of a paper mask. */
	.eye:last-child {
		animation-delay: calc(var(--blink-delay, 0s) + var(--eye-lag, 0.09s));
	}
	.talking {
		animation: talk 0.55s ease-in-out infinite;
	}
	.talking .eye {
		animation: none;
		transform: scaleY(1.15);
	}

	/* ---- the meter ---- */
	/* A thin bar across the foot of the face: how much of the lounge's yardstick
	 * this bot's lifetime bill has eaten, in the same ink as its eyes so it reads
	 * on any fill. The exact numbers are in the tooltip. */
	.meter {
		position: absolute;
		left: 12%;
		right: 12%;
		bottom: 7%;
		height: max(2px, 0.06em);
		border-radius: 999px;
		background: var(--eye-track, rgba(0, 0, 0, 0.32));
		overflow: hidden;
	}
	.meter .fill {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: inherit;
		background: var(--eye, #15151a);
		transform: scaleX(var(--fill, 0));
		transform-origin: 0 50%;
		transition: transform 0.4s ease;
	}

	/* ---- hats ---- */
	.hat {
		/* Sits on the head, where the head actually is: the anchor is the top of
		 * the blob, which the avatar moved down to make room for it. */
		position: absolute;
		left: 50%;
		translate: -50% 0;
		bottom: calc(var(--roof, 1) * 100%);
		z-index: 3;
		animation: hatwobble 3.4s ease-in-out infinite;
		animation-delay: var(--wobble-delay, 0s);
		transform-origin: 50% 100%;
	}
	/* The light bar rides the same anchor a hat does, above any hat he is wearing
	   (a police car's beacon sits on the roof, not through the seats). It is one
	   small pill split into a blue lamp and a red one, so both colours are on him
	   at every moment and only their brightness trades places. */
	.beacon {
		position: absolute;
		left: 50%;
		translate: -50% 0;
		bottom: calc((var(--roof, 1) + var(--beacon-lift, 0)) * 100%);
		z-index: 4;
		display: flex;
		width: 0.38em;
		height: 0.18em;
		border-radius: 999px;
		overflow: hidden;
		box-shadow: 0 0 0.2em rgba(0, 0, 0, 0.5);
	}
	.lamp {
		flex: 1 1 50%;
		animation: 1.6s ease-in-out infinite;
	}
	.lamp.blue {
		background: #3b82f6;
		box-shadow: 0 0 0.3em rgba(59, 130, 246, 0.95);
		animation-name: lamp-blue;
	}
	.lamp.red {
		background: #ef4444;
		box-shadow: 0 0 0.3em rgba(239, 68, 68, 0.95);
		animation-name: lamp-red;
	}
	@keyframes lamp-blue {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.32;
		}
	}
	@keyframes lamp-red {
		0%,
		100% {
			opacity: 0.32;
		}
		50% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		/* Both lamps lit, and steady. */
		.lamp {
			animation: none;
			opacity: 0.9;
		}
	}
	@keyframes hatwobble {
		0%,
		100% {
			transform: rotate(-5deg) translateY(0);
		}
		50% {
			transform: rotate(5deg) translateY(-4%);
		}
	}

	.halo {
		width: 0.62em;
		height: 0.2em;
		/* Hovers over the head rather than resting on it. */
		margin-bottom: 0.04em;
		border: 0.07em solid #ffd76a;
		border-radius: 50%;
		background: none;
		box-shadow: 0 0 0.12em rgba(255, 215, 106, 0.7);
	}
	.antenna {
		width: 0.3em;
		height: 0.3em;
		background: none;
	}
	.antenna .stalk {
		position: absolute;
		left: 50%;
		bottom: 0;
		width: 0.05em;
		height: 0.34em;
		margin-left: -0.025em;
		background: #6f7480;
		border-radius: 0.03em;
	}
	.antenna .bulb {
		position: absolute;
		left: 50%;
		top: 0;
		width: 0.16em;
		height: 0.16em;
		margin-left: -0.08em;
		border-radius: 50%;
		background: #7ee0a8;
		box-shadow: 0 0 0.16em rgba(126, 224, 168, 0.9);
		animation: bob 1.6s ease-in-out infinite;
	}
	.flower {
		width: 0.5em;
		height: 0.5em;
		background: none;
	}
	.flower .petal {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 0.19em;
		height: 0.19em;
		margin: -0.095em 0 0 -0.095em;
		border-radius: 50%;
		background: #ff9ec4;
	}
	.flower .petal:nth-child(1) {
		transform: translateY(-0.15em);
	}
	.flower .petal:nth-child(2) {
		transform: translateX(0.15em);
	}
	.flower .petal:nth-child(3) {
		transform: translateY(0.15em);
	}
	.flower .petal:nth-child(4) {
		transform: translateX(-0.15em);
	}
	.flower .core {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 0.14em;
		height: 0.14em;
		margin: -0.07em 0 0 -0.07em;
		border-radius: 50%;
		background: #ffd76a;
	}
	.cap {
		width: 0.62em;
		height: 0.3em;
		background: #2f6f4f;
		border-radius: 0.3em 0.3em 0.08em 0.08em;
	}
	.cap .peak {
		position: absolute;
		left: 0.5em;
		bottom: 0;
		width: 0.26em;
		height: 0.09em;
		background: #245a3f;
		border-radius: 0 0.12em 0.12em 0;
	}
	.cap .b {
		position: absolute;
		left: 50%;
		top: -0.05em;
		width: 0.09em;
		height: 0.09em;
		margin-left: -0.045em;
		border-radius: 50%;
		background: #245a3f;
	}

	.party {
		width: 0.5em;
		height: 0.5em;
		background: repeating-linear-gradient(45deg, #ff5d8f 0 0.07em, #ffd166 0.07em 0.14em);
		clip-path: polygon(50% 0, 100% 100%, 0 100%);
	}
	.party .pom {
		position: absolute;
		top: -0.09em;
		left: 50%;
		width: 0.13em;
		height: 0.13em;
		margin-left: -0.065em;
		border-radius: 50%;
		background: #fff;
		animation: bob 1.1s ease-in-out infinite;
	}

	.top {
		width: 0.42em;
		height: 0.46em;
		background: #17171b;
		border-radius: 0.05em 0.05em 0 0;
		border-bottom: 0.06em solid #b03a48;
	}
	.top .brim {
		position: absolute;
		bottom: -0.1em;
		left: -0.16em;
		width: 0.74em;
		height: 0.09em;
		background: #17171b;
		border-radius: 999px;
	}

	.hard {
		width: 0.62em;
		height: 0.32em;
		background: #f2b21c;
		border-radius: 0.3em 0.3em 0.06em 0.06em;
		box-shadow: inset 0 0.05em 0 rgba(255, 255, 255, 0.3);
	}
	.hard .brim {
		position: absolute;
		bottom: -0.06em;
		left: -0.09em;
		width: 0.8em;
		height: 0.09em;
		background: #d99a10;
		border-radius: 999px;
	}

	.night {
		width: 0.5em;
		height: 0.42em;
		background: linear-gradient(#4c5fd5, #37439b);
		border-radius: 0.34em 0.12em 0.06em 0.06em;
		transform-origin: 90% 100%;
	}
	.night .tip {
		position: absolute;
		top: -0.08em;
		right: -0.06em;
		width: 0.15em;
		height: 0.15em;
		border-radius: 50%;
		background: #eef1ff;
		animation: bob 2.1s ease-in-out infinite;
	}

	.wizard {
		width: 0;
		height: 0;
		border-left: 0.26em solid transparent;
		border-right: 0.26em solid transparent;
		border-bottom: 0.56em solid #5c3fa8;
	}
	.wizard .brim {
		position: absolute;
		bottom: -0.03em;
		left: -0.38em;
		width: 0.76em;
		height: 0.09em;
		background: #5c3fa8;
		border-radius: 999px;
	}
	.wizard .star {
		position: absolute;
		top: 0.22em;
		left: -0.04em;
		width: 0.08em;
		height: 0.08em;
		background: #ffe08a;
		clip-path: polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
		animation: twinkle 1.6s ease-in-out infinite;
	}

	.crown {
		display: flex;
		align-items: flex-start;
		width: 0.56em;
		height: 0.3em;
		background: #f4c430;
		border-radius: 0.04em;
		box-shadow: inset 0 -0.05em 0 rgba(0, 0, 0, 0.15);
	}
	.crown .pt {
		width: 0.12em;
		height: 0.16em;
		margin: -0.14em 0.05em 0;
		background: #f4c430;
		clip-path: polygon(50% 0, 100% 100%, 0 100%);
	}

	.beanie {
		width: 0.56em;
		height: 0.3em;
		background: #d94f70;
		border-radius: 0.3em 0.3em 0.06em 0.06em;
	}
	.beanie .rotor {
		position: absolute;
		top: -0.12em;
		left: 50%;
		width: 0.4em;
		height: 0.05em;
		margin-left: -0.2em;
		background: #9aa0ad;
		border-radius: 999px;
		transform-origin: 50% 50%;
		animation: spin 0.7s linear infinite;
	}
	.beanie .blade {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: #c3c8d2;
		border-radius: 999px;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes bob {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-35%);
		}
	}
	@keyframes twinkle {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.4;
			transform: scale(0.7);
		}
	}

	/* ---- keyboard ---- */
	.desk {
		grid-area: 1 / 1;
		position: relative;
		width: 74%;
		height: 30%;
		/* Sits on the foot of the box, not under it. */
		margin-bottom: 0;
		z-index: 2;
	}
	.keyboard {
		position: absolute;
		inset: 20% 0 0 0;
		/* Lighter than the blob's shadow so the keys read at 30-40px. */
		background: #6f7480;
		border: 1px solid #9aa0ad;
		/* Corner radii split by axis: 0.18em on a 30px face is 5.4px against a
		 * 7px-tall box, which rounded the whole slab into a pill - the desk read
		 * as a second circle under a circle-shaped bot. Percentages keep the
		 * corners a rectangle's corners at every avatar size. */
		border-radius: 12% / 25%;
		background-image: repeating-linear-gradient(
			90deg,
			transparent 0 10%,
			#2b2f38 10% 13%,
			transparent 13% 22%
		);
		box-shadow: 0 0.06em 0.12em rgba(0, 0, 0, 0.5);
	}
	.arm {
		position: absolute;
		bottom: 22%;
		width: 15%;
		height: 56%;
		background: var(--blob);
		/* A rim keeps the arm readable where it crosses the blob's own colour. */
		border: 1px solid rgba(255, 255, 255, 0.35);
		border-radius: 45%;
		z-index: 3;
	}
	.arm.left {
		left: 6%;
		transform-origin: 50% 100%;
		animation: type 0.42s steps(2, end) infinite;
	}
	.arm.right {
		right: 6%;
		transform-origin: 50% 100%;
		animation: type 0.42s steps(2, end) infinite reverse;
	}

	@keyframes squish {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(0.98, 0.96);
		}
	}
	@keyframes blink {
		0%,
		92%,
		100% {
			transform: scaleY(1);
		}
		95% {
			transform: scaleY(0.1);
		}
	}
	/* The same blink, taken slowly: a shade longer shut, a shade longer between. */
	@keyframes blink-lazy {
		0%,
		88%,
		100% {
			transform: scaleY(1);
		}
		94% {
			transform: scaleY(0.08);
		}
	}
	@keyframes talk {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(0.96);
		}
	}
	@keyframes type {
		0% {
			transform: translateY(0) rotate(-6deg);
		}
		100% {
			transform: translateY(-16%) rotate(6deg);
		}
	}

	/* While the bot works its desk its blob breathes a soft halo: a glow pulse
	 * only, so the silhouette never moves. */
	.wrap.working .blob:not(.customface) {
		animation: workglow 2s ease-in-out infinite;
	}
	@keyframes workglow {
		0%,
		100% {
			box-shadow:
				inset 0 0 0 1px rgba(255, 255, 255, 0.16),
				inset 0 -0.06em 0.14em rgba(0, 0, 0, 0.22),
				0 1px 3px rgba(0, 0, 0, 0.5),
				0 0 0 rgba(255, 255, 255, 0);
		}
		50% {
			box-shadow:
				inset 0 0 0 1px rgba(255, 255, 255, 0.16),
				inset 0 -0.06em 0.14em rgba(0, 0, 0, 0.22),
				0 1px 3px rgba(0, 0, 0, 0.5),
				0 0 0.35em rgba(255, 255, 255, 0.35);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.eyes {
			transition: none;
		}
		.wrap:hover .eyes {
			transform: none;
		}
		/* Outranks the lazy class, so nobody blinks at all under reduced motion. */
		.wrap .eye {
			animation: none;
		}
		.meter .fill {
			transition: none;
		}
		/* The work glow stays off too: reduced motion means no animation. */
		.wrap.working .blob:not(.customface) {
			animation: none;
		}
	}
</style>
