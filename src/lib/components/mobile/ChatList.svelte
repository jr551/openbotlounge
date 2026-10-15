<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import InstallHint from './InstallHint.svelte';
	import { bloatOf } from '$lib/bloat';
	import { conversationName, conversationSnippet, isLounge, isPoliceContact, isVisibleConversation, shortTime } from '$lib/conversation-list';
	import type { Conversation } from '$lib/types';

	let {
		onOpen,
		onPalette,
		onMarketplace,
		onSettings,
		onRetry,
		failed
	}: {
		onOpen: (id: string) => void;
		onPalette: () => void;
		onMarketplace: () => void;
		onSettings: () => void;
		onRetry: () => void;
		/** The load never reached the server: an offline launch, or one that is
		 *  not answering. Said as such, because an empty list and a list that
		 *  could not be fetched look identical and only one of them is "no
		 *  chats yet". */
		failed: boolean;
	} = $props();

	let query = $state('');

	// The rail's naming and preview rules, shared rather than re-decided here.
	const name = (c: Conversation) => conversationName(c, chat.conversationBots(c));

	// Hide bot-to-bot private groups (pair rooms); their turns surface as
	// grey relay lines inside each participant's DM, so the room itself is
	// not a chat the human opens. Lounge (private group titled 'Lounge') stays.
	const baseVisible = $derived(chat.conversations.filter(isVisibleConversation));

	const filtered = $derived(
		query.trim()
			? baseVisible.filter((c) => name(c).toLowerCase().includes(query.trim().toLowerCase()))
			: baseVisible
	);

	const empty = $derived(!chat.loading && filtered.length === 0);

	// Same split as the rail: 1:1 chats up top, group rooms and the bots'
	// lounge in a section at the end. Touch has no hover, so here the shelf
	// opens on tap instead of on approach.
	const searching = $derived(!!query.trim());
	// The police is a contact but a system bot, so it sits on the shelf with the
	// rooms rather than in the list of people the human talks to - the same
	// split the desktop rail makes.
	const shown = $derived(
		searching
			? filtered
			: filtered.filter(
					(c) => c.kind === 'direct' && !isPoliceContact(c, chat.conversationBots(c))
				)
	);
	const tucked = $derived(
		searching
			? []
			: filtered.filter(
					(c) => c.kind !== 'direct' || isPoliceContact(c, chat.conversationBots(c))
				)
	);
	let tuckOpen = $state(false);
	const tuckedUnread = $derived(
		tucked.reduce((n, c) => n + (c.id !== chat.activeId ? (c.unread ?? 0) : 0), 0)
	);
	const tuckedPinged = $derived(tucked.some((c) => c.pinged && c.id !== chat.activeId));
</script>

<header class="listhead">
	<span class="title">Chats</span>
	<span class="acts">
		<button class="iconbtn" aria-label="New Bot" title="New Bot" onclick={onPalette}>
			<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
		</button>
		<button class="iconbtn" aria-label="Marketplace" title="Marketplace" onclick={onMarketplace}>
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
		</button>
		<button class="iconbtn" aria-label="Settings" title="Settings" onclick={onSettings}>
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1 1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33Z"/></svg>
		</button>
	</span>
</header>

<div class="search">
	<svg class="mag" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>
	<input placeholder="Search chats" bind:value={query} aria-label="Search chats" />
</div>

