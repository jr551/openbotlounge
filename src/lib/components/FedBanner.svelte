<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import type { Peer } from '$lib/types';

	/**
	 * The pinned strip a federated conversation carries: the external bot is
	 * here, here is its fingerprint, and here are the two things the human can
	 * do about it. Data is fetched per conversation rather than riding the chat
	 * store - the strip is the only reader.
	 */
	let peer = $state<Peer | null>(null);
	let busy = $state(false);
	const convId = $derived(chat.activeConversation?.id ?? '');

	async function load(id: string) {
		peer = null;
		if (!id) return;
		const res = await fetch(`/api/fed/peers?conversation_id=${encodeURIComponent(id)}`).catch(
			() => null
		);
		if (res?.ok) peer = ((await res.json()) as { peer: Peer | null }).peer;
	}

	$effect(() => {
		void load(convId);
	});

	async function act(kind: 'remove' | 'block') {
		if (!peer || busy) return;
		busy = true;
		try {
			if (kind === 'remove') {
				await fetch(`/api/fed/peers?id=${peer.id}`, { method: 'DELETE' });
			} else {
				await fetch('/api/fed/peers/block', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id: peer.id, blocked: true })
				});
			}
		} finally {
			busy = false;
			void load(convId);
		}
	}
</script>

{#if peer}
	<div class="fedbar" role="note">
		<span class="spy" aria-hidden="true">🕵️</span>
		<span class="text">External bot <strong>{peer.name}</strong> is in this chat</span>
		<span class="fp" title="The peer's key fingerprint">{peer.fingerprint}</span>
		<span class="gap"></span>
		<button class="btn" disabled={busy} onclick={() => act('remove')}>Remove</button>
		<button class="btn danger" disabled={busy} onclick={() => act('block')}>Block</button>
	</div>
{/if}

<style>
	.fedbar {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.35rem 1rem;
		background: color-mix(in srgb, #8b5cf6 12%, var(--bg, #17171c));
		border-bottom: 1px solid color-mix(in srgb, #8b5cf6 35%, transparent);
		font-size: 0.8rem;
		color: var(--text);
	}
	/* The spy keeps watch: a plain CSS blink, slow enough to read the room. */
	.spy {
		font-size: 0.95rem;
		animation: spyflash 1.4s ease-in-out infinite;
	}
	@keyframes spyflash {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.15;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spy {
			animation: none;
		}
	}
	.fp {
		font-family: var(--mono, monospace);
		font-size: 0.68rem;
		opacity: 0.55;
	}
	.gap {
		flex: 1;
	}
	.btn {
		font-size: 0.72rem;
		padding: 0.15rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}
	.btn:hover {
		background: var(--bg-hover);
	}
	.btn.danger:hover {
		color: #ff6b6b;
		border-color: #ff6b6b;
	}
</style>
