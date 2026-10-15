<script lang="ts">
	import { onMount } from 'svelte';

	type Notice = {
		id: string;
		bot_id: string;
		bot_name: string;
		kind: string;
		rule: string;
		summary: string;
		evidence: string;
		created_at: number;
	};

	/**
	 * The tap on the shoulder. The police round raises a finding, this asks for
	 * it, and it leaves the screen on its own after a few seconds - the ✕ and
	 * the timer both dismiss it the same way, and the log in Settings keeps
	 * the record either way.
	 */
	let notices = $state<Notice[]>([]);
	let seen = $state<Set<string>>(new Set());
	/** The notice whose report was just copied, so its button can say so. */
	let copied = $state('');

	async function load() {
		const res = await fetch('/api/police').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (data) notices = data.notices ?? [];
	}

	async function dismiss(n: Notice) {
		// Off screen at once; the log records the dismissal either way.
		seen = new Set(seen).add(n.id);
		await fetch('/api/police', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ dismiss: n.id })
		}).catch(() => {});
		notices = notices.filter((x) => x.id !== n.id);
	}

	function ago(at: number): string {
		const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
		if (minutes < 60) return `${minutes}m ago`;
		return `${Math.round(minutes / 60)}h ago`;
	}

	const shown = $derived(notices.filter((n) => !seen.has(n.id)));

	/** How long a notice stays before it dismisses itself. */
	const AUTO_DISMISS_MS = 7_000;
	/** One countdown per notice on screen; it firing is the same as the ✕. */
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	$effect(() => {
		const live = new Set(shown.map((n) => n.id));
		for (const n of shown) {
			// A pending jail is a question, not a tap on the shoulder: it stays
			// until the human answers, so it gets no countdown.
			if (n.kind === 'jail') continue;
			if (!timers.has(n.id)) {
				timers.set(
					n.id,
					setTimeout(() => void dismiss(n), AUTO_DISMISS_MS)
				);
			}
		}
		// A notice that left by another route (dismissed, expired) does not
		// get to fire its timer into a list it is no longer in.
		for (const [id, t] of timers) {
			if (!live.has(id)) {
				clearTimeout(t);
				timers.delete(id);
			}
		}
	});

	/**
	 * A security or disobedience finding is a pattern the patrol matched on a
	 * real line - high-confidence by construction - so it earns a one-tap bug
	 * report. The report is copied, not filed: there is no tracker configured
	 * for it to open.
	 */
	async function fileReport(n: Notice) {
		const report = [
			`Police finding: ${n.summary}`,
			'',
			`Kind: ${n.kind} (${n.rule})`,
			`Bot: ${n.bot_name || 'the fleet'}`,
			`Raised: ${new Date(n.created_at).toISOString()}`,
			'',
			'Evidence:',
			n.evidence
		].join('\n');
		try {
			await navigator.clipboard.writeText(report);
			copied = n.id;
			setTimeout(() => {
				if (copied === n.id) copied = '';
			}, 2000);
		} catch {
			// No clipboard (insecure context, denied): the evidence is still on
			// the banner to copy by hand.
		}
	}

	/**
	 * The notice poll, rescheduling itself each round like the chat store's
	 * ambient polls: a hidden tab fetches nothing, a quiet one waits a little
	 * longer each time up to the cap, and a new notice - or the tab coming back
	 * - snaps it to the minimum so the tap on the shoulder still lands fast.
	 */
	const POLL_MIN_MS = 15_000;
	const POLL_MAX_MS = 60_000;

	onMount(() => {
		let cancelled = false;
		let delay = POLL_MIN_MS;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (!cancelled && !document.hidden) {
				const before = notices[0]?.id;
				await load();
				delay = notices[0]?.id !== before ? POLL_MIN_MS : Math.min(delay * 1.5, POLL_MAX_MS);
			}
			if (!cancelled) timer = setTimeout(() => void tick(), delay);
		};
		void load();
		timer = setTimeout(() => void tick(), delay);
		const onVisible = () => {
			if (document.hidden || cancelled) return;
			delay = POLL_MIN_MS;
			clearTimeout(timer);
			void tick();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

{#if shown.length}
	<div class="stack">
		{#each shown as n (n.id)}
			<div
				class="notice"
				class:security={n.kind === 'security' || n.kind === 'disobedience'}
				class:jail={n.kind === 'jail'}
				style={`--life:${AUTO_DISMISS_MS}ms`}
				role="alert"
			>
				<div class="head">
					<span class="tag">{n.kind === 'jail' ? 'JAIL' : n.kind === 'bug_report' ? 'BUG' : 'POLICE'}</span>
					<span class="officer">{n.kind === 'jail' ? '🔒 pending jail' : n.kind === 'bug_report' ? '🐛 bug report' : '🚨 the police'}</span>
					<span class="when">{ago(n.created_at)}</span>
					<button class="x" title="Dismiss" aria-label="Dismiss" onclick={() => dismiss(n)}>✕</button>
				</div>
				<p class="summary">{n.summary}{n.bot_name ? ` — ${n.bot_name}` : ''}</p>
				<p class="evidence">{n.evidence}</p>
				<button
					class="more"
					onclick={() => {
						void dismiss(n);
						window.dispatchEvent(new CustomEvent('obl:police-log'));
					}}
				>
					Police log
				</button>
				{#if n.kind === 'security' || n.kind === 'disobedience'}
					<button class="more report" onclick={() => fileReport(n)}>
						{copied === n.id ? 'Copied ✓' : 'File report'}
					</button>
				{/if}
				{#if n.kind !== 'jail'}
					<span class="life" aria-hidden="true"></span>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	/* One corner stack: several findings queue instead of landing on top of
	   each other. */
	.stack {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 70;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: min(26rem, calc(100vw - 2rem));
	}
	/* The police's own colours: the badge blue, not the app's accent. */
	.notice {
		position: relative;
		overflow: hidden;
		animation:
			notice-in 0.35s ease-out,
			siren 1.6s ease-in-out 0.35s infinite;
	}
	.notice.security {
		background: #2a1010;
		border-color: #b91c1c;
		border-left-color: #ef4444;
	}
	/* A proposed jail is a question, not a siren: amber, and it stays put
	   until the human answers it - no auto-dismiss on a decision. */
	.notice.jail {
		background: #241a08;
		border-color: #b45309;
		border-left-color: #f59e0b;
		animation: notice-in 0.35s ease-out;
	}
	.jail .tag {
		background: #78350f;
		border-color: #f59e0b;
	}
	.jail .officer {
		color: #fbbf24;
	}
	@keyframes notice-in {
		from {
			transform: translateY(0.8rem);
			opacity: 0;
		}
	}
	/* The patrol light: a slow, soft blue/red glow that keeps breathing while
	   the notice is up - present, never strobing. */
	@keyframes siren {
		0%,
		100% {
			box-shadow:
				0 8px 28px rgba(0, 0, 0, 0.55),
				0 0 16px rgba(59, 130, 246, 0.28);
		}
		50% {
			box-shadow:
				0 8px 28px rgba(0, 0, 0, 0.55),
				0 0 16px rgba(239, 68, 68, 0.24);
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.tag {
		flex: none;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		color: #fff;
		background: #1e3a8a;
		border: 1px solid #3b82f6;
		border-radius: 4px;
		padding: 0.1rem 0.4rem;
	}
	.security .tag {
		background: #7f1d1d;
		border-color: #ef4444;
	}
	.officer {
		font-weight: 600;
		color: #93c5fd;
	}
	.security .officer {
		color: #f87171;
	}
	.when {
		color: var(--muted, #8a8a93);
		font-size: 0.75rem;
	}
	.x {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--muted, #8a8a93);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0 0.15rem;
	}
	.x:hover {
		color: #fff;
	}
	.summary {
		margin: 0.3rem 0 0;
		color: #f3f4f6;
	}
	.evidence {
		margin: 0.25rem 0 0;
		color: var(--muted, #b6b6bd);
		font-family: ui-monospace, Menlo, monospace;
		font-size: 0.74rem;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
	}
	.more {
		display: inline-block;
		margin-top: 0.4rem;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: #93c5fd;
		font-family: inherit;
		font-size: 0.76rem;
		text-decoration: none;
	}
	.report {
		margin-left: 0.7rem;
	}
	.more:hover {
		text-decoration: underline;
	}
	/* The bar drains for exactly as long as the auto-dismiss timer runs, so
	   the notice says it is leaving rather than vanishing without warning. */
	.life {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		width: 100%;
		background: #3b82f6;
		transform-origin: left;
		animation: life-drain var(--life, 7s) linear forwards;
	}
	.security .life {
		background: #ef4444;
	}
	@keyframes life-drain {
		from {
			transform: scaleX(1);
		}
		to {
			transform: scaleX(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.notice {
			animation: none;
		}
		.life {
			animation: none;
			opacity: 0.4;
		}
	}
</style>
