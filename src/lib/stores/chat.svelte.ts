import type { Note, Reaction, Task, Activity, Bot, BotProposal, BubbleTheme, ChangeRequest, Conversation, Message, Plugin, Routine, SshRequest, WakeTask, WaitCondition } from '$lib/types';
import { sndDone, sndError, sndSend } from '$lib/sound';

/** Messages missed before a catch-up digest is worth generating. */
const CATCHUP_THRESHOLD = 8;

/**
 * The ambient polls' fastest and slowest cadence. Each starts at its minimum
 * and backs off while nothing changes; a hidden tab stops them outright.
 */
const SYNC_MIN_MS = 3000;
const SYNC_MAX_MS = 30_000;
const ACTIVITY_MIN_MS = 5000;
const ACTIVITY_MAX_MS = 30_000;
/** Machine presence changes no faster than a container starts or stops. */
const PRESENCE_MIN_MS = 8000;
const PRESENCE_MAX_MS = 30_000;
/** Fleet-wide task tray poll; backs off while the tray is quiet. */
const GLOBAL_TASK_MIN_MS = 3000;
const GLOBAL_TASK_MAX_MS = 30_000;
/** Active-conversation task poll while turns run (SSE carries previews). */
const TASK_POLL_MS = 700;
const TASK_POLL_LIVE_MS = 1800;
/** Debounce bot/proposal/ssh/ask re-reads after a thread reload. */
const META_REFRESH_MS = 300;

/**
 * The activity kinds that mean a bot is at its machine: a shell command, a
 * page it drove, the sandbox waking or the computer sub-agent's own notes.
 * The same set ScreenPanel calls "at the desk".
 */
const USING_COMPUTER_KINDS = ['shell', 'browser', 'sandbox', 'computer'];

class ChatStore {
	bots = $state<Bot[]>([]);
	conversations = $state<Conversation[]>([]);
	activeId = $state('');
	messages = $state<Message[]>([]);
	/** Emoji reactions per message id. */
	reactions = $state<Record<string, Reaction[]>>({});
	/** Shared notes for the open chat - what the bots scribble on their board. */
	notes = $state<Note[]>([]);
	/** Crayon marks on the lounge board; each is a PNG of one stroke. */
	marks = $state<any[]>([]);
	activeBots = $state<Bot[]>([]);
	/** Bots pitched for the open chat that the human has not answered yet. */
	botProposals = $state<BotProposal[]>([]);
	models = $state<string[]>([]);
	defaultModel = $state('');
	policeModel = $state('');
	/** The model that looks at pictures; '' means the police model looks. */
	visionModel = $state('');
	dockerAvailable = $state(true);
	think = $state(false);
	error = $state('');
	loading = $state(true);
	routines = $state<Routine[]>([]);
	activities = $state<Activity[]>([]);
	/** Wakes and waits this bot is holding: things that will start a turn later. */
	wakes = $state<WakeTask[]>([]);
	waits = $state<WaitCondition[]>([]);
	/** The open chat's SSH asks: one card per row the bot filed. */
	sshRequests = $state<SshRequest[]>([]);
	/** The asks still waiting on the human: one card per row a bot filed. */
	asks = $state<ChangeRequest[]>([]);
	/**
	 * Per-bot machine presence from the server: 'running' | 'sleeping' | 'off'
	 * | 'archived'. The header dots read this rather than claiming a state
	 * nobody computed - the sofa used to say "online" for a bot whose machine
	 * had been down for hours.
	 */
	presence = $state<Record<string, string>>({});
	plugins = $state<Plugin[]>([]);
	botPlugins = $state<(Plugin & { effective_enabled: number })[]>([]);
	social = $state(true);
	socialIntervalMin = $state(60);
	/** Whole-app theme id; '' is the shipped default (:root values). */
	theme = $state('');
	/** Background turns fleet-wide, for the left list's typing/action bubbles. */
	globalTasks = $state<Task[]>([]);
	private globalTaskTimer: ReturnType<typeof setTimeout> | undefined;
	private globalTaskDelay = GLOBAL_TASK_MIN_MS;
	/** Background turns: running work plus recently finished, newest first. */
	tasks = $state<Task[]>([]);
	/**
	 * Live partial replies, keyed by task id, as the server streams them. The
	 * composing bubble reads this; the task polls still carry the rows. Keyed by
	 * task rather than by bot so two bots composing at once each keep their own.
	 */
	previews = $state<Record<string, string>>({});
	private taskStream: EventSource | null = null;
	/** Where the user last caught up in the open chat; marks the "missed" line. */
	unreadFrom = $state(0);
	/** Older messages exist on the server beyond the page the thread holds. */
	hasMoreMessages = $state(false);
	/** A "load earlier" fetch is in flight. */
	loadingEarlier = $state(false);
	/** Digest of what the bots did while the user was away, when much happened. */
	catchup = $state('');
	/**
	 * The message the composer is answering, or null when this is not a reply.
	 * The thread sets it from a bubble's quote action; the composer shows it
	 * above the input and clears it once the send is away.
	 */
	quoteDraft = $state<Message | null>(null);
	detailBotId = $state('');
	/**
	 * The human's own lines that steered a turn already running, by the stored
	 * message id the send's reply named. The row the server wrote carries no such
	 * field, so the ids are kept here: the mark has to survive every later re-read
	 * of the thread, and the reload that lands the row is never the last one.
	 */
	steeredIds = $state<string[]>([]);

	private taskTimer: ReturnType<typeof setTimeout> | undefined;
	private activityTimer: ReturnType<typeof setTimeout> | undefined;
	private syncTimer: ReturnType<typeof setTimeout> | undefined;
	private presenceTimer: ReturnType<typeof setTimeout> | undefined;
	private metaRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private reloadThreadInflight: Promise<void> | null = null;
	/**
	 * How long the ambient polls currently wait between ticks. Each backs off
	 * while nothing changes and snaps back to its minimum the moment something
	 * does - or the tab comes back into view - so a quiet page costs little
	 * and a busy one still feels live.
	 */
	private syncDelay = SYNC_MIN_MS;
	private activityDelay = ACTIVITY_MIN_MS;
	private presenceDelay = PRESENCE_MIN_MS;
	private visibilityWatched = false;
	/**
	 * Task snapshot per conversation (task id → last status we saw). A task that
	 * reaches a terminal status is noticed exactly once, even when a provider
	 * fails before the first poll ever sees it running.
	 */
	private taskSnapshots = new Map<string, Map<string, Task['status']>>();

