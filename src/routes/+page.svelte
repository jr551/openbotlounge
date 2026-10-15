<script lang="ts">
	import { onMount } from 'svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import ScreenPanel from '$lib/components/ScreenPanel.svelte';
	import Palette from '$lib/components/Palette.svelte';
	import BotForm from '$lib/components/BotForm.svelte';
	import NewBotWizard from '$lib/components/NewBotWizard.svelte';
	import Marketplace from '$lib/components/Marketplace.svelte';
	import Plugins from '$lib/components/Plugins.svelte';
	import Settings from '$lib/components/Settings.svelte';
	import RoutineForm from '$lib/components/RoutineForm.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import TaskTray from '$lib/components/TaskTray.svelte';
	import RecoveryNotice from '$lib/components/RecoveryNotice.svelte';
	import SpectatorComposer from '$lib/components/SpectatorComposer.svelte';
	import MobileApp from '$lib/components/mobile/MobileApp.svelte';
	import { MOBILE_COOKIE, isIPadOnMac, overrideFromCookie } from '$lib/mobile';
	import { isLounge, isPoliceContact } from '$lib/conversation-list';
	import { costOf, formatCost, resolveModel, type ModelPricing } from '$lib/pricing';

	// The shell for this load: the server's verdict (see $lib/mobile), plus the
	// one signal a request cannot carry - iPadOS in desktop mode - which is only
	// consulted when nothing was asked for explicitly, because `?mobile=0` on an
	// iPad is a choice, not a misdetection to correct.
	const pinned = typeof document === 'undefined' ? null : overrideFromCookie(document.cookie);
	let { data } = $props();
	const mobile = $derived(data.mobile || (pinned === null && isIPadOnMac()));

	$effect(() => {
		// Remembered, so a reload of the tab does not go back to the desktop
		// shell and then blink into the mobile one.
		if (mobile && !data.mobile) {
			document.cookie = `${MOBILE_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 365}`;
		}
	});

	let paletteOpen = $state(false);
	let botFormOpen = $state(false);
	let wizardOpen = $state(false);
	let marketplaceOpen = $state(false);
	let routineOpen = $state(false);
	let pluginsOpen = $state(false);
	let settingsOpen = $state(false);
	// The live sandbox screen is a power feature, not part of a chat - opt in.
	let screenOpen = $state(false);
	// Bots manage their own tasks; the tray is only there if you go looking.
	let tasksOpen = $state(false);
	let editingBot = $state<import('$lib/types').Bot | null>(null);
	// What the palette was searching for when "New bot" was clicked, so the form
	// opens with that name already typed instead of asking for it a second time.
	let newBotName = $state('');

	/** Open the new-bot wizard, optionally prefilled from the palette's query. */
	function openNewBot(name = '') {
		editingBot = null;
		newBotName = name;
		wizardOpen = true;
	}
	// Below 700px the rail leaves the layout and reopens as an overlay.
	let sidebarOpen = $state(false);
	// The lounge's stir-the-pot box only exists at the bottom of the thread.
	let atBottom = $state(true);

	const conv = $derived(chat.activeConversation);
	const empty = $derived(chat.messages.length === 0 && !chat.streaming);
	// The member list is already known from the conversation row, so the header
	// does not have to fall back to "Group / 0 bots" while the thread loads.
	const headerBots = $derived(
		chat.activeBots.length ? chat.activeBots : conv ? chat.conversationBots(conv) : []
	);
	// Per-token prices from the provider's /models listing, fetched once. Empty
	// until it lands, and empty for ever when the provider prices nothing - the
	// header then shows no money rather than a made-up one.
	let pricing = $state<Record<string, ModelPricing>>({});
	// What the bots in the header have spent, or null when none of their models
	// carries a price. The title spells out the tokens and the rate behind the
	// number so it can be checked by hand.
	const headerSpend = $derived.by(() => {
		const lines: string[] = [];
		let total = 0;
		for (const b of headerBots) {
			// The provider prices the model it actually served, and a bot's own
			// model is often an alias the price list does not carry at all, so the
			// served model wins whenever a turn has reported one. The configured
			// model is the fallback for a bot whose provider names no model.
			const model = resolveModel(b.served_model || b.model, chat.defaultModel);
			const p = pricing[model];
			if (!p) continue;
			const cost = costOf(p, { input: b.input_tokens, output: b.output_tokens });
			total += cost;
			lines.push(
				`${b.name}: ${formatCost(cost)} — ${b.input_tokens} in / ${b.output_tokens} out @ $${p.prompt}/in, $${p.completion}/out (${model})`
			);
		}
		if (!lines.length) return null;
		return { total, title: lines.join('\n') };
	});
	// True once a load has failed: an offline launch, or a server that stopped
	// answering. Without it the store stays in its loading state for ever and
	// every screen shows a spinner that never ends.
	let loadFailed = $state(false);

	/** The initial load, and the retry after a failure or a return to network. */
	function reload() {
		chat.loading = true;
		void chat.init().then(
			() => (loadFailed = false),
			() => {
				loadFailed = true;
				chat.loading = false;
			}
		);
	}

	onMount(() => {
		reload();
		// Prices are a readout, not a gate: a provider that does not answer
		// leaves the header without money rather than failing the launch.
		void fetch('/api/pricing')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d?.pricing) pricing = d.pricing;
			})
			.catch(() => {});
		// Coming back from offline is the one moment the app knows it is worth
		// trying again; the store's own polls give up quietly and nothing else
		// would ever bring the lounge back without a manual reload.
		window.addEventListener('online', reload);
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				paletteOpen = true;
			}
			if (e.key === 'Escape') sidebarOpen = false;
		};
		// Growing back past the breakpoint returns the rail to the flow, so
		// the overlay state must not linger.
		const mq = window.matchMedia('(max-width: 700px)');
		const onMq = () => {
			if (!mq.matches) sidebarOpen = false;
		};
		mq.addEventListener('change', onMq);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('online', reload);
			window.removeEventListener('keydown', onKey);
			mq.removeEventListener('change', onMq);
		};
	});
