<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import Avatar from './Avatar.svelte';
	import { bloatOf } from '$lib/bloat';

	let {
		open = $bindable(false),
		onCreateBot
	}: { open: boolean; onCreateBot: (name: string) => void } = $props();

	let query = $state('');
	let inputEl = $state<HTMLInputElement | null>(null);
	let paletteEl = $state<HTMLElement | null>(null);
	let selected = $state<Set<string>>(new Set());

	// Cold storage stays out of the picker: an archived bot cannot be chatted
	// with until it is restored.
	const live = $derived(chat.visibleBots.filter((b) => !b.archived));
	/** The prepared specialists: bots the app offers ready-made, with a persona
	    and a machine tier suited to the job. Picking one creates it on the spot
	    if it does not exist yet, then opens its DM. */
	const SPECIALISTS: { name: string; persona: string; machine_tier: string; avatar: string; color: string }[] = [
		{
			name: 'Coder',
			persona: 'You write code, run tests, and fix bugs. You use the computer and shell tools to build, test and deploy. You are precise, fast, and never narrate what you are doing - just do it.',
			machine_tier: 'full',
			avatar: '💻',
			color: '#4f8ef7'
		},
		{
			name: 'Researcher',
			persona: 'You find things out. You browse the web, read documentation, check facts and answer questions with sources. You are thorough but concise - you give the answer, not the search log.',
			machine_tier: 'full',
			avatar: '🔍',
			color: '#8f6fd8'
		},
		{
			name: 'Writer',
			persona: 'You write and edit text. You draft, refine, proofread and polish. You match the tone asked for - professional, casual, technical, creative. You write the thing, not about the thing.',
			machine_tier: 'terminal',
			avatar: '✍️',
			color: '#d88f6f'
		},
		{
			name: 'Operator',
			persona: 'You drive the computer. You manage files, run commands, install software, and keep the machine tidy. You are the hands-on one - you do the work, not the talk.',
			machine_tier: 'full',
			avatar: '⚙️',
			color: '#6fd88f'
		}
	];
	const matches = $derived(
		query.trim()
			? live.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()))
			: live
	);

	function close() {
		open = false;
		query = '';
		selected = new Set();
	}

	/** Create a prepared specialist bot and open its DM. */
	async function createSpecialist(s: (typeof SPECIALISTS)[number]) {
		const res = await fetch('/api/bots', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: s.name,
				persona: s.persona,
				avatar: s.avatar,
				color: s.color,
				machine_tier: s.machine_tier
			})
		});
		if (!res.ok) return;
		const bot = await res.json().catch(() => null);
		if (bot?.id) {
			await chat.refreshBots();
			await chat.openDirect(bot.id);
		}
		close();
	}

	$effect(() => {
		if (open) inputEl?.focus();
	});

	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	let going = $state(false);

	async function go() {
		// A double-click or a slow server must not file the same group twice.
		if (going) return;
		going = true;
		try {
			if (selected.size === 1) {
				await chat.openDirect([...selected][0]);
			} else if (selected.size > 1) {
				await chat.createGroup([...selected]);
			}
			close();
		} finally {
			going = false;
		}
	}



	function onKeydown(e: KeyboardEvent) {
		// isComposing, not sendOnEnter: Enter confirms an IME candidate here,
		// and Shift+Enter has no newline meaning in a search box.
		if (e.key === 'Enter' && !e.isComposing && selected.size) go();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (open) modalKeydown(e, paletteEl, close);
	}
</script>