	/** Refresh the fleet-wide running tasks (no conversation filter). */
	async refreshGlobalTasks() {
		const res = await this.req('/api/tasks').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data?.tasks) return;
		this.globalTasks = data.tasks as Task[];
	}

	private scheduleGlobalTaskPoll() {
		clearTimeout(this.globalTaskTimer);
		this.globalTaskTimer = setTimeout(() => {
			void (async () => {
				if (typeof document === 'undefined' || !document.hidden) {
					const before = this.globalTasks.map((t) => `${t.id}:${t.status}`).join('|');
					await this.refreshGlobalTasks();
					const after = this.globalTasks.map((t) => `${t.id}:${t.status}`).join('|');
					this.globalTaskDelay =
						before !== after ? GLOBAL_TASK_MIN_MS : Math.min(this.globalTaskDelay * 1.5, GLOBAL_TASK_MAX_MS);
				}
				this.scheduleGlobalTaskPoll();
			})();
		}, this.globalTaskDelay);
		void this.refreshGlobalTasks();
	}

	/**
	 * Follow the server's live reply stream. EventSource reconnects on its own,
	 * and the server replays the current partial for every running task on each
	 * (re)connect, so a dropped connection costs only the gap it was down. The
	 * task polls keep running for everything else - rows, statuses, the tray.
	 */
	private watchPreviews() {
		if (this.taskStream || typeof EventSource === 'undefined') return;
		const source = new EventSource('/api/tasks/stream');
		source.addEventListener('preview', (e) => {
			const data = JSON.parse((e as MessageEvent).data) as { taskId: string; preview: string };
			// `previews` is $state, so the deep proxy makes this assignment the
			// reactive update - no copy of the map on every delta.
			this.previews[data.taskId] = data.preview;
		});
		source.addEventListener('task_end', (e) => {
			const { taskId } = JSON.parse((e as MessageEvent).data) as { taskId: string };
			this.dropPreview(taskId);
		});
		this.taskStream = source;
	}

	/**
	 * Forget a task's partial. The finished message - or the failure, or the
	 * stop - takes its place, so a partial must never be left looking like a
	 * reply that landed.
	 */
	dropPreview(taskId: string) {
		delete this.previews[taskId];
	}

	/** The partial reply for one task, or '' when nothing has streamed yet. */
	previewForTask(taskId: string): string {
		return this.previews[taskId] ?? '';
	}

	/**
	 * The partial reply a bot is composing in the open chat, or ''. Found by the
	 * bot's running task, so two bots composing at once each read their own.
	 */
	previewForBot(botId: string): string {
		const task = this.tasks.find((t) => t.bot_id === botId && t.status === 'running');
		return task ? this.previewForTask(task.id) : '';
	}

	/** Live token counters for a bot's running task: TX = prompt tokens sent,
	    RX = reply tokens received. 0 when nothing is in flight. */
	tokensOutFor(botId: string): number {
		const task = this.tasks.find((t) => t.bot_id === botId && t.status === 'running');
		return task?.tokens_in ?? 0;
	}
	tokensInFor(botId: string): number {
		const task = this.tasks.find((t) => t.bot_id === botId && t.status === 'running');
		return task?.tokens_out ?? 0;
	}

	/** Running tasks touching a particular conversation, for the rail's bubble. */
	tasksForConversation(conversationId: string): Task[] {
		return this.globalTasks.filter((t) => t.conversation_id === conversationId && t.status === 'running');
	}

	/** Small indicator for the left list row: typing or acting (toolbox/thinking). */
	indicatorFor(conversationId: string): { label: string; kind: 'typing' | 'acting' } | null {
		const running = this.tasksForConversation(conversationId);
		if (!running.length) return null;
		const t = running[0];
		const act = this.activityKindFor(t.bot_id);
		if (['shell', 'browser', 'sandbox', 'computer', 'task'].includes(act)) {
			return { label: 'acting…', kind: 'acting' };
		}
		if (act === 'thinking' || t.preview.length < 40) return { label: 'thinking…', kind: 'typing' };
		return { label: 'typing…', kind: 'typing' };
	}

	/**
	 * fetch that answers null instead of throwing on a network failure. Every
	 * call site below treats a lost request as "no answer" - the same shape a
	 * refused one already has - so a blip can never surface as an unhandled
	 * rejection from a click or a poll.
	 */
	private async req(url: string, init?: RequestInit): Promise<Response | null> {
		return fetch(url, init).catch(() => null);
	}

	async init() {
		const [botsRes, convRes, modelRes, settingsRes] = await Promise.all([
			this.req('/api/bots'),
			this.req('/api/conversations'),
			this.req('/api/models'),
			this.req('/api/settings')
		]);
		// A launch that reached nothing is a failed launch: without the throw the
		// page reads "no bots yet" - a state that is also true of a working
		// server - and the retry button never appears.
		if (!botsRes?.ok && !convRes?.ok && !modelRes?.ok && !settingsRes?.ok) {
			throw new Error('the server did not answer');
		}
		if (botsRes?.ok) this.bots = (await botsRes.json()).bots;
		if (convRes?.ok) this.conversations = (await convRes.json()).conversations;
		if (modelRes?.ok) {
			const data = await modelRes.json();
			this.models = data.models;
			this.defaultModel = data.default || data.models[0] || '';
		}
		// The stored settings win over the defaults declared on the fields above,
		// so a toggle the user already made survives the next Save.
		if (settingsRes?.ok) {
			const data = await settingsRes.json();
			this.social = data.social;
			this.socialIntervalMin = data.social_interval_min;
			if (data.default_model) this.defaultModel = data.default_model;
			this.policeModel = data.police_model ?? '';
			this.visionModel = data.vision_model ?? '';
			// The stored theme wins the same way, so a chosen look survives reload.
			this.theme = data.theme ?? '';
			this.applyTheme();
		}
		this.loading = false;
		this.scheduleActivityPoll();
		this.scheduleGlobalTaskPoll();
		// The live reply stream: the composing bubble's text arrives per delta
		// rather than at the next poll.
		this.watchPreviews();
		// Other clients - a second tab, a phone, a webhook - write to the same
		// conversations, and nothing else ever brings their messages here.
		this.scheduleSyncPoll();
		this.schedulePresencePoll();
		// A hidden tab polls nothing; coming back refreshes at once rather than
		// waiting out whatever delay the backoff had reached.
		if (typeof document !== 'undefined' && !this.visibilityWatched) {
			this.visibilityWatched = true;
			document.addEventListener('visibilitychange', () => {
				if (document.hidden) return;
				this.syncDelay = SYNC_MIN_MS;
				this.activityDelay = ACTIVITY_MIN_MS;
				this.presenceDelay = PRESENCE_MIN_MS;
				this.globalTaskDelay = GLOBAL_TASK_MIN_MS;
				void this.syncFromServer();
				void this.refreshActivities();
				// A sleep that happened while the tab was hidden is the one thing
				// the police console's Sleep/Wake pair must not sit stale on.
				void this.refreshPresence();
			});
		}
	}

	/**
	 * The conversation-list poll, rescheduling itself each round. A hidden tab
	 * skips the fetch entirely; a quiet one waits a little longer each time,
	 * up to the cap. syncFromServer reports whether it saw anything new, which
	 * is what resets the backoff.
	 */
	private scheduleSyncPoll() {
		clearTimeout(this.syncTimer);
		this.syncTimer = setTimeout(() => {
			void (async () => {
				if (typeof document === 'undefined' || !document.hidden) {
					const changed = await this.syncFromServer();
					this.syncDelay = changed ? SYNC_MIN_MS : Math.min(this.syncDelay * 1.5, SYNC_MAX_MS);
				}
				this.scheduleSyncPoll();
			})();
		}, this.syncDelay);
	}

	/** The panel poll, on the same back-off-and-hide scheme as the sync poll. */
	private scheduleActivityPoll() {
		clearTimeout(this.activityTimer);
		this.activityTimer = setTimeout(() => {
			void (async () => {
				if (typeof document === 'undefined' || !document.hidden) {
					const before = this.activities[0]?.id;
					await this.refreshActivities();
					const moved = this.activities[0]?.id !== before;
					this.activityDelay = moved
						? ACTIVITY_MIN_MS
						: Math.min(this.activityDelay * 1.5, ACTIVITY_MAX_MS);
				}
				this.scheduleActivityPoll();
			})();
		}, this.activityDelay);
	}
	/**
	 * The presence poll, on the same back-off-and-hide scheme as the others.
	 * The whole fleet's machine state arrives in one answer; a snapshot that
	 * matches the last one backs off, since containers do not flicker.
	 */
	private schedulePresencePoll() {
		clearTimeout(this.presenceTimer);
		this.presenceTimer = setTimeout(() => {
			void (async () => {
				if (typeof document === 'undefined' || !document.hidden) {
					const before = JSON.stringify(this.presence);
					await this.refreshPresence();
					const changed = JSON.stringify(this.presence) !== before;
					this.presenceDelay = changed
						? PRESENCE_MIN_MS
						: Math.min(this.presenceDelay * 1.5, PRESENCE_MAX_MS);
				}
				this.schedulePresencePoll();
			})();
		}, this.presenceDelay);
	}

	/** Re-read the fleet's machine presence (see /api/bots/presence). */
	async refreshPresence() {
		const res = await this.req('/api/bots/presence').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (data?.presence) this.presence = data.presence;
	}

	/**
	 * What the header may say about a bot, from what is actually true. A turn
	 * in flight is "typing…"; a live machine "online"; a stopped machine
	 * "asleep" — not "offline", which is a bot with no machine container at
	 * all. A chat-only bot has no machine to be offline from, an archived one
	 * is in cold storage by a human's own hand, and before the first poll
	 * answers nothing is claimed: the panel's own "…" .
	 */
	presenceFor(id: string): string {
		const bot = this.botById(id);
		if (bot?.archived) return 'cold storage';
		// A jailed bot is not offline - it is inside, and the header should say so.
		if (bot?.jailed_until && bot.jailed_until > Date.now()) return 'in jail';
		if (this.streamingBotId === id) return 'typing…';
		const state = this.presence[id];
		if (state === 'running') return 'online';
		if (state === 'sleeping') return 'asleep';
		if (state === 'off') return (bot?.machine_tier ?? '') === 'none' ? 'online' : 'offline';
		return '…';
	}

	async saveSettings(s: { social: boolean; social_interval_min: number; default_model: string; police_model?: string }) {
		const res = await this.req('/api/settings', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(s)
		});
		if (res?.ok) {
			this.social = s.social;
			this.socialIntervalMin = s.social_interval_min;
			this.defaultModel = s.default_model;
			if (s.police_model !== undefined) this.policeModel = s.police_model;
			return true;
		}
		// A refused save (an out-of-range interval) must reach the dialog, or it
		// closes showing a value that was never stored.
		const body = await res?.json().catch(() => null);
		this.error = body?.message ?? 'could not save settings';
		return false;
	}

	/**
	 * Store the model that looks at pictures, once the server has seen it answer
	 * one. A pick that cannot do images comes back refused and nothing moves:
	 * the setting is a model with eyes or it is nothing, and the caller shows
	 * the check's own answer as the confirmation.
	 */
	async saveVisionModel(model: string): Promise<{ ok: boolean; detail: string }> {
		const res = await this.req('/api/settings', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ vision_model: model })
		});
		const body = await res?.json().catch(() => null);
		if (!res?.ok) {
			this.error = body?.message ?? 'could not save the vision model';
			return { ok: false, detail: this.error };
		}
		// Only now does the stored value move: the server wrote it, so this is
		// what a reload would read back.
		this.visionModel = body?.settings?.vision_model ?? model;
		this.error = '';
		return { ok: true, detail: body?.vision?.detail ?? '' };
	}

	/**
	 * Point the document at the stored theme. The default ('') is no attribute
	 * at all, so :root carries the shipped look and nothing overrides it.
	 */
	applyTheme() {
		if (typeof document === 'undefined') return;
		if (this.theme) document.documentElement.dataset.theme = this.theme;
		else delete document.documentElement.dataset.theme;
	}

	/** Switch theme now and keep it; a refused write leaves the old one showing. */
	async setTheme(id: string) {
		const prev = this.theme;
		this.theme = id;
		this.applyTheme();
		const res = await this.req('/api/settings', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme: id })
		});
		if (!res?.ok) {
			this.theme = prev;
			this.applyTheme();
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not save theme';
		}
	}

	botById(id: string): Bot | undefined {
		return this.bots.find((b) => b.id === id);
	}

	/**
	 * The bots the human owns. `bots` holds every row, including a hidden system
	 * bot (the police) so messages it wrote still render with its name and
	 * colour; nothing that offers a bot to schedule, delete or gossip with may
	 * use that wider list. The police's own DM is the one contact the
	 * conversation list offers, and it is read off the conversation, not here.
	 */
	get visibleBots(): Bot[] {
		return this.bots.filter((b) => !b.hidden);
	}

	conversationBots(conv: Conversation | undefined): Bot[] {
		if (!conv?.bot_ids) return [];
		return conv.bot_ids
			.split(',')
			.map((id) => this.botById(id))
			.filter((b): b is Bot => !!b);
	}

	get activeConversation(): Conversation | undefined {
		return this.conversations.find((c) => c.id === this.activeId);
	}

	/** The bot shown in the right-hand screen panel. */
	get panelBot(): Bot | undefined {
		if (this.streamingBotId) return this.botById(this.streamingBotId);
		return this.activeBots[0];
	}

	/**
	 * True while the first bot is actually at its computer: recent shell,
	 * browser or sandbox activity. Drives the "typing at a keyboard" blob.
	 */
	get botWorking(): boolean {
		const id = this.activeBots[0]?.id;
		if (!id) return false;
		// Only real input counts - a shell command or a page it drove - and only
		// for a minute after the last one. Starting a container or taking a
		// screenshot is not somebody sitting at a keyboard.
		const typed = this.activities.find((a) => a.bot_id === id && a.kind === 'typing');
		return !!typed && Date.now() - typed.created_at < 60_000;
	}

	/**
	 * True while the panel bot is driving its machine: a computer-touching
	 * activity - shell, browser, sandbox, computer - newer than two minutes.
	 * The same read ScreenPanel makes for its "at the desk" set; the header's
	 * screen icon flashes on it so the machine work is visible with the panel
	 * closed. The activity poll's cadence is the lag, at most one poll.
	 */
	get botUsingComputer(): boolean {
		const id = this.panelBot?.id;
		if (!id) return false;
		const cutoff = Date.now() - 120_000;
		return this.activities.some(
			(a) => a.bot_id === id && USING_COMPUTER_KINDS.includes(a.kind) && a.created_at > cutoff
		);
	}


	/** The newest activity kind for a bot, used to pick its hat. '' when it has none. */
	activityKindFor(botId: string): string {
		return this.activities.find((a) => a.bot_id === botId)?.kind ?? '';
	}

	async select(id: string) {
		this.activeId = id;
		this.error = '';
		// Everything below belongs to the chat that was open: its thread, its
		// panel, its drafts. Leaving any of it in place shows one chat's words
		// under another's name until the fetch lands - and a quote or a secret
		// card carried over would act on the wrong room entirely.
		// Pending sends for the chat being opened survive the wipe: their bubbles
		// are not on the server yet, so clearing them would make a sent message
		// vanish until the next poll. Everything else belongs to the old chat.
		this.messages = this.messages.filter(
			(m) => m.id.startsWith('local-') && m.conversation_id === id
		);
		this.reactions = {};
		this.notes = [];
		this.marks = [];
		this.activeBots = [];
		this.activities = [];
		this.routines = [];
		this.wakes = [];
		this.waits = [];
		this.tasks = [];
		this.hasMoreMessages = false;
		this.unreadFrom = 0;
		this.catchup = '';
		this.quoteDraft = null;
		this.secretDraft = false;
		this.secretNote = '';
		this.botProposals = [];
		this.sshRequests = [];
		void this.refreshBotProposals();
		void this.refreshSshRequests();
		void this.refreshAsks();
		const res = await this.req(`/api/conversations/${id}`).catch(() => null);
		// Switching again while this fetch is in flight would otherwise let the
		// slower response overwrite the thread the user is actually looking at.
		if (this.activeId !== id) return;
		if (res?.ok) {
			const data = await res.json();
			if (this.activeId !== id) return;
			this.messages = this.mergeThread(id, data.messages);
			this.hasMoreMessages = data.has_more ?? false;
			this.activeBots = data.bots;
			this.reactions = data.reactions ?? {};
			this.notes = data.notes ?? [];
			this.marks = data.marks ?? [];
			void this.refreshActivities();
		} else {
			// A refused or lost load must say so: an empty thread and a thread
			// that could not be fetched are not the same thing.
			this.error = 'could not load this conversation';
		}
		if (this.activeId !== id) return;
		// Show what was missed before clearing the badge, so the divider has
		// somewhere to sit.
		const conv = this.conversations.find((c) => c.id === id);
		this.unreadFrom = conv?.last_read_at ?? 0;
		await this.pollTasks();
		if (this.activeId !== id) return;
		if (this.runningTasks.length) this.watchTasks();
		// Only bother with a digest when there is a real backlog to read. The
		// stamp goes with the request: markRead rewrites last_read_at the moment
		// it lands, and the two calls race, so a catch-up that reads the row
		// itself usually finds the backlog already "read" and says nothing.
		if ((conv?.unread ?? 0) >= CATCHUP_THRESHOLD) void this.loadCatchup(id, this.unreadFrom);
		void this.markRead(id);
	}

	/**
	 * Optimistic bubbles for a conversation whose send has not landed yet. A
	 * thread reload answers with what the server holds - which is everything
	 * but these - so they are appended back rather than dropped mid-send.
	 * A bubble whose words already sit in that answer has landed, though:
	 * keeping it would read the message twice until the reader switches chats.
	 */
	private pendingLocal(convId: string, landed?: Message[]): Message[] {
		const taken = landed
			? new Set(
					landed
						.filter((m) => m.role === 'user')
						.map((m) => `${m.reply_to ?? ''}\u0000${m.content}`)
				)
			: null;
		return this.messages.filter((m) => {
			if (!m.id.startsWith('local-') || m.conversation_id !== convId) return false;
			return !taken?.has(`${m.reply_to ?? ''}\u0000${m.content}`);
		});
	}

	/**
	 * The thread a reload answers with: the server's rows, the sends that have
	 * not landed yet, and - for a send that steered a turn already running - the
	 * mark on the row it became. The row is matched by the id the send's reply
	 * named (`steeredIds`), never by its words: two lines can read alike, and the
	 * mark has to sit on exactly the one that steered, through every later reload
	 * (the ambient sync re-reads the thread seconds after every send, and again
	 * whenever the conversation's stamp moves).
	 */
	private mergeThread(convId: string, landed: Message[]): Message[] {
		const steered = this.steeredIds;
		const rows = steered.length
			? landed.map((m) => (steered.includes(m.id) ? { ...m, steered: true } : m))
			: landed;
		return [...rows, ...this.pendingLocal(convId, landed)];
	}

	/**
	 * Mark the human's own lines that steered a turn already running: the
	 * optimistic bubble, while it is still pending, and the stored row the reply
	 * named. The row id is remembered, so a row that has already landed - or lands
	 * later - wears the mark either way.
	 */
	private markSteered(...ids: string[]): void {
		const mark = new Set(ids.filter((id) => id !== ''));
		if (!mark.size) return;
		const learned = [...mark].filter((id) => !id.startsWith('local-') && !this.steeredIds.includes(id));
		if (learned.length) this.steeredIds = [...this.steeredIds, ...learned];
		this.messages = this.messages.map((m) => (mark.has(m.id) ? { ...m, steered: true } : m));
	}

	/**
	 * Page older messages in above the ones shown. The cursor is the oldest
	 * message the thread holds; the server answers with what came before it,
	 * and anything already held (a deleted anchor's timestamp can overlap) is
	 * dropped rather than duplicated.
	 */
	async loadEarlier() {
		const id = this.activeId;
		const oldest = this.messages.find((m) => !m.id.startsWith('local-'));
		if (!id || !oldest || !this.hasMoreMessages || this.loadingEarlier) return;
		this.loadingEarlier = true;
		try {
			const res = await this.req(
				`/api/conversations/${id}?before=${encodeURIComponent(oldest.id)}&before_ts=${oldest.created_at}`
			).catch(() => null);
			if (!res?.ok || this.activeId !== id) return;
			const data = await res.json().catch(() => null);
			if (!data || this.activeId !== id) return;
			const held = new Set(this.messages.map((m) => m.id));
			const older = (data.messages as Message[]).filter((m) => !held.has(m.id));
			this.messages = [...older, ...this.messages];
			this.hasMoreMessages = data.has_more ?? false;
		} finally {
			this.loadingEarlier = false;
		}
	}

	/** Ask the server to summarise the backlog since the user last looked. */
	async loadCatchup(id: string, since = 0) {
		const res = await this.req(`/api/conversations/${id}/catchup?since=${since}`, { method: 'POST' }).catch(() => null);
		if (!res?.ok || this.activeId !== id) return;
		const data = await res.json().catch(() => null);
		if (data?.summary) this.catchup = data.summary;
	}

	/** Clear unread/ping state for a conversation the user is looking at. */
	async markRead(id: string) {
		if (!this.conversations.find((c) => c.id === id)?.unread) return;
		const res = await this.req(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => null);
		if (!res?.ok) return;
		this.conversations = this.conversations.map((c) =>
			c.id === id ? { ...c, unread: 0, pinged: 0, last_read_at: Date.now() } : c
		);
	}

	async openDirect(botId: string) {
		const existing = this.conversations.find(
			(c) => c.kind === 'direct' && c.bot_ids === botId
		);
		if (existing) {
			await this.select(existing.id);
			return;
		}
		const res = await this.req('/api/conversations', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bot_ids: [botId] })
		});
		if (res?.ok) {
			const conv = await res.json();
			this.conversations = [{ ...conv, bot_ids: botId }, ...this.conversations];
			await this.select(conv.id);
		}
	}

	async createGroup(botIds: string[]) {
		if (botIds.length < 2) return;
		const res = await this.req('/api/conversations', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bot_ids: botIds })
		});
		if (res?.ok) {
			const conv = await res.json();
			this.conversations = [{ ...conv, bot_ids: botIds.join(',') }, ...this.conversations];
			await this.select(conv.id);
		}
	}

	async createBot(input: {
		name: string;
		persona: string;
		avatar: string;
		color: string;
		model: string;
		desktop_recipe?: string;
		browser_recipe?: string;
		machine_tier?: string;
	}) {
		const res = await this.req('/api/bots', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input)
		});
		if (res?.ok) {
			const bot: Bot = await res.json();
			this.bots = [...this.bots, bot];
			return bot;
		}
		// A refused create (a taken name, an unknown model) has to reach the form,
		// or it closes looking like it worked.
		const body = await res?.json().catch(() => null);
		this.error = body?.message ?? 'could not create that bot';
		return null;
	}

	async updateBot(id: string, patch: Partial<Bot>) {
		const res = await this.req(`/api/bots/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		});
		if (res?.ok) {
			const bot: Bot = await res.json();
			this.bots = this.bots.map((b) => (b.id === id ? bot : b));
			this.activeBots = this.activeBots.map((b) => (b.id === id ? bot : b));
			return true;
		}
		const body = await res?.json().catch(() => null);
		this.error = body?.message ?? 'could not save that bot';
		return false;
	}

	/** Re-read the bot list (styles, proposals, token meters). */
	async refreshBots() {
		const res = await this.req('/api/bots').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		this.bots = data.bots;
		this.activeBots = this.activeBots
			.map((b) => this.bots.find((fresh) => fresh.id === b.id) ?? b);
	}

	/** Re-read the pending new-bot pitches for the open chat. */
	async refreshBotProposals() {
		const id = this.activeId;
		if (!id) return;
		const res = await this.req(`/api/bot-proposals?conversation_id=${encodeURIComponent(id)}`).catch(
			() => null
		);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		// Switching chats while this was in flight would file one chat's card
		// under another's messages.
		if (this.activeId !== id) return;
		this.botProposals = data.proposals ?? [];
	}

	/** The human's verdict on a bot's pitch for a new bot. */
	async approveBotProposal(id: string, approve: boolean) {
		const res = await this.req(`/api/bot-proposals/${id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not answer that proposal';
			return false;
		}
		// Answered, so the card goes either way; on approve the new bot needs a
		// row in the list even if it never says another word.
		this.botProposals = this.botProposals.filter((p) => p.id !== id);
		if (approve) void this.refreshBots();
		return true;
	}

	/** The human's verdict on a bot's proposed bubble style. */
	async approveStyle(botId: string, approve: boolean) {
		const res = await this.req(`/api/bots/${botId}/style`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not answer that proposal';
			return false;
		}
		const bot: Bot = await res.json();
		this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
		this.activeBots = this.activeBots.map((b) => (b.id === bot.id ? bot : b));
		return true;
	}

	/** The human's verdict on a bot's proposed bubble theme. */
	async approveTheme(botId: string, approve: boolean) {
		const res = await this.req(`/api/bots/${botId}/themes`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not answer that proposal';
			return false;
		}
		const bot: Bot = await res.json();
		this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
		this.activeBots = this.activeBots.map((b) => (b.id === bot.id ? bot : b));
		return true;
	}

	/**
	 * The human's verdict on a bot's ask for debug access, or their revoke of
	 * access already granted. Approving is the only way it is handed out and
	 * revoking the only way it ends early; either way the fresh bot row comes
	 * back so the badge and the card reflect it at once.
	 */
	async approveDebug(botId: string, approve: boolean, revoke = false) {
		const res = await this.req(`/api/bots/${botId}/debug`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(revoke ? { revoke: true } : { approve })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not change that debug access';
			return false;
		}
		const bot: Bot = await res.json();
		this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
		this.activeBots = this.activeBots.map((b) => (b.id === bot.id ? bot : b));
		return true;
	}

	/**
	 * The human's verdict on a bot's ask to think hard, or their revoke of a
	 * grant already given. Same shape as approveDebug: the route is the only
	 * writer of a grant, and the fresh bot row comes back so the card and the
	 * badge reflect it at once.
	 */
	async approveThinking(botId: string, approve: boolean, revoke = false) {
		const res = await this.req(`/api/bots/${botId}/thinking`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(revoke ? { revoke: true } : { approve })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not change that thinking grant';
			return false;
		}
		const bot: Bot = await res.json();
		this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
		this.activeBots = this.activeBots.map((b) => (b.id === bot.id ? bot : b));
		return true;
	}

	/** Re-read the open chat's SSH asks; the cards hang off these rows. */
	async refreshSshRequests() {
		const id = this.activeId;
		if (!id) {
			this.sshRequests = [];
			return;
		}
		const res = await this.req(`/api/ssh?conversation_id=${encodeURIComponent(id)}`).catch(
			() => null
		);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		// Switching chats while this was in flight would file one chat's card
		// under another's messages.
		if (this.activeId !== id) return;
		this.sshRequests = data.requests ?? [];
	}

	/** Run ssh from the bot's own machine; the card shows the verdict. */
	async checkSsh(id: string, target?: { host: string; username: string; port: number }) {
		const res = await this.req(`/api/ssh/${id}/check`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			...(target ? { body: JSON.stringify(target) } : {})
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not check that connection';
			return false;
		}
		const updated = (await res.json().catch(() => null))?.request;
		if (updated) this.sshRequests = this.sshRequests.map((r) => (r.id === id ? updated : r));
		return true;
	}

	/** Withdraw an ask; the card goes with it. */
	async deleteSshRequest(id: string) {
		await this.req(`/api/ssh/${id}`, { method: 'DELETE' });
		this.sshRequests = this.sshRequests.filter((r) => r.id !== id);
	}

	/** Re-read the asks still waiting on the human; the cards hang off these rows. */
	async refreshAsks() {
		const res = await this.req('/api/asks').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		this.asks = data.asks ?? [];
	}

	/** The human's ruling on an ask; the card flips to the verdict. */
	async resolveAsk(id: string, approve: boolean) {
		const res = await this.req(`/api/asks/${id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not answer that request';
			return false;
		}
		const updated = await res.json().catch(() => null);
		if (updated) this.asks = this.asks.filter((r) => r.id !== id);
		return true;
	}



	async rate(messageId: string, rating: number) {
		const msg = this.messages.find((m) => m.id === messageId);
		if (!msg) return;
		const next = msg.rating === rating ? 0 : rating;
		const before = msg.rating;
		msg.rating = next;
		const res = await this.req(`/api/messages/${messageId}/rate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ rating: next })
		}).catch(() => null);
		// A refused or lost vote must not stay lit: the server kept the old one.
		if (!res?.ok) msg.rating = before;
	}

	async refreshActivities() {
		const bot = this.panelBot;
		if (!bot) {
			this.activities = [];
			this.routines = [];
			this.wakes = [];
			this.waits = [];
			return;
		}
		try {
			const res = await this.req(`/api/bots/${bot.id}`);
			// The panel may have moved to another bot - or another chat - while
			// this was in flight; writing now would hang the old bot's log on it.
			if (this.panelBot?.id !== bot.id) return;
			if (res?.ok) {
				const data = await res.json();
				this.activities = data.activities;
				this.routines = data.routines;
				// The same read carries the bot's token meter, which moves as turns
				// run - so the panel's number follows without a second poll.
				const fresh: Bot = data.bot;
				if (fresh) {
					this.bots = this.bots.map((b) => (b.id === fresh.id ? fresh : b));
					this.activeBots = this.activeBots.map((b) => (b.id === fresh.id ? fresh : b));
				}
			}
			// A pending wake or wait will start a turn later, so the panel shows it
			// and lets you call it off.
			const pending = await this.req(`/api/wakes?bot_id=${encodeURIComponent(bot.id)}`);
			if (this.panelBot?.id !== bot.id) return;
			if (pending?.ok) {
				const data = await pending.json();
				this.wakes = data.wakes;
				this.waits = data.waits;
			}
		} catch {
			// A network blip leaves the last snapshot up; the next poll retries.
		}
	}

	async createRoutine(input: {
		bot_id: string;
		conversation_id: string;
		name: string;
		prompt: string;
		interval_min: number;
		cron?: string;
	}) {
		const res = await this.req('/api/routines', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input)
		});
		if (res?.ok) {
			await this.refreshActivities();
			return true;
		}
		return false;
	}

	/**
	 * Save an edit to a routine. The panel re-reads the bot afterwards, the same
	 * path a new routine takes, so the row shows what was actually stored. A
	 * refused save comes back as the reason to show, leaving the row untouched.
	 */
	async updateRoutine(
		id: string,
		input: { prompt: string; interval_min: number; cron: string; enabled: boolean }
	): Promise<string | null> {
		const res = await this.req(`/api/routines/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input)
		});
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			return body?.message ?? `Could not save that (${res?.status ?? 'offline'})`;
		}
		await this.refreshActivities();
		return null;
	}

	/**
	 * The human's ruling on a routine the police refused: "Approve anyway" on a
	 * row whose attempts ran out. The panel re-reads the bot afterwards, the
	 * same path a toggle takes, so the row shows what was actually stored.
	 */
	async approveRoutine(id: string, approve: boolean) {
		const res = await this.req(`/api/routines/${id}/approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve })
		});
		if (res?.ok) await this.refreshActivities();
		return !!res?.ok;
	}

	/**
	 * The human's ruling on a wake the police refused: "Approve anyway" on a
	 * row whose attempts ran out. The panel re-reads the bot afterwards, the
	 * same path a routine ruling takes, so the row shows what was stored.
	 */
	async approveWake(id: string, approve: boolean) {
		const res = await this.req(`/api/wakes/${id}/approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve })
		});
		if (res?.ok) await this.refreshActivities();
		return !!res?.ok;
	}

	async deleteRoutine(id: string) {
		await this.req(`/api/routines/${id}`, { method: 'DELETE' });
		this.routines = this.routines.filter((r) => r.id !== id);
	}

	/** Call off a wake or a wait before it fires. One route handles both. */
	async cancelPending(id: string) {
		await this.req(`/api/wakes/${id}`, { method: 'DELETE' });
		this.wakes = this.wakes.filter((w) => w.id !== id);
		this.waits = this.waits.filter((w) => w.id !== id);
	}

	async toggleRoutine(r: Routine) {
		await this.req(`/api/routines/${r.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled: !r.enabled })
		});
		this.routines = this.routines.map((x) =>
			x.id === r.id ? { ...x, enabled: x.enabled ? 0 : 1 } : x
		);
	}

	async loadPlugins() {
		const res = await this.req('/api/plugins');
		if (res?.ok) this.plugins = (await res.json()).plugins;
	}

	async createPlugin(input: {
		name: string;
		description: string;
		kind: 'tool' | 'hook';
		hook_point?: string;
		parameters?: string;
		code: string;
		author_bot_id?: string;
		scope: 'bot' | 'shared';
	}) {
		const res = await this.req('/api/plugins', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input)
		});
		if (res?.ok) {
			await this.loadPlugins();
			return true;
		}
		return false;
	}

	async togglePlugin(id: string, enabled: boolean) {
		const res = await this.req(`/api/plugins/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled })
		});
		if (!res?.ok) {
			// The route can refuse the flip - a refusal the police wrote stands
			// until the human rules on it - so the lists are read back rather
			// than left showing a switch the server never moved.
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? `Could not change that plugin (${res?.status ?? 'offline'})`;
			await this.reloadPluginLists();
			return false;
		}
		this.error = '';
		this.plugins = this.plugins.map((p) =>
			p.id === id ? { ...p, enabled: enabled ? 1 : 0 } : p
		);
		return true;
	}

	/** Both lists, from the rows themselves: what a failed toggle falls back to. */
	private async reloadPluginLists() {
		await this.loadPlugins();
		const bot = this.panelBot;
		if (bot) await this.loadBotPlugins(bot.id);
	}

	/**
	 * Send an unreviewed plugin to the police now: the "not reviewed" chip's
	 * click. The officer's verdict is written to the row and comes back with
	 * it, so both lists show what was decided rather than the state they were
	 * in when the click was made.
	 */
	async reviewPluginNow(id: string) {
		const res = await this.req(`/api/plugins/${id}/review`, { method: 'POST' });
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? `Could not reach the police (${res?.status ?? 'offline'})`;
			return false;
		}
		this.error = '';
		// Both lists from the rows themselves: the verdict the review stored,
		// and the effective state each bot's switch has to show for it.
		await this.reloadPluginLists();
		return true;
	}

	async deletePlugin(id: string) {
		await this.req(`/api/plugins/${id}`, { method: 'DELETE' });
		this.plugins = this.plugins.filter((p) => p.id !== id);
		this.botPlugins = this.botPlugins.filter((p) => p.id !== id);
	}

	/**
	 * The human's ruling on a plugin the police refused: "Approve anyway" on a
	 * card whose attempts ran out. The row comes back from the route, so both
	 * lists show the verdict it actually stored.
	 */
	async approvePlugin(id: string, approve: boolean) {
		const res = await this.req(`/api/plugins/${id}/approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve })
		});
		if (!res?.ok) return false;
		const updated: Plugin = await res.json();
		this.plugins = this.plugins.map((p) => (p.id === id ? { ...p, ...updated } : p));
		this.botPlugins = this.botPlugins.map((p) => (p.id === id ? { ...p, ...updated } : p));
		return true;
	}

	async updatePlugin(
		id: string,
		patch: { name?: string; code?: string; enabled?: boolean; icon_svg?: string }
	) {
		const res = await this.req(`/api/plugins/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		});
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? `Could not save plugin (${res?.status ?? 'offline'})`;
			return false;
		}
		const updated: Plugin = await res.json();
		this.error = '';
		this.plugins = this.plugins.map((p) => (p.id === id ? { ...p, ...updated } : p));
		this.botPlugins = this.botPlugins.map((p) => (p.id === id ? { ...p, ...updated } : p));
		return true;
	}

	async loadBotPlugins(botId: string) {
		const res = await this.req(`/api/bots/${botId}/plugins`);
		// The panel may have moved to another bot while this was in flight.
		if (this.panelBot?.id !== botId) return;
		if (res?.ok) this.botPlugins = (await res.json()).plugins;
	}

	async toggleBotPlugin(botId: string, pluginId: string, enabled: boolean) {
		const res = await this.req(`/api/bots/${botId}/plugins`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ plugin_id: pluginId, enabled })
		});
		if (!res?.ok) {
			// Same guard as the plugin's own switch: a refusal the police wrote
			// is not overridden by a bot's preference, so the row is read back
			// rather than the knob left showing a state the server refused.
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? `Could not change that plugin (${res?.status ?? 'offline'})`;
			await this.loadBotPlugins(botId);
			return false;
		}
		this.error = '';
		this.botPlugins = this.botPlugins.map((p) =>
			p.id === pluginId ? { ...p, effective_enabled: enabled ? 1 : 0 } : p
		);
		return true;
	}

	get runningTasks(): Task[] {
		return this.tasks.filter((t) => t.status === 'running');
	}

	/** Work in flight anywhere the header should glow about: running turns, or a bot at its computer. */
	get busyTasks(): number {
		return this.runningTasks.length + (this.botWorking ? 1 : 0);
	}

	/** True while this conversation has work in flight. */
	get streaming(): boolean {
		return this.runningTasks.length > 0;
	}

	/** The bot currently mid-reply, for the typing indicator. */
	get streamingBotId(): string {
		return this.runningTasks[0]?.bot_id ?? '';
	}

	/** True while a secret is being handed over inline in the thread. */
	secretDraft = $state(false);
	secretNote = $state('');

	/** Give the active bot a secret; it lands as its own bubble in the thread. */
	async giveSecret(botId: string, name: string, value: string) {
		this.secretNote = 'storing…';
		const res = await this.req(`/api/bots/${botId}/secrets`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, value, conversation_id: this.activeId })
		}).catch(() => null);
		if (!res?.ok) {
			const err = await res?.json().catch(() => null);
			this.secretNote = err?.message ?? 'could not store that';
			return false;
		}
		const data = await res.json().catch(() => null);
		// The secret is in the vault either way; the sandbox is warmed in the
		// background and `use_secret` injects on demand.
		this.secretNote = `stored — ${data?.name ?? 'the secret'} is ready`;
		if (this.activeId) await this.refetchMessages();
		this.secretDraft = false;
		// The handover lands as a message, so the sidebar preview is stale until
		// this list is re-read.
		void this.refreshConversations();
		return true;
	}

	/** Delete a message outright, for good. */
	async deleteMessage(id: string) {
		const res = await this.req(`/api/messages/${id}`, { method: 'DELETE' }).catch(() => null);
		if (!res?.ok) return;
		this.messages = this.messages.filter((m) => m.id !== id);
		void this.refreshConversations();
	}

	
	/** The human's verdict on a bot's proposed persona. */
	async approvePersona(botId: string, approve: boolean) {
		const action = approve ? 'approve' : 'deny';
		const res = await this.req(`/api/bots/${botId}/persona`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not answer that proposal';
			return false;
		}
		const bot: Bot = await res.json();
		this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
		this.activeBots = this.activeBots.map((b) => (b.id === bot.id ? bot : b));
		return true;
	}

/** Save one crayon stroke as a bitmap mark. */
	async saveMark(dataUrl: string): Promise<boolean> {
		const convId = this.activeId;
		if (!convId) return false;
		const res = await this.req(`/api/conversations/${convId}/board`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ dataUrl })
		}).catch(() => null);
		if (!res?.ok) return false;
		const data = await res.json().catch(() => null);
		// A stroke saved for the room it was drawn in must not land on the
		// board of whichever chat the reader has since opened.
		if (data?.mark && this.activeId === convId) this.marks = [...this.marks, data.mark];
		return true;
	}

	/** Rub a mark off the board. */
	async rubOffMark(id: string) {
		const res = await this.req(`/api/board/${id}`, { method: 'DELETE' }).catch(() => null);
		if (res?.ok) this.marks = this.marks.filter((m) => m.id !== id);
	}

	/** Drop a burger onto the lounge gym's table. */
	async dropBurger(): Promise<boolean> {
		const convId = this.activeId;
		if (!convId) return false;
		const res = await this.req(`/api/conversations/${convId}/gym`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'drop_burger' })
		}).catch(() => null);
		return !!res?.ok;
	}

	/** React to a message as the user. Passing '' takes the reaction back. */
	async reactTo(m: Message, emoji: string) {
		const mine = (this.reactions[m.id] ?? []).find((r) => r.actor === '');
		const next = mine?.emoji === emoji ? '' : emoji;
		const res = await this.req(`/api/messages/${m.id}/react`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emoji: next })
		});
		if (!res?.ok) return;
		const rest = (this.reactions[m.id] ?? []).filter((r) => r.actor !== '');
		this.reactions = {
			...this.reactions,
			[m.id]: next ? [...rest, { id: `local-${m.id}`, message_id: m.id, actor: '', emoji: next, created_at: Date.now() }] : rest
		};
	}

	/** Put words in a bot's mouth inside a bots-only room. */
	async inject(botId: string | undefined, content: string, mode: 'as_bot' | 'director' = 'as_bot') {
		if (!this.activeId) return;
		const res = await this.req(`/api/conversations/${this.activeId}/inject`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bot_id: botId, content, mode })
		});
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not drop that in';
			return;
		}
		// Re-read the room, then collect the reaction.
		await this.reloadThread();
		await this.pollTasks();
		this.watchTasks();
	}

	/** Stop one task by id. */
	async cancelTask(id: string) {
		const res = await this.req(`/api/tasks/${id}`, { method: 'DELETE' }).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			this.error = body?.message ?? 'could not stop that task';
			return;
		}
		await this.pollTasks();
	}

	/** Stop every task still working in this conversation. */
	async stop() {
		const running = this.runningTasks;
		await Promise.all(
			running.map((t) => this.req(`/api/tasks/${t.id}`, { method: 'DELETE' }))
		);
		await this.pollTasks();
	}

	async send(content: string): Promise<boolean> {
		// Sending while a turn runs is deliberate: the old task keeps working and
		// a new one starts alongside it.
		const text = content.trim();
		const convId = this.activeId;
		if (!text || !convId) return false;
		this.error = '';
		// The message being answered rides as its own column, not in the words:
		// the bot reads the same transcript it would have read anyway.
		const quoted = this.quoteDraft;
		const localId = `local-${crypto.randomUUID()}`;
		this.messages = [
			...this.messages,
			{
				id: localId,
				conversation_id: convId,
				role: 'user',
				bot_id: '',
				content: text,
				model: '',
				rating: 0,
				kind: '',
				reply_to: quoted?.id ?? '',
				created_at: Date.now()
			}
		];
		this.touchActive(text);
		// A refused send must not leave its optimistic bubble behind - the row
		// was never stored, so showing it reads as a delivered message.
		const sent = await this.dispatch({ content: text, reply_to: quoted?.id });
		if (!sent.ok) {
			this.messages = this.messages.filter((m) => m.id !== localId);
			return false;
		}
		sndSend();
		// The quote went with it; a refusal keeps it so the ask can be retried.
		if (this.quoteDraft === quoted) this.quoteDraft = null;
		// This line steered a turn that was already running: mark the bubble the
		// human is looking at and, by the id the server gave, the stored row it
		// becomes - so the mark is on the right line whether the row lands before
		// or after this reply. A reader who moved chats mid-send holds neither,
		// and the update is simply a no-op for them.
		if (sent.steeredId) this.markSteered(localId, sent.steeredId);
		// The cold-storage refusal is part of this send's answer: put it in the
		// thread now, so the reader is told at once rather than on a later poll.
		// A poll that beat the response to it already added the row - and a
		// reader who switched chats mid-send never gets another room's note.
		if (
			sent.note &&
			this.activeId === convId &&
			!this.messages.some((m) => m.id === sent.note!.id)
		) {
			this.messages = [...this.messages, sent.note];
		}
		return true;
	}
	/** Send a message to a specific conversation, not the active one. */
	async sendTo(conversationId: string, content: string): Promise<boolean> {
		const text = content.trim();
		if (!text) return false;
		const res = await this.req('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ conversation_id: conversationId, content: text })
		});
		return res?.ok ?? false;
	}

	/** Send a message that branches a new subtask instead of steering the
	    running turn - the old task keeps working, the new one starts beside it. */
	async sendBranch(content: string): Promise<boolean> {
		const text = content.trim();
		const convId = this.activeId;
		if (!text || !convId) return false;
		const res = await this.req('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ conversation_id: convId, content: text, branch: true })
		});
		return res?.ok ?? false;
	}

	/** Delete a conversation and drop it from the list. */
	async deleteConversation(id: string): Promise<boolean> {
		const res = await this.req(`/api/conversations/${id}`, { method: 'DELETE' });
		if (!res?.ok && res?.status !== 204) return false;
		this.conversations = this.conversations.filter((c) => c.id !== id);
		if (this.activeId === id) this.activeId = this.conversations[0]?.id ?? '';
		return true;
	}


	async regenerate(message: Message) {
		const convId = this.activeId;
		if (!convId) return;
		this.error = '';
		const index = this.messages.findIndex((m) => m.id === message.id);
		this.messages = this.messages.filter((m) => m.id !== message.id);
		const sent = await this.dispatch({
			regenerate: true,
			bot_id: message.bot_id,
			message_id: message.id
		});
		// A refused regenerate deleted nothing on the server, so the answer it
		// was replacing goes back where it was rather than vanishing from view.
		if (!sent.ok && index >= 0 && this.activeId === convId) {
			const restored = [...this.messages];
			restored.splice(Math.min(index, restored.length), 0, message);
			this.messages = restored;
		}
	}

	/** Drop a message from the model's context (or put it back). */
	async toggleExcluded(m: Message) {
		const next = !m.excluded;
		const res = await this.req(`/api/messages/${m.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ excluded: next })
		});
		if (res?.ok) {
			this.messages = this.messages.map((x) =>
				x.id === m.id ? { ...x, excluded: next ? 1 : 0 } : x
			);
		}
	}

	/** Collapse the backlog into the summary and start a fresh topic. */
	async newTopic() {
		if (!this.activeId || this.streaming) return;
		const res = await this.req(`/api/conversations/${this.activeId}/new-topic`, {
			method: 'POST'
		});
		if (res?.ok) await this.select(this.activeId);
	}

	/** Re-read the chat list (badges, snippets, ordering). */
	private async refreshConversations() {
		const res = await this.req('/api/conversations').catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		const seen = this.conversations.find((c) => c.id === this.activeId)?.unread;
		this.conversations = data.conversations;
		// We are looking at it, so it stays read even though the server just
		// counted the new message as unread.
		if (this.activeId && seen) void this.markRead(this.activeId);
	}

	/**
	 * Re-read the open thread's message window. The limit follows how much the
	 * reader has paged in, so a refresh never drops history they asked for -
	 * and never fetches more than that either.
	 */
	private async refetchMessages() {
		const id = this.activeId;
		if (!id) return;
		const limit = Math.max(this.messages.length, 200);
		const res = await this.req(`/api/conversations/${id}?limit=${limit}`).catch(() => null);
		if (!res?.ok || this.activeId !== id) return;
		const body = await res?.json().catch(() => null);
		if (!body || this.activeId !== id) return;
		this.messages = this.mergeThread(id, body.messages);
		this.hasMoreMessages = body.has_more ?? false;
	}
	/** Debounced side fetches after reloadThread so one burst of updates costs one round trip each. */
	private scheduleMetaRefresh() {
		clearTimeout(this.metaRefreshTimer);
		this.metaRefreshTimer = setTimeout(() => {
			void this.refreshBots();
			void this.refreshBotProposals();
			void this.refreshSshRequests();
			void this.refreshAsks();
		}, META_REFRESH_MS);
	}

	/** Re-read the open thread (messages, reactions, notes, board marks). */
	private reloadThread(): Promise<void> {
		if (this.reloadThreadInflight) return this.reloadThreadInflight;
		this.reloadThreadInflight = this.reloadThreadOnce().finally(() => {
			this.reloadThreadInflight = null;
		});
		return this.reloadThreadInflight;
	}

	private async reloadThreadOnce() {
		const id = this.activeId;
		if (!id) return;
		const limit = Math.max(this.messages.length, 200);
		const res = await this.req(`/api/conversations/${id}?limit=${limit}`).catch(() => null);
		if (!res?.ok || this.activeId !== id) return;
		const body = await res?.json().catch(() => null);
		if (!body || this.activeId !== id) return;
		this.messages = this.mergeThread(id, body.messages);
		this.hasMoreMessages = body.has_more ?? false;
		this.reactions = body.reactions ?? {};
		this.notes = body.notes ?? [];
		this.marks = body.marks ?? [];
		this.scheduleMetaRefresh();
	}

	/**
	 * Pick up writes made by other clients. The conversation list is the cheap
	 * signal: a message bumps its `updated_at`, so when the open chat's stamp
	 * moves past the newest message this tab holds, the thread is re-read.
	 * Reports whether anything changed, which is what resets the poll's backoff.
	 */
	private async syncFromServer(): Promise<boolean> {
		const id = this.activeId;
		const before = id ? this.conversations.find((c) => c.id === id)?.updated_at : undefined;
		await this.refreshConversations();
		if (!id || this.activeId !== id) return false;
		const after = this.conversations.find((c) => c.id === id)?.updated_at;
		const newestLocal = Math.max(
			0,
			...this.messages.filter((m) => !m.id.startsWith('local-')).map((m) => m.created_at)
		);
		if (after !== undefined && after !== before && after > newestLocal) {
			await this.reloadThread();
			return true;
		}
		return false;
	}


	/** Bump the chat list entry so its snippet and ordering stay current. */
	private touchActive(snippet: string) {
		const id = this.activeId;
		const text = snippet.replace(/\s+/g, ' ').trim();
		this.conversations = this.conversations
			.map((c) =>
				c.id === id ? { ...c, last_message: text || c.last_message, updated_at: Date.now() } : c
			)
			.sort((a, b) => b.updated_at - a.updated_at);
	}

	/** Hand the reply to the server as a background task and start watching. */
	private async dispatch(opts: {
		content?: string;
		regenerate?: boolean;
		bot_id?: string;
		message_id?: string;
		reply_to?: string;
	}): Promise<{ ok: boolean; note?: Message; steeredId?: string }> {
		let body: {
			archived?: boolean;
			note?: Message;
			tasks?: { steered?: boolean; message_id?: string }[];
		} | null = null;
		try {
			const res = await this.req('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					conversation_id: this.activeId,
					content: opts.content,
					regenerate: opts.regenerate,
					message_id: opts.message_id,
					bot_id: opts.bot_id,
					reply_to: opts.reply_to,
					think: this.think
				})
			});
			if (!res?.ok) {
				const failure = await res?.json().catch(() => null);
				throw new Error(failure?.message ?? `Request failed (${res?.status ?? 'offline'})`);
			}
			body = await res.json().catch(() => null);
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'request failed';
			return { ok: false };
		}
		await this.pollTasks();
		this.watchTasks();
		// A task that came back `steered` names the human's own line: that is what
		// the caller marks, and it is the id the server holds, not a guess from
		// the words the human typed.
		const steered = body?.tasks?.find((t) => t.steered === true);
		return {
			ok: true,
			note: body?.archived ? body.note : undefined,
			steeredId: steered?.message_id ?? ''
		};
	}

	/** Poll while anything is running; stop as soon as the conversation is idle. */
	private taskPollDelayMs() {
		return this.taskStream && this.runningTasks.length ? TASK_POLL_LIVE_MS : TASK_POLL_MS;
	}

	private watchTasks() {
		clearTimeout(this.taskTimer);
		const tick = () => {
			void this.pollTasks().then(() => {
				if (!this.runningTasks.length) {
					this.taskTimer = undefined;
					return;
				}
				this.taskTimer = setTimeout(tick, this.taskPollDelayMs());
			});
		};
		this.taskTimer = setTimeout(tick, this.taskPollDelayMs());
	}

	/**
	 * Refresh the task list. When a task has finished since the last look, reload
	 * the thread so its persisted message replaces the live preview - and, when it
	 * failed, say so in the thread instead of leaving the ask unanswered.
	 */
	async pollTasks() {
		const convId = this.activeId;
		if (!convId) return;
		const res = await this.req(`/api/tasks?conversation_id=${convId}`).catch(() => null);
		if (!res?.ok) return;
		const data = await res.json().catch(() => null);
		if (!data) return;
		// The reply may belong to a conversation the user has since left.
		if (this.activeId !== convId) return;
		this.tasks = data.tasks;
		// A task the poll reports as no longer running has no partial to show:
		// the finished message (or the failure) replaces it, and a stale partial
		// must never be left looking like a reply that landed. Ids the poll does
		// not know belong to another conversation and are left alone.
		for (const t of this.tasks) {
			if (t.status !== 'running') this.dropPreview(t.id);
		}
		const previous = this.taskSnapshots.get(convId);
		this.taskSnapshots.set(convId, new Map(this.tasks.map((t) => [t.id, t.status])));
		// The first look at a conversation only baselines it: a failure from before
		// the reader arrived must not be replayed as if it had just happened.
		const finished = previous
			? this.tasks.filter((t) => t.status !== 'running' && previous.get(t.id) !== t.status)
			: [];
		const failed = finished.filter((t) => t.status === 'error');
		if (failed.length) {
			this.error = failed
				.map((t) => `${this.botById(t.bot_id)?.name ?? 'bot'}: ${t.error || 'the reply failed'}`)
				.join('\n');
			sndError();
		} else if (finished.length) {
			sndDone();
		}
		if (finished.length) {
			void this.refreshConversations();
			// A finished turn has just moved its bot's token meter; pick that up
			// now rather than at the next idle poll. It may also have left a
			// style proposal, or a pitch for a new bot, waiting on the human.
			void this.refreshActivities();
			void this.refreshBots();
			void this.refreshBotProposals();
			const lastBefore = this.messages.at(-1)?.content ?? '';
			await this.reloadThread();
			this.touchActive(this.messages.at(-1)?.content ?? lastBefore);
		}
	}

	/** Take back a look the human approved. */
	async revertLook(botId: string, what: 'css' | 'avatar') {
		const res = await this.req(`/api/bots/${botId}/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revert: true }) }).catch(() => null);
		if (!res?.ok) { const body = await res?.json().catch(() => null); this.error = body?.message ?? 'could not revert that'; return false; }
		const bot: Bot = await res.json();
		this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
		this.activeBots = this.activeBots.map((b) => (b.id === bot.id ? bot : b));
		return true;
	}

}

export function pausedUntilOf(bot: Bot | undefined): number {
	const until = (bot as unknown as { paused_until?: number })?.paused_until;
	return typeof until === 'number' && until > Date.now() ? until : 0;
}

export const chat = new ChatStore();

/**
 * The named bubble themes a bot has been given, read from the JSON on its row.
 * Junk, or a shape that is not a list of themes, reads as none - the same
 * tolerance a stored style blob gets, so a bad value can never take the chat
 * down. Lives beside the store because the renderer, the tests and the
 * proposal card all need one answer to "what can this bot wear".
 */
export function bubbleThemesOf(bot: Pick<Bot, 'bubble_themes'> | undefined): BubbleTheme[] {
	if (!bot?.bubble_themes) return [];
	try {
		const parsed = JSON.parse(bot.bubble_themes);
		return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.name === 'string') : [];
	} catch {
		return [];
	}
}

/**
 * A bot's custom-bubble directive, alone on a message's first line. The name is
 * read case-insensitively, the same way a bot's own name is everywhere else, so
 * a model that capitalises it still gets the theme it meant.
 */
const BUBBLE_DIRECTIVE_RE = /^\[\[bubble:([A-Za-z0-9][A-Za-z0-9_-]{0,23})\]\]\s*\n?/;

/**
 * Whitespace collapsed and clipped - the one line a preview or a quote stands
 * for. Shared so the thread, the composer's reply bar and the chat list all
 * cut at the same place rather than each choosing their own.
 */
export function oneLine(text: string, max = 90): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	// Cut on code points, not UTF-16 units: slicing mid-surrogate-pair leaves a
	// lone surrogate that renders as mojibake at the end of the preview.
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/**
 * A message's text as the thread shows it: runs of blank lines collapse to
 * one. `white-space: pre-wrap` renders every newline literally, so a message
 * that is mostly blank lines - a paste gone wrong, or a bot padding the
 * transcript - otherwise becomes a bubble taller than the screen. Two
 * newlines still read as a paragraph break; the stored text and what Copy
 * hands over are untouched.
 */
export function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * A message's custom bubble: the theme it asks for, and the text to render.
 *
 * The directive is honoured only when it names one of that bot's approved
 * themes. Then it is stripped and the theme applies to this bubble alone. A
 * message from anyone else, or a name the bot does not have - a typo, or a
 * theme the human declined - is left exactly as it was typed: nothing is
 * stripped, and the directive stays visible so the mistake reads as a mistake
 * rather than silently becoming plain text.
 */
export function bubbleLook(
	content: string,
	themes: BubbleTheme[]
): { theme: BubbleTheme | null; text: string } {
	const match = BUBBLE_DIRECTIVE_RE.exec(content);
	if (!match) return { theme: null, text: content };
	const theme = themes.find((t) => t.name === match[1].toLowerCase()) ?? null;
	if (!theme) return { theme: null, text: content };
	return { theme, text: content.slice(match[0].length) };
}
