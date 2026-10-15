<script lang="ts">
	import { byteSize, kindOf, shortAge } from '$lib/format';

	/** One file the user has given this agent; the bytes are fetched separately. */
	type StoredFile = { id: string; name: string; size: number; mime: string; created_at: number };

	/** A folder in the tree: the segment it is named by, and the path that opens it. */
	type Folder = { name: string; path: string };

	/** A file on its way in, with the path inside the drop it will be filed under. */
	type Incoming = { file: File; rel: string };

	let { botId, botName = '' }: { botId: string; botName?: string } = $props();

	/** Mirrors MAX_FILE_BYTES in $lib/server/files.ts, which is the authority. */
	const MAX_FILE_BYTES = 256 * 1024;

	/** The folder on screen, as a path of segments; '' is the agent's top level. */
	let path = $state('');
	let folders = $state<Folder[]>([]);
	let files = $state<StoredFile[]>([]);
	let loading = $state(false);
	let error = $state('');
	/** The file being sent this moment, so a drop of many is not a silent wait. */
	let busy = $state('');
	let dragging = $state(false);
	let picker = $state<HTMLInputElement | null>(null);
	let dirPicker = $state<HTMLInputElement | null>(null);
	/** The agent the folder on screen was opened in, so another starts at its own top. */
	let shownBot = '';

	/** The trail to the folder on screen, each part with the path that opens it. */
	const crumbs = $derived(
		path
			? path.split('/').map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') }))
			: []
	);

	/** The file's own name, without the folders it is filed under. */
	function base(name: string): string {
		return name.slice(name.lastIndexOf('/') + 1);
	}

	/** One folder of this agent's files, or a reason there is nothing to show. */
	async function load(bot: string, dir: string) {
		if (!bot) {
			folders = [];
			files = [];
			error = '';
			return;
		}
		loading = true;
		const query = `bot_id=${encodeURIComponent(bot)}&path=${encodeURIComponent(dir)}`;
		const res = await fetch(`/api/files?${query}`).catch(() => null);
		// The reader may have moved on - into another folder, or to another agent
		// - while this was in flight, and a late reply is not news about the
		// folder on screen: assigning it would fill the list with another
		// agent's files, delete buttons and all, under the name now shown.
		if (bot !== botId || dir !== path) return;
		if (!res?.ok) {
			loading = false;
			folders = [];
			files = [];
			error = 'Could not read this folder.';
			return;
		}
		const data = await res.json();
		if (bot !== botId || dir !== path) return;
		loading = false;
		folders = data.folders;
		files = data.files;
		error = '';
	}

	$effect(() => {
		const bot = botId;
		if (bot !== shownBot) {
			shownBot = bot;
			if (path) {
				// A folder belongs to the agent it was opened in, so a different
				// agent starts at its own top level. The effect runs again with
				// the reset path - loading here would ask the new agent about the
				// old agent's folder for nothing.
				path = '';
				return;
			}
		}
		void load(bot, path);
	});

	/** The folder one level up from the one on screen; the top has none. */
	function up() {
		const cut = path.lastIndexOf('/');
		path = cut < 0 ? '' : path.slice(0, cut);
	}

	/** A File's bytes as the data URL the upload endpoint takes. */
	function readAsDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	}

	/** The path a picked file carries inside the folder that was picked. */
	function relOf(file: File): string {
		return file.webkitRelativePath || file.name;
	}

	/**
	 * Send one file into the folder on screen, filed under `rel`.
	 *
	 * `rel` is the path the browser gave the file, which for a folder that was
	 * picked or dropped is the whole path inside it - so a folder arrives as the
	 * tree it is rather than as a heap of files with no place of their own. What
	 * a name may be is the server's call, and a refusal is shown as it came.
	 */
	async function send(bot: string, dir: string, file: File, rel: string): Promise<boolean> {
		// Refused here as well as on the server, so an enormous file is declined
		// before the browser spends time encoding it.
		if (file.size > MAX_FILE_BYTES) {
			error = `${rel} is larger than the ${MAX_FILE_BYTES / 1024} KB limit.`;
			return false;
		}
		let data: string;
		try {
			data = await readAsDataUrl(file);
		} catch {
			error = `${rel} could not be read.`;
			return false;
		}
		const name = dir ? `${dir}/${rel}` : rel;
		busy = rel;
		const res = await fetch('/api/files', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bot_id: bot, name, data })
		}).catch(() => null);
		busy = '';
		// A reply about an agent the picker has left is not news about the one on
		// screen, so it is not shown and nothing is reloaded.
		if (bot !== botId) return false;
		if (res?.ok) return true;
		// Say what the server said: it knows which mistake it was.
		const body = await res?.json().catch(() => null);
		error = body?.message ?? `Could not add ${rel}.`;
		return false;
	}

	/** Add what was picked or dropped, then show the folder it landed in. */
	async function addFiles(incoming: Incoming[]) {
		const bot = botId;
		const dir = path;
		if (!bot || !incoming.length) return;
		// Cleared once, at the start: one file of a batch failing leaves its
		// reason on screen even when the next one lands.
		error = '';
		let added = 0;
		for (const { file, rel } of incoming) {
			if (await send(bot, dir, file, rel)) added++;
		}
		if (bot !== botId) return;
		if (added) await load(bot, dir);
	}

	/** A picker's worth of files, read before the input is cleared. */
	function onPick(input: HTMLInputElement | null) {
		const picked = input ? [...(input.files ?? [])] : [];
		// Cleared at once so picking the same file twice in a row registers. The
		// copies above are what the uploads use: the input's own list is live,
		// and emptying the input empties it.
		if (input) input.value = '';
		void addFiles(picked.map((file) => ({ file, rel: relOf(file) })));
	}

	/** Every file inside a dropped entry, each with the path it was dropped under. */
	async function walk(entry: FileSystemEntry, out: Incoming[]): Promise<void> {
		if (entry.isFile) {
			const file = await new Promise<File | null>((resolve) => {
				(entry as FileSystemFileEntry).file(resolve, () => resolve(null));
			});
			// fullPath is rooted at the drop, so trimming the separator leaves the
			// path the tree is filed under.
			if (file) out.push({ file, rel: entry.fullPath.replace(/^\//, '') || file.name });
			return;
		}
		if (!entry.isDirectory) return;
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		// readEntries hands back one batch at a time and says it is done by
		// handing back nothing, so it is asked until it does.
		for (;;) {
			const batch = await new Promise<FileSystemEntry[]>((resolve) =>
				reader.readEntries(resolve, () => resolve([]))
			);
			if (!batch.length) return;
			for (const child of batch) await walk(child, out);
		}
	}

	/** The files a drop carried, a dropped folder included. */
	async function takeDrop(dt: DataTransfer) {
		dragging = false;
		// Both lists are read now: a drop's data is only there during the event.
		const items = [...dt.items];
		const plain = [...dt.files];
		const entries = items
			.map((item) => item.webkitGetAsEntry?.() ?? null)
			.filter((entry): entry is FileSystemEntry => entry !== null);
		if (!entries.length) {
			await addFiles(plain.map((file) => ({ file, rel: relOf(file) })));
			return;
		}
		// A folder arrives as one entry to be walked, not as the files inside it,
		// and a mix of both is walked the same way.
		const incoming: Incoming[] = [];
		for (const entry of entries) await walk(entry, incoming);
		await addFiles(incoming);
	}

	/** Drop a file the user no longer wants the agent to have. */
	async function forget(id: string) {
		const res = await fetch(`/api/files/${id}`, { method: 'DELETE' }).catch(() => null);
		await load(botId, path);
		if (res && !res.ok) error = 'Could not delete that file.';
	}
</script>

<div class="browser">
	<div
		class="dropzone"
		class:over={dragging}
		role="button"
		tabindex="0"
		ondragover={(e) => {
			e.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={(e) => {
			e.preventDefault();
			const dt = e.dataTransfer;
			if (dt) void takeDrop(dt);
		}}
		onclick={() => picker?.click()}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				picker?.click();
			}
		}}
	>
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V5m0 0L8 9m4-4l4 4M5 19h14"/></svg>
		<span>Drop files or a folder here, or click to choose</span>
		<span class="dlimit">
			Into {path ? `${path}/` : 'the top level'} · up to {MAX_FILE_BYTES / 1024} KB each
		</span>
	</div>
	<button class="linky" onclick={() => dirPicker?.click()}>Add a whole folder…</button>
	<input
		class="pick"
		type="file"
		multiple
		aria-label="Add files"
		bind:this={picker}
		onchange={() => onPick(picker)}
	/>
	<input
		class="pick"
		type="file"
		webkitdirectory
		multiple
		aria-label="Add a folder and everything in it"
		bind:this={dirPicker}
		onchange={() => onPick(dirPicker)}
	/>

	<nav class="crumbs" aria-label="Folder">
		{#if path}
			<button class="up" onclick={up} title="Up one folder" aria-label="Up one folder">
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V6m0 0l-6 6m6-6l6 6" /></svg>
			</button>
		{/if}
		<button
			class="crumb"
			class:here={!path}
			aria-current={!path ? 'page' : undefined}
			onclick={() => (path = '')}>Files</button
		>
		{#each crumbs as c (c.path)}
			<span class="sep" aria-hidden="true">/</span>
			<button
				class="crumb"
				class:here={c.path === path}
				aria-current={c.path === path ? 'page' : undefined}
				onclick={() => (path = c.path)}>{c.name}</button
			>
		{/each}
	</nav>

	{#if busy}
		<p class="hint">Adding {busy}…</p>
	{/if}
	{#if error}
		<p class="hint err">{error}</p>
	{/if}

	{#if loading}
		<p class="hint">Loading…</p>
	{:else if folders.length === 0 && files.length === 0}
		<div class="empty">
			<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13l2-8h12l2 8v6H4z"/><path d="M4 13h4l1 2h6l1-2h4"/></svg>
			{#if path}
				<p>This folder is empty</p>
				<span>Anything dropped above lands in {path}/. A folder shows up once a file is in it.</span>
			{:else}
				<p>No files yet</p>
				<span>Anything added here is something {botName || 'this agent'} can read in chat.</span>
			{/if}
		</div>
	{:else}
		<div class="inv">
			{#each folders as d (d.path)}
				<button class="frow fold" onclick={() => (path = d.path)} title="Open {d.name}">
					<span class="thumb glyph" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
					</span>
					<span class="fmeta">
						<span class="fname">{d.name}</span>
						<span class="sub">Folder</span>
					</span>
				</button>
			{/each}
			{#each files as f (f.id)}
				{@const name = base(f.name)}
				{@const image = f.mime.startsWith('image/')}
				<div class="frow">
					{#if image}
						<img class="thumb" src={`/api/files/${f.id}?inline=1`} alt="" loading="lazy" />
					{:else}
						<span class="thumb glyph" aria-hidden="true">
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>
						</span>
					{/if}
					<span class="fmeta">
						{#if image}
							<a
								class="fname"
								href={`/api/files/${f.id}?inline=1`}
								target="_blank"
								rel="noreferrer"
								title="Open {name}">{name}</a
							>
						{:else}
							<a class="fname" href={`/api/files/${f.id}`} download={name} title="Download {name}"
								>{name}</a
							>
						{/if}
						<span class="sub">{byteSize(f.size)} · {kindOf(f.mime)} · {shortAge(f.created_at)}</span>
					</span>
					<a
						class="dl"
						href={`/api/files/${f.id}`}
						download={name}
						title="Download {name}"
						aria-label="Download {name}"
					>
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>
					</a>
					<button
						class="bin"
						title="Delete {name}"
						aria-label="Delete {name}"
						onclick={() => forget(f.id)}>✕</button
					>
				</div>
			{/each}
		</div>
		<p class="hint">
			{botName || 'This agent'} reads these with its own list_files and read_file tools, folders and
			all.
		</p>
	{/if}
</div>

<style>
	.browser {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	/* Children take no pointer events, so a drag that crosses a glyph or a label
	   still reads as being over the zone and the highlight never flickers. */
	.dropzone {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
		padding: 0.9rem 0.6rem;
		border: 1px dashed var(--border);
		border-radius: 0.6rem;
		background: var(--bg);
		color: var(--text-muted);
		font-size: 0.78rem;
		text-align: center;
		cursor: pointer;
	}
	.dropzone > * {
		pointer-events: none;
	}
	.dropzone:hover,
	.dropzone.over {
		border-color: var(--accent);
		background: var(--bg-hover);
		color: var(--text);
	}
	.dlimit {
		font-size: 0.7rem;
		word-break: break-all;
	}
	.linky {
		align-self: flex-start;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-muted);
		font-size: 0.72rem;
		text-decoration: underline;
		cursor: pointer;
	}
	.linky:hover {
		color: var(--text);
	}
	.pick {
		display: none;
	}
	.crumbs {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.15rem;
		min-height: 1.4rem;
		font-size: 0.78rem;
	}
	.crumb {
		padding: 0.05rem 0.3rem;
		border: none;
		border-radius: 0.4rem;
		background: none;
		color: var(--text-muted);
		font-size: 0.78rem;
		cursor: pointer;
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.crumb:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.crumb.here {
		color: var(--text);
	}
	.sep {
		color: var(--text-muted);
	}
	.up {
		display: grid;
		place-items: center;
		width: 1.4rem;
		height: 1.4rem;
		margin-right: 0.15rem;
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		background: var(--bg);
		color: var(--text-muted);
		cursor: pointer;
	}
	.up:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.hint {
		margin: 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.err {
		color: var(--danger);
	}
	.inv {
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg);
		overflow: hidden;
	}
	.frow {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		padding: 0.45rem 0.6rem;
		font-size: 0.8rem;
		text-align: left;
	}
	.frow + .frow {
		border-top: 1px solid var(--border);
	}
	.frow:hover {
		background: var(--bg-hover);
	}
	.fold {
		border: none;
		background: none;
		color: inherit;
		cursor: pointer;
	}
	.thumb {
		flex: none;
		width: 2.1rem;
		height: 2.1rem;
		border-radius: 0.4rem;
		border: 1px solid var(--border);
		background: var(--bg-raised);
		object-fit: cover;
	}
	.glyph {
		display: grid;
		place-items: center;
		color: var(--text-muted);
	}
	.fmeta {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.fname {
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-decoration: none;
	}
	.fname:hover {
		color: var(--accent);
	}
	.sub {
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	.dl {
		flex: none;
		display: inline-flex;
		color: var(--text-muted);
	}
	.dl:hover {
		color: var(--accent);
	}
	.bin {
		flex: none;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0 0.2rem;
	}
	.bin:hover {
		color: var(--danger);
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		padding: 1.1rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg);
		text-align: center;
	}
	.empty svg {
		color: var(--text-muted);
	}
	.empty p {
		margin: 0;
		font-size: 0.82rem;
		color: var(--text);
	}
	.empty span {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.up:focus-visible,
	.linky:focus-visible,
	.crumb:focus-visible,
	.fold:focus-visible,
	.dl:focus-visible,
	.bin:focus-visible,
	.dropzone:focus-visible,
	.fname:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	/* A narrow panel is a short one: the row keeps its name and its buttons, and
	   gives up the thumbnail and the metadata line rather than wrapping. */
	@media (max-width: 520px) {
		.thumb {
			width: 1.6rem;
			height: 1.6rem;
		}
		.frow {
			padding: 0.4rem 0.5rem;
			gap: 0.4rem;
		}
	}
</style>
