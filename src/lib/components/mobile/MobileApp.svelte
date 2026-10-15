<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import ChatList from './ChatList.svelte';
	import ChatScreen from './ChatScreen.svelte';
	import BotSheet from './BotSheet.svelte';
	import BotDetail from '$lib/components/BotDetail.svelte';
	import type { Bot } from '$lib/types';

	let {
		onPalette,
		onMarketplace,
		onSettings,
		onEditBot,
		onRoutine,
		onTasks,
		onRetry,
		failed
	}: {
		onPalette: () => void;
		onMarketplace: () => void;
		onSettings: () => void;
		onEditBot: (bot: Bot) => void;
		onRoutine: () => void;
		onTasks: () => void;
		onRetry: () => void;
		failed: boolean;
	} = $props();

	// WhatsApp's two screens: the list is home, a chat is pushed on top of it.
	// Both stay mounted, which is what lets the slide animate and what keeps the
	// thread's scroll position and half-typed draft while you glance at the list.
	let screen = $state<'list' | 'chat'>('list');
	let sheet = $state(false);
	// The id this shell has already reacted to, so a selection made elsewhere
	// (the palette) opens the chat exactly once instead of on every poll.
	let seenId = $state(chat.activeId);

	const conv = $derived(chat.activeConversation);

	$effect(() => {
		const id = chat.activeId;
		// A conversation deleted, or a launch with none restored, is not a chat
		// screen: fall back rather than sit on an empty frame.
		if (!id) {
			screen = 'list';
			return;
		}
		if (id !== seenId) {
			seenId = id;
			screen = 'chat';
		}
	});

	function open(id: string) {
		seenId = id;
		screen = 'chat';
		void chat.select(id);
	}
</script>

<div class="shell" class:inchats={screen === 'chat'}>
	<!-- The pane off to the side is inert: nothing under the edge of the screen
	     should take a tap or a Tab, and a phone keyboard must not find it. -->
	<div class="pane list" inert={screen === 'chat'}>
		<ChatList onOpen={open} {onPalette} {onMarketplace} {onSettings} {onRetry} {failed} />
	</div>
	<div class="pane thread" inert={screen === 'list'}>
		{#if conv}
			<ChatScreen onBack={() => (screen = 'list')} onPanel={() => (sheet = true)} {onTasks} />
		{/if}
	</div>
</div>

{#if sheet}
	<BotSheet onClose={() => (sheet = false)} {onEditBot} {onRoutine} />
{/if}

<!-- The bot card lives on the shell so a name tap anywhere opens it. -->
<BotDetail />

<style>
	.shell {
		position: relative;
		height: 100dvh;
		overflow: hidden;
		background: var(--bg);
	}
	.pane {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		transition: transform 0.26s ease;
		will-change: transform;
	}
	.thread {
		transform: translateX(100%);
	}
	/* The list slides most of the way out rather than all of it: the edge that
	   is left is what makes the chat read as sitting on top of it. */
	.shell.inchats .list {
		transform: translateX(-22%);
	}
	.shell.inchats .thread {
		transform: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.pane {
			transition: none;
		}
	}
</style>
