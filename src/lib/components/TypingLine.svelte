<script lang="ts">
	/**
	 * Live model output, typed out the way a person writes: it catches up in
	 * bursts, sometimes backs up a few characters and rewrites them, and leaves
	 * a caret blinking at the end.
	 */
	let { text = '' }: { text: string } = $props();

	/** How much of `text` is currently on screen. */
	let shown = $state(0);
	let revising = $state(false);

	$effect(() => {
		const id = setInterval(() => {
			const target = text.length;
			if (shown < target) {
				// Type faster when we are far behind, so long replies still land.
				shown = Math.min(target, shown + Math.max(2, Math.ceil((target - shown) / 12)));
			} else if (shown > target) {
				shown = target;
			} else if (shown > 24 && Math.random() < 0.05) {
				// A small "hmm, no" - delete a few characters and rewrite them.
				shown -= Math.min(5, shown - 1);
				revising = true;
				setTimeout(() => (revising = false), 220);
			}
		}, 60);
		return () => clearInterval(id);
	});

	const visible = $derived(text.slice(Math.max(0, shown - 120), shown));
	const caughtUp = $derived(shown >= text.length);
</script>

<div class="typing" class:revising>
	<span class="chars">{visible}</span><span class="caret" class:blink={caughtUp}></span>
</div>

<style>
	.typing {
		font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace;
		font-size: 0.72rem;
		line-height: 1.45;
		color: #888;
		margin-top: 0.25rem;
		max-height: 3.4rem;
		overflow: hidden;
		word-break: break-word;
		letter-spacing: 0.01em;
	}
	.typing.revising .chars {
		text-decoration: line-through;
		text-decoration-color: rgba(242, 109, 109, 0.7);
	}
	.caret {
		display: inline-block;
		width: 0.5em;
		height: 1em;
		margin-left: 0.08em;
		background: #888;
		vertical-align: text-bottom;
		opacity: 0.9;
	}
	.caret.blink {
		animation: caret 1.05s steps(2, end) infinite;
	}
	@keyframes caret {
		0%,
		100% {
			opacity: 0.9;
		}
		50% {
			opacity: 0.15;
		}
	}
</style>
