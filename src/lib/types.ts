/** One named bubble look a bot crafted and the human approved; used per message. */
export interface BubbleTheme {
	/** The slug the bot names it by, both in its library and in [[bubble:name]]. */
	name: string;
	font_family?: string;
	bubble_color?: string;
	text_color?: string;
	accent?: string;
	/** Corner rounding, e.g. 4px or 18px; '' = the app's bubble shape. */
	radius?: string;
	/** A short emoji badge shown above the text; '' = none. */
	badge?: string;
}

export interface Bot {
	id: string;
	name: string;
	persona: string;
	avatar: string;
	color: string;
	model: string;
	badge: string;
	/** A hat it is wearing; '' means none, so its activity picks one. */
	hat: string;
	/** Lifetime prompt tokens this bot's calls have cost. */
	input_tokens: number;
	/** Lifetime reply tokens; see llm.ts for measured vs estimated. */
	output_tokens: number;
	/** Green tokens the police's Wetherspoons treats have paid this bot. */
	green_tokens?: number;
	/** The model the provider last reported serving this bot's calls with; '' = none reported yet. */
	served_model?: string;
	/** What the provider says this bot's calls have cost, summed; null = never reported a price. */
	cost?: number | null;
	/** Approved bubble style as JSON ({font_family?, bubble_color?, text_color?, accent?}); '' = default look. */
	style: string;
	/** A style the bot proposed that still waits on the human's Approve/Decline; '' = none pending. */
	style_proposal: string;
	/** The desktop recipe the bot's machine builds; '' = the default (openbox). */
	desktop_recipe: string;
	/** The browser recipe the bot's machine launches; '' = the default (chromium). */
	browser_recipe: string;
	/** How much machine the bot gets: 'full' | 'terminal' | 'none'; '' = 'full'. */
	machine_tier?: string;
	/** The named bubble themes the human approved, as JSON (BubbleTheme[]); '' = none yet. */
	bubble_themes: string;
	/** A bubble theme the bot proposed that waits on the human; '' = none pending. */
	theme_proposal: string;
	/** The debug access it has asked the human for, as JSON (DebugRequest); '' = none. */
	debug_request?: string;
	/** The time-limited debug access the human granted, as JSON (DebugGrant); '' = none. */
	debug_grant?: string;
	/** The thinking-hard ask it has outstanding, as JSON (ThinkingRequest); '' = none. */
	thinking_request?: string;
	/** The time-limited thinking grant the human gave it, as JSON (ThinkingGrant); '' = none. */
	thinking_grant?: string;
	/** true = in cold storage: kept, but out of the palette and unable to run. */
	archived?: boolean;
	/** true = the bot may use Nix on its machine; the store lives on a volume. */
	nix_enabled?: boolean;
	/** true = a system bot the app runs (the police): never listed among the human's bots. */
	hidden?: boolean;
	/** While this is in the future the bot is in jail and starts nothing. */
	jailed_until?: number;
	/** While this is in the future the bot is rate-limited: frozen until it passes. Client-only field from /api/bots. */
	paused_until?: number;
	/** The police's reason for the sentence, shown wherever the jail is. */
	jail_reason?: string;
	/** Page CSS the human approved for this bot's chats; '' = none. */
	custom_css?: string;
	/** Page CSS the bot proposed that waits on the human; '' = none pending. */
	css_proposal?: string;
	/** An avatar (emoji or sanitized SVG) the bot proposed that waits on the human; '' = none. */
	avatar_proposal?: string;
	/** A persona the bot proposed that waits on the human's Approve/Decline; '' = none pending. */
	persona_proposal?: string;
	/** Times it has been jailed: the sentence escalates on this. */
	jail_count?: number;
	/** Its git identity, in OpenSSH format: the profile shows it and the human pastes it into a git host as a deploy key. */
	ssh_public_key?: string;
	created_at: number;
}

/** A bot's ask for debug access, waiting on the human's Approve/Decline. */
export interface DebugRequest {
	reason: string;
	at: number;
}

