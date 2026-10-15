<script lang="ts">
	import { tick } from 'svelte';
	import { chat, oneLine } from '$lib/stores/chat.svelte';
	import { sendOnEnter } from '$lib/keys';
	import EmojiPicker from './EmojiPicker.svelte';

	let text = $state('');
	let fileInput: HTMLInputElement;
	let listening = $state(false);
	let attachments = $state<{ name: string; kind: 'text' | 'image'; content: string }[]>([]);
	const target = $derived(
		chat.activeBots[0]?.name ?? chat.conversationBots(chat.activeConversation)[0]?.name ?? 'Bot'
	);
	/** Chromium never paints an ellipsis on a ::placeholder, so a name longer
	 *  than the field is simply cut off mid-glyph; shorten it here instead. */
	const placeholderName = $derived(oneLine(target, 28));
	/** Sending mid-turn is allowed: the running task keeps going. */
	const canSend = $derived((text.trim().length > 0 || attachments.length > 0) && !!chat.activeId);

	let textarea: HTMLTextAreaElement;

	/**
	 * The message being answered, as the bar above the input shows it: who said
	 * it and one line of what they said. The draft holds the message itself, so
	 * nothing has to be resolved or stored twice.
	 */
	const quoting = $derived.by(() => {
		const m = chat.quoteDraft;
		if (!m) return null;
		return {
			id: m.id,
			author: m.bot_id ? (chat.botById(m.bot_id)?.name ?? 'a bot') : 'You',
			snippet: oneLine(m.content, 120)
		};
	});

	/**
	 * Reach for the field when the reader picks a message to answer, so quoting
	 * is one click and straight to typing. Only a message that has just been
	 * chosen focuses it: a draft restored with the page does not steal the caret.
	 */
	let focusedQuote = '';
	$effect(() => {
		const id = chat.quoteDraft?.id ?? '';
		if (!id || id === focusedQuote) return;
		focusedQuote = id;
		void tick().then(() => textarea?.focus());
	});

	/** Insert at the caret so the picker behaves like a keyboard emoji row. */
	function insertEmoji(emoji: string) {
		const el = textarea;
		if (!el) {
			text += emoji;
			return;
		}
		const start = el.selectionStart ?? text.length;
		const end = el.selectionEnd ?? start;
		text = text.slice(0, start) + emoji + text.slice(end);
		void tick().then(() => {
			el.focus();
			autogrow(el);
			const caret = start + emoji.length;
			el.setSelectionRange(caret, caret);
		});
	}

	function autogrow(el: HTMLTextAreaElement) {
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 200) + 'px';
	}

	async function submit() {
		const value = text.trim();
		if ((!value && !attachments.length) || !chat.activeId) return;
		let out = value;
		for (const a of attachments) {
			out += a.kind === 'image'
				? `\n\n![${a.name}](${a.content})`
				: `\n\n${a.name}\n\`\`\`\n${a.content}\n\`\`\`\n`;
		}
		const sentText = text;
		const sentAttachments = attachments;
		text = '';
		attachments = [];
		if (textarea) textarea.style.height = 'auto';
		// A refused send keeps the words: the bubble was never stored, so the
		// draft goes back rather than vanishing with the failed request.
		if (!(await chat.send(out))) {
			if (!text) text = sentText;
			if (!attachments.length) attachments = sentAttachments;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (sendOnEnter(e)) {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape' && chat.quoteDraft) {
			e.preventDefault();
			chat.quoteDraft = null;
		}
	}

	async function onFiles(e: Event) {
		const files = (e.target as HTMLInputElement).files;
		if (!files?.length) return;
		const skipped: string[] = [];
		for (const file of Array.from(files)) {
			// Only text belongs inline: a binary read as text lands as mojibake
			// garbage in the message, and an over-long file is dropped - say so
			// rather than letting the button look dead.
			const textual = file.type.startsWith('text/') || file.type === 'application/json' ||
				/\.(txt|md|json|js|ts|py|csv|log|ya?ml|xml|html?|css|toml|ini|sh|sql)$/i.test(file.name);
			if (!textual || file.size > 256 * 1024) {
				skipped.push(file.name);
				continue;
			}
			const content = await file.text().catch(() => null);
			if (content === null) {
				skipped.push(file.name);
				continue;
			}
			text += `${text ? '\n\n' : ''}${file.name}\n\`\`\`\n${content}\n\`\`\`\n`;
			// The field only grows on input events; a programmatic append would
			// leave it one row tall over text the reader cannot see.
			void tick().then(() => textarea && autogrow(textarea));
		}
		if (skipped.length) {
			chat.error = `Skipped ${skipped.join(', ')} — only text files up to 256 KB can be attached`;
		}
		(e.target as HTMLInputElement).value = '';
	}

	function onPaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of Array.from(items)) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) continue;
				const reader = new FileReader();
				reader.onload = () => {
					attachments = [
						...attachments,
						{ name: file.name || 'pasted image', kind: 'image', content: String(reader.result) }
					];
				};
				reader.readAsDataURL(file);
			}
		}
		if (e.defaultPrevented) return;
		const pasted = e.clipboardData?.getData('text/plain') ?? '';
		if (pasted.length > 32) {
			e.preventDefault();
			attachments = [
				...attachments,
				{ name: `pasted-${pasted.length}ch.txt`, kind: 'text', content: pasted }
			];
		}
	}
	/** The one recognizer in flight; a second click stops it, never stacks. */
	let rec: { stop: () => void } | null = null;

	function mic() {
		const w = window as unknown as {
			webkitSpeechRecognition?: new () => {
				continuous: boolean;
				interimResults: boolean;
				onresult: ((e: { results: { [k: number]: { [k: number]: { transcript: string } } } }) => void) | null;
				onend: (() => void) | null;
				onerror: (() => void) | null;
				start: () => void;
				stop: () => void;
			};
		};
		const SR = w.webkitSpeechRecognition;
		if (!SR) return;
		if (rec) {
			rec.stop();
			rec = null;
			listening = false;
			return;
		}
		const r = new SR();
		rec = r;
		r.continuous = false;
		r.interimResults = false;
		r.onresult = (e) => {
			text += e.results[0][0].transcript;
			void tick().then(() => textarea && autogrow(textarea));
		};
		r.onend = () => {
			listening = false;
			rec = null;
		};
		r.onerror = () => {
			listening = false;
			rec = null;
		};
		listening = true;
		r.start();
	}
