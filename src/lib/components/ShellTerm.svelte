<script lang="ts" module>
	import { init } from 'ghostty-web';
	// The WASM module loads once for every terminal the panel ever mounts.
	const ghosttyReady = init();
</script>

<script lang="ts">
	import { Terminal, FitAddon } from 'ghostty-web';
	import type { Bot } from '$lib/types';

	let { bot }: { bot: Bot } = $props();

	type ShellState = 'running' | 'booting' | 'sleeping' | 'none';

	let kstate = $state<ShellState | null>(null);
	/** The terminal blown up over the app, like the screen panel's expand. */
	let expanded = $state(false);
	let hostEl = $state<HTMLElement | null>(null);

	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	/**
	 * The last payload painted, so unchanged polls don't flash the screen.
	 * Cleared with the terminal it belongs to: a pane must never show the
	 * machine of the bot that was open before it.
	 */
	let lastScreen = '';
	/** What is actually on the terminal; lastScreen is the newer capture. */
	let paintedScreen = '';
	/** Keystrokes in flight - the poll runs hot while the pane is changing. */
	let typing = false;
	/**
	 * The grid the pane was last sized to, and whether a resize is still
	 * settling. A keystroke that lands while tmux is reflowing to a new width
	 * hits a cursor that is about to move - the corruption on expand+type -
	 * so input waits for the first capture at the new size before it flows.
	 */
	let sentCols = 0;
	let sentRows = 0;
	let resizing = false;
	/**
	 * The grid the painted capture was laid out on. ghostty refits its own
	 * grid the moment the box changes shape, but the pane answers at its old
	 * size until the next poll - and when that capture comes back
	 * byte-identical (nothing wrapped) it must still be repainted, or the
	 * widget keeps whatever its own refit left on the glass.
	 */
	let paintedCols = 0;
	let paintedRows = 0;
	/** The input queue's flush, assigned once the terminal exists. */
	let flushQueued: (() => void) | null = null;
	/**
	 * Paste enters the same queue keystrokes use, but flushes at once - a
	 * paste is one ordered chunk, not a run of single keys. Assigned with the
	 * terminal, like flushQueued.
	 */
	let injectInput: ((data: string) => void) | null = null;
	/** Selection presence, mirrored from the terminal so copy can disable. */
	let hasSel = $state(false);
	/** Transient chrome note ("copied", clipboard errors); auto-hides. */
	let note = $state('');
	let noteTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const el = hostEl;
		if (!el) return;
		let dead = false;
		void ghosttyReady.then(() => {
			if (dead) return;
			term = new Terminal({
				fontSize: 13,
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
				convertEol: true,
				// Keystrokes go to the machine's tmux pane through the shellbox
				// route; the pane is shared with the bot, so what the user types
				// lands in the same shell the bot watches.
				cursorBlink: false,
				scrollback: 2000,
				theme: { background: '#101014', foreground: '#d4d4d8' }
			});
			fit = new FitAddon();
			term.loadAddon(fit);
			term.open(el);
			// open() focuses the hidden textarea, which would steal the composer;
			// it stays blurred until the user clicks into the pane (below).
			term.blur();
			fit.fit();
			fit.observeResize();
			if (lastScreen) paint(lastScreen);
			// Each keystroke is one small POST; the pane answers on the next
			// poll rather than echoing locally, so what you see is always what
			// the machine actually has. Only one request is in flight at a
			// time and the rest queue up in typed order: fired concurrently,
			// fast typing reached the pane out of order (and scrambled, via
			// tmux's shared paste buffer), which no amount of care in the
			// pane could undo. A failed request drops its keystroke - the pane
			// is the only place the text lives - and the queue keeps moving.
			let queued = '';
			let sending = false;
			let holdTimer: ReturnType<typeof setTimeout> | null = null;
			/**
			 * The pane's last line reads like a shell prompt when it ends in a
			 * prompt sigil. At a prompt, single characters are batched for a
			 * blink (~60ms) so fast typing arrives as one ordered paste instead
			 * of a queue of one-byte requests - and so a resize that is still
			 * settling never has keystrokes threaded through it. Enter and
			 * control bytes flush at once: they end the line or move the cursor,
			 * and holding them would feel broken.
			 */
			const atPrompt = () => {
				const tail = lastScreen.replace(/\s+$/, '').split('\n').pop() ?? '';
				return /[$#%>»❯]\s*$/.test(tail) || tail === '';
			};
			const flushTyped = () => {
				if (holdTimer) {
					clearTimeout(holdTimer);
					holdTimer = null;
				}
				if (sending || !queued || resizing) return;
				const data = queued;
				queued = '';
				sending = true;
				const ac = new AbortController();
				// A hung endpoint must not wedge the queue for the rest of the
				// session; the abort is what makes the next keystroke able to
				// be sent at all.
				const killer = setTimeout(() => ac.abort(), 5000);
				void fetch(`/api/bots/${bot.id}/shellbox`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ action: 'type', data }),
					signal: ac.signal
				})
					.then((r) => (r.ok ? r.json() : null))
					.then((d) => {
						// The keystroke's answer carries the pane back: paint it now
						// rather than waiting for the next poll, which is what made
						// typing feel a beat behind.
						if (d?.screen && d.screen !== lastScreen) {
							lastScreen = d.screen;
							paint(d.screen);
						}
					})
					.catch(() => {})
					.finally(() => {
						clearTimeout(killer);
						sending = false;
						typing = !!queued;
						flushTyped();
					});
			};
			term.onData((data) => {
				typing = true;
				queued += data;
				// A single printable character at a prompt can wait a blink for
				// its neighbours; anything else - Enter, arrows, escapes, a paste
				// - goes now.
				if (data.length === 1 && data >= ' ' && data < '\x7f' && atPrompt()) {
					if (!holdTimer) holdTimer = setTimeout(flushTyped, 60);
					return;
				}
				flushTyped();
			});
			flushQueued = flushTyped;
			// Paste rides the same queue as keystrokes (so it lands in typed
			// order and behind the resize gate) but flushes immediately: a
			// paste is one ordered chunk, never held for a single-key blink.
			injectInput = (data) => {
				if (!data) return;
				typing = true;
				queued += data;
				flushTyped();
			};
			// The pane is a canvas, so the browser has no selection to read;
			// ghostty's buffer is the source of truth for the copy button.
			term.onSelectionChange(() => {
				hasSel = term?.hasSelection() ?? false;
			});
		});
		return () => {
			dead = true;
			term?.dispose();
			term = null;
			fit = null;
			flushQueued = null;
			injectInput = null;
			hasSel = false;
			// A fresh terminal has nothing on it; the next paint must not diff
			// against the old bot's screen, nor pre-paint it on mount.
			paintedScreen = '';
			lastScreen = '';
		};
	});

	/**
	 * Repaint the pane. The common case - new lines appended at the bottom -
	 * is detected and only the delta is written, which keeps the buffer and
	 * lets the terminal's own pin-to-bottom decide whether to follow. A grid
	 * change or an in-place redraw (a full-screen app repainting) falls back
	 * to clear+write, restoring the user's scroll offset.
	 */
	function paint(screen: string) {
		if (!term) return;
		// paintedScreen, not lastScreen: lastScreen is already the new capture
		// by the time paint runs, so the append check needs what is actually
		// on the terminal.
		const prev = paintedScreen;
		paintedScreen = screen;
		// A grid change forces a full repaint even when the capture is
		// unchanged: the bytes are the same, the cells they sit in are not.
		const refit = term.cols !== paintedCols || term.rows !== paintedRows;
		if (!refit && prev && screen.startsWith(prev)) {
			if (screen.length > prev.length) term.write(screen.slice(prev.length));
			return;
		}
		// viewportY is lines scrolled up from the bottom; 0 means pinned to
		// live output. Only a user already at the bottom follows new output -
		// anyone reading scrollback stays where they were.
		const atBottom = term.viewportY === 0;
		const y = term.viewportY;
		// reset() in ghostty-web 0.4.0 frees the WASM terminal and builds a
		// new one while the renderer keeps the old render state, so everything
		// painted after it comes back as garbage. Clear through the parser
		// instead: it wipes every cell of the live grid, honours the widget's
		// own scrollback, and never swaps the memory out from under the
		// renderer.
		term.write('\x1b[2J\x1b[H');
		term.write(screen);
		paintedCols = term.cols;
		paintedRows = term.rows;
		if (!atBottom && y > 0) term.scrollToLine(y);
	}

	/*
	 * Opening the terminal is intent enough to have a machine, so it is woken
	 * - a POST, since GET is read-only and never boots anything. The wake
	 * returns as soon as the boot is safely in flight; the pane fills in over
	 * the next polls rather than holding one request for the whole container
	 * boot. A poll that finds the machine down re-fires it (throttled), so a
	 * failed first wake or a mid-view sleep is not a dead end.
	 */
	let lastWake = 0;
	function wakeMachine(id: string) {
		if (Date.now() - lastWake < 30_000) return;
		lastWake = Date.now();
		void fetch(`/api/bots/${id}/shellbox`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'wake' })
		}).catch(() => {});
	}

	/*
	 * Poll the pane while this view is open. The next read is scheduled only
	 * after the current one settles, and each fetch carries its own timeout,
	 * so a hung endpoint can never stack requests up.
	 */
	$effect(() => {
		const id = bot.id;
		wakeMachine(id);
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async () => {
			if (document.hidden) {
				timer = setTimeout(tick, 2000);
				return;
			}
			const ac = new AbortController();
			const killer = setTimeout(() => ac.abort(), 5000);
			try {
				const cols = term?.cols ?? 80;
				const rows = term?.rows ?? 24;
				// A grid change means the pane is about to be resized and repainted;
				// input holds until the first capture at the new size lands, so a
				// keystroke can never be pasted into a pane mid-reflow.
				if (cols !== sentCols || rows !== sentRows) {
					resizing = true;
					sentCols = cols;
					sentRows = rows;
				}
				const res = await fetch(
					`/api/bots/${id}/shellbox?cols=${cols}&rows=${rows}`,
					{ signal: ac.signal }
				);
				if (res.ok && !cancelled) {
					const data = await res.json();
					// A running machine whose pane is not capturable yet is still
					// booting (tmux install, session start); say so rather than
					// showing a blank terminal that reads as broken.
					kstate =
						data.state === 'running' && typeof data.screen === 'string' && !data.screen
							? 'booting'
							: data.state;
					// A changed capture paints; an unchanged one paints too when
					// the grid has moved on since it was laid out (the refit
					// check inside paint decides) - identical bytes at a new
					// size still need new cells.
					if (typeof data.screen === 'string') {
						const refit =
							term !== null && (term.cols !== paintedCols || term.rows !== paintedRows);
						if (refit || data.screen !== lastScreen) {
							lastScreen = data.screen;
							paint(data.screen);
						}
					}
					// The pane has answered at the new size; input flows again.
					if (resizing) {
						resizing = false;
						flushQueued?.();
					}
				}
			} catch {
				// A blip leaves the last frame up rather than blanking it.
				// A failed read never resized the pane; release the gate so input
				// is not held forever waiting for a capture that did not happen.
				resizing = false;
			} finally {
				clearTimeout(killer);
				// While keystrokes are in flight the pane is changing under the
				// poll, so it runs hot; the rest of the time it idles at 2s.
				if (!cancelled) timer = setTimeout(tick, typing ? 400 : 2000);
			}
		};
		void tick();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	});
	// The expanded terminal covers the app, so Esc is the way out.
	$effect(() => {
		if (!expanded) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') expanded = false;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	/*
	 * Copy/paste. The pane is a canvas, so the browser's own copy has nothing
	 * to read - the selection lives in ghostty's buffer and is copied from
	 * there. Paste goes back through the queue keystrokes use, so it lands in
	 * the pane in order and behind the resize gate.
	 */
	function flash(msg: string) {
		note = msg;
		if (noteTimer) clearTimeout(noteTimer);
		noteTimer = setTimeout(() => (note = ''), 1500);
	}
	async function copySelection() {
		const text = term?.getSelection() ?? '';
		if (!text) {
			flash('nothing to copy');
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			flash('copied');
		} catch {
			// A denied/absent clipboard must never surface as an unhandled
			// rejection; the chrome says what happened instead.
			flash('copy blocked');
		}
	}
	async function pasteClipboard() {
		if (!navigator.clipboard?.readText) {
			flash('clipboard unavailable');
			return;
		}
		try {
			const text = await navigator.clipboard.readText();
			if (!text) {
				flash('clipboard empty');
				return;
			}
			injectInput?.(text);
		} catch {
			flash('paste blocked');
		}
	}
	/*
	 * Shortcuts and the native paste event, captured on the host so they run
	 * before ghostty's own handlers (which would otherwise encode Ctrl+Shift+C
	 * as a control byte, or route a paste through bracketed-paste wrapping).
	 * Ctrl+Shift+C / Cmd+C copy; Ctrl+Shift+V / Cmd+V paste. Plain Ctrl+C is
	 * left alone - it is SIGINT to the pane.
	 */
	$effect(() => {
		const el = hostEl;
		if (!el) return;
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || (e.ctrlKey && e.shiftKey))) return;
			const k = e.key.toLowerCase();
			if (k === 'c') {
				e.preventDefault();
				e.stopPropagation();
				void copySelection();
			} else if (k === 'v') {
				e.preventDefault();
				e.stopPropagation();
				void pasteClipboard();
			}
		};
		const onPaste = (e: ClipboardEvent) => {
			// The event carries the clipboard, so this path needs no permission
			// prompt - prefer it over readText whenever it fires.
			const text = e.clipboardData?.getData('text/plain') ?? '';
			if (!text) return;
			e.preventDefault();
			e.stopPropagation();
			injectInput?.(text);
		};
		el.addEventListener('keydown', onKey, { capture: true });
		el.addEventListener('paste', onPaste, { capture: true });
		return () => {
			el.removeEventListener('keydown', onKey, { capture: true });
			el.removeEventListener('paste', onPaste, { capture: true });
		};
	});
