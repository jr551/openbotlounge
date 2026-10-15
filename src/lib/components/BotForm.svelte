<script lang="ts">
	import { onMount } from 'svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import Avatar from './Avatar.svelte';
	import CompanyCard from './CompanyCard.svelte';
	import type { Bot } from '$lib/types';

	let {
		open = $bindable(false),
		bot = null,
		initialName = ''
	}: { open: boolean; bot?: Bot | null; initialName?: string } = $props();

	const COLORS = ['#4f8ef7', '#e5489b', '#e04a4a', '#e08a3c', '#2fae8f', '#8a6ff0', '#6b7280', '#a06b3f'];

	let name = $state('');
	let persona = $state('');
	let color = $state('#4f8ef7');
	let model = $state('');
	let machineTier = $state('full');
	let nixEnabled = $state(false);
	let desktopRecipe = $state('');
	let browserRecipe = $state('');
	let recipes = $state<{
		desktops: { id: string; label: string }[];
		browsers: { id: string; label: string }[];
	}>({ desktops: [], browsers: [] });
	let nameEl = $state<HTMLInputElement | null>(null);
	let dialogEl = $state<HTMLElement | null>(null);
	/** Cold storage state, tracked locally so the toggle flips without a reopen. */
	let archived = $state(false);
	/** The kill prompt: closed, asking, or busy deleting. */
	let killing = $state<'idle' | 'ask' | 'busy'>('idle');
	let killReason = $state('');
	/** Set for a moment after the public key is copied, so the button says so. */
	let keyCopied = $state(false);
	/**
	 * The bot's company profile, shown at the top of its main profile. Read
	 * only here - editing it stays in the bot's card - so this is a fetch and
	 * a render, nothing more.
	 */
	let companyProfile = $state('');
	/** 'idle' before a bot is known, then the same states the card uses. */
	let companyState = $state<'idle' | 'loading' | 'ready' | 'none' | 'error'>('idle');
	/**
	 * The bot whose page is shown, as a scalar: the `bot` prop is an object the
	 * parent may hand back fresh, and an effect reading it would refetch on
	 * every store tick.
	 */
	const companyBotId = $derived(open && bot ? bot.id : '');

	// A saved bot may carry a colour outside the palette; surface it as an
	// extra swatch so exactly one swatch is always selected.
	const palette = $derived(color && !COLORS.includes(color) ? [...COLORS, color] : COLORS);
	onMount(async () => {
		const r = await fetch('/api/recipes').catch(() => null);
		if (r?.ok) recipes = await r.json();
	});

	$effect(() => {
		if (open) {
			name = bot?.name ?? initialName;
			persona = bot?.persona ?? '';
			color = bot?.color ?? '#4f8ef7';
			model = bot?.model ?? chat.defaultModel;
			desktopRecipe = bot?.desktop_recipe ?? '';
			browserRecipe = bot?.browser_recipe ?? '';
			// '' reads as 'full' - every bot made before the column was.
			machineTier = bot?.machine_tier || 'full';
			nixEnabled = !!bot?.nix_enabled;
			archived = !!bot?.archived;
			reverting = '';
			killing = 'idle';
			killReason = '';
			keyCopied = false;
		}
	});

	$effect(() => {
		if (open) nameEl?.focus();
	});

	// The company profile is read when the form opens on an existing bot. A new
	// bot has no page yet, so nothing is fetched for one. A failed read is not
	// an empty page, so it is said as such rather than as "no profile yet".
	$effect(() => {
		const id = companyBotId;
		if (!id) {
			companyProfile = '';
			companyState = 'idle';
			return;
		}
		let cancelled = false;
		companyState = 'loading';
		void fetch(`/api/bots/${id}/profile`)
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status}`);
				return r.json();
			})
			.then((data) => {
				if (cancelled) return;
				companyProfile = data?.content ?? '';
				companyState = companyProfile.trim() ? 'ready' : 'none';
			})
			.catch(() => {
				if (!cancelled) companyState = 'error';
			});
		return () => {
			cancelled = true;
		};
	});

	let saving = $state(false);

	async function save() {
		// A double-click or a slow server must not file the same bot twice.
		if (!name.trim() || saving) return;
		saving = true;
		try {
			const fields = {
				name,
				persona,
				color,
				model,
				machine_tier: machineTier,
				desktop_recipe: desktopRecipe,
				browser_recipe: browserRecipe,
			// Nix is an edit-only switch: a bot being created has no machine
			// yet, so the flag is only sent on the update path.
			...(bot ? { nix_enabled: nixEnabled } : {})
			};
			let ok = false;
			if (bot) {
				ok = await chat.updateBot(bot.id, fields);
			} else {
				const created = await chat.createBot({ ...fields, avatar: '' });
				if (created) {
					ok = true;
					await chat.openDirect(created.id);
				}
			}
			// A refused save (a taken name) keeps the form open with the reason
			// showing, instead of closing as if it worked.
			if (ok) open = false;
		} finally {
			saving = false;
		}
	}

	/** Cold storage: the bot stays, but leaves the palette and stops running. */
	let archiving = $state(false);
	async function toggleArchive() {
		if (!bot || archiving) return;
		archiving = true;
		const ok = await chat.updateBot(bot.id, { archived: !archived });
		if (ok) archived = !archived;
		archiving = false;
	}

	/**
	 * The look the bot is wearing, read off the store's row rather than the
	 * `bot` prop: a revert lands on the store at once, and the prop is the
	 * stale copy the parent opened the form with.
	 */
	const look = $derived(bot ? (chat.botById(bot.id) ?? bot) : null);
	/** Which revert is in flight, so a second click cannot double it. */
	let reverting = $state('');

	/** Take back a look the human approved: the chat's CSS, or the bot's face. */
	async function revert(what: 'css' | 'avatar') {
		if (!bot || reverting) return;
		reverting = what;
		try {
			await chat.revertLook(bot.id, what);
		} finally {
			reverting = '';
		}
	}

	/** The whole line, comment included, is what a git host wants pasted. */
	async function copySshKey() {
		if (!bot?.ssh_public_key) return;
		try {
			await navigator.clipboard.writeText(bot.ssh_public_key);
			keyCopied = true;
			setTimeout(() => (keyCopied = false), 1500);
		} catch {
			// No clipboard (insecure context, denied): the key is still on
			// screen to select by hand.
			chat.error = 'could not copy the key';
		}
	}

	/** Kill is delete with a reason, which the Lounge hears about. */
	async function kill() {
		if (!bot || killing === 'busy') return;
		killing = 'busy';
		const res = await fetch(`/api/bots/${bot.id}`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason: killReason.trim() })
		}).catch(() => null);
		if (res?.ok) {
			await chat.refreshBots();
			open = false;
		} else {
			killing = 'ask';
			chat.error = 'could not kill that bot';
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
			aria-labelledby="bot-form-title"
			tabindex="-1"
			bind:this={dialogEl}
		>
			<header>
				<h2 id="bot-form-title">{bot ? 'Edit Bot' : 'Create new Bot'}</h2>
				<button
					type="button"
					class="x"
					title="Close"
					aria-label="Close"
					onclick={() => (open = false)}>✕</button>
			</header>

			<div class="body">
				{#if bot}
					<!-- The company profile leads the bot's main profile: it is the
					     page the human keeps on the bot, and it used to be reachable
					     only from a badge over the bot's screen. -->
					<section class="sect">
						<h3>Company profile</h3>
						{#if companyState === 'loading'}
							<p class="hint">Reading the file…</p>
						{:else if companyState === 'error'}
							<p class="hint">Couldn't read the company profile — the server isn't answering.</p>
						{:else if companyState === 'none'}
							<p class="hint">No company profile yet.</p>
						{:else if companyState === 'ready'}
							<CompanyCard {bot} profile={companyProfile} />
						{/if}
					</section>
				{/if}
				<div class="identity">
					<Avatar {color} seed={name} size={56} />
					<div class="swatches" role="group" aria-label="Avatar colour">
						{#each palette as c}
							<button
								type="button"
								class="swatch"
								class:sel={c === color}
								style:background={c}
								aria-label={`Select color ${c}`}
								aria-pressed={c === color}
								onclick={() => (color = c)}
							></button>
						{/each}
					</div>
				</div>

				<label>
					Name
					<input bind:value={name} bind:this={nameEl} placeholder="e.g. Cooper" maxlength="60" />
				</label>

				<label>
					Persona / instructions
					<textarea
						rows="8"
						bind:value={persona}
						placeholder="You are a helpful assistant who…"
					></textarea>
				</label>

				<section class="sect">
					<h3>Model</h3>
					<label>
						Model
						<select bind:value={model}>
							<option value="">Provider default</option>
							{#each chat.models as m}
								<option value={m}>{m}</option>
							{/each}
							{#if model && !chat.models.includes(model)}
								<option value={model}>{model}</option>
							{/if}
						</select>
					</label>
					<p class="hint">Leave it on the provider default unless this bot needs a different model.</p>
				</section>

				<section class="sect">
					<h3>Machine</h3>
					<label>
						Tier
						<select bind:value={machineTier}>
							<option value="full">Full desktop</option>
							<option value="terminal">Terminal only</option>
							<option value="none">No machine</option>
						</select>
					</label>
					{#if machineTier === 'none'}
						<p class="hint">Chat only - no machine is ever built for this bot.</p>
					{:else if machineTier === 'terminal'}
						<p class="hint">A machine without a screen: shell and files, no desktop or browser.</p>
					{:else}
						<p class="hint">
							The desktop and browser the bot's machine builds when it first needs a
							screen. The bot can change these itself later with its setup_desktop tool.
						</p>
						<label>
							Desktop
							<select bind:value={desktopRecipe}>
								<option value="">Openbox (default)</option>
								{#each recipes.desktops as r}
									<option value={r.id}>{r.label}</option>
								{/each}
							</select>
						</label>
						<label>
							Browser
							<select bind:value={browserRecipe}>
								<option value="">Chromium (default)</option>
								{#each recipes.browsers as r}
									<option value={r.id}>{r.label}</option>
								{/each}
							</select>
						</label>
					{/if}
					{#if bot && machineTier !== 'none'}
						<label class="nixrow">
							<input type="checkbox" bind:checked={nixEnabled} />
							<span>Nix package manager</span>
						</label>
						<p class="hint">
							Gives {bot.name} the nix tool. The store lives on a volume, so what it
							installs survives a rebuild; first use installs Nix itself.
						</p>
					{/if}
				</section>

				{#if bot?.ssh_public_key}
					<section class="sect">
						<h3>Git access</h3>
						<p class="hint">
							Paste this into GitHub or Forgejo as a deploy key and {bot.name} can clone
							and push over SSH from its machine. Only the public half is ever shown -
							the private key stays encrypted on the server and inside the bot's
							machine.
						</p>
						<div class="sshrow">
							<code class="sshkey">{bot.ssh_public_key}</code>
							<button type="button" class="coldbtn" onclick={copySshKey}>
								{keyCopied ? 'Copied' : 'Copy'}
							</button>
						</div>
					</section>
				{/if}

				{#if look && (look.custom_css || look.avatar)}
					<section class="sect">
						<h3>Look</h3>
						<p class="hint">
							Things {look?.name ?? 'the bot'} made for itself that you approved. Reverting takes
							them back; it can always propose them again.
						</p>
						<div class="coldrow">
							{#if look.custom_css}
								<button
									type="button"
									class="coldbtn"
									disabled={!!reverting}
									onclick={() => revert('css')}
								>
									{reverting === 'css' ? 'Reverting…' : 'Revert chat CSS'}
								</button>
							{/if}
							{#if look.avatar}
								<button
									type="button"
									class="coldbtn"
									disabled={!!reverting}
									onclick={() => revert('avatar')}
								>
									{reverting === 'avatar' ? 'Reverting…' : 'Revert avatar'}
								</button>
							{/if}
						</div>
					</section>
				{/if}

				{#if bot}
					<section class="sect">
						<h3>Cold storage</h3>
						<p class="hint">
							An archived bot keeps its chats and files but leaves the palette and
							stops running. Kill deletes it for good - the Lounge hears why.
						</p>
						<div class="coldrow">
							<button type="button" class="coldbtn" onclick={toggleArchive}>
								{archived ? 'Restore' : 'Archive'}
							</button>
							{#if killing === 'idle'}
								<button type="button" class="coldbtn danger" onclick={() => (killing = 'ask')}>
									Kill
								</button>
							{/if}
						</div>
						{#if killing !== 'idle'}
							<div class="killbox">
								<label>
									Why are you killing {bot.name}?
									<input
										bind:value={killReason}
										placeholder="said to the Lounge"
										maxlength="300"
									/>
								</label>
								<div class="coldrow">
									<button
										type="button"
										class="coldbtn danger"
										disabled={killing === 'busy'}
										onclick={kill}
									>
										{killing === 'busy' ? 'Killing…' : 'Kill it'}
									</button>
									<button
										type="button"
										class="coldbtn"
										disabled={killing === 'busy'}
										onclick={() => (killing = 'idle')}
									>
										Keep it
									</button>
								</div>
							</div>
						{/if}
					</section>
				{/if}
			</div>

			<div class="footer">
				{#if chat.error}
					<span class="formerr">{chat.error}</span>
				{/if}
				<button type="button" class="cancel" onclick={() => (open = false)}>Cancel</button>
				<button type="button" class="save" disabled={!name.trim() || saving} onclick={save}>
					{saving ? (bot ? 'Saving…' : 'Creating…') : bot ? 'Save' : 'Create Bot'}
				</button>
			</div>
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
		z-index: 60;
	}
	.dialog {
		width: min(26rem, 92vw);
		/* Content can outgrow the viewport; the body scrolls instead, so the
		   footer stays reachable without covering anything. */
		max-height: 85dvh;
		overflow: hidden;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		box-shadow: 0 1.5rem 3.5rem rgba(0, 0, 0, 0.55);
		border-radius: 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex: none;
		padding: 1.4rem 1.4rem 0;
	}
	/* Everything between the header and the footer scrolls here, so the
	   footer is a static sibling that cannot cover content or scroll away. */
	.body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding: 0 1.4rem 0.9rem;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	.x {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		background: none;
		border: none;
		border-radius: 0.5rem;
		color: var(--text-muted);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
	}
	.x:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.identity {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		margin-top: -0.35rem;
	}
	.swatches {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.45rem;
	}
	.swatch {
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		border: none;
		border-radius: 50%;
		cursor: pointer;
	}
	.swatch:hover {
		box-shadow:
			0 0 0 2px var(--bg-raised),
			0 0 0 4px var(--text-muted);
	}
	.swatch.sel {
		box-shadow:
			0 0 0 2px var(--bg-raised),
			0 0 0 4px var(--text);
	}
	.coldrow {
		display: flex;
		gap: 0.5rem;
	}
	.coldbtn {
		padding: 0.35rem 0.9rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.coldbtn:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.coldbtn.danger {
		border-color: var(--danger, #e06c75);
		color: var(--danger, #e06c75);
	}
	.coldbtn.danger:hover:not(:disabled) {
		background: rgba(224, 108, 117, 0.12);
	}
	.coldbtn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.killbox {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding: 0.6rem 0.7rem;
		border: 1px solid var(--danger, #e06c75);
		border-radius: 0.6rem;
		background: rgba(224, 108, 117, 0.06);
	}
	.sshrow {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	/* The key is one long line; it wraps rather than running off the dialog. */
	.sshkey {
		flex: 1 1 auto;
		min-width: 0;
		padding: 0.5rem 0.6rem;
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
		line-height: 1.35;
		word-break: break-all;
	}
	.sshrow .coldbtn {
		flex: none;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	input,
	textarea,
	select {
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		font-family: inherit;
		font-size: 0.9rem;
		padding: 0.55rem 0.7rem;
	}
	textarea {
		resize: vertical;
		min-height: 7rem;
	}
	input:focus,
	textarea:focus,
	select:focus {
		outline: none;
		border-color: var(--accent);
	}
	.sect {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	h3 {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	/* The Nix switch sits beside its label, not stacked like the text fields. */
	.nixrow {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
		color: var(--text);
	}
	.nixrow input {
		width: auto;
		margin: 0;
	}
	.hint {
		margin: -0.15rem 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		/* Static action bar after the scrollport; its own bottom padding
		   replaces the dialog's, so it never crosses the border. */
		flex: none;
		padding: 0.9rem 1.4rem 1.4rem;
		border-top: 1px solid var(--border);
		background: var(--bg-raised);
	}
	.formerr {
		margin-right: auto;
		font-size: 0.8rem;
		color: var(--danger, #e06c75);
	}
	.cancel {
		padding: 0.5rem 1rem;
		background: none;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		cursor: pointer;
	}
	.cancel:hover {
		background: var(--bg-hover);
	}
	.save {
		padding: 0.5rem 1.2rem;
		background: var(--accent);
		border: none;
		border-radius: 0.5rem;
		color: #fff;
		cursor: pointer;
	}
	.save:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.dialog:focus-visible,
	.x:focus-visible,
	.swatch:focus-visible,
	.cancel:focus-visible,
	.save:focus-visible,
	input:focus-visible,
	textarea:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