</script>

{#if mobile}
	<!-- The phone gets its own shell rather than a squeezed desktop one: the
	     same store, the same bubbles, the same composer, arranged as two
	     screens you move between. -->
	<MobileApp
		onPalette={() => (paletteOpen = true)}
		onMarketplace={() => (marketplaceOpen = true)}
		onSettings={() => (settingsOpen = true)}
		onEditBot={(b) => {
			editingBot = b;
			botFormOpen = true;
		}}
		onRoutine={() => (routineOpen = true)}
		onTasks={() => (tasksOpen = true)}
		onRetry={reload}
		failed={loadFailed}
	/>
{:else}
<div class="app">
	<Sidebar bind:open={sidebarOpen} onPalette={() => (paletteOpen = true)} onMarketplace={() => (marketplaceOpen = true)} onSettings={() => (settingsOpen = true)} />

	<main>
		{#if conv}
			<header>
				<div class="contact">
					<button
						class="iconbtn menubtn"
						class:on={sidebarOpen}
						title="Conversations"
						onclick={() => (sidebarOpen = !sidebarOpen)}
					>
						<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/></svg>
					</button>
					{#if isPoliceContact(conv, headerBots)}
						{@const b = headerBots[0]}
						<!-- The officer is a system bot, not one of the human's to edit,
						     so its header is a label rather than a button into the form. -->
						<div class="who static">
							<Avatar
								color={b.color}
								seed={b.id}
								size={38}
								talking={chat.streamingBotId === b.id}
								working={chat.botWorking}
								hat={b.hat}
								activity={chat.activityKindFor(b.id)}
								usage={b}
							/>
							<span class="names">
								<span class="namerow">
									<span class="name">{b.name}</span>
									{#if headerSpend}
										<span class="cost" title={headerSpend.title}
											>{formatCost(headerSpend.total)}</span
										>
									{/if}
								</span>
								<span class="status">
									<span class="presence"></span>your help bot — here to serve you
								</span>
							</span>
						</div>
					{:else if headerBots.length === 1}
						{@const b = headerBots[0]}
						<button
							class="who"
							onclick={() => {
								editingBot = b;
								botFormOpen = true;
							}}
						>
							<Avatar
								color={b.color}
								seed={b.id}
								size={38}
								talking={chat.streamingBotId === b.id}
								working={chat.botWorking}
								hat={b.hat}
								activity={chat.activityKindFor(b.id)}
								usage={b}
							/>
							<span class="names">
								<span class="namerow">
									<span class="name">{b.name}</span>
									{#if headerSpend}
										<span class="cost" title={headerSpend.title}
											>{formatCost(headerSpend.total)}</span
										>
									{/if}
								</span>
								<span
									class="status"
									class:typing={chat.presenceFor(b.id) === 'typing…'}
									class:away={chat.presenceFor(b.id) === 'asleep' ||
										chat.presenceFor(b.id) === 'offline'}
								>
									<span class="presence"></span>{chat.presenceFor(b.id)}
								</span>
							</span>
						</button>
					{:else if isLounge(conv)}
						<div class="who static">
							<span class="sofa">🛋️</span>
							<span class="names">
								<span class="name">Bots' private lounge</span>
								<span class="status">no humans allowed</span>
							</span>
						</div>
					{:else}
						<div class="who static">
							<span class="group-avatars">
								{#each headerBots.slice(0, 3) as b}
									<Avatar
										color={b.color}
										seed={b.id}
										size={26}
										activity={chat.activityKindFor(b.id)}
									/>
								{/each}
							</span>
							<span class="names">
								<span class="name">
									{headerBots.map((b) => b.name).join(', ') || 'Group'}
								</span>
								<span class="status">
									{headerBots.length} bots
									{#if headerSpend}
										<span class="cost" title={headerSpend.title}
											>{formatCost(headerSpend.total)}</span
										>
									{/if}
								</span>
							</span>
						</div>
					{/if}
				</div>
				<div class="headside">
					<button
						class="txtbtn"
						title="Collapse this backlog into the summary and start a fresh topic"
						disabled={chat.streaming}
						onclick={() => chat.newTopic()}
					>
						New topic
					</button>
					<div class="tools">
					{#if !isLounge(conv)}
						<button
							class="iconbtn"
							class:on={tasksOpen}
							class:busy={chat.busyTasks > 0}
							title="Background tasks"
							onclick={() => (tasksOpen = !tasksOpen)}
						>
							<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
						</button>
						<button
							class="iconbtn"
							class:on={screenOpen}
							class:using={chat.botUsingComputer}
							title="Bot screen"
							onclick={() => (screenOpen = !screenOpen)}
						>
							<!-- A desktop monitor: landscape screen on a stand, so the
							     screen toggle reads as the machine the bot is looking
							     at, not the phone-shaped box it used to look like. -->
							<svg class="monitor" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect class="mon-screen" width="20" height="14" x="2" y="3" rx="2"/><line class="mon-stand" x1="8" x2="16" y1="21" y2="21"/><line class="mon-stand" x1="12" x2="12" y1="17" y2="21"/></svg>
						</button>
						<button class="iconbtn" title="Plugins" onclick={() => (pluginsOpen = true)}>
							<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v6a6 6 0 0 1-12 0z"/></svg>
						</button>
					{/if}
					</div>
				</div>
			</header>

			{#if empty && isLounge(conv)}
				<div class="hero">
					<span class="sofabig">🛋️</span>
					<h1>Bots' private lounge</h1>
					<p class="sub">
						{chat.activeBots.length} bots, no humans. They don't know you're reading —
						drop something in below if you want to stir the pot.
					</p>
				</div>
			{:else if empty}
				<div class="hero">
					<h1>Message {chat.activeBots.map((b) => b.name).join(' & ') || 'a bot'}</h1>
				</div>
			{:else}
				<MessageList bind:atBottom />
			{/if}
			<!-- The thread's own banner only exists while it is mounted; an empty
			     chat still needs to hear a refused send or a failed load. -->
			{#if empty && chat.error}
				<div class="heroerr">{chat.error}</div>
			{/if}
			{#if conv.private}
				<!-- The stir-the-pot box steps aside while the reader is up in the
				     backlog, but stays mounted so a draft survives the scroll. -->
				<SpectatorComposer away={!empty && !atBottom} />
			{:else}
				<Composer />
			{/if}
		{:else}
			<header class="railhead">
				<button
					class="iconbtn menubtn"
					class:on={sidebarOpen}
					title="Conversations"
					onclick={() => (sidebarOpen = !sidebarOpen)}
				>
					<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/></svg>
				</button>
			</header>
			<div class="hero welcome">
				<h1>OpenBotLounge</h1>
				{#if chat.loading}
					<p class="sub">Warming up the lounge…</p>
				{:else if loadFailed}
					<!-- The load never arrived. Saying so beats the "no bots yet" a
					     failed fetch would otherwise be mistaken for, and beats a
					     spinner that would never stop. -->
					<p class="sub">
						The lounge is out of reach — the server isn't answering. Messages sent now
						would not arrive.
					</p>
					<button class="primary" onclick={reload}>Try again</button>
				{:else}
					<p class="sub">
						{chat.visibleBots.length
							? 'Pick a bot to jump back in, or start a new chat.'
							: 'No bots yet — create one to get started.'}
					</p>
					{#if chat.visibleBots.length}
						<div class="botgroup">
							<span class="botlabel">Your bots</span>
							<div class="botrow">
								{#each chat.visibleBots as bot (bot.id)}
									<button class="botcard" onclick={() => chat.openDirect(bot.id)}>
										<Avatar
											color={bot.color}
											seed={bot.id}
											size={48}
											activity={chat.activityKindFor(bot.id)}
											usage={bot}
										/>
										<span class="botname">{bot.name}</span>
										{#if bot.badge}<span class="badge">{bot.badge}</span>{/if}
										<span class="openhint">Open chat →</span>
									</button>
								{/each}
							</div>
						</div>
						<button class="primary" onclick={() => (paletteOpen = true)}>New chat</button>
					{:else}
						<button class="primary" onclick={() => openNewBot()}>
							Create a bot
						</button>
					{/if}
				{/if}
			</div>
		{/if}
	</main>

	{#if screenOpen}
		<div class="screenwrap">
			<ScreenPanel onCreateRoutine={() => (routineOpen = true)} />
		</div>
	{/if}
</div>
{/if}

{#if tasksOpen}
	<TaskTray />
{/if}

<Palette bind:open={paletteOpen} onCreateBot={openNewBot} />
<NewBotWizard bind:open={wizardOpen} initialName={newBotName} />
<BotForm bind:open={botFormOpen} bot={editingBot} initialName={newBotName} />
<Marketplace bind:open={marketplaceOpen} />
<Plugins bind:open={pluginsOpen} />
<Settings bind:open={settingsOpen} />
<RoutineForm bind:open={routineOpen} />
<RecoveryNotice />

<style>
	.app {
		display: flex;
		height: 100dvh;
	}
	main {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.35rem 0.8rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-raised);
	}
	.contact {
		min-width: 0;
	}
	/* The rail toggle only exists below the 700px breakpoint, where the
	   sidebar leaves the layout and reopens as an overlay. The doubled
	   class outranks .iconbtn's display:grid below. */
	.menubtn.menubtn {
		display: none;
	}
	/* Slim bar on the welcome screen so the rail stays reachable there too. */
	.railhead {
		display: none;
	}
	.screenwrap {
		display: contents;
	}
	@media (max-width: 700px) {
		.menubtn.menubtn {
			display: grid;
			flex: none;
		}
		.railhead {
			display: flex;
		}
		.contact {
			display: flex;
			align-items: center;
			gap: 0.15rem;
		}
	}

	/* The 340px screen panel would crush the thread: past the 300px rail it
	   leaves less than a phone column for the messages well before the 700px
	   phone breakpoint (768px - 640px of chrome is 128px). The panel becomes
	   an overlay pinned to the right edge below 1000px, starting below the
	   header so the Bot screen toggle that closes it stays reachable;
	   wide-enough desktops keep it in the row. */
	@media (max-width: 1000px) {
		.screenwrap {
			display: flex;
			position: fixed;
			top: 3.1rem;
			right: 0;
			bottom: 0;
			width: min(340px, 100vw);
			z-index: 30;
		}
		.screenwrap :global(.panel) {
			width: 100%;
			min-width: 0;
		}
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		background: none;
		border: none;
		color: var(--text);
		padding: 0.25rem 0.4rem;
		border-radius: 0.7rem;
		cursor: pointer;
		text-align: left;
		min-width: 0;
	}
	.who.static {
		cursor: default;
	}
	.who:not(.static):hover {
		background: var(--bg-hover);
	}
	.names {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-size: 0.95rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* The name and its spend share a line so the money sits next to the head
	   without adding a third row to the header. */
	.namerow {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		min-width: 0;
	}
	/* A readout, not a control: small, muted, and hoverable for the breakdown. */
	.cost {
		font-size: 0.72rem;
		font-weight: 500;
		color: var(--text-muted);
		white-space: nowrap;
		cursor: help;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.76rem;
		color: var(--text-muted);
	}
	/* Presence reads at a glance; pink while the bot is mid-reply. */
	.presence {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #3fbf6f;
		flex-shrink: 0;
	}
	.status.typing .presence {
		background: #ff5d8f;
	}
	/* A machine that is down or missing: the dot goes grey, the word says which. */
	.status.away .presence {
		background: #6b7280;
	}
	.sofa {
		font-size: 1.7rem;
		line-height: 1;
	}
	.sofabig {
		font-size: 3rem;
		line-height: 1;
		margin-bottom: 0.3rem;
	}
	.group-avatars {
		display: flex;
		gap: 0.15rem;
	}
	.headside {
		display: flex;
		align-items: center;
		gap: 0.7rem;
	}
	/* The three toggles travel as one set, apart from the primary action. */
	.tools {
		display: flex;
		align-items: center;
		gap: 0.1rem;
		padding: 0.15rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 999px;
	}
	.txtbtn {
		background: none;
		border: 1px solid #3d3d44;
		color: var(--text);
		font-size: 0.78rem;
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		cursor: pointer;
		white-space: nowrap;
		transition: transform 0.14s ease;
	}
	.txtbtn:hover:not(:disabled) {
		color: var(--text);
		background: var(--bg-hover);
		transform: translateY(-1px) scale(1.02);
	}
	.txtbtn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.iconbtn {
		display: grid;
		place-items: center;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0.4rem;
		border-radius: 50%;
	}
	.iconbtn:hover,
	.iconbtn.on {
		color: var(--text);
		background: var(--bg-hover);
	}
	/* Radioactive pulse while any background task is running. */
	.iconbtn.busy {
		color: #4ade80;
		animation: task-glow 1.4s ease-in-out infinite;
	}
	@keyframes task-glow {
		0%,
		100% {
			color: #4ade80;
			box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.55);
		}
		50% {
			color: #86efac;
			box-shadow: 0 0 14px 3px rgba(74, 222, 128, 0.55);
		}
	}
	/* Electric-blue flash while the bot is driving its machine - the panel may
	   be closed, so the screen icon is the one place that work still shows. */
	.iconbtn.using {
		color: #00bfff;
		animation: computer-flash 1.2s ease-in-out infinite;
	}
	@keyframes computer-flash {
		0%,
		100% {
			color: #00bfff;
			box-shadow: 0 0 0 0 rgba(0, 191, 255, 0);
		}
		50% {
			color: #7dd8ff;
			box-shadow: 0 0 14px 3px rgba(0, 191, 255, 0.6);
		}
	}
	/* The monitor wakes up on hover: the stand bounces off the desk, the
	   screen flickers. */
	.monitor .mon-stand {
		transform-box: fill-box;
		transform-origin: 50% 100%;
	}
	.iconbtn:hover .monitor .mon-stand {
		animation: stand-bounce 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.iconbtn:hover .monitor .mon-screen {
		animation: screen-flicker 0.45s ease-out;
	}
	@keyframes stand-bounce {
		0% {
			transform: translateY(0);
		}
		40% {
			transform: translateY(-1.6px);
		}
		100% {
			transform: translateY(0);
		}
	}
	@keyframes screen-flicker {
		0% {
			opacity: 1;
		}
		30% {
			opacity: 0.35;
		}
		100% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.txtbtn {
			transition: none;
		}
		.txtbtn:hover:not(:disabled) {
			transform: none;
		}
		.iconbtn:hover .monitor .mon-stand,
		.iconbtn:hover .monitor .mon-screen {
			animation: none;
		}
		.iconbtn.busy,
		.iconbtn.using {
			animation: none;
		}
	}
	.hero {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 1rem;
	}
	/* The thread's error banner, re-homed for the empty state that has no
	   MessageList to carry it. */
	.heroerr {
		align-self: center;
		width: min(48rem, calc(100% - 2.2rem));
		margin: 0 auto 0.6rem;
		padding: 0.7rem 1rem;
		border: 1px solid #5a2b2b;
		background: #2a1515;
		border-radius: 0.6rem;
		color: var(--danger);
		font-size: 0.88rem;
	}
	/* The no-conversation state is a lobby, not a void: bounded width, bots first. */
	.welcome {
		align-self: center;
		width: 100%;
		max-width: 34rem;
		gap: 1.4rem;
	}
	.welcome .sub {
		text-align: center;
	}
	/* Bots group first with a quiet label, so the eye lands there before the action. */
	.botgroup {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
	}
	.botlabel {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.botrow {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
		gap: 0.6rem;
		width: 100%;
	}
	.botcard {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.45rem;
		padding: 0.9rem 0.5rem 0.7rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		color: var(--text);
		cursor: pointer;
		transition:
			transform 0.14s ease,
			border-color 0.14s ease,
			background 0.14s ease;
	}
	.botcard:hover {
		background: var(--bg-hover);
		border-color: var(--accent);
		transform: translateY(-2px);
	}
	/* Reserved space so the hint fading in doesn't shift the card. */
	.openhint {
		font-size: 0.68rem;
		color: var(--accent);
		opacity: 0;
		transition: opacity 0.14s ease;
	}
	.botcard:hover .openhint,
	.botcard:focus-visible .openhint {
		opacity: 1;
	}
	.botname {
		font-size: 0.85rem;
		font-weight: 600;
		max-width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.badge {
		font-size: 0.62rem;
		background: #2a2a2f;
		border-radius: var(--r-pill);
		padding: 0.05rem 0.4rem;
		color: var(--text-muted);
		max-width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hero h1 {
		margin: 0;
		font-size: 1.6rem;
		font-weight: 600;
	}
	.sub {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.9rem;
	}
	.primary {
		padding: 0.55rem 1.4rem;
		background: var(--accent);
		border: none;
		border-radius: var(--r-md);
		color: #fff;
		font-size: 0.9rem;
		cursor: pointer;
	}
	@media (prefers-reduced-motion: reduce) {
		.botcard,
		.openhint {
			transition: none;
		}
		.botcard:hover {
			transform: none;
		}
	}
</style>
