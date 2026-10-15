<script lang="ts">
	import { tick } from 'svelte';
	import { chat, bubbleLook, bubbleThemesOf, collapseBlankLines, oneLine } from '$lib/stores/chat.svelte';
	import { mentionRegex } from '$lib/mentions';
	import { nameMentions } from '$lib/name-mentions';
	import { botQuotesOf, type BotQuote } from '$lib/bot-quotes';
	import Markdown from './Markdown.svelte';
	import Avatar from './Avatar.svelte';
	import { bloatOf } from '$lib/bloat';
	import EmojiPicker from './EmojiPicker.svelte';
	import DelegateCard from './DelegateCard.svelte';
	import FedBanner from './FedBanner.svelte';
	import type { Message, Bot, BotProposal, BubbleTheme, ChangeRequest, SshRequest } from '$lib/types';

	/** Reported upward so a footer that should only exist at the bottom can hide. */
	let { atBottom = $bindable(true) }: { atBottom?: boolean } = $props();
	let container: HTMLDivElement;
	let secretCard: HTMLDivElement | undefined = $state();
	let copiedId = $state('');
	let secretName = $state('');
	let secretValue = $state('');
	let showValue = $state(false);
	/** True from the moment a handover leaves until it lands; the sandbox may need waking. */
	let handingOver = $state(false);
	/** Collapsed blocks the reader has reopened. */
	let opened = $state<Set<string>>(new Set());
	/** Bot messages the reader has folded away in a group chat. */
	let foldedBots = $state<Set<string>>(new Set());
	/** System notes (relays, routines, webhooks) the reader has opened. */
	let sysOpen = $state<Set<string>>(new Set());
	/** Police lines the reader has expanded; collapsed by default in a DM. */
	let policeOpen = $state<Set<string>>(new Set());
	/** System runs (>3 quiet rows in a row) the reader has expanded, by first row id. */
	let sysRunsOpen = $state<Record<string, boolean>>({});
	let toolOpen = $state<Set<string>>(new Set());
	/** Incoming bubbles that just landed while the reader watched, for the glow. */
	let fresh = $state<Set<string>>(new Set());
	/** Which SSH card's string was just copied, so the button can say so. */
	let copiedSsh = $state('');
	/** SSH asks being checked right now, by request id. */
	let checkingSsh = $state<Set<string>>(new Set());
	/** Editable host/user/port per ask, until the first check locks it in. */
	let sshEdits = $state<Record<string, { host: string; username: string; port: string }>>({});
	/**
	 * A slow clock. A live debug grant's badge counts down and vanishes on its
	 * own, which needs a re-render even when nothing else on the page changes.
	 */
	let accessClock = $state(Date.now());

	/**
	 * Light one bubble up for a moment - a message that just landed under the
	 * reader's eye, or the one a tapped quote jumped back to. The id is dropped
	 * again once the animation has had its say, so paging it out of the window
	 * and back does not replay it forever.
	 */
	function glow(id: string) {
		fresh = new Set([...fresh, id]);
		setTimeout(() => {
			if (!fresh.has(id)) return;
			const next = new Set(fresh);
			next.delete(id);
			fresh = next;
		}, 2400);
	}

	/**
	 * Narration the app itself posts while a bot works its computer. The rows
	 * stay in the database - the model reads them as context - but the feed
	 * never reads them out: the bot's 🧰 bubble (computerActing below) is the
	 * one place that news shows. Kind-checked so a bot's own words that happen
	 * to start with "Opening " keep their bubble.
	 */
	const COMPUTER_PROGRESS = /^Using the computer:|^Delegated:|^Still on it|^Opening |^Setting up its desktop/i;
	function isComputerProgress(m: Message): boolean {
		return m.kind === 'event' && COMPUTER_PROGRESS.test(m.content);
	}
	const displayMessages = $derived(
		chat.messages.filter((m) => m.role !== 'system' && !isComputerProgress(m))
	);

	function personaProposalOf(raw: string | undefined): { persona: string; note: string } | null {
		if (!raw) return null;
		try {
			const p = JSON.parse(raw);
			return { persona: String(p.persona ?? ''), note: String(p.note ?? '') };
		} catch {
			return null;
		}
	}

	/** The custom CSS the open chat's first bot dressed it in, if any. */
	const chatCss = $derived(
		chat.activeBots.map((b) => b.custom_css ?? '').find((c) => !!c) ?? ''
	);
	const cssBot = $derived(chat.activeBots.find((b) => !!b.custom_css));

	/**
	 * The bot's CSS, fenced to this thread via per-bot class .bot-{id}. Every rule
	 * is nested under that class, so a selector the bot writes can only ever match
	 * inside the message list for that bot's chat - never the rail, header, or another chat.
	 * The handles a bot can reach: `&` for the chat window itself, .col for the column,
	 * .row/.bubble for a message, .md for rendered markdown, .sname/.stamp for name and time,
	 * .day for dividers, .chips for reactions. The server has already sanitized the text;
	 * this is only scoping. (A `</style>` in the source would break out, which is exactly
	 * what the sanitizer is for.)
	 */
	const scopedCss = $derived(
		cssBot ? `.bot-${cssBot.id} {\n${cssBot.custom_css ?? ''}\n}` : chatCss ? `.bot-custom {\n${chatCss}\n}` : ''
	);
	/** The class the message list wears so scopedCss can match: the bot's own
	 *  fence, or the generic one when only a bare sheet is known. */
	const cssClass = $derived(cssBot ? `bot-${cssBot.id}` : chatCss ? 'bot-custom' : '');

	/**
	 * A tool/plugin milestone - the bot built or installed something. Working
	 * narration ("Using the computer:", "Still on it", ...) is not a milestone:
	 * it belongs in the 🧰 bubble and is filtered from the feed entirely.
	 */
	function isToolEvent(m: Message): boolean {
		if (m.kind === 'tool' || m.kind === 'plugin') return true;
		return m.kind === 'event' && /^Created (tool|plugin) "/i.test(m.content);
	}
	function toolLabel(m: Message): string {
		const named = m.content.match(/Created (tool|plugin) "([^"]+)"/i);
		if (named) return named[2];
		return m.kind === 'plugin' ? 'plugin' : 'tool';
	}
	function toggleTool(id: string) {
		const next = new Set(toolOpen);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		toolOpen = next;
	}
	type DiffChunk = { text: string; kind: 'same' | 'del' | 'ins' };
	function diffWords(a: string, b: string): DiffChunk[] {
		const aW = a.split(/(\s+)/);
		const bW = b.split(/(\s+)/);
		const cap = 600;
		const an = Math.min(aW.length, cap), bm = Math.min(bW.length, cap);
		const dp: number[][] = Array.from({ length: an + 1 }, () => Array(bm + 1).fill(0));
		for (let i = an - 1; i >= 0; i--) for (let j = bm - 1; j >= 0; j--) dp[i][j] = aW[i] === bW[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		const out: DiffChunk[] = [];
		let i = 0, j = 0;
		while (i < an && j < bm) {
			if (aW[i] === bW[j]) { out.push({ text: aW[i], kind: 'same' }); i++; j++; }
			else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ text: aW[i], kind: 'del' }); i++; }
			else { out.push({ text: bW[j], kind: 'ins' }); j++; }
		}
		while (i < an) { out.push({ text: aW[i++], kind: 'del' }); }
		while (j < bm) { out.push({ text: bW[j++], kind: 'ins' }); }
		if (aW.length > cap) out.push({ text: aW.slice(cap).join(''), kind: 'del' });
		if (bW.length > cap) out.push({ text: bW.slice(cap).join(''), kind: 'ins' });
		return out;
	}

	/**
	 * How much of the tail is mounted. Long threads only render the recent
	 * window - each message costs a full markdown parse - and the "earlier"
	 * control at the top grows it (and pages the server when it has more).
	 */
	const RENDER_WINDOW = 150;
	let shownCount = $state(RENDER_WINDOW);

	/** bubbleLook results by message id + content + theme set, so a new message
	 *  appended to the thread does not re-derive the look of every one before it. */
	const lookCache = new Map<string, { key: string; look: { theme: BubbleTheme | null; text: string } }>();

	/** Bot-quote matches by message id + content, same shape of caching as the
	 *  look cache above: a bot message's quotes only change when its content
	 *  does, and the matcher scans the recent tail every call otherwise. */
	const quoteCache = new Map<string, { key: string; quotes: BotQuote[] }>();

	/** The text a relayed message carries once its "Message from <name>:" prefix
	 *  is off - the bubble already says who sent it. */
	function relayText(m: Message): string {
		const sender = botOf(m)?.name;
		if (sender && m.content.startsWith(`Message from ${sender}: `)) {
			return m.content.slice(`Message from ${sender}: `.length);
		}
		return m.content.replace(/^Message from [^:]*: /, '');
	}

	/**
	 * A relay line as the DM shows it: 'Sender → Recipient: text'. The sender
	 * is the row's bot; the recipient is relay_to when the row carries it,
	 * otherwise the bot this DM belongs to - a relay in a one-bot chat can
	 * only have been aimed at its resident.
	 */
	function relayLine(m: Message): { from: string; to: string; text: string } {
		const from = botOf(m)?.name ?? 'a bot';
		const named = chat.botById(m.relay_to ?? '')?.name;
		// A relay in a one-bot chat can only have been aimed at its resident;
		// in a group room an unnamed target is the room itself, not whichever
		// bot happens to sort first.
		const to =
			named ??
			(chat.activeConversation?.kind === 'group'
				? 'the room'
				: (chat.activeBots[0]?.name ?? 'the room'));
		return { from, to, text: relayText(m) };
	}

	function lookOf(m: Message): { theme: BubbleTheme | null; text: string } {
		const themes = bubbleThemesOf(chat.botById(m.bot_id));
		const content = m.kind === 'relay' ? relayText(m) : m.content;
		const key = `${content}${themes}`;
		const hit = lookCache.get(m.id);
		if (hit && hit.key === key) return hit.look;
		const look = bubbleLook(content, themes);
		lookCache.set(m.id, { key, look });
		return look;
	}

	/** Each bot's newest message id, so a pending style proposal hangs off it. */
	const latestBotMsg = $derived.by(() => {
		const map = new Map<string, string>();
		for (const m of displayMessages) if (m.bot_id) map.set(m.bot_id, m.id);
		return map;
	});

	/** The text a bot message shows, with its directive dropped when it applied. */
	function bodyOf(m: Message): string {
		return m.bot_id ? lookOf(m).text : m.content;
	}

	/** The theme a bot message wears; null unless its directive named one it has. */
	function themeOf(m: Message): BubbleTheme | null {
		return m.bot_id ? lookOf(m).theme : null;
	}

	/**
	 * The quotes a bot message's text matches in the recent tail, cached by
	 * id + content like the look cache above. A human reply carries reply_to
	 * and renders the quote block through it; this is the same block for a bot
	 * that quotes in plain text. Relayed rows are skipped - their words are
	 * another bot's, and the thread already reads them as traffic reports.
	 */
	function botQuoteOf(m: Message): BotQuote[] {
		if (!m.bot_id || m.reply_to) return [];
		const key = m.content;
		const hit = quoteCache.get(m.id);
		if (hit && hit.key === key) return hit.quotes;
		const quotes = botQuotesOf(m, chat.messages);
		quoteCache.set(m.id, { key, quotes });
		return quotes;
	}

	/** Drop quote entries for messages no longer in the thread, so the cache
	 *  follows the same lifecycle as the look cache's conversation switch. */
	function dropQuotesNotIn(messages: Message[]) {
		const live = new Set(messages.map((m) => m.id));
		for (const id of quoteCache.keys()) {
			if (!live.has(id)) quoteCache.delete(id);
		}
	}


	/** The inline style a bot bubble wears: its approved restyle, theme over it. */
	function bubbleLookStyle(m: Message, bot: Bot | undefined): string | undefined {
		const fields = { ...(bot ? styleFields(bot.style) : {}), ...(themeOf(m) ?? {}) };
		return bubbleStyle(fields) || undefined;
	}

	/** The pending pitch for a new bot, by the bot that made it. */
	const botProposalsByBot = $derived.by(() => {
		const map = new Map<string, BotProposal>();
		for (const p of chat.botProposals) map.set(p.proposer_bot_id, p);
		return map;
	});

	type Segment =
		| { kind: 'msg'; m: Message; index: number }
		| { kind: 'collapsed'; id: string; msgs: Message[]; index: number }
		| { kind: 'sysrun'; id: string; msgs: Message[]; index: number };

	/**
	 * The quiet rows a run gathers: notes the app posted (events, routines,
	 * webhooks) and relays, which read as traffic reports rather than speech.
	 * Tool/plugin milestones wear cards of their own and never fold into a
	 * run; bubbles and the human's own lines always break one.
	 */
	function isSystemRow(m: Message): boolean {
		if (isToolEvent(m)) return false;
		if (m.kind === 'relay') return true;
		return m.role === 'user' && !!m.kind && m.kind !== 'secret' && m.kind !== 'delegate' && !m.bot_id;
	}

	/**
	 * Runs of context-excluded messages fold into one block, so a compacted
	 * backlog reads as a single "collapsed" line you can click open. A secret
	 * handover is kept out of the model's context too, but it is not compaction,
	 * so it always keeps its own bubble rather than hiding behind the fold.
	 * Consecutive system rows fold the same way once they pass three - below
	 * that they render as the individual lines they are.
	 */
	const segments = $derived.by(() => {
		const out: Segment[] = [];
		let run: Message[] = [];
		let runStart = 0;
		let sys: { m: Message; index: number }[] = [];
		const flush = () => {
			if (run.length) {
				out.push({ kind: 'collapsed', id: run[0].id, msgs: run, index: runStart });
				run = [];
			}
		};
		const flushSys = () => {
			if (!sys.length) return;
			if (sys.length > 3) {
				out.push({ kind: 'sysrun', id: sys[0].m.id, msgs: sys.map((x) => x.m), index: sys[0].index });
			} else {
				for (const x of sys) out.push({ kind: 'msg', m: x.m, index: x.index });
			}
			sys = [];
		};
		// Only the tail window is built: a message above it is not mounted, so
		// nothing needs its segment. `index` stays absolute so the row can still
		// look at its real neighbours for day dividers and run grouping.
		const from = Math.max(0, displayMessages.length - shownCount);
		for (let index = from; index < displayMessages.length; index++) {
			const m = displayMessages[index];
			if (m.excluded && m.kind !== 'secret') {
				flushSys();
				if (!run.length) runStart = index;
				run.push(m);
			} else if (isSystemRow(m)) {
				flush();
				sys.push({ m, index });
			} else {
				flush();
				flushSys();
				out.push({ kind: 'msg', m, index });
			}
		}
		flush();
		flushSys();
		return out;
	});

	/** Messages above the mounted window, plus any the server still holds. */
	const hiddenEarlier = $derived(
		Math.max(0, displayMessages.length - shownCount) + (chat.hasMoreMessages ? 1 : 0)
	);

	/**
	 * Grow the window, and page the server when the local list runs out. The
	 * scroll position is held against the first new row so the thread does not
	 * jump: prepending rows otherwise reads as a scroll to the top.
	 */
	async function showEarlier() {
		if (!container) return;
		const prevHeight = container.scrollHeight;
		const prevTop = container.scrollTop;
		shownCount += RENDER_WINDOW;
		if (displayMessages.length <= shownCount - RENDER_WINDOW && chat.hasMoreMessages) {
			await chat.loadEarlier();
		}
		await tick();
		container.scrollTop = container.scrollHeight - prevHeight + prevTop;
	}

	/**
	 * Whether the reader is following the bottom of the thread. Kept current by the
	 * scroll listener rather than measured when a message lands: by then Svelte has
	 * already grown the list, and the reader's untouched scrollTop looks like they
	 * left the bottom even though they never moved. Bound upward so a footer that
	 * only belongs at the bottom can hide while the reader is up in the backlog.
	 */
	function nearBottom(): boolean {
		if (!container) return true;
		return container.scrollHeight - container.scrollTop - container.clientHeight < 160;
	}

	/** Newest message the view has reacted to, and the chat it has landed in. */
	let seenKey = '';
	let landedConv = '';
	/** Newest message the reader saw land - the missed line only counts past it. */
	let seenThrough = $state(0);
	/** The running summary behind an opened fold; null until it is fetched. */
	let foldSummary = $state<string | null>(null);
	/** The police's verdict on the fold, fetched with the summary. */
	let foldReview = $state<{ verdict: string; reason: string } | null>(null);

	$effect(() => {
		// Ticks the debug-access countdown. The clock is read only by the badge, so
		// nothing else on the page re-renders with it.
		const timer = setInterval(() => (accessClock = Date.now()), 15_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		// The task poller swaps `messages` wholesale, so key off the newest message's
		// identity and size rather than the array length.
		const msgs = chat.messages;
		// Entries for rows the thread no longer holds are dead weight; drop them
		// on the same tick the cache is consulted, not on a separate sweep.
		dropQuotesNotIn(msgs);
		const last = msgs[msgs.length - 1];
		const key = `${last?.id ?? ''}:${last?.content?.length ?? 0}`;
		const conv = chat.activeId;

		const arrived = key !== seenKey;
		seenKey = key;

		// Sending is explicit intent; opening another chat starts at its newest message.
		// A relayed bot message carries a bot_id - it is incoming, not the reader's
		// own line, so it only follows a reader already at the bottom.
		const own = arrived && last?.role === 'user' && !last?.bot_id;
		const switched = conv !== landedConv;

		// A different chat starts at its newest page: the window and the look
		// cache belong to the thread that was open, not the one arriving.
		if (switched) {
			shownCount = RENDER_WINDOW;
			lookCache.clear();
			quoteCache.clear();
			// A new chat's backlog is not "missed" and nothing in it is fresh.
			seenThrough = 0;
			fresh = new Set();
			foldSummary = null;
		}
		if (!atBottom && !own && !switched) return;

		// A hidden tab is not watching, even though it never scrolled: the messages
		// that landed while it was away are exactly what the divider is for.
		const watching = atBottom && !document.hidden;
		// The reader is looking at the bottom when this lands, so it is seen - the
		// missed line only counts what arrives while they are away or scrolled up.
		if (arrived && !switched && watching && last) {
			seenThrough = Math.max(seenThrough, last.created_at);
		}
		// An incoming bubble that lands under the reader's eye gets a brief glow.
		if (arrived && !switched && watching && last && !own) glow(last.id);

		void (async () => {
			// Effects now run after the DOM patch, but the list's height is only final
			// once layout settles, so wait a tick before reading the scroll target.
			await tick();
			if (!container) return;
			container.scrollTop = container.scrollHeight;
			atBottom = true;
		})();

		// A selected chat's messages arrive a fetch later, so it only counts as landed
		// once it has content - the empty list is otherwise "the bottom" and the reader
		// is stranded above the history that loads a moment after.
		if (switched && msgs.length) landedConv = conv;
	});

	async function handOver(botId: string) {
		if (handingOver) return;
		handingOver = true;
		try {
			const ok = await chat.giveSecret(botId, secretName.trim(), secretValue);
			if (ok) {
				secretName = '';
				secretValue = '';
			}
		} finally {
			handingOver = false;
		}
	}

	/**
	 * The padlock appends the card to the bottom of the thread, so the reader's scroll
	 * position never moves and the card - "Hand it over" included - ends up past the
	 * scroll box, under the composer. Bring it into view as soon as it opens.
	 */
	$effect(() => {
		if (!chat.secretDraft || !secretCard) return;
		secretCard.scrollIntoView({ block: 'nearest' });
	});

	/** Which message is being read aloud, so the button can show it. */
	let speakingId = $state('');

	/** Read a reply out with the browser's speech synthesis. */
	function speak(m: Message) {
		if (!('speechSynthesis' in window)) return;
		if (speakingId === m.id) {
			window.speechSynthesis.cancel();
			speakingId = '';
			return;
		}
		window.speechSynthesis.cancel();
		const utterance = new SpeechSynthesisUtterance(
			bodyOf(m).replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '')
		);
		utterance.onend = () => (speakingId = '');
		utterance.onerror = () => (speakingId = '');
		speakingId = m.id;
		window.speechSynthesis.speak(utterance);
	}

	// The voice belongs to the thread it was reading: leaving the chat - or the
	// page - must not let it keep talking about a conversation that is gone.
	$effect(() => {
		chat.activeId;
		return () => {
			window.speechSynthesis?.cancel();
			speakingId = '';
		};
	});

	/**
	 * The message a thumb was just clicked on, and which way. The rating posts
	 * through chat.rate as before; this only drives the ~1s star burst over
	 * the bubble so the click reads as landed before the sel state settles.
	 */
	let burst = $state<{ id: string; good: boolean } | null>(null);
	let burstTimer: ReturnType<typeof setTimeout> | null = null;
	function rateMsg(m: Message, rating: 1 | -1) {
		if (m.id.startsWith('local-') || chat.streaming) return;
		void chat.rate(m.id, rating);
		burst = { id: m.id, good: rating === 1 };
		if (burstTimer) clearTimeout(burstTimer);
		burstTimer = setTimeout(() => (burst = null), 1000);
	}

	/** An ask's marker payload ({ssh_request}) parsed off its message, or null. */
	function sshMarkerOf(m: Message): { ssh_request?: string } | null {
		if (m.kind !== 'ssh') return null;
		try {
			const parsed = JSON.parse(m.content);
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch {
			return null;
		}
	}

	/** The ask this marker points at, or null when it was withdrawn. */
	function sshRequestOf(m: Message): SshRequest | null {
		const marker = sshMarkerOf(m);
		const id = marker?.ssh_request;
		if (!id) return null;
		return chat.sshRequests.find((r) => r.id === id) ?? null;
	}

	/** The change ask this marker points at, or null when it was answered. */
	function askOf(m: Message): ChangeRequest | null {
		try {
			const marker = JSON.parse(m.content) as { change_request?: string };
			const id = marker?.change_request;
			if (!id) return null;
			return chat.asks.find((r) => r.id === id) ?? null;
		} catch {
			return null;
		}
	}

	/** The one-liner the human runs once, on their own box, to let the key in. */
	function sshCopyIdCommand(req: SshRequest): string {
		return `ssh-copy-id -p ${req.port} ${req.username}@${req.host}`;
	}

	/** Copy any card string; a denied clipboard just leaves the button as it was. */
	async function copySshText(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return;
		}
		copiedSsh = key;
		setTimeout(() => {
			if (copiedSsh === key) copiedSsh = '';
		}, 1500);
	}

	/** The card's editable fields for one ask, seeded from the row. */
	function sshEditOf(req: SshRequest): { host: string; username: string; port: string } {
		return (
			sshEdits[req.id] ?? { host: req.host, username: req.username, port: String(req.port) }
		);
	}

	function setSshEdit(
		req: SshRequest,
		patch: Partial<{ host: string; username: string; port: string }>
	) {
		sshEdits = { ...sshEdits, [req.id]: { ...sshEditOf(req), ...patch } };
	}

	/** Run the check from the bot's machine; the card shows ok/failed after. */
	async function checkSsh(req: SshRequest) {
		if (checkingSsh.has(req.id)) return;
		checkingSsh = new Set([...checkingSsh, req.id]);
		try {
			const edit = sshEditOf(req);
			const port = Number(edit.port);
			const ok = await chat.checkSsh(
				req.id,
				req.status === 'pending'
					? {
							host: edit.host.trim(),
							username: edit.username.trim(),
							port: Number.isInteger(port) ? port : req.port
						}
					: undefined
			);
			// The row now holds the verdict; drop the draft edits so the card
			// shows what was actually tested.
			if (ok) {
				const next = { ...sshEdits };
				delete next[req.id];
				sshEdits = next;
			}
		} finally {
			const next = new Set(checkingSsh);
			next.delete(req.id);
			checkingSsh = next;
		}
	}

	async function copy(m: Message) {
		// What the reader sees, so a copied bubble never carries the directive.
		// A denied clipboard (permissions policy, unfocused tab) must not throw
		// an unhandled rejection - the button just does nothing.
		try {
			await navigator.clipboard.writeText(bodyOf(m));
		} catch {
			return;
		}
		copiedId = m.id;
		setTimeout(() => (copiedId = ''), 1500);
	}

	function botOf(m: Message) {
		return chat.botById(m.bot_id);
	}

	/** Parse a stored style/proposal JSON blob; '' or bad JSON reads as no fields. */
	function styleFields(json: string): Record<string, string> {
		try {
			const parsed = JSON.parse(json);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	/**
	 * The debug access a bot is holding, or null when it has none or the grant
	 * has run out - the row stays in the database, so the clock is what decides
	 * here too. `accessClock` is read so the badge re-renders as time passes.
	 */
	function debugAccess(bot: Bot | undefined): { expires_at: number; reason: string } | null {
		if (!bot?.debug_grant) return null;
		const grant = styleFields(bot.debug_grant);
		const expires = Number(grant.expires_at);
		void accessClock;
		return Number.isFinite(expires) && expires > Date.now()
			? { expires_at: expires, reason: grant.reason ?? '' }
			: null;
	}

	/** What is left of a grant, as the badge says it: "24 min", "under a minute". */
	function debugLeft(expiresAt: number): string {
		void accessClock;
		const minutes = Math.ceil((expiresAt - Date.now()) / 60_000);
		return minutes <= 1 ? 'under a minute' : `${minutes} min`;
	}

	/**
	 * The thinking-hard grant a bot is holding, or null when it has none or it
	 * has run out - same clock rule as debugAccess.
	 */
	function thinkingAccess(bot: Bot | undefined): { expires_at: number; reason: string } | null {
		if (!bot?.thinking_grant) return null;
		const grant = styleFields(bot.thinking_grant);
		const expires = Number(grant.expires_at);
		void accessClock;
		return Number.isFinite(expires) && expires > Date.now()
			? { expires_at: expires, reason: grant.reason ?? '' }
			: null;
	}

	/** The inline style a set of approved (or proposed) fields produces. */
	function bubbleStyle(fields: Record<string, string | undefined>): string {
		const parts: string[] = [];
		if (fields.font_family) parts.push(`font-family:${fields.font_family}`);
		if (fields.bubble_color) parts.push(`background:${fields.bubble_color}`);
		if (fields.text_color) parts.push(`color:${fields.text_color}`);
		if (fields.accent) parts.push(`border-left:3px solid ${fields.accent}`);
		if (fields.radius) parts.push(`border-radius:${fields.radius}`);
		return parts.join(';');
	}

	function toggle(id: string) {
		const next = new Set(opened);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		opened = next;
	}

	/** A message can only be answered once it is really stored - not mid-stream. */
	function canQuote(m: Message): boolean {
		return !m.id.startsWith('stream-') && !m.id.startsWith('local-');
	}

	/**
	 * Bring a quoted message back into view. It may be folded away, or above the
	 * mounted window, so the fold is opened - or the window grown - until the row
	 * is there to scroll to; then it is centred and lit up like a fresh arrival.
	 */
	async function jumpTo(id: string) {
		for (let tries = 0; tries < 40; tries++) {
			await tick();
			const el = container?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
			if (el) {
				el.scrollIntoView({ block: 'center', behavior: 'smooth' });
				glow(id);
				return;
			}
			const fold = segments.find(
				(s) => s.kind === 'collapsed' && s.msgs.some((x) => x.id === id)
			);
			if (fold?.kind === 'collapsed' && !opened.has(fold.id)) {
				openFold(fold.id);
				continue;
			}
			const run = segments.find((s) => s.kind === 'sysrun' && s.msgs.some((x) => x.id === id));
			if (run?.kind === 'sysrun' && !sysRunsOpen[run.id]) {
				toggleSysRun(run.id);
				continue;
			}
			if (hiddenEarlier > 0) {
				await showEarlier();
				continue;
			}
			return;
		}
	}

	/**
	 * Open a folded block. The summary it collapsed into is not on the message
	 * list, so it is fetched once, the first time a fold is opened, and kept for
	 * every fold in the chat.
	 */
	function openFold(id: string) {
		if (opened.has(id)) {
			toggle(id);
			return;
		}
		toggle(id);
		if (foldSummary !== null) return;
		const conv = chat.activeId;
		void fetch(`/api/conversations/${conv}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (chat.activeId === conv) {
					foldSummary = d?.summary ?? '';
					foldReview = d?.review ?? null;
				}
			})
			.catch(() => (foldSummary = ''));
	}

	function toggleBot(id: string) {
		const next = new Set(foldedBots);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		foldedBots = next;
	}

	function togglePolice(id: string) {
		const next = new Set(policeOpen);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		policeOpen = next;
	}

	function toggleSys(id: string) {
		const next = new Set(sysOpen);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		sysOpen = next;
	}

	/** A short label for a message the user did not type. */
	function sysLabel(m: Message): string {
		if (m.kind === 'relay' || m.content.startsWith('Message from ')) return '⇄ relay';
		// A line the human aimed at a turn already running in this room: it is
		// the human speaking, but it reads as a note rather than a bubble.
		if (m.kind === 'steer') return '⚡ steer';
		if (m.content.startsWith('[Lounge')) return ' lounge';
		if (m.content.startsWith('[Routine')) return ' routine';
		if (m.content.startsWith('[Scheduled')) return ' wake';
		if (m.content.startsWith('[Wait satisfied')) return ' wake';
		if (m.content.startsWith('[Webhook')) return ' webhook';
		return ' system';
	}

	/**
	 * Wrap @botname in a mention chip after the markdown renders. Runs on the
	 * rendered DOM so it works inside paragraphs, lists and code-free text
	 * without touching the markdown source. The user's own handle chips too -
	 * a bot that writes @you is asking for attention, and it should look like
	 * the ping it is, not plain text.
	 *
	 * The caller keys the .md node on mentionKey(body), so a changed body - or a
	 * new bot name - remounts it and this runs again on the fresh DOM. That
	 * remount is load-bearing, not just tidy: swapping a text node for a chip
	 * detaches the node SvelteMarkdown would otherwise rewrite in place, so an
	 * in-place update would leave the old words on screen. Re-walking is
	 * idempotent - a node already inside a chip is skipped - so a second pass
	 * never double-wraps.
	 */
	function mentions(node: HTMLElement) {
		const re = mentionRegex(chat.bots.map((b) => b.name));
		const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
		const targets: Text[] = [];
		let t: Text | null;
		while ((t = walker.nextNode() as Text | null)) {
			// Code is quoted verbatim: a handle inside a snippet is text the bot
			// wrote, not a ping, and a chip inside it reads as part of the code.
			// .mention is our own pill - skipping it keeps a re-walk from
			// wrapping the chip's own text a second time.
			if (t.parentElement?.closest('code, pre, .mention')) continue;
			// matchAll, not test(): a /g regex carries lastIndex between calls,
			// so a mention at the start of the node after a match would be skipped.
			if ([...t.nodeValue?.matchAll(re) ?? []].length) targets.push(t);
		}
		for (const textNode of targets) {
			const frag = document.createDocumentFragment();
			let last = 0;
			const value = textNode.nodeValue ?? '';
			for (const match of value.matchAll(re)) {
				const idx = match.index ?? 0;
				if (idx > last) frag.append(document.createTextNode(value.slice(last, idx)));
				const chip = document.createElement('span');
				chip.className = 'mention';
				chip.textContent = match[0];
				frag.append(chip);
				last = idx + match[0].length;
			}
			if (last < value.length) frag.append(document.createTextNode(value.slice(last)));
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	}

	/** The mention action's trigger: the body, plus the roster of names, so a
	 *  bot created after a message mounted still chips in it. */
	function mentionKey(body: string): string {
		return `${body}\u0000${chat.bots.map((b) => b.name).join('\u0000')}`;
	}
	function isEmojiOnly(text: string): boolean {
		const t = text.trim();
		if (!t || [...t].length > 8) return false;
		if (!/\p{Extended_Pictographic}/u.test(t)) return false;
		return !/[A-Za-z0-9.,!?;:'"()[\]{}<>/\\|@#$%^&*_+=~`-]/.test(t);
	}

	/**
	 * What the reader genuinely missed: bot lines newer than both the server's
	 * read mark and whatever landed while they were watching the bottom. A
	 * relayed message keeps role 'user' but carries the sender's bot_id, so it
	 * counts as something a bot said.
	 */
	const missed = $derived(
		displayMessages.filter(
			(x) =>
				x.created_at > Math.max(chat.unreadFrom, seenThrough) &&
				(x.role !== 'user' || !!x.bot_id)
		)
	);

	/** How to describe the gap since the user last looked. */
	function missedLabel(): string {
		const n = missed.length;
		return `${n} new message${n === 1 ? '' : 's'} while you were away`;
	}

	/**
	 * The bot composing right now, for the typing bubble at the foot of the
	 * thread: the one whose reply is streaming, or the one still at its keyboard.
	 * It steps aside the moment that bot's own bubble is the tail - an empty one
	 * already pulses its dots, and a filled one is the answer itself.
	 */
	const typingBot = $derived.by(() => {
		const id =
			chat.streamingBotId ||
			(chat.streaming || chat.botWorking ? (chat.activeBots[0]?.id ?? '') : '');
		if (!id) return undefined;
		const last = displayMessages[displayMessages.length - 1];
		if (last?.bot_id === id && last.id.startsWith('stream-')) return undefined;
		// A keyboard still warm from a turn that has already answered is not typing.
		if (!chat.streaming && last?.bot_id === id) {
			const typed = chat.activities.find((a) => a.bot_id === id && a.kind === 'typing');
			if (typed && last.created_at > typed.created_at) return undefined;
		}
		return chat.botById(id);
	});

	/**
	 * The words the composing bot has written so far, streamed live from the
	 * server. Empty until the first delta arrives, when the bubble keeps its
	 * dots - so a tool-only turn looks exactly as it did before.
	 */
	const composingText = $derived(typingBot ? chat.previewForBot(typingBot.id) : '');

	/**
	 * The background task behind the composing bot's current turn, if it is
	 * one: the tray knows it by title and age, the bubble only knew dots.
	 * `accessClock` is read so the age line re-renders as the seconds pass.
	 */
	const workingTask = $derived.by(() => {
		void accessClock;
		const id = typingBot?.id ?? '';
		if (!id) return null;
		return chat.runningTasks.find((t) => t.bot_id === id) ?? null;
	});

	/** How long that task has been going, in the bubble's own words. */
	function taskElapsed(t: { created_at: number }): string {
		const s = Math.max(1, Math.round((Date.now() - t.created_at) / 1000));
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return `${m}m ${s % 60}s`;
	}

	/** What the bubble calls the task: the server's generated title when it has one, else the ask itself. */
	function taskTitle(t: { prompt: string; title?: string; emoji?: string }): string {
		return oneLine(t.title || t.prompt, 60);
	}

	/** The typing bot the view has already followed down, so it follows once. */
	let followedTyping = '';

	/**
	 * The kinds that mean a bot is driving its computer rather than composing.
	 * A plugin call is machine work too - the bot handed its question to a
	 * plugin and is waiting on the answer - so it holds the 🧰 bubble like a
	 * shell step does.
	 * The left rail's indicator reads this list plus `sandbox`: from a list row
	 * a machine boot does look like work, but it is the box waking and building
	 * itself beside the bot's turn, not the bot at its machine, so it must never
	 * take over the composing bubble.
	 */
	const COMPUTER_ACTS = ['shell', 'browser', 'computer', 'task', 'plugin'];
	/**
	 * The kinds that mean the bot is at its keyboard composing a reply. The
	 * newest fresh activity is what the bot is doing now, so one of these wins
	 * the bubble back from the machine line even while a shell step from earlier
	 * in the same turn is still inside the fresh window.
	 */
	const COMPOSING_ACTS = ['thinking', 'typing'];
	/**
	 * One glyph per kind of work, so a glance at the "…" bubble says what the
	 * bot is up to: composing (thinking/typing), at a shell (shell/exec), in a
	 * browser, driving its machine (computer/delegate), on a task, or dreaming.
	 * Kinds with no entry - and a bot with no fresh activity at all - fall back
	 * to the sparkle.
	 */
	const ACTIVITY_EMOJI: Record<string, string> = {
		thinking: '💭',
		typing: '💭',
		shell: '⌨️',
		exec: '⌨️',
		browser: '🌐',
		computer: '🧰',
		delegate: '🧰',
		sandbox: '⚙️',
		task: '⏳',
		dreaming: '💤',
		wake: '⏰',
		routine: '🔁',
		webhook: '🪝',
		plugin: '🧩',
		secret: '🔑',
		police: '🚨',
		jail: '⛓️',
		replied: '💬'
	};
	const DEFAULT_EMOJI = '✨';
	/**
	 * The newest activity for the typing bot inside the fresh window, or null.
	 * Activities carry the bot's id (thread events do not) and include
	 * "Delegated:", which never lands in the thread at all; the cutoff keeps
	 * yesterday's shell grind from haunting today's typing bubble.
	 */
	function newestFreshActivity() {
		const id = typingBot?.id ?? '';
		if (!id) return null;
		const cutoff = Date.now() - 120_000;
		for (const a of chat.activities) {
			if (a.created_at < cutoff) break;
			if (a.bot_id !== id) continue;
			return a;
		}
		return null;
	}
	/** What the typing bot is doing now: its newest fresh activity, or null. */
	const freshActivity = $derived(newestFreshActivity());
	/**
	 * The bot's computer activity, or null when it is not at its machine. The
	 * one newest fresh activity decides on its own: a bot back at its keyboard
	 * is composing, and the shell step it ran a moment ago must not hold the
	 * bubble at its machine now that the thinking is newer.
	 */
	const computerActivity = $derived.by(() => {
		const a = freshActivity;
		if (!a || COMPOSING_ACTS.includes(a.kind)) return null;
		return COMPUTER_ACTS.includes(a.kind) ? a : null;
	});
	/**
	 * The computer-progress line the working bot's "…" bubble shows, or '' when
	 * it is not at its machine. The activity's own detail is the line - "Still
	 * on it - shell exec (step 6)", "Opening news.sky.com", "Took a screenshot"
	 * - clipped to one short line; the generic label is only for a detail-less
	 * activity.
	 */
	const computerActing = $derived.by(() => {
		const a = computerActivity;
		if (!a) return '';
		return a.detail.trim() ? oneLine(a.detail, 60) : 'using the computer…';
	});
	/** The computer sub-agent's step ceiling (MAX_STEPS in computer-agent.ts). */
	const COMPUTER_MAX_STEPS = 12;
	/** The "(step N)" the sub-agent stamps into its progress notes. */
	const STEP_RE = /\(step (\d+)\)/;
	/**
	 * How far along the working bot is, as a whole percent, or null when no step
	 * counter is known - the bar then shimmers rather than invent a number. The
	 * computer sub-agent notes "(step N)" every few steps; N over its 12-step
	 * ceiling is the fraction of the job done. The rail rides with the machine
	 * line, so a composing bot has no fraction at all - not even the one from
	 * the shell step it ran before going back to its keyboard.
	 */
	const progressPct = $derived.by(() => {
		const id = typingBot?.id ?? '';
		if (!id || !computerActivity) return null;
		const cutoff = Date.now() - 120_000;
		for (const a of chat.activities) {
			if (a.created_at < cutoff) break;
			if (a.bot_id !== id) continue;
			const m = STEP_RE.exec(a.detail);
			if (m) return Math.min(100, Math.round((Number(m[1]) / COMPUTER_MAX_STEPS) * 100));
		}
		return null;
	});
	/**
	 * The emoji the bubble shows for what the bot is doing right now: its newest
	 * fresh activity of any kind, which is the same activity the machine line
	 * names while the bot is at its computer. '' when nothing fresh is known,
	 * which leaves the plain bubble's dots as the fallback.
	 */
	const activityEmoji = $derived.by(() => {
		const a = freshActivity;
		return a ? (ACTIVITY_EMOJI[a.kind] ?? DEFAULT_EMOJI) : '';
	});

	/** Fold a system run open or closed - each run keeps its own state. */
	function toggleSysRun(id: string) {
		sysRunsOpen[id] = !sysRunsOpen[id];
	}

	/**
	 * The typing bubble is a brand-new last row, so a reader sitting at the bottom
	 * is pushed off it the moment a bot starts composing - the list only follows
	 * messages that arrive. Follow it down too, but only from the bottom: scrolled
	 * up, the reader is reading, and the row can wait below the fold.
	 */
	$effect(() => {
		const id = typingBot?.id ?? '';
		if (!id) {
			followedTyping = '';
			return;
		}
		if (id === followedTyping || !atBottom) return;
		followedTyping = id;
		void tick().then(() => {
			if (container) container.scrollTop = container.scrollHeight;
		});
	});

	function fmtTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	function fmtDay(ts: number): string {
		const d = new Date(ts);
		const today = new Date();
		if (d.toDateString() === today.toDateString()) return 'Today';
		const yesterday = new Date(today.getTime() - 86400_000);
		if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
		return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
	}

	/** Consecutive messages from the same sender share one avatar and name. */
	function sameSender(a: Message | undefined, b: Message): boolean {
		if (!a) return false;
		return a.role === b.role && a.bot_id === b.bot_id;
	}
</script>

{#snippet chips(m: Message)}
	{@const rs = chat.reactions[m.id] ?? []}
	{#if rs.length}
		<div class="chips">
			{#each rs as r (r.id)}
				<button
					class="chip"
					class:mine={r.actor === ''}
					title={r.actor === '' ? 'You' : (chat.botById(r.actor)?.name ?? 'bot')}
					onclick={() => r.actor === '' && chat.reactTo(m, r.emoji)}
				>
					{r.emoji}
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet ctxAndReact(m: Message)}
	<button
		class="act ctx"
		class:sel={!!m.excluded}
		title={m.excluded ? 'Add back to context' : 'Remove from context'}
		onclick={() => chat.toggleExcluded(m)}
	>
		{#if m.excluded}
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9M3 3l18 18"/></svg>
		{:else}
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
		{/if}
	</button>
	<EmojiPicker title="React" size={14} onselect={(e) => chat.reactTo(m, e)} />
{/snippet}

{#snippet copyBtn(m: Message)}
	<button class="act" title="Copy" onclick={() => copy(m)}>
		{#if copiedId === m.id}
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>
		{:else}
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
		{/if}
	</button>
{/snippet}

{#snippet quoteBtn(m: Message)}
	{#if canQuote(m)}
		<button class="act" title="Reply" onclick={() => (chat.quoteDraft = m)}>
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15 4 10l5-5"/><path d="M4 10h10a5 5 0 0 1 5 5v3"/></svg>
		</button>
	{/if}
{/snippet}

{#snippet quoted(m: Message)}
	{#if m.reply_to}
		{@const target = chat.messages.find((x) => x.id === m.reply_to)}
		{@const who = target ? (botOf(target)?.name ?? 'You') : 'Quoted message'}
		{@const line = target ? oneLine(bodyOf(target)) : 'no longer in this chat'}
		<button class="quote" onclick={() => void jumpTo(m.reply_to)} title="Jump to {who}'s message">
			<span class="quote-who">{who}</span>
			<span class="quote-text" class:dim={!target}>{line}</span>
		</button>
	{:else}
		<!-- A bot quoting another message in its own words: the same block, one
		     per matched line, each backed by a real row. A span in quotes that
		     matched nothing stays in the bubble as the plain text it was - the
		     matcher never invents a link. -->
		{#each botQuoteOf(m) as q (q.source.id)}
			<button
				class="quote"
				onclick={() => void jumpTo(q.source.id)}
				title="Jump to {chat.botById(q.source.bot_id)?.name ?? 'the quoted message'}'s message"
			>
				<span class="quote-who">{chat.botById(q.source.bot_id)?.name ?? 'Quoted message'}</span>
				<span class="quote-text">{oneLine(q.text)}</span>
			</button>
		{/each}
	{/if}
{/snippet}

{#snippet sysNote(m: Message)}
	{@const open = sysOpen.has(m.id)}
	<div class="row sys" data-mid={m.id}>
		<button class="sysnote" class:open onclick={() => toggleSys(m.id)} title={open ? 'Fold' : 'Read it'}>
			<span class="sys-label">{sysLabel(m)}</span>
			{#if open}
				<span class="sys-body">{collapseBlankLines(m.content)}</span>
			{:else}
				<span class="sys-peek">{oneLine(m.content)}</span>
			{/if}
		</button>
	</div>
{/snippet}

{#snippet relayNote(m: Message)}
	{@const line = relayLine(m)}
	<div class="row sys" data-mid={m.id}>
		<span class="relayline">
			<span class="relaywho">{line.from} → {line.to}:</span>
			{line.text}
		</span>
	</div>
{/snippet}

{#snippet messageRow(m: Message, i: number, prev: Message | undefined, next: Message | undefined)}
	{@const bot = botOf(m)}
	{@const group = chat.activeConversation?.kind === 'group'}
	{@const firstOfRun = !sameSender(prev, m)}
	{@const lastOfRun = !sameSender(next, m)}
	<!-- A bot speaking in a chat it does not belong to: the police walking in, a
	     bot that was handed the ask. It is not the room's own voice, so it must not
	     look like one - see the guest treatment below. -->
	{@const foreign = !!bot && !chat.activeBots.some((b) => b.id === m.bot_id)}

	{#if !prev || fmtDay(prev.created_at) !== fmtDay(m.created_at)}
		<div class="day"><span>{fmtDay(m.created_at)}</span></div>
	{/if}

	<!-- Once, before the first bot line the reader has not seen - not before
	     every one, and never for messages they watched land. Nothing missed
	     means nothing to divide: no count, and no divider to read. -->
	{#if missed.length > 0 && m.id === missed[0]?.id}
		<div class="missed">
			<span class="pill">{missedLabel()}</span>
			{#if chat.catchup}
				<p class="digest">{chat.catchup}</p>
			{/if}
		</div>
	{/if}

	{#if m.kind === 'secret'}
		<div class="row out" class:last={lastOfRun} data-mid={m.id}>
			<div class="stack">
				<div class="secretdone">
					<span>🔒</span>
					<span class="sectext">
						You gave <strong>{botOf(m)?.name ?? 'bot'}</strong> the secret <code>{m.content}</code>
					</span>
					<span class="stamp">{fmtTime(m.created_at)}</span>
				</div>
			</div>
		</div>
	{:else if m.kind === 'delegate'}
		<!-- A bot handed the ask to another bot: a card, not a bubble. -->
		<DelegateCard {m} />
	{:else if m.kind === 'ssh'}
		<!-- A bot asking for shell on the human's box: the card carries the ask,
		     the bot's public key to install, and the check that runs from its machine. -->
		{@const sshReq = sshRequestOf(m)}
		{#if sshReq}
			{@const sshEdit = sshEditOf(sshReq)}
			{@const sshLocked = sshReq.status !== 'pending'}
			{@const sshChecking = checkingSsh.has(sshReq.id)}
			{@const sshPubkey = botOf(m)?.ssh_public_key ?? ''}
			<div class="row" data-mid={m.id}>
				<div class="stack">
					<div class="proposalcard sshcard">
						<div class="proposalhead">
							<span>🔑 {botOf(m)?.name ?? 'bot'} is asking for SSH access</span>
							{#if sshReq.status === 'ok'}
								<span class="sshok">● connected</span>
							{:else if sshReq.status === 'failed'}
								<span class="sshfail">● check failed</span>
							{:else}
								<span class="sshpending">● waiting for key install</span>
							{/if}
						</div>
						<div class="sshfields">
							<label>Host<input value={sshEdit.host} disabled={sshLocked} oninput={(e) => setSshEdit(sshReq, { host: e.currentTarget.value })} /></label>
							<label>User<input value={sshEdit.username} disabled={sshLocked} oninput={(e) => setSshEdit(sshReq, { username: e.currentTarget.value })} /></label>
							<label class="sshport">Port<input value={sshEdit.port} disabled={sshLocked} inputmode="numeric" oninput={(e) => setSshEdit(sshReq, { port: e.currentTarget.value })} /></label>
						</div>
						{#if sshPubkey}
							<div class="sshkeyrow">
								<code class="sshkey">{sshPubkey}</code>
								<button class="sshcopy" onclick={() => copySshText(`key-${sshReq.id}`, sshPubkey)}>{copiedSsh === `key-${sshReq.id}` ? 'Copied ✓' : 'Copy key'}</button>
							</div>
							<div class="sshkeyrow">
								<code class="sshkey">{sshCopyIdCommand({ ...sshReq, host: sshEdit.host, username: sshEdit.username, port: Number(sshEdit.port) || sshReq.port })}</code>
								<button class="sshcopy" onclick={() => copySshText(`cmd-${sshReq.id}`, sshCopyIdCommand({ ...sshReq, host: sshEdit.host, username: sshEdit.username, port: Number(sshEdit.port) || sshReq.port }))}>{copiedSsh === `cmd-${sshReq.id}` ? 'Copied ✓' : 'Copy'}</button>
							</div>
							<p class="sshhint">On your box, run the ssh-copy-id line once (it asks for your password), then Check connection.</p>
						{/if}
						{#if sshReq.last_error}
							<p class="ssherror">{sshReq.last_error}</p>
						{/if}
						<div class="proposalbtns">
							<button class="proposalok" disabled={sshChecking} onclick={() => checkSsh(sshReq)}>{sshChecking ? 'Checking…' : 'Check connection'}</button>
							<button class="proposalno" onclick={() => chat.deleteSshRequest(sshReq.id)}>Withdraw</button>
						</div>
					</div>
				</div>
			</div>
		{:else}
			<div class="row" data-mid={m.id}>
				<div class="stack">
					<div class="secretdone">
						<span>🔑</span>
						<span class="sectext">SSH request withdrawn</span>
						<span class="stamp">{fmtTime(m.created_at)}</span>
					</div>
				</div>
			</div>
		{/if}
	{:else if m.kind === 'ask'}
		<!-- A bot asking the human for a change it cannot make itself: the card
		     carries the ask and the Approve/Deny ruling. -->
		{@const ask = askOf(m)}
		{#if ask}
			<div class="row" data-mid={m.id}>
				<div class="stack">
					<div class="proposalcard">
						<div class="proposalhead">
							<span>🛠 {ask.bot_name ?? botOf(m)?.name ?? 'bot'} is asking for a change</span>
							<span class="sshpending">● waiting for you</span>
						</div>
						<p class="askneed">{ask.need}</p>
						{#if ask.reason}
							<p class="askreason">{ask.reason}</p>
						{/if}
						<div class="proposalbtns">
							<button class="proposalok" onclick={() => chat.resolveAsk(ask.id, true)}>Approve</button>
							<button class="proposalno" onclick={() => chat.resolveAsk(ask.id, false)}>Deny</button>
						</div>
					</div>
				</div>
			</div>
		{:else}
			<div class="row" data-mid={m.id}>
				<div class="stack">
					<div class="secretdone">
						<span>🛠</span>
						<span class="sectext">Request answered</span>
						<span class="stamp">{fmtTime(m.created_at)}</span>
					</div>
				</div>
			</div>
		{/if}
	{:else if isToolEvent(m)}
		<!-- A tool/plugin milestone: what the bot built, one quiet card. Click
		     to read the full line; click again to fold it back. -->
		{@const open = toolOpen.has(m.id)}
		<div class="row" data-mid={m.id}>
			<button
				class="toolbubble"
				class:open
				aria-expanded={open}
				onclick={() => toggleTool(m.id)}
				title={open ? 'Hide detail' : 'Show detail'}
			>
				<span class="toolhead">
					<span class="toolname">{toolLabel(m)}</span>
					<span class="toolpreview">{oneLine(m.content)}</span>
				</span>
				{#if open}
					<span class="tooldetail">{collapseBlankLines(m.content)}</span>
				{/if}
			</button>
		</div>
	{:else if m.kind === 'relay'}
		<!-- A relayed line: a traffic report, not the room's own voice - who
		     passed what to whom, in the muted system voice. -->
		{@render relayNote(m)}
	{:else if m.kind === 'webhook'}
		<!-- An inbound webhook payload: a styled bubble of its own, so an
		     outside service's delivery reads as a real event in the thread,
		     not another grey app note. -->
		<div class="row in" class:last={lastOfRun} data-mid={m.id}>
			<span class="avatar"><span class="hookicon" aria-hidden="true">🪝</span></span>
			<div class="stack">
				<div class="bubble in webhook" class:fresh={fresh.has(m.id)}>
					<span class="hooktag">webhook</span>
					<span class="body">{bodyOf(m)}</span>
					<span class="stamp">{fmtTime(m.created_at)}</span>
				</div>
			</div>
		</div>
	{:else if m.role === 'user' && m.kind && m.kind !== 'secret' && !m.bot_id}
		<!-- A message the user did not type: a routine, a webhook, an app note.
		     It reads as a quiet note rather than the user's own bubble, and
		     expands on click. A relayed bot message carries the sender's bot_id
		     and is rendered as a relay line above. -->
		{@render sysNote(m)}
	{:else if m.role === 'user' && !m.bot_id}
		<div class="row out" class:last={lastOfRun} class:muted={!!m.excluded} data-mid={m.id}>
			<div class="stack">
				{@render quoted(m)}
				<div class="bubble out" class:big={isEmojiOnly(bodyOf(m))} class:fresh={fresh.has(m.id)}>
					<span class="body">{collapseBlankLines(bodyOf(m))}</span>
					<span class="stamp"
						>{fmtTime(m.created_at)}{#if m.steered}<span
								class="steered"
								title="This line steered a turn that was already running"
								><span aria-hidden="true">⚡</span> steered</span
							>{/if}</span
					>
				</div>
				{@render chips(m)}
				{#if !m.id.startsWith('stream-') || !chat.streaming}
					<div class="actions">
						{@render ctxAndReact(m)}
						{@render quoteBtn(m)}
						{@render copyBtn(m)}
					</div>
				{/if}
			</div>
		</div>
	{:else}
		{@const streaming = m.id.startsWith('stream-')}
		{@const collapsed = group && !streaming && foldedBots.has(m.id)}
		<!-- The officer's drop-ins read as a quiet grey ticket in a DM: the hat,
		     a five-word peek, and a chevron to open the whole line. -->
		{@const policeCollapsed = !group && !!bot?.hidden && !streaming && !policeOpen.has(m.id)}
		<div
			class="row in"
			class:last={lastOfRun}
			class:muted={!!m.excluded}
			class:guest={foreign}
			style:--who={bot?.color ?? '#4f8ef7'}
			data-mid={m.id}
		>
			{#if firstOfRun || collapsed}
				<span class="avatar" class:named={(group || foreign) && !!bot}>
					<Avatar
						color={bot?.color ?? '#4f8ef7'}
						seed={bot?.id ?? m.bot_id}
						size={30}
						hat={bot?.hat ?? ''}
						bloat={bot ? bloatOf(bot) : 0}
						talking={chat.streamingBotId === m.bot_id}
						activity={chat.activityKindFor(bot?.id ?? m.bot_id)}
						usage={bot}
					/>
				</span>
			{:else}
				<span class="avatar-spacer"></span>
			{/if}

			{#if collapsed}
				<!-- A folded bot message: the bot's face, name and a one-line peek in a
				     quieter card. Click to read it; click again to fold it back. -->
				<button
					class="peek"
					class:injected={m.kind === 'injected'}
					onclick={() => toggleBot(m.id)}
					title="Show message"
				>
					<span class="peek-head">
						{#if bot}<span class="peek-name" style:color={bot.color}>{bot.name}</span>{/if}
						{#if m.kind === 'injected'}<span class="peek-tag">planted</span>{/if}
						<span class="peek-text">{oneLine(bodyOf(m))}</span>
					</span>
					<svg class="peek-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
				</button>
			{:else if policeCollapsed}
				<!-- The officer's line in a DM: a grey ticket with the hat and a
				     five-word peek - the whole message is one click away. -->
				<button class="peek policepeek" onclick={() => togglePolice(m.id)} title="Show the police's note">
					<span class="peek-head">
						<span class="peek-tag policehat" title="the police">👮</span>
						<span class="peek-text">{oneLine(bodyOf(m), 40)}</span>
					</span>
					<svg class="peek-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
				</button>
			{:else}
				{@const theme = themeOf(m)}
				{@const body = bodyOf(m)}
				<div class="stack">
					{#if (group || foreign) && firstOfRun && bot}
						<button class="sname" style:color={bot.color} onclick={() => toggleBot(m.id)} title="Fold message">{bot.name}</button>
						{#if foreign}
							<span class="guest-tag" title="Not this chat's bot">guest</span>
						{/if}
					{/if}
					{@render quoted(m)}
					<div
						class="bubble in"
						class:big={isEmojiOnly(body)}
						class:fresh={fresh.has(m.id)}
						class:police={!!bot?.hidden && m.kind !== 'fed'}
						class:warning={m.kind === 'warning'}
						class:fed={m.kind === 'fed'}
						class:rated={burst?.id === m.id}
						style={bubbleLookStyle(m, bot)}
					>
						{#if burst?.id === m.id}
							<!-- The thumb's ~1s answer: a star burst over the bubble, then
							     the sel state on the button carries it from there. -->
							<span class="starburst" class:bad={!burst.good} aria-hidden="true">
								<i>✦</i><i>✦</i><i>✦</i><i>✦</i><i>✦</i><i>✦</i>
							</span>
						{/if}
						{#if theme}
							<span class="tbadge">{theme.badge ? `${theme.badge} ` : ''}{theme.name}</span>
						{/if}
						{#if m.kind === 'fed'}
							<span class="fedtag">🕵️ from another bot</span>
						{/if}
						{#if body}
							{#if isEmojiOnly(body)}
								<span class="emoji">{body}</span>
							{:else}
								{#key mentionKey(body)}
									<div class="md" use:mentions use:nameMentions={chat.bots}><Markdown source={body} /></div>
								{/key}
							{/if}
						{:else if streaming}
							<div class="thinking">
								<span class="dot"></span><span class="dot"></span><span class="dot"></span>
							</div>
						{/if}
						{#if m.image}
							<!-- A screenshot the bot sent into the thread: the picture is
							     served from the same shots directory the screen panel reads,
							     and opens full size in a new tab. -->
							<a class="shot" href="/api/shots/{m.image}" target="_blank" rel="noreferrer">
								<img src="/api/shots/{m.image}" alt="screenshot" loading="lazy" />
							</a>
						{/if}
						<span class="stamp">{fmtTime(m.created_at)}</span>
					</div>
					{@render chips(m)}
					{#if bot?.style_proposal && latestBotMsg.get(bot.id) === m.id}
						{@const proposal = styleFields(bot.style_proposal)}
						<div class="proposalcard">
							<div class="proposalhead">
								<span>{bot.name} wants to restyle their bubbles</span>
								{#if proposal.note}<span class="proposalnote">“{proposal.note}”</span>{/if}
							</div>
							<div class="stylepreview" style={bubbleStyle(proposal) || undefined}>
								{bot.name}'s bubbles could look like this
							</div>
							<div class="proposalbtns">
								<button class="proposalok" onclick={() => chat.approveStyle(bot.id, true)}>Approve</button>
								<button class="proposalno" onclick={() => chat.approveStyle(bot.id, false)}>Decline</button>
							</div>
						</div>
					{/if}

					{#if bot && botProposalsByBot.has(bot.id) && latestBotMsg.get(bot.id) === m.id}
						{@const pitch = botProposalsByBot.get(bot.id)!}
						{@const draft = styleFields(pitch.payload)}
						<div class="proposalcard">
							<div class="proposalhead">
								<span>{bot.name} wants to create a new bot</span>
								{#if draft.note}<span class="proposalnote">“{draft.note}”</span>{/if}
							</div>
							<div class="botpreview">
								<Avatar color={draft.color || '#4f8ef7'} seed={draft.name} size={30} />
								<div class="botwho">
									<span class="botname">{draft.name}</span>
									<span class="botmodel">{draft.model || 'the default model'}</span>
								</div>
							</div>
							{#if draft.persona}<p class="botpersona">{draft.persona}</p>{/if}
							<div class="proposalbtns">
								<button class="proposalok" onclick={() => chat.approveBotProposal(pitch.id, true)}>Approve</button>
								<button class="proposalno" onclick={() => chat.approveBotProposal(pitch.id, false)}>Decline</button>
							</div>
						</div>
					{/if}

					{#if bot?.theme_proposal && latestBotMsg.get(bot.id) === m.id}
						{@const pitch = styleFields(bot.theme_proposal)}
						<div class="proposalcard">
							<div class="proposalhead">
								<span>{bot.name} wants a bubble theme called “{pitch.name}”</span>
								{#if pitch.note}<span class="proposalnote">“{pitch.note}”</span>{/if}
							</div>
							<div class="stylepreview" style={bubbleStyle(pitch) || undefined}>
								{#if pitch.badge}<span class="tbadge">{pitch.badge}</span>{/if}
								{bot.name}'s “{pitch.name}” bubbles could look like this
							</div>
							<div class="proposalbtns">
								<button class="proposalok" onclick={() => chat.approveTheme(bot.id, true)}>Approve</button>
								<button class="proposalno" onclick={() => chat.approveTheme(bot.id, false)}>Decline</button>
							</div>
						</div>
					{/if}

					{#if bot && (bot as unknown as { persona_proposal?: string }).persona_proposal && latestBotMsg.get(bot.id) === m.id}
						{@const pp = personaProposalOf((bot as unknown as { persona_proposal?: string }).persona_proposal)}
						{#if pp}
							{@const chunks = diffWords(bot.persona ?? '', pp.persona)}
							<div class="proposalcard personacard">
								<div class="proposalhead"><span>{bot.name} wants to change their persona</span>{#if pp.note}<span class="proposalnote">“{pp.note}”</span>{/if}</div>
								<div class="personadiff" aria-label="Persona diff">
									{#each chunks as c, idx (idx)}
										{#if c.kind === 'same'}<span class="pdiff-same">{c.text}</span>{:else if c.kind === 'del'}<span class="pdiff-del">{c.text}</span>{:else}<span class="pdiff-ins">{c.text}</span>{/if}
									{/each}
								</div>
								<div class="proposalbtns"><button class="proposalok" onclick={() => chat.approvePersona(bot.id, true)}>Accept</button><button class="proposalno" onclick={() => chat.approvePersona(bot.id, false)}>Deny</button></div>
							</div>
						{/if}
					{/if}

					{#if bot?.debug_request && latestBotMsg.get(bot.id) === m.id}
						{@const ask = styleFields(bot.debug_request)}
						<div class="proposalcard debugcard">
							<div class="proposalhead">
								<span>🔧 {bot.name} is asking for debug access</span>
								{#if ask.reason}<span class="proposalnote">“{ask.reason}”</span>{/if}
							</div>
							<p class="debugnote">
								Approving hands over every setting, every bot's state and every
								conversation - including rooms {bot.name} is not in - for 30 minutes,
								with every call it makes written to its activity log. Secret values
								are never part of it. You can revoke it at any time.
							</p>
							<div class="proposalbtns">
								<button class="proposalok" onclick={() => chat.approveDebug(bot.id, true)}>Approve</button>
								<button class="proposalno" onclick={() => chat.approveDebug(bot.id, false)}>Decline</button>
							</div>
						</div>
					{/if}

					{#if bot && debugAccess(bot) && latestBotMsg.get(bot.id) === m.id}
						{@const grant = debugAccess(bot)!}
						<div class="debugbadge">
							<span>🔧 debug access: granted, expires in {debugLeft(grant.expires_at)}</span>
							<button class="proposalno" onclick={() => chat.approveDebug(bot.id, false, true)}>Revoke</button>
						</div>
					{/if}

					{#if bot?.thinking_request && latestBotMsg.get(bot.id) === m.id}
						{@const ask = styleFields(bot.thinking_request)}
						<div class="proposalcard debugcard">
							<div class="proposalhead">
								<span>🧠 {bot.name} is asking to think hard</span>
								{#if ask.reason}<span class="proposalnote">“{ask.reason}”</span>{/if}
							</div>
							<p class="debugnote">
								Approving runs its turns at the provider's maximum effort for 30
								minutes instead of the usual low one - slower and dearer, and
								it lapses on its own. You can revoke it at any time.
							</p>
							<div class="proposalbtns">
								<button class="proposalok" onclick={() => chat.approveThinking(bot.id, true)}>Approve</button>
								<button class="proposalno" onclick={() => chat.approveThinking(bot.id, false)}>Decline</button>
							</div>
						</div>
					{/if}

					{#if bot && thinkingAccess(bot) && latestBotMsg.get(bot.id) === m.id}
						{@const grant = thinkingAccess(bot)!}
						<div class="debugbadge">
							<span>🧠 thinking hard: granted, expires in {debugLeft(grant.expires_at)}</span>
							<button class="proposalno" onclick={() => chat.approveThinking(bot.id, false, true)}>Revoke</button>
						</div>
					{/if}

					{#if !streaming || !chat.streaming}
						<div class="actions">
							{@render ctxAndReact(m)}
							{@render quoteBtn(m)}
							<button
								class="act"
								class:sel={speakingId === m.id}
								title={speakingId === m.id ? 'Stop reading' : 'Read aloud'}
								onclick={() => speak(m)}
							>
								<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>
							</button>
							{@render copyBtn(m)}
							<button class="act rate" class:sel={m.rating === 1} title="Good" onclick={() => rateMsg(m, 1)}>
								<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z"/></svg>
							</button>
							<button class="act rate" class:sel={m.rating === -1} title="Bad" onclick={() => rateMsg(m, -1)}>
								<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:scaleY(-1)"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z"/></svg>
							</button>
							{#if !m.id.startsWith('local-') && !streaming}
								<button
									class="act danger"
									title="Delete this message"
									onclick={() => {
										if (confirm('Delete this message for good?')) chat.deleteMessage(m.id);
									}}
								>
									<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>
								</button>
							{/if}

							{#if i === displayMessages.length - 1 && !chat.streaming && m.role === 'assistant'}
								<button class="act" title="Regenerate" onclick={() => chat.regenerate(m)}>
									<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
								</button>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

<!-- A paired external bot keeps a pinned strip above the thread: pinned, so
     it never scrolls away with the messages it describes. -->
<FedBanner />
	<div class="scroll {cssClass}" bind:this={container} onscroll={() => (atBottom = nearBottom())}>
		<!-- The bot's approved chat sheet, fenced to this thread by cssClass. The
		     server sanitized the text; this is the scoping the comment above describes. -->
		{#if scopedCss}{@html `<style>${scopedCss}</style>`}{/if}
		<div class="col">
		{#if hiddenEarlier > 0}
			<button class="earlier" disabled={chat.loadingEarlier} onclick={() => void showEarlier()}>
				{chat.loadingEarlier ? 'Loading…' : 'Show earlier messages'}
			</button>
		{/if}

		{#each segments as seg (seg.kind === 'msg' ? seg.m.id : seg.kind === 'sysrun' ? `sysrun-${seg.id}` : `c-${seg.id}`)}
			{#if seg.kind === 'msg'}
				{@render messageRow(seg.m, seg.index, displayMessages[seg.index - 1], displayMessages[seg.index + 1])}
			{:else if seg.kind === 'sysrun'}
				{@const first = seg.msgs[0]}
				{@const prev = displayMessages[seg.index - 1]}
				{#if !prev || fmtDay(prev.created_at) !== fmtDay(first.created_at)}
					<div class="day"><span>{fmtDay(first.created_at)}</span></div>
				{/if}
				{#if missed.length > 0 && seg.msgs.some((x) => x.id === missed[0]?.id)}
					<!-- The relay rows a run folds count as things a bot said, so a
					     run can hold the first unseen line - the divider belongs above
					     its toggle rather than swallowed by it. -->
					<div class="missed">
						<span class="pill">{missedLabel()}</span>
						{#if chat.catchup}
							<p class="digest">{chat.catchup}</p>
						{/if}
					</div>
				{/if}
				{#if sysRunsOpen[seg.id]}
					{#each seg.msgs as m (m.id)}
						{#if m.kind === 'relay'}
							{@render relayNote(m)}
						{:else}
							{@render sysNote(m)}
						{/if}
					{/each}
					<button class="sysrun" aria-expanded="true" onclick={() => toggleSysRun(seg.id)}>
						▸ fold back
					</button>
				{:else}
					<!-- Long runs of quiet lines fold into one toggle, keyed by the
					     run's first row so each run remembers its own state. -->
					<button class="sysrun" aria-expanded="false" onclick={() => toggleSysRun(seg.id)}>
						▸ {seg.msgs.length} system events
					</button>
				{/if}
			{:else}
				{@const isOpen = opened.has(seg.id)}
				<button class="collapse" onclick={() => openFold(seg.id)}>
					<svg
						class="chev"
						class:open={isOpen}
						viewBox="0 0 24 24" width="14" height="14" fill="none"
						stroke="currentColor" stroke-width="2"
						stroke-linecap="round" stroke-linejoin="round"
					><path d="m9 18 6-6-6-6"/></svg>
					<span>
						{seg.msgs.length} message{seg.msgs.length === 1 ? '' : 's'}
						{isOpen ? 'shown' : 'folded into the summary'}
					</span>
				</button>
				{#if isOpen}
					<!-- What was taken out, then what it became: the folded lines read
					     as removed, the summary that stands in for them as added. -->
					<div class="diff">
						<div class="diff-head">
							<span class="diff-title">− {seg.msgs.length} folded away</span>
							<button class="diff-close" title="Close" onclick={() => toggle(seg.id)}>✕</button>
						</div>
						{#each seg.msgs as m (m.id)}
							<div class="diff-line removed" data-mid={m.id}>
								<span class="diff-sign">−</span>
								<span class="diff-text">
									{#if m.bot_id}<strong>{botOf(m)?.name ?? 'bot'}:</strong>{' '}{/if}{collapseBlankLines(bodyOf(m))}
								</span>
							</div>
						{/each}
						{#if foldSummary === null}
							<div class="diff-line added">
								<span class="diff-sign">+</span>
								<span class="diff-text dim">reading the summary…</span>
							</div>
						{:else if foldSummary}
							<div class="diff-line added">
								<span class="diff-sign">+</span>
								<span class="diff-text">{foldSummary}</span>
							</div>
						{:else}
							<div class="diff-note">folded into the summary</div>
						{/if}
						{#if foldReview}
							<!-- The police's sign-off on this fold: invisible until the fold
							     is opened, then one quiet line with the verdict and why. -->
							<div class="diff-line review" class:rejected={foldReview.verdict === 'rejected'}>
								<span class="diff-sign">{foldReview.verdict === 'rejected' ? '✗' : '✓'}</span>
								<span class="diff-text dim">
									police {foldReview.verdict === 'approved'
										? 'approved'
										: foldReview.verdict === 'rewritten'
											? 'approved after a rewrite'
											: 'rejected'}: {foldReview.reason}
								</span>
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		{/each}

		<!-- A bot composing: a reply streaming, or a keyboard it is still at. Its
		     face and name sit above the dots, WhatsApp-style, so it is clear who
		     is about to speak; the whole row goes when the real message lands.
		     Only a bot actually driving its machine swaps the dots for the 🧰
		     line and its rail - the one surface for progress news, since the
		     narration rows never reach the feed - and a machine booting itself
		     is not that, so a composing bot keeps the plain dots throughout. -->
		{#if typingBot}
			<div class="row in typing">
				<span class="avatar named">
					<Avatar
						color={typingBot.color}
						seed={typingBot.id}
						size={30}
						hat={typingBot.hat ?? ''}
						bloat={bloatOf(typingBot)}
						talking
						activity={chat.activityKindFor(typingBot.id)}
					/>
				</span>
				<div class="stack">
					<span class="sname" style:color={typingBot.color}>{typingBot.name}</span>
					<div
						class="bubble in typingbubble"
						class:toolbox={!!computerActing}
						aria-label={computerActing
							? `${typingBot.name} is using the computer`
							: composingText
								? `${typingBot.name} is writing`
								: `${typingBot.name} is typing`}
					>
						{#if workingTask}
							<!-- The turn is a background task the tray would name: say so
							     here, in the thread the user is actually looking at, with
							     its age - a pending ask is not just dots. -->
							<span class="taskline" title="This is a background task - open the tray for detail">
								<span class="taskglyph" aria-hidden="true">⏳</span>
								<span class="taskname">working on {taskTitle(workingTask)}</span>
								<span class="taskage">{taskElapsed(workingTask)}</span>
							</span>
						{/if}
						{#if computerActing}
							<span class="toolboxline">
								{#key activityEmoji}
									<span class="actemoji" aria-hidden="true">{activityEmoji}</span>
								{/key}
								{computerActing}
							</span>
							<!-- The rail rides with the line: a bot composing a reply gets
							     its dots and nothing else, however long the wait. -->
							<div class="progressrow">
								<div class="progress" class:indeterminate={progressPct === null}>
									<div
										class="progressbar"
										style:width={progressPct === null ? undefined : `${progressPct}%`}
									></div>
								</div>
								{#if progressPct !== null}<span class="progresspct">{progressPct}%</span>{/if}
							</div>
						{:else if composingText}
							<!-- Live wire status while the reply streams: the planet keeps
							     flashing and RX counts the characters as they land. -->
							<div class="thinking wireup">
								<span class="planet" aria-hidden="true">
									<span class="planet-core"></span>
									<span class="planet-ring"></span>
								</span>
								<span class="txrx">
									<span class="tx" title="Prompt tokens sent so far">TX {chat.tokensOutFor(typingBot.id)}</span>
									<span class="rx" title="Reply characters received so far">RX {composingText.length}</span>
								</span>
							</div>
							<!-- The reply as it is being written. The words arrive per delta
							     and the whole composing row goes when the turn ends, so the
							     finished message replaces this text rather than joining it. -->
							<div class="partial">{composingText}</div>
						{:else}
							<div class="thinking">
								<!-- Waiting on the AI gateway: a little planet that flashes
								     while the request is in flight, with live TX/RX counters
								     so the wait reads as a wire, not a stall. -->
								<span class="planet" aria-hidden="true">
									<span class="planet-core"></span>
									<span class="planet-ring"></span>
								</span>
								<span class="txrx">
									<!-- TX/RX as live wire counters: TX is the prompt tokens the
									     task has already spent (per completed provider call), RX is
									     the reply streaming in right now - its character count is the
									     only signal that moves while a single call is in flight. -->
									<span class="tx" title="Prompt tokens sent so far">TX {chat.tokensOutFor(typingBot.id)}</span>
									<span class="rx" title="Reply characters received so far">RX {composingText.length || chat.tokensInFor(typingBot.id)}</span>
								</span>
								<span class="dot"></span><span class="dot"></span><span class="dot"></span>
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		{#if chat.secretDraft}
			{@const lockbot = chat.activeBots[0]}
			<div class="row out">
				<div class="stack">
					<div class="secretcard" bind:this={secretCard}>
						<div class="sechead">
							<span>🔒</span>
							<span>Give {lockbot?.name ?? 'them'} a secret</span>
							<button class="secx" title="Cancel" onclick={() => (chat.secretDraft = false)}>✕</button>
						</div>
						<input placeholder="name (e.g. api_key)" bind:value={secretName} />
						<div class="valurow">
							<input
								type={showValue ? 'text' : 'password'}
								placeholder="paste the value"
								bind:value={secretValue}
								onkeydown={(e) => {
									// isComposing: Enter confirms an IME candidate, not a handover.
									if (e.key === 'Enter' && !e.isComposing && lockbot) void handOver(lockbot.id);
								}}
							/>
							<button
								class="eye"
								type="button"
								title={showValue ? 'Hide the value' : 'Show the value'}
								onclick={() => (showValue = !showValue)}
							>
								{#if showValue}
									<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>
								{:else}
									<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.5 7.5A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.9 9.9 0 0 0 4-.8"/></svg>
								{/if}
							</button>
						</div>
						<div class="secfoot">
							<span class="secnote">{chat.secretNote}</span>
							<button
								class="secsend"
								disabled={handingOver || !secretName.trim() || !secretValue.trim() || !lockbot}
								onclick={() => lockbot && handOver(lockbot.id)}
							>
								{handingOver ? 'Handing over…' : 'Hand it over'}
							</button>
						</div>
						<p class="sechint">
							Encrypted at rest, dropped straight into their sandbox. It never enters the
							chat or their context.
						</p>
					</div>
				</div>
			</div>
		{/if}

		{#if chat.error}
			<div class="error">{chat.error}</div>
		{/if}
	</div>
</div>

<style>
	.scroll {
		flex: 1;
		overflow-y: auto;
	}
	.col {
		width: min(48rem, 100%);
		margin: 0 auto;
		padding: 1rem 1.1rem 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
		/* Query container so the hover actions can clamp their width to the
		   space actually left beside a bubble instead of clipping at the
		   panel edge. */
		container-type: inline-size;
	}
	.day {
		display: flex;
		justify-content: center;
		padding: 0.9rem 0 0.6rem;
	}
	.day span {
		font-size: 0.72rem;
		color: var(--text-muted);
		background: var(--bg-raised);
		padding: 0.25rem 0.7rem;
		border-radius: 0.6rem;
	}

	.missed {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		/* Symmetric: the thread's own gap supplies the rest of the rhythm. */
		padding: 0.7rem 0;
	}
	.pill {
		font-size: 0.74rem;
		color: #7fb2ff;
		background: rgba(80, 140, 255, 0.14);
		border: 1px solid rgba(80, 140, 255, 0.3);
		padding: 0.22rem 0.75rem;
		border-radius: 999px;
	}
	.digest {
		margin: 0;
		max-width: 32rem;
		font-size: 0.84rem;
		line-height: 1.5;
		color: var(--text-muted);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		padding: 0.6rem 0.8rem;
	}
	.collapse {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0.7rem auto;
		padding: 0.38rem 0.9rem;
		background: var(--bg-raised);
		border: 1px solid #3d3d44;
		border-radius: 999px;
		color: var(--text-muted);
		font-size: 0.76rem;
		cursor: pointer;
	}
	.collapse:hover {
		color: var(--text);
		background: var(--bg-hover);
		border-color: #4a4a52;
	}
	/* An opened fold reads like a diff: what was taken out in red, the summary
	   that stands in for it in green. */
	.diff {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin: 0.2rem 0 0.6rem;
	}
	.diff-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0 0.35rem 0.15rem 0.6rem;
	}
	.diff-title {
		font-size: 0.7rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.diff-close {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		background: none;
		border: 1px solid transparent;
		border-radius: 0.4rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		cursor: pointer;
	}
	.diff-close:hover {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border);
	}
	.diff-line {
		display: flex;
		gap: 0.55rem;
		padding: 0.3rem 0.6rem;
		border-radius: 0.45rem;
		font-size: 0.82rem;
		line-height: 1.45;
	}
	.diff-line.removed {
		background: rgba(240, 90, 90, 0.08);
		border-left: 3px solid rgba(240, 90, 90, 0.45);
		color: var(--text-muted);
	}
	.diff-line.added {
		background: rgba(90, 200, 120, 0.09);
		border-left: 3px solid rgba(90, 200, 120, 0.5);
		color: var(--text);
	}
	.diff-sign {
		flex: none;
		width: 0.8rem;
		text-align: center;
		opacity: 0.7;
		user-select: none;
	}
	.diff-text {
		min-width: 0;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}
	.diff-text.dim {
		font-style: italic;
		opacity: 0.6;
	}
	.diff-note {
		padding: 0.15rem 0.6rem;
		font-size: 0.74rem;
		font-style: italic;
		color: var(--text-muted);
	}
	/* The police's sign-off line inside an opened fold: quiet like the rest of
	   the diff, red only when the fold was sent back. */
	.diff-line.review .diff-sign {
		color: #4ade80;
	}
	.diff-line.review.rejected .diff-sign,
	.diff-line.review.rejected .diff-text {
		color: #f87171;
	}
	.earlier {
		display: block;
		margin: 0.4rem auto 0.2rem;
		padding: 0.38rem 0.9rem;
		background: var(--bg-raised);
		border: 1px solid #3d3d44;
		border-radius: 999px;
		color: var(--text-muted);
		font-size: 0.76rem;
		cursor: pointer;
	}
	.earlier:hover:not(:disabled) {
		color: var(--text);
		background: var(--bg-hover);
		border-color: #4a4a52;
	}
	.earlier:disabled {
		cursor: default;
	}


	.row {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		max-width: 100%;
	}
	.row.out {
		justify-content: flex-end;
	}
	.row + .row {
		margin-top: 0.18rem;
	}
	.row.last {
		margin-bottom: 0.35rem;
	}
	.avatar {
		flex: none;
	}
	/* When a sender name sits above the bubble, drop the avatar past the
	   name block (1.25rem line + 0.18rem gap) so its top lands on the
	   bubble's top edge instead of the name's. */
	.avatar.named {
		margin-top: 1.43rem;
	}
	.avatar-spacer {
		width: 30px;
		flex: none;
	}
	.stack {
		display: flex;
		flex-direction: column;
		min-width: 0;
		max-width: min(76%, 34rem);
		/* Anchors the hover actions beside the bubble without giving them
		   layout space. */
		position: relative;
	}
	.row.out .stack {
		align-items: flex-end;
	}
	.sname {
		font-size: 0.76rem;
		font-weight: 600;
		/* Fixed line-height keeps .avatar.named's 1.43rem offset exact. */
		line-height: 1.25rem;
		margin: 0 0 0.18rem 0.6rem;
		/* It is a button (click folds the message), so the UA chrome has to come
		   off: without the reset it renders as a full-width grey bar. */
		align-self: flex-start;
		padding: 0;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
	}

	/* A folded bot message: a quiet one-line card, not a full bubble. */
	.peek {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: min(76%, 34rem);
		min-width: 0;
		padding: 0.4rem 0.7rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.8rem;
		color: var(--text-muted);
		font-size: 0.82rem;
		cursor: pointer;
		text-align: left;
		transition: background 0.12s ease, border-color 0.12s ease;
	}
	.peek:hover {
		background: var(--bg-hover);
		border-color: #4a4a52;
	}
	.peek-head {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		min-width: 0;
		flex: 1;
	}

	/* A message the user did not type: a quiet centred note, not a bubble. */
	.row.sys {
		justify-content: center;
	}
	.sysnote {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
		max-width: min(76%, 34rem);
		padding: 0.3rem 0.8rem;
		background: none;
		border: none;
		border-radius: 0.6rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		cursor: pointer;
		text-align: center;
	}
	.sysnote:hover {
		background: var(--bg-raised);
	}
	.sys-label {
		font-weight: 600;
		letter-spacing: 0.02em;
		opacity: 0.85;
	}
	.sys-peek {
		font-style: italic;
		opacity: 0.7;
		/* A long unbroken word (a 60-char bot name in an onboarding note) must
		   wrap inside the note rather than bleed off the screen - `anywhere`
		   because only it counts breaks in the min-content width. */
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.sys-body {
		font-style: normal;
		white-space: pre-wrap;
		word-break: break-word;
		max-width: 100%;
		color: var(--text);
		font-size: 0.85rem;
	}
	.peek-name {
		font-weight: 600;
		flex: none;
	}
	.peek-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.peek-chev {
		flex: none;
		transition: transform 0.18s ease;
	}
	/* A message planted under a bot's name reads differently, so the fold
	   carries a small tag and a dashed edge to flag it. */
	.peek.injected {
		border-style: dashed;
		border-color: rgba(240, 180, 80, 0.45);
	}
	.peek-tag {
		flex: none;
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: #f0b450;
		background: rgba(240, 180, 80, 0.12);
		border: 1px solid rgba(240, 180, 80, 0.35);
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
	}
	/* An @botname inside a message becomes a small pill. */
	.md :global(.mention) {
		display: inline-block;
		font-weight: 600;
		font-size: 0.86em;
		line-height: 1.2;
		color: #8ab4ff;
		background: rgba(110, 168, 254, 0.14);
		border: 1px solid rgba(110, 168, 254, 0.3);
		border-radius: 999px;
		padding: 0 0.4em;
		vertical-align: baseline;
	}
	/* Status and meta text (sender name, timestamp, typing) read in a
	   distinct italic so they never look like something the bot said. */
	.sname,
	.stamp,
	.peek-text,
	.peek-tag {
		font-style: italic;
	}

	/* A reply's quote: a small tappable strip above the bubble, one line of the
	   message it answers, with an accent bar on the side it leans to. */
	.quote {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.05rem;
		max-width: min(22rem, 100%);
		margin: 0 0 0.2rem 0.35rem;
		padding: 0.25rem 0.6rem;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border: none;
		border-left: 3px solid color-mix(in srgb, var(--accent) 60%, transparent);
		border-radius: 0.45rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		line-height: 1.3;
		text-align: left;
		cursor: pointer;
	}
	.quote:hover {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--text);
	}
	.quote-who {
		font-weight: 600;
		font-style: italic;
	}
	.quote-text {
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}
	.quote-text.dim {
		font-style: italic;
		opacity: 0.6;
	}
	.bubble {
		position: relative;
		display: flex;
		flex-direction: column;
		padding: 0.55rem 0.8rem;
		border-radius: 1rem;
		font-size: 0.93rem;
		line-height: 1.45;
		/* `anywhere`, not `break-word`: only `anywhere` lowers the min-content
		   width, so a huge unbroken string shrinks the flex bubble and wraps
		   instead of blowing it out under the sidebar. */
		overflow-wrap: anywhere;
		min-width: 3.2rem;
	}
	.bubble.in {
		background: var(--bubble);
		border-bottom-left-radius: 0.3rem;
	}
	/* A screenshot a bot sent: bounded so a full-screen grab cannot blow the
	   bubble out, and clickable to open the full-size picture. */
	.bubble .shot {
		display: block;
		margin-top: 0.4rem;
		line-height: 0;
	}
	.bubble .shot img {
		max-width: 100%;
		max-height: 22rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border);
	}
	.bubble.out {
		background: var(--bubble-out);
		border-bottom-right-radius: 0.3rem;
	}
	/* A bubble that just landed under the reader's eye glows once, then settles. */
	.bubble.fresh {
		animation: freshglow 1.8s ease-out forwards;
	}
	@keyframes freshglow {
		0% {
			box-shadow: 0 0 0 3px rgba(110, 168, 254, 0.35), 0 0 18px rgba(110, 168, 254, 0.3);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(110, 168, 254, 0), 0 0 0 rgba(110, 168, 254, 0);
		}
	}
	/* The officer's own words wear his lights: blue down one side and red down
	   the other, both on the bubble at once, so it reads as a light bar at a
	   glance. The pulse only breathes them - neither colour ever goes out.
	   Identified by the bot row (the app's system bot), never by what it is
	   called. */
	.bubble.police {
		box-shadow:
			-7px 0 18px -4px rgba(59, 130, 246, 0.55),
			7px 0 18px -4px rgba(239, 68, 68, 0.5);
		animation: siren 1.9s ease-in-out infinite;
	}
	@keyframes siren {
		0%,
		100% {
			box-shadow:
				-7px 0 18px -4px rgba(59, 130, 246, 0.55),
				7px 0 18px -4px rgba(239, 68, 68, 0.5);
		}
		50% {
			box-shadow:
				-8px 0 26px -4px rgba(59, 130, 246, 0.85),
				8px 0 26px -4px rgba(239, 68, 68, 0.75);
		}
	}
	/* A spectator warning is the officer's red only: the siren's blue half is
	   for the police speaking, and this is the police pointing at a message. */
	.bubble.warning {
		box-shadow:
			0 0 0 1px rgba(239, 68, 68, 0.55),
			0 0 22px -2px rgba(239, 68, 68, 0.5);
		animation: none;
	}
	/* An inbound webhook payload: a teal-edged bubble with the hook tag, so an
	   outside service's delivery reads as a real event rather than another
	   grey system note. */
	.bubble.webhook {
		border: 1px solid rgba(94, 200, 190, 0.5);
		background: color-mix(in srgb, rgba(94, 200, 190, 0.12), var(--bubble));
		box-shadow: 0 0 14px -4px rgba(94, 200, 190, 0.35);
	}
	.hooktag {
		display: inline-block;
		font-size: 0.62rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: rgba(94, 200, 190, 0.9);
		margin-bottom: 0.15rem;
	}
	.hookicon {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		font-size: 1rem;
		background: color-mix(in srgb, rgba(94, 200, 190, 0.15), var(--bg));
		border: 1px solid rgba(94, 200, 190, 0.4);
		border-radius: 50%;
	}
	/* A bot that is not this chat's bot - the police walking into a DM, someone
	   else's message carried in - gets its own outline in its own colour and says
	   who it is, so it never reads as the room's own voice. The room's bot and the
	   human are untouched. */
	.row.guest .bubble {
		background: color-mix(in srgb, var(--who) 16%, var(--bubble));
		border: 1px solid color-mix(in srgb, var(--who) 55%, transparent);
	}
	.guest-tag {
		margin-left: 0.4rem;
		padding: 0 0.4rem;
		border: 1px solid color-mix(in srgb, var(--who) 45%, transparent);
		border-radius: 999px;
		font-size: 0.66rem;
		font-style: italic;
		color: var(--text-muted);
	}

	.body {
		white-space: pre-wrap;
	}
	.bubble.big {
		background: none;
		padding: 0.1rem 0.15rem 0.15rem;
	}
	.emoji {
		font-size: 2.6rem;
		line-height: 1.25;
	}
	/* A themed bubble's tag: the theme's emoji badge and its name, above the
	   text. Clamped to the bubble so a long name can never widen it. */
	.tbadge {
		max-width: 100%;
		margin-bottom: 0.15rem;
		font-size: 0.68rem;
		line-height: 1.3;
		letter-spacing: 0.02em;
		opacity: 0.75;
		overflow-wrap: anywhere;
	}
	/* An external peer's bubble wears its own tag, so "from another bot" is
	   said on the message itself and not only on the strip up top. */
	.fedtag {
		margin-bottom: 0.15rem;
		font-size: 0.68rem;
		letter-spacing: 0.02em;
		color: #b79bff;
	}
	.bubble.in.fed {
		border-color: color-mix(in srgb, #8b5cf6 45%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, #8b5cf6 25%, transparent);
	}
	.stamp {
		align-self: flex-end;
		margin-top: 0.3rem;
		font-size: 0.66rem;
		color: var(--text-muted);
		opacity: 0.8;
		user-select: none;
	}
	/* The line steered a turn already running: the marker rides with the time,
	   small and quiet, so it reads without competing with the message. The text
	   carries it for a screen reader - the bolt is decoration. */
	.stamp .steered {
		margin-left: 0.4rem;
		color: var(--accent);
		opacity: 1;
	}
	/* One stamp paradigm everywhere: end of the content flow, small top
	   margin, flush with the container's right padding. In the horizontal
	   secret row that means bottom-aligned at the row's end. */

	.actions {
		/* Out of flow so a row is exactly as tall as its bubble; revealed on
		   hover/focus-within without shifting anything. */
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.1rem;
		width: max-content;
		opacity: 0;
		pointer-events: none;
		z-index: 4;
		transition: opacity 0.12s;
	}
	/* Incoming rows hang the strip just right of the bubble, outgoing rows
	   mirror it to the left. The max-width clamps it inside the column (the
	   query container) so a wide bubble can't push the buttons past the
	   panel edge — they wrap instead of clipping. The 30px on .in is the
	   avatar/spacer column. */
	.row.in .actions {
		left: calc(100% + 0.35rem);
		max-width: max(3rem, calc(100cqw - 100% - 30px - 1.15rem));
	}
	.row.out .actions {
		right: calc(100% + 0.35rem);
		max-width: max(3rem, calc(100cqw - 100% - 1rem));
	}
	.row:hover .actions,
	.actions:focus-within {
		opacity: 0.75;
		pointer-events: auto;
	}
	.actions:hover {
		opacity: 1;
	}
	.act {
		display: grid;
		place-items: center;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0.25rem;
		border-radius: 0.4rem;
		transition: transform 0.14s ease;
	}
	.act:hover {
		color: var(--text);
		background: var(--bg-hover);
		transform: translateY(-1px);
	}
	.act.sel {
		color: #6ea8fe;
	}
	.act.danger:hover {
		color: var(--danger);
	}
	/* The ✕ spins a quarter-turn as a hint that it puts things back. */
	.act.ctx svg {
		transition: transform 0.18s ease;
	}
	.act.ctx:hover svg {
		transform: rotate(90deg);
	}
	/* Thumbs rock a couple of degrees when they land. */
	.act.rate {
		transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.act.rate.sel {
		transform: rotate(-5deg);
	}
	.act.rate.sel:hover {
		transform: rotate(-5deg) translateY(-1px);
	}

	/* The ~1s answer to a thumb click: six stars scatter off the bubble, then
	   the sel state on the button carries the rating from there. */
	.starburst {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: visible;
	}
	.starburst i {
		position: absolute;
		left: 50%;
		top: 50%;
		font-style: normal;
		font-size: 0.9rem;
		color: #ffd76a;
		text-shadow: 0 0 6px rgba(255, 200, 60, 0.8);
		opacity: 0;
		animation: starfly 0.9s ease-out forwards;
	}
	.starburst.bad i {
		color: #9fb4ff;
		text-shadow: 0 0 6px rgba(120, 150, 255, 0.8);
	}
	.starburst i:nth-child(1) { --dx: -2.6rem; --dy: -1.6rem; animation-delay: 0s; }
	.starburst i:nth-child(2) { --dx: 2.4rem; --dy: -1.8rem; animation-delay: 0.05s; }
	.starburst i:nth-child(3) { --dx: -3rem; --dy: 0.4rem; animation-delay: 0.1s; }
	.starburst i:nth-child(4) { --dx: 2.8rem; --dy: 0.6rem; animation-delay: 0.08s; }
	.starburst i:nth-child(5) { --dx: -1.2rem; --dy: -2.4rem; animation-delay: 0.14s; }
	.starburst i:nth-child(6) { --dx: 1.4rem; --dy: 1.8rem; animation-delay: 0.12s; }
	@keyframes starfly {
		0% {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.4);
		}
		20% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1.3);
		}
	}

	.chev {
		transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.chev.open {
		transform: rotate(90deg);
	}

	.chips {
		display: flex;
		gap: 0.2rem;
		margin-top: -0.35rem;
		padding: 0 0.4rem;
		z-index: 3;
	}
	.chip {
		cursor: default;
	}
	.chip.mine {
		cursor: pointer;
		border-color: rgba(80, 140, 255, 0.5);
	}
	.chip {
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.78rem;
		line-height: 1;
		padding: 0.18rem 0.35rem;
		box-shadow: 0 1px 5px rgba(0, 0, 0, 0.35);
		animation: pop 0.22s ease-out;
		transition: transform 0.14s ease;
	}
	.chip:hover {
		transform: scale(1.12);
	}
	@keyframes pop {
		from {
			transform: scale(0.5);
			opacity: 0;
		}
	}
	.secretcard {
		width: min(24rem, 100%);
		background: var(--bg-raised);
		border: 1px solid rgba(80, 140, 255, 0.35);
		border-radius: 1rem;
		padding: 0.7rem 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.sechead {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.84rem;
		font-weight: 600;
	}
	.sechead span:nth-child(2) {
		flex: 1;
	}
	.secx {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.72rem;
	}
	.secx:hover {
		color: var(--text);
	}
	.valurow {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.valurow input {
		flex: 1;
	}
	.eye {
		display: grid;
		place-items: center;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0.3rem;
		border-radius: 0.4rem;
		flex: none;
	}
	.eye:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.secretcard input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		padding: 0.45rem 0.6rem;
		color: var(--text);
		font-family: inherit;
		font-size: 0.85rem;
	}
	.secretcard input:focus {
		outline: none;
		border-color: #3d3d44;
	}
	.secfoot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.secnote {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.secsend {
		background: var(--accent);
		border: none;
		border-radius: 999px;
		color: #fff;
		font-size: 0.8rem;
		padding: 0.42rem 1rem;
		cursor: pointer;
	}
	.secsend:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.sechint {
		margin: 0;
		font-size: 0.68rem;
		line-height: 1.4;
		color: var(--text-muted);
	}
	.secretdone {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: rgba(80, 140, 255, 0.12);
		border: 1px solid rgba(80, 140, 255, 0.3);
		border-radius: 1rem;
		padding: 0.5rem 0.8rem;
		font-size: 0.84rem;
		max-width: 30rem;
	}
	.sectext {
		flex: 1;
	}
	.sectext code {
		background: var(--bg);
		border-radius: 0.3rem;
		padding: 0.05rem 0.35rem;
		font-size: 0.78rem;
	}
	.md {
		display: flow-root;
	}
	/* Inline code chips: a touch more left padding than right so trailing
	   punctuation tucks close while the chip still reads as a chip. */
	.bubble .md :global(code:not(pre code)) {
		padding: 0.15em 0.18em 0.15em 0.3em;
	}
	/* Reopened messages stay obviously out of context. */
	.row.muted {
		opacity: 0.55;
	}
	.row.muted .bubble {
		border: 1px dashed rgba(255, 255, 255, 0.14);
	}
	.thinking {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.35rem 0.15rem;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-muted);
		animation: pulse 1.2s infinite ease-in-out;
	}
	.dot:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dot:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 0.3;
		}
		50% {
			opacity: 1;
		}
	}
	/* The waiting-on-gateway planet: a small world that flashes while the
	   request is in flight, with live TX/RX counters beside it. */
	.planet {
		position: relative;
		width: 14px;
		height: 14px;
		flex: none;
	}
	.planet-core {
		position: absolute;
		inset: 2px;
		border-radius: 50%;
		background: #6a8fd8;
		animation: planetflash 1.6s ease-in-out infinite;
	}
	.planet-ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1px solid rgba(106, 143, 216, 0.4);
		animation: planetring 1.6s ease-in-out infinite;
	}
	@keyframes planetflash {
		0%, 100% { opacity: 0.4; transform: scale(0.85); }
		50% { opacity: 1; transform: scale(1); }
	}
	@keyframes planetring {
		0%, 100% { opacity: 0.2; transform: scale(0.9); }
		50% { opacity: 0.6; transform: scale(1.1); }
	}
	.txrx {
		display: flex;
		gap: 0.35rem;
		font-family: 'SF Mono', 'Cascadia Code', monospace;
		font-size: 0.6rem;
		color: var(--text-muted);
	}
	.txrx .tx { color: #7fb8a8; }
	.txrx .rx { color: #8fa8d8; }
	.error {
		padding: 0.7rem 1rem;
		border: 1px solid #5a2b2b;
		background: #2a1515;
		border-radius: 0.6rem;
		color: var(--danger);
		font-size: 0.88rem;
		margin-top: 0.6rem;
	}

	/* A proposal waiting on the human's verdict, under the bot's newest bubble:
	   its own restyle, or a new bot it wants to bring into the lounge. */
	.proposalcard {
		margin-top: 0.3rem;
		padding: 0.55rem 0.7rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		font-size: 0.8rem;
	}
	.proposalhead {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		color: var(--text);
	}
	.proposalnote {
		color: var(--text-muted);
		font-style: italic;
	}
	.stylepreview {
		padding: 0.45rem 0.7rem;
		border-radius: 0.8rem;
		background: var(--bg-hover);
		border: 1px solid var(--border);
		color: var(--text);
	}
	/* The bot on the table: the new bot's face, name and the model it
	   would think on, with the persona it would be given underneath. */
	.botpreview {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.7rem;
		border-radius: 0.8rem;
		background: var(--bg-hover);
		border: 1px solid var(--border);
	}
	.botwho {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		overflow: hidden;
	}
	.botname {
		color: var(--text);
		font-weight: 600;
	}
	.botmodel {
		color: var(--text-muted);
	}
	.botpersona {
		margin: 0;
		color: var(--text);
	}
	.proposalbtns {
		display: flex;
		gap: 0.4rem;
	}
	.proposalbtns button {
		font-size: 0.78rem;
		padding: 0.25rem 0.8rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-hover);
		color: var(--text);
		cursor: pointer;
	}
	.proposalbtns button:hover {
		border-color: #4a4a52;
	}
	.proposalbtns .proposalok {
		color: #7fb2ff;
	}

	/* A live debug grant, under the bot's newest bubble: the human sees the
	   access is on, how long is left, and can end it from here. */
	.debugbadge {
		margin-top: 0.3rem;
		padding: 0.35rem 0.7rem;
		background: var(--bg-raised);
		border: 1px solid #4a4330;
		border-radius: 999px;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.78rem;
		color: var(--text-muted);
		width: fit-content;
	}
	.debugbadge button {
		font-size: 0.72rem;
		padding: 0.15rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-hover);
		color: var(--text-muted);
		cursor: pointer;
	}
	.debugnote {
		margin: 0;
		color: var(--text-muted);
		line-height: 1.35;
	}
	/* An SSH ask: the target fields, the key to install, and the check verdict. */
	.sshcard {
		border-color: rgba(80, 140, 255, 0.35);
	}
	.sshfields {
		display: flex;
		gap: 0.4rem;
	}
	.sshfields label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		flex: 1;
		color: var(--text-muted);
		font-size: 0.72rem;
	}
	.sshfields .sshport {
		max-width: 5rem;
	}
	.sshfields input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		color: var(--text);
		padding: 0.3rem 0.5rem;
		font-size: 0.8rem;
		width: 100%;
		box-sizing: border-box;
	}
	.sshfields input:disabled {
		opacity: 0.6;
	}
	.sshfields input:focus {
		outline: none;
		border-color: #3d3d44;
	}
	.sshkeyrow {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	.sshkey {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		padding: 0.3rem 0.5rem;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.sshcopy {
		flex-shrink: 0;
		font-size: 0.72rem;
		padding: 0.25rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-hover);
		color: var(--text);
		cursor: pointer;
	}
	.sshhint {
		margin: 0;
		color: var(--text-muted);
		line-height: 1.35;
	}
	.ssherror {
		margin: 0;
		color: var(--danger);
		line-height: 1.35;
		word-break: break-word;
	}
	.askneed {
		margin: 0;
		font-weight: 600;
		line-height: 1.35;
	}
	.askreason {
		margin: 0;
		color: var(--text-muted);
		line-height: 1.35;
	}
	.sshok {
		color: #7fd08a;
		font-size: 0.75rem;
	}
	.sshfail {
		color: var(--danger);
		font-size: 0.75rem;
	}
	.sshpending {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.act,
		.act.ctx svg,
		.act.rate,
		.chip,
		.chev {
			transition: none;
		}
		.bubble.fresh {
			animation: none;
		}
		/* No breathing, but both lights stay on him. */
		.bubble.police {
			animation: none;
			box-shadow:
				-7px 0 18px -4px rgba(59, 130, 246, 0.5),
				7px 0 18px -4px rgba(239, 68, 68, 0.46);
		}
		.act:hover,
		.act.rate.sel,
		.act.rate.sel:hover,
		.act.ctx:hover svg,
		.chip:hover {
			transform: none;
		}
		.chev.open {
			transform: rotate(90deg);
		}
	}
	:global(.toolbubble) {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		max-width: min(76%, 34rem);
		padding: 0.4rem 0.7rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		cursor: pointer;
		text-align: left;
		color: var(--text-muted);
	}
	:global(.toolbubble:hover) { background: var(--bg-hover); border-color: #4a4a52; }
	:global(.toolhead) { display: flex; align-items: center; gap: 0.45rem; min-width: 0; }
	:global(.toolname) { font-weight: 600; color: var(--text); font-size: 0.78rem; flex: none; }
	:global(.toolpreview) { font-size: 0.78rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
	:global(.tooldetail) { font-size: 0.78rem; color: var(--text); white-space: pre-wrap; overflow-wrap: break-word; text-align: left; max-width: 100%; }
	:global(.toolbubble.open .toolhead) { color: var(--text); }
	:global(.personadiff) { padding: 0.45rem 0.6rem; background: var(--bg); border: 1px solid var(--border); border-radius: 0.55rem; font-size: 0.82rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: break-word; }
	:global(.pdiff-del) { background: rgba(240,90,90,0.18); color: #f87171; text-decoration: line-through; text-decoration-color: rgba(240,90,90,0.6); border-radius: 2px; padding: 0 1px; }
	:global(.pdiff-ins) { background: rgba(90,200,120,0.18); color: #4ade80; border-radius: 2px; padding: 0 1px; }
	:global(.pdiff-same) { color: var(--text-muted); }
	:global(.toolboxline) {
		font-size: 0.8rem;
		color: var(--text-muted);
		font-style: italic;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}
	/* The activity emoji breathes: it pops in, holds, and fades out on a loop,
	   so the bubble reads as alive without a timer. Keyed on the glyph, so a
	   change of activity restarts the animation and the new one pops in. */
	.actemoji {
		display: inline-block;
		font-size: 0.95rem;
		line-height: 1;
		transform-origin: center;
		animation: actpop 1.4s ease-in-out infinite;
	}
	@keyframes actpop {
		0% {
			opacity: 0;
			transform: scale(0.4);
		}
		25% {
			opacity: 1;
			transform: scale(1.15);
		}
		45% {
			transform: scale(1);
		}
		75% {
			opacity: 1;
			transform: scale(1);
		}
		100% {
			opacity: 0;
			transform: scale(0.85);
		}
	}
	:global(.bubble.toolbox) { border: 1px dashed rgba(120,160,255,0.35); }

	/* The composing bubble is wider than its dots so the progress rail has room
	   to read as a rail rather than a stub. */
	.typingbubble {
		min-width: 9rem;
	}
	/* A turn that is a background task says so above its content: what it is
	   working on and how long it has been going, so a pending ask is readable
	   in the thread itself rather than only in the tray. */
	.taskline {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-bottom: 0.3rem;
		padding: 0.25rem 0.5rem;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
		border-radius: 0.5rem;
		font-size: 0.74rem;
		line-height: 1.3;
		min-width: 0;
	}
	.taskglyph {
		flex: none;
	}
	.taskname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}
	.taskage {
		flex: none;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	/* The live partial reply: the words as they arrive, wrapped like the message
	   they are becoming. The tail is bounded server-side, so no height cap. */
	.partial {
		white-space: pre-wrap;
		overflow-wrap: break-word;
		text-align: left;
		font-size: 0.9rem;
		line-height: 1.45;
	}
	/* A thin rail under the bubble's line: filled to the computer sub-agent's
	   step fraction, or shimmering when there is no number to show. */
	.progressrow {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-top: 0.4rem;
	}
	.progress {
		flex: 1;
		height: 3px;
		border-radius: 999px;
		background: var(--bg-hover);
		overflow: hidden;
	}
	.progressbar {
		height: 100%;
		border-radius: 999px;
		background: var(--text-muted);
		transition: width 0.4s ease;
	}
	.progress.indeterminate .progressbar {
		width: 40%;
		animation: progressshimmer 1.4s ease-in-out infinite;
	}
	@keyframes progressshimmer {
		0% {
			transform: translateX(-120%);
		}
		100% {
			transform: translateX(320%);
		}
	}
	.progresspct {
		flex: none;
		font-size: 0.7rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	/* After the rules above, not before them: an equal-specificity override in
	   an earlier block loses the cascade to the unconditional rule that follows. */
	@media (prefers-reduced-motion: reduce) {
		/* The emoji just sits there, lit, and the rail fills without the slide
		   or the shimmer. */
		.actemoji {
			animation: none;
		}
		.progressbar {
			transition: none;
		}
		.progress.indeterminate .progressbar {
			animation: none;
		}
	}

	/* A relay read as a traffic report, not a bubble: who passed what to whom. */
	.relayline {
		max-width: min(76%, 34rem);
		padding: 0.15rem 0.2rem;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.relaywho {
		font-weight: 600;
		opacity: 0.85;
	}

	/* A run of quiet system lines folded into one toggle, shaped like the
	   notes it stands in for. */
	.sysrun {
		display: block;
		margin: 0.15rem auto;
		padding: 0.22rem 0.8rem;
		background: none;
		border: none;
		border-radius: 0.6rem;
		color: var(--text-muted);
		font-size: 0.76rem;
		cursor: pointer;
		text-align: center;
	}
	.sysrun:hover {
		background: var(--bg-raised);
		color: var(--text);
	}
</style>
