<script lang="ts">
	/**
	 * Minimal emoji picker: a hover/click popover with a curated set. No
	 * dependency and no network - a chat needs a smiley row, not a full Unicode
	 * catalogue.
	 */
	let {
		onselect,
		title = 'Emoji',
		/** Icon size in px; the hit area scales with it. */
		size = 18,
		open = $bindable(false),
		/**
		 * Where to float the popover when the picker is shared: viewport coords
		 * of the button that asked for it. With one, the trigger button is not
		 * rendered - the caller owns it - and the popover is position:fixed.
		 */
		anchor
	}: {
		onselect: (emoji: string) => void;
		title?: string;
		size?: number;
		open?: boolean;
		anchor?: { x: number; y: number } | null;
	} = $props();

	const GROUPS: { name: string; emoji: string[] }[] = [
		{
			name: 'Smileys',
			emoji: [
				'😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
				'😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
				'😋', '😛', '😜', '🤪', '😝', '🤗', '🤭', '🤫', '🤔', '😐',
				'😑', '😶', '😏', '😒', '🙄', '😬', '😮', '😯', '😴', '🤤',
				'😪', '😵', '🤯', '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁',
				'😮‍💨', '😢', '😭', '😤', '😠', '😡', '🤬', '😈', '🤡', '👻'
			]
		},
		{
			name: 'Gestures',
			emoji: [
				'👍', '👎', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈',
				'👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤝',
				'🙏', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '💪'
			]
		},
		{
			name: 'Hearts',
			emoji: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💯', '🔥']
		},
		{
			name: 'Animals',
			emoji: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦄', '🐝']
		},
		{
			name: 'Food',
			emoji: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🥑', '🍞', '🧀', '🍕', '🍔', '🍟', '🌮', '🍣', '🍜', '🍰', '🍩', '🍪', '☕', '🍺', '🍷']
		},
		{
			name: 'Activity',
			emoji: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎱', '🎯', '🎮', '🕹️', '🎲', '🧩', '🎨', '🎬', '🎤', '🎧', '🎸', '🥁', '🏆', '🥇']
		},
		{
			name: 'Travel',
			emoji: ['🚗', '🚕', '🚙', '🚌', '🏎️', '🚓', '🚑', '🚒', '✈️', '🚀', '🚁', '⛵', '🚤', '🛸', '🏠', '🏢', '🌋', '🏔️', '🏖️', '🌍']
		},
		{
			name: 'Nature',
			emoji: ['🌟', '⭐', '✨', '⚡', '☄️', '💥', '🌈', '☀️', '🌤️', '⛅', '🌧️', '⛈️', '❄️', '🔥', '🌊', '🌸', '🌺', '🌻', '🌹', '🌲']
		},
		{
			name: 'Symbols',
			emoji: ['✅', '❌', '⚠️', '❗', '❓', '💤', '💬', '👀', '🧠', '🫡', '🎉', '🎊', '🎁', '🏅', '💡', '🔔', '📌', '🔒', '🧿', '♻️']
		}
	];

	const RECENT_KEY = 'openbotlounge:recent-emoji';
	const RECENT_MAX = 16;

	function loadRecent(): string[] {
		try {
			const raw = localStorage.getItem(RECENT_KEY);
			const list: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : [];
		} catch {
			return [];
		}
	}

	let activeGroup = $state(0);
	let wrap = $state<HTMLDivElement | undefined>(undefined);
	let gridEl: HTMLDivElement | undefined = $state();
	let recent = $state<string[]>(loadRecent());

	/** 'Recent' is a pseudo-category prepended only once the user has history. */
	const tabs = $derived(
		recent.length ? [{ name: 'Recent', emoji: recent }, ...GROUPS] : GROUPS
	);
	const current = $derived(tabs[Math.min(activeGroup, tabs.length - 1)]);

	/** True while the grid has rows below the fold - drives the bottom fade. */
	let moreBelow = $state(false);

	function updateMoreBelow() {
		moreBelow =
			!!gridEl && gridEl.scrollHeight - gridEl.scrollTop - gridEl.clientHeight > 1;
	}

	$effect(() => {
		// Re-measure when the popover opens or the visible group changes size.
		open;
		current;
		updateMoreBelow();
	});

	function selectGroup(i: number) {
		activeGroup = i;
		if (gridEl) gridEl.scrollTop = 0;
	}

	function pick(e: string) {
		recent = [e, ...recent.filter((r) => r !== e)].slice(0, RECENT_MAX);
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
		} catch {
			/* storage full or unavailable - recents are best-effort */
		}
		onselect(e);
		open = false;
	}

	function onWindowClick(e: MouseEvent) {
		if (open && wrap && !wrap.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} />

{#if anchor !== undefined}
	{#if open && anchor}
		<!-- The shared picker: the caller's button stays where it was, the
		     popover floats beside it in viewport space. -->
		<div class="pop fixed" style:left="{anchor.x}px" style:top="{anchor.y}px" role="dialog" aria-label="Pick an emoji" bind:this={wrap}>
			<div class="tabs" role="group" aria-label="Emoji categories">
				{#each tabs as g, i}
					<button
						class="tab"
						class:sel={i === activeGroup}
						type="button"
						onclick={() => selectGroup(i)}
						aria-label={g.name}
						aria-pressed={i === activeGroup}
						title={g.name}
					>
						{g.name === 'Recent' ? '🕘' : g.emoji[0]}
					</button>
				{/each}
			</div>
			<div class="gridwrap">
				<div class="grid" bind:this={gridEl} onscroll={updateMoreBelow}>
					{#each current.emoji as e}
						<button class="cell" type="button" onclick={() => pick(e)}>{e}</button>
					{/each}
				</div>
				{#if moreBelow}
					<div class="fade" aria-hidden="true"></div>
				{/if}
			</div>
		</div>
	{/if}
{:else}
<div class="wrap" bind:this={wrap}>
	<button
		class="ebtn"
		class:on={open}
		{title}
		type="button"
		onclick={() => (open = !open)}
		aria-label={title}
	>
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.2q3.5 2.6 7 0"/><path d="M11 15.6Q12 17.3 13 15.6Z" fill="currentColor" stroke="none"/><circle class="eye" cx="9" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle class="eye" cx="15" cy="10" r="1.15" fill="currentColor" stroke="none"/></svg>
	</button>

	{#if open}
		<div class="pop" role="dialog" aria-label="Pick an emoji">
			<div class="tabs" role="group" aria-label="Emoji categories">
				{#each tabs as g, i}
					<button
						class="tab"
						class:sel={i === activeGroup}
						type="button"
						onclick={() => selectGroup(i)}
						aria-label={g.name}
						aria-pressed={i === activeGroup}
						title={g.name}
					>
						{g.name === 'Recent' ? '🕘' : g.emoji[0]}
					</button>
				{/each}
			</div>
			<div class="gridwrap">
				<div class="grid" bind:this={gridEl} onscroll={updateMoreBelow}>
					{#each current.emoji as e}
						<button class="cell" type="button" onclick={() => pick(e)}>{e}</button>
					{/each}
				</div>
				{#if moreBelow}
					<div class="fade" aria-hidden="true"></div>
				{/if}
			</div>
		</div>
	{/if}
</div>
{/if}

<style>
	.wrap {
		position: relative;
		display: flex;
	}
	.pop {
		position: absolute;
		bottom: calc(100% + 0.55rem);
		right: 0;
		width: 19rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.9rem;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		overflow: hidden;
		z-index: 40;
	}
	.tabs {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--border);
		overflow-x: auto;
	}
	.tab {
		/* Equal shares of the row, glyph centred: the tabs read as an even
		   grid instead of ragged variable-width items. */
		flex: 1 1 0;
		min-width: 0;
		display: grid;
		place-items: center;
		background: none;
		border: none;
		font-size: 1rem;
		padding: 0.3rem 0;
		border-radius: 0.45rem;
		cursor: pointer;
		line-height: 1.2;
		opacity: 0.8;
		transition:
			opacity 0.12s ease,
			background 0.12s ease;
	}
	.tab:hover {
		opacity: 0.95;
		background: var(--bg-hover);
	}
	.tab.sel {
		opacity: 1;
		background: rgba(58, 123, 213, 0.22);
	}
	/* The shared picker's popover floats in viewport space beside the button
	   that asked for it. */
	.pop.fixed {
		position: fixed;
		bottom: auto;
		right: auto;
		transform: translateY(-100%);
	}
	.gridwrap {
		position: relative;
	}
	/* Hints that rows continue below the fold; only rendered while the grid
	   actually overflows, and never intercepts clicks. */
	.fade {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 2rem;
		background: linear-gradient(to bottom, transparent, var(--bg-raised));
		pointer-events: none;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 0.25rem;
		padding: 0.5rem;
		/* Exactly 6 rows tall: 6×2rem cells + 5×0.25rem gaps + 2×0.5rem
		   padding, so the bottom row is never sliced mid-glyph. */
		max-height: 14.25rem;
		overflow-y: auto;
	}
	.cell {
		display: grid;
		place-items: center;
		height: 2rem;
		background: none;
		border: none;
		font-size: 1.15rem;
		line-height: 1;
		padding: 0;
		border-radius: 0.45rem;
		cursor: pointer;
		transition: background 0.1s ease;
	}
	.cell:hover {
		background: var(--bg-hover);
	}
	.cell:focus-visible,
	.tab:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	/* Self-contained: a parent's scoped class cannot style this button. */
	.ebtn {
		display: grid;
		place-items: center;
		padding: 0.25rem;
		background: none;
		border: none;
		border-radius: 0.4rem;
		color: var(--text-muted);
		cursor: pointer;
		flex: none;
		line-height: 0;
	}
	.ebtn:hover,
	.ebtn.on {
		color: var(--text);
		background: var(--bg-hover);
	}
	.ebtn svg {
		transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.ebtn:hover svg {
		transform: rotate(8deg) scale(1.08);
	}
	.ebtn .eye {
		transform-box: fill-box;
		transform-origin: center;
		animation: emblink 5s infinite;
	}
	@keyframes emblink {
		0%,
		92%,
		100% {
			transform: scaleY(1);
		}
		95% {
			transform: scaleY(0.1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ebtn svg {
			transition: none;
		}
		.ebtn .eye {
			animation: none;
		}
	}
</style>
