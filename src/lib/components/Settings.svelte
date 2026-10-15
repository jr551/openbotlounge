<script lang="ts">
	import { tick } from 'svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { modalKeydown } from '$lib/modal';
	import { providerById, providerForBaseUrl, PROVIDERS } from '$lib/providers';
	import { byteSize, shortAge, shortAhead } from '$lib/format';
	import { shortTokens } from '$lib/bloat';
	import Avatar from './Avatar.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import MountBrowser from './MountBrowser.svelte';
	import PoliceConsole from './PoliceConsole.svelte';
	import Federation from './Federation.svelte';

	let { open = $bindable(false) }: { open: boolean } = $props();

	/** One entry per bot; `secrets` holds names only, never a value. */
	type BotSecrets = {
		id: string;
		name: string;
		color: string;
		hat: string;
		secrets: { name: string; shared_with: string; created_at: number }[];
	};

	/** The one provider every model call uses; the key itself is never sent to the page. */
	type ProviderCfg = {
		base_url: string;
		/** Whether a key is stored - the key is not, and must not be, readable here. */
		has_key: boolean;
		/** Whether the provider signs in through OAuth rather than a pasted key. */
		oauth: boolean;
	};

	/**
	 * The database's own state, as the settings endpoints report it. The copy is
	 * the safety net under everything else in this dialog, so where it stands is
	 * shown here rather than anywhere louder.
	 */
	type DatabaseState = {
		/** When the last copy was taken, or - when that attempt failed - when it was tried. */
		last_backup_at: number;
		last_backup_bytes: number;
		/** A reason, rather than a flag, so a broken safety net says what broke. */
		backup_error: string;
		recovered_at: number;
		recovered_from: string;
		recovery_seen: boolean;
	};

	let social = $state(true);
	let socialMin = $state(60);
	let defaultModel = $state('');
	let policeModel = $state('');
	/** The vision pick, as a draft: it only moves to the stored value once the
	    server has watched it answer an image. */
	let visionModel = $state('');
	let visionChecking = $state(false);
	let visionNote = $state<Note>({ kind: 'idle', text: '' });
	/** The save in flight: the button says so rather than looking ignored. */
	let saving = $state(false);
	/** Bulk model reset in flight: the button says so rather than looking ignored. */
	let resettingModels = $state(false);
	let botSecrets = $state<BotSecrets[]>([]);
	/**
	 * The tab strip, in order. One source for labels, ids and keyboard order,
	 * so the markup, the roving tabindex and the arrow keys cannot drift apart.
	 */
	const TABS = [
		{ id: 'general', label: 'General' },
		{ id: 'models', label: 'Models' },
		{ id: 'connectors', label: 'Connectors' },
		{ id: 'secrets', label: 'Secrets' },
		{ id: 'files', label: 'Files' },
		{ id: 'routines', label: 'Routines' },
		{ id: 'police', label: 'Police' },
		{ id: 'federation', label: 'Federation' }
	] as const;
	type TabId = (typeof TABS)[number]['id'];
	/** Where the last-used tab is remembered between opens. */
	const TAB_KEY = 'obl.settings.tab';
	let tab = $state<TabId>('general');
	/** The tab a notice asked for, honoured once by the open effect below. */
	let askedTab: TabId | null = null;
	/** The strip itself, so arrow keys can move focus to the tab they select. */
	let tablistEl = $state<HTMLElement | null>(null);
	let filesBotId = $state('');
	/**
	 * Which drive the tree under the files tab shows: 'company', or
	 * `shared:<bot id>`. The company drive is the default because it is the one
	 * every machine has, bots or not.
	 */
	let drivePick = $state('company');
	let padContent = $state('');
	/** The pad as last loaded or saved; the baseline the dirty check compares to. */
	let padSaved = $state('');
	/** Which agent the editor's content came from; a save for another is refused. */
	let padBotId = $state('');
	/** True while the editor holds edits the server has not seen. */
	const padDirty = $derived(padContent !== padSaved);
	let padSaving = $state(false);
	let padNote = $state('');
	let providerCfg = $state<ProviderCfg | null>(null);
	/** Whether each web-search provider has a key stored - the keys never reach the page. */
	let searchKeys = $state<{ exa: boolean; firecrawl: boolean } | null>(null);
	let exaKey = $state('');
	let firecrawlKey = $state('');
	let searchNote = $state<Note>({ kind: 'idle', text: '' });
	let newProvider = $state('');
	let newModel = $state('');
	let newBaseUrl = $state('');
	let newKey = $state('');
	/** Inline answers to the two actions that talk to a provider. */
	type Note = { kind: 'idle' | 'busy' | 'ok' | 'bad'; text: string };
	let testNote = $state<Note>({ kind: 'idle', text: '' });
	let oauthNote = $state<Note>({ kind: 'idle', text: '' });
	/** The capability test's last report and whether a run is in flight. */
	let capability = $state<{ running: boolean; report: CapabilityReport | null }>({
		running: false,
		report: null
	});
	let capabilityBudget = $state(1_000_000);

	type CapabilityCheck = {
		id: string;
		name: string;
		runs: number;
		passed: number;
		samples: { pass: boolean; detail: string }[];
	};
	type CapabilityReport = {
		model: string;
		budget: number;
		tokens_used: number;
		started_at: number;
		finished_at: number;
		checks: CapabilityCheck[];
		verdict: string;
	};

	async function loadCapability() {
		const res = await fetch('/api/capability').catch(() => null);
		if (res?.ok) capability = await res.json();
	}

	async function runCapability() {
		const res = await fetch('/api/capability', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ budget: capabilityBudget })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			capability = { ...capability, running: false };
			testNote = { kind: 'bad', text: body?.message ?? 'The test could not start.' };
			return;
		}
		capability = { ...capability, running: true };
		// Poll until the run lands: the report is the only progress there is.
		const poll = async () => {
			await loadCapability();
			if (capability.running) setTimeout(poll, 3000);
		};
		void poll();
	}
	/**
	 * Store the vision pick, and say what the check made of it. Nothing is
	 * stored unless the model answered the image, so the draft snaps back to the
	 * stored value on a refusal and the note carries the reason.
	 */
	async function confirmVision() {
		visionChecking = true;
		visionNote = { kind: 'busy', text: `asking ${visionModel || 'the police model'} to read a test image…` };
		const result = await chat.saveVisionModel(visionModel);
		visionChecking = false;
		// The drafts and the note both follow what is actually stored: an
		// unconfirmed pick must not sit there looking saved.
		visionModel = chat.visionModel;
		if (!result.ok) {
			visionNote = { kind: 'bad', text: result.detail };
			return;
		}
		visionNote = chat.visionModel
			? {
					kind: 'ok',
					text: `confirmed: this model accepts images${result.detail ? ` - it read the test image as “${result.detail}”` : ''}`
				}
			: { kind: 'ok', text: 'cleared: the police model looks at images instead' };
	}

	/** An in-flight OpenAI device sign-in: the code the human is typing. */
	let deviceFlow = $state<{ id: string; code: string; url: string; interval: number } | null>(
		null
	);
	let dialogEl = $state<HTMLElement | null>(null);
	/** null until the first read answers; the block says so rather than guessing. */
	let database = $state<DatabaseState | null>(null);
	/** The add form, so picking a provider can bring its fields into view. */
	let addFormEl = $state<HTMLElement | null>(null);

	/** The catalogue entry the add form is standing on. */
	const chosen = $derived(newProvider ? providerById(newProvider) : undefined);

	/** The list sits above the form: picking a provider reveals fields below it. */
	$effect(() => {
		if (chosen && addFormEl) addFormEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});

	async function loadSecrets() {
		const res = await fetch('/api/secrets').catch(() => null);
		if (res?.ok) botSecrets = (await res.json()).bots;
	}

	async function forgetSecret(botId: string, name: string) {
		await fetch(`/api/bots/${botId}/secrets/${encodeURIComponent(name)}`, {
			method: 'DELETE'
		}).catch(() => {});
		// Re-read rather than splice, so the list matches what the server kept.
		await loadSecrets();
	}

	/** The ask-a-bot form: which bot, and the name of the secret to ask for. */
	let askBotId = $state('');
	let askName = $state('');
	let askBusy = $state(false);
	/** What the last ask ended in, so a refusal is not silent. */
	let askNote = $state('');

	/** The bot the ask form is pointed at, for the live wording under it. */
	const askBot = $derived(chat.botById(askBotId));

	// The picker starts on the first bot rather than an empty choice, so the
	// form is one field away from usable.
	$effect(() => {
		if (!askBotId && chat.visibleBots.length) askBotId = chat.visibleBots[0].id;
	});

	/**
	 * Ask a bot for a secret. The request goes through the same path the human's
	 * own chat uses - open the bot's direct conversation, then send - so it
	 * lands in that bot's thread as a message it will answer. The bot cannot
	 * invent a secret it does not have, so the words ask it to say what it needs
	 * or to store what the human hands over.
	 */
	async function askForSecret() {
		const bot = askBot;
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
		// The message lands in the bot's own chat, so the dialog gets out of the
		// way and the human sees it there.
		open = false;
	}

	/**
	 * Values a secret's eyeball has fetched, keyed `botId:name`. They are only
	 * ever read on demand - the list itself never carries a value - and a
	 * second click drops the copy the page is holding.
	 */
	let revealed = $state<Record<string, string>>({});

	/** Show a secret's value, or hide it again. Only ever fetched on demand. */
	async function toggleReveal(botId: string, name: string) {
		const key = `${botId}:${name}`;
		if (key in revealed) {
			const next = { ...revealed };
			delete next[key];
			revealed = next;
			return;
		}
		const res = await fetch('/api/secrets', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bot_id: botId, name, reveal: true })
		}).catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (data?.value !== undefined) revealed = { ...revealed, [key]: data.value };
	}
	type ConnectorField = {
		key: string;
		label: string;
		secret: boolean;
		placeholder?: string;
		required: boolean;
	};
	type Connector = {
		plugin_id: string;
		connector: string;
		name: string;
		description: string;
		icon_svg: string;
		enabled: boolean;
		configured: boolean;
		fields: ConnectorField[];
		values: Record<string, string>;
		secrets_set: Record<string, boolean>;
		bots: string[];
		allowed_chats?: { id: string; alias: string }[];
	};

	let connectors = $state<Connector[]>([]);
	/** Editable copies: field values per connector (secrets start blank), bot ids. */
	let connDraft = $state<Record<string, Record<string, string>>>({});
	let connBots = $state<Record<string, string[]>>({});
	let connNote = $state<Record<string, string>>({});
	let connBusy = $state('');
	let qrFor = $state('');
	let qrImage = $state('');
	/** WhatsApp: chats fetched from WAHA plus the ticked allowlist drafts. */
	let waChats = $state<Record<string, { id: string; name: string }[]>>({});
	let connChats = $state<Record<string, { id: string; alias: string }[]>>({});
	/** Tailscale: last reported link state per assigned bot. */
	let tsStatus = $state<Record<string, { online: boolean; ips: string[]; backend: string; detail?: string }>>({});
	/** ElevenLabs: the account's phone numbers, for picking a phone_number_id. */
	let elNumbers = $state<
		Record<
			string,
			{ phone_number_id: string; phone_number: string; label: string; provider: string; assigned_agent: string }[]
		>
	>({});

	async function loadConnectors() {
		const res = await fetch('/api/connectors').catch(() => null);
		if (!res?.ok) return;
		connectors = (await res.json()).installed;
		const drafts: Record<string, Record<string, string>> = {};
		const bots: Record<string, string[]> = {};
		for (const c of connectors) {
			drafts[c.plugin_id] = { ...c.values };
			// Secret fields stay blank: the server masks them, and a blank save
			// keeps the stored value rather than wiping it.
			for (const f of c.fields) if (f.secret) drafts[c.plugin_id][f.key] = '';
			bots[c.plugin_id] = [...c.bots];
		}
		connDraft = drafts;
		connBots = bots;
		const chats: Record<string, { id: string; alias: string }[]> = {};
		for (const c of connectors) chats[c.plugin_id] = [...(c.allowed_chats ?? [])];
		connChats = chats;
	}

	async function saveConnector(c: Connector) {
		connBusy = c.plugin_id;
		const res = await fetch(`/api/connectors/${c.plugin_id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				values: connDraft[c.plugin_id] ?? {},
				bots: connBots[c.plugin_id] ?? [],
				allowed_chats: connChats[c.plugin_id] ?? []
			})
		}).catch(() => null);
		connBusy = '';
		if (res?.ok) {
			connNote = { ...connNote, [c.plugin_id]: 'Saved.' };
		} else {
			const body = await res?.json().catch(() => null);
			connNote = { ...connNote, [c.plugin_id]: body?.message ?? 'Could not save.' };
		}
		await loadConnectors();
	}

	async function toggleConnector(c: Connector, enabled: boolean) {
		const res = await fetch(`/api/connectors/${c.plugin_id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			connNote = { ...connNote, [c.plugin_id]: body?.message ?? 'Could not change that.' };
		}
		await loadConnectors();
	}

	function toggleConnBot(pluginId: string, botId: string) {
		const list = connBots[pluginId] ?? [];
		connBots = {
			...connBots,
			[pluginId]: list.includes(botId) ? list.filter((b) => b !== botId) : [...list, botId]
		};
	}

	/** WhatsApp pairing: the server starts the WAHA session and hands back a QR. */
	async function connectQr(c: Connector) {
		connBusy = c.plugin_id;
		qrFor = '';
		qrImage = '';
		const res = await fetch(`/api/connectors/${c.plugin_id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'connect' })
		}).catch(() => null);
		connBusy = '';
		const data = res?.ok ? await res.json().catch(() => null) : null;
		if (!data) {
			connNote = { ...connNote, [c.plugin_id]: 'Could not reach the WAHA server.' };
			return;
		}
		if (data.qr) {
			qrFor = c.plugin_id;
			qrImage = data.qr;
		} else {
			connNote = {
				...connNote,
				[c.plugin_id]:
					data.status === 'WORKING'
						? 'Connected — the session is live.'
						: `Status: ${data.status}${data.detail ? ' — ' + data.detail : ''}`
			};
		}
	}

	/** WhatsApp: pull the session's chat list for the allowlist picker. */
	async function loadWaChats(c: Connector) {
		connBusy = c.plugin_id;
		const res = await fetch(`/api/connectors/${c.plugin_id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'chats' })
		}).catch(() => null);
		connBusy = '';
		const data = res?.ok ? await res.json().catch(() => null) : null;
		if (!data) {
			const body = await res?.json().catch(() => null);
			connNote = { ...connNote, [c.plugin_id]: body?.message ?? 'Could not load chats.' };
			return;
		}
		waChats = { ...waChats, [c.plugin_id]: data.chats ?? [] };
	}

	function toggleWaChat(pluginId: string, chatId: string) {
		const list = connChats[pluginId] ?? [];
		connChats = {
			...connChats,
			[pluginId]: list.some((c) => c.id === chatId)
				? list.filter((c) => c.id !== chatId)
				: [...list, { id: chatId, alias: '' }]
		};
	}

	/** Tailscale: join (or just report) the picked bot's machine. */
	async function tailscaleJoin(c: Connector, botId: string, join: boolean) {
		connBusy = c.plugin_id;
		const res = await fetch(`/api/connectors/${c.plugin_id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: join ? 'join' : 'status', bot_id: botId })
		}).catch(() => null);
		connBusy = '';
		const data = res?.ok ? await res.json().catch(() => null) : null;
		if (!data) {
			const body = await res?.json().catch(() => null);
			connNote = { ...connNote, [c.plugin_id]: body?.message ?? 'Could not reach the machine.' };
			return;
		}
		tsStatus = { ...tsStatus, [`${c.plugin_id}:${botId}`]: data };
	}

	/** ElevenLabs: list the account's numbers so a phone_number_id can be picked. */
	async function loadElNumbers(c: Connector) {
		connBusy = c.plugin_id;
		const res = await fetch(`/api/connectors/${c.plugin_id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'numbers' })
		}).catch(() => null);
		connBusy = '';
		const data = res?.ok ? await res.json().catch(() => null) : null;
		if (!data) {
			const body = await res?.json().catch(() => null);
			connNote = { ...connNote, [c.plugin_id]: body?.message ?? 'Could not list numbers.' };
			return;
		}
		elNumbers = { ...elNumbers, [c.plugin_id]: data.numbers ?? [] };
	}

	/** The agent's scratchpad, as the file the backend keeps it in. */
	async function loadPad() {
		const botId = filesBotId;
		if (!botId) {
			padContent = '';
			padSaved = '';
			return;
		}
		const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/scratchpad`).catch(() => null);
		// A slow read that lands after the human moved on must not paint the
		// previous agent's notes over the one now on screen.
		if (botId !== filesBotId) return;
		padBotId = botId;
		if (!res?.ok) {
			padContent = '';
			padSaved = '';
			return;
		}
		const data = await res.json();
		padContent = data.content ?? '';
		padSaved = padContent;
	}

	/** Save the pad as the human; the bot is handed the diff on its next turn. */
	async function savePad() {
		const botId = filesBotId;
		if (!botId || padSaving) return;
		// The editor may still be showing the previous agent's notes while the
		// new one loads; saving now would write them onto the wrong agent.
		if (padBotId && padBotId !== botId) {
			padNote = 'Still loading this agent’s scratchpad — try again in a moment.';
			return;
		}
		padSaving = true;
		padNote = '';
		const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/scratchpad`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: padContent })
		}).catch(() => null);
		padSaving = false;
		if (botId !== filesBotId) {
			// The human switched agents mid-save. The write landed on the agent
			// it was started for, but the pad on screen is a different one now,
			// so refreshing it here would show the wrong notes - say what
			// happened instead of returning silently.
			padNote = res?.ok
				? 'Saved to the agent this was started for; the pad now shows another.'
				: 'The save did not finish before the agent changed.';
			return;
		}
		if (res?.ok) {
			padNote = 'Saved - the agent will see what changed.';
			await loadPad();
		} else {
			padNote = 'Could not save the scratchpad.';
		}
	}

	/**
	 * The agent picker. Switching away from unsaved edits would silently drop
	 * them (the reload below overwrites the editor), so confirm first and put
	 * the select back if the human says no.
	 */
	function onPickBot(e: Event) {
		const el = e.currentTarget as HTMLSelectElement;
		const next = el.value;
		if (next === filesBotId) return;
		if (padDirty && !confirm(`Discard unsaved changes to ${pickBot?.name ?? 'this agent'}'s scratchpad?`)) {
			el.value = filesBotId;
			return;
		}
		padNote = '';
		filesBotId = next;
	}
	/** The backup's standing and any restore that happened, re-read per open. */
	async function loadDatabase() {
		const res = await fetch('/api/settings').catch(() => null);
		if (res?.ok) database = (await res.json()).database;
	}

	/**
	 * The six whole-app looks. The default ('') is no override at all — :root
	 * carries it — so switching back clears data-theme rather than restyling.
	 */
	const THEMES = [
		{ id: '', label: 'Default', accent: '#3a7bd5' },
		{ id: 'midnight', label: 'Midnight', accent: '#5b8cff' },
		{ id: 'forest', label: 'Forest', accent: '#4ade80' },
		{ id: 'sunset', label: 'Sunset', accent: '#fb923c' },
		{ id: 'lavender', label: 'Lavender', accent: '#c084fc' },
		{ id: 'mono', label: 'Mono', accent: '#e5e5e5' }
	] as const;

	/** A scheduled routine plus the runs the task tray still holds for it. */
	type Routine = {
		id: string;
		bot_id: string;
		name: string;
		prompt: string;
		interval_min: number;
		cron?: string;
		next_run_at: number;
		enabled: number;
		paused_reason?: string;
		/** The police's sign-off on the routine, as JSON; '' = never reviewed. */
		verification?: string;
		created_at: number;
	};
	type RoutineTask = {
		id: string;
		prompt: string;
		kind?: string;
		status: string;
		error: string;
		finished_at: number;
	};
	let routines = $state<Routine[]>([]);
	let routineTasks = $state<RoutineTask[]>([]);
	/** Which routine's detail is open; at most one, so long histories stay readable. */
	let openRoutine = $state('');
	let routinesNote = $state('');

	/** Every routine with its runs, re-read when the tab opens. */
	async function loadRoutines() {
		routinesNote = '';
		const [rRes, tRes] = await Promise.all([
			fetch('/api/routines').catch(() => null),
			fetch('/api/tasks').catch(() => null)
		]);
		if (rRes?.ok) routines = (await rRes.json()).routines ?? [];
		else routinesNote = 'Could not load routines.';
		// The tray keeps running work plus recently finished; the routine's own
		// runs are the kind==='routine' ones whose prompt carries its marker.
		if (tRes?.ok) {
			const all = (await tRes.json()).tasks ?? [];
			routineTasks = all.filter((t: RoutineTask) => t.kind === 'routine');
		} else routineTasks = [];
	}

	/** The tray's surviving runs for one routine, newest first, capped at ten. */
	function runsFor(name: string): RoutineTask[] {
		const marker = `[Routine: ${name}]`;
		return routineTasks
			.filter((t) => t.prompt.includes(marker))
			.sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))
			.slice(0, 10);
	}

	/** A routine's schedule in the row's own words: cron, or every N minutes. */
	function scheduleOf(r: Routine): string {
		return r.cron?.trim() ? r.cron : `every ${r.interval_min}m`;
	}

	/**
	 * The police's verdict on a routine, read back from the row's JSON; null
	 * means it was never reviewed (or the row predates the gate).
	 */
	function routineVerdict(r: Routine): { verdict: string; reason: string; by?: string } | null {
		if (!r.verification) return null;
		try {
			const v = JSON.parse(r.verification) as { verdict?: string; reason?: string; by?: string };
			return v.verdict === 'approved' || v.verdict === 'rejected' || v.verdict === 'unreviewed'
				? { verdict: v.verdict, reason: v.reason ?? '', by: v.by }
				: null;
		} catch {
			return null;
		}
	}

	/** Flip a routine on or off; the row stays as it was if the write fails. */
	async function toggleRoutine(r: Routine, enabled: boolean) {
		const res = await fetch(`/api/routines/${encodeURIComponent(r.id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled })
		});
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			routinesNote = body?.message ?? 'Could not change that.';
			return;
		}
		r.enabled = enabled ? 1 : 0;
	}


	async function loadProvider() {
		const res = await fetch('/api/settings').catch(() => null);
		if (!res?.ok) return;
		const body = await res.json();
		providerCfg = body.provider ?? null;
		searchKeys = {
			exa: !!body.exa?.has_key,
			firecrawl: !!body.firecrawl?.has_key
		};
	}

	/**
	 * Store the web-search keys. An empty field means "keep the stored key",
	 * like the provider key: the saved value is never shown, so posting it
	 * blank would wipe it on every unrelated save.
	 */
	async function saveSearchKeys() {
		const body: Record<string, string> = {};
		if (exaKey.trim()) body.exa_api_key = exaKey.trim();
		if (firecrawlKey.trim()) body.firecrawl_api_key = firecrawlKey.trim();
		if (!Object.keys(body).length) {
			searchNote = { kind: 'bad', text: 'Nothing to save - paste a key first.' };
			return;
		}
		const res = await fetch('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}).catch(() => null);
		if (res?.ok) {
			exaKey = '';
			firecrawlKey = '';
			searchNote = { kind: 'ok', text: 'Saved.' };
		} else {
			const data = await res?.json().catch(() => null);
			searchNote = { kind: 'bad', text: data?.message ?? 'The keys could not be saved.' };
		}
		await loadProvider();
	}

	/** Picking a provider fills in its endpoint and offers its models. */
	function pickProvider(id: string) {
		const provider = providerById(id);
		if (!provider) return;
		newProvider = provider.id;
		newBaseUrl = provider.baseUrl;
		newModel = provider.models[0] ?? '';
		checkedModel = '';
		newKey = '';
		testNote = { kind: 'idle', text: '' };
		oauthNote = { kind: 'idle', text: '' };
	}

	function resetAddForm() {
		newProvider = '';
		newModel = '';
		checkedModel = '';
		newBaseUrl = '';
		newKey = '';
		deviceFlow = null;
		testNote = { kind: 'idle', text: '' };
		oauthNote = { kind: 'idle', text: '' };
	}

	/**
	 * The model check runs on its own when the model field changes - there is
	 * no button for it. The cheapest real probe lives in /api/providers/check:
	 * a model listing first, a one-token completion only when the endpoint has
	 * no listing. The answer is a toast, not a line under the form.
	 */
	let checkToast = $state<Note>({ kind: 'idle', text: '' });
	let checkTimer: ReturnType<typeof setTimeout> | null = null;
	function toastCheck(kind: Note['kind'], text: string) {
		checkToast = { kind, text };
		if (checkTimer) clearTimeout(checkTimer);
		if (kind !== 'busy') checkTimer = setTimeout(() => (checkToast = { kind: 'idle', text: '' }), 4000);
	}

	/** The model the last check ran against, so a reselect of the same value is not rechecked. */
	let checkedModel = $state('');
	async function checkModel() {
		const model = newModel.trim();
		const baseUrl = newBaseUrl.trim();
		if (!model || !baseUrl || model === checkedModel) return;
		checkedModel = model;
		toastCheck('busy', `Checking ${model}…`);
		const res = await fetch('/api/providers/check', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ base_url: baseUrl, model, api_key: newKey.trim() })
		}).catch(() => null);
		const data = res?.ok ? await res.json().catch(() => null) : null;
		if (!data?.message) {
			toastCheck('bad', 'The check could not run. Try again.');
			return;
		}
		toastCheck(data.ok ? 'ok' : 'bad', data.message);
	}



	/**
	 * OpenRouter's PKCE sign-in. The window is opened on the click itself,
	 * because one opened after an await is what pop-up blockers refuse. Only the
	 * authorize URL reaches the browser: the key OpenRouter issues arrives at
	 * the server-side callback and is stored there.
	 */
	async function connectOpenRouter() {
		const popup = window.open('', 'obl-openrouter', 'width=560,height=760');
		oauthNote = { kind: 'busy', text: 'Waiting for OpenRouter…' };
		const res = await fetch('/api/providers/oauth/openrouter/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: newModel.trim() })
		}).catch(() => null);
		const data = res?.ok ? await res.json().catch(() => null) : null;
		if (!data?.authorize_url) {
			popup?.close();
			oauthNote = { kind: 'bad', text: 'Could not start the OpenRouter sign-in. Try again.' };
			return;
		}
		if (!popup) {
			oauthNote = {
				kind: 'bad',
				text: 'This browser blocked the sign-in window. Allow pop-ups for this site and try again.'
			};
			return;
		}
		popup.location.href = data.authorize_url;
	}

	/**
	 * OpenAI's device-code sign-in, the same flow Codex CLI and opencode use.
	 * There is no redirect back here: the server hands the page a code, the
	 * human types it at auth.openai.com, and the status route polls until
	 * OpenAI issues the tokens - which are stored server-side and never reach
	 * this page.
	 */
	async function connectChatGPT() {
		// Opened on the click itself, like the OpenRouter flow: a window opened
		// after an await is what pop-up blockers refuse. The code is also shown
		// inline, so a blocked window is not fatal.
		const popup = window.open('', 'obl-openai', 'width=560,height=760');
		oauthNote = { kind: 'busy', text: 'Asking OpenAI for a sign-in code…' };
		const res = await fetch('/api/providers/oauth/openai/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: newModel.trim() })
		}).catch(() => null);
		const data = res?.ok ? await res.json().catch(() => null) : null;
		if (!data?.flow_id) {
			popup?.close();
			oauthNote = {
				kind: 'bad',
				text: data?.error ?? 'Could not start the OpenAI sign-in. Try again.'
			};
			return;
		}
		deviceFlow = {
			id: data.flow_id,
			code: data.user_code,
			url: data.verification_url,
			interval: data.interval
		};
		if (popup) popup.location.href = data.verification_url;
		oauthNote = { kind: 'busy', text: 'Waiting for the sign-in to finish…' };
		// Poll until the status route stops answering 'pending'. The flow id is
		// captured: a cancel or a second attempt must not let an old poll write
		// over the new state.
		const flowId = data.flow_id;
		for (;;) {
			await new Promise((r) => setTimeout(r, Math.max(data.interval ?? 5, 1) * 1000));
			if (deviceFlow?.id !== flowId) return;
			const sres = await fetch('/api/providers/oauth/openai/status', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ flow_id: flowId })
			}).catch(() => null);
			const sdata = sres ? await sres.json().catch(() => null) : null;
			if (sdata?.status === 'pending') continue;
			deviceFlow = null;
			if (sdata?.status === 'connected') {
				resetAddForm();
				oauthNote = {
					kind: 'ok',
				text: 'Connected — the provider now holds your ChatGPT sign-in.'
				};
				await loadProvider();
			} else {
				oauthNote = {
					kind: 'bad',
					text: sdata?.error ?? 'The sign-in did not complete. Try again.'
				};
			}
			return;
		}
	}

	function cancelDeviceFlow() {
		deviceFlow = null;
		oauthNote = { kind: 'idle', text: '' };
	}

	async function saveProvider() {
		// An empty key field means "keep the stored key", not "store nothing":
		// the field never shows the saved value, so sending it blank would wipe
		// the key every time the provider is re-saved.
		const body: Record<string, string> = {
			provider_base_url: newBaseUrl.trim(),
			default_model: newModel.trim()
		};
		if (newKey.trim()) body.provider_api_key = newKey.trim();
		const res = await fetch('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}).catch(() => null);
		if (res?.ok) {
			resetAddForm();
		} else {
			// A refused save must say so, not leave the form filled and silent.
			const body = await res?.json().catch(() => null);
			testNote = { kind: 'bad', text: body?.message ?? 'The provider could not be saved.' };
		}
		await loadProvider();
	}

	/** The tab the last open left on, if it is still one of ours. */
	function readStoredTab(): TabId {
		try {
			const v = localStorage.getItem(TAB_KEY);
			if (v && TABS.some((t) => t.id === v)) return v as TabId;
		} catch {
			// Private mode or storage disabled: fall back to the first tab.
		}
		return 'general';
	}

	function persistTab(id: TabId) {
		try {
			localStorage.setItem(TAB_KEY, id);
		} catch {
			// Nothing to do: remembering the tab is a convenience, not state.
		}
	}

	/** Select a tab, remember it, and (for keyboard moves) keep focus on it. */
	function selectTab(id: TabId, focus = false) {
		tab = id;
		persistTab(id);
		if (focus) tablistEl?.querySelector<HTMLElement>(`#tab-${id}`)?.focus();
	}

	/**
	 * Arrow keys walk the strip, Home/End jump to its ends. Selection follows
	 * focus (the standard automatic-activation pattern), so one key press both
	 * moves and opens the tab.
	 */
	function onTablistKeydown(e: KeyboardEvent) {
		const at = TABS.findIndex((t) => t.id === tab);
		let next = at;
		if (e.key === 'ArrowRight') next = (at + 1) % TABS.length;
		else if (e.key === 'ArrowLeft') next = (at - 1 + TABS.length) % TABS.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = TABS.length - 1;
		else return;
		e.preventDefault();
		selectTab(TABS[next].id, true);
	}

	$effect(() => {
		if (open) {
			// A notice can ask for the Police tab; that lands here so the reset
			// below cannot take the tab back off the human. Otherwise the tab
			// the last open left on is restored.
			tab = askedTab ?? readStoredTab();
			askedTab = null;
			persistTab(tab);
			social = chat.social;
			socialMin = chat.socialIntervalMin;
			defaultModel = chat.defaultModel;
			policeModel = chat.policeModel;
			// The vision pick starts on what is stored, and the last check's
			// answer is not carried over as if it were this visit's.
			visionModel = chat.visionModel;
			visionNote = { kind: 'idle', text: '' };
			resetAddForm();
			loadSecrets();
			loadProvider();
			loadDatabase();
			loadConnectors();
			loadCapability();
		}
	});

	/**
	 * The police notice is outside this dialog, so it asks for the log through
	 * the window rather than a prop: the tab opens itself when the human follows
	 * a notice in.
	 */
	$effect(() => {
		function onOpenPolice() {
			askedTab = 'police';
			open = true;
		}
		window.addEventListener('obl:police-log', onOpenPolice);
		return () => window.removeEventListener('obl:police-log', onOpenPolice);
	});

	/**
	 * The OpenRouter callback posts this word once the key has been stored; the
	 * list then re-reads from the server, so the new key appears without the
	 * page ever having seen it.
	 */
	$effect(() => {
		function onOAuthDone(e: MessageEvent) {
			if (e.origin !== location.origin || e.data !== 'obl-oauth-done') return;
			resetAddForm();
			oauthNote = { kind: 'ok', text: 'Connected — the provider holds the key OpenRouter issued.' };
			void loadProvider();
		}
		window.addEventListener('message', onOAuthDone);
		return () => window.removeEventListener('message', onOAuthDone);
	});

	/**
	 * Opening the dialog lands focus on the active tab, and every later tab
	 * change keeps it there - so the keyboard is always on the strip, never
	 * lost behind the dialog.
	 */
	$effect(() => {
		if (!open) return;
		const active = tab;
		void tick().then(() => {
			const el = tablistEl?.querySelector<HTMLElement>(`#tab-${active}`);
			(el ?? dialogEl)?.focus();
		});
	});

	/** The agent whose files and scratchpad are on screen. */
	const pickBot = $derived(chat.visibleBots.find((b) => b.id === filesBotId));

	$effect(() => {
		if (!open || tab !== 'files') return;
		// The picker always stands on a real agent: the first one when the tab
		// is opened, and another if the chosen one was deleted in the meantime.
		if (!chat.visibleBots.some((b) => b.id === filesBotId)) {
			filesBotId = chat.visibleBots[0]?.id ?? '';
			padNote = '';
		}
		void loadPad();
	});

	$effect(() => {
		// Fresh each visit: a routine fires while the dialog sits open.
		if (!open || tab !== 'routines') return;
		void loadRoutines();
	});

	/** Drop the session server-side, then go to the login page. */
	async function signOut() {
		await fetch('/api/logout', { method: 'POST' }).catch(() => {});
		location.href = '/login';
	}

	async function save() {
		if (saving) return;
		saving = true;
		// A refused save keeps the dialog open with the reason showing, instead
		// of closing over a value that was never stored.
		if (await chat.saveSettings({ social, social_interval_min: socialMin, default_model: defaultModel, police_model: policeModel })) {
			open = false;
		}
		saving = false;
	}

	/** Point every bot at the model in the Default select. */
	async function resetAllModels() {
		if (resettingModels || !defaultModel) return;
		resettingModels = true;
		try {
			await Promise.all(
				chat.visibleBots
					.filter((b) => !b.archived && b.model !== defaultModel)
					.map((b) =>
						fetch(`/api/bots/${b.id}`, {
							method: 'PATCH',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ model: defaultModel })
						}).catch(() => null)
					)
			);
			await chat.refreshBots();
		} finally {
			resettingModels = false;
		}
	}


	function onWindowKeydown(e: KeyboardEvent) {
		if (open) modalKeydown(e, dialogEl, () => (open = false));
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<div
		class="overlay"
		role="presentation"
		onclick={(e) => {
			// Only a click on the backdrop itself dismisses; the dialog stops
			// propagation, so anything inside it never reaches here.
			if (e.target === e.currentTarget) open = false;
		}}
	>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
			tabindex="-1"
			bind:this={dialogEl}
		>
			<header>
				<h2 id="settings-title">Settings</h2>
				<button class="x" title="Close" aria-label="Close" onclick={() => (open = false)}>✕</button>
			</header>

			<div
				class="tabs"
				role="tablist"
				aria-label="Settings sections"
				aria-orientation="horizontal"
				tabindex="-1"
				bind:this={tablistEl}
				onkeydown={onTablistKeydown}
			>
				{#each TABS as t (t.id)}
					<button
						id={`tab-${t.id}`}
						class="tab"
						class:sel={tab === t.id}
						role="tab"
						aria-selected={tab === t.id}
						aria-controls={`panel-${t.id}`}
						tabindex={tab === t.id ? 0 : -1}
						onclick={() => selectTab(t.id)}
					>
						{t.label}
					</button>
				{/each}
			</div>
			<div class="body">
				{#if tab === 'general'}
					<div class="panel" role="tabpanel" id="panel-general" aria-labelledby="tab-general">
						<section class="sect">
							<h3>Behaviour</h3>
							<label class="field">
								<span class="flabel">Bot socialising</span>
								<button class="tog" class:on={social} onclick={() => (social = !social)}>
									{social ? 'On' : 'Off'}
								</button>
							</label>
							<p class="hint">Bots chat among themselves in a shared "Lounge" group on a schedule.</p>

							{#if social}
								<label class="field">
									<span class="flabel">Interval (minutes)</span>
									<input type="number" min="5" bind:value={socialMin} />
								</label>
							{/if}

							<label class="field">
								<span class="flabel">Default model</span>
								<div class="modelrow">
									<select bind:value={defaultModel}>
										{#each chat.models as m}
											<option value={m}>{m}</option>
										{/each}
										{#if defaultModel && !chat.models.includes(defaultModel)}
											<!-- A stored model the provider no longer lists still shows
											as itself, not a blank that a save would silently overwrite. -->
											<option value={defaultModel}>{defaultModel}</option>
										{/if}
									</select>
									<button
										class="mini"
										title="Set every bot's model to this one"
										disabled={!defaultModel || resettingModels}
										onclick={resetAllModels}
									>
										{resettingModels ? 'Resetting…' : 'Reset all to this'}
									</button>
								</div>
							</label>
							<p class="hint">Per-bot model overrides live in each bot's edit dialog.</p>

							<label class="field">
								<span class="flabel">Police model</span>
								<select bind:value={policeModel}>
									<option value="">Same as default</option>
									{#each chat.models as m}
										<option value={m}>{m}</option>
									{/each}
									{#if policeModel && !chat.models.includes(policeModel)}
										<option value={policeModel}>{policeModel}</option>
									{/if}
								</select>
							</label>
							<p class="hint">The model the police round reviews with; empty uses the default.</p>

							<label class="field">
								<span class="flabel">Vision model</span>
								<div class="visionrow">
									<select bind:value={visionModel}>
										<option value="">Same as the police model</option>
										{#each chat.models as m}
											<option value={m}>{m}</option>
										{/each}
										{#if visionModel && !chat.models.includes(visionModel)}
											<option value={visionModel}>{visionModel}</option>
										{/if}
									</select>
									<button class="makedef" disabled={visionChecking} onclick={confirmVision}>
										{visionChecking ? 'Checking…' : 'Confirm'}
									</button>
								</div>
							</label>
							<p class="hint">
								The model that looks at screenshots when a bot's own model cannot. It is
								stored only after it answers a test image - Confirm asks it to read one, and
								a model that cannot see stays unsaved.
							</p>
							{#if visionNote.kind !== 'idle'}
								<p class="probe {visionNote.kind}" role="status">{visionNote.text}</p>
							{/if}
						</section>

						<section class="sect">
							<h3>Appearance</h3>
							<p class="hint">The whole app repaints at once; the choice is kept across reloads.</p>
							<div class="themegrid" role="radiogroup" aria-label="App theme">
								{#each THEMES as t (t.id || 'default')}
									<button
										class="theme"
										class:sel={chat.theme === t.id}
										role="radio"
										aria-checked={chat.theme === t.id}
										title={t.label}
										onclick={() => chat.setTheme(t.id)}
									>
										<span class="dot" style={`background:${t.accent}`} aria-hidden="true"></span>
										{t.label}
									</button>
								{/each}
							</div>
							{#if chat.error}<p class="hint">{chat.error}</p>{/if}
						</section>

						{#if !chat.dockerAvailable}
							<section class="sect">
								<h3>Machines</h3>
								<p class="dbstate err">
									Docker is not reachable - bots cannot start computers, terminals or
									desktops until the daemon is up and the app can see its socket.
								</p>
							</section>
						{/if}

						<section class="sect">
							<h3>Session</h3>
							<p class="hint">
								Signing out ends this browser's session. You will need the shared password to
								get back in.
							</p>
							<button class="ghost signout" onclick={signOut}>
								<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17l5-5-5-5M20 12H9M12 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/></svg>
								Sign out
							</button>
						</section>

						{#if database}
							<section class="sect">
								<h3>Database backup</h3>
								{#if database.backup_error}
									<p class="dbstate err">
										The last backup attempt failed: {database.backup_error}
										{#if database.last_backup_at}<span class="sub">(tried {shortAge(database.last_backup_at)})</span>{/if}
									</p>
									{#if database.last_backup_bytes}
										<p class="hint">
											The copy taken the night before is still in place
											({byteSize(database.last_backup_bytes)}); a failed attempt never overwrites it.
										</p>
									{:else}
										<p class="hint">
											No copy has been taken yet, so nothing stands behind the database until one
											succeeds.
										</p>
									{/if}
								{:else if database.last_backup_at}
									<p class="dbstate">
										Last copy taken {shortAge(database.last_backup_at)}
										<span class="sub">· {byteSize(database.last_backup_bytes)}</span>
									</p>
									<p class="hint">
										A fresh copy is taken once a day; if the database is ever damaged, this is
										what replaces it.
									</p>
								{:else}
									<p class="hint">
										No copy yet. The first one is taken automatically within a minute of the
										server starting, and then once a day.
									</p>
								{/if}
								{#if database.recovered_at}
									<p class="hint">
										The database was restored {shortAge(database.recovered_at)}; the damaged file was
										kept at <span class="dbpath">{database.recovered_from}</span>.
									</p>
								{/if}
							</section>
						{/if}
					</div>
				{/if}

				{#if tab === 'models'}
					<div class="panel" role="tabpanel" id="panel-models" aria-labelledby="tab-models">
						<section class="sect">
							<h3>Provider</h3>
							{#if providerCfg}
								{@const mark = providerForBaseUrl(providerCfg.base_url)}
								<div class="providerrow">
									<span class="mark" style={`--tint:${mark?.tint ?? '#8a8a93'}`}>
										{mark?.mark ?? '·'}
									</span>
									<div class="pmeta">
										<span class="pname" title={providerCfg.base_url}>
											{mark?.name ?? 'Custom provider'}
										</span>
										<span class="subline">
											<span class="pmodel" title={providerCfg.base_url}>{providerCfg.base_url}</span>
											{#if providerCfg.oauth}
												<span class="keychip" title="Signed in through OAuth">Signed in</span>
											{:else if providerCfg.has_key}
												<span class="keychip" title="An API key is stored">Key</span>
											{/if}
										</span>
									</div>
								</div>
							{:else}
								<span class="none">Loading…</span>
							{/if}
							<p class="hint">
								Every bot calls this provider; a bot's edit dialog can still override the model.
							</p>
						</section>

						<section class="sect">
							<h3>Web search</h3>
							<p class="hint">
								The search_web tool asks Exa first and falls back to Firecrawl when Exa has no
								key or cannot answer. Either key works on its own; with both, Exa wins.
							</p>
							<div class="providerform">
								<label>
									Exa API key {#if searchKeys?.exa}<span class="keychip" title="An API key is stored">Key</span>{/if}
									<input
										type="password"
										autocomplete="off"
										placeholder={searchKeys?.exa ? 'Stored - paste to replace' : 'Paste the key from exa.ai'}
										bind:value={exaKey}
										/>
								</label>
								<label>
									Firecrawl API key (failover)
									{#if searchKeys?.firecrawl}<span class="keychip" title="An API key is stored">Key</span>{/if}
									<input
										type="password"
										autocomplete="off"
										placeholder={searchKeys?.firecrawl ? 'Stored - paste to replace' : 'Paste the key from firecrawl.dev'}
										bind:value={firecrawlKey}
										/>
									<span class="fieldhint">Kept on the server; keys are never sent back to this page.</span>
								</label>
								<button
									class="add"
									disabled={!exaKey.trim() && !firecrawlKey.trim()}
									onclick={saveSearchKeys}
									>
									Save
								</button>
								{#if searchNote.kind !== 'idle'}
									<p class="probe {searchNote.kind}">{searchNote.text}</p>
								{/if}
							</div>
						</section>

						<section class="sect">
							<h3>{providerCfg ? 'Change provider' : 'Set up a provider'}</h3>
							<div class="providers">
								{#each PROVIDERS as provider (provider.id)}
									<button
										class="prov"
										class:sel={newProvider === provider.id}
										title={provider.note}
										onclick={() => pickProvider(provider.id)}
										>
										<span class="mark" style={`--tint:${provider.tint}`}>{provider.mark}</span>
										<span class="provname">{provider.name}</span>
									</button>
								{/each}
							</div>

							{#if chosen}
								<p class="hint">{chosen.note}</p>
								<div class="providerform" bind:this={addFormEl}>
									<label>
										Base URL
										<input
											placeholder={chosen.basePlaceholder ?? 'https://api.example.com/v1'}
											bind:value={newBaseUrl}
											/>
										<span class="fieldhint">Include the /v1 path.</span>
									</label>
									<label>
										Model
										<input list="provider-models" placeholder="e.g. glm-5.3" bind:value={newModel} onchange={checkModel} />
										{#if chosen.models.length}
											<span class="fieldhint">
												Suggestions come from {chosen.name}'s own docs; any model id works.
											</span>
										{/if}
									</label>
									<datalist id="provider-models">
										{#each chosen.models as m (m)}
											<option value={m}></option>
										{/each}
									</datalist>

									{#if chosen.auth === 'oauth'}
										{#if deviceFlow}
											<div class="deviceflow">
												<span class="dflabel">Type this code at OpenAI:</span>
												<code class="dfcode">{deviceFlow.code}</code>
												<a class="dfurl" href={deviceFlow.url} target="_blank" rel="noopener">
													{deviceFlow.url}
												</a>
												<button class="makedef" onclick={cancelDeviceFlow}>Cancel</button>
											</div>
										{:else}
											<button
												class="add"
												disabled={!newModel.trim() || oauthNote.kind === 'busy'}
												onclick={chosen.id === 'chatgpt' ? connectChatGPT : connectOpenRouter}
												>
												Sign in with {chosen.name}
											</button>
										{/if}
									{:else}
										<label>
											API key {chosen.id === 'custom' ? '(optional)' : ''}
											<input
												type="password"
												autocomplete="off"
												placeholder={chosen.id === 'custom'
												? 'Usually not needed on a local server'
												: 'Paste the key from the provider'}
												bind:value={newKey}
												/>
											<span class="fieldhint">Kept on the server; it is never sent back to this page.</span>
										</label>
										<button
											class="add"
											disabled={!newModel.trim() || !newBaseUrl.trim()}
											onclick={saveProvider}
											>
											Save
										</button>
									{/if}
								</div>
							{:else}
								<p class="hint">
									Pick a provider to fill in its endpoint, or Custom for anything else.
								</p>
							{/if}

							{#if checkToast.kind !== 'idle'}
								<div class="checktoast {checkToast.kind}" role="status">{checkToast.text}</div>
							{/if}
							{#if testNote.kind !== 'idle'}
								<p class="probe {testNote.kind}">{testNote.text}</p>
							{/if}
							{#if oauthNote.kind !== 'idle'}
								<p class="probe {oauthNote.kind}">{oauthNote.text}</p>
							{/if}
						</section>

						{#if providerCfg}
							<section class="sect">
								<h3>Capability test</h3>
								<p class="hint">
									Run the battery against the configured model: instruction following, JSON,
									tool use, arithmetic, hallucination resistance, multi-step reasoning and a
									needle in a long context. Each check repeats until the token budget is
									spent, so the report is a pass rate rather than one lucky answer.
								</p>
								<div class="caprow">
									<label class="capbudget">
										Token budget
										<input
											type="number"
											min="1000"
											step="1000"
											bind:value={capabilityBudget}
											disabled={capability.running}
											/>
									</label>
									<button class="makedef" disabled={capability.running} onclick={runCapability}>
										{capability.running ? 'Running…' : 'Run the test'}
									</button>
								</div>
								{#if capability.report}
									{@const r = capability.report}
									<p class="capverdict {r.verdict}">
										{r.model}: {r.verdict} - {shortTokens(r.tokens_used)} tokens,
										{new Date(r.finished_at).toLocaleString()}
									</p>
									<div class="capchecks">
										{#each r.checks as c (c.id)}
											<div class="capcheck">
												<span class="capname">{c.name}</span>
												<span class="caprate" class:bad={c.runs > 0 && c.passed / c.runs < 0.5}>
													{c.passed}/{c.runs}
												</span>
												<span class="capbar">
													<span
														class="capfill"
														style:width="{c.runs ? (c.passed / c.runs) * 100 : 0}%"
														></span>
												</span>
											</div>
										{/each}
									</div>
								{/if}
							</section>
						{/if}
					</div>
				{/if}


				{#if tab === 'connectors'}
					<div class="panel" role="tabpanel" id="panel-connectors" aria-labelledby="tab-connectors">
						{#if connectors.length === 0}
							<div class="empty">
								<p>No connectors installed</p>
								<span>Install one from the Marketplace, then set it up here.</span>
							</div>
						{:else}
							{#each connectors as c (c.plugin_id)}
								<section class="sect conn">
									<div class="connhead">
										<span class="connicon" aria-hidden="true">{@html c.icon_svg}</span>
										<div class="conntitle">
											<span class="connname">{c.name}</span>
											<span class="conndesc">{c.description}</span>
										</div>
										{#if !c.configured}
											<span class="needsetup">Needs setup</span>
										{/if}
										<button
											class="tog"
											class:on={c.enabled}
											disabled={!c.configured && !c.enabled}
											title={c.configured ? '' : 'Fill in the settings first'}
											onclick={() => toggleConnector(c, !c.enabled)}
											>
											{c.enabled ? 'On' : 'Off'}
										</button>
									</div>

									{#if connDraft[c.plugin_id]}
										{#each c.fields as f (f.key)}
											<label>
												{f.label}{f.required ? ' *' : ''}
												{#if f.secret}
													<input
														type="password"
														autocomplete="off"
														placeholder={c.secrets_set[f.key]
														? '•••••• saved — leave blank to keep'
														: (f.placeholder ?? '')}
														bind:value={connDraft[c.plugin_id][f.key]}
														/>
												{:else}
													<input
														placeholder={f.placeholder ?? ''}
														bind:value={connDraft[c.plugin_id][f.key]}
														/>
												{/if}
											</label>
										{/each}
									{/if}

									<div class="assign">
										<span class="assignlabel">Bots that can use it</span>
										<div class="assignbots">
											{#each chat.visibleBots as b (b.id)}
												<label class="assignbot">
													<input
														type="checkbox"
														checked={(connBots[c.plugin_id] ?? []).includes(b.id)}
														onchange={() => toggleConnBot(c.plugin_id, b.id)}
														/>
													{b.name}
												</label>
											{:else}
												<span class="none">No bots yet</span>
											{/each}
										</div>
									</div>

									{#if c.connector === 'whatsapp'}
										<div class="assign">
											<div class="chathead">
												<span class="assignlabel">Allowed chats</span>
												<button
													class="makedef"
													disabled={connBusy === c.plugin_id}
													onclick={() => loadWaChats(c)}
													>
													Load chats
												</button>
											</div>
											{#if (waChats[c.plugin_id] ?? []).length === 0 && (connChats[c.plugin_id] ?? []).length === 0}
												<span class="fieldhint">
													Load chats once the session is connected, then tick the ones this
													bot may read and send to. Nothing ticked = unrestricted.
												</span>
											{:else}
												<div class="chatlist">
													{#each waChats[c.plugin_id] ?? [] as chat (chat.id)}
														{@const entry = (connChats[c.plugin_id] ?? []).find((a) => a.id === chat.id)}
														<div class="chatrow">
															<label class="assignbot">
																<input
																	type="checkbox"
																	checked={!!entry}
																	onchange={() => toggleWaChat(c.plugin_id, chat.id)}
																	/>
																{chat.name || chat.id}
															</label>
															{#if entry}
																<input
																	class="alias"
																	placeholder="alias (e.g. Mum)"
																	value={entry.alias}
																	oninput={(e) => (entry.alias = e.currentTarget.value)}
																	/>
															{/if}
														</div>
													{/each}
													{#each (connChats[c.plugin_id] ?? []).filter((a) => !(waChats[c.plugin_id] ?? []).some((w) => w.id === a.id)) as stale (stale.id)}
														<div class="chatrow">
															<label class="assignbot">
																<input
																	type="checkbox"
																	checked
																	onchange={() => toggleWaChat(c.plugin_id, stale.id)}
																	/>
																{stale.id}
															</label>
															<input
																class="alias"
																placeholder="alias"
																value={stale.alias}
																oninput={(e) => (stale.alias = e.currentTarget.value)}
																/>
														</div>
													{/each}
												</div>
											{/if}
										</div>
									{/if}

									{#if c.connector === 'tailscale' && (connBots[c.plugin_id] ?? []).length > 0}
										<div class="assign">
											<span class="assignlabel">Tailnet link</span>
											{#each connBots[c.plugin_id] ?? [] as botId (botId)}
												{@const st = tsStatus[`${c.plugin_id}:${botId}`]}
												<div class="chatrow">
													<span class="assignbot">{chat.visibleBots.find((b) => b.id === botId)?.name ?? botId}</span>
													{#if st}
														<span class="tsstate" class:on={st.online}>
															{st.online ? st.ips.join(', ') : (st.detail ?? st.backend)}
														</span>
													{/if}
													<button
														class="makedef"
														disabled={connBusy === c.plugin_id}
														onclick={() => tailscaleJoin(c, botId, true)}
														>
														Join
													</button>
													<button
														class="makedef"
														disabled={connBusy === c.plugin_id}
														onclick={() => tailscaleJoin(c, botId, false)}
														>
														Status
													</button>
												</div>
											{/each}
											<span class="fieldhint">
												Join starts a tailscale sidecar on the bot's machine so it can reach
												tailnet hosts.
											</span>
										</div>
									{/if}

									{#if c.connector === 'elevenlabs-phone-calls'}
										<div class="assign">
											<div class="chathead">
												<span class="assignlabel">Phone numbers on this account</span>
												<button
													class="makedef"
													disabled={connBusy === c.plugin_id}
													onclick={() => loadElNumbers(c)}
													>
													Check
												</button>
											</div>
											{#if (elNumbers[c.plugin_id] ?? []).length === 0}
												<span class="fieldhint">
													Check lists the numbers imported in ElevenLabs telephony. Pick one to
													fill the phone number id, then Save — E.164 numbers must be imported
													there before the agent can call from one.
												</span>
											{:else}
												<div class="chatlist">
													{#each elNumbers[c.plugin_id] ?? [] as n (n.phone_number_id)}
														<div class="chatrow">
															<span class="assignbot">
																{n.phone_number}{n.label ? ` — ${n.label}` : ''}{n.assigned_agent
																? ''
																: ' (no agent assigned)'}
															</span>
															<button
																class="makedef"
																onclick={() =>
																(connDraft[c.plugin_id].phone_number_id = n.phone_number_id)}
																>
																Use this id
															</button>
														</div>
													{/each}
												</div>
											{/if}
										</div>
									{/if}

									<div class="connfoot">
										{#if c.connector === 'whatsapp'}
											<button
												class="makedef"
												disabled={connBusy === c.plugin_id}
												onclick={() => connectQr(c)}
												>
												{connBusy === c.plugin_id ? 'Connecting…' : 'Connect / show QR'}
											</button>
										{/if}
										<button
											class="add"
											disabled={connBusy === c.plugin_id}
											onclick={() => saveConnector(c)}
											>
											Save
										</button>
									</div>
									{#if qrFor === c.plugin_id && qrImage}
										<div class="qrbox">
											<img src={qrImage} alt="WhatsApp pairing QR code" />
											<span class="fieldhint">Scan this with WhatsApp → Linked devices.</span>
										</div>
									{/if}
									{#if connNote[c.plugin_id]}
										<p class="hint">{connNote[c.plugin_id]}</p>
									{/if}
								</section>
							{/each}
							<p class="hint">
								Secret values are stored encrypted on the server and never sent back to this
								page — a blank field keeps what is saved.
							</p>
						{/if}
					</div>
				{/if}
				{#if tab === 'secrets'}
					<div class="panel" role="tabpanel" id="panel-secrets" aria-labelledby="tab-secrets">
						<!-- A bot can only ask for what it needs or store what it is
						     given, so this sends it the request rather than inventing a
						     secret. -->
						<div class="asksecret">
							<div class="askrow">
								<select bind:value={askBotId} aria-label="Bot to ask for a secret">
									{#each chat.visibleBots as b (b.id)}
										<option value={b.id}>{b.name}</option>
									{/each}
								</select>
								<input
									class="askname"
									bind:value={askName}
									placeholder="secret name"
									aria-label="Name of the secret to ask for"
									onkeydown={(e) => {
										if (e.key === 'Enter') void askForSecret();
									}}
								/>
								<button
									class="askgo"
									onclick={askForSecret}
									disabled={askBusy || !askBotId || !askName.trim()}
								>
									{askBusy ? 'Asking…' : 'Ask'}
								</button>
							</div>
							<span class="fieldhint">
								{askNote ||
									`get ${askBot?.name ?? 'a bot'} to ask me for a secret${askName.trim() ? ` for ${askName.trim()}` : ''}`}
							</span>
						</div>
						<div class="secrets">
							{#each botSecrets as bot (bot.id)}
								<div class="botsecrets">
									<div class="who">
										<Avatar color={bot.color} seed={bot.id} size={20} hat={bot.hat} />
										<span>{bot.name}</span>
									</div>
									{#each bot.secrets as s (s.name)}
										{@const key = `${bot.id}:${s.name}`}
										<div class="secret">
											<span class="sname">{s.name}</span>
											{#if s.shared_with}<span class="shared">shared</span>{/if}
											{#if s.created_at}<span class="swhen">{shortAge(s.created_at)}</span>{/if}
											<!-- The value is fetched only when the eye is opened, and
											dropped the moment it is shut: the list itself never
											carries one. -->
											<button
												class="eye"
												title={key in revealed ? 'Hide the value' : 'Show the value'}
												onclick={() => toggleReveal(bot.id, s.name)}
												>
												{#if key in revealed}
													<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>
												{:else}
													<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.5 7.5A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.9 9.9 0 0 0 4-.8"/></svg>
												{/if}
											</button>
											<button
												class="bin"
												title="Forget this secret"
												onclick={() => forgetSecret(bot.id, s.name)}
												>
												✕
											</button>
										</div>
										{#if key in revealed}
											<code class="sval">{revealed[key]}</code>
										{:else}
											<span class="sval masked">••••••••</span>
										{/if}
									{:else}
										<span class="none">No secrets</span>
									{/each}
								</div>
							{/each}
						</div>
						<p class="hint">Values stay encrypted on the server; the eye fetches one only while it is open.</p>
					</div>
				{/if}

				{#if tab === 'files'}
					<div class="panel" role="tabpanel" id="panel-files" aria-labelledby="tab-files">
						<section class="sect">
							<h3>Machine drives</h3>
							<p class="hint">
								What is actually on disk: the /company drive every machine mounts, and a
								bot's own /shared. Read-only - names, sizes and the start of text files.
							</p>
							<div class="filepick">
								<select bind:value={drivePick} aria-label="Drive to browse">
									<option value="company">Company drive (/company)</option>
									{#each chat.visibleBots as b (b.id)}
										<option value={`shared:${b.id}`}>{b.name} — /shared</option>
									{/each}
								</select>
							</div>
							<MountBrowser
								volume={drivePick === 'company' ? 'company' : 'shared'}
								botId={drivePick === 'company' ? '' : drivePick.slice('shared:'.length)}
								label={drivePick === 'company'
								? 'Company drive (/company)'
								: `${chat.botById(drivePick.slice('shared:'.length))?.name ?? 'This bot'} — /shared`}
								/>
						</section>

						{#if chat.visibleBots.length === 0}
							<p class="hint">Files belong to an agent. Create one and it can be given files.</p>
						{:else}
							<div class="filepick">
								{#if pickBot}
									<Avatar color={pickBot.color} seed={pickBot.id} size={20} hat={pickBot.hat} />
								{/if}
								<select value={filesBotId} onchange={onPickBot} aria-label="Agent whose files to show">
									{#each chat.visibleBots as b (b.id)}
										<option value={b.id}>{b.name}</option>
									{/each}
								</select>
							</div>

							<FileBrowser botId={filesBotId} botName={pickBot?.name ?? ''} />

							<div class="pad">
								<div class="padhead">
									<span class="padtitle">Scratchpad</span>
									<span class="padsub">notes {pickBot?.name ?? 'this agent'} keeps for itself</span>
									{#if padDirty}<span class="paddirty">Unsaved</span>{/if}
								</div>
								<textarea
									class="padtext"
									rows="6"
									placeholder="Nothing written yet…"
									bind:value={padContent}
									aria-label="{pickBot?.name ?? 'Agent'} scratchpad"
									></textarea>
								<div class="padfoot">
									{#if padNote}<span class="padnote">{padNote}</span>{/if}
									<button class="padsave" onclick={savePad} disabled={padSaving}>
										{padSaving ? 'Saving…' : 'Save'}
									</button>
								</div>
							</div>
						{/if}
					</div>
				{/if}

				{#if tab === 'routines'}
					<div class="panel" role="tabpanel" id="panel-routines" aria-labelledby="tab-routines">
						<section class="sect">
							<h3>Scheduled routines</h3>
							{#if routinesNote}
								<p class="dbstate err">{routinesNote}</p>
							{:else if routines.length === 0}
								<p class="hint">No routines yet. Create one from a bot's menu and it appears here.</p>
							{/if}
							{#each routines as r (r.id)}
								{@const runs = runsFor(r.name)}
								{@const fails = runs.filter((t) => t.status === 'error').length}
								{@const rv = routineVerdict(r)}
								<div class="botsecrets">
									<button
										class="routinerow"
										aria-expanded={openRoutine === r.id}
										onclick={() => (openRoutine = openRoutine === r.id ? '' : r.id)}
									>
										<span class="routinename">{r.name}</span>
										<span class="swhen">{chat.botById(r.bot_id)?.name ?? 'Unknown bot'}</span>
										<span class="swhen">{scheduleOf(r)}</span>
										{#if !r.enabled}<span class="shared">off</span>{/if}
										{#if r.paused_reason}<span class="shared">{r.paused_reason}</span>{/if}
										<span class="swhen">{shortAhead(r.next_run_at)}</span>
									</button>
									<span class="routinefoot">
										<span class="fieldhint">{runs.length ? `${runs.length} recent run${runs.length === 1 ? '' : 's'}${fails ? ` · ${fails} failed` : ''}` : 'No runs yet'}</span>
										<button
											class="tog"
											class:on={!!r.enabled}
											title={r.enabled ? 'Switch this routine off' : 'Switch this routine on'}
											onclick={() => toggleRoutine(r, !r.enabled)}
										>
											{r.enabled ? 'On' : 'Off'}
										</button>
									</span>
									{#if openRoutine === r.id}
										<div class="routinedetail">
											<p class="hint">{r.prompt}</p>
											{#if rv}
												<span class="fieldhint">
													Police: {rv.verdict === 'approved' ? 'verified' : rv.verdict === 'rejected' ? 'refused' : 'unverified'}{rv.reason ? ` — ${rv.reason}` : ''}{rv.by === 'human' ? ' · by you' : ''}
												</span>
											{/if}
											<span class="fieldhint">
												Schedule: {scheduleOf(r)} · next {shortAhead(r.next_run_at)} · created {shortAge(r.created_at)}
											</span>
											{#each runs as t (t.id)}
												<div class="runrow">
													<span class="runstatus" class:bad={t.status === 'error'}>{t.status}</span>
													{#if t.finished_at}
														<span class="swhen">{shortAge(t.finished_at)}</span>
													{:else}
														<span class="swhen">running</span>
													{/if}
													{#if t.error}<span class="runerr">{t.error}</span>{/if}
												</div>
											{:else}
												<span class="fieldhint">No matching runs in the tray yet.</span>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</section>
					</div>
				{/if}

				{#if tab === 'police'}
					<div class="panel" role="tabpanel" id="panel-police" aria-labelledby="tab-police">
						<PoliceConsole />
					</div>
				{/if}
				{#if tab === 'federation'}
					<div class="panel" role="tabpanel" id="panel-federation" aria-labelledby="tab-federation">
						<Federation />
					</div>
				{/if}
			</div>

			<div class="footer">
				{#if chat.error}<span class="err">{chat.error}</span>{/if}
				<button class="save" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: grid;
		place-items: center;
		z-index: 50;
	}
	.dialog {
		width: min(920px, 94vw);
		/* The secret inventory can outgrow the viewport; the body scrolls
		   instead, so Save stays reachable without covering anything. */
		max-height: 85dvh;
		overflow: hidden;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		box-shadow: 0 1.5rem 3.5rem rgba(0, 0, 0, 0.55);
		border-radius: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex: none;
		padding: 1.4rem 1.4rem 0;
	}
	.x {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 1rem;
	}
	.tabs {
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid var(--border);
		flex: none;
		/* The padding keeps the focus ring from being clipped by the scroller
		   below; the margin keeps the strip aligned with the header. */
		margin: 0 1.2rem;
		padding: 0.2rem 0.2rem 0;
		/* More tabs than the bar is wide scroll sideways rather than
		   shrinking into unreadable stubs. */
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: thin;
	}
	/* Everything between the tab bar and the footer scrolls here, so the
	   footer is a static sibling that cannot cover content or scroll away. */
	.body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 0 1.4rem 0.9rem;
	}
	/* One panel is mounted at a time; it carries the vertical rhythm the body
	   used to, so a tab reads as one organised column rather than a scroll. */
	.panel {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.tab {
		/* Grow to share a wide bar, never shrink below the label's own
		   width - that is what the scroller above is for. */
		flex: 1 0 auto;
		white-space: nowrap;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 0.4rem 0.4rem 0 0;
		color: var(--text-muted);
		font-size: 0.78rem;
		padding: 0.4rem 0.6rem;
		cursor: pointer;
		transition:
			color 0.12s ease,
			background 0.12s ease,
			border-color 0.12s ease;
	}
	.tab:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.tab.sel {
		color: var(--text);
		background: var(--bg-hover);
		border-bottom-color: var(--accent);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	/* Label on the left, control on the right: the shape most settings rows
	   read best in. */
	label.field {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	label.field > input,
	label.field > select {
		flex: 0 1 auto;
		width: auto;
		min-width: 7rem;
		max-width: 60%;
	}
	.flabel {
		color: var(--text);
	}
	input,
	select {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		color: var(--text);
		padding: 0.45rem 0.6rem;
		font-size: 0.9rem;
	}
	input:focus,
	select:focus {
		outline: none;
		border-color: var(--accent);
	}
	input::placeholder {
		color: var(--text-muted);
		font-style: italic;
	}
	.sect {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.sect + .sect {
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}
	h3 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	/* A short accent rule gives every section the same visual anchor, so the
	   eye can find the next heading without reading the whole column. */
	h3::before {
		content: '';
		flex: none;
		width: 3px;
		height: 0.9em;
		border-radius: 2px;
		background: var(--accent);
	}
	.fieldhint {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.hint {
		margin: -0.4rem 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.sect .hint {
		margin-top: -0.15rem;
	}
	.asksecret {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-bottom: 0.6rem;
	}
	.askrow {
		display: flex;
		gap: 0.4rem;
	}
	.askrow select {
		flex: none;
		max-width: 9rem;
	}
	.askname {
		flex: 1;
		min-width: 0;
	}
	.askgo {
		flex: none;
	}
	.botsecrets {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg);
	}
	.botsecrets + .botsecrets {
		margin-top: 0.5rem;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		color: var(--text);
	}
	.secret {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.35rem;
		padding-left: 1.7rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.sname {
		flex: 1;
		word-break: break-all;
	}
	.shared {
		font-size: 0.7rem;
		padding: 0 0.35rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
	}
	.swhen {
		font-size: 0.7rem;
		color: var(--text-muted);
		opacity: 0.8;
	}
	.eye {
		display: grid;
		place-items: center;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0.15rem;
		border-radius: 0.3rem;
	}
	.eye:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	/* The revealed value sits under its row, in the row's own indent. */
	.sval {
		display: block;
		margin: 0.15rem 0 0.2rem 1.7rem;
		font-size: 0.76rem;
		overflow-wrap: anywhere;
	}
	code.sval {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		padding: 0.25rem 0.5rem;
		color: var(--text);
	}
	.sval.masked {
		color: var(--text-muted);
		opacity: 0.6;
		letter-spacing: 0.1em;
	}
	.def {
		font-size: 0.68rem;
		padding: 0.05rem 0.45rem;
		border: 1px solid var(--accent);
		border-radius: 999px;
		color: var(--accent);
	}
	.bin {
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
	.none {
		display: block;
		margin-top: 0.35rem;
		padding-left: 1.7rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.filepick {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}


	.filepick select {
		flex: 1;
		min-width: 0;
	}
	.err {
		color: var(--danger);
	}
	.sub {
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	/* The scratchpad is the agent's own handwriting, so it is set in a casual
	   script rather than the UI face - it should read as theirs, not ours. */
	.pad {
		margin-top: 1rem;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: var(--bg-raised);
		padding: 0.7rem 0.8rem;
	}
	.padhead {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.padtitle {
		font-size: 0.84rem;
		font-weight: 600;
	}
	.padsub {
		flex: 1;
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	.paddirty {
		flex: none;
		font-size: 0.65rem;
		padding: 0.05rem 0.45rem;
		border: 1px solid var(--accent);
		border-radius: 999px;
		color: var(--accent);
	}
	.padhist {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 0.7rem;
		cursor: pointer;
		text-decoration: underline;
	}
	.padhist:hover {
		color: var(--text);
	}
	.padtext {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		padding: 0.6rem 0.7rem;
		color: var(--text);
		font-family: 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', 'Chalkboard SE', cursive;
		font-size: 0.95rem;
		line-height: 1.5;
	}
	.padtext:focus {
		outline: none;
		border-color: #4a4a52;
	}
	.padfoot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 0.5rem;
	}
	.padnote {
		flex: 1;
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	.padsave {
		background: var(--accent);
		border: none;
		border-radius: 999px;
		color: #fff;
		font-size: 0.78rem;
		padding: 0.4rem 1rem;
		cursor: pointer;
	}
	.padsave:disabled {
		opacity: 0.5;
		cursor: default;
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
	.empty p {
		margin: 0;
		font-size: 0.82rem;
		color: var(--text);
	}
	.empty span {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.providerrow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		font-size: 0.8rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg);
	}
	.pmeta {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.subline {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}
	.pname {
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pmodel {
		min-width: 0;
		font-size: 0.72rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.makedef {
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.72rem;
	}
	.makedef:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.makedef.primary {
		color: var(--text);
		border-color: var(--accent);
	}
	.makedef:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.providerform {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.providers {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.4rem;
	}
	.prov {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		padding: 0.5rem 0.3rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		color: var(--text-muted);
		font-size: 0.72rem;
		cursor: pointer;
	}
	.prov:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.prov.sel {
		background: var(--bg-hover);
		border-color: var(--accent);
		color: var(--text);
	}
	.provname {
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}
	/* A provider's mark is a monogram drawn here, never a downloaded logo, so
	   nothing in this dialog suggests a partnership that does not exist. */
	.mark {
		display: grid;
		place-items: center;
		flex: none;
		width: 1.7rem;
		height: 1.7rem;
		border-radius: 0.45rem;
		border: 1px solid var(--tint);
		color: var(--tint);
		font-size: 0.72rem;
		font-weight: 600;
	}
	.providerrow .mark {
		width: 1.4rem;
		height: 1.4rem;
		border-radius: 0.35rem;
		font-size: 0.6rem;
	}
	.keychip {
		flex: none;
		font-size: 0.65rem;
		padding: 0.05rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
	}
	.pform {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.prow,
	.probebtns {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.4rem;
	}
	/* The model check's answer: a small popup that dismisses itself, fixed to
	   the dialog's corner so it never shifts the form. */
	.checktoast {
		position: fixed;
		right: 1.2rem;
		bottom: 1.2rem;
		z-index: 60;
		max-width: 22rem;
		padding: 0.55rem 0.9rem;
		border-radius: 0.6rem;
		font-size: 0.82rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
		animation: toastin 0.18s ease-out;
	}
	.checktoast.ok {
		border-color: #2fae8f;
		color: #7fd8c0;
	}
	.checktoast.bad {
		border-color: #e04a4a;
		color: #f0a0a0;
	}
	.checktoast.busy {
		color: var(--text-muted);
	}
	@keyframes toastin {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	.dialog:focus-visible,
	.x:focus-visible,
	.tab:focus-visible,
	.prov:focus-visible,
	.tog:focus-visible,
	.makedef:focus-visible,
	.bin:focus-visible,
	.add:focus-visible,
	.save:focus-visible,
	.theme:focus-visible,
	.routinerow:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.deviceflow {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.4rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
	}
	.deviceflow .dflabel {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.deviceflow .dfcode {
		font-size: 1.15rem;
		font-weight: 700;
		letter-spacing: 0.12em;
	}
	.deviceflow .dfurl {
		font-size: 0.75rem;
		color: var(--accent, #4f8ef7);
		overflow-wrap: anywhere;
	}
	.add {
		align-self: flex-end;
		padding: 0.4rem 1rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		color: var(--text);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.add:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.add:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.tog {
		padding: 0.25rem 0.8rem;
		border-radius: 1rem;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.8rem;
	}
	.tog.on {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.footer {
		display: flex;
		justify-content: flex-end;
		/* Static action bar after the scrollport; its own bottom padding
		   replaces the dialog's, so it never crosses the border. */
		flex: none;
		padding: 0.9rem 1.4rem 1.4rem;
		border-top: 1px solid var(--border);
		background: var(--bg-raised);
	}
	.ghost {
		background: none;
		border: 1px solid var(--border);
		border-radius: var(--r-sm, 0.5rem);
		color: var(--text);
		font-size: 0.84rem;
		padding: 0.45rem 0.95rem;
		cursor: pointer;
	}
	.ghost:hover {
		background: var(--bg-hover);
	}
	.signout {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}
	/* Ending a session is not a neutral act; say so on hover. */
	.signout:hover {
		border-color: var(--danger);
		color: var(--danger);
		background: rgba(242, 109, 109, 0.08);
	}
	.save {
		padding: 0.5rem 1.4rem;
		background: var(--accent);
		border: none;
		border-radius: 0.6rem;
		color: #fff;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.dialog:focus-visible,
	.x:focus-visible,
	.tab:focus-visible,
	.prov:focus-visible,
	.tog:focus-visible,
	.makedef:focus-visible,
	.bin:focus-visible,
	.add:focus-visible,
	.save:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* The backup block sits at the foot of General: quiet enough to ignore,
	   specific enough to find when the restore notice has sent you looking. */
	.dbstate {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.4;
		color: var(--text);
	}
	/* Two classes, so the shared .err colour is not overtaken by the rule above. */
	.dbstate.err {
		color: var(--danger);
	}
	.dbpath {
		overflow-wrap: anywhere;
		color: var(--text);
	}

	/* Connectors tab: one card per installed connector. */
	.connhead {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.connicon {
		flex: none;
		width: 1.8rem;
		height: 1.8rem;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}
	.connicon :global(svg) {
		width: 1.4rem;
		height: 1.4rem;
	}
	.conntitle {
		flex: 1;
		min-width: 0;
	}
	.connname {
		display: block;
		font-size: 0.9rem;
		color: var(--text);
	}
	.conndesc {
		display: block;
		font-size: 0.74rem;
		line-height: 1.35;
		color: var(--text-muted);
	}
	.needsetup {
		flex: none;
		font-size: 0.7rem;
		padding: 0 0.4rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--danger);
	}
	.assign {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.assignlabel {
		font-size: 0.78rem;
		color: var(--text);
	}
	.assignbots {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.9rem;
	}
	.assignbot {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.78rem;
		color: var(--text);
	}
	.connfoot {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 0.5rem;
	}
	.qrbox {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		padding: 0.6rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: #fff;
	}
	.qrbox img {
		width: 12rem;
		height: 12rem;
		image-rendering: pixelated;
	}
	.qrbox .fieldhint {
		color: #555;
	}
	.chathead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.chatlist {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 12rem;
		overflow-y: auto;
	}
	.chatrow {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.chatrow .assignbot {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.alias {
		width: 8rem;
		font-size: 0.75rem;
	}
	.tsstate {
		flex: 1;
		font-size: 0.74rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tsstate.on {
		color: #6ea8fe;
	}
	.caprow {
		display: flex;
		align-items: end;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	/* The vision pick with its own Confirm beside it: model names are long, so
	   the select takes the room and the button keeps its width. */
	.visionrow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.visionrow select {
		flex: 1;
		min-width: 0;
	}
	/* The default-model select with its reset-all button beside it: same
	   shape as visionrow - the select takes the room, the button keeps its
	   width. */
	.modelrow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 0 1 auto;
		max-width: 70%;
	}
	.modelrow select {
		flex: 1;
		min-width: 0;
	}
	button.mini {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		color: var(--text-muted);
		font-size: 0.7rem;
		padding: 0.3rem 0.55rem;
		cursor: pointer;
		white-space: nowrap;
	}
	button.mini:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--text-muted);
	}
	button.mini:disabled {
		opacity: 0.5;
		cursor: default;
	}
	/* The one-line answer under a provider or vision action - the check's own
	   words, coloured by how it went. */
	.probe {
		margin: 0;
		font-size: 0.78rem;
	}
	.probe.ok {
		color: #7fd8c0;
	}
	.probe.bad {
		color: #f0a0a0;
	}
	.probe.busy {
		color: var(--text-muted);
	}
	.capbudget {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.74rem;
		color: var(--text-muted);
	}
	.capbudget input {
		width: 9rem;
	}
	.capverdict {
		margin: 0.5rem 0 0;
		font-size: 0.8rem;
	}
	.capverdict.capable {
		color: #4ade80;
	}
	.capverdict.partial {
		color: #facc15;
	}
	.capverdict.poor {
		color: #f87171;
	}
	.capchecks {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-top: 0.4rem;
	}
	.capcheck {
		display: grid;
		grid-template-columns: 11rem 3rem 1fr;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.76rem;
	}
	.caprate.bad {
		color: #f87171;
	}
	.capbar {
		height: 4px;
		background: var(--bg-hover);
		border-radius: 2px;
		overflow: hidden;
	}
	.capfill {
		display: block;
		height: 100%;
		background: #4ade80;
	}
	/* Appearance: six swatches in a grid, each naming its theme with an accent dot. */
	.themegrid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.4rem;
	}
	.theme {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.45rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		cursor: pointer;
	}
	.theme:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.theme.sel {
		border-color: var(--accent);
		color: var(--text);
	}
	.theme .dot {
		flex: none;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
	}
	/* Routines: one card per schedule; the name row opens the spec and history. */
	.routinerow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font: inherit;
		cursor: pointer;
		text-align: left;
	}
	.routinename {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.85rem;
		color: var(--text);
	}
	.routinefoot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		margin-top: 0.35rem;
		padding-left: 0;
	}
	.routinedetail {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	.routinedetail .hint {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.runrow {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.76rem;
	}
	.runstatus {
		flex: none;
		color: var(--text-muted);
	}
	.runstatus.bad {
		color: var(--danger);
	}
	.runerr {
		flex: 1;
		min-width: 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
</style>