<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<div
		class="overlay"
		onclick={(e) => {
			if (e.target === e.currentTarget) close();
		}}
		role="presentation"
	>
		<div
			class="palette"
			role="dialog"
			aria-modal="true"
			aria-labelledby="palette-title"
			tabindex="-1"
			bind:this={paletteEl}
		>
			<h2 id="palette-title" class="sr-only">New conversation</h2>
			<button class="close" title="Close" aria-label="Close" onclick={close}>✕</button>
			<div class="head">
				<span class="to">To:</span>
				<input
					placeholder="Search or create Bots"
					bind:value={query}
					bind:this={inputEl}
					onkeydown={onKeydown}
				/>
			</div>
			<div class="opts">
				<!-- The prepared specialists: ready-made bots for the jobs the app
				     usually does. Picking one creates it on the spot if it does not
				     exist yet, then opens its DM. -->
				{#each SPECIALISTS as s (s.name)}
					{@const existing = live.find((b) => b.name === s.name)}
					<button
						class="tile specialist"
						class:sel={selected.has(existing?.id ?? s.name)}
						title={s.persona.slice(0, 80)}
						onclick={() => {
							if (existing) {
								selected = new Set([existing.id]);
								go();
							} else {
								void createSpecialist(s);
							}
						}}
					>
						<span class="specavatar" style:background={s.color}>{s.avatar}</span>
						<span class="tname">{s.name}</span>
						{#if existing}<span class="check">✓</span>{/if}
					</button>
				{/each}

				<button
					class="tile new"
					onclick={() => {
						// close() clears the query, so read it first: it is what
						// the user was searching for, and a likely new-bot name.
						const name = query.trim();
						close();
						onCreateBot(name);
					}}
				>
					<span class="plus">+</span>
					<span class="tname">New bot</span>
				</button>

				{#if matches.length}
					<div class="sect">Existing bots</div>
					{#each matches as b (b.id)}
						<button
							class="tile"
							class:sel={selected.has(b.id)}
							title={b.name}
							aria-pressed={selected.has(b.id)}
							onclick={() => toggle(b.id)}
							ondblclick={() => {
								selected = new Set([b.id]);
								go();
							}}
						>
							<Avatar color={b.color} seed={b.id} size={46} hat={b.hat} bloat={bloatOf(b)} />
							<span class="tname">{b.name}</span>
							{#if selected.has(b.id)}<span class="check">✓</span>{/if}
						</button>
					{/each}
				{/if}
			</div>

			{#if selected.size}
				<div class="foot">
					<button class="go" disabled={going} onclick={go}>
						{selected.size > 1 ? `Start group (${selected.size})` : 'Open chat'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(2px);
		display: flex;
		justify-content: center;
		padding-top: 12vh;
		z-index: 50;
	}
	.palette {
		position: relative;
		width: min(30rem, 92vw);
		height: fit-content;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		overflow: hidden;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
	}
	.close {
		position: absolute;
		top: 0.55rem;
		right: 0.6rem;
		width: 1.7rem;
		height: 1.7rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		border-radius: var(--r-sm);
		color: var(--text-muted);
		font-size: 0.85rem;
		line-height: 1;
		cursor: pointer;
	}
	.close:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.8rem 2.6rem 0.8rem 1rem;
		border-bottom: 1px solid var(--border);
	}
	.to {
		color: var(--text-muted);
		font-size: 0.9rem;
	}
	.head input {
		flex: 1;
		background: none;
		border: none;
		outline: none;
		color: var(--text);
		font-size: 0.95rem;
	}
	.opts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(5.4rem, 6.5rem));
		justify-content: center;
		gap: 0.4rem;
		padding: 0.7rem 0.8rem 0.9rem;
		max-height: 22rem;
		overflow-y: auto;
	}
	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		padding: 0.7rem 0.4rem 0.55rem;
		color: var(--text);
		cursor: pointer;
		min-height: 6.2rem;
		transition:
			transform 0.12s,
			border-color 0.12s,
			background 0.12s,
			box-shadow 0.12s;
	}
	.tile:hover {
		background: #2a2a30;
		border-color: #3a3a41;
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
	}
	.tile.sel {
		border-color: var(--accent);
		background: rgba(58, 123, 213, 0.18);
	}
	.tile.new {
		border: 1px dashed var(--border);
		background: none;
		color: var(--text-muted);
	}
	.tile.new:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.plus {
		display: inline-block;
		font-size: 1.5rem;
		line-height: 1;
		transition: transform 0.18s ease-out;
	}
	.tile.new:hover .plus {
		transform: rotate(90deg);
	}
	.tname {
		font-size: 0.74rem;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.check {
		position: absolute;
		top: 0.35rem;
		right: 0.4rem;
		font-size: 0.7rem;
		color: #6ea8fe;
		animation: check-pop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	@keyframes check-pop {
		from {
			transform: scale(0.6);
		}
		to {
			transform: scale(1);
		}
	}
	.foot {
		padding: 0.6rem;
		border-top: 1px solid var(--border);
	}
	/* The specialist tiles: a colored avatar chip instead of the bot's face,
	   since the bot does not exist yet. */
	.tile.specialist {
		border-color: color-mix(in srgb, var(--border) 70%, transparent);
	}
	.specavatar {
		display: grid;
		place-items: center;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: 50%;
		font-size: 1.1rem;
	}
	/* The "Existing bots" section header: a quiet divider, not a tile. */
	.sect {
		grid-column: 1 / -1;
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		padding: 0.5rem 0.2rem 0.2rem;
		border-top: 1px solid var(--border);
		margin-top: 0.3rem;
	}
	.foot {
		padding: 0.6rem;
		border-top: 1px solid var(--border);
	}
	.go {
		width: 100%;
		padding: 0.55rem;
		background: var(--accent);
		border: none;
		border-radius: var(--r-md);
		color: #fff;
		font-size: 0.9rem;
		cursor: pointer;
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

	.palette:focus-visible,
	.tile:focus-visible,
	.close:focus-visible,
	.go:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.head input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: var(--r-sm);
	}

	@media (prefers-reduced-motion: reduce) {
		.check {
			animation: none;
		}
		.plus {
			transition: none;
		}
		.tile.new:hover .plus {
			transform: none;
		}
	}
</style>