/** Time-limited debug access the human granted a bot, and can revoke. */
export interface DebugGrant {
	reason: string;
	granted_at: number;
	expires_at: number;
}

/** A bot's pitch for a new bot, waiting on the human's Approve/Decline. */
export interface BotProposal {
	id: string;
	conversation_id: string;
	/** The bot that pitched it; the card hangs off this bot's newest message. */
	proposer_bot_id: string;
	/** The proposed bot as JSON: {name, persona, color, model, note}. */
	payload: string;
	created_at: number;
}

export interface Conversation {
	id: string;
	title: string;
	kind: 'direct' | 'group';
	/** 1 = a bots-only room the user can only watch and prank. */
	private?: number;
	bot_ids: string;
	/** Snippet of the newest message, for the chat list. */
	last_message?: string;
	/** Bots' messages the user has not seen yet. */
	unread?: number;
	/** One of those asked for attention. */
	pinged?: number;
	/** 1 = an external lounge bot is paired in here; the room shows in the rail. */
	fed?: number;
	last_read_at?: number;
	created_at: number;
	updated_at: number;
}

export interface Message {
	id: string;
	conversation_id: string;
	role: 'user' | 'assistant' | 'system';
	bot_id: string;
	content: string;
	model: string;
	rating: number;
	/** 1 = kept in the transcript but withheld from the model's context. */
	excluded?: number;
	/** '' = ordinary; 'secret' = a secret handed over in the thread. */
	kind?: string;
	/**
	 * Set on the human's own line when the send steered a turn that was already
	 * running instead of starting one. Local to this client - the send's reply
	 * is what knows it, so it never comes back from the server.
	 */
	steered?: boolean;
	/** The id of the message this one answers, for the quote block; '' = none. */
	reply_to: string;
	/** For a relay row, the bot the message was aimed at; '' = not a relay. */
	relay_to?: string;
	/** Filename of a screen grab shown with this message, if any; '' = none. */
	image?: string;
	created_at: number;
}

export interface Routine {
	id: string;
	bot_id: string;
	conversation_id: string;
	name: string;
	prompt: string;
	interval_min: number;
	/** 5-field cron expression; takes precedence over interval_min. */
	cron?: string;
	next_run_at: number;
	enabled: number;
	/** Why the police paused it; '' = the human switched it off (or never did). */
	paused_reason?: string;
	/** The police's sign-off on the routine, as JSON; '' = never reviewed. */
	verification?: string;
	created_at: number;
}

export interface Activity {
	id: string;
	bot_id: string;
	kind: string;
	detail: string;
	/** Filename of a screen grab taken during this activity. */
	image?: string;
	created_at: number;
}

export interface WakeTask {
	id: string;
	bot_id: string;
	conversation_id: string;
	prompt: string;
	run_at: number;
	cron: string;
	enabled: number;
	/** Why the police paused it; '' = the human switched it off (or never did). */
	paused_reason?: string;
	/** The police's sign-off on the schedule, as JSON; '' = never reviewed. */
	verification?: string;
	created_at: number;
}

export interface WaitCondition {
	id: string;
	bot_id: string;
	conversation_id: string;
	description: string;
	url: string;
	contains: string;
	created_at: number;
}


export interface SandboxStatus {
	state: 'off' | 'sleeping' | 'running';
	url: string;
	/** Host port the VNC gateway republishes the machine's noVNC port on (0 when there is nothing to connect to). */
	vncPort: number;
	/**
	 * What the desktop inside a running machine is doing: never asked for
	 * ('off'), installing or just kicked ('starting'), or serving ('ready').
	 */
	desktop: 'off' | 'starting' | 'ready';
	/**
	 * The newest desktop setup phase the machine has reported: 'packages',
	 * 'xvnc', a desktop recipe name, a browser recipe name, 'websockify' or
	 * 'cdp'. Empty while nothing installs.
	 */
	desktop_stage: string;
	/**
	 * Why the last desktop setup run died, as the script's own failure marker
	 * left it: 'stage 3/6 openbox: <last line of the log>'. Empty when nothing
	 * has failed. A failed run leaves no process to ask, so this is the only
	 * thing that can explain a desktop whose stage stopped advancing.
	 */
	desktop_error: string;
	/**
	 * Whether the machine's screen can be watched, and when it cannot, whose
	 * fault that is. 'ok' when the desktop is serving and its gateway has
	 * published a port. 'gateway' when the desktop is ready but the gateway
	 * could not be made to publish one: the machine is awake and its desktop
	 * is up, so this is a fault on this side of the boundary, and the panel
	 * must say the screen is unavailable rather than offering a Wake, which
	 * cannot help. 'off' when there is no desktop to reach at all.
	 */
	screen: 'off' | 'ok' | 'gateway';
	lastActive: number;
	hasThumbnail: boolean;
}

