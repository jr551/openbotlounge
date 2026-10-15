<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import { shortTokens } from '$lib/bloat';
	import Avatar from './Avatar.svelte';
	import Markdown from './Markdown.svelte';
	import type { Activity, Message, Task } from '$lib/types';

	/**
	 * One task up close: what it was asked, what it has done so far, what it is
	 * costing and what it produced. While the task runs this re-reads itself
	 * once a second; once it settles the answer stops changing, so the polling
	 * does too.
	 */
	let { taskId, close }: { taskId: string; close: () => void } = $props();

	let task = $state<Task | null>(null);
	let message = $state<Message | null>(null);
	let activities = $state<Activity[]>([]);
	let missing = $state(false);
	/** The bot machine's state while the task runs; null hides the line. */
	let machineState = $state<string | null>(null);
	let dialogEl = $state<HTMLElement | null>(null);

	/** Ticking clock for the elapsed figure while the task runs. */
	let now = $state(Date.now());

	async function refresh() {
		const res = await fetch(`/api/tasks/${taskId}`).catch(() => null);
		if (!res) return;
		if (res.status === 404) {
			missing = true;
			return;
		}
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		task = data.task;
		message = data.message;
		activities = data.activities;
		if (task?.status === 'running') void refreshMachine();
		else machineState = null;
	}
	/** The newest machine-setup step, if the run has logged one yet. */
	const setupDetail = $derived(activities.filter((a) => a.kind === 'sandbox').at(-1)?.detail ?? '');
	async function refreshMachine() {
		const id = task?.bot_id;
		if (!id || task?.status !== 'running') return;
		const res = await fetch(`/api/bots/${id}/shellbox`).catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (typeof data?.state === 'string') machineState = data.state;
	}

	$effect(() => {
		void refresh();
		const t = setInterval(() => {
			now = Date.now();
			if (task?.status === 'running') void refresh();
		}, 1000);
		return () => clearInterval(t);
	});

	function elapsed(t: Task): string {
		const end = t.finished_at || now;
		const s = Math.max(0, Math.round((end - t.created_at) / 1000));
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m ${s % 60}s`;
	}

	/** How far into the task a step happened, e.g. +4s. */
	function offset(a: Activity): string {
		const s = Math.max(0, Math.round((a.created_at - (task?.created_at ?? a.created_at)) / 1000));
		if (s < 60) return `+${s}s`;
		return `+${Math.floor(s / 60)}m ${s % 60}s`;
	}

	function statusWord(t: Task): string {
		if (t.status === 'running') return 'working';
		if (t.status === 'done') return 'done';
		if (t.status === 'cancelled') return 'stopped';
		return 'hit an error';
	}

	async function cancel() {
		await chat.cancelTask(taskId);
		await refresh();
	}

	async function retry() {
		// Re-send the same prompt as a new task in the same conversation.
		await chat.sendTo(task!.conversation_id, task!.prompt);
		close();
	}

	async function retryWithAdvice() {
		// Re-send the prompt with a note about what went wrong, so the model
		// knows what to fix.
		const advice = task!.error
			? `The previous attempt failed: ${task!.error}. Please try again.`
			: 'The previous attempt did not complete. Please try again.';
		await chat.sendTo(task!.conversation_id, `${task!.prompt}\n\n${advice}`);
		close();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		modalKeydown(e, dialogEl, close);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

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
		aria-labelledby="task-detail-title"
		tabindex="-1"
		bind:this={dialogEl}
	>
		<header>
			<h2 id="task-detail-title">Task</h2>
			<button class="x" title="Close" aria-label="Close" onclick={close}>✕</button>
		</header>

		{#if missing}
			<div class="body"><p class="hint">That task is gone.</p></div>
		{:else if !task}
			<div class="body"><p class="hint">Loading…</p></div>
		{:else}
			{@const bot = chat.botById(task.bot_id)}
			<div class="body">
				<div class="meta">
					<Avatar
						color={bot?.color ?? '#4f8ef7'}
						seed={bot?.id ?? task.bot_id}
						size={30}
						working={task.status === 'running'}
					/>
					<span class="who" style:color={bot?.color}>{bot?.name ?? 'bot'}</span>
					<span class="state">{statusWord(task)}</span>
					<span class="stat">{elapsed(task)}</span>
					<span
						class="stat"
						title="{task.tokens_in.toLocaleString()} tokens in · {task.tokens_out.toLocaleString()} tokens out"
					>
						{shortTokens(task.tokens_in)} in · {shortTokens(task.tokens_out)} out
					</span>
				</div>
				{#if machineState && machineState !== 'running'}
					<div class="machine">machine: {machineState}{setupDetail ? ` · setup: ${setupDetail}` : ''}</div>
				{/if}

				<div class="block">
					<span class="lbl">Asked</span>
					<div class="prompt">{task.prompt || 'working'}</div>
				</div>

				{#if task.context}
					<div class="block">
						<span class="lbl">Brief</span>
						<div class="prompt">{task.context}</div>
					</div>
				{/if}

				{#if activities.length}
					<div class="block">
						<span class="lbl">Steps</span>
						<ul class="steps">
							{#each activities as a (a.id)}
								<li>
									<span class="kind">{a.kind}</span>
									<span class="at">{offset(a)}</span>
									<span class="det">
										{a.detail}
										{#if a.image}
											<a href="/api/shots/{a.image}" target="_blank" rel="noreferrer">screenshot</a>
										{/if}
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if task.error}
					<div class="err">{task.error}</div>
				{/if}

				{#if message}
					<div class="block">
						<span class="lbl">Reply</span>
						<div class="result"><Markdown source={message.content} /></div>
					</div>
				{:else if task.preview}
					<div class="block">
						<span class="lbl">{task.status === 'running' ? 'Writing' : 'Partial reply'}</span>
						<div class="result partial">{task.preview}</div>
					</div>
				{/if}
			</div>

			{#if task.status === 'running'}
				<div class="actions">
					<button class="ghost" onclick={cancel}>Stop task</button>
				</div>
			{:else if task.status === 'error' || task.status === 'done'}
				<div class="actions">
					<button class="ghost" onclick={() => retry()}>Retry</button>
					<button class="ghost" onclick={() => retryWithAdvice()}>Retry with advice</button>
				</div>
			{/if}
		{/if}
	</div>
</div>

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
		width: min(34rem, 92vw);
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
	.meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.82rem;
	}
	.who {
		font-weight: 600;
	}
	.state {
		color: var(--text-muted);
	}
	.stat {
		color: var(--text-muted);
		font-size: 0.76rem;
		font-variant-numeric: tabular-nums;
	}
	.machine {
		color: var(--text-muted);
		font-size: 0.76rem;
		font-variant-numeric: tabular-nums;
	}
	.stat:first-of-type {
		margin-left: auto;
	}
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.lbl {
		color: #a9a9b3;
		font-size: 0.76rem;
	}
	.prompt {
		font-size: 0.86rem;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
	}
	.steps li {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
	}
	.kind {
		flex: none;
		background: var(--bg-hover);
		border-radius: 0.3rem;
		padding: 0.05rem 0.35rem;
		font-size: 0.72rem;
		color: #a9a9b3;
	}
	.at {
		flex: none;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}
	.det {
		min-width: 0;
		color: var(--text);
		overflow-wrap: break-word;
	}
	.det a {
		color: var(--accent);
	}
	.result {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		padding: 0.7rem 0.8rem;
	}
	.result.partial {
		font-size: 0.82rem;
		color: var(--text-muted);
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}
	.err {
		color: var(--danger);
		font-size: 0.83rem;
	}
	.hint {
		margin: 0;
		font-size: 0.82rem;
		color: #a9a9b3;
	}
	.actions {
		flex: none;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.75rem 1.2rem;
		border-top: 1px solid var(--border);
		background: var(--bg-raised);
	}
	.actions button {
		border-radius: 0.6rem;
		padding: 0.5rem 1rem;
		font-size: 0.86rem;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.ghost {
		background: var(--bg);
		border-color: var(--border) !important;
		color: var(--text);
	}
	.ghost:hover {
		background: var(--bg-hover);
	}

	.dialog:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