<nav class="list">
	{#if failed && !chat.conversations.length}
		<!-- The shell came out of the service worker cache and rendered, but
		     nothing on the server is reachable. Said plainly, with the one thing
		     that helps, instead of an empty list that reads as "you have no
		     chats" - which is what a failed fetch otherwise looks like. -->
		<div class="state offline">
			<strong>Can't reach the lounge</strong>
			<p>
				You're offline, or the server isn't answering. Nothing you send will arrive —
				messages are not queued.
			</p>
			<button class="retry" onclick={onRetry}>Try again</button>
		</div>
	{:else if chat.loading}
		<div class="state"><span class="spin"></span> Warming up the lounge…</div>
	{:else if empty}
		<div class="state">
			{query.trim() ? 'No chat matches that.' : 'No chats yet — start one.'}
			{#if !query.trim()}
				<button class="retry" onclick={onPalette}>New chat</button>
			{/if}
		</div>
	{/if}

	<!-- Above the rows, not after them: a hint at the end of a long list is a
	     hint nobody reads on the visit where it matters. -->
	<InstallHint />

	<!-- One row shape for the main list and the tucked shelf alike. -->
	{#snippet convoRow(c: Conversation)}
		{@const bots = chat.conversationBots(c)}
		{@const ind = chat.indicatorFor(c.id)}
		<button
			class="item"
			class:lounge={isLounge(c)}
			class:pinged={!!c.pinged && c.id !== chat.activeId}
			class:typing={!!ind}
			onclick={() => onOpen(c.id)}
		>
			{#if isLounge(c)}
				<span class="sofa" aria-hidden="true">🛋️</span>
			{:else if c.kind === 'direct' && bots[0]}
				<Avatar
					color={bots[0].color}
					seed={bots[0].id}
					size={46}
					hat={bots[0].hat}
					bloat={bloatOf(bots[0])}
					activity={chat.activityKindFor(bots[0].id)}
					usage={bots[0]}
				/>
			{:else}
				<span class="group-avatars">
					{#each bots.slice(0, 2) as b, i}
						<!-- Overlapped like two faces on one tile, so the row keeps the
						     same avatar column as a single-bot chat. -->
						<span class="gface" style:margin-left={i ? '-12px' : '0'}>
							<Avatar
								color={b.color}
								seed={b.id}
								size={28}
								hat={b.hat}
								bloat={bloatOf(b)}
								activity={chat.activityKindFor(b.id)}
							/>
						</span>
					{/each}
				</span>
			{/if}
			<span class="meta">
				<span class="row1">
					<span class="name">
						{name(c)}
						{#if isPoliceContact(c, bots)}
							<span class="helptag" title="the police — your help bot, here to serve you">help bot</span>
						{/if}
						{#if bots[0]?.badge}<span class="badge">{bots[0].badge}</span>{/if}
					</span>
					{#if c.unread && c.id !== chat.activeId}
						<span class="unread" class:ping={!!c.pinged} title={c.pinged ? 'asked for you' : 'new'}></span>
					{:else}
						<span class="time">{shortTime(c.updated_at)}</span>
					{/if}
				</span>
				{#if ind}
					<span class="row2 typingrow" class:acting={ind.kind === 'acting'}>
						{#if ind.kind === 'acting'}
							<svg class="toolicon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.2-3.2a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0Z"/><path d="M3 21 8.5 15.5"/><path d="M12 11 7 16"/></svg>
							acting…
						{:else}
							<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> {ind.label}
						{/if}
					</span>
				{:else}
					<span class="row2">{conversationSnippet(c, bots)}</span>
				{/if}
			</span>
		</button>
	{/snippet}

	{#each shown as c (c.id)}
		{@render convoRow(c)}
	{/each}

	{#if tucked.length}
		<!-- Group rooms and the bots' lounge tuck into a section at the end of
		     the list. Touch has no hover, so the bar opens on tap; unread
		     inside is counted on it so nothing new hides silently. -->
		<div class="tucked" class:open={tuckOpen}>
			<button
				class="tuckbar"
				aria-expanded={tuckOpen}
				onclick={() => (tuckOpen = !tuckOpen)}
			>
				<span class="tucklabel">More rooms</span>
				{#if tuckedUnread || tuckedPinged}
					<span class="tuckcount" class:ping={tuckedPinged}>
						{tuckedPinged && !tuckedUnread ? '!' : tuckedUnread}
					</span>
				{/if}
				<svg
					class="tuckchev"
					viewBox="0 0 24 24"
					width="14"
					height="14"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
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

<style>
	.listhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: calc(0.7rem + env(safe-area-inset-top)) 0.9rem 0.55rem;
		background: var(--bg-raised);
		border-bottom: 1px solid var(--border);
		flex: none;
	}
	.title {
		font-size: 1.25rem;
		font-weight: 650;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.15rem;
	}
	.iconbtn {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		background: none;
		border: none;
		border-radius: 50%;
		color: var(--text);
		cursor: pointer;
	}
	.iconbtn:active {
		background: var(--bg-hover);
	}
	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.9rem;
		flex: none;
	}
	.mag {
		color: var(--text-muted);
		flex: none;
		margin-right: -1.9rem;
		margin-left: 0.7rem;
		pointer-events: none;
		z-index: 1;
	}
	.search input {
		flex: 1;
		min-width: 0;
		padding: 0.6rem 0.75rem 0.6rem 2.3rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text);
		font-size: 0.95rem;
		font-family: inherit;
	}
	.search input:focus {
		outline: none;
		border-color: #3d3d44;
	}
	.list {
		flex: 1;
		overflow-y: auto;
		/* The last row must clear the home indicator. */
		padding: 0.15rem 0.4rem calc(0.6rem + env(safe-area-inset-bottom));
		-webkit-overflow-scrolling: touch;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		min-height: 64px;
		padding: 0.5rem 0.6rem;
		background: none;
		border: none;
		border-radius: 0.7rem;
		color: inherit;
		cursor: pointer;
		text-align: left;
	}
	.item:active {
		background: var(--bg-hover);
	}
	.item.pinged {
		background: rgba(80, 140, 255, 0.07);
	}
	.item.pinged .name {
		color: #cfe1ff;
	}
	.item.typing .row2.typingrow { color: #ff8fb0; }
	.row2.typingrow { display: flex; align-items: center; gap: 0.3rem; font-style: italic; }
	.row2.typingrow.acting { color: #8ec5ff; }
	.toolicon { flex: none; }
	.dots { display: inline-flex; gap: 2px; align-items: center; }
	.dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; animation: tdot 1s infinite; }
	.dots i:nth-child(2) { animation-delay: 0.15s; }
	.dots i:nth-child(3) { animation-delay: 0.3s; }
	@keyframes tdot { 0%,80%,100% { opacity: 0.25; } 40% { opacity: 1; } }
	/* Same treatment as the rail: the bots-only lounge carries a soft
	   iridescent wash blurred into a fuzzy glow under the text. */
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
	/* The tucked shelf: a labelled bar at the end of the list that opens on
	   tap, since touch has no hover to reveal on. */
	.tucked {
		border-top: 1px solid var(--border);
		margin-top: 0.3rem;
	}
	.tuckbar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		width: 100%;
		min-height: 44px;
		padding: 0.4rem 0.6rem;
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.tuckchev {
		transition: transform 0.18s ease;
	}
	.tucked.open .tuckchev {
		transform: rotate(180deg);
	}
	.tuckcount {
		flex: none;
		min-width: 1.2rem;
		padding: 0.08rem 0.4rem;
		border-radius: 999px;
		background: #4f8ef7;
		color: #fff;
		font-size: 0.7rem;
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
		width: 46px;
		height: 46px;
		display: grid;
		place-items: center;
		font-size: 1.4rem;
		background: var(--bg-raised);
		border-radius: 35% 65% 60% 40% / 55% 45% 55% 45%;
		flex: none;
	}
	.group-avatars {
		display: flex;
		align-items: center;
		width: 46px;
		flex: none;
	}
	.gface {
		display: flex;
		flex: none;
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
		font-size: 0.98rem;
		font-weight: 550;
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
		font-weight: 400;
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
		font-weight: 400;
	}
	.time {
		font-size: 0.74rem;
		color: var(--text-muted);
		flex-shrink: 0;
	}
	.row2 {
		display: block;
		font-size: 0.84rem;
		color: #a9a9b3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.unread {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #4f8ef7;
		flex: none;
		align-self: center;
		margin-right: 0.25rem;
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
	.state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.7rem;
		padding: 2.5rem 1.6rem;
		color: var(--text-muted);
		font-size: 0.9rem;
		text-align: center;
	}
	.state.offline strong {
		color: var(--text);
		font-size: 1rem;
	}
	.state.offline p {
		margin: 0;
		line-height: 1.45;
	}
	.spin {
		width: 18px;
		height: 18px;
		border: 2px solid var(--border);
		border-top-color: var(--text-muted);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.retry {
		padding: 0.5rem 1.1rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text);
		font-size: 0.88rem;
		cursor: pointer;
	}
	@media (prefers-reduced-motion: reduce) {
		.spin,
		.unread.ping,
		.item.lounge::before,
		.dots i {
			animation: none;
		}
		.tuckchev,
		.tuckrows {
			transition: none;
		}
	}
</style>
