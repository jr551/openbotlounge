<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import Avatar from './Avatar.svelte';
	import TaskDetail from './TaskDetail.svelte';
	import TypingLine from './TypingLine.svelte';
	import type { Task } from '$lib/types';

	/**
	 * The task tray: what each bot is working on right now, and what it has
	 * done in the last day. Turns run in the background, so this is where
	 * parallel work is visible and cancellable - and where yesterday's routine
	 * or computer job can still be found.
	 */
	let { }: {} = $props();

	/**
	 * The tray's own fold. It used to drive the parent's mount flag, which
	 * meant collapsing the list unmounted the tray outright - the head that
	 * reopens it went with it. Expanded and mounted are separate things.
	 */
	let expanded = $state(true);
	/** Tasks the reader has dismissed individually; they stay gone until the
	    next poll brings a genuinely new row. */
	let dismissed = $state<Set<string>>(new Set());
	/** The tray slides itself open the moment a task appears, and slides back
	    down once everything has settled - the head stays as the manual toggle. */
	let prevRunning = $state(0);
	$effect(() => {
		if (running.length > prevRunning) expanded = true;
		prevRunning = running.length;
	});

	/**
	 * The fields the server adds to a task row: a generated title and emoji,
	 * and what sort of work it was. Read through a cast so the tray compiles
	 * while the columns are still landing; '' everywhere means "not yet".
	 */
	type TaskLabel = { title?: string; emoji?: string; kind?: string };
	const labelOf = (t: Task): TaskLabel => t as Task & TaskLabel;

	/**
	 * The tray's own list: every conversation's tasks, not just the open
	 * chat's. The store's `tasks` is scoped to the room being read, so the
	 * tray fetches the fleet-wide feed itself while it is open.
	 */
	let trayTasks = $state<Task[]>([]);
	let clearing = $state(false);

	// The Lounge's own rounds are not the human's work — hide them even if the
	// backend hasn't filtered them yet (title 'Lounge' or kind 'lounge').
	function isLoungeTask(t: Task): boolean {
		const k = (t as Task & { kind?: string }).kind;
		if (k === 'lounge') return true;
		const lounge = chat.conversations.find((c) => c.kind === 'group' && c.title === 'Lounge' && (c as unknown as { private?: number }).private);
		if (lounge && t.conversation_id === lounge.id) return true;
		if (t.prompt?.startsWith('[Lounge]')) return true;
		return false;
	}
	const filteredTasks = $derived(trayTasks.filter((t) => !isLoungeTask(t)));
	const running = $derived(filteredTasks.filter((t) => t.status === 'running'));
	const recent = $derived(filteredTasks.filter((t) => t.status !== 'running'));
	const busy = $derived(running.length > 0);
	/** The task whose detail dialog is open, if any. */
	let detailId = $state('');

	/** Seconds a task has been going, ticking while it runs. */
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	// The tray keeps its own poll while open: running rows need their preview
	// refreshed, and a task that finishes should settle without waiting for the
	// open chat's own poller to notice.
	$effect(() => {
		if (!expanded) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async () => {
			const res = await fetch('/api/tasks').catch(() => null);
			if (cancelled) return;
			if (res?.ok) {
				const data = await res.json().catch(() => null);
				if (data?.tasks && !cancelled) {
					trayTasks = (data.tasks as Task[]).filter((t) => !isLoungeTask(t));
				}
			}
			if (!cancelled) timer = setTimeout(() => void tick(), running.length ? 1500 : 8000);
		};
		void tick();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	});

	function elapsed(t: Task): string {
		const end = t.finished_at || now;
		const s = Math.max(0, Math.round((end - t.created_at) / 1000));
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m ${s % 60}s`;
	}

	/** How long ago a finished task ended, in the tray's own words. */
	function ago(t: Task): string {
		const at = t.finished_at || t.created_at;
		const mins = Math.max(0, Math.round((now - at) / 60_000));
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.round(mins / 60);
		return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
	}

	function botOf(t: Task) {
		return chat.botById(t.bot_id);
	}

	function statusWord(t: Task): string {
		if (t.status === 'running') return 'working';
		if (t.status === 'done') return 'done';
		if (t.status === 'cancelled') return 'stopped';
		return 'hit an error';
	}

	async function clearFinished() {
		if (!recent.length || clearing) return;
		clearing = true;
		const kept = trayTasks.filter((t) => t.status === 'running');
		const prev = trayTasks;
		trayTasks = kept;
		try {
			let res = await fetch('/api/tasks', { method: 'DELETE' }).catch(() => null);
			if (!res?.ok) {
				res = await fetch('/api/tasks/clear', { method: 'POST' }).catch(() => null);
			}
			if (res?.ok) {
				const r = await fetch('/api/tasks').catch(() => null);
				if (r?.ok) {
					const d = await r.json().catch(() => null);
					if (d?.tasks) trayTasks = (d.tasks as Task[]).filter((t) => !isLoungeTask(t));
				}
			} else {
				trayTasks = prev;
			}
		} finally {
			clearing = false;
		}
	}

	/** A glyph for the sort of work it was, when the server said. */
	const KIND_ICON: Record<string, string> = {
		chat: '💬',
		routine: '🔁',
		wake: '⏰',
		lounge: '🛋️',
		computer: '🖥️',
		webhook: '🪝',
		inject: '💉',
		onboarding: '👋',
		fed: '🕵️',
		subagent: '🤖'
	};

	/** What the row is called: the generated title, else the ask itself. */
	function titleOf(t: Task): string {
		const label = labelOf(t);
		return label.title || t.prompt || 'working';
	}

	/**
	 * The live partial for a running row, falling back to the polled tail. The
	 * stream carries the words as they are written; the poll is only the
	 * backstop for a row whose task this process is not running.
	 */
	function livePreview(t: Task): string {
		return chat.previewForTask(t.id) || t.preview;
	}

	/** The row's glyph: the generated emoji, else one for the kind of work. */
	function emojiOf(t: Task): string {
		const label = labelOf(t);
		return label.emoji || KIND_ICON[label.kind ?? ''] || '⚙️';
	}
</script>

{#if filteredTasks.length}
	<section class="tray" class:open={expanded}>
		<div class="head" role="button" tabindex="0" onclick={() => (expanded = !expanded)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; } }}>
			<span class="dot" class:pulse={busy}></span>
			<span class="title">
				{busy ? `${running.length} task${running.length === 1 ? '' : 's'} in flight` : 'Tasks'}
			</span>
			{#if recent.length}
				<button
					class="clear"
					disabled={clearing}
					title="Clear finished tasks"
					onclick={(e) => {
						e.stopPropagation();
						void clearFinished();
					}}
				>{clearing ? 'Clearing…' : 'Clear'}</button>
			{/if}
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate({expanded ? 180 : 0}deg)"><path d="m6 15 6-6 6 6"/></svg>
		</div>

		{#if expanded}
			<div class="list">
				{#each running as t (t.id)}
					{@const bot = botOf(t)}
					{@const elapsedS = Math.max(0, Math.round((now - t.created_at) / 1000))}
					{@const pct = Math.min(90, Math.round((elapsedS / 120) * 100))}
					<!-- A plain row, not a role="button" holding the stop button: a
					     button inside a button is announced twice and Enter cannot
					     tell them apart. Click stays the mouse shortcut; the Open
					     button below is the real control. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- The row click is only the mouse shortcut; the Open button
					     inside is the real, keyboard-reachable control. -->
					<div class="task running" onclick={() => (detailId = t.id)}>
						<!-- The bot's face and name are their own control: they open the
						     bot's chat on purpose, and stop the click from also opening the
						     task. The rest of the row opens only the task detail. -->
						<button
							class="botlink"
							title="Open {bot?.name ?? 'bot'}'s chat"
							onclick={(e) => {
								e.stopPropagation();
								void chat.openDirect(t.bot_id);
							}}
						>
							<Avatar color={bot?.color ?? '#4f8ef7'} seed={bot?.id ?? t.bot_id} size={30} working />
						</button>
						<div class="body">
							<div class="line1">
								<span class="glyph" aria-hidden="true">{emojiOf(t)}</span>
								<button
									class="who"
									style:color={bot?.color}
									title="Open {bot?.name ?? 'bot'}'s chat"
									onclick={(e) => {
										e.stopPropagation();
										void chat.openDirect(t.bot_id);
									}}
								>{bot?.name ?? 'bot'}</button>
								<span class="state">⏳ working</span>
								<span class="time" title="Running for {elapsed(t)}">{elapsed(t)}</span>
								<button
									class="open"
									title="Open task detail"
									onclick={(e) => {
										e.stopPropagation();
										detailId = t.id;
									}}
								>Open</button>
								<button
									class="stop"
									title="Stop this task"
									onclick={(e) => {
										e.stopPropagation();
										chat.cancelTask(t.id);
									}}
								>✕</button>
							</div>
							<!-- The ask, big and first - the whole point of a running row:
							     what this bot is busy with, readable at a glance. -->
							<div class="what running-what">Working on {titleOf(t)}</div>
							<!-- A task does not know its own progress, so the bar fills on
							     elapsed time alone - a 30s job reads differently from a
							     5-minute one, and the cap keeps a long grind from looking
							     done. -->
							<div class="taskbar" title="Running for {elapsed(t)}">
								<span class="fill" style:width="{pct}%"></span>
							</div>
							{#if livePreview(t)}
								<TypingLine text={livePreview(t)} />
							{/if}
						</div>
					</div>
				{/each}

				{#each recent as t (t.id)}
					{@const bot = botOf(t)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="task done" onclick={() => (detailId = t.id)}>
						<button
							class="botlink"
							title="Open {bot?.name ?? 'bot'}'s chat"
							onclick={(e) => {
								e.stopPropagation();
								void chat.openDirect(t.bot_id);
							}}
						>
							<Avatar color={bot?.color ?? '#4f8ef7'} seed={bot?.id ?? t.bot_id} size={30} />
						</button>
						<div class="body">
							<div class="line1">
								<span class="glyph" aria-hidden="true">{emojiOf(t)}</span>
								<button
									class="who"
									style:color={bot?.color}
									title="Open {bot?.name ?? 'bot'}'s chat"
									onclick={(e) => {
										e.stopPropagation();
										void chat.openDirect(t.bot_id);
									}}
								>{bot?.name ?? 'bot'}</button>
								<span class="state">{statusWord(t)}</span>
								<span class="time" title={new Date(t.finished_at || t.created_at).toLocaleString()}>
									{ago(t)}
								</span>
								<button
									class="open"
									title="Open task detail"
									onclick={(e) => {
										e.stopPropagation();
										detailId = t.id;
									}}
								>Open</button>
							</div>
							<div class="what">{titleOf(t)}</div>
							{#if t.error}
								<div class="err">{t.error}</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>
{/if}

{#if detailId}
	<TaskDetail taskId={detailId} close={() => (detailId = '')} />
{/if}



<style>
	.tray {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		width: min(23rem, calc(100vw - 2rem));
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.85rem;
		box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
		overflow: hidden;
		z-index: 50;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		background: none;
		border: none;
		color: var(--text);
		padding: 0.55rem 0.75rem;
		font-size: 0.83rem;
		cursor: pointer;
	}
	.head svg {
		transition: transform 0.18s;
	}
	.head:hover {
		background: var(--bg-hover);
	}
	.title {
		flex: 1;
		text-align: left;
		font-weight: 600;
	}
	.clear {
		font-size: 0.72rem;
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text-muted);
		cursor: pointer;
		margin-right: 0.2rem;
	}
	.clear:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
		border-color: #4a4a52;
	}
	.clear:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		/* A soft square, not a circle: the same 8px round dot reads as "off" in
		 * every other list, so here the tray's own lamp keeps corners. */
		border-radius: 2px;
		background: var(--text-muted);
	}
	.dot.pulse {
		background: #4ade80;
		animation: breathe 1.4s ease-in-out infinite;
	}
	@keyframes breathe {
		0%,
		100% {
			opacity: 0.5;
			transform: scale(0.85);
		}
		50% {
			opacity: 1;
			transform: scale(1.15);
		}
	}
	.list {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--border);
		/* A day's work can run long; the tray scrolls rather than growing. */
		max-height: 24rem;
		overflow-y: auto;
	}
	.task {
		display: flex;
		gap: 0.55rem;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
	}
	.task:hover {
		background: var(--bg-hover);
	}
	.task:last-child {
		border-bottom: none;
	}
	.task.done {
		opacity: 0.55;
	}
	/* A running row stands out against finished ones: a left accent bar and
	   full opacity, so what is in flight is the row the eye lands on. */
	.task.running {
		border-left: 3px solid #4ade80;
	}
	.running-what {
		/* Bigger than a finished row's ask: this one is still in motion. */
		font-weight: 600;
		font-size: 0.82rem;
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	.line1 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
	}
	.glyph {
		flex: none;
		font-size: 0.85rem;
		line-height: 1;
	}
	.botlink {
		flex: none;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
		line-height: 0;
		border-radius: 50%;
	}
	.botlink:hover {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.who {
		font-weight: 600;
		padding: 0;
		border: none;
		background: none;
		font-size: inherit;
		cursor: pointer;
		text-align: left;
	}
	.who:hover {
		text-decoration: underline;
	}
	.state {
		color: var(--text-muted);
	}
	/* A running row's state chip is the work-in-flight signal: green, not the
	   muted grey a finished row carries. */
	.task.running .state {
		color: #4ade80;
	}
	.time {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 0.72rem;
	}
	button.open {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.72rem;
		padding: 0.15rem 0.55rem;
	}
	button.open:hover {
		background: var(--bg-hover);
		color: var(--text);
		border-color: #4a4a52;
	}
	.stop {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.72rem;
		padding: 0 0.2rem;
	}
	.stop:hover {
		color: var(--danger);
		animation: x-shake 0.3s ease-in-out;
	}
	@keyframes x-shake {
		0%,
		100% {
			transform: translateX(0);
		}
		33% {
			transform: translateX(-1.5px);
		}
		66% {
			transform: translateX(1.5px);
		}
	}
	.what {
		font-size: 0.78rem;
		color: var(--text);
		margin-top: 0.15rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* The running row's own progress: elapsed time as a bar, capped at 90% so
	   a long grind never reads as done. The fill's transition smooths the
	   poll's jumps. */
	.taskbar {
		position: relative;
		height: 0.2rem;
		border-radius: 999px;
		background: var(--border);
		overflow: hidden;
		margin-top: 0.3rem;
	}
	.taskbar .fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: 999px;
		background: linear-gradient(90deg, #4ade80, #86efac);
		transition: width 0.5s ease;
	}
	.err {
		font-size: 0.74rem;
		color: var(--danger);
		margin-top: 0.2rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.stop:hover {
			animation: none;
		}
		.head svg {
			transition: none;
		}
		.dot.pulse {
			animation: none;
		}
	}
</style>
