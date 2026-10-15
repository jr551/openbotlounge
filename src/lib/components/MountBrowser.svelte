<script lang="ts">
	import { untrack } from 'svelte';
	import { byteSize, shortAge } from '$lib/format';

	/**
	 * One of the bots' drives as a folder tree: /company, or one bot's /shared.
	 *
	 * Read-only. A folder is fetched the first time it is opened and kept, so
	 * folding and unfolding costs nothing after that; the drive itself is
	 * re-read whenever the picker sends a different one.
	 */
	let {
		volume,
		botId = '',
		label = ''
	}: { volume: 'company' | 'shared'; botId?: string; label?: string } = $props();

	type FileRow = { name: string; path: string; size: number; mtime: number };
	type Node = {
		folders: { name: string; path: string }[];
		files: FileRow[];
		open: boolean;
		loaded: boolean;
		loading: boolean;
		error: string;
	};
	type Preview = { name: string; text: string; size: number; truncated: boolean; binary?: string };

	/** One node per folder that has been opened, keyed by its path ('' = root). */
	let nodes = $state<Record<string, Node>>({});
	let all = $state<{ files: { path: string; size: number }[]; truncated: boolean } | null>(null);
	let preview = $state<Preview | null>(null);
	let error = $state('');
	let loading = $state(false);
	/** Why the drive could not be read at all (no Docker, no reader image). */
	let fault = $state('');
	/** The file whose preview is on its way, named so a slow read is not silent. */
	let previewing = $state('');

	const root = $derived(nodes['']);

	function empty(open = false): Node {
		return { folders: [], files: [], open, loaded: false, loading: false, error: '' };
	}

	/** The query every request carries for the drive on screen. */
	function driveQuery(path = ''): string {
		const params = new URLSearchParams({ volume, path });
		if (volume === 'shared' && botId) params.set('bot_id', botId);
		return params.toString();
	}

	async function load(path: string): Promise<void> {
		const node = nodes[path] ?? empty();
		// A folder that failed to read stays unloaded, so the next click retries
		// rather than toggling a dead branch open.
		nodes[path] = { ...node, loading: true, error: '' };
		const res = await fetch(`/api/mounts?${driveQuery(path)}`).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			nodes[path] = {
				...nodes[path],
				loading: false,
				error: body?.message ?? 'could not read that folder'
			};
			return;
		}
		const data = await res.json();
		nodes[path] = {
			folders: data.folders ?? [],
			files: data.files ?? [],
			open: true,
			loaded: true,
			loading: false,
			error: ''
		};
	}

	/** Every file on the drive, flat - the whole of /company at a glance. */
	async function loadAll(): Promise<void> {
		loading = true;
		error = '';
		const res = await fetch(`/api/mounts?volume=${volume}&all=1`).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			error = body?.message ?? 'could not read the drive';
			loading = false;
			return;
		}
		const data = await res.json();
		all = { files: data.files ?? [], truncated: !!data.truncated };
		loading = false;
	}

	async function toggle(path: string): Promise<void> {
		const node = nodes[path];
		// A second click while the drive is still answering starts a second
		// reader container for the same folder; the first result is on its way.
		if (node?.loading) return;
		if (node?.loaded) {
			nodes[path] = { ...node, open: !node.open };
			return;
		}
		await load(path);
	}

	/** The start of one file, for reading without leaving the dialog. */
	async function show(file: FileRow): Promise<void> {
		error = '';
		// A listing takes as long as a reader container takes to start, so the
		// click has to say something while it waits.
		previewing = file.name;
		const res = await fetch(`/api/mounts/file?${driveQuery(file.path)}`).catch(() => null);
		previewing = '';
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			error = body?.message ?? 'could not read that file';
			return;
		}
		const data = await res.json();
		preview =
			data.kind === 'text'
				? { name: data.name, text: data.text, size: data.size, truncated: data.truncated }
				: { name: data.name, text: '', size: data.size, truncated: false, binary: data.note };
	}

	$effect(() => {
		// A different drive starts at its own root; the tree under the old one
		// belongs to a disk that is no longer on screen.
		void volume;
		void botId;
		// Everything below runs untracked. load() reads the node table as it
		// starts, and a tracked read there would have this effect rescheduling
		// itself off its own write - an endless reset.
		untrack(() => {
			nodes = {};
			all = null;
			preview = null;
			error = '';
			fault = '';
			loading = true;
			void load('').then(() => {
				loading = false;
				fault = untrack(() => nodes['']?.error ?? '');
			});
		});
	});
</script>

