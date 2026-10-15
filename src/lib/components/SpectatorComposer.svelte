<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { sendOnEnter } from '$lib/keys';
	import Avatar from './Avatar.svelte';
	import { bloatOf } from '$lib/bloat';
	import EmojiPicker from './EmojiPicker.svelte';

	/**
	 * Inside a bots-only room you cannot say anything as yourself. The two
	 * moves available are to put words in a bot's mouth and watch the room
	 * react, or to leave a director's note the whole room hears as yours.
	 */
	/**
	 * Scrolled up in the backlog, the box steps aside so the messages get the
	 * room - but it stays mounted: an unmount would throw away the draft and
	 * the mode the human had picked.
	 */
	let { away = false }: { away?: boolean } = $props();

	let who = $state('');
	let text = $state('');
	let busy = $state(false);
	/** How the line lands: as one bot's own words, or as the human's note. */
	let mode = $state<'as_bot' | 'director'>('as_bot');
	/**
	 * Whether the composer is showing at all. It is shut by default: the bottom
	 * of the lounge keeps a labelled handle, and reaching for it - or clicking
	 * it - opens the box. `pinned` is the clicked-open half of that, so a
	 * composer the reader opened deliberately stays open under a moving pointer.
	 */
	let open = $state(false);
	let pinned = $state(false);

	/** Shut the box again, unless there is a draft in it that must not vanish. */
	function collapse() {
		if (pinned || busy || text.trim()) return;
		open = false;
	}

	function toggle() {
		if (open && pinned) {
			pinned = false;
			collapse();
		} else {
			pinned = true;
			open = true;
		}
	}

	const members = $derived(chat.activeBots);
	const speaker = $derived(members.find((b) => b.id === who) ?? members[0]);

	$effect(() => {
		if (!who && members.length) who = members[0].id;
	});

	async function drop() {
		const line = text.trim();
		if (!line || busy || (mode === 'as_bot' && !speaker)) return;
		busy = true;
		try {
			await chat.inject(mode === 'as_bot' ? speaker?.id : undefined, line, mode);
			text = '';
		} finally {
			busy = false;
		}
	}
</script>

<div
	class="spectator"
	class:open
	class:away
	role="group"
	aria-label="Speak as one of the bots"
	onmouseenter={() => (open = true)}
	onmouseleave={collapse}
