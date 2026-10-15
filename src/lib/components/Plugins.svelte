<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import { refusedByPolice, verdictLabel, verificationOf } from '$lib/plugin-verdict';
	import type { Plugin } from '$lib/types';

	let { open = $bindable(false) }: { open: boolean } = $props();

	/** One box in, a drafted plugin out - same shape as the routine form. */
	let text = $state('');
	let scope = $state<'bot' | 'shared'>('bot');
	let draft = $state<{
		name: string;
		description: string;
		kind: 'tool' | 'hook';
		hook_point: string;
		parameters: string;
		code: string;
		icon_svg: string;
	} | null>(null);
	let drafting = $state(false);
	let saving = $state(false);
	let formError = $state('');
	/** Which card's source editor is open, keyed 'all:<id>' or 'bot:<id>' so the
	    same plugin can be edited from either list without two editors fighting. */
	let editingKey = $state('');
	let editCode = $state('');
	let editSvg = $state('');
	let editError = $state('');
	let editSaving = $state(false);
	let sheetEl = $state<HTMLElement | null>(null);
	/** The card whose on-demand review is in flight, and why the last action on
	    a card failed; the officer's answer can take a while, so the chip says so
	    rather than looking ignored. */
	let reviewing = $state('');
	let actionError = $state('');
	let actionErrorId = $state('');

	const bot = $derived(chat.panelBot);
	/** The puzzle outline every plugin badge wears - the same path kindIcon draws. */
	const PUZZLE_PATH =
		'M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z';

	$effect(() => {
		if (open) {
			void chat.loadPlugins();
			if (bot) void chat.loadBotPlugins(bot.id);
		}
	});

	$effect(() => {
		if (open) sheetEl?.focus();
	});

	async function draftIt() {
		if (!text.trim() || drafting) return;
		drafting = true;
		formError = '';
		try {
			const res = await fetch('/api/plugins/parse', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: text.trim() })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Could not draft that (${res.status})`);
			}
			draft = (await res.json()).draft;
		} catch (e) {
			formError = e instanceof Error ? e.message : 'could not draft that';
			draft = null;
		} finally {
			drafting = false;
		}
	}

	async function accept() {
		if (saving || !draft) return;
		saving = true;
		formError = '';
		// `input` is a variable on purpose: createPlugin's signature predates
		// icon_svg, and a literal would trip the excess-property check.
		const input = {
			name: draft.name,
			description: draft.description,
			kind: draft.kind,
			hook_point: draft.kind === 'hook' ? draft.hook_point : undefined,
			parameters: draft.kind === 'tool' ? draft.parameters : undefined,
			code: draft.code,
			icon_svg: draft.icon_svg,
			author_bot_id: bot?.id,
			scope: scope === 'bot' && !bot ? 'shared' : scope
		};
		const ok = await chat.createPlugin(input);
		saving = false;
		if (ok) {
			text = '';
			draft = null;
			if (bot) void chat.loadBotPlugins(bot.id);
		} else {
			formError = 'Failed to create plugin';
		}
	}

	/** First emoji in the name or description, else the puzzle default - the
	    badge's fallback when a plugin has no icon_svg. */
	function pluginEmoji(p: { name: string; description: string }): string {
		return (p.name + ' ' + p.description).match(/\p{Extended_Pictographic}/u)?.[0] ?? '🧩';
	}

	function svgLooksSafe(svg: string): boolean {
		const s = svg
			.trim()
			.replace(/<!--[\s\S]*?-->/g, '')
			.trim();
		return (
			!!s &&
			svg.trim().length <= 8000 &&
			/^<svg[\s>]/i.test(s) &&
			/<\/svg>\s*$/i.test(s) &&
			/\bviewBox\s*=/i.test(s) &&
			!/<\?/.test(s) &&
			!/<!\s*(?:doctype|entity|\[cdata)/i.test(s) &&
			!/<\/?\s*(?:script|style|foreignobject|iframe|object|embed|image|audio|video|a)\b/i.test(s) &&
			!/(?:^|[\s"'/])on[a-z]+\s*=/i.test(s) &&
			!/javascript\s*:/i.test(s) &&
			!/url\s*\(\s*(?!['"]?\s*#)/i.test(s) &&
			!/(?:-webkit-)?image-set\s*\(/i.test(s) &&
			!/\b(?:href|src)\s*=\s*(?!['"]?\s*#)/i.test(s) &&
			!/@import|expression\s*\(/i.test(s)
		);
	}

	function toggleEditor(scopeKey: string, p: Plugin) {
		const key = `${scopeKey}:${p.id}`;
		if (editingKey === key) {
			editingKey = '';
			return;
		}
		editingKey = key;
		editCode = p.code;
		editSvg = p.icon_svg ?? '';
		editError = '';
	}

	async function saveEdit(id: string) {
		if (editSaving) return;
		editSaving = true;
		editError = '';
		const ok = await chat.updatePlugin(id, { code: editCode, icon_svg: editSvg.trim() });
		editSaving = false;
		if (ok) {
			editingKey = '';
			void chat.loadPlugins();
			if (bot) void chat.loadBotPlugins(bot.id);
		} else {
			editError = chat.error || 'Could not save plugin';
		}
	}

	/**
	 * One card action through the routes, with a refusal shown on the card. Both
	 * controls can be turned away - a switch the police's verdict holds down, a
	 * review that cannot be reached - and a control that snaps back with no
	 * reason reads as a broken button.
	 */
	async function actOnCard(id: string, run: () => Promise<boolean>, fallback: string) {
		if (await run()) {
			actionError = '';
			actionErrorId = '';
			return;
		}
		actionError = chat.error || fallback;
		actionErrorId = id;
	}

	/**
	 * Ask the police to look at a plugin the gate never saw. The card says what
	 * the officer decided as soon as the row comes back, so an unreviewed plugin
	 * has a way out of that state that is not the author's.
	 */
	async function reviewNow(id: string) {
		if (reviewing) return;
		reviewing = id;
		await actOnCard(id, () => chat.reviewPluginNow(id), 'Could not reach the police');
		reviewing = '';
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (!open) return;
		// Escape folds an open editor first; only the next press closes the dialog.
		if (e.key === 'Escape' && editingKey) {
			editingKey = '';
			(e as KeyboardEvent & { oblEscapeHandled?: boolean }).oblEscapeHandled = true;
			return;
		}
		modalKeydown(e, sheetEl, () => (open = false));
	}
</script>


<svelte:window onkeydown={onWindowKeydown} />

{#snippet kindIcon(kind: string)}
	{#if kind === 'hook'}
		<svg
			viewBox="0 0 24 24"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M12 8v6a4.5 4.5 0 0 1-9 0" />
			<circle cx="12" cy="5" r="2" />
		</svg>
	{:else}
		<svg
			viewBox="0 0 24 24"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path
				d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"
			/>
		</svg>
	{/if}
{/snippet}

{#snippet pluginBadge(p: { name: string; description: string; icon_svg?: string })}
	<span class="badge" aria-hidden="true">
		<svg
			class="puzzle"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d={PUZZLE_PATH} />
		</svg>
		<span class="badgeicon">
			{#if p.icon_svg && svgLooksSafe(p.icon_svg)}
				{@html p.icon_svg}
			{:else}
				{pluginEmoji(p)}
			{/if}
		</span>
	</span>
{/snippet}

{#snippet pluginEditor(p: Plugin, scopeKey: string)}
	{#if editingKey === `${scopeKey}:${p.id}`}
		<div class="editor">
			<label class="field">
				<span class="flabel">Code</span>
				<textarea
					class="code codeedit"
					bind:value={editCode}
					rows={Math.min(28, Math.max(6, editCode.split('\n').length + 1))}
					spellcheck="false"
				></textarea>
			</label>
			<label class="field">
				<span class="flabel">Icon SVG</span>
				<textarea
					class="code codeedit"
					bind:value={editSvg}
					rows={Math.min(14, Math.max(4, editSvg.split('\n').length + 1))}
					spellcheck="false"
					placeholder="<svg viewBox=&quot;0 0 24 24&quot;>…</svg> — empty shows the emoji"
				></textarea>
			</label>
			<div class="iconpreview">
				{@render pluginBadge({ name: p.name, description: p.description, icon_svg: editSvg })}
				{#if editSvg.trim() && !svgLooksSafe(editSvg)}
					<span class="err">won't save — needs one self-contained &lt;svg&gt; with a viewBox</span>
				{/if}
			</div>
			{#if editError}<p class="err">{editError}</p>{/if}
			<div class="editactions">
				<button class="ghost" onclick={() => (editingKey = '')}>Cancel</button>
				<button class="save" disabled={editSaving} onclick={() => saveEdit(p.id)}>
					{editSaving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet verdictChip(p: Plugin)}
	{@const v = verificationOf(p.verification)}
	{#if v && (v.verdict === 'approved' || v.verdict === 'rejected')}
		<span class="chip" class:refused={v.verdict === 'rejected'} title={v.reason}>
			{verdictLabel(v)}
		</span>
	{:else}
		<!-- The two states with no ruling on them - never reviewed, and a review
		     the officer was never reached for - want the same action, so both are
		     the button that asks again. The chip keeps its own label either way. -->
		<button
			class="chip review"
			class:unverified={v?.verdict === 'unreviewed'}
			disabled={reviewing === p.id}
			title={v
				? 'The police could not be reached - ask them again'
				: 'The police have not seen this plugin - send it for review now'}
			onclick={(e) => {
				e.stopPropagation();
				void reviewNow(p.id);
			}}
		>
			{reviewing === p.id ? 'reviewing…' : v ? verdictLabel(v) : 'not reviewed'}
		</button>
	{/if}
{/snippet}

{#snippet verdictNote(p: Plugin)}
	{@const v = verificationOf(p.verification)}
	{#if actionErrorId === p.id}
		<span class="verdict refused">{actionError}</span>
	{:else if reviewing === p.id}
		<!-- The officer is reading it now: a bar rather than a spinner, because
		     the review has real phases - the self-test runs first, then the
		     model's verdict - and the bar's own sweep says it is still going. -->
		<span class="verdict reviewing">
			<span class="reviewbar"><span class="fill"></span></span>
			<span>police are reading it…</span>
		</span>
	{:else if v}
		<span
			class="verdict"
			class:refused={v.verdict === 'rejected'}
			class:unverified={v.verdict === 'unreviewed'}
		>
			police: {verdictLabel(v)}{v.reason ? ` — ${v.reason}` : ''}{v.attempts ? ` (attempt ${v.attempts})` : ''}{v.by === 'human' ? ' · by you' : ''}
		</span>
	{/if}
{/snippet}

{#snippet approveAnyway(p: Plugin)}
	{@const v = verificationOf(p.verification)}
	{#if refusedByPolice(p.verification)}
		<button
			class="approve"
			title={v?.awaitingHuman
				? 'The bot used up its attempts - sign this off yourself'
				: 'The police refused this - sign it off yourself to overrule them'}
			onclick={(e) => {
				e.stopPropagation();
				void actOnCard(p.id, () => chat.approvePlugin(p.id, true), 'Could not rule on that plugin');
			}}
		>
			Approve anyway
		</button>
	{/if}
{/snippet}

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
			aria-labelledby="plugins-title"
			tabindex="-1"
			bind:this={sheetEl}
		>
			<header>
				<h2 id="plugins-title">Plugins</h2>
				<button class="x" aria-label="Close" onclick={() => (open = false)}>
					<svg
						viewBox="0 0 24 24"
						width="14"
						height="14"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						aria-hidden="true"
					>
						<path d="M18 6 6 18" />
						<path d="m6 6 12 12" />
					</svg>
				</button>
			</header>
			<div class="body">
				<section class="sect">
					<h3>Plugin library</h3>
					{#if chat.plugins.length === 0}
						<p class="empty">
							{@render kindIcon('extension')}
							<span>No plugins yet — describe a new ability below and the bot writes the code.</span>
						</p>
					{:else}
						{#each chat.plugins as p (p.id)}
							<div
								class="card"
								role="button"
								tabindex="0"
								title="Edit source"
								onclick={() => toggleEditor('all', p)}
								onkeydown={(e) => {
									if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
										e.preventDefault();
										toggleEditor('all', p);
									}
								}}
							>
								{@render pluginBadge(p)}
								<div class="info">
									<span class="name">
										{p.name}
										<span class="chip"
											>{p.kind}{p.kind === 'hook' && p.hook_point
												? ` · ${p.hook_point}`
												: ''}</span
										>
										<span class="chip">{p.scope === 'shared' ? 'shared' : 'bot'}</span>
										{@render verdictChip(p)}
									</span>
									{#if p.description}<span class="blurb">{p.description}</span>{/if}
									{@render verdictNote(p)}
								</div>
								<div class="rowactions">
									{@render approveAnyway(p)}
									<button
										class="switch"
										class:on={!!p.enabled}
										role="switch"
										aria-checked={!!p.enabled}
										aria-label={p.name}
										onclick={(e) => {
											e.stopPropagation();
											void actOnCard(p.id, () => chat.togglePlugin(p.id, !p.enabled), 'Could not change that plugin');
										}}
									>
										<span class="knob"></span>
									</button>
									<button
										class="del"
										title="Delete"
										aria-label={`Delete ${p.name}`}
										onclick={(e) => {
											e.stopPropagation();
											chat.deletePlugin(p.id);
										}}
									>
										<svg
											viewBox="0 0 24 24"
											width="14"
											height="14"
											fill="none"
											stroke="currentColor"
											stroke-width="1.8"
											stroke-linecap="round"
											stroke-linejoin="round"
											aria-hidden="true"
										>
											<path d="M3 6h18" />
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
											<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
											<line x1="10" x2="10" y1="11" y2="17" />
											<line x1="14" x2="14" y1="11" y2="17" />
										</svg>
									</button>
								</div>
							</div>
							{@render pluginEditor(p, 'all')}
						{/each}
					{/if}
				</section>

				{#if bot}
					<section class="sect">
						<h3>For {bot.name}</h3>
						{#if chat.botPlugins.length === 0}
							<p class="empty">
								{@render kindIcon('extension')}
								<span>Nothing for {bot.name} yet — draft one below and set the scope to “This bot only”.</span>
							</p>
						{:else}
							{#each chat.botPlugins as p (p.id)}
								<div
									class="card"
									role="button"
									tabindex="0"
									title="Edit source"
									onclick={() => toggleEditor('bot', p)}
									onkeydown={(e) => {
										if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
											e.preventDefault();
											toggleEditor('bot', p);
										}
									}}
								>
									{@render pluginBadge(p)}
									<div class="info">
										<span class="name">
											{p.name}
											<span class="chip">{p.kind}</span>
											{@render verdictChip(p)}
										</span>
										{#if p.description}<span class="blurb">{p.description}</span>{/if}
										{@render verdictNote(p)}
									</div>
									<div class="rowactions">
										{@render approveAnyway(p)}
										<button
											class="switch"
											class:on={!!p.effective_enabled}
											role="switch"
											aria-checked={!!p.effective_enabled}
											aria-label={`${p.name} for ${bot.name}`}
											onclick={(e) => {
												e.stopPropagation();
												void actOnCard(p.id, () => chat.toggleBotPlugin(bot.id, p.id, !p.effective_enabled), 'Could not change that plugin');
											}}
										>
											<span class="knob"></span>
										</button>
									</div>
								</div>
								{@render pluginEditor(p, 'bot')}
							{/each}
						{/if}
					</section>
				{/if}

				<section class="sect">
					<h3>New plugin</h3>
					<p class="hint">Describe it in your own words — the bot writes the code.</p>

					<textarea
						bind:value={text}
						placeholder="e.g. look up the weather for a city and format it nicely"
						onkeydown={(e) => {
							if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) draftIt();
						}}
					></textarea>
					<label class="field">
						<span class="flabel">Scope</span>
						<select bind:value={scope}>
							<option value="bot" disabled={!bot}>This bot only</option>
							<option value="shared">Shared with all bots</option>
						</select>
					</label>

					{#if formError}<p class="err">{formError}</p>{/if}

					{#if draft}
						<div class="preview">
							<div class="prow">
								<span class="lbl">Name</span>
								<span class="val">
									{@render pluginBadge(draft)}
									<code>{draft.name}</code>
								</span>
							</div>
							<div class="prow">
								<span class="lbl">Does</span>
								<span class="val">{draft.description || '—'}</span>
							</div>
							<div class="prow">
								<span class="lbl">Kind</span>
								<span class="val">
									{draft.kind}{draft.kind === 'hook' ? ` · ${draft.hook_point}` : ''}
								</span>
							</div>
							<div class="prow">
								<span class="lbl">Code</span>
								<pre class="code">{draft.code}</pre>
							</div>
						</div>
					{/if}

				</section>
			</div>

			<div class="actions">
				{#if draft}
					<button class="ghost" disabled={drafting} onclick={draftIt}>Regenerate</button>
					<button class="save" disabled={saving} onclick={accept}>
						{saving ? 'Saving…' : 'Accept'}
					</button>
				{:else}
					<button class="save" disabled={!text.trim() || drafting} onclick={draftIt}>
						{drafting ? 'Drafting…' : 'Draft plugin'}
					</button>
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
		display: grid;
		place-items: center;
		z-index: 60;
	}
	.sheet {
		width: min(38rem, 94vw);
		max-height: min(85dvh, 50rem);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		box-shadow: 0 1.5rem 3.5rem rgba(0, 0, 0, 0.55);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1.2rem;
		border-bottom: 1px solid var(--border);
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.x {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		/* The button's right edge sits on the dialog's content edge - the same
		   inset as the row actions and the footer's primary button. */
		margin-right: 0;
		background: none;
		border: none;
		border-radius: var(--r-sm);
		color: var(--text-muted);
		cursor: pointer;
	}
	.x:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.body {
		flex: 1 1 auto;
		overflow-y: auto;
		min-height: 0;
		padding: 0.9rem 1.2rem;
		display: flex;
		flex-direction: column;
		gap: 1.2rem;
	}
	.sect {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.sect + .sect {
		border-top: 1px solid var(--border);
		padding-top: 1.2rem;
	}
	h3 {
		margin: 0;
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.card {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.6rem 0.75rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		cursor: pointer;
	}
	.card:hover {
		background: var(--bg-hover);
	}
	/* The puzzle outline is the badge; the plugin's own svg (or an emoji when
	   it has none) sits centered inside it. */
	.badge {
		position: relative;
		display: grid;
		place-items: center;
		width: 1.9rem;
		height: 1.9rem;
		flex: none;
		color: var(--text-muted);
	}
	.card:hover .badge {
		color: var(--text);
	}
	.badge .puzzle {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.badgeicon {
		position: relative;
		display: grid;
		place-items: center;
		width: 0.95rem;
		height: 0.95rem;
		font-size: 0.72rem;
		line-height: 1;
	}
	.badgeicon :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}
	.info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.name {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--text);
	}
	.chip {
		font-size: 0.68rem;
		font-weight: 500;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		padding: 0.05rem 0.45rem;
	}
	/* The police's verdict, when it is not a clean sign-off: a refusal is red,
	   an unreviewed plugin is amber, so neither reads as verified. */
	.chip.refused {
		color: #ff8a8a;
		border-color: #7a2b2b;
	}
	.chip.unverified {
		color: #e0b060;
		border-color: #6b5220;
	}
	/* The chip that has no verdict to show: the same pill, made a button, so a
	   plugin the gate never saw is a state with an action on it rather than an
	   empty space where a verdict would be. */
	.chip.review {
		background: none;
		border-style: dashed;
		cursor: pointer;
	}
	.chip.review:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.chip.review:disabled {
		cursor: default;
	}
	.blurb {
		display: block;
		font-size: 0.78rem;
		color: #a6a6b0;
	}
	/* The police's word on the code, in the same ink the chip uses so the two
	   read as one verdict: red for a refusal, amber for a review that never
	   ran, muted for a pass. */
	.verdict {
		display: block;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.verdict.refused {
		color: #ff8a8a;
	}
	.verdict.unverified {
		color: #e0b060;
	}
	/* The review in flight: the same muted line, with a bar that sweeps while
	   the officer is out - the self-test runs first, then the model's verdict,
	   so the bar's motion says which of the two it is still on. */
	.verdict.reviewing {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-muted);
	}
	.reviewbar {
		position: relative;
		width: 4rem;
		height: 0.25rem;
		border-radius: 999px;
		background: var(--border);
		overflow: hidden;
		flex: none;
	}
	.reviewbar .fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: 40%;
		border-radius: 999px;
		background: linear-gradient(90deg, #7ee0a8, #b8f5d0);
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
	.switch {
		position: relative;
		width: 2.1rem;
		height: 1.2rem;
		flex: none;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		background: var(--bg-raised);
		cursor: pointer;
		transition: background 0.15s;
	}
	/* An invisible halo widens the hit area without changing the track's
	   size; the right side stops at the gap so it can't shadow the trash. */
	.switch::after {
		content: '';
		position: absolute;
		inset: -0.3rem -0.15rem -0.3rem -0.3rem;
	}
	.switch .knob {
		position: absolute;
		top: 0.1rem;
		left: 0.1rem;
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 50%;
		background: var(--text-muted);
		transition:
			left 0.15s,
			background 0.15s;
	}
	.switch.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.switch.on .knob {
		left: 1.1rem;
		background: #fff;
	}
	/* The switch and trash ride together in a group docked to the card's right
	   edge, so the last control lands on the dialog's content edge. */
	.rowactions {
		display: flex;
		align-items: center;
		align-self: stretch;
		gap: 0.15rem;
		flex: none;
		padding-left: 0.45rem;
		margin: -0.6rem calc(-0.75rem - 1px) -0.6rem 0;
		border-left: 1px solid var(--border);
	}
	/* The human's override on a refused plugin: a quiet text button that reads
	   as a decision, not another switch. */
	.approve {
		flex: none;
		padding: 0.15rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		background: none;
		color: var(--text-muted);
		font-size: 0.7rem;
		cursor: pointer;
	}
	.approve:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.del {
		display: grid;
		place-items: center;
		width: 1.9rem;
		height: 1.9rem;
		flex: none;
		background: none;
		border: none;
		border-radius: var(--r-sm);
		color: var(--text-muted);
		cursor: pointer;
	}
	.del:hover {
		background: var(--bg-raised);
		color: var(--danger);
	}
	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		margin: 0;
		padding: 0.9rem 1rem;
		border: 1px dashed #3d3d44;
		border-radius: var(--r-md);
		background: var(--bg);
		/* A step lighter than --text-muted so the helper reads as guidance,
		   not a disabled control - same tone as Sidebar's secondary text. */
		color: #a9a9b3;
		font-size: 0.8rem;
	}
	.empty svg {
		flex: none;
		color: var(--text-muted);
	}
	.hint {
		margin: 0;
		font-size: 0.75rem;
		color: #a6a6b0;
	}
	.field {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.35rem;
	}
	.flabel {
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-muted);
	}
	.field select {
		align-self: stretch;
	}
	.preview {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		padding: 0.7rem 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.prow {
		display: flex;
		gap: 0.7rem;
		font-size: 0.84rem;
	}
	.prow .lbl {
		width: 3.4rem;
		flex: none;
		color: var(--text-muted);
		font-size: 0.74rem;
		padding-top: 0.15rem;
	}
	.prow .val {
		min-width: 0;
		color: var(--text);
	}
	pre.code {
		margin: 0;
		max-height: 11rem;
		overflow: auto;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: var(--r-sm);
		padding: 0.5rem 0.6rem;
		font-size: 0.74rem;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
		flex: 1;
	}
	.ghost {
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--text);
		border-radius: var(--r-sm);
		padding: 0.5rem 1rem;
		font-size: 0.86rem;
		cursor: pointer;
	}
	.ghost:hover {
		background: var(--bg-hover);
	}
	textarea,
	select {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-sm);
		color: var(--text);
		font-family: inherit;
		font-size: 0.9rem;
		padding: 0.55rem 0.7rem;
	}
	textarea {
		height: 5.5rem;
		resize: vertical;
	}
	textarea::placeholder {
		color: var(--text-muted);
	}
	textarea:focus,
	select:focus {
		outline: none;
		border-color: var(--accent);
	}
	.code {
		font-family: ui-monospace, monospace;
		font-size: 0.82rem;
	}
	/* The inline source editor hangs off the card it belongs to. */
	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding: 0.7rem 0.8rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
	}
	.codeedit {
		width: 100%;
		height: auto;
		line-height: 1.45;
	}
	.iconpreview {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.editactions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.err {
		margin: 0;
		font-size: 0.8rem;
		color: var(--danger);
	}
	.actions {
		/* Static flex sibling after the scrolling body, so it can neither
		   overlap content nor scroll out of reach. */
		flex: none;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.9rem 1.2rem;
		border-top: 1px solid var(--border);
		background: var(--bg-raised);
	}
	.save {
		padding: 0.5rem 1.2rem;
		background: var(--accent);
		border: none;
		border-radius: var(--r-sm);
		color: #fff;
		font-size: 0.86rem;
		font-weight: 500;
		cursor: pointer;
	}
	.save:hover:not(:disabled) {
		background: #4a8ae0;
	}
	.save:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.sheet:focus-visible,
	.card:focus-visible,
	.x:focus-visible,
	.switch:focus-visible,
	.del:focus-visible,
	.ghost:focus-visible,
	.save:focus-visible,
	textarea:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
