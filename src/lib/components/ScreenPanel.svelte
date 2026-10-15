<script lang="ts">
	import { tick } from 'svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { bloatLabel, shortTokens, tokensOf } from '$lib/bloat';
	import Avatar from './Avatar.svelte';
	import PlayGym from './PlayGym.svelte';
	import ShellTerm from './ShellTerm.svelte';
import { IN_THE_PUB, ON_THE_GYM } from '$lib/lounge';
	import { isLounge } from '$lib/conversation-list';
	import { sndClick } from '$lib/sound';
	import type { Routine, SandboxStatus, Task, Verification } from '$lib/types';

	let { onCreateRoutine }: { onCreateRoutine: () => void } = $props();

	let status = $state<SandboxStatus | null>(null);
	let waking = $state(false);
	/**
	 * What the last wake attempt ended in, so the panel can say what to do
	 * about it. The four causes need four different things done, and the one
	 * "could not start it" line told the user none of them. '' means nothing
	 * has failed since the last attempt began.
	 */
	let wakeFailure = $state<'' | 'unreachable' | 'refused' | 'timeout'>('');
	/** The server's own words for a refusal, shown as it sent them. */
	let wakeDetail = $state('');
	/** When the current wake began, so a slow boot can say how long it has been. */
	let wakeStartedAt = $state(0);
	let wakeSeconds = $state(0);
	/** When the machine first reported its desktop still coming up. */
	let bootStartedAt = $state(0);
	let bootSeconds = $state(0);
	/** The window the wake route races its boot against before answering. */
	const WAKE_RACE_MS = 11_500;
	/**
	 * How long the wake request may sit in flight before the panel stops
	 * calling it progress and hands the control back. The route answers within
	 * its race window, so a request still unanswered past this is one that is
	 * not coming back.
	 */
	const WAKE_IN_FLIGHT_MS = 15_000;
	/** How long a desktop may install before the panel calls it stuck. */
	const BOOT_STUCK_MS = 180_000;
	/** Cache-buster so the last-seen image refreshes after each capture. */
	let thumbVersion = $state(0);
	/**
	 * The screen is watch-only until you unlock it, so a stray click cannot
	 * drive someone else's computer. Unlocking reloads the viewer without
	 * noVNC's view_only flag.
	 */
	let unlocked = $state(false);
	/**
	 * Where the bot's pointer is, as a fraction of its screen.
	 *
	 * noVNC draws whatever cursor the sandbox sends, and the sandbox often sends
	 * none, so the pointer is invisible exactly when you want to watch the bot
	 * work. This is read from the sandbox itself and drawn over the viewer, big
	 * and pink, so it is obvious where the mouse is even when nothing is moving
	 * on screen.
	 */
	let pointer = $state<{ fx: number; fy: number } | null>(null);
	/** The sandbox screen's aspect, so the overlay can be aligned to noVNC's fit. */
	let frameAspect = $state(0);
	/** The viewer blown up over the app, instead of the small tile in the panel. */
	let expanded = $state(false);
	/**
	 * The police's verdict on a routine or wake, read back from the row's JSON;
	 * null means it was never reviewed (or the row predates the gate).
	 */
	function verdictOf(row: { verification?: string }): Verification | null {
		if (!row.verification) return null;
		try {
			return JSON.parse(row.verification) as Verification;
		} catch {
			return null;
		}
	}
	/** What the verdict reads as on the row. */
	function verdictLabel(v: Verification): string {
		return v.verdict === 'approved' ? 'verified' : v.verdict === 'rejected' ? 'refused' : 'unverified';
	}
	/** Which machine the panel is watching: the desktop sandbox or the shell box. */
	let view = $state<'desktop' | 'shell'>('desktop');
	/**
	 * The viewer's rendered size. The pointer overlay is placed inside it, and
	 * that size changes when the viewer is expanded, so it is measured rather
	 * than assumed - a hardcoded box put the drawn arrow in the wrong place the
	 * moment the screen was a different size.
	 */
	let screenEl = $state<HTMLElement | null>(null);
	let screenBox = $state({ w: 0, h: 0 });

	const bot = $derived(chat.panelBot);
	/** How much machine this bot gets; '' reads as 'full' (see machine.ts). */
	const tier = $derived(bot?.machine_tier === 'terminal' || bot?.machine_tier === 'none' ? bot.machine_tier : 'full');

	/**
	 * Whether a gym round is in play. The scheduler logs the newest marker for
	 * each bot in the round and supersedes it when the round ends, so this reads
	 * the latest one rather than searching for any - with a short social interval
	 * an old 'on the gym' row is still recent when the next round starts, and
	 * looking for any of them left the bots on the bar permanently.
	 */
	const playingGym = $derived(chat.activities.find((a) => a.kind === 'gym')?.detail === ON_THE_GYM);
	/**
	 * Who is downstairs at the Wetherspoons: the bots whose newest pub marker
	 * says a treat is still on the table. Same newest-marker read as the gym -
	 * the scheduler writes 'in' when the offer lands and 'out' when it resolves
	 * or lapses, so the latest row is the truth.
	 */
	const inPub = $derived(
		new Set(
			chat.activities
				.filter((a) => a.kind === 'pub')
				.filter((a, i, arr) => arr.findIndex((b) => b.bot_id === a.bot_id) === i)
				.filter((a) => a.detail === IN_THE_PUB)
				.map((a) => a.bot_id)
		)
	);
	/**
	 * Who is at a computer right now. The backend exposes no usingComputer
	 * field on /api/bots (checked), so this is derived from the activity feed:
	 * a computer-touching activity - shell, browser, sandbox, computer -
	 * newer than two minutes counts as at the desk. The feed polls on its own
	 * cadence, so this trails reality by at most one poll.
	 */
	const USING_KINDS = ['shell', 'browser', 'sandbox', 'computer'];
	const gymUsing = $derived(
		new Set(
			chat.activities
				.filter((a) => USING_KINDS.includes(a.kind) && Date.now() - a.created_at < 120_000)
				.map((a) => a.bot_id)
		)
	);
	const working = $derived(chat.botWorking);
/**
 * What the working bot is doing right now: its freshest computer-touching
 * activity's detail - clipped to one short line - so the desk line reads live
 * instead of sitting static. Falls back to the generic label when the freshest
 * activity carries no detail, or none is fresh.
 */
