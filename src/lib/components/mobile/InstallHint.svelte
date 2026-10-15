<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * iOS Safari has no install prompt to catch - the only way onto the home
	 * screen is Share → Add to Home Screen, which nobody discovers on their own.
	 * So it is said once, in the chat list, and never again after a dismissal.
	 * Android and desktop do have a prompt, so this stays out of their way.
	 */
	const DISMISSED = 'obl_install_hint';

	let show = $state(false);

	onMount(() => {
		const ua = navigator.userAgent;
		// Chrome/Firefox/Edge on iOS are WebKit underneath but none of them
		// offers Add to Home Screen, so telling their users to look for it
		// would be instructions to do something that does not exist.
		const ios = /iP(hone|ad|od)/.test(ua);
		const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA/.test(ua);
		const installed =
			window.matchMedia('(display-mode: standalone)').matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true;
		show = ios && safari && !installed && localStorage.getItem(DISMISSED) !== '1';
	});

	function dismiss() {
		show = false;
		localStorage.setItem(DISMISSED, '1');
	}
</script>

{#if show}
	<div class="hint">
		<span class="glyph" aria-hidden="true">
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
		</span>
		<span class="txt">
			<strong>Add to Home Screen</strong>
			Tap Share, then “Add to Home Screen” — the lounge then opens full screen,
			with no browser bars.
		</span>
		<button class="x" aria-label="Dismiss" onclick={dismiss}>
			<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
		</button>
	</div>
{/if}

<style>
	.hint {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		margin: 0.5rem 0.6rem 0.2rem;
		padding: 0.7rem 0.75rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.8rem;
		font-size: 0.82rem;
		line-height: 1.45;
		color: #a9a9b3;
	}
	.glyph {
		color: var(--accent);
		flex: none;
		margin-top: 0.1rem;
	}
	.txt {
		flex: 1;
		min-width: 0;
	}
	.txt strong {
		display: block;
		color: var(--text);
		font-size: 0.86rem;
	}
	.x {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		flex: none;
		background: none;
		border: none;
		border-radius: 50%;
		color: var(--text-muted);
		cursor: pointer;
	}
	.x:active {
		background: var(--bg-hover);
	}
</style>
