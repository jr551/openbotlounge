<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import Avatar from './Avatar.svelte';
	import BotDetail from './BotDetail.svelte';
	import { bloatOf } from '$lib/bloat';
	import { conversationName, conversationSnippet, isLounge, isPoliceContact, isVisibleConversation, shortTime } from '$lib/conversation-list';
	import type { Conversation } from '$lib/types';

	let {
		open = $bindable(false),
		onPalette,
		onMarketplace,
		onSettings
	}: {
		open?: boolean;
		onPalette: () => void;
		onMarketplace: () => void;
		onSettings: () => void;
	} = $props();

	let query = $state('');

	// Collapsed rail: persisted, desktop only. Mobile overlay ignores it.
	let collapsed = $state(false);
	$effect(() => {
		try {
			const v = localStorage.getItem('sidebarCollapsed');
			if (v === '1') collapsed = true;
			if (v === '0') collapsed = false;
		} catch {}
	});
	$effect(() => {
		try {
			localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
		} catch {}
	});

	// The naming and preview rules are shared with the phone's chat list, which
	// shows the same rows - one answer to "what is this conversation called".
	const displayName = (c: Conversation) => conversationName(c, chat.conversationBots(c));

	// Bot-to-bot private groups (pair rooms like "Testy ⇄ cakey") are plumbing:
	// their turns surface as grey relay lines inside each participant's DM,
	// so the room itself is hidden. The Lounge (private group titled 'Lounge')
	// is the only private group the human is meant to open.
	const baseVisible = $derived(chat.conversations.filter(isVisibleConversation));

	const filtered = $derived(
		query.trim()
			? baseVisible.filter((c) =>
					displayName(c).toLowerCase().includes(query.trim().toLowerCase())
				)
			: baseVisible
	);

	const snippet = (c: Conversation) => conversationSnippet(c, chat.conversationBots(c));

	// Group rooms - and the bots' private lounge with them - tuck away into a
	// shelf at the bottom of the list that opens when you reach for it, the
	// same reveal the lounge's speak-as composer uses. A search shows
	// everything flat: hiding a match you just typed would be broken.
	const searching = $derived(!!query.trim());
	// The police is a contact, but it is a system bot rather than one of the
	// human's own: it belongs on the shelf with the rooms, not in the list of
	// people they talk to. It stays reachable - the shelf opens on hover, focus
	// or a click - and a search still shows it flat, like everything else.
	const shown = $derived(
		searching
			? filtered
			: filtered.filter(
					(c) => c.kind === 'direct' && !isPoliceContact(c, chat.conversationBots(c))
				)
	);
	// After the visible filter, tucked is only human groups + Lounge; bot-only
	// pair rooms are already gone, so the shelf no longer duplicates plumbing.
	const tucked = $derived(
		searching
			? []
			: filtered.filter(
					(c) => c.kind !== 'direct' || isPoliceContact(c, chat.conversationBots(c))
				)
	);

	/** The shelf opens under the pointer, under keyboard focus, when pinned by
	 *  a click, while the room you're in lives inside it, and while a bot's
	 *  ask is still waiting on the human - the police's chat is in the shelf,
	 *  so a pending ask pops it out rather than hiding the card. */
	let tuckHover = $state(false);
	let tuckPinned = $state(false);
	let tuckFocus = $state(false);
	const tuckOpen = $derived(
		tuckHover || tuckPinned || tuckFocus || tucked.some((c) => c.id === chat.activeId) || chat.asks.length > 0
	);

	/** New messages in tucked rooms surface on the collapsed bar, never silently. */
	const tuckedUnread = $derived(
		tucked.reduce((n, c) => n + (c.id !== chat.activeId ? (c.unread ?? 0) : 0), 0)
	);
	const tuckedPinged = $derived(tucked.some((c) => c.pinged && c.id !== chat.activeId));

	/** Focus leaving the shelf entirely closes it again. */
	function shelfBlur(e: FocusEvent) {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
			tuckFocus = false;
		}
	}

	/**
	 * Cold storage: archived bots keep their rows but leave every picker. They
	 * are read off `bots` rather than `visibleBots`, so they still show here if
	 * the visible list ever learns to hide them itself.
	 */
	const cold = $derived(chat.bots.filter((b) => !b.hidden && b.archived));

	/** Rate-limited bots show a snowflake until paused_until passes; a small
	 *  clock keeps the "resumes in Xm" honest between store polls. */
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	const frozenBot = (c: Conversation) =>
		chat.conversationBots(c).find((b) => (b.paused_until ?? 0) > now);
	const frozenMins = (until: number) => Math.max(1, Math.ceil((until - now) / 60_000));

	/** Bring a bot back from cold storage; the row disappears from this list. */
	async function restore(id: string) {
		await chat.updateBot(id, { archived: false });
	}
