<script lang="ts">
	import SvelteMarkdown from '@humanspeak/svelte-markdown';
	import CodeBlock from './CodeBlock.svelte';
	import { guardHtml } from '$lib/markdown-guard';

	let { source }: { source: string } = $props();

	// Message text is untrusted; raw HTML would otherwise become live elements.
	const safe = $derived(guardHtml(source));
</script>

<div class="md">
	<SvelteMarkdown source={safe} renderers={{ code: CodeBlock }} />
</div>

<style>
	.md {
		line-height: 1.65;
		font-size: 0.95rem;
		overflow-wrap: break-word;
	}
	.md :global(p) {
		margin: 0.5rem 0;
	}
	.md :global(p:first-child) {
		margin-top: 0;
	}
	.md :global(p:last-child) {
		margin-bottom: 0;
	}
	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		margin: 1rem 0 0.5rem;
		line-height: 1.3;
	}
	.md :global(ul),
	.md :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}
	.md :global(li) {
		margin: 0.25rem 0;
	}
	.md :global(code) {
		font-family: 'SF Mono', 'Fira Code', Menlo, Consolas, monospace;
		font-size: 0.85em;
		background: rgba(0, 0, 0, 0.28);
		border: 1px solid var(--border);
		border-radius: 0.3rem;
		padding: 0.15em 0.25em;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
	}
	.md :global(pre code) {
		background: none;
		border: none;
		padding: 0;
		font-size: inherit;
	}
	.md :global(a) {
		color: #6ea8fe;
	}
	.md :global(blockquote) {
		margin: 0.75rem 0;
		padding: 0.1rem 0 0.1rem 1rem;
		border-left: 3px solid var(--border);
		color: var(--text-muted);
	}
	.md :global(table) {
		border-collapse: collapse;
		margin: 0.75rem 0;
	}
	.md :global(th),
	.md :global(td) {
		border: 1px solid var(--border);
		padding: 0.4rem 0.7rem;
		font-size: 0.88rem;
	}
	.md :global(th) {
		background: #1a1a1e;
	}
	.md :global(hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1rem 0;
	}
</style>
