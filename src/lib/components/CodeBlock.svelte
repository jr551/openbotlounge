<script lang="ts">
	import hljs from 'highlight.js/lib/common';
	// The theme that gives the <span class="hljs-*"> tokens their colours;
	// without it the highlight runs but everything renders plain.
	import 'highlight.js/styles/github-dark.css';

	let { lang = '', text = '' }: { lang?: string; text?: string } = $props();

	let copied = $state(false);

	const html = $derived.by(() => {
		try {
			if (lang && hljs.getLanguage(lang)) {
				return hljs.highlight(text, { language: lang }).value;
			}
			return hljs.highlightAuto(text).value;
		} catch {
			// The fallback is spliced in as markup, so it must be escaped here.
			return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}
	});

	async function copy() {
		// A denied clipboard (permissions policy, unfocused tab) must not throw
		// an unhandled rejection - the button just does nothing.
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return;
		}
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="codeblock">
	<div class="bar">
		<span class="lang">{lang || 'text'}</span>
		<button class="copy" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
	</div>
	<pre><code>{@html html}</code></pre>
</div>

<style>
	.codeblock {
		margin: 0.5rem 0;
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		overflow: hidden;
		background: var(--bg);
	}
	.bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.4rem 0.8rem;
		background: var(--bg-raised);
		border-bottom: 1px solid var(--border);
	}
	.lang {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.copy {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 0.75rem;
		cursor: pointer;
		padding: 0.15rem 0.4rem;
		border-radius: 0.3rem;
	}
	.copy:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	pre {
		margin: 0;
		padding: 0.7rem 0.8rem;
		overflow-x: auto;
		font-size: 0.85rem;
		line-height: 1.5;
	}
	code {
		font-family: 'SF Mono', 'Fira Code', Menlo, Consolas, monospace;
	}
</style>
