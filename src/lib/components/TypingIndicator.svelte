<script lang="ts">
	/** A calm, deterministic typing indicator shared by chat and task surfaces. */
	let { label = 'typing', compact = false }: { label?: string; compact?: boolean } = $props();
</script>

<div class="typing-indicator" class:compact role="status" aria-label={label}>
	<span class="dot" aria-hidden="true"></span>
	<span class="dot" aria-hidden="true"></span>
	<span class="dot" aria-hidden="true"></span>
	<span class="sr-only">{label}</span>
</div>

<style>
	.typing-indicator {
		display: inline-flex;
		align-items: center;
		gap: 0.28rem;
		min-height: 1rem;
		color: var(--text-muted, #888);
	}
	.typing-indicator.compact {
		gap: 0.2rem;
		min-height: 0.8rem;
	}
	.dot {
		width: 0.34rem;
		height: 0.34rem;
		border-radius: 999px;
		background: currentColor;
		opacity: 0.32;
		animation: typing-wave 1.15s ease-in-out infinite;
		will-change: transform, opacity;
	}
	.dot:nth-child(2) {
		animation-delay: 0.14s;
	}
	.dot:nth-child(3) {
		animation-delay: 0.28s;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	@keyframes typing-wave {
		0%,
		60%,
		100% {
			opacity: 0.32;
			transform: translateY(0);
		}
		30% {
			opacity: 0.95;
			transform: translateY(-0.16rem);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot {
			animation: none;
			opacity: 0.68;
			will-change: auto;
		}
	}
</style>
