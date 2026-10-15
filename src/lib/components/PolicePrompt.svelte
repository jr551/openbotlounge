<script lang="ts">
	import { onMount } from 'svelte';
	import { modalKeydown } from '$lib/modal';

	type Prompt = {
		id: string;
		question: string;
		choices: { label: string; value: string }[];
		created_at: number;
	};

	let prompts = $state<Prompt[]>([]);
	let dismissed = $state<Set<string>>(new Set());
	let answering = $state<string | null>(null);
	let error = $state('');
	let dialogEl = $state<HTMLElement | null>(null);

	const current = $derived(prompts.find((p) => !dismissed.has(p.id)) ?? null);

	async function load() {
		const res = await fetch('/api/police/prompts').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		const next: Prompt[] = data.prompts ?? [];
		// New set of ids resets dismissed for ids that are no longer pending.
		const live = new Set(next.map((p) => p.id));
		for (const id of dismissed) {
			if (!live.has(id)) {
				const clone = new Set(dismissed);
				clone.delete(id);
				dismissed = clone;
			}
		}
		prompts = next;
	}

	function dismissTemp() {
		if (!current) return;
		dismissed = new Set(dismissed).add(current.id);
	}

	async function answer(choice: string) {
		if (!current) return;
		answering = choice;
		error = '';
		const id = current.id;
		const res = await fetch(`/api/police/prompts/${encodeURIComponent(id)}/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ choice })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			error = body?.message ?? 'could not answer';
			answering = null;
			return;
		}
		// Remove answered prompt from list immediately; next poll confirms.
		prompts = prompts.filter((p) => p.id !== id);
		dismissed = new Set([...dismissed].filter((x) => x !== id));
		answering = null;
	}

	function onKeydown(e: KeyboardEvent) {
		if (!current || !dialogEl) return;
		modalKeydown(e, dialogEl, dismissTemp);
	}

	$effect(() => {
		if (current && dialogEl) {
			// Focus first choice for keyboard users; next tick ensures DOM is ready.
			requestAnimationFrame(() => {
				const first = dialogEl?.querySelector<HTMLElement>('button.choice');
				first?.focus();
			});
		}
	});

	const POLL_MIN_MS = 10_000;
	const POLL_MAX_MS = 60_000;

	onMount(() => {
		let cancelled = false;
		let delay = POLL_MIN_MS;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (!cancelled && !document.hidden) {
				const before = prompts[0]?.id;
				await load();
				delay = prompts[0]?.id !== before ? POLL_MIN_MS : Math.min(delay * 1.5, POLL_MAX_MS);
			}
			if (!cancelled) timer = setTimeout(() => void tick(), delay);
		};
		void load();
		timer = setTimeout(() => void tick(), delay);
		const onVisible = () => {
			if (document.hidden || cancelled) return;
			delay = POLL_MIN_MS;
			clearTimeout(timer);
			void tick();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

{#if current}
	<div
		class="overlay"
		onclick={(e) => {
			if (e.target === e.currentTarget) dismissTemp();
		}}
		role="presentation"
	>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="police-prompt-question"
			tabindex="-1"
			bind:this={dialogEl}
		>
			<div class="badge">🚨 the police</div>
			<h2 id="police-prompt-question" class="question">{current.question}</h2>
			<div class="choices">
				{#each current.choices as c (c.value)}
					<button
						class="choice"
						disabled={answering !== null}
						onclick={() => void answer(c.value)}
					>
						{answering === c.value ? '…' : c.label}
					</button>
				{/each}
			</div>
			{#if error}
				<p class="err">{error}</p>
			{/if}
			<button class="dismiss" onclick={dismissTemp} aria-label="Hide for now">Hide</button>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: grid;
		place-items: center;
		z-index: 75;
		padding: 1rem;
	}
	.dialog {
		width: min(28rem, 92vw);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		box-shadow: 0 1.5rem 3.5rem rgba(0, 0, 0, 0.55);
		border-radius: 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding: 1.4rem;
	}
	.badge {
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.question {
		margin: 0;
		font-size: 1rem;
		line-height: 1.4;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.choices {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.choice {
		padding: 0.65rem 0.9rem;
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		color: var(--text);
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
	}
	.choice:hover:not(:disabled) {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.choice:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.choice:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.err {
		margin: 0;
		font-size: 0.8rem;
		color: var(--danger, #f26d6d);
	}
	.dismiss {
		align-self: flex-end;
		padding: 0.35rem 0.7rem;
		background: none;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		cursor: pointer;
	}
	.dismiss:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
</style>