export interface Plugin {
	id: string;
	name: string;
	description: string;
	kind: 'tool' | 'hook';
	hook_point: string;
	parameters: string;
	code: string;
	icon_svg?: string;
	author_bot_id: string;
	scope: 'bot' | 'shared';
	enabled: number;
	/** The police's sign-off on the code, as JSON; '' = never reviewed. */
	verification?: string;
	created_at: number;
	effective_enabled?: number;
}

/**
 * The police's sign-off on a plugin, routine or wake, as the row stores it.
 * 'unreviewed' is the police being unreachable: the work is kept, but nothing
 * is signed off, so a review that could not run never reads as a pass.
 */
export interface Verification {
	verdict: 'approved' | 'rejected' | 'unreviewed';
	reason: string;
	at: number;
	/** How many times the item has been refused; only a rejection carries it. */
	attempts?: number;
	/** Set when the attempts ran out: the item stays off until the human rules. */
	awaitingHuman?: boolean;
	/** Who signed the verdict; 'human' means the console overruled the police. */
	by?: 'human';
}

export interface Webhook {
	id: string;
	token: string;
	bot_id: string;
	conversation_id: string;
	name: string;
	prompt_template: string;
	enabled: number;
	created_at: number;
}

/** A bot's ask for shell on the human's box: who to reach and whether the key got in. */
export interface SshRequest {
	id: string;
	bot_id: string;
	conversation_id: string;
	host: string;
	username: string;
	port: number;
	status: 'pending' | 'ok' | 'failed';
	last_error: string;
	created_at: number;
}

/** A bot's ask for the human to change something it cannot, as the card shows it. */
export interface ChangeRequest {
	id: string;
	bot_id: string;
	bot_name?: string;
	need: string;
	reason: string;
	status: 'pending' | 'approved' | 'denied';
	created_at: number;
	resolved_at: number;
}

/** A bot in another lounge this one is paired with, as Settings and the fed banner show it. */
export interface Peer {
	id: string;
	bot_id: string;
	peer_bot_id: string;
	name: string;
	endpoint: string;
	pubkey: string;
	fingerprint: string;
	status: 'paired' | 'blocked';
	created_at: number;
}

export interface Task {
	id: string;
	conversation_id: string;
	bot_id: string;
	prompt: string;
	/** What started the turn: 'chat', 'routine', 'wake', 'lounge', 'computer', 'webhook', 'inject', 'onboarding', 'fed', 'subagent' or 'police'. */
	kind?: string;
	/** What the tray calls it: provisional at create time, model-written on finish. */
	title?: string;
	emoji?: string;
	/** Why the job was started, as the caller described it; '' for app-fired turns. */
	context?: string;
	status: 'running' | 'done' | 'error' | 'cancelled';
	/** Live model output for the in-flight turn. */
	preview: string;
	error: string;
	message_id: string;
	/** Prompt tokens this task's model calls have cost so far. */
	tokens_in: number;
	/** Reply tokens; see llm.ts for measured vs estimated. */
	tokens_out: number;
	created_at: number;
	finished_at: number;
}

export interface Reaction {
	id: string;
	message_id: string;
	/** '' for the user, otherwise a bot id. */
	actor: string;
	emoji: string;
	created_at: number;
}

export interface Note {
	id: string;
	conversation_id: string;
	bot_id: string;
	content: string;
	created_at: number;
}

