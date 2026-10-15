<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import { describeSchedule } from '$lib/format';

	let { open = $bindable(false) }: { open: boolean } = $props();

	/** One box in, a drafted schedule out. */
	let text = $state('');
	let draft = $state<{ name: string; prompt: string; cron: string; interval_min: number } | null>(
		null
	);
	let nextRun = $state<number | null>(null);
	let busy = $state(false);
	let error = $state('');
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let dialogEl = $state<HTMLElement | null>(null);

	const EXAMPLES = [
		'Every weekday at 9am, summarise my inbox',
		'Check the NAS every 30 minutes and shout if a disk is failing',
		'Monday mornings, post a plan for the week'
	];

	$effect(() => {
		if (open) textareaEl?.focus();
	});

	async function draftIt() {
		if (!text.trim() || busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/routines/parse', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: text.trim() })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Could not draft that (${res.status})`);
			}
			const data = await res.json();
			draft = data.draft;
			nextRun = data.next_run_at;
		} catch (e) {
			error = e instanceof Error ? e.message : 'could not draft that';
			draft = null;
		} finally {
			busy = false;
		}
	}

	async function accept() {
		const bot = chat.panelBot;
		if (!bot || !chat.activeId || !draft || busy) return;
		busy = true;
		try {
			const ok = await chat.createRoutine({
				bot_id: bot.id,
				conversation_id: chat.activeId,
				name: draft.name,
				prompt: draft.prompt,
				interval_min: draft.interval_min,
				cron: draft.cron
			});
			if (ok) close();
		} finally {
			busy = false;
		}
	}

	function close() {
		open = false;
		text = '';
		draft = null;
		nextRun = null;
		error = '';
	}

	function fmtWhen(ts: number | null): string {
		if (!ts) return '';
		return new Date(ts).toLocaleString([], {
			weekday: 'short',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (open) modalKeydown(e, dialogEl, close);
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
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="routine-form-title"
			tabindex="-1"
			bind:this={dialogEl}
		>
			<header>
				<h2 id="routine-form-title">New routine</h2>
				<button class="x" title="Close" aria-label="Close" onclick={close}>✕</button>
			</header>
			<div class="body">
				<p class="hint">Describe it in your own words — the bot works out the schedule.</p>

				<textarea
					rows="3"
					bind:value={text}
					bind:this={textareaEl}
					placeholder="e.g. Every weekday at 9am, summarise my inbox"
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) draftIt();
					}}
				></textarea>

				{#if !draft && !busy}
					<div class="examples">
						{#each EXAMPLES as ex}
							<button class="ex" onclick={() => (text = ex)}>{ex}</button>
						{/each}
					</div>
				{/if}

				{#if error}
					<div class="err">{error}</div>
				{/if}

				{#if draft}
					<div class="preview">
						<div class="prow">
							<span class="lbl">Routine</span>
							<span class="val">{draft.name}</span>
						</div>
						<div class="prow">
							<span class="lbl">Task</span>
							<span class="val body">{draft.prompt}</span>
						</div>
						<div class="prow">
							<span class="lbl">Schedule</span>
							<span class="val">
								{describeSchedule(draft)}
								{#if draft.cron}<code>{draft.cron}</code>{/if}
							</span>
						</div>
						<div class="prow">
							<span class="lbl">Next</span>
							<span class="val">{fmtWhen(nextRun)}</span>
						</div>
					</div>
				{/if}
			</div>

			<div class="actions">
				<button class="cancel" onclick={close}>Cancel</button>
				{#if draft}
					<button class="ghost" disabled={busy} onclick={draftIt}>Regenerate</button>
					<button class="save" disabled={busy} onclick={accept}>Accept</button>
				{:else}
					<button class="save" disabled={!text.trim() || busy} onclick={draftIt}>
						{busy ? 'Drafting…' : 'Draft routine'}
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
	.dialog {
		width: min(32rem, 92vw);
		/* The draft preview can outgrow a short viewport; the body scrolls
		   while the header and the action footer stay put. */
		max-height: min(85dvh, 50rem);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 1rem;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	header {
		flex: none;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.2rem 1.2rem 0;
	}
	.body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 0.7rem 1.2rem 1.2rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.x {
		flex: none;
		background: none;
		border: none;
		border-radius: 0.45rem;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 1rem;
		line-height: 1;
		padding: 0.4rem 0.55rem;
	}
	.x:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.hint {
		margin: 0;
		font-size: 0.82rem;
		/* A step lighter than --text-muted for comfortable reading, same as Sidebar. */
		color: #a9a9b3;
	}
	textarea {
		width: 100%;
		resize: vertical;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		padding: 0.6rem 0.7rem;
		color: var(--text);
		font-family: inherit;
		font-size: 0.9rem;
		line-height: 1.45;
	}
	textarea:focus {
		outline: none;
		border-color: #3d3d44;
	}
	.examples {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.ex {
		text-align: left;
		background: none;
		border: 1px dashed var(--border);
		border-radius: 0.55rem;
		color: #a9a9b3;
		font-size: 0.8rem;
		padding: 0.4rem 0.6rem;
		cursor: pointer;
	}
	.ex:hover {
		color: var(--text);
		border-color: #3d3d44;
	}
	.preview {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		padding: 0.7rem 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.prow {
		display: flex;
		gap: 0.7rem;
		font-size: 0.86rem;
	}
	.lbl {
		width: 4.6rem;
		flex: none;
		color: #a9a9b3;
		font-size: 0.76rem;
		padding-top: 0.1rem;
	}
	.val {
		color: var(--text);
		min-width: 0;
	}
	.val.body {
		white-space: pre-wrap;
	}
	code {
		margin-left: 0.45rem;
		background: var(--bg-hover);
		border-radius: 0.3rem;
		padding: 0.05rem 0.35rem;
		font-size: 0.76rem;
		color: #a9a9b3;
	}
	.err {
		color: var(--danger);
		font-size: 0.83rem;
	}
	.actions {
		/* Static flex sibling after the scrolling body, so it can neither
		   overlap the draft preview nor scroll out of reach. */
		flex: none;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.75rem 1.2rem;
		border-top: 1px solid var(--border);
		background: var(--bg-raised);
	}
	button {
		border-radius: 0.6rem;
		padding: 0.5rem 1rem;
		font-size: 0.86rem;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.cancel {
		background: none;
		color: var(--text-muted);
	}
	.cancel:hover {
		color: var(--text);
	}
	.ghost {
		background: var(--bg);
		border-color: var(--border);
		color: var(--text);
	}
	.ghost:hover {
		background: var(--bg-hover);
	}
	.save {
		background: var(--accent);
		color: #fff;
	}
	.save:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.dialog:focus-visible,
	button:focus-visible,
	textarea:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
