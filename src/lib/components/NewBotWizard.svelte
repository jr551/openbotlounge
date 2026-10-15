<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import Avatar from './Avatar.svelte';

	let {
		open = $bindable(false),
		initialName = ''
	}: { open: boolean; initialName?: string } = $props();

	/**
	 * The names the wizard suggests and autocompletes from: short, one word,
	 * and none of them a name the app reserves (system, app, the police).
	 * The first suggestion is a random pick; typing filters the same list
	 * through the datalist.
	 */
	const BOT_NAMES = [
		'Cooper', 'Marlow', 'Pip', 'Juniper', 'Hollis', 'Bexley', 'Tarn', 'Wren',
		'Sable', 'Quill', 'Moss', 'Fable', 'Rook', 'Linden', 'Cinder', 'Pax',
		'Vesper', 'Onyx', 'Sorrel', 'Bramble', 'Echo', 'Fen', 'Gale', 'Hazel',
		'Iris', 'Jett', 'Kestrel', 'Lark', 'Maple', 'Nix', 'Oslo', 'Peregrine',
		'Quince', 'Reed', 'Slate', 'Tansy', 'Umber', 'Vale', 'Willow', 'Yarrow',
		'Zephyr', 'Ash', 'Birch', 'Cove', 'Dune', 'Elm', 'Flint', 'Grove',
		'Heath', 'Isle', 'Jasper'
	];

	/** The wizard's three steps: ask, wait on the police's draft, review it. */
	let step = $state<'ask' | 'drafting' | 'review'>('ask');
	let name = $state('');
	let purpose = $state('');
	let description = $state('');
	let persona = $state('');
	let draftError = $state('');
	let creating = $state(false);
	let nameEl = $state<HTMLInputElement | null>(null);
	let dialogEl = $state<HTMLElement | null>(null);

	$effect(() => {
		if (open) {
			step = 'ask';
			// The palette's search text wins; a bare "New bot" gets a suggestion.
			name = initialName || BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
			purpose = '';
			description = '';
			persona = '';
			draftError = '';
			creating = false;
		}
	});

	$effect(() => {
		if (open && step === 'ask') nameEl?.focus();
	});

	/** Ask the police to draft the persona; a failed draft still lets the human write it. */
	async function draft() {
		if (!purpose.trim() || step === 'drafting') return;
		step = 'drafting';
		draftError = '';
		const res = await fetch('/api/bots/draft', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ purpose: purpose.trim() })
		}).catch(() => null);
		if (res?.ok) {
			const data = await res.json().catch(() => null);
			description = data?.description ?? '';
			persona = data?.persona ?? '';
			if (!persona) draftError = 'The police wrote nothing back — write the persona yourself.';
		} else {
			draftError = 'The police could not be reached — write the persona yourself.';
		}
		step = 'review';
	}

	/** Accept creates the bot through the same path the full form uses. */
	async function accept() {
		if (!name.trim() || creating) return;
		creating = true;
		try {
			const created = await chat.createBot({
				name: name.trim(),
				persona,
				avatar: '',
				color: '',
				model: ''
			});
			if (created) {
				await chat.openDirect(created.id);
				open = false;
			}
		} finally {
			creating = false;
		}
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (open) modalKeydown(e, dialogEl, () => (open = false));
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<div
		class="overlay"
		onclick={(e) => {
			if (e.target === e.currentTarget) open = false;
		}}
		role="presentation"
	>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="wizard-title"
			tabindex="-1"
			bind:this={dialogEl}
		>
			<header>
				<h2 id="wizard-title">New bot</h2>
				<button
					type="button"
					class="x"
					title="Close"
					aria-label="Close"
					onclick={() => (open = false)}>✕</button>
			</header>

			<div class="body">
				<div class="identity">
					<Avatar color="#4f8ef7" seed={name} size={56} />
				</div>

				<label>
					Name
					<input
						list="wizard-names"
						bind:value={name}
						bind:this={nameEl}
						placeholder="e.g. Cooper"
						maxlength="60"
					/>
				</label>
				<datalist id="wizard-names">
					{#each BOT_NAMES as n (n)}
						<option value={n}></option>
					{/each}
				</datalist>

				{#if step === 'ask'}
					<label>
						What do you want it to do?
						<textarea
							rows="4"
							bind:value={purpose}
							placeholder="e.g. Watches the deploy channel and summarises failures"
						></textarea>
					</label>
					<div class="foot">
						<button class="go" disabled={!name.trim() || !purpose.trim()} onclick={draft}>
							Draft it
						</button>
					</div>
				{:else if step === 'drafting'}
					<p class="hint">The police is writing a persona…</p>
					<div class="wizbar"><span class="fill"></span></div>
				{:else}
					{#if description}
						<p class="desc">{description}</p>
					{/if}
					{#if draftError}
						<p class="hint warn">{draftError}</p>
					{/if}
					<label>
						Persona / instructions
						<textarea
							rows="8"
							bind:value={persona}
							placeholder="You are a helpful assistant who…"
						></textarea>
					</label>
					<div class="foot">
						<button class="makedef" onclick={() => (step = 'ask')}>Back</button>
						<button class="go" disabled={!name.trim() || creating} onclick={accept}>
							{creating ? 'Creating…' : 'Accept'}
						</button>
					</div>
					{#if creating}
						<div class="wizbar"><span class="fill"></span></div>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
	}
	.dialog {
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.8rem;
		width: min(30rem, 92vw);
		max-height: 85vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid var(--border);
	}
	h2 {
		margin: 0;
		font-size: 1rem;
	}
	.x {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.9rem;
	}
	.x:hover {
		color: var(--text);
	}
	.body {
		padding: 1rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.identity {
		display: flex;
		justify-content: center;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	input,
	textarea {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		color: var(--text);
		padding: 0.45rem 0.6rem;
		font: inherit;
		resize: vertical;
	}
	.hint {
		font-size: 0.82rem;
		color: var(--text-muted);
		margin: 0;
	}
	.hint.warn {
		color: #f0a0a0;
	}
	.desc {
		margin: 0;
		font-size: 0.9rem;
		font-style: italic;
		color: var(--text);
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.go {
		background: var(--accent);
		border: none;
		color: #fff;
		padding: 0.45rem 1.1rem;
		border-radius: 0.4rem;
		cursor: pointer;
		font: inherit;
	}
	.go:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.makedef {
		background: none;
		border: 1px solid var(--border);
		color: var(--text-muted);
		padding: 0.45rem 0.9rem;
		border-radius: 0.4rem;
		cursor: pointer;
		font: inherit;
	}
	.makedef:hover {
		color: var(--text);
	}
	/* The wizard's own progress: a bar that sweeps while the police drafts or
	   the create is in flight, so a slow provider does not read as a dead
	   dialog. */
	.wizbar {
		position: relative;
		width: 100%;
		height: 0.25rem;
		border-radius: 999px;
		background: var(--border);
		overflow: hidden;
	}
	.wizbar .fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: 40%;
		border-radius: 999px;
		background: linear-gradient(90deg, var(--accent), #7ee0a8);
		animation: slide 1.35s ease-in-out infinite;
	}
	@keyframes slide {
		0% {
			left: -40%;
		}
		100% {
			left: 100%;
		}
	}
</style>