</script>

<div class="composer">
	<div class="box">
		{#if quoting}
			<!-- What this send answers: one line of it, and a way out of it. -->
			<div class="quotebar">
				<span class="quotewho">{quoting.author}</span>
				<span class="quotetext">{quoting.snippet}</span>
				<button class="quotex" title="Cancel reply" onclick={() => (chat.quoteDraft = null)}>✕</button>
			</div>
		{/if}
		{#if attachments.length}
			<div class="chips">
				{#each attachments as a, i}
					<span class="chip">
						{a.kind === 'image' ? '🖼' : '📄'} {a.name}
						<button class="x" onclick={() => (attachments = attachments.filter((_, j) => j !== i))}>✕</button>
					</span>
				{/each}
			</div>
		{/if}
		<div class="inputrow">
			<div class="side">
				<button
					class="tool lock"
					class:on={chat.secretDraft}
					title="Give them a secret"
					type="button"
					onclick={() => (chat.secretDraft = !chat.secretDraft)}
				>
					<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path class="shackle" d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
				</button>

				<button class="tool" title="Attach a text file" onclick={() => fileInput.click()}>
					<svg class="attach" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
				</button>
				<input bind:this={fileInput} type="file" multiple hidden accept="text/*,.txt,.md,.json,.js,.ts,.py,.csv,.log,.yaml,.yml,.xml,.html,.css,.toml,.ini,.sh,.sql" onchange={onFiles} />
			</div>

			<textarea
				rows="1"
				placeholder="Message {placeholderName}"
				bind:this={textarea}
				bind:value={text}
				oninput={(e) => autogrow(e.currentTarget)}
				onkeydown={onKeydown}
				onpaste={onPaste}
			></textarea>

			<div class="side">
				<button
					class="tool brain"
					class:on={chat.think}
					title={chat.think ? 'Thinking hard' : 'Think harder'}
					onclick={() => (chat.think = !chat.think)}
				>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.6C10.7 3.7 9.1 3.4 7.7 4 5.6 4.9 4.3 6.8 4.3 9c0 .5.1 1 .3 1.4a3.6 3.6 0 0 0-1.1 3.5c0 1.6 1.1 3 2.7 3.4.6 1.5 2.1 2.6 3.9 2.6.7 0 1.5-.2 1.9-.7"/><path d="M12 4.6c1.3-.9 2.9-1.2 4.3-.6 2.1.9 3.4 2.8 3.4 5 0 .5-.1 1-.3 1.4a3.6 3.6 0 0 1 1.1 3.5c0 1.6-1.1 3-2.7 3.4-.6 1.5-2.1 2.6-3.9 2.6-.7 0-1.5-.2-1.9-.7"/><path d="M12 4.6v14.6"/><path d="M8.3 8.5c-1 .3-1.7 1.2-1.7 2.3"/><path d="M15.7 8.5c1 .3 1.7 1.2 1.7 2.3"/></svg>
				</button>

				<EmojiPicker onselect={insertEmoji} />

				<button class="tool mic" class:on={listening} title="Voice input" onclick={mic}>
					<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>
				</button>

				{#if chat.streaming}
					<button class="send stop" title="Stop" onclick={() => chat.stop()}>
						<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
					</button>
					<button class="send branch" title="Branch new subtask" onclick={() => void chat.sendBranch(text)}>
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M15 6h-3a3 3 0 0 0-3 3v3"/></svg>
					</button>
				{/if}
				<button class="send" title="Send" disabled={!canSend} onclick={submit}>
					<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.composer {
		padding: 0.4rem 1rem 0.5rem;
	}
	.box {
		width: min(44rem, 100%);
		margin: 0 auto;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 1.4rem;
		padding: 0.5rem 0.6rem;
	}
	.box:focus-within {
		border-color: #3d3d44;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		padding: 0.2rem 0.3rem 0.5rem;
	}
	/* The reply draft: one line of the message being answered, above the field,
	   with an accent edge that matches the quote on the sent bubble. */
	.quotebar {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		margin: 0.1rem 0.3rem 0.45rem;
		padding: 0.3rem 0.5rem;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border-left: 3px solid color-mix(in srgb, var(--accent) 60%, transparent);
		border-radius: 0.5rem;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.quotewho {
		flex: none;
		font-weight: 600;
		font-style: italic;
	}
	.quotetext {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.quotex {
		flex: none;
		align-self: center;
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 0.72rem;
		cursor: pointer;
		padding: 0 0.1rem;
	}
	.quotex:hover {
		color: var(--text);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		padding: 0.25rem 0.55rem;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.chip .x {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.7rem;
		padding: 0;
	}
	.chip .x:hover {
		color: var(--text);
	}
	.inputrow {
		display: flex;
		align-items: center;
		/* Wider than the .side inner gap so each cluster reads as one group. */
		gap: 0.5rem;
	}
	/* The two icon clusters: identical flex rhythm on both sides of the field. */
	.side {
		display: flex;
		align-items: center;
		gap: 0.1rem;
		flex-shrink: 0;
	}
	/* The field can be only ~120px wide on a narrow screen, and the placeholder
	   - the bot's name is part of it - needs more than that, so it wrapped and
	   the second line was clipped. One line reads as intentional; Firefox paints
	   the ellipsis, Chromium cuts hard, so long names are shortened in JS too. */
	textarea::placeholder {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	textarea {
		flex: 1;
		resize: none;
		background: none;
		border: none;
		outline: none;
		color: var(--text);
		font-family: inherit;
		font-size: 0.95rem;
		line-height: 1.5;
		max-height: 200px;
		/* Asymmetric on purpose: Inter's ink sits ~1.6px low in the line box, so
		   this nudges the text's optical centre onto the buttons' centre line. */
		padding: 0.35rem 0.3rem 0.55rem;
	}
	textarea::placeholder {
		color: var(--text-muted);
	}
	/*
	 * The side controls stay out of the way until you reach for them. The emoji
	 * button lives inside EmojiPicker, so its rules have to be global - a scoped
	 * selector from this component can never match it.
	 */
	.inputrow .tool,
	.inputrow :global(.ebtn) {
		opacity: 0.45;
		transition: opacity 0.15s;
	}
	.box:hover .inputrow .tool,
	.box:hover .inputrow :global(.ebtn),
	.box:focus-within .inputrow .tool,
	.box:focus-within .inputrow :global(.ebtn),
	.inputrow .tool.on,
	.inputrow :global(.ebtn.on) {
		opacity: 1;
	}
	/* Match the emoji trigger's hit area to .tool so glyph spacing is even. */
	.inputrow :global(.ebtn) {
		padding: 0.45rem;
		border-radius: 0.5rem;
	}
	.tool {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0.45rem;
		border-radius: 0.5rem;
		font-size: 0.82rem;
	}
	.tool:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.tool.on {
		color: #ff5d8f;
		background: rgba(255, 93, 143, 0.14);
	}
	.mic.on {
		color: #6ea8fe;
		background: #16202e;
	}
	.send {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: none;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
		flex-shrink: 0;
		/* The circles carry no padding, so margins give them the same air the
		   ghost buttons get from theirs — even glyph gaps and symmetric
		   insets at both ends of the row. */
	}
	.send:disabled {
		background: #2a2a2f;
		color: #5a5a63;
		cursor: default;
	}
	.send.stop {
		background: #2a2a2f;
		color: var(--text);
	}
	/* Gentle life for the row icons; all motion is hover/active-driven. */
	.inputrow .tool svg,
	.send svg {
		transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.tool:hover .attach {
		transform: rotate(90deg);
	}
	.shackle {
		transform-box: fill-box;
		transform-origin: left bottom;
		transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.lock.on .shackle {
		transform: rotate(-20deg);
	}
	.mic.on svg {
		animation: micpulse 1.1s ease-in-out infinite;
	}
	@keyframes micpulse {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.12);
		}
	}
	.brain.on svg {
		animation: brainbob 2.4s ease-in-out infinite;
	}
	.brain:hover svg {
		transform: scale(1.08);
		animation: brainwobble 0.45s ease-in-out;
	}
	@keyframes brainwobble {
		0% {
			transform: scale(1) rotate(0deg);
		}
		30% {
			transform: scale(1.08) rotate(-5deg);
		}
		65% {
			transform: scale(1.08) rotate(4deg);
		}
		100% {
			transform: scale(1.08) rotate(0deg);
		}
	}
	@keyframes brainbob {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-1.5px);
		}
	}
	.send:not(:disabled):not(.stop):hover svg {
		transform: translateY(-1px) rotate(6deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.inputrow .tool svg,
		.send svg,
		.shackle {
			transition: none;
		}
		.mic.on svg,
		.brain:hover svg,
		.brain.on svg {
			animation: none;
		}
	}
	/* Phone widths: the same controls, packed tighter, so the field is usable. */
	@media (max-width: 430px) {
		.inputrow {
			gap: 0.25rem;
		}
		.side {
			gap: 0;
		}
		.tool {
			padding: 0.3rem;
		}
	}
</style>
