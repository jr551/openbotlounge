<script lang="ts">
	import { onMount } from 'svelte';
	import { updated } from '$app/state';
	import '../app.css';
	import { chat } from '$lib/stores/chat.svelte';
	import PoliceAlert from '$lib/components/PoliceAlert.svelte';
	import PolicePrompt from '$lib/components/PolicePrompt.svelte';

	let { children } = $props();

	/**
	 * The theme lives on documentElement so every surface repaints at once.
	 * The store owns the value (loaded in init, changed from Settings); this
	 * only mirrors it, so a reload lands on the stored look as soon as init
	 * answers without the layout knowing any theme ids itself.
	 */
	$effect(() => {
		chat.applyTheme();
	});

	/**
	 * Offline is said once, here, rather than in each screen: the shell itself
	 * comes out of the service worker cache and renders perfectly, so without a
	 * word about the network every empty list and every send that goes nowhere
	 * reads as a bug in the app instead of a missing connection.
	 */
	let offline = $state(false);

	onMount(() => {
		if ('serviceWorker' in navigator) {
			void navigator.serviceWorker.register('/sw.js');
		}
		const sync = () => (offline = !navigator.onLine);
		sync();
		window.addEventListener('online', sync);
		window.addEventListener('offline', sync);
		return () => {
			window.removeEventListener('online', sync);
			window.removeEventListener('offline', sync);
		};
	});
</script>
{@render children()}

<!-- The police round's tap on the shoulder: a notice, never a chat message. -->
<PoliceAlert />
<!-- The police modal: a question with 2-4 choices, wherever the human is. -->
<PolicePrompt />

{#if offline}
	<div class="offlinebar" role="status">
		<span class="beacon" aria-hidden="true"></span>
		Offline — nothing you send will arrive
	</div>
{/if}

<!--
	A tab that is left open keeps running the JS it loaded, so a deployed fix is
	invisible until the page is reloaded - which is exactly the sort of "it still
	does not work" that is impossible to debug from the other side. SvelteKit
	polls the build's version when version.pollInterval is set; this offers the
	reload rather than taking it, because a reply may be streaming and a draft may
	be half-typed, and neither should be thrown away because a deploy happened.
-->
{#if updated.current}
	<button
		class="stale"
		onclick={() => location.reload()}
		title="This tab is running an older build of the app"
	>
		A new version is ready — reload
	</button>
{/if}

<style>
	.offlinebar {
		position: fixed;
		left: 50%;
		top: calc(0.4rem + env(safe-area-inset-top));
		transform: translateX(-50%);
		z-index: 80;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		max-width: calc(100vw - 1.5rem);
		background: #3b2a2a;
		border: 1px solid #5a3838;
		border-radius: 999px;
		color: #f3d9d9;
		font-size: 0.8rem;
		padding: 0.4rem 0.9rem;
		box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
		pointer-events: none;
	}
	.beacon {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--danger);
		flex: none;
		animation: blip 1.6s ease-in-out infinite;
	}
	@keyframes blip {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.beacon {
			animation: none;
		}
	}
	.stale {
		position: fixed;
		left: 50%;
		bottom: 1rem;
		transform: translateX(-50%);
		z-index: 60;
		background: var(--accent);
		border: none;
		border-radius: 999px;
		color: #fff;
		font-family: inherit;
		font-size: 0.82rem;
		padding: 0.5rem 1.1rem;
		cursor: pointer;
		box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
	}
	.stale:hover {
		filter: brightness(1.1);
	}
</style>