</script>

<div class="term" class:expanded>
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="termhost" bind:this={hostEl} onclick={() => term?.focus()}></div>
	<div class="termtools">
		{#if note}
			<span class="chip note">{note}</span>
		{/if}
		<span class="chip" class:live={kstate === 'running'}>
			{kstate === 'running' ? 'running' : kstate === 'booting' ? 'starting' : kstate === 'sleeping' ? 'asleep' : kstate === 'none' ? 'none' : '…'}
		</span>
		<button
			class="tool"
			title="Copy selection"
			aria-label="Copy selection"
			disabled={!hasSel}
			onclick={() => void copySelection()}
		>
			<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
		</button>
		<button
			class="tool"
			title="Paste from clipboard"
			aria-label="Paste from clipboard"
			onclick={() => void pasteClipboard()}
		>
			<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>
		</button>
		<button
			class="tool"
			title={expanded ? 'Shrink the terminal' : 'Expand the terminal'}
			aria-label={expanded ? 'Shrink the terminal' : 'Expand the terminal'}
			onclick={() => (expanded = !expanded)}
		>
			{#if expanded}
				<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M15 21h4a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4"/></svg>
			{:else}
				<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M21 15v4a2 2 0 0 1-2 2h-4M3 15v4a2 2 0 0 0 2 2h4"/></svg>
			{/if}
		</button>
	</div>
	{#if kstate === 'sleeping' || kstate === 'none' || kstate === 'booting'}
		<div class="asleep">
			<span>
				{kstate === 'sleeping'
					? 'machine is asleep - waking it…'
					: kstate === 'booting'
						? 'machine is starting…'
						: 'no machine yet - building one…'}
			</span>
		</div>
	{/if}
</div>

<style>
	/* Same box the desktop screen sits in, so the two views swap in place. */
	.term {
		position: relative;
		margin: 0.8rem;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: #101014;
		overflow: hidden;
		/* Fills whatever the panel has left; the FitAddon's resize observer
		   refits the grid when the box changes shape. */
		flex: 1;
		min-height: 0;
	}
	.termhost {
		position: absolute;
		inset: 0;
		padding: 0.45rem;
	}
	/*
	 * ghostty-web's hidden input is the one element in the widget that carries
	 * the browser's own colours - a white background with a black caret - and
	 * it is only 1px and transparent by an inline style. Painted to the theme
	 * here, it cannot flash as a white box (or a black caret) inside a dark
	 * pane whatever happens to its size.
	 */
	.termhost :global(textarea) {
		background: #101014;
		color: #d4d4d8;
		caret-color: #d4d4d8;
		border: none;
		outline: none;
	}
	/* The terminal itself: same colour as the box, so the painted grid and the
	   unpainted area below it read as one surface. */
	.termhost :global(canvas) {
		background: #101014;
	}
	.termtools {
		position: absolute;
		top: 0.45rem;
		right: 0.45rem;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.chip {
		font-size: 0.66rem;
		color: var(--text-muted);
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.18rem 0.55rem;
	}
	.chip.live {
		color: #7ee0a8;
		border-color: #2c5a3d;
	}
	.chip.note {
		color: #d4d4d8;
		border-color: #3d3d44;
	}
	.tool {
		display: grid;
		place-items: center;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		font-size: 0.85rem;
		line-height: 1;
		padding: 0.3rem 0.45rem;
		cursor: pointer;
	}
	.tool:hover {
		background: rgba(0, 0, 0, 0.85);
	}
	.tool:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.tool:disabled:hover {
		background: rgba(0, 0, 0, 0.6);
	}
	/* Same overlay-the-app pattern as .screen.expanded. */
	.term.expanded {
		/* A terminal reads best wide: ~2:1 keeps 80-col lines uncramped without
		   the letterbox a 16:10 box leaves on a tall window. */
		--w: min(1180px, 94vw, calc(88vh * 2.0));
		position: fixed;
		inset: 0;
		margin: auto;
		width: var(--w);
		height: calc(var(--w) / 2.0);
		z-index: 70;
		border-color: #3d3d44;
		box-shadow:
			0 0 0 100vmax rgba(0, 0, 0, 0.62),
			0 24px 70px rgba(0, 0, 0, 0.6);
	}
	/* Under the tools (z 5) and click-through, so the expand button and the
	   terminal's scroll still work while the note is up. */
	.asleep {
		position: absolute;
		inset: 0;
		z-index: 4;
		pointer-events: none;
		display: grid;
		place-items: center;
		background: rgba(10, 10, 12, 0.72);
		color: var(--text-muted);
		font-size: 0.8rem;
	}
</style>