const deskLine = $derived.by(() => {
	const id = bot?.id ?? '';
	if (id) {
		const cutoff = Date.now() - 120_000;
		for (const a of chat.activities) {
			if (a.created_at < cutoff) break;
			if (a.bot_id !== id || !USING_KINDS.includes(a.kind)) continue;
			const flat = a.detail.replace(/\s+/g, ' ').trim();
			if (!flat) break;
			// Cut on code points, not UTF-16 units, so no lone surrogate.
			const chars = [...flat];
			return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : flat;
		}
	}
	return 'at the keyboard';
});
	/**
	 * Whether the machine is serving a desktop at all: the container running
	 * and the desktop ready. This is the pair that only moves on a real
	 * transition - the machine starting or stopping, its desktop coming up or
	 * going away - so it is what the viewer is keyed on.
	 */
	const screenServing = $derived(status?.state === 'running' && status?.desktop === 'ready');
	/**
	 * Whether the viewer is up. Latched rather than read straight off the
	 * status, because the status poll re-ensures the gateway whenever its port
	 * reads 0: the port blips to 0 for a round trip while the gateway is
	 * recreated, and a viewer keyed on the raw port was torn down and rebuilt
	 * on every blip - the flicker of the screen stopping and starting again.
	 * The latch only drops when the machine itself stops serving, which is the
	 * real transition; a port that is briefly missing is the RFB client's own
	 * reconnect to cover, and the relay refuses the socket until the gateway is
	 * back, so nothing is dialled into a dead port.
	 */
	let live = $state(false);
	$effect(() => {
		if (!screenServing) live = false;
		else if (status?.vncPort) live = true;
	});
	/** The machine is up but the desktop is still installing - show progress, not '…'. */
	const booting = $derived(status?.state === 'running' && status?.desktop === 'starting');
	/** The setup phase the machine's desktop is in, named by the script's stage markers. */
	const desktopStage = $derived(status?.desktop_stage ?? '');
	/**
	 * A wake request that has been in flight past the window the route takes to
	 * answer: the control comes back rather than the panel sitting on a spinner
	 * with nothing to press.
	 */
	const wakeStalled = $derived(waking && wakeSeconds * 1000 >= WAKE_IN_FLIGHT_MS);
	/**
	 * A desktop that has been installing far longer than a healthy one. The
	 * panel says so and offers the retry, because a stage that stopped
	 * advancing with no way to kick it again is the "it just does not work".
	 */
	const bootStuck = $derived(booting && bootSeconds * 1000 >= BOOT_STUCK_MS);
	/**
	 * The line the panel shows for the last wake failure, in the user's terms.
	 * Each cause needs a different thing done about it, so they are not folded
	 * into one message: unreachable means the app itself is down, refused means
	 * the server said no and said why, a timeout means the boot outlived the
	 * server's window, and a stuck boot means the desktop never finished.
	 */
	const wakeMessage = $derived.by(() => {
		if (wakeFailure === 'unreachable') return 'Could not reach the server — the app may be down.';
		if (wakeFailure === 'refused') return wakeDetail || 'The server refused the wake.';
		if (wakeFailure === 'timeout')
			return 'The wake did not finish in the server’s window — the machine is still starting.';
		if (bootStuck)
			return `Still installing after ${bootSeconds}s${desktopStage ? ` · ${desktopStage}` : ''} — retry to kick it again.`;
		return '';
	});
	/**
	 * What the wake control does next. It is never left dead: a wake in flight
	 * disables it only for the bounded window the route takes to answer, and a
	 * boot that drags on hands it back as a retry.
	 */
	const wakeAction = $derived<'waking' | 'retry' | 'wake'>(
		waking && !wakeStalled ? 'waking' : booting || wakeStalled || wakeFailure ? 'retry' : 'wake'
	);
	/**
	 * Why the last desktop setup run died, in the setup script's own words. It
	 * is shown wherever the panel would otherwise have nothing useful to say:
	 * a stage that stopped advancing with no reason anywhere is exactly the
	 * "the desktop just does not work" the screen used to report.
	 */
	const desktopError = $derived(status?.desktop_error ?? '');
	/**
	 * The bot the viewer dials, as a scalar. The connection effect must depend
	 * on the id itself, never on the object it came from: `status` is replaced
	 * wholesale by every status poll and the store hands back a fresh bot object
	 * on every refresh, so an effect reading either one tore the RFB connection
	 * down and rebuilt it every few seconds - which is exactly the flicker of
	 * control stopping and starting again.
	 */
	const screenBotId = $derived(bot?.id ?? '');
	/** Whether this panel is the police console rather than a bot's screen. */
	const screenHidden = $derived(!!bot?.hidden);
	/** Rate-limit frost: a chip by the bot's name while paused_until is in the
	 *  future; a small clock keeps the remaining minutes honest between polls. */
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	const pausedUntil = $derived(bot && !bot.hidden && (bot.paused_until ?? 0) > now ? bot.paused_until! : 0);

	/**
	 * The background task the panel's bot is running right now, if any: the
	 * tray knows the ask by title, this panel would otherwise sit silent while
	 * the bot grinds away on it. `now` above keeps the age line honest between
	 * polls.
	 */
	const panelTask = $derived.by(() => {
		void now;
		const id = bot?.id ?? '';
		if (!id) return null;
		return chat.runningTasks.find((t) => t.bot_id === id) ?? null;
	});

	/** The ask a running task is working on: the generated title, else the prompt. */
	const panelTaskTitle = $derived.by(() => {
		const t = panelTask;
		if (!t) return '';
		const label = t as Task & { title?: string };
		return label.title || t.prompt || 'something';
	});

	/** How long the panel's running task has been going, for its banner. */
	const panelTaskElapsed = $derived.by(() => {
		const t = panelTask;
		if (!t) return '';
		const s = Math.max(1, Math.round(((t.finished_at || now) - t.created_at) / 1000));
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m ${s % 60}s`;
	});
	/**
	 * Whether the panel is showing a place rather than a bot: the bots-only
	 * lounge or a group room. A room has furniture (the gym, the wall) and its
	 * own log, and none of the per-bot machinery - machine tabs, routines,
	 * secrets, the token meter - which has no subject in a room. A 1:1 chat with
	 * a bot is not a room and keeps all of it.
	 */
	const room = $derived(
		!!chat.activeConversation?.private || chat.activeConversation?.kind === 'group'
	);

	/**
	 * The private Lounge (titled 'Lounge', the way the scheduler and the police
	 * find it) keeps gossip instead of a log: one playful line per visible bot,
	 * drawn only from what the chat store already holds - its lifetime token
	 * bill, its newest activity, its routines, its police record - so no new
	 * fetches. Other rooms keep the raw log.
	 */
	const isLoungeRoom = $derived(
		chat.activeConversation ? isLounge(chat.activeConversation) : false
	);
	const loungeFacts = $derived.by((): { id: string; name: string; color: string; line: string }[] => {
		const bots = chat.visibleBots;
		if (!bots.length) return [];
		const ranked = [...bots].sort((a, b) => tokensOf(b) - tokensOf(a));
		const top = ranked.at(0);
		const fattest = top && tokensOf(top) > 0 ? top.id : '';
		const specific = new Map<string, string>();
		for (const b of bots) {
			const stretches = b.jail_count ?? 0;
			const latest = chat.activities.find((a) => a.bot_id === b.id);
			const routines = chat.routines.filter((r) => r.bot_id === b.id).length;
			const tokens = tokensOf(b);
			if (stretches > 0) {
				specific.set(b.id, `has done ${stretches} stretch${stretches === 1 ? '' : 'es'} in the cooler`);
			} else if (b.id === fattest) {
				specific.set(b.id, `holds the fattest bill in the lounge (${shortTokens(tokens)} lifetime tokens)`);
			} else if (latest) {
				specific.set(b.id, `caught ${latest.kind} at ${fmtWhen(latest.created_at)}`);
			} else if (routines > 0) {
				specific.set(b.id, `runs ${routines} routine${routines === 1 ? '' : 's'} behind the bar`);
			} else if (tokens > 0) {
				const label = bloatLabel(tokens);
				specific.set(b.id, `sports ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} waistline on ${shortTokens(tokens)} lifetime tokens`);
			}
		}
		// Thin data is the quiet line, not a row of shrugs - but once one bot
		// has real gossip, the rest admit they are keeping quiet.
		if (!specific.size) return [];
		return bots.map((b) => ({
			id: b.id,
			name: b.name,
			color: b.color,
			line: specific.get(b.id) ?? 'keeps its cards close — nothing on the books yet'
		}));
	});

	/**
	 * The RFB client is driven directly rather than framing vnc_lite.html, so
	 * the connection survives the controls: unlocking flips viewOnly and
	 * expanding resizes the remote desktop to fit, instead of reloading a whole
	 * viewer each time. The module is the sandbox's own, served same-origin
	 * through the app's /vnc proxy so the dynamic import resolves.
	 */
	let rfbEl = $state<HTMLElement | null>(null);
	/**
	 * The live client, as state rather than a plain local: the lock is applied
	 * when this changes, so a client that had to reconnect comes back in the
	 * state the human left it in instead of noVNC's default.
	 */
	let rfb = $state<{
		viewOnly: boolean;
		scaleViewport: boolean;
		resizeSession: boolean;
		disconnect: () => void;
		addEventListener: (t: string, f: (e: unknown) => void) => void;
		clipboardPasteFrom: (text: string) => void;
	} | null>(null);
	/** True once the live VNC stream has painted its first frame. */
	let frameSeen = $state(false);

	$effect(() => {
		const el = rfbEl;
		const id = screenBotId;
		if (!el || !id || !live) return;
		// First frame has not landed yet: the cached thumbnail stays up, blurred,
		// under the canvas so the panel is never a black rectangle while the
		// handshake and the first framebuffer update travel the wire.
		frameSeen = false;
		let dead = false;
		let retry: ReturnType<typeof setTimeout> | null = null;
		const connect = async () => {
			try {
				const mod = await import(
					/* @vite-ignore */ `/api/bots/${id}/vnc/core/rfb.js`
				);
				if (dead) return;
				const RFB = mod.default;
				// The app's own relay, not the machine's gateway: that port is
				// bound to the app host's loopback, so the browser cannot dial
				// it. Same origin, so the session cookie rides along.
				const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
				const ws = `${proto}//${location.host}/api/bots/${id}/vnc-ws`;
				const client = new RFB(el, ws, {});
				client.scaleViewport = true;
				// scaleViewport, not resizeSession: asking the sandbox's Xvnc to
				// resize the remote desktop on expand is what blanked the screen -
				// the framebuffer went away while the server failed the resize.
				// Scaling the existing framebuffer always has a picture to show.
				client.resizeSession = false;
				// LAN, not the internet: favour a sharp, responsive picture over
				// bandwidth. High quality + low compression keeps text crisp and the
				// frame rate up; the defaults read as a soft, laggy preview.
				client.qualityLevel = 8;
				client.compressionLevel = 0;
				// The remote's copies land here over VNC's clipboard channel; the
				// Copy button hands the latest one to the local clipboard.
				client.addEventListener('clipboardreceive', (e: { detail?: { text?: string } }) => {
					remoteClip = e.detail?.text ?? '';
				});
				client.addEventListener('disconnect', () => {
					// A dropped screen reconnects on its own rather than going blank
					// until the panel is reopened.
					frameSeen = false;
					if (!dead) retry = setTimeout(connect, 2000);
				});
				// First framebuffer update = the real picture has arrived; swap the
				// blurred thumbnail out from under the canvas.
				client.addEventListener('desktopname', () => {
					frameSeen = true;
				});
				rfb = client;
			} catch {
				if (!dead) retry = setTimeout(connect, 3000);
			}
		};
		void connect();
		return () => {
			dead = true;
			if (retry) clearTimeout(retry);
			rfb?.disconnect();
			rfb = null;
		};
	});

	// The controls act on the live connection: unlocking hands the keyboard and
	// mouse over. Expanding only changes the viewer's box - scaleViewport fits
	// the framebuffer to it, no remote resize needed.
	$effect(() => {
		if (!rfb) return;
		rfb.viewOnly = !unlocked;
	});

	/**
	 * Clipboard across the VNC line. noVNC keeps a clipboard channel: the
	 * remote's copies arrive as `clipboardreceive` events (kept above), and
	 * `clipboardPasteFrom` injects local text into the remote's clipboard so a
	 * paste there carries it. Both ends touch the local clipboard, whose
	 * permission can be refused - that is a note, never a crash.
	 */
	let remoteClip = $state('');
	let clipNote = $state('');
	let clipNoteTimer: ReturnType<typeof setTimeout> | null = null;
	function noteClip(msg: string) {
		clipNote = msg;
		if (clipNoteTimer) clearTimeout(clipNoteTimer);
		clipNoteTimer = setTimeout(() => (clipNote = ''), 2500);
	}

	/** Send the local clipboard into the remote desktop's clipboard. */
	async function pasteToRemote() {
		if (!rfb) return;
		try {
			const text = await navigator.clipboard.readText();
			if (!text) return noteClip('Local clipboard is empty.');
			rfb.clipboardPasteFrom(text);
			noteClip('Pasted to the remote clipboard — Ctrl+V there.');
		} catch {
			noteClip('Could not read the local clipboard (permission refused).');
		}
	}

	/** Take the remote's latest copy and hand it to the local clipboard. */
	async function copyFromRemote() {
		if (!remoteClip) return noteClip('Nothing has been copied on the remote yet.');
		try {
			await navigator.clipboard.writeText(remoteClip);
			noteClip('Copied to your clipboard.');
		} catch {
			noteClip('Could not write the local clipboard (permission refused).');
		}
	}

	/** Ctrl+Shift+V, or Cmd+V on a Mac, pastes into the viewer when driving. */
	function viewerKeydown(e: KeyboardEvent) {
		const pasteKeys = (e.ctrlKey && e.shiftKey && e.key === 'V') || (e.metaKey && e.key === 'v');
		if (!pasteKeys || !unlocked) return;
		e.preventDefault();
		void pasteToRemote();
	}

	/**
	 * Every real flip of the lock is reported, so the bot learns its machine
	 * changed hands: the button, and the collapse effect below that hands
	 * control back on the way down. The first state is not reported (nothing
	 * flipped yet), and the server folds repeats - a second tab, a viewer
	 * reconnect - so one handover is one event in the bot's DM.
	 */
	let reportedDriving: boolean | null = null;
	$effect(() => {
		const id = screenBotId;
		if (reportedDriving === unlocked) return;
		const first = reportedDriving === null;
		reportedDriving = unlocked;
		if (first || !id) return;
		void fetch(`/api/bots/${id}/sandbox`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'control', driving: unlocked })
		}).catch(() => {});
	});

	$effect(() => {
		// Another bot's names must not linger under this one's tab while its
		// own list is still loading. Keyed on the id: a store refresh hands
		// back an equal bot object, and that must not refetch the list.
		secrets = [];
		const id = screenBotId;
		if (id) void loadSecrets(id);
	});

	// The plugins list follows the same bot as the secrets above: the routines
	// tab shows each one's police verdict, so another bot's rows must not stand
	// in while this one's load.
	$effect(() => {
		const id = screenBotId;
		if (id) void chat.loadBotPlugins(id);
	});

	// Read the pointer on a timer, but only while there is a live screen to draw
	// it on and the tab is actually being looked at. The next read is scheduled
	// after the current one settles - never setInterval - so a hung sandbox
	// endpoint cannot stack requests up and starve every other fetch on the
	// page. Consecutive failures back the interval off.
	$effect(() => {
		const id = bot?.id;
		if (!id || !live || view !== 'desktop') {
			pointer = null;
			return;
		}
		let cancelled = false;
		let failures = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const read = async () => {
			if (document.hidden) {
				timer = setTimeout(read, unlocked ? 250 : 700);
				return;
			}
			const ac = new AbortController();
			const killer = setTimeout(() => ac.abort(), 4000);
			try {
				const res = await fetch(`/api/bots/${id}/sandbox?pointer=1`, { signal: ac.signal });
				if (!res.ok || cancelled) return;
				const p = await res.json();
				failures = 0;
				if (!p || cancelled) {
					pointer = null;
					return;
				}
				frameAspect = p.w / p.h;
				pointer = { fx: p.x / p.w, fy: p.y / p.h };
			} catch {
				// Leave the last position rather than flickering it away.
				failures++;
			} finally {
				clearTimeout(killer);
				if (!cancelled) {
					// Watching the bot work is the case this exists for, so it can be
					// lazy; once you are driving, the pointer has to keep up with your
					// own hand or it reads as a laggy second cursor.
					const base = unlocked ? 250 : 700;
					timer = setTimeout(read, base * Math.min(8, 2 ** failures));
				}
			}
		};
		void read();
		// A backgrounded tab freezes the overlay where it was; on return, read
		// now rather than leaving the stale arrow up until the next tick.
		const onVisible = () => {
			if (!document.hidden && !cancelled) {
				if (timer) clearTimeout(timer);
				void read();
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			document.removeEventListener('visibilitychange', onVisible);
			if (timer) clearTimeout(timer);
		};
	});

	/*
	 * The expanded viewer covers the app, so Esc is the way out without hunting
	 * for the button that is now in its top corner.
	 */
	$effect(() => {
		if (!expanded) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') expanded = false;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	/** A sleeping machine has no live viewer to blow up. */
	$effect(() => {
		if (!live) expanded = false;
	});

	// Collapsing the viewer hands control back: a small tile that still drives
	// the machine is one stray click away from typing into it, and the padlock
	// is easy to miss down there. `unlocked` is written, never read, so this
	// only fires when `expanded` flips - unlocking the small tile still works.
	$effect(() => {
		if (!expanded) unlocked = false;
	});

	/**
	 * Clicking away hands control back: while the human is driving, a
	 * pointerdown outside the screen releases the capture the same way the
	 * padlock does. It fires on pointerdown, before the click lands, so the
	 * release can never also click something inside the machine - and a press
	 * inside the screen (the padlock included) is left alone.
	 */
	function clickOutReleases(e: PointerEvent) {
		if (!unlocked) return;
		const el = screenEl;
		if (el && e.target instanceof Node && el.contains(e.target)) return;
		unlocked = false;
	}

	/*
	 * The viewer's own size, kept current across panel resizes and the expand
	 * toggle. A ResizeObserver rather than a one-off read: the panel can change
	 * shape (window resize, expand, collapse) without this component re-rendering.
	 */
	$effect(() => {
		const el = screenEl;
		if (!el) return;
		const measure = () => {
			screenBox = { w: el.clientWidth, h: el.clientHeight };
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	});

	/** The framebuffer fitted into the viewer, the way noVNC's resize=scale does. */
	const fitted = $derived.by(() => {
		if (!pointer || !frameAspect || !screenBox.w || !screenBox.h) return null;
		const boxAspect = screenBox.w / screenBox.h;
		const w = frameAspect > boxAspect ? screenBox.w : screenBox.h * frameAspect;
		const h = frameAspect > boxAspect ? screenBox.w / frameAspect : screenBox.h;
		return { w, h, left: (screenBox.w - w) / 2, top: (screenBox.h - h) / 2 };
	});

	$effect(() => {
		// A hidden bot (the police) has a console instead of a screen, and a
		// chat-only or terminal-only bot has no desktop to poll for - asking for
		// its status would only keep a dead endpoint warm. Read through scalars:
		// the store hands back a fresh bot object on every refresh, and an
		// effect that read the object restarted the poll each time, which threw
		// away the backoff (and every status poll replaces `status`, so it also
		// churned everything downstream of it).
		const id = screenBotId;
		if (!id || screenHidden || tier !== 'full') {
			status = null;
			return;
		}
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let lastSnap = 0;
		/**
		 * The status poll, rescheduling itself each round like the chat store's
		 * ambient polls: a hidden tab fetches nothing, and a machine whose
		 * status stops changing waits a little longer each time up to the cap.
		 * Waking, booting and running start brisk so the screen appears the
		 * moment it can; the signature ignores lastActive, which the poll
		 * itself refreshes and which would otherwise look like constant change.
		 */
		let lastSig = '';
		let delay = waking ? 1500 : 8000;
		const tick = async () => {
			if (cancelled) return;
			if (document.hidden) {
				timer = setTimeout(() => void tick(), delay);
				return;
			}
			try {
				const res = await fetch(`/api/bots/${id}/sandbox`);
				if (res.ok && !cancelled) {
					const s = (await res.json()) as SandboxStatus;
					const sig = `${s.state}|${s.desktop}|${s.desktop_stage ?? ''}|${s.desktop_error ?? ''}|${s.vncPort}|${s.hasThumbnail}`;
					const min = waking || s.state === 'running' ? 1500 : 8000;
					delay = sig !== lastSig ? min : Math.min(Math.max(delay * 1.5, min), 30_000);
					lastSig = sig;
					status = s;
				}
			} catch {
				// A blip leaves the last status rather than blanking the panel.
			}
			// While the desktop is serving, keep a fresh last-seen frame on disk
			// so the thumbnail is accurate the moment it sleeps - on the same
			// chain, so it too slows down on a quiet machine and stops hidden.
			// A desktop still installing has no frame to grab, so the POST would
			// only 502.
			if (!cancelled && status?.desktop === 'ready' && Date.now() - lastSnap >= 8000) {
				lastSnap = Date.now();
				void fetch(`/api/bots/${id}/sandbox/snapshot`, { method: 'POST' })
					.then((r) => r.ok && thumbVersion++)
					.catch(() => {});
			}
			if (!cancelled) timer = setTimeout(() => void tick(), delay);
		};
		void tick();
		// A backgrounded tab freezes the panel where it was; on return, poll now
		// rather than leaving a stale status up until the next tick.
		const onVisible = () => {
			if (document.hidden || cancelled) return;
			delay = waking || status?.state === 'running' ? 1500 : 8000;
			if (timer) clearTimeout(timer);
			void tick();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			document.removeEventListener('visibilitychange', onVisible);
			if (timer) clearTimeout(timer);
		};
	});

	// Counts the seconds the desktop has been installing so a slow apk run
	// reads as progress rather than a dead '…' placeholder.
	$effect(() => {
		if (!booting) {
			bootStartedAt = 0;
			bootSeconds = 0;
			return;
		}
		if (!bootStartedAt) bootStartedAt = Date.now();
		const t = setInterval(() => {
			bootSeconds = Math.round((Date.now() - bootStartedAt) / 1000);
		}, 500);
		return () => clearInterval(t);
	});

	async function wake() {
		// A second click while the first request is still out would only start
		// the same boot twice; the control is disabled for that window anyway.
		if (!bot || waking) return;
		waking = true;
		wakeStartedAt = Date.now();
		wakeSeconds = 0;
		wakeFailure = '';
		wakeDetail = '';
		const startedAt = Date.now();
		try {
			const res = await fetch(`/api/bots/${bot.id}/sandbox`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'wake' })
			});
			if (res.ok) {
				// The route answers with the machine's own status, so a wake that
				// is already running or installing shows that at once instead of
				// the panel's generic spinner.
				const s = (await res.json()) as SandboxStatus;
				status = s;
				// The route races its boot against a 12s delay: a 200 that lands
				// at the end of that window with the machine still not serving is
				// the wake having timed out, not one that worked.
				if (Date.now() - startedAt >= WAKE_RACE_MS && !(s.state === 'running' && s.desktop === 'ready'))
					wakeFailure = 'timeout';
			} else {
				// The server's own message, as it sent it: a 503 names Docker, a
				// 404 names the bot, and the user needs to see which it was.
				const body = await res.json().catch(() => null);
				wakeFailure = 'refused';
				wakeDetail = body?.message ?? `The server refused the wake (${res.status}).`;
			}
		} catch {
			wakeFailure = 'unreachable';
		} finally {
			waking = false;
		}
	}

	// Counts the seconds while a wake is in flight so a slow boot reads as progress
	// rather than as a button that did nothing.
	$effect(() => {
		if (!waking) return;
		const t = setInterval(() => {
			wakeSeconds = Math.round((Date.now() - wakeStartedAt) / 1000);
		}, 250);
		return () => clearInterval(t);
	});

	let secrets = $state<{ id: string; name: string; shared_with: string }[]>([]);

	/** One glyph per kind of thing a bot did. */
	const KIND_ICON: Record<string, string> = {
		replied: '💬',
		thinking: '🤔',
		dreaming: '☕',
		error: '⚠️',
		routine: '🔁',
		wake: '⏰',
		wait: '⏳',
		webhook: '🪝',
		sandbox: '📦',
		secret: '🔑',
		browser: '🌐',
		group: '👥',
		message: '✉️',
		plugin: '🧩',
		schedule: '📅',
		shell: '⌨️',
		ping: '🔔',
		task: '⚙️',
		reacted: '❤️',
		block: '⛔',
		unblock: '🤝',
		police: '🚨',
		docs: '📄',
		gym: '🏋️',
		computer: '🖥️',
		typing: '✍️',
		style: '🎨',
		bot: '🤖',
		system: '🛠'
	};
	/** Bots the police have on ice, for the console's Block/Unblock button. */
	let policeBlocks = $state<string[]>([]);
	let policeBusy = $state('');

	/** The usage chart's rows: one point per task, oldest first. */
	type UsageTask = {
		id: string;
		created_at: number;
		tokens_in: number;
		tokens_out: number;
		/** Prompt tokens the provider served from its cache. */
		cache_read: number;
		/** Prompt tokens the provider wrote into it. */
		cache_write: number;
		/**
		 * Whether this task's calls sent cache fields at all. A 0 under it is a
		 * real miss; a 0 without it is a provider that does not report cache,
		 * and must not be drawn as a miss.
		 */
		cache_reported: boolean;
		/** What the provider said the task cost; null when it named no price. */
		cost: number | null;
		/** The estimate against the best known rate; null when there is none. */
		estimated_cost: number | null;
		/** The model that served the task; '' when nothing recorded one. */
		model: string;
	};
	/** One model's share of the spend, as the usage route groups it. */
	type ModelSpend = {
		model: string;
		tasks: number;
		tokens_in: number;
		tokens_out: number;
		cost: number | null;
		estimated_cost: number | null;
	};
	let usage = $state<{
		tasks: UsageTask[];
		by_model: ModelSpend[];
		totals: {
			in: number;
			out: number;
			cache_read: number;
			cache_write: number;
			/** Cache reads over the prompt tokens of reporting tasks; null when none reported. */
			cache_hit_rate: number | null;
			/** The provider's own bill across priced tasks; null when none named a price. */
			cost: number | null;
			/** The estimate across unpriced tasks; null when there is none. */
			estimated_cost: number | null;
		};
	} | null>(null);
	/** Which task the chart's pointer or arrow keys are on, or -1 for none. */
	let usageHover = $state(-1);
	/** Whether the meter under the tabs is showing the figures behind the chart. */
	let meterOpen = $state(false);

	/** The meter's hover text: the same figures its detail block shows. */
	const meterTitle = $derived(
		usage
			? `Last 24 hours · ${usage.tasks.length} task${usage.tasks.length === 1 ? '' : 's'} · ${usage.totals.in.toLocaleString()} tokens in · ${usage.totals.out.toLocaleString()} tokens out`
			: 'Reading the last 24 hours…'
	);

	/** The feed's row cap; what does not fit is summarised by one line. */
	const FEED_MAX = 50;
	/**
	 * Consecutive entries of one kind collapse into a single row showing the
	 * newest one's detail with a xN count - a burst of 'thinking' rows is one
	 * fact, not twelve. An entry carrying a screenshot always stands alone:
	 * folding it away would hide the only part worth seeing.
	 */
	const feedRows = $derived.by(() => {
		const rows: { a: (typeof chat.activities)[number]; n: number }[] = [];
		for (const a of chat.activities) {
			const last = rows.at(-1);
			if (last && last.a.kind === a.kind && !a.image) last.n++;
			else rows.push({ a, n: 1 });
		}
		return rows;
	});
	const feedShown = $derived(feedRows.slice(0, FEED_MAX));
	const feedEarlier = $derived(
		chat.activities.length - feedShown.reduce((n, r) => n + r.n, 0)
	);
	let policeNote = $state('');

	/** The console's block list, refreshed after every order it gives. */
	async function loadPoliceConsole() {
		const res = await fetch('/api/police/action').catch(() => null);
		if (res?.ok) {
			const data = await res.json();
			policeBlocks = (data.blocked ?? []).map((b: { blocked_id: string }) => b.blocked_id);
		}
	}

	/** One order from the console: warn lands in the police log, the rest act. */
	async function policeAction(action: 'warn' | 'block' | 'unblock', botId: string) {
		if (policeBusy) return;
		policeBusy = `${action}:${botId}`;
		try {
			const res = await fetch('/api/police/action', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, bot_id: botId })
			});
			if (!res.ok) policeNote = `The ${action} was refused (${res.status}).`;
			await loadPoliceConsole();
		} catch {
			policeNote = `The ${action} could not be sent.`;
		} finally {
			policeBusy = '';
		}
	}

	/** Sleep/wake go to the bot's own sandbox route, not the police one. */
	async function sandboxAction(action: 'sleep' | 'wake', botId: string) {
		if (policeBusy) return;
		policeBusy = `${action}:${botId}`;
		try {
			const res = await fetch(`/api/bots/${botId}/sandbox`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
			if (!res.ok) policeNote = `The ${action} was refused (${res.status}).`;
		} catch {
			policeNote = `The ${action} could not be sent.`;
		} finally {
			policeBusy = '';
		}
	}

	$effect(() => {
		if (screenHidden) void loadPoliceConsole();
	});

	// The meter under the tabs reads the same window as the chart, so the fetch
	// follows the bot rather than the tab: switching bots refetches, and the old
	// bot's numbers are dropped at once rather than standing in for the new
	// one's until the response lands. Keyed on the id, not the bot object, so a
	// refreshed bot list does not refetch the same figures.
	$effect(() => {
		const id = screenBotId;
		usage = null;
		usageHover = -1;
		if (!id) return;
		let cancelled = false;
		void fetch(`/api/bots/${id}/usage`)
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				if (!cancelled) usage = data;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	/**
	 * Whether any of this bot's calls reported cache figures. Older tasks
	 * predate the columns and a provider that says nothing leaves them at zero:
	 * without this the chart would draw a line along the floor, which reads as
	 * "nothing was ever cached" rather than "nobody measured". Absent counts as
	 * unmeasured too - a route that predates the columns sends no field at all.
	 */
	const cacheMeasured = $derived(!!usage && usage.totals.cache_hit_rate != null);

	/**
	 * The chart's own coordinates. The polylines, the guide line and the hover
	 * hit test all read them, so a point cannot be drawn and read differently.
	 */
	const CHART_W = 300;
	const CHART_H = 90;
	const CHART_PAD = 4;

	/** The polyline points for one series: cumulative spend, so the line reads
	 *  as the meter filling up rather than a spiky per-task scatter. */
	function usagePoints(key: 'in' | 'out' | 'total' | 'cache'): string {
		const tasks = usage?.tasks ?? [];
		if (!tasks.length) return '';
		const cum = tasks.map((t) => ({
			in: t.tokens_in,
			out: t.tokens_out,
			total: t.tokens_in + t.tokens_out,
			// Only counted where the provider said something, so an unreported
			// task carries the previous total forward instead of reading as a
			// miss the provider never claimed.
			cache: t.cache_reported ? t.cache_read : 0
		}));
		for (let i = 1; i < cum.length; i++) {
			cum[i].in += cum[i - 1].in;
			cum[i].out += cum[i - 1].out;
			cum[i].total += cum[i - 1].total;
			cum[i].cache += cum[i - 1].cache;
		}
		// One scale for every series, so the cache line sits where it belongs
		// against the input it was served out of.
		const max = Math.max(1, cum.at(-1)!.total);
		return cum
			.map((c, i) => {
				const x = usageX(i);
				const y = CHART_H - CHART_PAD - (c[key] / max) * (CHART_H - CHART_PAD * 2);
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	}

	/** The task nearest a point in the chart's viewBox coordinates. */
	function usageIndexAt(x: number): number {
		const n = usage?.tasks.length ?? 0;
		if (!n) return -1;
		if (n === 1) return 0;
		const i = Math.round(((x - CHART_PAD) / (CHART_W - CHART_PAD * 2)) * (n - 1));
		return Math.max(0, Math.min(n - 1, i));
	}

	/** Where one task sits across the chart, for the guide line. */
	function usageX(i: number): number {
		const n = usage?.tasks.length ?? 0;
		if (n <= 1) return CHART_W / 2;
		return CHART_PAD + (i / (n - 1)) * (CHART_W - CHART_PAD * 2);
	}

	/** The task the readout under the chart names. */
	const usageHovered = $derived(usageHover >= 0 ? (usage?.tasks[usageHover] ?? null) : null);

	/** Point the readout at the task under the cursor. */
	function onChartMove(e: PointerEvent) {
		const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
		if (!rect.width) return;
		// The viewBox is stretched to the element's width, so the cursor maps
		// straight onto the chart's own 0-300 coordinates.
		usageHover = usageIndexAt(((e.clientX - rect.left) / rect.width) * CHART_W);
	}

	/** Arrow keys walk the same points the pointer does, so the readout is not mouse-only. */
	function onChartKey(e: KeyboardEvent) {
		const n = usage?.tasks.length ?? 0;
		if (!n) return;
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault();
			const step = e.key === 'ArrowRight' ? 1 : -1;
			// Starting from nothing, the first press lands on the near end.
			const from = usageHover < 0 ? (step > 0 ? -1 : n) : usageHover;
			usageHover = Math.max(0, Math.min(n - 1, from + step));
		} else if (e.key === 'Home') {
			e.preventDefault();
			usageHover = 0;
		} else if (e.key === 'End') {
			e.preventDefault();
			usageHover = n - 1;
		} else if (e.key === 'Escape') {
			usageHover = -1;
		}
	}
	const iconFor = (kind: string) => KIND_ICON[kind] ?? '•';
	let tab = $state<'routines' | 'activity' | 'secrets' | 'usage'>('activity');
	let shotOf = $state('');
	let lightboxEl = $state<HTMLElement | null>(null);
	// The lightbox covers the app like the expanded viewer, so Escape closes it
	// and focus moves in so keyboard users are not left outside a modal.
	$effect(() => {
		if (!shotOf) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') shotOf = '';
		};
		window.addEventListener('keydown', onKey);
		void tick().then(() => lightboxEl?.focus());
		return () => window.removeEventListener('keydown', onKey);
	});

	/**
	 * Which routine row is open for editing, and the fields being edited in it.
	 * A click on a row opens the form in place; saving re-reads the bot, so the
	 * row the panel shows is the one the database holds.
	 */
	let editingId = $state('');
	let editPrompt = $state('');
	let editCron = $state('');
	let editMinutes = $state(1);
	let editEnabled = $state(true);
	let editBusy = $state(false);
	let editError = $state('');

	async function loadSecrets(id: string) {
		const res = await fetch(`/api/bots/${id}/secrets`).catch(() => null);
		// The panel may have moved to another bot while this was in flight.
		if (res?.ok && screenBotId === id) secrets = (await res.json()).secrets;
	}

	async function forgetSecret(name: string) {
		if (!bot) return;
		await fetch(`/api/bots/${bot.id}/secrets/${encodeURIComponent(name)}`, {
			method: 'DELETE'
		}).catch(() => {});
		await loadSecrets(bot.id);
	}

	/** The ask-a-bot form: the name of the secret to ask this bot for. */
	let askName = $state('');
	let askBusy = $state(false);
	/** What the last ask ended in, so a refusal is not silent. */
	let askNote = $state('');

	/**
	 * Ask this bot for a secret. The request goes through the same path the
	 * human's own chat uses - open the bot's direct conversation, then send - so
	 * it lands in the bot's thread as a message it will answer. The bot cannot
	 * invent a secret it does not have, so the words ask it to say what it needs
	 * or to store what the human hands over.
	 */
	async function askForSecret() {
		const name = askName.trim();
		if (!bot || !name || askBusy) return;
		askBusy = true;
		askNote = '';
		await chat.openDirect(bot.id);
		// openDirect leaves the previous chat open if it could not reach the
		// server, and sending then would put the ask in the wrong thread.
		const opened = chat.conversations.find((c) => c.id === chat.activeId);
		if (!opened || opened.kind !== 'direct' || opened.bot_ids !== bot.id) {
			askBusy = false;
			askNote = 'Could not open that bot’s chat.';
			return;
		}
		const sent = await chat.send(
			`Ask me for a secret called "${name}" — tell me what you need it for, and I'll give you the value to store with store_secret.`
		);
		askBusy = false;
		if (!sent) {
			askNote = chat.error || 'The ask could not be sent.';
			return;
		}
		askName = '';
		askNote = `Asked ${bot.name} — it can only ask you for what it needs, or store a value you give it.`;
	}

	/** Open a routine's row as a form, filled with what it currently holds. */
	function openEditor(r: Routine) {
		editingId = r.id;
		editPrompt = r.prompt;
		editCron = r.cron ?? '';
		editMinutes = r.interval_min;
		editEnabled = !!r.enabled;
		editError = '';
	}

	function closeEditor() {
		editingId = '';
		editError = '';
	}

	/*
	 * Save the open row. The schedule is only checked here far enough to answer
	 * the obvious blank; the route is the judge of cron and interval, and its
	 * refusal is what the form shows.
	 */
	async function saveEditor(id: string) {
		if (editBusy) return;
		if (!editPrompt.trim()) {
			editError = 'Say what the routine should do.';
			return;
		}
		if (!editCron.trim() && (!Number.isInteger(editMinutes) || editMinutes < 1)) {
			editError = 'Give at least 1 minute, or a cron expression.';
			return;
		}
		editBusy = true;
		editError = '';
		const refusal = await chat.updateRoutine(id, {
			prompt: editPrompt.trim(),
			interval_min: editMinutes,
			cron: editCron.trim(),
			enabled: editEnabled
		});
		editBusy = false;
		// On success the refreshed list is the row's new content; the form closes.
		if (refusal) editError = refusal;
		else editingId = '';
	}

	function fmtNext(ts: number): string {
		const mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
		if (mins < 60) return `in ${mins}m`;
		return `in ${Math.round(mins / 60)}h`;
	}

	function fmtWhen(ts: number): string {
		const d = new Date(ts);
		const today = new Date();
		if (d.toDateString() === today.toDateString()) {
			return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
		}
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	/** Activity details arrive as markdown; the feed shows plain text only. */
	function plain(text: string): string {
		return (
			text
				// A fenced block carries no meaning once the syntax is gone, so it
				// becomes a marker rather than a run-on of its contents.
				.replace(/```[\s\S]*?```/g, ' [code] ')
				.replace(/`([^`]*)`/g, '$1')
				.replace(/[*_#]/g, '')
				.replace(/\s+/g, ' ')
				.trim()
		);
	}
</script>

<svelte:window onpointerdown={clickOutReleases} />

{#snippet frostChip()}
	{#if pausedUntil}
		<span
			class="frost"
			title={`frozen — resumes in ${Math.max(1, Math.ceil((pausedUntil - now) / 60_000))}m`}
			aria-label={`frozen — resumes in ${Math.max(1, Math.ceil((pausedUntil - now) / 60_000))}m`}
		>❄ frozen</span>
	{/if}
{/snippet}

<!-- The wake control, shared by every state the panel can be in. It is never
     left dead: a wake in flight disables it only for the bounded window the
     route takes to answer, and a boot that drags on hands it back as a retry. -->
{#snippet wakeButton(label: string)}
	<button class="wake" disabled={wakeAction === 'waking'} onclick={wake}>
		{wakeAction === 'waking' ? 'Waking…' : wakeAction === 'retry' ? 'Retry wake' : label}
	</button>
{/snippet}

<!-- The activity feed, shared by a bot's Log tab and a room's own log: the rows
     are the same, it is only who they belong to that differs. -->
{#snippet activityFeed()}
	<div class="feed">
		{#if feedEarlier > 0}
			<span class="earlier">…and {feedEarlier} earlier</span>
		{/if}
		{#each feedShown as row (row.a.id)}
			<div class="act" title={row.a.kind}>
				<span class="icon">{iconFor(row.a.kind)}</span>
				<span class="main">
					<span class="detail">
						{plain(row.a.detail ?? '')}{#if row.n > 1}
							<span class="times">×{row.n}</span>
						{/if}
					</span>
					<span class="when">{fmtWhen(row.a.created_at)}</span>
				</span>
				{#if row.a.image}
					<button class="shotbtn" onclick={() => (shotOf = row.a.image ?? '')} title="View screen">
						<img src="/api/shots/{row.a.image}" alt="" />
					</button>
				{/if}
			</div>
		{:else}
			<span class="none">No recent activity</span>
		{/each}
	</div>
{/snippet}

<section class="panel">
	{#if bot}
		{#if panelTask}
			<!-- The bot is mid-task right now: what it is working on and how long
			     it has been going, said at the top where it cannot be missed -
			     the tray is where detail lives, but it must be opened to be read. -->
			<div class="taskbanner" title="A background task is running - open the tray to stop it">
				<span class="taskicon" aria-hidden="true">⏳</span>
				<span class="taskwhat">working on {panelTaskTitle}</span>
				<span class="taskage">{panelTaskElapsed}</span>
			</div>
		{/if}
		{#if bot.hidden}
			<!-- The police have no screen: their panel is the console they police
			     from. One row per visible bot, each order a real call. -->
			<div class="console">
				<span class="lbl">the police console - the fleet, on one page.</span>
				{#each chat.visibleBots as b (b.id)}
					<div class="crow">
						<Avatar color={b.color} seed={b.id} size={20} />
						<span class="cname">{b.name}</span>
						<span class="cacts">
							<button
								class="cbtn"
								disabled={!!policeBusy}
								title="Write a warning into the police log"
								onclick={() => policeAction('warn', b.id)}>Warn</button
							>
							{#if b.machine_tier !== 'none'}
								{@const machine = chat.presence[b.id]}
								<!-- Sleep only makes sense on a running machine, Wake only on
								     one that is not; the wrong-direction button stays on the
								     row but disabled until the presence poll says which way
								     is which, so the row never reflows between rounds. -->
								<button
									class="cbtn"
									disabled={!!policeBusy || machine === 'sleeping' || machine === 'off'}
									onclick={() => sandboxAction('sleep', b.id)}>Sleep</button
								>
								<button
									class="cbtn"
									disabled={!!policeBusy || machine === 'running'}
									onclick={() => sandboxAction('wake', b.id)}>Wake</button
								>
							{/if}
							{#if policeBlocks.includes(b.id)}
								<button
									class="cbtn"
									disabled={!!policeBusy}
									onclick={() => policeAction('unblock', b.id)}>Unblock</button
								>
							{:else}
								<button
									class="cbtn"
									disabled={!!policeBusy}
									onclick={() => policeAction('block', b.id)}>Block</button
								>
							{/if}
						</span>
					</div>
				{:else}
					<span class="none">No bots on the books.</span>
				{/each}
			</div>
			{#if policeNote}<p class="none">{policeNote}</p>{/if}
		{:else if chat.activeConversation?.private}
			<!-- The gym is furniture in the room; they are only on it while a round
			     is being played on it, which the scheduler marks in the log. -->
			<PlayGym bots={chat.activeBots} playing={playingGym} using={gymUsing} pub={inPub} />
		{:else if chat.activeConversation?.kind === 'group'}
			<!-- A group has no single computer: show whose notes are on the wall instead. -->
			<div class="groupnote">
				<span class="gname">{bot.name}{@render frostChip()}</span>
				<span class="gsub">
					{chat.activeBots.length} bots in this room · their own screens are on their own chats
				</span>
			</div>
			{#if tier === 'none'}
				<!-- A chat-only bot has no machine at all: no tabs, no screen. -->
				<div class="groupnote">
					<span class="gname">{bot.name}{@render frostChip()}</span>
					<span class="gsub">chat-only - no machine</span>
				</div>
			{/if}
		{:else}
		<div class="tabs machines">
			{#if tier === 'full'}
				<!-- A lightswitch-style flip between the bot's screen and its
				     terminal: one control, two states, the live side lit. -->
				<button
					class="viewswitch"
					class:shell={view === 'shell'}
					role="switch"
					aria-checked={view === 'shell'}
					title={view === 'shell' ? 'Switch to the desktop screen' : 'Switch to the terminal'}
					onclick={() => {
						view = view === 'shell' ? 'desktop' : 'shell';
						sndClick();
					}}
				>
					<span class="vslabel" class:on={view !== 'shell'}>🖥 Screen</span>
					<span class="vsthumb" aria-hidden="true"></span>
					<span class="vslabel" class:on={view === 'shell'}>⌨ Term</span>
				</button>
			{:else}
				<button class="tab sel" disabled>Terminal</button>
			{/if}
		</div>
		{#if view === 'shell' || tier === 'terminal'}
		<ShellTerm {bot} />
		{:else}
		{#if expanded}
			<!-- The dim behind the expanded viewer doubles as its click-away: a
			     click that lands on it rather than the screen shrinks the viewer
			     back into the panel. -->
			<div
				class="screenbackdrop"
				role="presentation"
				onclick={() => (expanded = false)}
			></div>
		{/if}
		<div class="screen" class:expanded class:driving={unlocked && live} bind:this={screenEl}>
			{#if live}
				{#if status?.hasThumbnail && !frameSeen}
					<!-- The last screenshot the machine took, blurred under the VNC
					     canvas until the first real frame lands - the panel reads as a
					     waking screen, not a black rectangle. -->
					<img
						class="thumb under"
						src="/api/bots/{bot.id}/sandbox/thumb?v={thumbVersion}"
						alt=""
						aria-hidden="true"
					/>
					<span class="wakeload"><span class="scan"></span>connecting…</span>
				{/if}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
				<!-- The viewer takes focus so Ctrl+Shift+V / Cmd+V has somewhere to land. -->
				<div
					class="vnc"
					bind:this={rfbEl}
					title="{bot.name}'s screen"
					role="application"
					aria-label="{bot.name}'s screen viewer"
					tabindex="0"
					onkeydown={viewerKeydown}
				></div>
				<div class="screentools">
					<button
						class="lockscreen"
						class:open={unlocked}
						title={unlocked ? 'Hand the screen back to the bot' : 'Take over the keyboard and mouse'}
						onclick={() => (unlocked = !unlocked)}
					>
						{unlocked ? '🔓' : '🔒'}
						<span>{unlocked ? 'Release control' : 'Take control'}</span>
					</button>
					<button
						class="zoom"
						title={expanded ? 'Shrink the screen' : 'Fullscreen'}
						onclick={() => (expanded = !expanded)}
					>
						{#if expanded}
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M15 21h4a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4"/></svg>
							<span>Shrink</span>
						{:else}
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M21 15v4a2 2 0 0 1-2 2h-4M3 15v4a2 2 0 0 0 2 2h4"/></svg>
							<span>Fullscreen</span>
						{/if}
					</button>
					{#if unlocked}
						<button
							class="zoom clip"
							title="Send your clipboard to the remote desktop (then Ctrl+V there)"
							aria-label="Paste clipboard to remote"
							onclick={pasteToRemote}
						>
							📋<span>Paste in</span>
						</button>
					{/if}
					<button
						class="zoom clip"
						title="Copy the remote desktop's last copy to your clipboard"
						aria-label="Copy remote clipboard"
						onclick={copyFromRemote}
					>
						📄<span>Copy out</span>
					</button>
				</div>
				{#if clipNote}<span class="clipnote" role="status">{clipNote}</span>{/if}
				{#if unlocked}
					<!-- While the human holds the keyboard the screen wears a ring and
					     a badge, so whose hands are on it is never in doubt. -->
					<span class="driving-badge" aria-hidden="true">YOU'RE DRIVING</span>
				{/if}
				{#if pointer && fitted}
					<!-- Where the bot's pointer actually is. noVNC shows whatever cursor the
					     sandbox sends, which is usually none, so this is drawn here: big and
					     pink so it reads against whatever is on screen. -->
					<span
						class="pointer"
						style:left="{fitted.left + pointer.fx * fitted.w}px"
						style:top="{fitted.top + pointer.fy * fitted.h}px"
					>
						<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
							<path
								d="M4 2 L4 20 L9 15.5 L12.5 22 L15.5 20.5 L12 14.5 L18.5 14 Z"
								fill="#ff2d95"
								stroke="#ffffff"
								stroke-width="1.6"
								stroke-linejoin="round"
							/>
						</svg>
					</span>
				{/if}
			{:else}
				<div class="off">
					{#if status?.hasThumbnail}
						<img
							class="thumb"
							class:dimmed={waking || booting}
							src="/api/bots/{bot.id}/sandbox/thumb?v={thumbVersion}"
							alt="{bot.name}'s last screen"
						/>
						{#if waking || booting}
							{@const stageMatch = desktopStage.match(/stage (\d+)\/(\d+)/)}
							{@const stagePct = stageMatch ? Math.round((Number(stageMatch[1]) / Number(stageMatch[2])) * 100) : 0}
							<div class="booting">
								<span class="scan"></span>
								<span class="bootmsg">Waking {bot.name}'s computer</span>
								<span class="bootbar" class:determinate={stagePct > 0}>
									{#if stagePct > 0}
										<span class="fill" style:width="{stagePct}%"></span>
									{:else}
										<span class="fill"></span>
									{/if}
								</span>
								<span class="bootsub">
									{booting
										? `installing the desktop${desktopStage ? ` · ${desktopStage}` : ''} · ${bootSeconds}s`
										: wakeSeconds < 3
											? 'starting the container…'
											: `booting · ${wakeSeconds}s`}
								</span>
								{#if desktopError}
									<!-- The setup script's own reason for giving up, one line
									     of it: the rest rides in the title rather than being
									     clipped away with nowhere left to look. -->
									<span class="booterr" title={desktopError}>setup failed · {desktopError}</span>
								{/if}
								{#if wakeMessage}
									<span class="booterr" title={wakeMessage}>{wakeMessage}</span>
								{/if}
								{@render wakeButton('Wake')}
							</div>
						{:else}
							<div class="overlay">
								<span class="state">
									{status?.state === 'sleeping' ? 'last seen · asleep' : 'last seen'}
								</span>
								<!-- Nothing is running and the last attempt is why: said here
								     rather than left in a log nobody opens. -->
								{#if desktopError}
									<span class="booterr" title={desktopError}>setup failed · {desktopError}</span>
								{/if}
								{#if wakeMessage}
									<span class="wakeerr" title={wakeMessage}>{wakeMessage}</span>
								{/if}
								{@render wakeButton('Wake')}
							</div>
						{/if}
					{:else}
						<svg
							class="monitor"
							class:on={waking || booting}
							viewBox="0 0 24 24" width="28" height="28" fill="none"
							stroke="currentColor" stroke-width="1.5"
							stroke-linecap="round" stroke-linejoin="round"
						><rect class="mon-screen" x="2" y="4" width="20" height="13" rx="2"/><path class="mon-stand" d="M8 21h8M12 17v4"/></svg>
						<span>{bot.name}'s computer</span>
						{#if waking}
							<span class="state booting-inline">waking · {wakeSeconds}s</span>
							<span class="bootbar wide"><span class="fill"></span></span>
						{:else if booting}
							<span class="state booting-inline">installing the desktop · {bootSeconds}s</span>
							<span class="bootbar wide"><span class="fill"></span></span>
							{#if desktopError}
								<span class="booterr" title={desktopError}>setup failed · {desktopError}</span>
							{/if}
							{#if wakeMessage}
								<span class="booterr" title={wakeMessage}>{wakeMessage}</span>
							{/if}
						{:else}
							<span class="state">
								{wakeMessage
									? wakeMessage
									: status?.state === 'sleeping'
										? 'asleep'
										: status?.state === 'off'
											? 'no sandbox yet'
											: '…'}
							</span>
							{#if desktopError}
								<span class="booterr" title={desktopError}>setup failed · {desktopError}</span>
							{/if}
						{/if}
						{@render wakeButton('Wake sandbox')}
					{/if}
				</div>
			{/if}
			{#if working}
				<span class="atdesk">
					<Avatar color={bot.color} seed={bot.id} size={22} working />
					<span>{deskLine}</span>
				</span>
			{:else if live}
				<span class="caption">live</span>
			{:else}
				<!-- The bot's name, and nothing to click: the badge used to open the
				     bot's card from here, but the card is the profile and the profile
				     is not reached from a corner of the screen. -->
				<span class="caption">{bot.name}{@render frostChip()}</span>
			{/if}
		</div>
		{/if}
		{/if}
		{#if room}
			<!--
				A room is not a computer. The log is the room's own activity, so it
				stays; everything else in this panel has a bot for a subject - a
				screen and a shell to watch, routines to schedule, secrets to keep,
				tokens to count - and a room has none of those to show. Rendering
				them here offered controls that operated on whichever bot was
				picked, from a room that has no such bot.
			-->
			<div class="tabs">
				<span class="tab sel heading">
					Log
					{#if chat.activities.length}
						<span class="count">{chat.activities.length}</span>
					{/if}
				</span>
			</div>
			{#if isLoungeRoom}
				<!-- The Lounge keeps gossip, not a log: one playful line per bot. -->
				<div class="feed">
					{#each loungeFacts as f (f.id)}
						<div class="act">
							<span class="icon">🛋️</span>
							<span class="main">
								<span class="detail"><span style="color: {f.color}; font-weight: 600">{f.name}</span> {f.line}</span>
							</span>
						</div>
					{:else}
						<span class="none">The lounge is quiet — no gossip yet.</span>
					{/each}
				</div>
			{:else}
				{@render activityFeed()}
			{/if}
		{:else}
		<div class="tabs">
			<button class="tab" class:sel={tab === 'routines'} onclick={() => (tab = 'routines')}>
				Routines
			</button>
			<button class="tab" class:sel={tab === 'activity'} onclick={() => (tab = 'activity')}>
				Log
				{#if chat.activities.length}
					<span class="count">{chat.activities.length}</span>
				{/if}
			</button>
			<button class="tab" class:sel={tab === 'secrets'} onclick={() => (tab = 'secrets')}>
				Secrets {secrets.length ? `(${secrets.length})` : ''}
			</button>
			<button class="tab" class:sel={tab === 'usage'} onclick={() => (tab = 'usage')}>
				Usage
			</button>
		</div>
		<!-- What this bot's model calls have cost in the last 24 hours - the same
		     window the usage chart draws. Provider-reported where the provider
		     reports tokens, estimated from characters otherwise. Hovering,
		     focusing or clicking it opens the figures behind the chart.
		     The button and the figures it opens share one hover container, so
		     the pointer can travel from the one into the other: with the leave
		     handler on the button alone, stepping down into the panel it had
		     just opened closed it again and the readout was unreachable. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="usagewrap"
			onpointerenter={() => (meterOpen = true)}
			onpointerleave={() => (meterOpen = false)}
		>
			<button
				class="usage"
				type="button"
				aria-expanded={meterOpen}
				title={meterTitle}
				onclick={() => (meterOpen = true)}
				onfocus={() => (meterOpen = true)}
				onblur={() => (meterOpen = false)}
			>
				{#if usage}
					{shortTokens(usage.totals.in)} in · {shortTokens(usage.totals.out)} out
				{:else}
					…
				{/if}
			</button>
			{#if meterOpen && usage}
				<div class="usagedetail">
					<span class="udrow">
						Last 24 hours · {usage.tasks.length} task{usage.tasks.length === 1 ? '' : 's'}
					</span>
					<span class="udrow">
						{usage.totals.in.toLocaleString()} in · {usage.totals.out.toLocaleString()} out · {(usage.totals.in + usage.totals.out).toLocaleString()} total
					</span>
					{#if cacheMeasured}
						<span class="udrow">
							cache {Math.round((usage.totals.cache_hit_rate ?? 0) * 100)}% · {shortTokens(usage.totals.cache_read)} read · {shortTokens(usage.totals.cache_write)} written
						</span>
					{/if}
					{#if usage.totals.cost !== null}
						<span class="udrow">
							provider's bill: ${usage.totals.cost.toFixed(4)}
						</span>
					{/if}
					{#if usage.totals.estimated_cost !== null}
						<span class="udrow">
							estimated: ${usage.totals.estimated_cost.toFixed(4)} (going rate)
						</span>
					{/if}
					{#each usage.by_model ?? [] as m (m.model)}
						<!-- The same spend split by the model that served it: priced
						     where the provider billed it, estimated where it did not. -->
						<span class="udrow umodel">
							{m.model || 'unrecorded model'} · {m.tasks} task{m.tasks === 1 ? '' : 's'} ·
							{#if m.cost !== null}
								${m.cost.toFixed(4)}{#if m.estimated_cost !== null}
									&nbsp;+ ${m.estimated_cost.toFixed(4)} est.{/if}
							{:else if m.estimated_cost !== null}
								${m.estimated_cost.toFixed(4)} est.
							{:else}
								not priced
							{/if}
						</span>
					{/each}
				</div>
			{/if}
		</div>

		{#if tab === 'routines'}
			<div class="feed routines">
				<span class="lbl">Routines are recurring tasks this bot runs on a schedule.</span>
				{#each chat.routines as r (r.id)}
					<div class="routine" class:editing={editingId === r.id}>
						{#if editingId === r.id}
							<div class="redit">
								<label class="rfield">
									<span class="rlabel">What it does</span>
									<textarea
										rows="3"
										bind:value={editPrompt}
										onkeydown={(e) => {
											if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEditor(r.id);
										}}
									></textarea>
								</label>
								<div class="rfield">
									<span class="rlabel">Schedule — the cron wins when set</span>
									<div class="rrow">
										<input bind:value={editCron} placeholder="0 9 * * 1-5" />
										<span class="ror">or</span>
										<input class="rmin" type="number" min="1" bind:value={editMinutes} />
										<span class="ror">min</span>
									</div>
								</div>
								<label class="ronoff">
									<input type="checkbox" bind:checked={editEnabled} />
									<span>On</span>
								</label>
								{#if editError}
									<div class="rerr">{editError}</div>
								{/if}
								<div class="ractions">
									<button class="rcancel" disabled={editBusy} onclick={closeEditor}>Cancel</button>
									<button class="rsave" disabled={editBusy} onclick={() => saveEditor(r.id)}>
										{editBusy ? 'Saving…' : 'Save'}
									</button>
								</div>
							</div>
						{:else}
							{@const rv = verdictOf(r)}
							<button class="rinfo" title="Edit this routine" onclick={() => openEditor(r)}>
								<span class="rname">{r.name}</span>
								<span class="rmeta">
									{r.cron ? r.cron : `every ${r.interval_min}m`} · next {fmtNext(r.next_run_at)}
								</span>
								{#if rv}
									<span class="rmeta verdict" class:refused={rv.verdict === 'rejected'} class:unverified={rv.verdict === 'unreviewed'}>
										police: {verdictLabel(rv)}{rv.reason ? ` — ${rv.reason}` : ''}{rv.attempts ? ` (attempt ${rv.attempts})` : ''}{rv.by === 'human' ? ' · by you' : ''}
									</span>
								{/if}
							</button>
							{#if rv?.verdict === 'rejected' && rv.awaitingHuman}
								<button
									class="tog"
									title="The bot used up its attempts - sign this off yourself"
									onclick={() => chat.approveRoutine(r.id, true)}
								>
									Approve anyway
								</button>
							{/if}
							<button class="tog" class:on={!!r.enabled} onclick={() => chat.toggleRoutine(r)}>
								{r.enabled ? 'On' : 'Off'}
							</button>
							<button class="del" onclick={() => chat.deleteRoutine(r.id)}>✕</button>
						{/if}
					</div>
				{/each}
				<button class="create" onclick={onCreateRoutine}>Create Routine</button>

				{#if chat.wakes.length || chat.waits.length}
					<span class="lbl">
						Waiting to start a turn. Call one off if the bot set it up for something you have
						since dealt with.
					</span>
					{#each chat.wakes as w (w.id)}
						{@const wv = verdictOf(w)}
						<div class="routine">
							<div class="rinfo">
								<span class="rname">⏰ {w.cron ? w.cron : fmtNext(w.run_at)}</span>
								<span class="rmeta">{w.prompt}</span>
								{#if wv}
									<span class="rmeta verdict" class:refused={wv.verdict === 'rejected'} class:unverified={wv.verdict === 'unreviewed'}>
										police: {verdictLabel(wv)}{wv.reason ? ` — ${wv.reason}` : ''}{wv.attempts ? ` (attempt ${wv.attempts})` : ''}{wv.by === 'human' ? ' · by you' : ''}
									</span>
								{/if}
							</div>
							{#if wv?.verdict === 'rejected' && wv.awaitingHuman}
								<button
									class="tog"
									title="The bot used up its attempts - sign this off yourself"
									onclick={() => chat.approveWake(w.id, true)}
								>
									Approve anyway
								</button>
							{/if}
							<button
								class="del"
								title="Call this wake off"
								onclick={() => chat.cancelPending(w.id)}
							>
								✕
							</button>
						</div>
					{/each}
					{#each chat.waits as w (w.id)}
						<div class="routine">
							<div class="rinfo">
								<span class="rname">👀 waiting</span>
								<span class="rmeta">{w.description}{w.url ? ` · ${w.url}` : ''}</span>
							</div>
							<button
								class="del"
								title="Stop waiting for this"
								onclick={() => chat.cancelPending(w.id)}
							>
								✕
							</button>
						</div>
					{/each}
				{/if}

				{#if chat.botPlugins.length}
					<span class="lbl">
						Plugins this bot can see - its own and the shared ones - with the police's
						verdict on each.
					</span>
					{#each chat.botPlugins as p (p.id)}
						{@const pv = verdictOf(p)}
						<div class="routine">
							<div class="rinfo">
								<span class="rname">🧩 {p.name}</span>
								<span class="rmeta">
									{p.kind}{p.kind === 'hook' && p.hook_point ? ` · ${p.hook_point}` : ''} ·
									{p.author_bot_id === bot?.id ? 'own' : 'shared'}
								</span>
								{#if pv}
									<span class="rmeta verdict" class:refused={pv.verdict === 'rejected'} class:unverified={pv.verdict === 'unreviewed'}>
										police: {verdictLabel(pv)}{pv.reason ? ` — ${pv.reason}` : ''}{pv.attempts ? ` (attempt ${pv.attempts})` : ''}{pv.by === 'human' ? ' · by you' : ''}
									</span>
								{/if}
							</div>
							{#if pv?.verdict === 'rejected' && pv.awaitingHuman}
								<button
									class="tog"
									title="The bot used up its attempts - sign this off yourself"
									onclick={() => chat.approvePlugin(p.id, true)}
								>
									Approve anyway
								</button>
							{/if}
							<button
								class="tog"
								class:on={!!p.effective_enabled}
								onclick={() => bot && chat.toggleBotPlugin(bot.id, p.id, !p.effective_enabled)}
							>
								{p.effective_enabled ? 'On' : 'Off'}
							</button>
						</div>
					{/each}
				{/if}
			</div>
		{:else if tab === 'secrets'}
			<div class="feed">
				{#each secrets as s (s.id)}
					<div class="act secret">
						<span class="kind">🔑</span>
						<span class="detail">{s.name}</span>
						{#if s.shared_with}<span class="shared">shared</span>{/if}
						<button class="bin" title="Forget this secret" onclick={() => forgetSecret(s.name)}>
							✕
						</button>
					</div>
				{:else}
					<span class="none">
						No secrets yet. Bots store them with the store_secret tool.
					</span>
				{/each}
				<!-- A bot can only ask for what it needs or store what it is given,
				     so this sends it the request rather than inventing a secret. -->
				<div class="asksecret">
					<div class="askrow">
						<input
							class="askname"
							bind:value={askName}
							placeholder="secret name"
							aria-label="Name of the secret to ask {bot.name} for"
							onkeydown={(e) => {
								if (e.key === 'Enter') void askForSecret();
							}}
						/>
						<button class="askgo" onclick={askForSecret} disabled={askBusy || !askName.trim()}>
							{askBusy ? 'Asking…' : 'Ask'}
						</button>
					</div>
					<span class="askhint">
						{askNote ||
							`get ${bot.name} to ask me for a secret${askName.trim() ? ` for ${askName.trim()}` : ''}`}
					</span>
				</div>
			</div>
		{:else if tab === 'usage'}
			<div class="feed">
				{#if usage?.tasks.length}
					<span class="uwindow">Last 24 hours</span>
					<!-- Cumulative spend per task, so the lines read as the meter
					     filling up. Drawn by hand: a chart library for three polylines
					     would cost more than the whole panel. -->
					<svg
						class="uchart"
						viewBox="0 0 300 90"
						preserveAspectRatio="none"
						role="slider"
						aria-label="Token spend per task over the last 24 hours"
						aria-valuemin="0"
						aria-valuemax={usage.tasks.length - 1}
						aria-valuenow={usageHover >= 0 ? usageHover : 0}
						aria-valuetext={usageHovered
							? `${new Date(usageHovered.created_at).toLocaleString()}: ${usageHovered.tokens_in.toLocaleString()} in, ${usageHovered.tokens_out.toLocaleString()} out${usageHovered.cost !== null ? `, $${usageHovered.cost.toFixed(4)}` : usageHovered.estimated_cost !== null ? `, $${usageHovered.estimated_cost.toFixed(4)} estimated` : ''}`
							: 'no task selected'}
						tabindex="0"
						onpointermove={onChartMove}
						onpointerleave={() => (usageHover = -1)}
						onkeydown={onChartKey}
						onblur={() => (usageHover = -1)}
					>
						<line class="ugrid" x1="0" y1="86" x2="300" y2="86" />
						{#if usageHovered}
							<!-- The point the readout below names, so the cursor and the
							     figures are visibly the same task. -->
							<line
								class="uguide"
								x1={usageX(usageHover)}
								y1="4"
								x2={usageX(usageHover)}
								y2="86"
							/>
						{/if}
						<polyline class="uline in" points={usagePoints('in')} />
						<polyline class="uline out" points={usagePoints('out')} />
						<polyline class="uline total" points={usagePoints('total')} />
						{#if cacheMeasured}
							<!-- A subset of the input line, dashed so it reads as a measured
							     slice of it rather than a fourth thing being spent. -->
							<polyline class="uline cache" points={usagePoints('cache')} />
						{/if}
					</svg>
					<span class="ulegend">
						<span class="ukey in">in</span>
						<span class="ukey out">out</span>
						<span class="ukey total">total</span>
						{#if cacheMeasured}
							<!-- Unmeasured bots get no key at all: a 0% badge would claim
							     a measurement nobody made. -->
							<span
								class="ukey cache"
								title="{shortTokens(usage.totals.cache_read)} prompt tokens served from cache, {shortTokens(usage.totals.cache_write)} written to it"
								>cache {Math.round((usage.totals.cache_hit_rate ?? 0) * 100)}%</span
							>
						{/if}
						<span class="utotals">
							{shortTokens(usage.totals.in)} in · {shortTokens(usage.totals.out)} out
						</span>
					</span>
					<span class="uhover" aria-live="polite">
						{#if usageHovered}
							{new Date(usageHovered.created_at).toLocaleString()} · {usageHovered.tokens_in.toLocaleString()} in · {usageHovered.tokens_out.toLocaleString()} out · {(usageHovered.tokens_in + usageHovered.tokens_out).toLocaleString()} total{#if usageHovered.cost !== null}
								&nbsp;· ${usageHovered.cost.toFixed(4)}{:else if usageHovered.estimated_cost !== null}
								&nbsp;· ${usageHovered.estimated_cost.toFixed(4)} est.{/if}
						{:else}
							Hover the chart, or focus it and use the arrow keys, for a task's spend.
						{/if}
					</span>
				{:else}
					<span class="none">No tasks yet - nothing spent.</span>
				{/if}
			</div>
		{:else}
			{@render activityFeed()}
		{/if}
		{/if}
	{:else}
		<div class="empty">Select a bot to see its screen</div>
	{/if}

		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- Escape is handled on the window while the lightbox is open. -->
	{#if shotOf}
		<div
			class="viewer"
			role="dialog"
			aria-modal="true"
			aria-label="Screenshot viewer"
			tabindex="-1"
			bind:this={lightboxEl}
			onclick={() => (shotOf = '')}
		>
			<img src="/api/shots/{shotOf}" alt="screenshot" />
		</div>
	{/if}
</section>

<style>
	.panel {
		width: 340px;
		min-width: 340px;
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		background: #0d0d0f;
		/* The feed scrolls, not the panel: with the panel itself scrolling, the
		   feed's flex:1 squeezed the screen down to its borders and the live
		   desktop was there but two pixels tall. */
		overflow: hidden;
	}
	/* A running task said at the panel's top: what it is working on and its
	   age, in one strip the eye cannot miss. */
	.taskbanner {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.8rem 0.8rem 0;
		padding: 0.4rem 0.6rem;
		background: color-mix(in srgb, #4ade80 12%, transparent);
		border: 1px solid color-mix(in srgb, #4ade80 40%, transparent);
		border-radius: 0.55rem;
		font-size: 0.78rem;
	}
	.taskbanner .taskwhat {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}
	.taskbanner .taskage {
		flex: none;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.taskbanner .taskicon {
		flex: none;
		animation: taskbreath 1.4s ease-in-out infinite;
	}
	@keyframes taskbreath {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}
	.screen {
		position: relative;
		margin: 0.8rem;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: #141416;
		aspect-ratio: 16 / 10;
		overflow: hidden;
		/* The screen's size comes from its shape, so flex must not take it back. */
		flex: 0 0 auto;
	}
	.vnc {
		width: 100%;
		height: 100%;
		border: none;
		/* The RFB canvas fills it; overflow hidden keeps a mid-resize frame from
		   spilling while the remote desktop catches up to the new size. */
		overflow: hidden;
	}
	.vnc :global(canvas) {
		display: block;
	}
	.screentools {
		position: absolute;
		top: 0.45rem;
		right: 0.45rem;
		z-index: 5;
		display: flex;
		gap: 0.3rem;
	}
	.lockscreen,
	.zoom {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		font-size: 0.85rem;
		line-height: 1;
		padding: 0.3rem 0.45rem;
		cursor: pointer;
	}
	/* The expand control reads as a button, not a glyph: a word next to the
	   icon and a bigger pad so it is easy to hit over the live screen. */
	.zoom {
		gap: 0.35rem;
		padding: 0.4rem 0.65rem;
		font-size: 0.72rem;
	}
	/* The lock button reads as a button: a word next to the glyph, like the
	   expand control, so taking over is an act you can see. */
	.lockscreen {
		gap: 0.35rem;
		padding: 0.4rem 0.65rem;
		font-size: 0.72rem;
	}
	.lockscreen:hover,
	.zoom:hover {
		background: rgba(0, 0, 0, 0.85);
	}
	.lockscreen.open {
		border-color: rgba(120, 220, 160, 0.6);
	}
	/* While the bot drives, the take-over control breathes a soft green glow so
	   it reads as an available action rather than another toolbar button. Once
	   the human holds the screen the ring and badge carry that story instead. */
	.lockscreen:not(.open) {
		animation: beckon 2.4s ease-in-out infinite;
	}
	@keyframes beckon {
		0%,
		100% {
			border-color: rgba(120, 220, 160, 0.4);
			box-shadow: 0 0 6px rgba(120, 220, 160, 0.15);
		}
		50% {
			border-color: rgba(120, 220, 160, 0.9);
			box-shadow:
				0 0 18px rgba(120, 220, 160, 0.5),
				0 0 36px rgba(120, 220, 160, 0.2);
		}
	}
	/* While the human drives, the screen wears the ring and the badge. */
	.screen.driving {
		border-color: rgba(120, 220, 160, 0.75);
		box-shadow:
			0 0 0 2px rgba(120, 220, 160, 0.35),
			0 0 24px rgba(120, 220, 160, 0.18);
	}
	/* The clipboard buttons share the zoom control's look; the note reads as a
	   quiet status line, not an alert. */
	.clipnote {
		position: absolute;
		bottom: 2rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 5;
		background: rgba(0, 0, 0, 0.7);
		color: var(--text);
		font-size: 0.7rem;
		padding: 0.2rem 0.55rem;
		border-radius: 0.4rem;
		pointer-events: none;
	}
	.driving-badge {
		position: absolute;
		top: 0.45rem;
		left: 0.45rem;
		z-index: 5;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		background: rgba(20, 60, 38, 0.85);
		border: 1px solid rgba(120, 220, 160, 0.6);
		color: #9fe8bd;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.1em;
	}
	/*
	 * Expanded: a big viewer over the app, not the browser's fullscreen. Sized to
	 * fit the window while keeping the viewer's shape; the dim is a real element
	 * behind it so clicks outside the screen have somewhere to land.
	 */
	.screenbackdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.62);
		z-index: 69;
		cursor: zoom-out;
	}
	.screen.expanded {
		--w: min(1180px, 94vw, calc(90vh * 1.6));
		position: fixed;
		inset: 0;
		margin: auto;
		width: var(--w);
		height: calc(var(--w) / 1.6);
		z-index: 70;
		border-color: #3d3d44;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
	}
	.thumb {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		filter: saturate(0.85);
	}
	/* ---- the bot's pointer ---- */
	/* Sits over the viewer, never in front of the mouse: clicks and drags go
	   through to noVNC underneath. */
	.pointer {
		position: absolute;
		z-index: 4;
		pointer-events: none;
		/* the drawn arrow's tip is at its top-left, so the hot spot lines up */
		transform: translate(-3px, -2px);
		filter: drop-shadow(0 0 3px rgba(255, 45, 149, 0.85));
	}

	/* ---- waking ---- */
	/* The last-seen frame stays visible underneath, dimmed, so the moment the
	   live view takes over reads as the same screen coming back rather than as
	   one image being swapped for another. */
	.thumb.dimmed {
		filter: brightness(0.45) saturate(0.7);
		transition: filter 0.4s ease;
	}
	.booting {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.55rem;
		/* Darkest behind the words and lighter at the edges, so the message reads
		   over whatever the last frame happened to be - usually a light page. */
		background: radial-gradient(
			ellipse at center,
			rgba(6, 8, 12, 0.86) 0%,
			rgba(6, 8, 12, 0.72) 55%,
			rgba(6, 8, 12, 0.45) 100%
		);
	}
	/* A line sweeping down the screen, the way a CRT settles. */
	.booting .scan {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}
	.booting .scan::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		height: 30%;
		background: linear-gradient(transparent, rgba(126, 224, 168, 0.16), transparent);
		animation: sweep 1.8s ease-in-out infinite;
	}
	@keyframes sweep {
		0% {
			top: -35%;
		}
		100% {
			top: 105%;
		}
	}
	.bootmsg {
		position: relative;
		font-size: 0.8rem;
		font-weight: 500;
		color: #ffffff;
		text-shadow:
			0 1px 2px rgba(0, 0, 0, 1),
			0 0 8px rgba(0, 0, 0, 0.9);
		animation: pulse 1.6s ease-in-out infinite;
	}
	.bootmsg::after {
		content: '';
		animation: dots 1.4s steps(4, end) infinite;
	}
	@keyframes dots {
		0% {
			content: '';
		}
		25% {
			content: '.';
		}
		50% {
			content: '..';
		}
		75% {
			content: '...';
		}
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}
	.bootbar {
		position: relative;
		width: 10rem;
		height: 0.3rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.22);
		overflow: hidden;
	}
	.bootbar.wide {
		margin-top: 0.3rem;
	}
	.bootbar .fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: 40%;
		border-radius: 999px;
		background: linear-gradient(90deg, #7ee0a8, #b8f5d0);
		animation: slide 1.35s ease-in-out infinite;
	}
	/* A determinate fill: the stage number the script last echoed, as a real
	   fraction rather than the indeterminate sweep. The sweep still runs for
	   the container-start phase where no stage has been echoed yet. */
	.bootbar.determinate .fill {
		animation: none;
		transition: width 0.4s ease;
	}
	@keyframes slide {
		0% {
			left: -40%;
		}
		100% {
			left: 100%;
		}
	}
	.bootsub {
		position: relative;
		font-size: 0.7rem;
		color: rgba(255, 255, 255, 0.82);
		text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
		font-variant-numeric: tabular-nums;
	}
	/* Why a desktop setup run died: one line of it, clipped, with the whole text
	   in the title. Muted like the stage line above it, because it is the same
	   kind of message - it is just the one that says something is wrong. */
	.booterr {
		position: relative;
		max-width: min(30rem, 92%);
		font-size: 0.7rem;
		opacity: 0.75;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* Over the dimmed last frame, the same white the rest of the block uses. */
	.booting .booterr {
		color: rgba(255, 255, 255, 0.82);
		text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
		opacity: 1;
	}
	/* Under the corner label of the last-seen overlay, clear of the Wake button
	   in the middle. */
	.overlay .booterr {
		position: absolute;
		top: 1.35rem;
		left: 0.5rem;
		right: 0.5rem;
		color: rgba(255, 255, 255, 0.75);
		text-align: left;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
		opacity: 1;
	}
	/* Why the last wake failed, on its own line under the setup error: the two
	   are different problems - one is the desktop's, one is the wake's - so
	   neither is allowed to overwrite the other. */
	.overlay .wakeerr {
		position: absolute;
		top: 2.6rem;
		left: 0.5rem;
		right: 0.5rem;
		font-size: 0.7rem;
		color: rgba(255, 255, 255, 0.92);
		text-align: left;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
	}

	/* Covers the whole thumbnail so the Wake button sits in its centre; the
	   label retreats to a corner where it no longer fights the button for
	   the same line. */
	.overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: radial-gradient(
			ellipse at center,
			rgba(6, 8, 12, 0.55) 0%,
			rgba(6, 8, 12, 0.3) 60%,
			rgba(6, 8, 12, 0.15) 100%
		);
	}
	.overlay .state {
		position: absolute;
		top: 0.35rem;
		left: 0.5rem;
		font-size: 0.66rem;
		color: rgba(255, 255, 255, 0.75);
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
	}
	.overlay .wake {
		margin: 0;
		padding: 0.3rem 0.9rem;
		font-size: 0.78rem;
	}
	.atdesk {
		position: absolute;
		bottom: 0.4rem;
		right: 0.6rem;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.7rem;
		color: var(--text);
		background: rgba(0, 0, 0, 0.62);
		padding: 0.12rem 0.5rem 0.12rem 0.2rem;
		border-radius: 999px;
	}
	.off {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		height: 100%;
		color: var(--text-muted);
		font-size: 0.85rem;
	}
	/* The little monitor wakes up when you hover: stand bounces, screen flickers. */
	.monitor .mon-stand {
		transform-box: fill-box;
		transform-origin: 50% 0%;
	}
	.off:hover .monitor .mon-stand {
		animation: stand-bounce 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.off:hover .monitor .mon-screen {
		animation: screen-flicker 0.45s ease-out;
	}
	.monitor.on {
		filter: drop-shadow(0 0 4px currentColor);
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
	.state {
		font-size: 0.72rem;
		opacity: 0.7;
	}
	.wake {
		margin-top: 0.3rem;
		padding: 0.4rem 1rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		font-size: 0.82rem;
		cursor: pointer;
	}
	.wake:hover {
		background: var(--bg-hover);
	}
	.caption {
		position: absolute;
		bottom: 0.4rem;
		right: 0.6rem;
		font-size: 0.7rem;
		color: var(--text-muted);
		background: rgba(0, 0, 0, 0.5);
		padding: 0.1rem 0.4rem;
		border-radius: 0.3rem;
	}
	.groupnote {
		margin: 0.8rem;
		padding: 0.9rem;
		border: 1px dashed var(--border);
		border-radius: 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.gname {
		font-size: 0.95rem;
		font-weight: 600;
	}
	/* The rate-limit frost: a quiet chip by the bot's name, no tint over the panel. */
	.frost {
		font-size: 0.66rem;
		font-weight: 400;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
		margin-left: 0.35rem;
		vertical-align: middle;
		cursor: help;
	}
	.gsub {
		font-size: 0.76rem;
		color: var(--text);
	}
	.tabs {
		display: flex;
		gap: 0.3rem;
		padding: 0 0.8rem;
	}
	/* The Desktop/shell box switch sits where the screen's top margin used to start. */
	.machines {
		padding-top: 0.8rem;
	}
	.tab {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		background: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
		font-size: 0.76rem;
		padding: 0.3rem 0.5rem;
		cursor: pointer;
	}
	.tab:hover {
		color: var(--text);
	}
	.tab.sel {
		color: var(--text);
		background: rgba(80, 140, 255, 0.12);
		border-color: var(--accent);
	}
	/* The lightswitch: one pill that flips between the bot's screen and its
	   terminal, the thumb sliding to the live side. */
	.viewswitch {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.25rem 0.5rem;
		cursor: pointer;
		position: relative;
	}
	.vslabel {
		font-size: 0.74rem;
		color: var(--text-muted);
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		transition: color 0.15s;
		z-index: 1;
	}
	.vslabel.on {
		color: var(--text);
	}
	.vsthumb {
		position: absolute;
		top: 3px;
		bottom: 3px;
		left: 3px;
		width: calc(50% - 3px);
		border-radius: 999px;
		background: rgba(80, 140, 255, 0.2);
		border: 1px solid var(--accent);
		transition: transform 0.18s ease;
	}
	.viewswitch.shell .vsthumb {
		transform: translateX(100%);
	}
	/* A room's log heading: the same pill, but nothing to click, so no pointer. */
	.tab.heading {
		cursor: default;
	}
	.count {
		background: var(--bg-hover);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
		font-size: 0.66rem;
		line-height: 1;
		padding: 0.12rem 0.4rem;
	}
	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.when {
		font-size: 0.68rem;
		/* The log is reference material; its timestamps still have to be readable. */
		color: #9a9aa5;
	}
	.act .icon {
		flex: none;
		width: 1.4rem;
		text-align: center;
		font-size: 0.85rem;
		line-height: 1.35;
		opacity: 0.75;
	}
	.act.secret {
		align-items: center;
	}
	.act.secret .detail {
		flex: 1;
	}
	.asksecret {
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.askrow {
		display: flex;
		gap: 0.35rem;
	}
	.askname {
		flex: 1;
		min-width: 0;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.45rem;
		color: var(--text);
		font-size: 0.75rem;
		padding: 0.3rem 0.45rem;
	}
	.askgo {
		flex: none;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.45rem;
		color: var(--text);
		font-size: 0.75rem;
		padding: 0.3rem 0.7rem;
		cursor: pointer;
	}
	.askgo:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.askgo:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.askhint {
		font-size: 0.68rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.shared {
		font-size: 0.66rem;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0 0.4rem;
	}
	.bin {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.72rem;
	}
	.bin:hover {
		color: var(--danger);
		animation: x-shake 0.3s ease-in-out;
	}
	.shotbtn {
		background: none;
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		padding: 0;
		width: 2.6rem;
		height: 1.7rem;
		overflow: hidden;
		cursor: pointer;
		flex: none;
		transition: transform 0.15s ease-out;
	}
	.shotbtn:hover {
		transform: scale(1.06);
	}
	.shotbtn img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.viewer {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.8);
		display: grid;
		place-items: center;
		z-index: 80;
		cursor: zoom-out;
	}
	.viewer img {
		max-width: 92vw;
		max-height: 92vh;
		border-radius: 0.6rem;
		border: 1px solid var(--border);
	}
	.lbl {
		font-size: 0.75rem;
		color: var(--text);
		text-align: center;
	}
	.routines {
		gap: 0.5rem;
	}
	.routine {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
	}
	.rinfo {
		flex: 1;
		min-width: 0;
		/* The row itself is the button that opens the edit form. */
		background: none;
		border: none;
		padding: 0;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.rinfo:hover .rname {
		color: var(--accent);
	}
	.rname {
		display: block;
		font-size: 0.82rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.rmeta {
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	/* The police's word on a schedule: red for a refusal, amber for a review
	   that never ran, the muted meta ink for a pass. */
	.rmeta.verdict {
		display: block;
	}
	.rmeta.verdict.refused {
		color: #ff8a8a;
	}
	.rmeta.verdict.unverified {
		color: #e0b060;
	}
	/* The routine editor opens inside its own row, so its fields are sized for
	   the narrow panel rather than for a dialog. */
	.routine.editing {
		align-items: stretch;
	}
	.redit {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.rfield {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}
	.rlabel {
		font-size: 0.68rem;
		color: var(--text-muted);
	}
	.redit input,
	.redit textarea {
		width: 100%;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.45rem;
		padding: 0.35rem 0.5rem;
		color: var(--text);
		font-family: inherit;
		font-size: 0.78rem;
	}
	.redit textarea {
		resize: vertical;
		line-height: 1.4;
	}
	.redit input:focus,
	.redit textarea:focus {
		outline: none;
		border-color: #3d3d44;
	}
	.redit input:focus-visible,
	.redit textarea:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.rrow {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.rrow .rmin {
		flex: none;
		width: 4.5rem;
	}
	.ror {
		flex: none;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.ronoff {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.75rem;
	}
	.ronoff input {
		width: auto;
		margin: 0;
	}
	.rerr {
		font-size: 0.75rem;
		color: var(--danger);
	}
	.ractions {
		display: flex;
		justify-content: flex-end;
		gap: 0.4rem;
	}
	.rcancel,
	.rsave {
		border-radius: 0.45rem;
		padding: 0.35rem 0.8rem;
		font-size: 0.78rem;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.rcancel {
		background: none;
		color: var(--text-muted);
	}
	.rcancel:hover {
		color: var(--text);
	}
	.rsave {
		background: var(--accent);
		color: #fff;
	}
	.rcancel:disabled,
	.rsave:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.tog {
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: none;
		color: var(--text-muted);
		font-size: 0.72rem;
		cursor: pointer;
	}
	.tog.on {
		color: #3fbf6f;
		border-color: #2c5a3d;
	}
	.del {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.75rem;
	}
	.del:hover {
		color: var(--danger);
		animation: x-shake 0.3s ease-in-out;
	}
	@keyframes x-shake {
		0%,
		100% {
			transform: translateX(0);
		}
		33% {
			transform: translateX(-1.5px);
		}
		66% {
			transform: translateX(1.5px);
		}
	}
	.create {
		align-self: center;
		margin-top: 0.3rem;
		padding: 0.45rem 1.2rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		color: var(--text);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.create:hover {
		background: var(--bg-hover);
	}
	.feed {
		flex: 1;
		/* min-height:0 lets a flex child actually shrink and scroll instead of
		   growing past the panel and pushing a scrollbar onto the whole column. */
		min-height: 0;
		overflow-y: auto;
		padding: 0.4rem 0.8rem 1.4rem;
		display: flex;
		flex-direction: column;
	}
	.act {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-size: 0.78rem;
		padding: 0.55rem 0;
	}
	.act + .act {
		border-top: 1px solid var(--border);
	}
	.kind {
		color: #6ea8fe;
		flex-shrink: 0;
	}
	.detail {
		color: var(--text);
		line-height: 1.35;
		overflow-wrap: break-word;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.none,
	.empty {
		color: var(--text-muted);
		font-size: 0.8rem;
		text-align: center;
		padding: 1rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.lockscreen:not(.open),
		.off:hover .monitor .mon-stand,
		.off:hover .monitor .mon-screen,
		.bin:hover,
		.del:hover {
			animation: none;
		}
		.taskbanner .taskicon {
			animation: none;
		}
		.shotbtn {
			transition: none;
		}
		.shotbtn:hover {
			transform: none;
		}
	}
	.usagewrap {
		/* The meter and the figures it opens are one hover target (see the
		   markup); relative so the panel can overlay the feed rather than
		   pushing it down. Opening in flow shifted everything below by the
		   panel's own height, so hovering near the meter's edge flickered. */
		position: relative;
	}
	.usage {
		/* The bot's meter, under its tabs. Its own line so the three tab buttons
		   keep their width, and tabular figures so a growing total does not
		   shuffle the line sideways with every turn. A button so the figures
		   behind the chart are reachable without a mouse. */
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 0 0.8rem;
		font: inherit;
		font-size: 0.7rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}
	.usage:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.usagedetail {
		/* The figures behind the chart, opened by hovering or focusing the meter
		   rather than hidden behind a click. Floated over the feed: laid out in
		   flow it moved the content under the pointer that opened it. */
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.3rem 0.8rem 0.45rem;
		font-size: 0.68rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
	}
	.udrow {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* A per-model line indents under the totals it breaks down. */
	.umodel {
		padding-left: 0.7rem;
	}

	/* ---- the police console ---- */
	.console {
		margin: 0.8rem;
		padding: 0.6rem;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: #141416;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		flex: 0 0 auto;
	}
	.crow {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}
	.cname {
		flex: 1;
		min-width: 0;
		font-size: 0.8rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cacts {
		display: flex;
		gap: 0.25rem;
		flex: none;
	}
	.cbtn {
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
		font-size: 0.66rem;
		line-height: 1;
		padding: 0.22rem 0.5rem;
		cursor: pointer;
	}
	.cbtn:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.cbtn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* ---- the log feed's compaction ---- */
	.earlier {
		font-size: 0.7rem;
		color: var(--text-muted);
		text-align: center;
		padding: 0.3rem 0 0.5rem;
	}
	.times {
		color: var(--text-muted);
		font-size: 0.7rem;
		margin-left: 0.3rem;
	}

	/* ---- the usage chart ---- */
	.uchart {
		width: 100%;
		height: 90px;
		display: block;
	}
	.ugrid {
		stroke: var(--border);
		stroke-width: 1;
	}
	.uline {
		fill: none;
		stroke-width: 1.5;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.uline.in {
		stroke: #6ea8fe;
	}
	.uline.out {
		stroke: #7ee0a8;
	}
	.uline.total {
		stroke: #e0a83c;
	}
	/* Dashed: cache reads are a slice of the input line, not another spend. */
	.uline.cache {
		stroke: #c08cff;
		stroke-dasharray: 3 2;
	}
	.ulegend {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		font-size: 0.68rem;
		color: var(--text-muted);
		padding: 0.15rem 0 0.3rem;
	}
	.ukey::before {
		content: '';
		display: inline-block;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: currentColor;
		margin-right: 0.25rem;
		vertical-align: -0.05rem;
	}
	.ukey.in {
		color: #6ea8fe;
	}
	.ukey.out {
		color: #7ee0a8;
	}
	.ukey.total {
		color: #e0a83c;
	}
	.ukey.cache {
		color: #c08cff;
	}
	.utotals {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	.uwindow {
		display: block;
		font-size: 0.68rem;
		color: var(--text-muted);
		padding: 0.2rem 0 0;
	}
	.uchart:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.uguide {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 2 2;
		opacity: 0.7;
	}
	.uhover {
		display: block;
		font-size: 0.68rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		padding: 0.15rem 0 0.3rem;
	}
</style>
