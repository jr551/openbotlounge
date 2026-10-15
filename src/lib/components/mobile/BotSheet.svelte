<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import Avatar from '$lib/components/Avatar.svelte';
	import ScreenPanel from '$lib/components/ScreenPanel.svelte';
	import type { Bot } from '$lib/types';

	let {
		onClose,
		onEditBot,
		onRoutine
	}: {
		onClose: () => void;
		onEditBot: (bot: Bot) => void;
		onRoutine: () => void;
	} = $props();

	const bot = $derived(chat.panelBot);

	let sheetEl = $state<HTMLElement | null>(null);

	// Escape closes it like every other overlay; the sheet is focusable so the
	// key has somewhere to land.
	function onWindowKeydown(e: KeyboardEvent) {
		modalKeydown(e, sheetEl, onClose);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!--
	The desktop's third column, as a sheet that covers the phone instead. It is
	the same ScreenPanel - the screen, log, routines, secrets and usage are not
	reimplemented for mobile; only the frame around them is.
-->
<div class="sheet" role="dialog" aria-modal="true" aria-label="Bot panel" tabindex="-1" bind:this={sheetEl}>
	<header class="sheethead">
		<span class="grab" aria-hidden="true"></span>
		<button class="iconbtn" aria-label="Close panel" title="Close" onclick={onClose}>
			<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
		</button>
		{#if bot}
			<button
				class="who"
				title="Bot settings"
				onclick={() => {
					onEditBot(bot);
					onClose();
				}}
			>
				<Avatar color={bot.color} seed={bot.id} size={26} hat={bot.hat} />
				<span class="name">{bot.name}</span>
				<svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
			</button>
		{/if}
	</header>
	<div class="sheetbody">
		<ScreenPanel onCreateRoutine={onRoutine} />
	</div>
</div>

<style>
	.sheet {
		position: fixed;
		inset: 0;
		z-index: 45;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		animation: rise 0.22s ease-out;
	}
	@keyframes rise {
		from {
			transform: translateY(100%);
		}
		to {
			transform: none;
		}
	}
	.sheethead {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: calc(0.9rem + env(safe-area-inset-top)) 0.5rem 0.45rem;
		background: var(--bg-raised);
		border-bottom: 1px solid var(--border);
		flex: none;
	}
	/* The drag handle is a signpost, not a control: the sheet closes with the ✕
	   or by picking a chat, and a fake grabber that eats a swipe is worse than
	   none at all. */
	.grab {
		position: absolute;
		top: calc(0.3rem + env(safe-area-inset-top));
		left: 50%;
		transform: translateX(-50%);
		width: 36px;
		height: 4px;
		border-radius: 999px;
		background: var(--border);
	}
	.iconbtn {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		flex: none;
		background: none;
		border: none;
		border-radius: 50%;
		color: var(--text);
		cursor: pointer;
	}
	.iconbtn:active {
		background: var(--bg-hover);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		padding: 0.3rem 0.5rem;
		background: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text);
		cursor: pointer;
		text-align: left;
		font-family: inherit;
	}
	.who:active {
		background: var(--bg-hover);
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.9rem;
		font-weight: 600;
	}
	.chev {
		color: var(--text-muted);
		flex: none;
	}
	.sheetbody {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	/* The panel is a full-width column here rather than a fixed 340px rail. */
	.sheetbody :global(.panel) {
		width: 100%;
		min-width: 0;
		border-left: none;
		height: 100%;
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet {
			animation: none;
		}
	}
</style>
