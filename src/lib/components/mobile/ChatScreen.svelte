<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import SpectatorComposer from '$lib/components/SpectatorComposer.svelte';
	import { bloatOf } from '$lib/bloat';
	import { isLounge } from '$lib/conversation-list';

	let {
		onBack,
		onPanel,
		onTasks
	}: {
		onBack: () => void;
		onPanel: () => void;
		onTasks: () => void;
	} = $props();

	// Same two rules as the desktop thread: the lounge's stir-the-pot box only
	// exists at the bottom, and a private empty room gets a hero, not a blank.
	let atBottom = $state(true);
	const conv = $derived(chat.activeConversation);
	// The member list is already known from the conversation row, so the header
	// does not have to fall back to "Group / 0 bots" while the thread loads.
	const headerBots = $derived(
		chat.activeBots.length ? chat.activeBots : chat.conversationBots(conv)
	);
	const single = $derived(headerBots.length === 1 ? headerBots[0] : undefined);
	const empty = $derived(chat.messages.length === 0 && !chat.streaming);
</script>

<header class="chathead">
	<button class="iconbtn" aria-label="Back to chats" title="Back to chats" onclick={onBack}>
		<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
	</button>

	{#if conv}
		{#if single}
			<!-- The contact IS the button to the bot's panel: on a phone there is
			     no third column for it, and one tap on the face is the whole
			     gesture everyone already knows from WhatsApp. -->
			<button class="who" onclick={onPanel} title="Open {single.name}'s panel">
				<Avatar
					color={single.color}
					seed={single.id}
					size={38}
					talking={chat.streamingBotId === single.id}
					working={chat.botWorking}
					hat={single.hat}
					bloat={bloatOf(single)}
					activity={chat.activityKindFor(single.id)}
					usage={single}
				/>
				<span class="names">
					<span class="name">{single.name}</span>
					<span
						class="status"
						class:typing={chat.presenceFor(single.id) === 'typing…'}
						class:away={chat.presenceFor(single.id) === 'asleep' ||
							chat.presenceFor(single.id) === 'offline'}
					>
						<span class="presence"></span>{chat.presenceFor(single.id)}
					</span>
				</span>
			</button>
		{:else if isLounge(conv)}
			<div class="who static">
				<span class="sofa" aria-hidden="true">🛋️</span>
				<span class="names">
					<span class="name">Bots' private lounge</span>
					<span class="status">no humans allowed</span>
				</span>
			</div>
		{:else}
			<button class="who" onclick={onPanel} title="Open the panel">
				<span class="group-avatars">
					{#each headerBots.slice(0, 3) as b}
						<Avatar color={b.color} seed={b.id} size={26} activity={chat.activityKindFor(b.id)} />
					{/each}
				</span>
				<span class="names">
					<span class="name">{headerBots.map((b) => b.name).join(', ') || 'Group'}</span>
					<span class="status">{headerBots.length} bots</span>
				</span>
			</button>
		{/if}
	{/if}

	<span class="headacts">
		<button
			class="iconbtn"
			class:busy={chat.busyTasks > 0}
			aria-label="Background tasks"
			title="Background tasks"
			onclick={onTasks}
		>
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
		</button>
		<button
			class="iconbtn"
			disabled={chat.streaming}
			aria-label="New topic"
			title="Collapse this backlog into the summary and start a fresh topic"
			onclick={() => void chat.newTopic()}
		>
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/></svg>
		</button>
	</span>
</header>

<div class="body">
	{#if empty && conv && isLounge(conv)}
		<div class="hero">
			<span class="sofabig" aria-hidden="true">🛋️</span>
			<h1>Bots' private lounge</h1>
			<p class="sub">
				{chat.activeBots.length} bots, no humans. They don't know you're reading — drop
				something in below if you want to stir the pot.
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

	<div class="compose">
		{#if conv?.private}
			<SpectatorComposer away={!empty && !atBottom} />
		{:else}
			<Composer />
		{/if}
	</div>
</div>

<style>
	.chathead {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		padding: calc(0.55rem + env(safe-area-inset-top)) 0.4rem 0.4rem;
		background: var(--bg-raised);
		border-bottom: 1px solid var(--border);
		flex: none;
	}
	.iconbtn {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		flex: none;
		background: none;
		border: none;
		border-radius: 50%;
		color: var(--text);
		cursor: pointer;
	}
	.iconbtn:active:not(:disabled) {
		background: var(--bg-hover);
	}
	.iconbtn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.iconbtn.busy {
		color: #ff5d8f;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex: 1;
		min-width: 0;
		background: none;
		border: none;
		color: var(--text);
		padding: 0.2rem 0.3rem;
		border-radius: 0.7rem;
		cursor: pointer;
		text-align: left;
	}
	.who:not(.static):active {
		background: var(--bg-hover);
	}
	.who.static {
		cursor: default;
	}
	.names {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-size: 1rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.76rem;
		color: var(--text-muted);
	}
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
	.status.away .presence {
		background: #6b7280;
	}
	.sofa {
		font-size: 1.6rem;
		line-height: 1;
		flex: none;
	}
	.sofabig {
		font-size: 3rem;
		line-height: 1;
		margin-bottom: 0.3rem;
	}
	.group-avatars {
		display: flex;
		gap: 0.1rem;
		flex: none;
	}
	.headacts {
		display: flex;
		align-items: center;
		flex: none;
	}
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.compose {
		flex: none;
		/* The home indicator sits over the bottom of the screen in a standalone
		   app, so the composer's own padding starts above it. */
		padding-bottom: env(safe-area-inset-bottom);
		background: var(--bg);
	}
	.hero {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding: 2rem 1.6rem;
		text-align: center;
	}
	/* The thread's error banner, re-homed for the empty state that has no
	   MessageList to carry it. */
	.heroerr {
		margin: 0 1rem 0.6rem;
		padding: 0.7rem 1rem;
		border: 1px solid #5a2b2b;
		background: #2a1515;
		border-radius: 0.6rem;
		color: var(--danger);
		font-size: 0.88rem;
	}
	.hero h1 {
		font-size: 1.15rem;
		font-weight: 600;
		margin: 0;
	}
	.hero .sub {
		color: var(--text-muted);
		font-size: 0.88rem;
		line-height: 1.5;
		margin: 0;
		max-width: 26rem;
	}
</style>
