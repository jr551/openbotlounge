<script lang="ts">
	import { onMount } from 'svelte';

	/** The database's own state, as the settings endpoints report it. */
	type DatabaseState = {
		last_backup_at: number;
		last_backup_bytes: number;
		backup_error: string;
		recovered_at: number;
		recovered_from: string;
		recovery_seen: boolean;
	};

	let database = $state<DatabaseState | null>(null);
	let dismissing = $state(false);
	let failed = $state('');
	let dismissBtn = $state<HTMLButtonElement | null>(null);

	const shown = $derived(!!database?.recovered_at && !database.recovery_seen);

	onMount(async () => {
		const res = await fetch('/api/settings').catch(() => null);
		if (res?.ok) database = (await res.json()).database;
	});

	/**
	 * The server is told first, and the notice only comes down once it has
	 * answered: hiding it on a failed request would lose the news entirely the
	 * next time the page loads, which is the one outcome this notice exists to
	 * prevent.
	 */
	async function dismiss() {
		dismissing = true;
		failed = '';
		const res = await fetch('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ acknowledge_recovery: true })
		}).catch(() => null);
		const data = res?.ok ? await res.json().catch(() => null) : null;
		dismissing = false;
		if (!data?.database) {
			failed = 'The acknowledgement could not be saved. It will be asked again on the next load.';
			return;
		}
		database = data.database;
	}

	/** The button is the one thing to do here, so it takes focus on its own. */
	$effect(() => {
		if (shown) dismissBtn?.focus();
	});

	function when(at: number): string {
		return new Date(at).toLocaleString();
	}
</script>

<!-- `shown` already implies this; the second term is what narrows `database` for the compiler. -->
{#if shown && database}
	<div class="overlay" role="presentation">
		<div
			class="card"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="recovery-title"
			aria-describedby="recovery-body"
		>
			<div class="head">
				<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3L2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>
				<h2 id="recovery-title">The database was restored</h2>
			</div>

			<p id="recovery-body">
				OpenBotLounge's database failed its integrity check when the server started
				({when(database.recovered_at)}), so it was replaced with the nightly copy.
				<strong>Anything written since that copy was taken is gone.</strong>
			</p>

			<p class="where">
				The damaged file was kept at <code>{database.recovered_from}</code> — nothing was
				deleted, so it is still there if you want to look.
			</p>

			{#if failed}
				<p class="failed">{failed}</p>
			{/if}

			<div class="actions">
				<button bind:this={dismissBtn} class="ok" disabled={dismissing} onclick={dismiss}>
					{dismissing ? 'Dismissing…' : 'Dismiss'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* This is news of lost data, so it takes the screen: no click can land
	   behind it and read past it before the acknowledgement is recorded.
	   Escape is deliberately not a dismissal either - one stray key must not
	   be able to swallow the only telling of it. */
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.66);
		display: grid;
		place-items: center;
		z-index: 90;
	}
	.card {
		width: min(27rem, 92vw);
		max-height: 85dvh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
		padding: 1.3rem 1.4rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-top: 3px solid var(--danger);
		border-radius: 0.9rem;
		box-shadow: 0 1.5rem 3.5rem rgba(0, 0, 0, 0.6);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--danger);
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
		color: var(--text);
	}
	p {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--text-muted);
	}
	strong {
		color: var(--text);
		font-weight: 600;
	}
	.where code {
		display: inline-block;
		margin-top: 0.15rem;
		padding: 0.1rem 0.35rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.35rem;
		color: var(--text);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}
	.failed {
		color: var(--danger);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.ok {
		padding: 0.5rem 1.4rem;
		background: var(--accent);
		border: none;
		border-radius: 0.6rem;
		color: #fff;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.ok:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.ok:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
