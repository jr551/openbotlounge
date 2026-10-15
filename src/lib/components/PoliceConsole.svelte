<script lang="ts">
	import { tick } from 'svelte';
	import { shortAhead } from '$lib/format';
	import { modalKeydown } from '$lib/modal';
	/**
	 * The police console: the whole of what the round knows and does, in one
	 * place. Two books - the write-ups (who was told, for what, how often) and
	 * the findings (what the patrol saw, with the line it read) - then the two
	 * things a human actually wants to do with them: pardon somebody, or turn the
	 * rules up and down. The numbers come from the API, which reads the settings
	 * in force, so the form shows what is being enforced rather than what this
	 * build shipped with.
	 */
	type Record = {
		bot_id: string;
		bot_name: string;
		offence_count: number;
		streak: number;
		last_offence_at: number;
		last_tokens: number;
		note: string;
		/** While this is in the future the bot is inside; the reason is the charge. */
		jailed_until?: number;
		jail_reason?: string;
	};
	type Alert = {
		id: string;
		bot_id: string;
		bot_name: string;
		kind: string;
		rule: string;
		summary: string;
		evidence: string;
		created_at: number;
		dismissed_at: number;
	};
	type Settings = {
		interval_hours: number;
		waste_tokens: number;
		bloat_tokens: number;
		outlier_floor: number;
		outlier_multiple: number;
		max_writes: number;
		max_alerts: number;
		write_ups: boolean;
		patrol: boolean;
		/** Whether newly written plugins, routines and group rooms go in front of the officer. */
		check_plugins: boolean;
		check_routines: boolean;
		check_wakes: boolean;
		check_rooms: boolean;
		/** How a proposed jail lands: ask first, jail outright, or never jail. */
		jail_mode: 'confirm' | 'on' | 'off';
	};

	let records = $state<Record[]>([]);
	let alerts = $state<Alert[]>([]);
	/**
	 * The creation book: every verdict the officer - or the human, overruling -
	 * left on a plugin, routine or wake. The row's verification is the record;
	 * an item never reviewed simply is not on it.
	 */
	type SignOff = {
		kind: 'plugin' | 'routine' | 'wake' | 'room';
		id: string;
		name: string;
		bot_name: string;
		verdict: 'approved' | 'rejected' | 'unreviewed';
		reason: string;
		at: number;
		attempts?: number;
		awaitingHuman?: boolean;
		by?: 'human';
		enabled: boolean;
	};
	let signOffs = $state<SignOff[]>([]);
	let nextRoundAt = $state(0);
	/**
	 * The patrol's own criteria: a regex it runs over what bots ingest and do,
	 * and the summary the alert carries when it trips. The API keeps only
	 * these fields - there is no enable flag or built-in list to show.
	 */
	type PatrolRule = {
		id: string;
		pattern: string;
		summary: string;
		created_at: number;
	};
	let patrolRules = $state<PatrolRule[]>([]);
	let ruleBusy = $state(false);
	let ruleNote = $state('');
	let newPattern = $state('');
	let newSummary = $state('');
	let rules = $state<Settings>({
		interval_hours: 12,
		waste_tokens: 20_000,
		bloat_tokens: 100_000,
		outlier_floor: 50_000,
		outlier_multiple: 3,
		max_writes: 3,
		max_alerts: 3,
		write_ups: true,
		patrol: true,
		check_plugins: true,
		check_routines: true,
		check_wakes: true,
		check_rooms: true,
		jail_mode: 'confirm'
	});
	let loaded = $state(false);
	/** What just happened, said under the buttons rather than as a toast. */
	let said = $state('');
	/**
	 * The log keeps everything, dismissals included - that is its job. The list
	 * shows what still stands, because twenty dismissed rows of the same rule
	 * reading down the page is what "the findings look strange" meant.
	 */
	let showDismissed = $state(false);
	let busy = $state('');
	/** The machine-reset queue: bots that asked for a wiped machine. */
	type Reset = {
		id: string;
		bot_id: string;
		bot_name: string;
		reason: string;
		created_at: number;
		resolved_at: number;
		resolution: string;
	};
	let resets = $state<Reset[]>([]);
	let showResolvedResets = $state(false);
	/** The officer's display name, from the API - the court's presiding judge. */
	let officer = $state('the police');
	/** The open court document, when a write-up or finding has been clicked. */
	let caseFile = $state<CaseFile | null>(null);
	let caseEl = $state<HTMLElement | null>(null);

	async function load() {
		const res = await fetch('/api/police').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		records = data.records ?? [];
		alerts = data.alerts ?? [];
		signOffs = data.sign_offs ?? [];
		nextRoundAt = data.next_round_at ?? 0;
		if (data.officer) officer = data.officer;
		if (data.settings) rules = { ...rules, ...data.settings };
		// The criteria book is its own endpoint; a failed read leaves the last list.
		void fetch('/api/police/rules')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d?.rules) patrolRules = d.rules;
			})
			.catch(() => {});
		// The reset queue is its own endpoint; a failed read leaves the last list.
		void fetch('/api/police/resets')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d?.resets) resets = d.resets;
			})
			.catch(() => {});
	}

	/**
	 * One court document serves both books: a write-up is a conviction the
	 * officer recorded, a finding is a charge the patrol filed. The fields are
	 * the same either way - who stands accused, what for, what was seen, and
	 * what the record already held.
	 */
	type CaseFile = {
		number: string;
		defendant: string;
		charge: string;
		statute: string;
		evidence: string[];
		priors: string[];
		filedAt: number;
		dismissed: boolean;
	};

	/** The docket number: the day it was filed plus the accused's name. */
	function caseNumber(at: number, name: string): string {
		const d = new Date(at);
		const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
		const who = (name || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'UNKNOWN';
		return `CASE #${day}-${who}`;
	}

	function fullDate(at: number): string {
		return new Date(at).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	/** What the log already held against this bot before the matter at hand. */
	function priorsFor(botId: string, exceptAlertId = ''): string[] {
		const priors: string[] = [];
		const record = records.find((r) => r.bot_id === botId);
		if (record?.offence_count)
			priors.push(
				`${record.offence_count} write-up${record.offence_count === 1 ? '' : 's'} on the officer's record` +
					(record.streak > 1 ? `, ${record.streak} rounds running` : '')
			);
		for (const a of alerts) {
			if (a.bot_id !== botId || a.id === exceptAlertId) continue;
			priors.push(`${fullDate(a.created_at)} - ${a.summary} (${a.rule})`);
			if (priors.length >= 6) break;
		}
		return priors;
	}

	function openRecordCase(r: Record) {
		caseFile = {
			number: caseNumber(r.last_offence_at, r.bot_name),
			defendant: r.bot_name,
			charge: r.note || 'Waste of fleet resources',
			statute: 'write-up for waste',
			evidence: [
				`${tokens(r.last_tokens)} tokens spent in the round under review`,
				`Offence recorded ${fullDate(r.last_offence_at)}`,
				`Told ${r.offence_count} time${r.offence_count === 1 ? '' : 's'}${r.streak > 1 ? `, ${r.streak} rounds running` : ''}`
			],
			priors: priorsFor(r.bot_id),
			filedAt: r.last_offence_at,
			dismissed: false
		};
		focusCase();
	}

	function openAlertCase(a: Alert) {
		caseFile = {
			number: caseNumber(a.created_at, a.bot_name),
			defendant: a.bot_name || 'a bot since gone',
			charge: a.summary,
			statute: a.rule,
			evidence: [
				a.evidence || 'the patrol noted it without quoting the line',
				`Filed ${fullDate(a.created_at)}`,
				`Kind: ${a.kind}; rule: ${a.rule}`
			],
			priors: priorsFor(a.bot_id, a.id),
			filedAt: a.created_at,
			dismissed: !!a.dismissed_at
		};
		focusCase();
	}

	/** Focus moves into the document so Escape and Tab belong to it. */
	function focusCase() {
		void tick().then(() => caseEl?.focus());
	}

	function onCaseKeydown(e: KeyboardEvent) {
		if (caseFile) modalKeydown(e, caseEl, () => (caseFile = null));
	}

	/** Enter or Space on a card opens its case, like the buttons it stands in for. */
	function cardKeydown(e: KeyboardEvent, open: () => void) {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		open();
	}
	void load();

	/** How long ago, in the console's own words. */
	function ago(at: number): string {
		const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.round(mins / 60);
		return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
	}

	function tokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
		return String(n);
	}

	async function forgive(r: Record) {
		busy = r.bot_id;
		// ok or not at all: a dead fetch must not read as "nothing on the
		// record" - that is a finding about the bot, and the network has no
		// business entering it.
		const res = await fetch('/api/police/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'forgive', bot_id: r.bot_id })
		})
			.then((x) => (x.ok ? x.json() : null))
			.catch(() => null);
		busy = '';
		said = !res
			? 'Could not reach the police.'
			: res.forgiven
				? `${r.bot_name} is off the record.`
				: `${r.bot_name} had nothing on the record.`;
		await load();
	}

	async function dismiss(a: Alert) {
		busy = a.id;
		const res = await fetch('/api/police', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ dismiss: a.id })
		}).catch(() => null);
		busy = '';
		said = res?.ok
			? 'Notice dismissed; the finding stays in the log.'
			: 'Could not dismiss that notice.';
		await load();
	}

	/**
	 * A pending jail is a finding the patrol filed and the human has to sign:
	 * confirming it dismisses the notice and puts the bot inside in one call.
	 */
	async function confirmJail(a: Alert) {
		busy = a.id;
		const res = await fetch('/api/police/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'jail', alert_id: a.id, bot_id: a.bot_id })
		}).catch(() => null);
		busy = '';
		said = res?.ok ? `${a.bot_name} is inside.` : 'Could not confirm that jail.';
		await load();
	}
	/** What a sign-off's verdict reads as on its card. */
	function signOffLabel(s: SignOff): string {
		return s.verdict === 'approved' ? 'verified' : s.verdict === 'rejected' ? 'refused' : 'unverified';
	}

	/**
	 * The human's ruling on a sign-off whose attempts ran out: the same
	 * "Approve anyway" the plugin card and routine row carry, routed by kind.
	 */
	async function approveSignOff(s: SignOff) {
		busy = s.id;
		const res = await fetch(`/api/${s.kind === 'wake' ? 'wakes' : s.kind === 'room' ? 'conversations' : `${s.kind}s`}/${s.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ approve: true })
		}).catch(() => null);
		busy = '';
		said = res?.ok ? `${s.name} is signed off.` : 'Could not record that ruling.';
		await load();
	}

	/** Let a jailed bot out early: the sentence clears, the record stays. */
	async function release(r: Record) {
		busy = r.bot_id;
		const res = await fetch('/api/police/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'release', bot_id: r.bot_id })
		}).catch(() => null);
		busy = '';
		said = res?.ok ? `${r.bot_name} is out.` : 'Could not release them.';
		await load();
	}

	/** Approve a reset: wipe the machine, keep the .md files. A 503 means the
	 *  wipe failed - the row stays pending so the ask is not lost. */
	async function approveReset(r: Reset) {
		if (!window.confirm(`Reset ${r.bot_name}'s machine? Its computer and drive are wiped; only its .md files are kept.`))
			return;
		busy = r.id;
		const res = await fetch(`/api/police/resets/${r.id}/approve`, { method: 'POST' }).catch(() => null);
		busy = '';
		if (res?.status === 503) {
			const body = await res.json().catch(() => null);
			said = `Wipe failed — the request stays pending.${body?.message ? ` (${body.message})` : ''}`;
		} else if (res?.ok) {
			const body = await res.json().catch(() => null);
			const kept: string[] = body?.kept ?? [];
			said =
				`${r.bot_name}'s machine was reset.` +
				(kept.length ? ` Kept: ${kept.join(', ')}.` : ' No .md files to keep.');
		} else {
			said = 'Could not approve that reset.';
		}
		await load();
	}

	/** Deny a reset: the machine stays as it is; the bot may ask again. */
	async function denyReset(r: Reset) {
		busy = r.id;
		const res = await fetch(`/api/police/resets/${r.id}/deny`, { method: 'POST' }).catch(() => null);
		busy = '';
		said = res?.ok ? `${r.bot_name}'s reset request was denied.` : 'Could not deny that reset.';
		await load();
	}

	/** Strike a criterion; the patrol stops reading it next round. */
	async function deleteRule(r: PatrolRule) {
		if (ruleBusy) return;
		ruleBusy = true;
		const res = await fetch('/api/police/rules', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: r.id })
		}).catch(() => null);
		ruleBusy = false;
		ruleNote = res?.ok ? '' : 'Could not strike that rule.';
		await load();
	}

	/** Write a new criterion into the book; a bad regex is the server's refusal. */
	async function addRule() {
		if (ruleBusy || !newPattern.trim()) return;
		ruleBusy = true;
		ruleNote = '';
		const res = await fetch('/api/police/rules', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pattern: newPattern.trim(), summary: newSummary.trim() })
		}).catch(() => null);
		ruleBusy = false;
		if (res?.ok) {
			newPattern = '';
			newSummary = '';
		} else {
			const body = await res?.json().catch(() => null);
			ruleNote = body?.message ?? 'Could not add that rule.';
		}
		await load();
	}

	async function saveConfig() {
		const res = await fetch('/api/settings', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				police_interval_hours: Number(rules.interval_hours),
				police_waste_tokens: Number(rules.waste_tokens),
				police_bloat_tokens: Number(rules.bloat_tokens),
				police_outlier_floor: Number(rules.outlier_floor),
				police_outlier_multiple: Number(rules.outlier_multiple),
				police_max_writes: Number(rules.max_writes),
				police_max_alerts: Number(rules.max_alerts),
				police_writeups: rules.write_ups ? 'on' : 'off',
				police_check_plugins: rules.check_plugins ? 'on' : 'off',
				police_check_routines: rules.check_routines ? 'on' : 'off',
				police_check_wakes: rules.check_wakes ? 'on' : 'off',
				police_jail_mode: rules.jail_mode
			})
		})
			.then((x) => x.json())
			.catch(() => null);
		said = res?.settings ? 'Rules saved. They apply from the next round.' : 'Could not save the rules.';
		await load();
	}
