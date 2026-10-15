<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let passwordInput: HTMLInputElement;
	let pending = $state(false);

	// Programmatic focus: the `autofocus` attribute trips a11y warnings and
	// can steal focus mid-hydration; focusing on mount behaves the same.
	$effect(() => {
		passwordInput?.focus();
	});
</script>

<div class="wrap">
	<form
		method="POST"
		class="card"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				pending = false;
				await update();
			};
		}}
	>
		<header>
			<h1>OpenBotLounge</h1>
			<p class="sub">This instance is protected by a shared password. Enter it to continue.</p>
		</header>

		<label for="password">Password</label>
		<input
			id="password"
			type="password"
			name="password"
			autocomplete="current-password"
			required
			bind:this={passwordInput}
			aria-invalid={!!form?.error}
			aria-describedby={form?.error ? 'login-error' : undefined}
		/>
		{#if form?.error}
			<p class="err" id="login-error" role="alert">{form.error}</p>
		{/if}

		<button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
	</form>
</div>

<style>
	.wrap {
		display: grid;
		place-items: center;
		min-height: 100dvh;
		padding: 1rem;
		background: var(--bg);
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		width: min(24rem, 100%);
		padding: 2rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
	}
	header {
		text-align: center;
		margin-bottom: 0.4rem;
	}
	h1 {
		margin: 0;
		font-size: 1.3rem;
		color: var(--text);
	}
	.sub {
		margin: 0.4rem 0 0;
		font-size: 0.85rem;
		line-height: 1.45;
		color: var(--text-muted);
	}
	label {
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	input {
		padding: 0.55rem 0.7rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-sm);
		color: var(--text);
		font-size: 0.95rem;
	}
	input:focus {
		outline: none;
		border-color: var(--accent);
	}
	button {
		padding: 0.6rem;
		background: var(--accent);
		border: none;
		border-radius: var(--r-sm);
		color: #fff;
		font-size: 0.95rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	input:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.err {
		margin: 0;
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>
