<script lang="ts">
	import { tick } from 'svelte';
	import { chat, pausedUntilOf } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import { shortTokens } from '$lib/bloat';
	import { formatCost } from '$lib/pricing';
	import Avatar from './Avatar.svelte';
	import CompanyCard from './CompanyCard.svelte';

	/**
	 * A bot's card: who it is, what it has spent, what the police have on it,
	 * and the company profile the human keeps on it. Opened by setting
	 * chat.detailBotId - a name in the thread, the screen's caption - so the
	 * same card answers from anywhere a bot is named. Everything is fetched on
	 * open and nothing is polled: a card you glance at, not a dashboard.
	 */

	/** One point on the meter: when, and what that turn cost in and out. */
	type UsagePoint = { t: number; input: number; output: number };
	/** One line in the police log: when, what kind of note, what it says. */
	type PoliceRow = { t: number; kind: string; detail: string };
	/** One model's share of the spend: its tasks, tokens, and bill. */
	type ModelSpend = {
		model: string;
		tasks: number;
		tokens_in: number;
		tokens_out: number;
		/** The provider's own bill for the group; null when it priced none. */
		cost: number | null;
		/** The estimate against the best known rate; null when there is none. */
		estimated_cost: number | null;
	};
	/** The spend priced: lifetime is the bot-row meter, total the task sum. */
	type Spend = {
		lifetime: number | null;
		total: number | null;
		estimated: number | null;
		by_model: ModelSpend[];
	};
	type Stats = { usage: UsagePoint[]; cost?: Spend; police: PoliceRow[] };

	const bot = $derived(chat.botById(chat.detailBotId));

	/** A frozen bot's card frosts over too; the pause counts down live. */
	let frostClock = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (frostClock = Date.now()), 15_000);
		return () => clearInterval(timer);
	});
	const frozenUntil = $derived(pausedUntilOf(bot));
	const frozen = $derived(frozenUntil > frostClock);
	const frozenMins = $derived(Math.max(1, Math.ceil((frozenUntil - frostClock) / 60_000)));

	let stats = $state<Stats | 'loading' | 'none' | 'error'>('loading');
	let profile = $state('');
	/** 'loading' while the first read is out, 'none' when there is no profile,
	 *  'error' when the read failed - which is not the same as an empty one. */
	let profileState = $state<'loading' | 'ready' | 'none' | 'error'>('loading');
	let editing = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let profileNote = $state('');
	let dialogEl = $state<HTMLElement | null>(null);
	function close() {
		chat.detailBotId = '';
	}

	// Both fetches are keyed on the id, so a card opened for one bot can never
	// show the last bot's numbers while its own are in flight. Both routes
	// answer 200 for "nothing there", so a failure is the transport, not an
	// empty record - and it is said as such, with a retry.
	function loadStats(id: string) {
		if (!id) return;
		stats = 'loading';
		void fetch(`/api/bots/${id}/stats`)
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status}`);
				return r.json();
			})
			.then((data) => {
				if (chat.detailBotId !== id) return;
				stats = data
					? { usage: data.usage ?? [], cost: data.cost, police: data.police ?? [] }
					: 'none';
			})
			.catch(() => {
				if (chat.detailBotId === id) stats = 'error';
			});
	}

	function loadProfile(id: string) {
		if (!id) return;
		profileState = 'loading';
		void fetch(`/api/bots/${id}/profile`)
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status}`);
				return r.json();
			})
			.then((data) => {
				if (chat.detailBotId !== id) return;
				profile = data?.content ?? '';
				profileState = 'ready';
			})
			.catch(() => {
				if (chat.detailBotId === id) profileState = 'error';
			});
	}

	$effect(() => {
		const id = chat.detailBotId;
		if (!id) return;
		profile = '';
		editing = false;
		profileNote = '';
		loadStats(id);
		loadProfile(id);
	});

	// Focus moves into the card when it opens and back to what opened it when
	// it closes, so a keyboard user is never dropped at the top of the page.
	let returnFocus: HTMLElement | null = null;
	$effect(() => {
		if (chat.detailBotId) {
			returnFocus = document.activeElement as HTMLElement | null;
			void tick().then(() => dialogEl?.focus());
		} else if (returnFocus) {
			returnFocus.focus();
			returnFocus = null;
		}
	});

	/** The fetched numbers, or null while loading, failed, or found without. */
	const statsData = $derived(
		stats === 'loading' || stats === 'none' || stats === 'error' ? null : stats
	);

	/** The meter drawn as two cumulative lines: the bill filling up over time. */
	function usagePoints(key: 'input' | 'output'): string {
		const rows = statsData?.usage ?? [];
		if (!rows.length) return '';
		const W = 300;
		const H = 90;
		const PAD = 4;
		const cum = rows.map((r) => ({ input: r.input, output: r.output }));
		for (let i = 1; i < cum.length; i++) {
			cum[i].input += cum[i - 1].input;
			cum[i].output += cum[i - 1].output;
		}

		const max = Math.max(1, cum.at(-1)!.input + cum.at(-1)!.output);
		return cum
			.map((c, i) => {
				const x = PAD + (rows.length > 1 ? (i / (rows.length - 1)) * (W - PAD * 2) : (W - PAD * 2) / 2);
				const y = H - PAD - (c[key] / max) * (H - PAD * 2);
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	}

	const usageTotals = $derived.by(() => {
		if (!statsData || !statsData.usage.length) return null;
		return {
			input: statsData.usage.reduce((n, r) => n + r.input, 0),
			output: statsData.usage.reduce((n, r) => n + r.output, 0)
		};
	});

	/** The spend block, when the stats route priced anything for this bot. */
	const spend = $derived(statsData?.cost ?? null);

	/** The log reads newest first; the API may already order it, so sort anyway. */
	const policeRows = $derived(statsData ? [...statsData.police].sort((a, b) => b.t - a.t) : []);

	function fmtWhen(t: number): string {
		const d = new Date(t);
		const today = new Date();
		if (d.toDateString() === today.toDateString()) {
			return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
		}
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function startEdit() {
		draft = profile;
		profileNote = '';
		editing = true;
	}

	async function saveProfile() {
		const id = chat.detailBotId;
		if (!id || saving) return;
		saving = true;
		profileNote = '';
		const res = await fetch(`/api/bots/${id}/profile`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: draft })
		}).catch(() => null);
		saving = false;
		if (chat.detailBotId !== id) return;
		if (res?.ok) {
			profile = draft;
			editing = false;
			profileNote = 'Saved.';
		} else {
			profileNote = 'Could not save the profile.';
		}
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (chat.detailBotId) modalKeydown(e, dialogEl, close);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if bot}
	<div
		class="overlay"
		role="presentation"
		onclick={(e) => {
			// Only a click on the backdrop itself dismisses; the card stops
			// propagation, so anything inside it never reaches here.
			if (e.target === e.currentTarget) close();
		}}
	>
		<div
			class="card"
			class:frozen
			role="dialog"
			aria-modal="true"
			aria-labelledby="botcard-title"
			tabindex="-1"
			bind:this={dialogEl}
		>
			<header class="head">
				<Avatar color={bot.color} seed={bot.id} size={40} hat={bot.hat} />
				<div class="who">
					<h2 id="botcard-title">{bot.name}</h2>
					<span class="sub">{chat.presenceFor(bot.id)} · {bot.model || 'default model'}</span>
				</div>
				{#if frozen}
					<span class="frostbadge">❄ frozen — resumes in {frozenMins}m</span>
				{/if}
				<button class="x" title="Close" aria-label="Close" onclick={close}>✕</button>
			</header>

			<div class="body">
				<section>
					<h3>Company profile</h3>
					{#if editing}
						<textarea
							class="profileedit"
							rows="8"
							bind:value={draft}
							aria-label="{bot.name}'s company profile"
						></textarea>
						<div class="profilerow">
							{#if profileNote}<span class="note">{profileNote}</span>{/if}
							<button class="ghost" disabled={saving} onclick={() => (editing = false)}>Cancel</button>
							<button class="primary" disabled={saving} onclick={saveProfile}>
								{saving ? 'Saving…' : 'Save'}
							</button>
						</div>
					{:else}
						{#if profileState === 'loading'}
							<p class="empty">Reading the file…</p>
						{:else if profileState === 'error'}
							<!-- A failed read is not an empty file; mirror the offline
							     card in mobile/ChatList: what happened, and the one
							     thing that helps. -->
							<div class="state error">
								<strong>Couldn't read the profile.</strong>
								<p>The server isn't answering — this is not "no profile yet".</p>
								<button class="retry" onclick={() => loadProfile(chat.detailBotId)}>Try again</button>
							</div>
						{:else if profileState === 'none'}
							<p class="empty">No profile yet.</p>
						{:else if profile.trim()}
							<CompanyCard {bot} {profile} />
						{:else}
							<p class="empty">No profile yet.</p>
						{/if}
						{#if profileState === 'ready'}
							<div class="profilerow">
								{#if profileNote}<span class="note">{profileNote}</span>{/if}
								<button class="ghost" onclick={startEdit}>
									{profile.trim() ? 'Edit' : 'Write one'}
								</button>
							</div>
						{/if}
					{/if}
				</section>
				<section>
					<details open>
						<summary>Usage + spend</summary>
						{#if stats === 'loading'}
						<p class="empty">Reading the meter…</p>
					{:else if stats === 'error'}
						<!-- A failed fetch is not an empty ledger; said plainly with a
						     retry instead of reading as "no usage yet". -->
						<div class="state error">
							<strong>Couldn't read the meter.</strong>
							<p>The server isn't answering — this is not "no usage on record".</p>
							<button class="retry" onclick={() => loadStats(chat.detailBotId)}>Try again</button>
						</div>
					{:else if stats === 'none' || !statsData?.usage.length}
						<p class="empty">No usage on record yet.</p>
					{:else}
						<!-- Cumulative spend, so the lines read as the meter filling up.
						     Drawn by hand: a chart library for two polylines would cost more
						     than the whole card. -->
						<svg class="uchart" viewBox="0 0 300 90" preserveAspectRatio="none" aria-hidden="true">
							<line class="ugrid" x1="0" y1="86" x2="300" y2="86" />
							<polyline class="uline in" points={usagePoints('input')} />
							<polyline class="uline out" points={usagePoints('output')} />
						</svg>
						<span class="ulegend">
							<span class="ukey in">in</span>
							<span class="ukey out">out</span>
							{#if usageTotals}
								<span class="utotals">
									{shortTokens(usageTotals.input)} in · {shortTokens(usageTotals.output)} out
								</span>
							{/if}
						</span>
					{/if}
					{#if spend && (spend.lifetime !== null || spend.estimated !== null || spend.by_model.length)}
						<!-- The money behind the meter: the provider's own bill where it
						     named a price, the best known rate's estimate where it did
						     not, and the same spend split by the model that served it. -->
						<div class="spend">
							{#if spend.lifetime !== null}
								<span class="srow">
									provider's bill: {formatCost(spend.lifetime)}
								</span>
							{/if}
							{#if spend.estimated !== null}
								<span class="srow">
									estimated: {formatCost(spend.estimated)} (going rate)
								</span>
							{/if}
							{#each spend.by_model as m (m.model)}
								<span class="srow smodel">
									{m.model || 'unrecorded model'} — {m.tasks} task{m.tasks === 1 ? '' : 's'} ·
									{#if m.cost !== null}
										{formatCost(m.cost)}{#if m.estimated_cost !== null}
											&nbsp;+ {formatCost(m.estimated_cost)} est.{/if}
									{:else if m.estimated_cost !== null}
										{formatCost(m.estimated_cost)} est.
									{:else}
										not priced
									{/if}
								</span>
							{/each}
						</div>
					{/if}
					</details>
				</section>

				<section>
					<h3>Police reports</h3>
					{#if stats === 'loading'}
						<p class="empty">Reading the log…</p>
					{:else if stats === 'error'}
						<!-- Same failed read as the meter above; its Try again button
						     refetches both. -->
						<p class="empty">Couldn't read the log.</p>
					{:else if !policeRows.length}
						<p class="empty">Nothing on the record.</p>
					{:else}
						<div class="plist">
							{#each policeRows as p, i (i)}
								<div class="prow">
									<span class="pwhen">{fmtWhen(p.t)}</span>
									<span class="pkind">{p.kind}</span>
									<span class="pdetail">{p.detail}</span>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: grid;
		place-items: center;
		z-index: 60;
	}
	.card {
		width: min(30rem, calc(100vw - 2rem));
		max-height: min(38rem, calc(100vh - 3rem));
		display: flex;
		flex-direction: column;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}
	/* A frozen bot's card frosts over: cold tint and a shimmering edge. */
	.card.frozen {
		background:
			linear-gradient(rgba(140, 190, 255, 0.06), rgba(140, 190, 255, 0.06)),
			var(--bg-raised);
		border-color: rgba(150, 200, 255, 0.4);
		animation: frost-shimmer 3.2s ease-in-out infinite;
	}
	@keyframes frost-shimmer {
		0%, 100% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(150, 200, 255, 0.2); }
		50% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(150, 200, 255, 0.5), inset 0 0 22px rgba(150, 200, 255, 0.1); }
	}
	.frostbadge {
		padding: 0.18rem 0.6rem;
		border-radius: 999px;
		background: rgba(30, 50, 80, 0.85);
		border: 1px solid rgba(150, 200, 255, 0.45);
		color: #bcd8ff;
		font-size: 0.64rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.8rem 0.9rem;
		border-bottom: 1px solid var(--border);
	}
	.who {
		flex: 1;
		min-width: 0;
	}
	.who h2 {
		margin: 0;
		font-size: 1rem;
	}
	.sub {
		font-size: 0.74rem;
		color: var(--text-muted);
	}
	.x {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.85rem;
		padding: 0.3rem;
		border-radius: 0.4rem;
	}
	.x:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.body {
		overflow-y: auto;
		padding: 0.6rem 0.9rem 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	details summary {
		margin: 0 0 0.4rem;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
		cursor: pointer;
	}
	h3 {
		margin: 0 0 0.4rem;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.empty {
		margin: 0;
		font-size: 0.8rem;
		font-style: italic;
		color: var(--text-muted);
	}
	/* A failed read, not an empty one: said plainly with the one thing that
	   helps, mirroring the offline card in mobile/ChatList. */
	.state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		padding: 0.5rem 0.4rem;
		color: var(--text-muted);
		font-size: 0.8rem;
		text-align: center;
	}
	.state.error strong {
		color: var(--text);
		font-size: 0.88rem;
	}
	.state.error p {
		margin: 0;
		line-height: 1.45;
	}
	.retry {
		padding: 0.35rem 0.9rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.retry:hover {
		background: var(--bg-hover);
	}
	.profileedit {
		width: 100%;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		color: var(--text);
		font-family: inherit;
		font-size: 0.84rem;
		line-height: 1.5;
		padding: 0.5rem 0.7rem;
		resize: vertical;
	}
	.profileedit:focus {
		outline: none;
		border-color: #3d3d44;
	}
	.profilerow {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}
	.note {
		margin-right: auto;
		font-size: 0.74rem;
		color: var(--text-muted);
	}
	.ghost {
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		color: var(--text);
		font-size: 0.76rem;
		padding: 0.28rem 0.8rem;
		cursor: pointer;
	}
	.ghost:hover {
		border-color: #4a4a52;
	}
	.primary {
		background: var(--accent);
		border: none;
		border-radius: var(--r-pill);
		color: #fff;
		font-size: 0.76rem;
		padding: 0.3rem 0.9rem;
		cursor: pointer;
	}
	.primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.uchart {
		width: 100%;
		height: 6.5rem;
		display: block;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
	}
	.ugrid {
		stroke: var(--border);
		stroke-width: 1;
	}
	.uline {
		fill: none;
		stroke-width: 1.6;
	}
	.uline.in {
		stroke: #6ea8fe;
	}
	.uline.out {
		stroke: #e5489b;
	}
	.ulegend {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin-top: 0.3rem;
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	.ukey::before {
		content: '—';
		margin-right: 0.25rem;
	}
	.ukey.in::before {
		color: #6ea8fe;
	}
	.ukey.out::before {
		color: #e5489b;
	}
	.utotals {
		margin-left: auto;
	}
	.spend {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-top: 0.35rem;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	/* A per-model line indents under the totals it breaks down. */
	.smodel {
		padding-left: 0.7rem;
	}
	.plist {
		display: flex;
		flex-direction: column;
	}
	.prow {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.3rem 0.1rem;
		border-bottom: 1px solid var(--border);
		font-size: 0.78rem;
	}
	.prow:last-child {
		border-bottom: none;
	}
	.pwhen {
		flex: none;
		color: var(--text-muted);
		font-size: 0.7rem;
	}
	.pkind {
		flex: none;
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: #f0b450;
	}
	.pdetail {
		min-width: 0;
		color: var(--text);
		overflow-wrap: anywhere;
	}
</style>