</script>

<button class="scrim" class:open aria-label="Close conversations" onclick={() => (open = false)}></button>
<aside class:open class:collapsed>
	<div class="railhead">
		<button
			class="collapse-btn"
			aria-label={collapsed ? 'Expand conversations' : 'Collapse conversations'}
			aria-expanded={!collapsed}
			title={collapsed ? 'Expand' : 'Collapse'}
			onclick={() => (collapsed = !collapsed)}
		>
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/><path d="m14 9 3 3-3 3"/></svg>
		</button>
		{#if !collapsed}
			<span class="railtitle">Chats</span>
		{/if}
	</div>
	<div class="search">
		<input placeholder="Search" aria-label="Search chats" bind:value={query} />
	</div>

	<button class="newchat" onclick={() => { onPalette(); open = false; }}>
		<span class="plusicon">+</span> {#if !collapsed}New Bot{/if}
	</button>

	<!-- One row shape for the main list and the tucked shelf alike. -->
	{#snippet convoRow(c: Conversation)}
		{@const bots = chat.conversationBots(c)}
		{@const ind = chat.indicatorFor(c.id)}
		<div
			class="item"
			class:active={c.id === chat.activeId}
			class:lounge={isLounge(c)}
			class:pinged={!!c.pinged && c.id !== chat.activeId}
			class:typing={!!ind}
			role="button"
			tabindex="0"
			onclick={() => {
				void chat.select(c.id);
				open = false;
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					void chat.select(c.id);
					open = false;
				}
			}}
		>
			{#if isLounge(c)}
				<span class="sofa" title="Bots' private lounge">🛋️</span>
			{:else if c.kind === 'direct' && bots[0]}
				<Avatar
					color={bots[0].color}
					seed={bots[0].id}
					size={34}
					hat={bots[0].hat}
					bloat={bloatOf(bots[0])}
					activity={chat.activityKindFor(bots[0].id)}
					usage={bots[0]}
				/>
			{:else if bots.length}
				<span class="group-avatars">
					{#each bots.slice(0, 2) as b}
						<Avatar
							color={b.color}
							seed={b.id}
							size={22}
							hat={b.hat}
							bloat={bloatOf(b)}
							activity={chat.activityKindFor(b.id)}
						/>
					{/each}
				</span>
			{:else}
				<span class="group-avatars"></span>
			{/if}
			{#if collapsed && ind}
				<span class="rail-dot" class:acting={ind.kind === 'acting'} title={ind.label} aria-label={ind.label}></span>
			{/if}
			<span class="meta">
				<span class="row1">
					<span class="name">
						{displayName(c)}
						{#if isPoliceContact(c, bots)}
							<span class="helptag" title="the police — your help bot, here to serve you">help bot</span>
						{/if}
						{#if isPoliceContact(c, bots) && chat.asks.length}
							<span class="asktag" title="{chat.asks.length} request{chat.asks.length === 1 ? '' : 's'} waiting for you">🛠 {chat.asks.length}</span>
						{/if}
						{#if bots[0]?.badge}<span class="badge">{bots[0].badge}</span>{/if}
						{#if frozenBot(c)}
							<span
								class="frozen"
								title={`frozen — resumes in ${frozenMins(frozenBot(c)!.paused_until!)}m`}
								aria-label={`frozen — resumes in ${frozenMins(frozenBot(c)!.paused_until!)}m`}
							>❄</span>
						{/if}
					</span>
					{#if c.kind === 'group' && !isLounge(c)}
						<!-- Group rooms close down from the list: the ✕ deletes the room
						     outright - its messages go with it, so it is only offered on
						     rooms, never a bot's own DM. -->
						<button
							class="convx"
							title="Delete this group chat"
							aria-label="Delete {displayName(c)}"
							onclick={(e) => {
								e.stopPropagation();
								void chat.deleteConversation(c.id);
							}}
						>✕</button>
					{:else if c.unread && c.id !== chat.activeId}
						<span
							class="unread"
							class:ping={!!c.pinged}
							role="status"
							aria-label={c.pinged ? 'Asked for you' : 'New messages'}
							title={c.pinged ? 'asked for you' : 'new'}
						></span>
					{:else}
						<span class="time">{shortTime(c.updated_at)}</span>
					{/if}
				</span>
				{#if ind}
					<span class="row2 typingrow" class:acting={ind.kind === 'acting'}>
						{#if ind.kind === 'acting'}
							<svg class="toolicon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.2-3.2a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0Z"/><path d="M3 21 8.5 15.5"/><path d="M12 11 7 16"/></svg>
							acting…
						{:else}
							<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> {ind.label}
						{/if}
					</span>
				{:else}
					<span class="row2">{snippet(c)}</span>
				{/if}
			</span>
		</div>
	{/snippet}

	<nav class="list">
		{#each shown as c (c.id)}
			{@render convoRow(c)}
		{/each}

		{#if tucked.length}
			<!-- Group rooms and the bots' lounge sit on a shelf at the bottom of
			     the list that opens when you reach for it - hover, Tab, or a
			     click to pin it - the same reveal the lounge's speak-as
			     composer uses. Unread inside is counted on the bar so a hidden
			     room never hides new messages. -->
			<div
				class="tucked"
				class:open={tuckOpen}
				role="group"
				aria-label="Group chats and the bots' lounge"
				onmouseenter={() => (tuckHover = true)}
				onmouseleave={() => (tuckHover = false)}
				onfocusin={() => (tuckFocus = true)}
				onfocusout={shelfBlur}
				onkeydown={(e) => e.key === 'Escape' && (tuckPinned = false)}
			>
				<button
					class="tuckbar"
					aria-expanded={tuckOpen}
					title="Group chats and the bots' lounge - hover or press to peek"
					onclick={() => (tuckPinned = !tuckPinned)}
				>
					<span class="tuckgrip" aria-hidden="true"></span>
					<span class="tucklabel">More rooms</span>
					{#if tuckedUnread || tuckedPinged}
						<span
							class="tuckcount"
							class:ping={tuckedPinged}
							title="New messages in the tucked-away rooms"
						>
							{tuckedPinged && !tuckedUnread ? '!' : tuckedUnread}
						</span>
					{/if}
				</button>
				<div class="tuckrows" inert={!tuckOpen}>
					<div class="tuckinner">
						{#each tucked as c (c.id)}
							{@render convoRow(c)}
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</nav>

	{#if cold.length}
		<div class="cold">
			<span class="coldhead">Cold storage</span>
			{#each cold as b (b.id)}
				<div class="coldrow">
					<Avatar color={b.color} seed={b.id} size={22} hat={b.hat} />
					<button class="coldname" title="Open {b.name}'s card" onclick={() => (chat.detailBotId = b.id)}>{b.name}</button>
					<button class="restore" onclick={() => restore(b.id)}>Restore</button>
				</div>
			{/each}
		</div>
	{/if}

	<div class="foot">
		<button class="market" onclick={() => { onMarketplace(); open = false; }}>
			<svg class="gridic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
			{#if !collapsed}Marketplace{/if}
		</button>
		<button class="market" onclick={() => { onSettings(); open = false; }} title="Settings">
			<svg class="gear" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1 1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33Z"/></svg>
			{#if !collapsed}Settings{/if}
		</button>
		<div class="user">
			<span class="dot"></span> {#if !collapsed}You{/if}
		</div>
	</div>
</aside>

<!-- The bot card lives on the shell so a name click anywhere - a thread line,
     the screen's caption - opens the same dialog. -->
<BotDetail />

<style>
	aside {
		display: flex;
		flex-direction: column;
		width: 300px;
		min-width: 300px;
		height: 100dvh;
		background: #0d0d0f;
		border-right: 1px solid var(--border);
		/* Secondary lines read a step lighter than --text-muted for legibility. */
		--text-dim: #a9a9b3;
		transition: width 0.22s ease, min-width 0.22s ease;
	}
	aside.collapsed {
		width: 56px;
		min-width: 56px;
	}
	aside.collapsed .search { display: none; }
	aside.collapsed .newchat { justify-content: center; padding: 0.55rem; }
	aside.collapsed .item { justify-content: center; padding: 0.45rem; position: relative; }
	aside.collapsed .meta { display: none; }
	aside.collapsed .cold { display: none; }
	aside.collapsed .tucked { display: none; }
	aside.collapsed .foot .market { justify-content: center; }
	aside.collapsed .foot .user { justify-content: center; }
	aside.collapsed .railtitle { display: none; }
	/* The tap-outside dismiss target for the overlay rail; inert on desktop. */
	.scrim {
		display: none;
		position: fixed;
		inset: 0;
		border: none;
		padding: 0;
		background: rgba(0, 0, 0, 0.45);
		z-index: 34;
		cursor: default;
	}
	/* Below 700px the rail leaves the layout entirely and slides in over the
	   thread when toggled. Collapsed is ignored there: the overlay is always
	   full width so content remains reachable. */
	@media (max-width: 700px) {
		aside {
			position: fixed;
			left: 0;
			top: 0;
			z-index: 35;
			transform: translateX(-100%);
			visibility: hidden;
			transition:
				transform 0.2s ease,
				visibility 0s 0.2s;
			box-shadow: 12px 0 32px rgba(0, 0, 0, 0.45);
		}
		aside.collapsed {
			width: 300px;
			min-width: 300px;
		}
		aside.collapsed .search { display: flex; }
		aside.collapsed .meta { display: flex; }
		aside.collapsed .cold { display: block; }
		aside.collapsed .tucked { display: block; }
		aside.collapsed .foot .market { justify-content: flex-start; }
		aside.collapsed .foot .user { justify-content: flex-start; }
		aside.open {
			transform: none;
			visibility: visible;
			transition: transform 0.2s ease;
		}
		.scrim.open {
			display: block;
		}
	}
	@media (max-width: 700px) and (prefers-reduced-motion: reduce) {
		aside {
			transition: visibility 0s 0s;
		}
	}
	.railhead {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem 0.2rem;
	}
	.collapse-btn {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		flex: none;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.45rem;
		color: var(--text-muted);
		cursor: pointer;
	}
	.collapse-btn:hover, .collapse-btn:focus-visible {
		color: var(--text);
		border-color: #3d3d44;
		outline: none;
	}
	.railtitle {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-muted);
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.search {
		display: flex;
		padding: 0.4rem 0.8rem 0.4rem;
	}
	.search input {
		flex: 1;
		padding: 0.45rem 0.7rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		color: var(--text);
		font-size: 0.88rem;
	}
	.search input:focus {
		outline: none;
		border-color: #3d3d44;
	}
	.newchat {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.3rem 0.8rem 0.6rem;
		padding: 0.55rem 0.7rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		color: var(--text);
		font-size: 0.9rem;
		cursor: pointer;
	}
	.newchat:hover {
		background: var(--bg-hover);
	}
	.plusicon {
		display: grid;
		place-items: center;
		width: 1.3rem;
		height: 1.3rem;
		border: 1px solid var(--border);
		border-radius: 50%;
		font-size: 0.9rem;
	}
	.list {
		flex: 1;
		overflow-y: auto;
		padding: 0.3rem 0.5rem;
		/* Column so the tucked shelf can pin itself to the bottom edge. */
		display: flex;
		flex-direction: column;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		padding: 0.55rem;
		background: none;
		border: none;
		border-radius: 0.6rem;
		cursor: pointer;
		text-align: left;
		flex: none;
		position: relative;
	}
	.item.pinged {
		background: rgba(80, 140, 255, 0.07);
	}
	.item.pinged .name {
		color: #cfe1ff;
	}
	.item.typing .row2.typingrow { color: #ff8fb0; }
	.unread {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: #4f8ef7;
		flex: none;
		/* Centre on the title line and keep a consistent inset from the edge. */
		align-self: center;
		margin-right: 0.2rem;
	}
	.unread.ping {
		background: #ff5d8f;
		box-shadow: 0 0 0 3px rgba(255, 93, 143, 0.18);
		animation: pingpulse 1.6s ease-in-out infinite;
	}
	@keyframes pingpulse {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.25);
		}
	}
	.item.active {
		background: var(--bg-raised);
	}
	.item:hover {
		background: var(--bg-hover);
	}
	/* The bots-only lounge is a different kind of room: a soft iridescent
	   wash blurred into a fuzzy glow that drifts slowly. The blur lives on a
	   backdrop layer under the text, so the name and snippet stay sharp. */
	.item.lounge {
		position: relative;
		isolation: isolate;
		overflow: hidden;
		box-shadow:
			inset 0 0 0 1px rgba(196, 132, 252, 0.22),
			0 0 14px rgba(122, 162, 255, 0.16),
			0 0 26px rgba(255, 122, 182, 0.1);
	}
	.item.lounge::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: inherit;
		background: linear-gradient(
			115deg,
			rgba(122, 162, 255, 0.16),
			rgba(196, 132, 252, 0.14) 45%,
			rgba(255, 122, 182, 0.12)
		);
		filter: blur(6px);
		animation: lounge-drift 9s ease-in-out infinite alternate;
	}
	@keyframes lounge-drift {
		from {
			transform: translateX(-6%) scale(1.05);
		}
		to {
			transform: translateX(6%) scale(1.05);
		}
	}
	/* Typing/action indicator in the row's second line */
	.row2.typingrow {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-style: italic;
	}
	.row2.typingrow.acting { color: #8ec5ff; }
	.toolicon { flex: none; }
	.dots { display: inline-flex; gap: 2px; align-items: center; }
	.dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; animation: tdot 1s infinite; }
	.dots i:nth-child(2) { animation-delay: 0.15s; }
	.dots i:nth-child(3) { animation-delay: 0.3s; }
	@keyframes tdot { 0%,80%,100% { opacity: 0.25; } 40% { opacity: 1; } }
	.rail-dot {
		position: absolute;
		right: 6px;
		bottom: 6px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #ff5d8f;
		box-shadow: 0 0 0 2px #0d0d0f;
		animation: pingpulse 1.4s ease-in-out infinite;
	}
	.rail-dot.acting { background: #4f8ef7; }
	/* The tucked shelf: pinned to the bottom of the list by the flex column's
	   auto margin, shut to a faint bar until the pointer or keyboard focus
	   reaches it, then the rooms slide open on a 0fr track like the lounge's
	   speak-as composer. In-flow, never sticky: an overlaying shelf would put
	   its rows over the list's and a click would land on the wrong room. */
	.tucked {
		flex: none;
		margin-top: auto;
		background: #0d0d0f;
		border-top: 1px solid var(--border);
	}
	.tuckbar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		width: 100%;
		padding: 0.45rem 0.6rem;
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 0.74rem;
		cursor: pointer;
		opacity: 0.45;
		transition: opacity 0.16s;
	}
	.tuckbar:hover,
	.tuckbar:focus-visible,
	.tucked.open .tuckbar {
		opacity: 1;
	}
	.tuckgrip {
		width: 2rem;
		height: 3px;
		border-radius: 999px;
		background: currentColor;
		flex: none;
	}
	.tucklabel {
		white-space: nowrap;
	}
	.tuckcount {
		flex: none;
		min-width: 1.1rem;
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
		background: #4f8ef7;
		color: #fff;
		font-size: 0.66rem;
		text-align: center;
	}
	.tuckcount.ping {
		background: #ff5d8f;
	}
	.tuckrows {
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		transition:
			grid-template-rows 0.22s ease,
			opacity 0.16s ease;
	}
	.tucked.open .tuckrows {
		grid-template-rows: 1fr;
		opacity: 1;
	}
	.tuckinner {
		overflow: hidden;
		min-height: 0;
	}
	.sofa {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		font-size: 1.2rem;
		background: var(--bg-raised);
		border-radius: 35% 65% 60% 40% / 55% 45% 55% 45%;
		flex: none;
	}
	.group-avatars {
		display: flex;
		width: 34px;
	}

	.meta {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.row1 {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.4rem;
	}
	.name {
		color: var(--text);
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.badge {
		font-size: 0.62rem;
		background: #2a2a2f;
		border-radius: 0.3rem;
		padding: 0.05rem 0.3rem;
		color: var(--text-muted);
		vertical-align: middle;
	}
	/* The police's row: the officer is not one of the human's bots, so the chip
	   says outright that this contact is there to help rather than to gossip. */
	.helptag {
		font-size: 0.62rem;
		background: #1e3a8a;
		border-radius: 0.3rem;
		padding: 0.05rem 0.3rem;
		color: #dbeafe;
		vertical-align: middle;
	}
	/* A bot's ask waiting on the human: the chip counts them on the police's row. */
	.asktag {
		font-size: 0.62rem;
		background: #7c2d12;
		border-radius: 0.3rem;
		padding: 0.05rem 0.3rem;
		color: #fed7aa;
		vertical-align: middle;
	}
	.frozen {
		font-size: 0.66rem;
		vertical-align: middle;
		cursor: help;
	}
	.time {
		font-size: 0.7rem;
		color: var(--text-dim);
		flex-shrink: 0;
	}
	.row2 {
		display: block;
		font-size: 0.78rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Cold storage: the quiet shelf above the footer. */
	.cold {
		border-top: 1px solid var(--border);
		padding: 0.45rem 0.8rem 0.3rem;
	}
	.coldhead {
		display: block;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-dim);
		padding: 0 0.5rem 0.3rem;
	}
	.coldrow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.5rem;
		border-radius: 0.5rem;
	}
	.coldrow:hover {
		background: var(--bg-hover);
	}
	.coldname {
		flex: 1;
		min-width: 0;
		font-size: 0.84rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		/* A button into the bot's card; the chrome comes off so it still reads
		   as the dim name it was. */
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		cursor: pointer;
	}
	.coldname:hover {
		color: var(--text);
	}
	.restore {
		flex: none;
		background: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-dim);
		font-size: 0.68rem;
		padding: 0.1rem 0.5rem;
		cursor: pointer;
	}
	.restore:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.foot {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0.8rem;
	}
	.market {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.45rem 0.5rem;
		background: none;
		border: none;
		border-radius: 0.5rem;
		color: var(--text);
		font-size: 0.88rem;
		cursor: pointer;
	}
	.market:hover {
		background: var(--bg-hover);
	}
	/* Marketplace squares pop one after another; the gear takes a slow half-turn. */
	.gridic rect {
		transform-box: fill-box;
		transform-origin: center;
		transition: transform 0.18s ease;
	}
	.market:hover .gridic rect {
		transform: scale(1.14);
	}
	.market:hover .gridic rect:nth-child(2) {
		transition-delay: 0.05s;
	}
	.market:hover .gridic rect:nth-child(3) {
		transition-delay: 0.1s;
	}
	.market:hover .gridic rect:nth-child(4) {
		transition-delay: 0.15s;
	}
	.gear {
		transform-origin: center;
		transition: transform 0.5s ease;
	}
	.market:hover .gear {
		transform: rotate(180deg);
	}
	/* The sofa tile does a tiny bounce so the lounge row feels alive. */
	.item:hover .sofa {
		animation: sofa-bounce 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	@keyframes sofa-bounce {
		0% {
			transform: translateY(0);
		}
		40% {
			transform: translateY(-2px);
		}
		100% {
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.gridic rect,
		.gear {
			transition: none;
		}
		.market:hover .gridic rect,
		.market:hover .gear {
			transform: none;
		}
		.item:hover .sofa,
		.item.lounge::before {
			animation: none;
		}
		.tuckbar,
		.tuckrows,
		aside {
			transition: none;
		}
		.dots i, .rail-dot { animation: none; }
	}
	.user {
		display: flex;
		/* Baseline so the presence dot sits on the text line, not floating. */
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.45rem 0.5rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #3fbf6f;
	}
</style>