</script>

<svelte:window onkeydown={onCaseKeydown} />

<div class="console">
	<p class="hint">
		The police review the fleet's messages, activity and spend every {rules.interval_hours}h.
		Next round {nextRoundAt ? shortAhead(nextRoundAt) : 'when the clock turns'}.
	</p>

	<section>
		<h3>Duties</h3>
		<label class="row">
			<span>Write-ups for waste</span>
			<button class="tog" class:on={rules.write_ups} onclick={() => (rules.write_ups = !rules.write_ups)}>
				{rules.write_ups ? 'On' : 'Off'}
			</button>
		</label>
		<label class="row">
			<span>Security patrol</span>
			<button class="tog" class:on={rules.patrol} onclick={() => (rules.patrol = !rules.patrol)}>
				{rules.patrol ? 'On' : 'Off'}
			</button>
		</label>
		<label class="row">
			<span>Check new plugins</span>
			<button
				class="tog"
				class:on={rules.check_plugins}
				onclick={() => (rules.check_plugins = !rules.check_plugins)}
			>
				{rules.check_plugins ? 'On' : 'Off'}
			</button>
		</label>
		<label class="row">
			<span>Check new routines</span>
			<button
				class="tog"
				class:on={rules.check_routines}
				onclick={() => (rules.check_routines = !rules.check_routines)}
			>
				{rules.check_routines ? 'On' : 'Off'}
			</button>
		</label>
		<label class="row">
			<span>Check new wakes</span>
			<button
				class="tog"
				class:on={rules.check_wakes}
				onclick={() => (rules.check_wakes = !rules.check_wakes)}
			>
				{rules.check_wakes ? 'On' : 'Off'}
			</button>
		</label>
		<label class="row">
			<span>Check new group chats</span>
			<button
				class="tog"
				class:on={rules.check_rooms}
				onclick={() => (rules.check_rooms = !rules.check_rooms)}
			>
				{rules.check_rooms ? 'On' : 'Off'}
			</button>
		</label>
		<label class="row">
			<span>Jailing</span>
			<select bind:value={rules.jail_mode} aria-label="Jailing">
				<option value="confirm">Ask first</option>
				<option value="on">On</option>
				<option value="off">Off</option>
			</select>
		</label>
	</section>

	<section>
		<h3>Rules</h3>
		<div class="grid">
			<label>Round every (hours)<input type="number" min="1" bind:value={rules.interval_hours} /></label>
			<label>Wasted tokens on one failed task<input type="number" min="1" bind:value={rules.waste_tokens} /></label>
			<label>Spend with nothing finished<input type="number" min="1" bind:value={rules.bloat_tokens} /></label>
			<label>Outlier floor (tokens)<input type="number" min="1" bind:value={rules.outlier_floor} /></label>
			<label>Outlier multiple of the median<input type="number" min="1" step="0.5" bind:value={rules.outlier_multiple} /></label>
			<label>Most write-ups a round<input type="number" min="0" bind:value={rules.max_writes} /></label>
			<label>Most findings a round<input type="number" min="0" bind:value={rules.max_alerts} /></label>
		</div>
		<button class="primary" onclick={saveConfig}>Save rules</button>
	</section>

	<section>
		<h3>Review criteria</h3>
		<p class="hint">
			What the patrol watches for, in its own words. Built-ins can be switched
			off but not edited; customs are yours - a name and what to watch for.
		</p>
		{#if patrolRules.length}
			<div class="list">
				{#each patrolRules as r (r.id)}
					<div class="card rule">
						<div class="head">
							<strong>{r.summary || r.pattern}</strong>
							<span class="ruleacts">
								<button class="ghost" disabled={ruleBusy} onclick={() => deleteRule(r)}>Strike</button>
							</span>
						</div>
						{#if r.summary}<p class="meta"><code>{r.pattern}</code></p>{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="empty">The rulebook is empty.</p>
		{/if}
		<div class="addrule">
			<input
				bind:value={newPattern}
				placeholder="Watch for… (a regular expression)"
				aria-label="What the rule watches for"
			/>
			<input
				bind:value={newSummary}
				placeholder="What the alert says"
				aria-label="Alert summary"
			/>
			<button
				class="primary"
				disabled={ruleBusy || !newPattern.trim()}
				onclick={addRule}
			>
				Add rule
			</button>
		</div>
		{#if ruleNote}<p class="said">{ruleNote}</p>{/if}
	</section>

	<h3>
		Machine resets
		<span class="count">{resets.filter((r) => !r.resolved_at).length} pending</span>
		{#if resets.some((r) => r.resolved_at)}
			<button class="linky" onclick={() => (showResolvedResets = !showResolvedResets)}>
				{showResolvedResets ? 'hide resolved' : `show resolved (${resets.filter((r) => r.resolved_at).length})`}
			</button>
		{/if}
	</h3>
	{#if !resets.length}
		<p class="empty">No machine has been asked for.</p>
	{:else}
		<div class="list">
			{#each (showResolvedResets ? resets : resets.filter((r) => !r.resolved_at)) as r (r.id)}
				<div class="card" class:settled={!!r.resolved_at}>
					<div class="head">
						<strong>{r.bot_name}</strong>
						<span class="when">{ago(r.created_at)}</span>
						{#if r.resolved_at}
							<span class="state">{r.resolution} · {ago(r.resolved_at)}</span>
						{/if}
					</div>
					<p class="detail">{r.reason}</p>
					{#if !r.resolved_at}
						<div class="ractions">
							<button class="primary" disabled={busy === r.id} onclick={() => approveReset(r)}>
								{busy === r.id ? 'Resetting…' : 'Approve'}
							</button>
							<button class="ghost" disabled={busy === r.id} onclick={() => denyReset(r)}>
								Deny
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<h3>Write-ups <span class="count">{records.length}</span></h3>
	{#if !loaded}
		<p class="empty">Reading the log…</p>
	{:else if !records.length}
		<p class="empty">No offences on the record; the fleet is behaving.</p>
	{:else}
		<div class="list">
			{#each records as r (r.bot_id)}
				<div
					class="card clickable"
					role="button"
					tabindex="0"
					title="Open the case"
					onclick={() => openRecordCase(r)}
					onkeydown={(e) => cardKeydown(e, () => openRecordCase(r))}
				>
					<div class="head">
						<strong>{r.bot_name}</strong>
						<span class="when">{ago(r.last_offence_at)}</span>
						<span class="badge">told {r.offence_count}×{r.streak > 1 ? `, ${r.streak} rounds running` : ''}</span>
						<span class="open-hint">case →</span>
					</div>
					<p class="detail">{r.note || 'no note'}</p>
					<p class="meta">
						{tokens(r.last_tokens)} tokens that round
						{#if r.jailed_until && r.jailed_until > Date.now()}
							· in jail{r.jail_reason ? ` - ${r.jail_reason}` : ''}
						{/if}
					</p>
					{#if r.jailed_until && r.jailed_until > Date.now()}
						<button
							class="ghost"
							disabled={busy === r.bot_id}
							onclick={(e) => {
								e.stopPropagation();
								release(r);
							}}
						>
							{busy === r.bot_id ? 'Releasing…' : 'Release'}
						</button>
					{/if}
					<button
						class="ghost"
						disabled={busy === r.bot_id}
						onclick={(e) => {
							e.stopPropagation();
							forgive(r);
						}}
					>
						{busy === r.bot_id ? 'Pardoning…' : 'Forgive'}
					</button>
				</div>
			{/each}
		</div>
	{/if}

	<h3>
		Findings <span class="count">{alerts.filter((a) => !a.dismissed_at).length} open</span>
		{#if alerts.some((a) => a.dismissed_at)}
			<button class="linky" onclick={() => (showDismissed = !showDismissed)}>
				{showDismissed ? 'hide dismissed' : `show dismissed (${alerts.filter((a) => a.dismissed_at).length})`}
			</button>
		{/if}
	</h3>
	{#if !alerts.length}
		<p class="empty">Nothing has tripped a rule.</p>
	{:else}
		<div class="list">
			{#each (showDismissed ? alerts : alerts.filter((a) => !a.dismissed_at)).slice(0, 40) as a (a.id)}
				<div
					class="card clickable"
					class:settled={!!a.dismissed_at}
					role="button"
					tabindex="0"
					title="Open the case"
					onclick={() => openAlertCase(a)}
					onkeydown={(e) => cardKeydown(e, () => openAlertCase(a))}
				>
					<div class="head">
						<strong>{a.bot_name}</strong>
						<span class="when">{ago(a.created_at)}</span>
						<span class="badge">{a.rule}</span>
						<span class="state">{a.dismissed_at ? 'dismissed' : 'standing'}</span>
					</div>
					<p class="detail">{a.summary}</p>
					<p class="meta">{a.evidence}</p>
					{#if !a.dismissed_at}
						<div class="ractions">
							{#if a.rule === 'jail-pending' || a.kind === 'jail'}
								<!-- A proposed jail waits for a signature: confirming it
								     dismisses the notice and puts the bot inside in one call. -->
								<button
									class="primary"
									disabled={busy === a.id}
									onclick={(e) => {
										e.stopPropagation();
										confirmJail(a);
									}}
								>
									{busy === a.id ? 'Jailing…' : 'Confirm jail'}
								</button>
							{/if}
							<button
								class="ghost"
								disabled={busy === a.id}
								onclick={(e) => {
									e.stopPropagation();
									dismiss(a);
								}}
							>
								{busy === a.id ? 'Dismissing…' : 'Dismiss'}
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if !showDismissed && alerts.every((a) => a.dismissed_at) && alerts.length}
		<p class="empty">Nothing standing; every finding has been seen and dismissed.</p>
	{/if}

	<h3>Sign-offs <span class="count">{signOffs.length}</span></h3>
	{#if !loaded}
		<p class="empty">Reading the book…</p>
	{:else if !signOffs.length}
		<p class="empty">Nothing has been in front of the officer yet.</p>
	{:else}
		<div class="list">
			{#each signOffs.slice(0, 40) as s (`${s.kind}:${s.id}`)}
				<div class="card" class:settled={s.verdict === 'approved'}>
					<div class="head">
						<strong>{s.name}</strong>
						<span class="when">{ago(s.at)}</span>
						<span class="badge">{s.kind}</span>
						<span
							class="state"
							class:refused={s.verdict === 'rejected'}
							class:unverified={s.verdict === 'unreviewed'}
						>
							{signOffLabel(s)}{s.by === 'human' ? ' · by you' : ''}{s.enabled ? '' : ' · off'}
						</span>
					</div>
					<p class="detail">{s.reason}</p>
					<p class="meta">
						{s.bot_name}
						{#if s.attempts} · attempt {s.attempts}{/if}
					</p>
					{#if s.verdict === 'rejected' && s.awaitingHuman}
						<div class="ractions">
							<button
								class="primary"
								disabled={busy === s.id}
								title="The bot used up its attempts - sign this off yourself"
								onclick={() => approveSignOff(s)}
							>
								{busy === s.id ? 'Signing…' : 'Approve anyway'}
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if said}<p class="said">{said}</p>{/if}
</div>

{#if caseFile}
	<div
		class="case-overlay"
		role="presentation"
		onclick={(e) => {
			// Only a click on the backdrop itself dismisses; the document stops
			// propagation, so anything inside it never reaches here.
			if (e.target === e.currentTarget) caseFile = null;
		}}
	>
		<div
			class="case-doc"
			role="dialog"
			aria-modal="true"
			aria-labelledby="case-title"
			tabindex="-1"
			bind:this={caseEl}
		>
			<div class="stamp" class:dismissed={caseFile.dismissed}>
				{caseFile.dismissed ? 'Case dismissed' : 'Guilty'}
			</div>
			<header class="case-head">
				<p class="court">OpenBotLounge Municipal Court</p>
				<p class="court-sub">Fleet Division - Night Session</p>
				<p class="case-no">{caseFile.number}</p>
			</header>
			<h2 id="case-title" class="vs">THE PEOPLE <span>vs</span> {caseFile.defendant}</h2>
			<dl class="case-rows">
				<dt>Charge</dt>
				<dd>{caseFile.charge} <span class="statute">({caseFile.statute})</span></dd>
				<dt>Evidence</dt>
				<dd>
					{#each caseFile.evidence as line (line)}
						<p class="exhibit">{line}</p>
					{/each}
				</dd>
				<dt>Prior record</dt>
				<dd>
					{#if caseFile.priors.length}
						{#each caseFile.priors as line (line)}
							<p class="exhibit">{line}</p>
						{/each}
					{:else}
						<p class="exhibit">First offence; the record was clean.</p>
					{/if}
				</dd>
			</dl>
			<footer class="case-foot">
				<p>Presiding: <strong>{officer}</strong>, officer of the watch</p>
				<p class="filed">Filed {fullDate(caseFile.filedAt)}</p>
			</footer>
			<button class="case-x" title="Close" aria-label="Close" onclick={() => (caseFile = null)}>✕</button>
		</div>
	</div>
{/if}

<style>
	.console {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	select {
		background: var(--bg-input, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		color: var(--text);
		padding: 0.25rem 0.4rem;
		font: inherit;
		font-size: 0.78rem;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	h3 {
		margin: 0.6rem 0 0;
		font-size: 0.82rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	.count {
		font-size: 0.72rem;
		opacity: 0.75;
		text-transform: none;
		letter-spacing: 0;
	}
	.hint {
		margin: 0;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.4rem;
	}
	label,
	.grid label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.76rem;
		color: var(--text-muted);
	}
	input {
		background: var(--bg-input, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		color: var(--text);
		padding: 0.3rem 0.45rem;
		font: inherit;
	}
	.row {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}
	.tog {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-muted);
		border-radius: 999px;
		padding: 0.15rem 0.7rem;
		font: inherit;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.tog.on {
		color: #cfe0ff;
		border-color: #1e3a8a;
		background: rgba(30, 58, 138, 0.35);
	}
	.primary {
		align-self: flex-start;
		background: #1e3a8a;
		border: 1px solid #2b4aa5;
		color: #dce8ff;
		border-radius: 0.4rem;
		padding: 0.3rem 0.8rem;
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}
	.ghost {
		align-self: flex-start;
		background: transparent;
		border: 1px solid rgba(30, 58, 138, 0.6);
		color: #9db6ee;
		border-radius: 0.4rem;
		padding: 0.2rem 0.6rem;
		font: inherit;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.ghost:hover:not(:disabled) {
		background: rgba(30, 58, 138, 0.22);
	}
	.ghost:disabled {
		opacity: 0.5;
		cursor: default;
	}
	/* A rule row's controls sit on the right of its name. */
	.ruleacts {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	/* The action buttons inside a card sit in a row. */
	.ractions {
		display: flex;
		gap: 0.4rem;
	}
	/* The add-a-rule row under the book. */
	.addrule {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	.addrule input {
		flex: 1;
		min-width: 0;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		border: 1px solid var(--border);
		border-left: 3px solid #1e3a8a;
		border-radius: 0.45rem;
		padding: 0.5rem 0.6rem;
		background: rgba(30, 58, 138, 0.08);
	}
	.card.settled {
		opacity: 0.6;
		border-left-color: var(--border);
		background: transparent;
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		flex-wrap: wrap;
	}
	.head strong {
		font-size: 0.82rem;
	}
	.when {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.badge {
		font-size: 0.68rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px solid rgba(30, 58, 138, 0.55);
		color: #a9c0f2;
	}
	.state {
		font-size: 0.68rem;
		color: var(--text-muted);
		margin-left: auto;
	}
	.state.refused {
		color: #e8a0a0;
	}
	.state.unverified {
		color: #e8c98a;
	}
	.detail {
		margin: 0;
		font-size: 0.78rem;
	}
	.meta {
		margin: 0;
		font-size: 0.72rem;
		color: var(--text-muted);
		word-break: break-word;
	}
	.empty {
		margin: 0;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.linky {
		margin-left: 0.4rem;
		background: none;
		border: none;
		padding: 0;
		color: #9db6ee;
		font: inherit;
		font-size: 0.7rem;
		text-transform: none;
		letter-spacing: 0;
		cursor: pointer;
		text-decoration: underline;
	}
	.said {
		margin: 0.2rem 0 0;
		font-size: 0.76rem;
		color: #a9c0f2;
	}
	.clickable {
		cursor: pointer;
	}
	.clickable:hover {
		border-color: rgba(30, 58, 138, 0.8);
	}
	.clickable:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.open-hint {
		margin-left: auto;
		font-size: 0.68rem;
		color: var(--text-muted);
		opacity: 0;
	}
	.clickable:hover .open-hint,
	.clickable:focus-visible .open-hint {
		opacity: 1;
	}

	/* The court document is paper no matter the app's theme: it carries its
	   own ink and stock rather than borrowing the surrounding palette, so it
	   reads the same over a dark or a light console. */
	.case-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: grid;
		place-items: center;
		z-index: 60;
	}
	.case-doc {
		position: relative;
		width: min(560px, 92vw);
		max-height: 85dvh;
		overflow-y: auto;
		padding: 1.6rem 1.8rem 1.3rem;
		background: #f4ecd9;
		background-image: repeating-linear-gradient(
			0deg,
			transparent 0 26px,
			rgba(120, 100, 60, 0.07) 26px 27px
		);
		color: #2b2418;
		border: 1px solid #cbbfa4;
		border-radius: 0.2rem;
		box-shadow:
			0 1.5rem 3.5rem rgba(0, 0, 0, 0.55),
			inset 0 0 4rem rgba(160, 140, 90, 0.18);
		font-family: Georgia, 'Times New Roman', serif;
	}
	.case-doc:focus-visible {
		outline: none;
	}
	.case-head {
		text-align: center;
		border-bottom: 2px solid #2b2418;
		padding-bottom: 0.6rem;
	}
	.court {
		margin: 0;
		font-size: 1.05rem;
		font-weight: bold;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.court-sub {
		margin: 0.15rem 0 0;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #6b5d43;
	}
	.case-no {
		margin: 0.5rem 0 0;
		font-family: 'Courier New', monospace;
		font-size: 0.78rem;
		letter-spacing: 0.06em;
	}
	.vs {
		margin: 0.9rem 0 0.8rem;
		text-align: center;
		font-size: 1.15rem;
		letter-spacing: 0.04em;
	}
	.vs span {
		font-style: italic;
		font-size: 0.85rem;
		color: #6b5d43;
	}
	.case-rows {
		margin: 0;
		display: grid;
		grid-template-columns: 7.5rem 1fr;
		gap: 0.45rem 0.9rem;
	}
	.case-rows dt {
		font-size: 0.7rem;
		font-weight: bold;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: #6b5d43;
		padding-top: 0.1rem;
	}
	.case-rows dd {
		margin: 0;
		font-size: 0.85rem;
	}
	.statute {
		font-size: 0.72rem;
		color: #6b5d43;
		font-family: 'Courier New', monospace;
	}
	.exhibit {
		margin: 0 0 0.3rem;
		word-break: break-word;
	}
	.exhibit:last-child {
		margin-bottom: 0;
	}
	.case-foot {
		margin-top: 1.1rem;
		padding-top: 0.6rem;
		border-top: 1px solid #b3a482;
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		flex-wrap: wrap;
		font-size: 0.78rem;
	}
	.case-foot p {
		margin: 0;
	}
	.filed {
		font-family: 'Courier New', monospace;
		font-size: 0.72rem;
		color: #6b5d43;
	}
	.case-x {
		position: absolute;
		top: 0.6rem;
		right: 0.7rem;
		background: none;
		border: none;
		color: #6b5d43;
		cursor: pointer;
		font-size: 0.95rem;
	}
	/* The verdict stamp: inked, off-square, and a little rough at the edges. */
	.stamp {
		position: absolute;
		top: 42%;
		left: 50%;
		transform: translate(-50%, -50%) rotate(-14deg);
		padding: 0.35rem 1.4rem;
		border: 4px double #a11d1d;
		border-radius: 0.3rem;
		color: #a11d1d;
		font-family: 'Courier New', monospace;
		font-size: 2rem;
		font-weight: bold;
		letter-spacing: 0.35em;
		text-transform: uppercase;
		opacity: 0.82;
		pointer-events: none;
		mask-image: repeating-linear-gradient(
			47deg,
			#000 0 3px,
			rgba(0, 0, 0, 0.72) 3px 5px,
			#000 5px 9px
		);
	}
	.stamp.dismissed {
		border-color: #6f6f6f;
		color: #6f6f6f;
		font-size: 1.3rem;
		letter-spacing: 0.22em;
	}
</style>
