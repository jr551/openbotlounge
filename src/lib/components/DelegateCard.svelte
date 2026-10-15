<script lang="ts">
	import type { Message } from '$lib/types';

	let { m }: { m: Message } = $props();

	/**
	 * The marker's JSON payload ({asker, target, task, declined?}). A marker
	 * that does not parse - one written by hand, or an older shape - still
	 * shows its raw text rather than vanishing from the thread.
	 */
	const d = $derived.by(():
		| { asker?: string; target?: string; task?: string; declined?: string }
		| null => {
		try {
			const v = JSON.parse(m.content);
			return v && typeof v === 'object' && (v.asker || v.target) ? v : null;
		} catch {
			return null;
		}
	});
</script>

<!-- A delegation is a handoff between bots, not something anyone said, so it
     reads as a small centred card rather than a bubble. -->
<div class="row">
	<div class="delegate" class:declined={d?.declined !== undefined}>
		{#if d && d.declined !== undefined}
			<span class="dlabel">⇄ <strong>{d.target}</strong> declined</span>
			{#if d.declined}<span class="dtask">{d.declined}</span>{/if}
		{:else if d}
			<span class="dlabel">⇄ <strong>{d.asker}</strong> asked <strong>{d.target}</strong></span>
			{#if d.task}<span class="dtask">{d.task}</span>{/if}
		{:else}
			<span class="dlabel">⇄ delegate</span>
			<span class="dtask">{m.content}</span>
		{/if}
	</div>
</div>

<style>
	.row {
		display: flex;
		justify-content: center;
	}
	.delegate {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
		max-width: min(76%, 34rem);
		padding: 0.35rem 0.9rem;
		background: rgba(139, 92, 246, 0.08);
		border: 1px solid rgba(139, 92, 246, 0.35);
		border-radius: 0.8rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		text-align: center;
	}
	.delegate.declined {
		background: rgba(242, 109, 109, 0.07);
		border-color: rgba(242, 109, 109, 0.3);
	}
	.dlabel {
		font-weight: 600;
		color: #b7a6f0;
	}
	.declined .dlabel {
		color: #e89a9a;
	}
	.dlabel strong {
		color: var(--text);
		font-weight: 600;
	}
</style>
