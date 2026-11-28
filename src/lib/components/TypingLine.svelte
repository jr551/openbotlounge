<script lang="ts">
	/**
	 * The server already streams real deltas. Show the latest tail directly -
	 * no timer, fake catch-up, random backtracking, or rewritten characters.
	 */
	let { text = '' }: { text: string } = $props();
	const tail = $derived(text.slice(-180));
</script>

<div class="typing-line" aria-hidden="true">
	<span class="preview">{tail}</span><span class="caret"></span>
</div>

<style>
	.typing-line {
		display: flex;
		align-items: center;
		min-width: 0;
		margin-top: 0.3rem;
		color: var(--text-muted, #888);
		font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace;
		font-size: 0.68rem;
		line-height: 1.35;
	}
	.preview {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.caret {
		flex: none;
		width: 2px;
		height: 1em;
		margin-left: 0.18rem;
		border-radius: 1px;
		background: var(--accent, #6a8fd8);
		animation: caret-blink 1s steps(1, end) infinite;
	}
	@keyframes caret-blink {
		0%,
		45% {
			opacity: 0.9;
		}
		55%,
		100% {
			opacity: 0.15;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.caret {
			animation: none;
			opacity: 0.75;
		}
	}
</style>