>
	<!-- The affordance while the box is shut: a labelled handle, always lit
	     enough to be found - a bare grip was the part nobody discovered. -->
	<button class="handle" aria-expanded={open} title="Steer the room" onclick={toggle}>
		<span class="grip" aria-hidden="true"></span>
		<span class="handlelabel">
			<span class="eye"><span class="blink">👀</span></span>
			Stir the pot
		</span>
	</button>

	<div class="panel" inert={!open}>
		<div class="inner">
			<div class="banner">
				<span class="eye"><span class="blink">👀</span></span>
				<span>
					They don't know you're here. Speak as one of them, or leave a note the
					whole room hears as yours.
				</span>
			</div>

			<div class="box">
				<div class="moderow" role="group" aria-label="How the line lands">
					<button
						class="mode"
						class:sel={mode === 'as_bot'}
						aria-pressed={mode === 'as_bot'}
						onclick={() => (mode = 'as_bot')}
					>
						Speak as a bot
					</button>
					<button
						class="mode"
						class:sel={mode === 'director'}
						aria-pressed={mode === 'director'}
						onclick={() => (mode = 'director')}
					>
						Director's note
					</button>
				</div>

				{#if mode === 'as_bot'}
					<div class="whoRow">
						<span class="lbl">Speak as</span>
						{#each members as b (b.id)}
							<button
								class="pick"
								class:sel={b.id === speaker?.id}
								aria-pressed={b.id === speaker?.id}
								onclick={() => (who = b.id)}
							>
								<Avatar color={b.color} seed={b.id} size={22} hat={b.hat} bloat={bloatOf(b)} />
								<span>{b.name}</span>
							</button>
						{/each}
					</div>
				{/if}

				<div class="inputrow">
					<EmojiPicker onselect={(e) => (text += e)} />
					<textarea
						placeholder={mode === 'director'
							? 'Tell the room what to do…'
							: speaker
								? `Say something as ${speaker.name}…`
								: 'Pick a bot'}
						bind:value={text}
						onkeydown={(e) => {
							if (sendOnEnter(e)) {
								e.preventDefault();
								void drop();
							} else if (e.key === 'Escape') {
								pinned = false;
								collapse();
							}
						}}
					></textarea>
					<button class="send" disabled={!text.trim() || busy || (mode === 'as_bot' && !speaker)} onclick={drop}>
						{busy ? 'Sending…' : 'Send'}
					</button>
				</div>
			</div>
			<p class="hint">
				{mode === 'director'
					? 'The whole room reads it as “The human says: …” - guidance, not a ventriloquist act.'
					: "They'll hear it as their own thought, and the others will answer."}
			</p>
		</div>
	</div>
</div>
<style>
	/* Shut, the composer is a labelled handle: visible enough to be found -
	   a bare grip was the part nobody discovered - and lit fully once the
	   box is open. */
	/* Hidden while the reader is up in the backlog; mounted, so the draft and
	   the picked mode survive the scroll. */
	.spectator.away {
		display: none;
	}
	.handle {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		width: min(44rem, 100%);
		margin: 0 auto;
		padding: 0.3rem 0.6rem;
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 0.76rem;
		cursor: pointer;
		opacity: 0.75;
		transition: opacity 0.16s;
	}
	.handle:hover,
	.spectator.open .handle {
		opacity: 1;
	}
	.grip {
		width: 2.6rem;
		height: 3px;
		border-radius: 999px;
		background: currentColor;
	}
	.handlelabel {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		white-space: nowrap;
	}
	.spectator.open .grip {
		display: none;
	}
	/* The two ways a line can land, as a small switch above the box. */
	.moderow {
		display: flex;
		gap: 0.3rem;
		padding: 0.1rem 0.2rem 0.4rem;
	}
	.mode {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.2rem 0.7rem;
		color: var(--text-muted);
		font-size: 0.74rem;
		cursor: pointer;
	}
	.mode:hover {
		background: var(--bg-hover);
	}
	.mode.sel {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 18%, var(--bg));
		color: var(--text);
	}
	.spectator.open .handlelabel {
		display: inline-flex;
	}
	/* The box itself slides open rather than appearing: a 0fr track can animate,
	   where a hidden element cannot. */
	.panel {
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		pointer-events: none;
		transition: grid-template-rows 0.22s ease, opacity 0.16s ease;
	}
	.spectator.open .panel {
		grid-template-rows: 1fr;
		opacity: 1;
		pointer-events: auto;
	}
	.inner {
		overflow: hidden;
		min-height: 0;
	}
	.banner {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: min(44rem, 100%);
		margin: 0 auto 0.5rem;
		font-size: 0.78rem;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
		border-radius: 0.7rem;
		padding: 0.45rem 0.7rem;
	}
	.eye {
		flex: none;
		display: inline-block;
		transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.eye:hover {
		transform: rotate(8deg) scale(1.08);
	}
	.blink {
		display: inline-block;
		animation: eyeblink 5s infinite;
	}
	@keyframes eyeblink {
		0%,
		92%,
		100% {
			transform: scaleY(1);
		}
		95% {
			transform: scaleY(0.1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.eye {
			transition: none;
		}
		.blink {
			animation: none;
		}
		.panel {
			transition: none;
		}
	}
	.box {
		width: min(44rem, 100%);
		margin: 0 auto;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 1.1rem;
		padding: 0.5rem 0.6rem;
	}
	.whoRow {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		overflow-x: auto;
		padding: 0.1rem 0.2rem 0.4rem;
	}
	.lbl {
		font-size: 0.72rem;
		color: var(--text-muted);
		flex: none;
		margin-right: 0.2rem;
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.15rem 0.5rem 0.15rem 0.15rem;
		color: var(--text-muted);
		font-size: 0.76rem;
		cursor: pointer;
		white-space: nowrap;
		flex: none;
		opacity: 0.65;
	}
	.pick:hover {
		background: var(--bg-hover);
		opacity: 1;
	}
	.pick.sel {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 18%, var(--bg));
		color: var(--text);
		opacity: 1;
	}
	.inputrow {
		display: flex;
		align-items: flex-end;
		gap: 0.3rem;
	}
	textarea {
		flex: 1;
		resize: none;
		background: none;
		border: none;
		outline: none;
		color: var(--text);
		font-family: inherit;
		font-size: 0.93rem;
		line-height: 1.5;
		padding: 0.45rem 0.3rem;
		max-height: 8rem;
	}
	textarea::placeholder {
		color: var(--text-muted);
	}
	.send {
		background: var(--accent);
		border: none;
		border-radius: 999px;
		color: #fff;
		font-size: 0.8rem;
		padding: 0.5rem 0.95rem;
		cursor: pointer;
		flex: none;
	}
	.send:disabled {
		background: #2a2a2f;
		color: #5a5a63;
		cursor: default;
	}
	.hint {
		width: min(44rem, 100%);
		margin: 0.4rem auto 0;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
</style>
