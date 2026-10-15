<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import type { Peer } from '$lib/types';

	/**
	 * The Federation tab: pair this lounge's bots with bots in other lounges by
	 * exchanging copy-paste invites. Everything here is the human's hands - the
	 * bots themselves only ever speak through the signed messages.
	 */
	let botId = $state('');
	let inviteBlob = $state('');
	let inviteFp = $state('');
	let paste = $state('');
	let note = $state('');
	let busy = $state(false);
	let copied = $state(false);
	let peers = $state<Peer[]>([]);

	const botPicked = $derived(botId || chat.visibleBots[0]?.id || '');

	$effect(() => {
		// Keep standing on a real bot when one is deleted under us.
		if (!chat.visibleBots.some((b) => b.id === botPicked)) botId = chat.visibleBots[0]?.id ?? '';
	});

	async function loadPeers() {
		if (!botPicked) return;
		const res = await fetch(`/api/fed/peers?bot_id=${encodeURIComponent(botPicked)}`).catch(() => null);
		if (res?.ok) peers = ((await res.json()) as { peers: Peer[] }).peers;
	}

	$effect(() => {
		void loadPeers();
	});

	/** Make an invite blob from this lounge's side, ready to hand to a peer. */
	async function makeInvite() {
		if (!botPicked) return;
		busy = true;
		note = '';
		try {
			const res = await fetch('/api/fed/invite', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ bot_id: botPicked, endpoint: `${location.origin}/fed/${botPicked}` })
			});
			if (!res.ok) {
				note = 'The invite could not be made.';
				return;
			}
			const data = (await res.json()) as { blob: string; fingerprint: string };
			inviteBlob = data.blob;
			inviteFp = data.fingerprint;
			copied = false;
		} finally {
			busy = false;
		}
	}

	async function connect() {
		if (!botPicked || !paste.trim()) return;
		busy = true;
		note = '';
		try {
			const res = await fetch('/api/fed/peers', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					bot_id: botPicked,
					invite: paste.trim(),
					endpoint: `${location.origin}/fed/${botPicked}`
				})
			});
			const data = (await res.json().catch(() => null)) as
				| { peer?: Peer; confirmed?: boolean; error?: string }
				| null;
			paste = '';
			note =
				data?.confirmed
					? `Paired with ${data.peer?.name}.`
					: `Registered ${data?.peer?.name} here, but their side did not confirm (${data?.error}). They can paste your invite to finish.`;
			void loadPeers();
		} finally {
			busy = false;
		}
	}

	async function remove(id: string) {
		await fetch(`/api/fed/peers?id=${id}`, { method: 'DELETE' });
		void loadPeers();
	}

	async function setBlocked(id: string, blocked: boolean) {
		await fetch('/api/fed/peers/block', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, blocked })
		});
		void loadPeers();
	}

	async function copyInvite() {
		try {
			await navigator.clipboard.writeText(inviteBlob);
			copied = true;
		} catch {
			// No clipboard (insecure context, denied): the invite is still on
			// screen to copy by hand.
		}
	}
</script>

<section class="sect">
	<h3>Invite a bot in</h3>
	<p class="hint">
		Hand an invite to another lounge's human; their side pastes it, and the pairing completes
		itself with a signed call back. One invite works once.
	</p>
	<select bind:value={botId} onchange={() => void loadPeers()}>
		{#each chat.visibleBots as b (b.id)}
			<option value={b.id}>{b.name}</option>
		{/each}
	</select>
	<button class="makedef" disabled={busy || !botPicked} onclick={() => void makeInvite()}>
		Create invite
	</button>
	{#if inviteBlob}
		<textarea class="blob" readonly rows={3} value={inviteBlob}></textarea>
		<div class="inviterow">
			<button class="makedef" onclick={() => void copyInvite()}>{copied ? 'Copied' : 'Copy'}</button>
			<span class="fp">this bot's fingerprint: <code>{inviteFp}</code></span>
		</div>
	{/if}
</section>

<section class="sect">
	<h3>Connect to a bot elsewhere</h3>
	<p class="hint">
		Paste an invite another lounge's human gave you. Their bot joins this lounge as an external
		bot with its own conversation.
	</p>
	<textarea
		class="blob"
		bind:value={paste}
		rows={3}
		placeholder="OBL-FED1.…"
	></textarea>
	<button class="makedef" disabled={busy || !paste.trim()} onclick={() => void connect()}>
		Connect
	</button>
	{#if note}<p class="hint">{note}</p>{/if}
</section>

<section class="sect">
	<h3>Paired bots</h3>
	{#if peers.length === 0}
		<p class="hint">None yet for this bot.</p>
	{:else}
		{#each peers as p (p.id)}
			<div class="peer">
				<span class="peername">🕵️ {p.name}</span>
				<span class="peerfp" title={p.endpoint}>{p.fingerprint}</span>
				{#if p.status === 'blocked'}<span class="blocked">blocked</span>{/if}
				<span class="gap"></span>
				<button class="peerbtn" disabled={busy} onclick={() => void remove(p.id)}>Remove</button>
				{#if p.status === 'paired'}
					<button class="peerbtn danger" disabled={busy} onclick={() => void setBlocked(p.id, true)}>Block</button>
				{:else}
					<button class="peerbtn" disabled={busy} onclick={() => void setBlocked(p.id, false)}>Unblock</button>
				{/if}
			</div>
		{/each}
	{/if}
</section>

<style>
	.sect {
		margin: 0 0 1.4rem;
	}
	.blob {
		display: block;
		width: 100%;
		margin: 0.5rem 0;
		padding: 0.45rem;
		font-family: var(--mono, monospace);
		font-size: 0.72rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-raised);
		color: var(--text);
		resize: vertical;
	}
	.inviterow {
		display: flex;
		align-items: center;
		gap: 0.7rem;
	}
	.fp {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.peer {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.35rem 0;
		border-bottom: 1px solid var(--border);
		font-size: 0.82rem;
	}
	.peername {
		font-weight: 500;
	}
	.peerfp {
		font-family: var(--mono, monospace);
		font-size: 0.68rem;
		color: var(--text-muted);
	}
	.blocked {
		font-size: 0.68rem;
		color: #ff6b6b;
	}
	.gap {
		flex: 1;
	}
	.peerbtn {
		font-size: 0.72rem;
		padding: 0.15rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}
	.peerbtn:hover {
		background: var(--bg-hover);
	}
	.peerbtn.danger:hover {
		color: #ff6b6b;
		border-color: #ff6b6b;
	}
</style>