{#snippet rows(path: string, depth: number)}
	{#each nodes[path]?.folders ?? [] as folder (folder.path)}
		<button
			class="mrow dir"
			style="padding-left:{0.35 + depth * 0.85}rem"
			onclick={() => void toggle(folder.path)}
		>
			<span class="chev">{nodes[folder.path]?.open ? '▾' : '▸'}</span>
			<span class="mname">{folder.name}</span>
		</button>
		{#if nodes[folder.path]?.loading}
			<span class="mnote" style="padding-left:{0.35 + (depth + 1) * 0.85}rem">reading…</span>
		{/if}
		{#if nodes[folder.path]?.error}
			<span class="mbad" style="padding-left:{0.35 + (depth + 1) * 0.85}rem">
				{nodes[folder.path]?.error}
			</span>
		{/if}
		{#if nodes[folder.path]?.open}
			{@render rows(folder.path, depth + 1)}
			{#if nodes[folder.path]?.loaded && !nodes[folder.path]?.folders.length && !nodes[folder.path]?.files.length}
				<span class="mnote" style="padding-left:{0.35 + (depth + 1) * 0.85}rem">empty</span>
			{/if}
		{/if}
	{/each}
	{#each nodes[path]?.files ?? [] as file (file.path)}
		<button class="mrow file" style="padding-left:{0.35 + depth * 0.85}rem" onclick={() => void show(file)}>
			<span class="mname">{file.name}</span>
			<span class="msize">{byteSize(file.size)}</span>
			<span class="mage">{file.mtime ? shortAge(file.mtime) : ''}</span>
		</button>
	{/each}
{/snippet}

<div class="mount">
	<div class="mhead">
		<span class="mtitle">{label || 'Drive'}</span>
		<button class="mall" onclick={() => void loadAll()}>All files</button>
		{#if all}<button class="mall" onclick={() => (all = null)}>Fold the list</button>{/if}
	</div>

	{#if fault}
		<p class="mbad">{fault}</p>
	{:else}
		<div class="mtree" class:short={!!preview}>
			{#if loading && !root}
				<span class="mnote">reading the drive…</span>
			{:else if root}
				{@render rows('', 0)}
				{#if !root.folders.length && !root.files.length}
					<span class="mnote">nothing on this drive yet</span>
				{/if}
			{/if}
		</div>
	{/if}

	{#if all}
		<div class="mtree tall">
			{#if !all.files.length}
				<span class="mnote">no files on this drive</span>
			{:else}
				{#each all.files as f (f.path)}
					<button class="mrow file" onclick={() => void show({ ...f, name: f.path, mtime: 0 })}>
						<span class="mname">{f.path}</span>
						<span class="msize">{byteSize(f.size)}</span>
					</button>
				{/each}
				{#if all.truncated}
					<span class="mnote">first {all.files.length} files shown</span>
				{/if}
			{/if}
		</div>
	{/if}

	{#if preview}
		<div class="mview">
			<div class="mvhead">
				<span class="mvname">{preview.name}</span>
				<span class="msize">{byteSize(preview.size)}{preview.truncated ? ' · start of file' : ''}</span>
				<button class="mall" onclick={() => (preview = null)}>Close</button>
			</div>
			{#if preview.binary}
				<span class="mnote">{preview.binary}</span>
			{:else}
				<pre class="mtext">{preview.text || '(empty)'}</pre>
			{/if}
		</div>
	{/if}
	{#if previewing}
		<p class="mnote">reading {previewing}…</p>
	{/if}

	{#if error}<p class="mbad">{error}</p>{/if}
</div>

<style>
	.mount {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.mhead {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.mtitle {
		color: var(--text);
		font-weight: 600;
		font-size: 0.85rem;
	}
	.mall {
		font-size: 0.72rem;
		padding: 0.15rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-hover);
		color: var(--text-muted);
		cursor: pointer;
	}
	.mall:hover {
		color: var(--text);
	}
	.mtree {
		max-height: 16rem;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg-raised);
		padding: 0.3rem 0;
		display: flex;
		flex-direction: column;
	}
	.mtree.short {
		max-height: 9rem;
	}
	.mtree.tall {
		max-height: 12rem;
	}
	.mrow {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		background: none;
		border: 0;
		padding: 0.18rem 0.5rem;
		color: var(--text);
		font-size: 0.78rem;
		text-align: left;
		cursor: pointer;
	}
	.mrow:hover {
		background: var(--bg-hover);
	}
	.chev {
		width: 0.7rem;
		color: var(--text-muted);
	}
	.mname {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mrow.dir .mname {
		color: var(--text);
	}
	.msize,
	.mage {
		color: var(--text-muted);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}
	.mnote,
	.mbad {
		color: var(--text-muted);
		font-size: 0.74rem;
		padding: 0.15rem 0.5rem;
	}
	.mbad {
		color: var(--danger);
	}
	.mview {
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg-hover);
		display: flex;
		flex-direction: column;
	}
	.mvhead {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.55rem;
		border-bottom: 1px solid var(--border);
	}
	.mvname {
		flex: 1;
		color: var(--text);
		font-size: 0.78rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mtext {
		margin: 0;
		padding: 0.5rem 0.6rem;
		max-height: 14rem;
		overflow: auto;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
