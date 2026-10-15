<script lang="ts">
	import { modalKeydown } from '$lib/modal';

	type CatalogEntry = {
		id: string;
		name: string;
		description: string;
		icon_svg: string;
		installed: { plugin_id: string; enabled: boolean; configured: boolean } | null;
	};

	let { open = $bindable(false) }: { open: boolean } = $props();
	let catalog = $state<CatalogEntry[]>([]);
	let installing = $state('');
	let sheetEl = $state<HTMLElement | null>(null);

	async function load() {
		const res = await fetch('/api/connectors').catch(() => null);
		if (res?.ok) catalog = (await res.json()).catalog;
	}

	$effect(() => {
		if (open) {
			sheetEl?.focus();
			void load();
		}
	});

	async function install(id: string) {
		installing = id;
		await fetch('/api/connectors', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: id })
		}).catch(() => {});
		installing = '';
		await load();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (open) modalKeydown(e, sheetEl, () => (open = false));
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
			class="sheet"
			role="dialog"
			aria-modal="true"
			aria-labelledby="marketplace-title"
			tabindex="-1"
			bind:this={sheetEl}
		>
			<header>
				<div class="headtext">
					<h2 id="marketplace-title">Marketplace</h2>
					<p class="sub">Connectors you can install, then configure in Settings → Connectors.</p>
				</div>
				<button class="x" title="Close" aria-label="Close" onclick={() => (open = false)}>
					✕
				</button>
			</header>
			<div class="grid">
				{#each catalog as c (c.id)}
					<div class="card">
						<span class="icon" aria-hidden="true">{@html c.icon_svg}</span>
						<div class="info">
							<span class="name">{c.name}</span>
							<span class="blurb">{c.description}</span>
						</div>
						{#if c.installed}
							<span class="state" class:ready={c.installed.configured}>
								{c.installed.configured ? 'Installed' : 'Needs setup'}
							</span>
						{:else}
							<button
								class="add"
								disabled={installing === c.id}
								aria-label={`Install ${c.name}`}
								onclick={() => install(c.id)}
							>
								{#if installing === c.id}
									…
								{:else}
									<svg class="ic" viewBox="0 0 12 12" aria-hidden="true">
										<path
											d="M6 2v8M2 6h8"
											fill="none"
											stroke="currentColor"
											stroke-width="1.6"
											stroke-linecap="round"
										/>
									</svg>
									Install
								{/if}
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(2px);
		display: grid;
		place-items: center;
		z-index: 60;
	}
	.sheet {
		width: min(34rem, 94vw);
		max-height: min(85dvh, 40rem);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.9rem 1.2rem;
		border-bottom: 1px solid var(--border);
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.sub {
		margin: 0.15rem 0 0;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.x {
		flex: none;
		width: 2rem;
		height: 2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		border-radius: var(--r-sm);
		color: var(--text-muted);
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
	}
	.x:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.grid {
		overflow-y: auto;
		min-height: 0;
		padding: 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.55rem 0.75rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
	}
	.icon {
		flex: none;
		width: 2.2rem;
		height: 2.2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}
	.icon :global(svg) {
		width: 1.6rem;
		height: 1.6rem;
	}
	.info {
		flex: 1;
		min-width: 0;
	}
	.name {
		display: block;
		font-size: 0.92rem;
		color: var(--text);
	}
	.blurb {
		display: block;
		font-size: 0.8rem;
		line-height: 1.4;
		/* A step lighter than --text-muted for comfortable reading, same as Sidebar. */
		color: #a9a9b3;
	}
	.add {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.35rem 0.75rem;
		background: none;
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		color: var(--text);
		font-size: 0.8rem;
		line-height: 1.2;
		cursor: pointer;
		transition:
			background 0.12s,
			border-color 0.12s,
			color 0.12s;
	}
	.add:hover:not(:disabled) {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.add:disabled {
		color: var(--text-muted);
		cursor: default;
	}
	.add .ic {
		width: 0.7rem;
		height: 0.7rem;
	}
	.state {
		flex: none;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.state.ready {
		color: #6ea8fe;
	}

	.sheet:focus-visible,
	.x:focus-visible,
	.add:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
