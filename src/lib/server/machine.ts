import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	directConversationWith,
	getBot,
	latestActivityByBot,
	listActivityImages,
	listBots,
	listMessageImages,
	logActivity,
	logEvent,
	recordExecSample,
	updateBot
} from './db';
import { config } from './config';
import {
	CURSOR_HOTSPOT,
	CURSOR_PATH,
	CURSOR_SIZE,
	CURSOR_THEME,
	THEME_DIR,
	botPalette,
	sandboxSkin,
	tarEntry,
	wallpaperCommand
} from './sandbox-theme';
// The ad blocker every bot's browser loads. It is kept as real extension files
// rather than as strings in here, so the manifest and the rule list can be read
// and diffed like any other extension; the desktop script writes these exact
// bytes into the machine (see ADBLOCK_FILES).
//
// The `with { type: 'json' }` attribute is not decoration: mcp-bridge.mjs loads
// these modules under plain `node` through its own resolve hook, and Node
// refuses a JSON import without it. Vite accepts the attribute too, so one form
// serves both loaders.
import adblockManifest from './adblock/manifest.json' with { type: 'json' };
import adblockRules from './adblock/rules.json' with { type: 'json' };
import {
	COMPANY_VOLUME,
	dockerExec,
	dockerExecDetached,
	dockerRequest,
	ensureAuditWatcher,
	isRunning,
	positiveEnv,
	nixVolume,
	shareVolume,
	type ContainerInfo
} from './docker';
import {
	EGRESS_NAME,
	EGRESS_PORT,
	EGRESS_URL,
	WEBSOCKIFY_PORT,
	attachedLiveNetworks,
	dropDeadNetworks,
	egressEnabled,
	egressIpOn,
	ensureMachineNetwork,
	ensureVncGateway,
	machineEnv,
	networkAttachments,
	removeMachineNetwork,
	vncGatewayPort
} from './machine-net';
// A cycle on purpose: ssh-keys installs the bot's key with a machineExec, and
// this module installs it on every wake. Both sides only call into the other
// at run time, so the module-level bindings are never read before they exist.
import { materializeBotKey } from './ssh-keys';
import {
	allFiles as listMountFiles,
	readFile as readMountFile,
	writeFile as writeMountFile
} from './mounts';
import { ensureCompanyProfile } from './profiles';
// secrets.ts calls machineExec, so this is a run-time-only cycle like
// ssh-keys: the binding is read inside the function, never at module level.
import { redactEverySecret } from './secrets';
// The base toolset list lives in machine-packages.ts so the prompts that name
// it never touch this heavily-mocked module.
import { MACHINE_PACKAGES } from './machine-packages';

/**
 * The per-bot machine: ONE Alpine container that is both of the bot's
 * computers. The tmux session inside it is the "non desktop" the user watches
 * and the bot types into; the desktop - Xvnc, a window manager, a browser and
 * a websockify/noVNC front end - is installed on demand from a recipe the bot
 * picked. Everything goes through the Docker exec API; there is no agent or
 * REST server inside the container.
 *
 * The network is the boundary. Each machine lives on its own `internal`
 * Docker network - no gateway, so no route to this app, the host, the LAN,
 * or another bot's machine - and its only members are the egress proxy,
 * which answers CONNECT and plain-HTTP requests to public addresses on any
 * port and refuses every private address, and the bot's VNC gateway, a
 * one-port forwarder that republishes the machine's websockify on this host's
 * loopback. The proxy env vars the machine is created with are what curl,
 * apk, git, Node's fetch and the browser use.
 *
 * This module supersedes the two-container model (agent-infra sandbox plus a
 * separate shell box). The old obl-sandbox and obl-shellbox containers are
 * removed the first time a bot's machine is ensured, and the reaper stops any
 * it still finds.
 */

const IMAGE = process.env.MACHINE_IMAGE ?? 'alpine:latest';

/**
 * How long a machine may sit unused before it is slept, in minutes. Exported
 * so a bot can be told what governs its own container, read-only: the window is
 * the operator's, and a bot that wants its machine down sooner can sleep it.
 */
export const IDLE_MINUTES = Math.max(1, positiveEnv('SANDBOX_IDLE_MINUTES', 15));
const IDLE_MS = IDLE_MINUTES * 60_000;
/** Ceiling on one command inside a machine. */
const MACHINE_EXEC_TIMEOUT_MS = positiveEnv('SANDBOX_EXEC_TIMEOUT_MS', 120_000);
/** Ceiling on installing tmux + the base toolset the first time a box comes up. */
const MACHINE_SETUP_TIMEOUT_MS = 300_000;
/** Ceiling on installing the desktop recipe; apk is slow the first time. */
const DESKTOP_SETUP_TIMEOUT_MS = 300_000;
/** Ceiling on one screen grab; a wedged shell must not hold the caller. */
const SCREENSHOT_TIMEOUT_MS = 30_000;
/**
 * How long a reader container may exist before the reaper treats it as
 * abandoned. A reader lives for the length of one file read - well under a
 * second - so minutes-old is unambiguous, and the margin is what keeps the
 * sweep off a reader that is still being read.
 */
const READER_GRACE_MS = 5 * 60_000;
/** Where a capture is written inside the container; /tmp goes with the container. */
const SCREENSHOT_PATH = '/tmp/obl-screen.png';
/** The tmux session everything happens in. */
const SESSION = 'obl';
/** The X display the desktop lives on; VNC serves it on 5900 + display. */
export const DISPLAY = ':1';
/**
 * The files Xvnc leaves behind on DISPLAY: the pid lock and the unix socket.
 * Both live in /tmp, which survives a container stop, so a machine that slept
 * with its desktop up wakes to a lock naming a pid some other process now
 * owns - and Xvnc refuses to start on a display it reads as taken. Anything
 * that stops the container or starts Xvnc clears them first.
 */
const X_LOCKS = `/tmp/.X${DISPLAY.slice(1)}-lock /tmp/.X11-unix/X${DISPLAY.slice(1)}`;
/**
 * The environment every tmux command runs with. tmux refuses to run without a
 * TERM, and docker exec provides none. DISPLAY rides along so the session
 * inherits it: a pane opened later, or one that outlives a re-attach, still
 * finds the display the desktop is really on.
 */
const TMUX_ENV = ['TERM=xterm-256color', `DISPLAY=${DISPLAY}`];
/** How far back the screen endpoint reads, in pane lines. */
const SCREEN_LINES = 2000;
/**
 * Where the bots' browser driver lives. Patchright - Playwright's patched,
 * undetected driver - installed under the name `playwright`, so a bot's
 * existing Playwright code drives this box's Chromium without knowing
 * anything changed.
 */
const PW_DIR = '/opt/pw';
/**
 * Scrollback a machine's session keeps, set before the session exists so its
 * first pane copies it (a pane takes the value at creation).
 */
const SESSION_HISTORY = 5000;
/** The pane's start script: prints the banner, sets the prompt, execs the shell. */
const START_SCRIPT = '/usr/local/bin/obl-shell';
/**
 * Escape sequences `capture-pane -e` leaves in front of styled text (CSI plus
 * the two-character escapes). Stripped, never interpreted: the only thing it
 * is used for is telling a row that prints nothing from a painted one.
 */
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
/** The line a finished command leaves behind: `~~OBL:<nonce>:<exit>~~`. */
const MARK = '~~OBL:';
const VNC_PORT = 5901;
/** Where the browser's CDP endpoint listens (localhost inside the container). */
const CDP_PORT = 9222;
/**
 * Where the desktop script unpacks the ad blocker. Chromium reads
 * `--load-extension` once, at launch, so the extension has to be on disk before
 * the browser phase starts - which is why the script writes it rather than the
 * app, whose only look inside the container is an exec the browser never waits
 * for.
 */
const ADBLOCK_DIR = '/tmp/obl-adblock';
/** Sentinel the desktop script touches once the desktop is up. */
const DESKTOP_READY = '/tmp/obl-desktop-ready';

/**
 * Where the desktop script leaves one marker per phase it starts, so a slow
 * first install can be narrated instead of guessed at. Each phase echoes
 * `__OBL_STAGE_<n>:<label>__` into this file (stdout goes nowhere - the script
 * runs detached); the status probe cats the file alongside its own probe and
 * speaks each marker the log has not heard yet.
 */
const STAGE_FILE = '/tmp/obl-stage';
/** Separates the stage markers from the probe's own one-word answer. */
const PROBE_SPLIT = '__OBL_PROBE__';

/**
 * Where the desktop script writes everything it and its phases print. It
 * matters that this is a file inside the machine rather than the container's
 * stdout: the script runs detached through the Docker API, so stdout goes
 * nowhere anybody reads, and a phase that died used to take its own error
 * message with it.
 */
const DESKTOP_LOG = '/tmp/obl-desktop.log';

/**
 * A process check that does not count a corpse. PID 1 in these containers is
 * `sleep infinity`, which reaps nothing, so a process that died once stays in
 * the process table as a zombie for the life of the container - and pgrep
 * counts a zombie as running. That is how the machine lost its taskbar: tint2
 * died, every setup run afterwards read its corpse as a live panel and skipped
 * starting it, and the screen was left as a bare X root with one maximised
 * window and no explanation anywhere.
 *
 * The pattern MUST be written `[x]rest`, the way the probes already write
 * theirs: a `sh -lc` one-liner carries its own pattern text on its command
 * line, so without the bracket the check matches itself and always says yes.
 */
const ALIVE_FN = `obl_alive() { ps -o stat=,args= | grep -v '^Z' | grep -q "$1"; }`;

/** `${ALIVE_FN}` applied to one `[x]rest` pattern. */
const alive = (pattern: string) => `obl_alive '${pattern}'`;

/**
 * The line the setup script leaves in the stage file when a phase fails:
 * `__OBL_STAGE_FAIL:<stage>:<label>:<last line of the log>__`. The script exits
 * right after writing it, so it is the terminal marker of that run - the whole
 * difference between a desktop whose stage quietly stops advancing and one that
 * says what killed it.
 */
const STAGE_FAIL_RE = /__OBL_STAGE_FAIL:(\d+):([^:]*):(.*?)__/;

/** A failure marker as the panel, the log and the status payload read it. */
const stageFailText = (m: RegExpMatchArray) => `stage ${m[1]}/6 ${m[2]}: ${m[3]}`;

/** Values that switch the boot orphan sweep off, however they are spelled. */
const SWEEP_OFF: Record<string, true> = { false: true, '0': true, no: true, off: true };

/**
 * What a bot's machine is doing: no container exists at all ('off'), one is
 * stopped ('sleeping'), or it is up ('running').
 */
export type MachineState = 'off' | 'sleeping' | 'running';

interface MachineStatus {
	state: MachineState;
	/** The machine's old in-network URL, kept for API compatibility; unreachable now that machine networks are internal. */
	url: string;
	/** Host port the bot's VNC gateway republishes the machine's noVNC port on; 0 while the desktop is down. */
	vncPort: number;
	/**
	 * What the desktop inside a running machine is doing: nothing asked for it
	 * ('off'), its setup script is installing or was just kicked ('starting'),
	 * or Xvnc + websockify are serving ('ready'). 'off' machines report 'off'.
	 */
	desktop: 'off' | 'starting' | 'ready';
	/**
	 * The newest setup phase the desktop script has reached, named as it
	 * echoes its markers - 'packages', 'xvnc', 'websockify', a recipe name, the
	 * browser's, or 'cdp'. Empty until the script has begun, blank again once
	 * the box is serving: the phase is only worth reading while it installs.
	 */
	desktop_stage: string;
	/**
	 * Why the last desktop setup run died, in the words of its own failure
	 * marker: 'stage 3/6 openbox: <last line of the log>'. Empty when nothing
	 * has failed. It stays reported whatever the desktop state is, because a
	 * run that died leaves nothing else to ask about it.
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
	/** True when a previously captured screen image exists. */
	hasThumbnail: boolean;
}

const lastActive: Record<string, number> = {};

/**
 * Mark the bot's machine as in use. Anything that watches or drives the
 * machine calls this - a status poll from an open panel counts as activity,
 * or the reaper would sleep a machine someone is looking at and the next
 * poll would recreate its tmux session, wiping the scrollback.
 */
export function touchMachine(botId: string): void {
	lastActive[botId] = Date.now();
}

/** The last state the panel reported for a bot's screen: hands off (false) or on it. */
const humanDriving: Record<string, boolean> = {};

/**
 * Record the human taking over - or letting go of - a bot's machine, and tell
 * the bot once per real flip. The screen panel reports every flip it makes,
 * including the collapse-driven releases, and a second browser tab or a viewer
 * reconnect can report a state the bot has already heard about; the record
 * makes those no-ops, so the DM carries one event per handover, not one per
 * click. A bot nobody has reported on reads as hands-off.
 */
export function setHumanDriving(botId: string, driving: boolean): void {
	if ((humanDriving[botId] ?? false) === driving) return;
	humanDriving[botId] = driving;
	logEvent(
		directConversationWith(botId)?.id ?? '',
		botId,
		'control',
		driving ? 'The human took control of your computer.' : 'The human handed your computer back.'
	);
	// The takeover is the moment the bot's own driving becomes a story to
	// tell: whatever it did on the machine up to now is handed back to it as
	// one event, so it can answer "what were you doing" from the record
	// rather than guessing. The record then restarts empty under the human's
	// hands.
	if (driving) flushDrivingReport(botId, directConversationWith(botId)?.id ?? '');
}

// ------------------------------------------------- bot activity while driving

/**
 * One thing the bot did on its machine, kept so a human who takes the screen
 * over can be told what the bot was up to when it was driving. `kind` is the
 * tool that did it ('shell' for both exec flavours, the gesture name for
 * desktop input); `title` is the focused window's title after the action,
 * when the machine would say.
 */
interface DrivingAct {
	at: number;
	kind: string;
	say: string;
	title: string;
}

/** Each machine's recent acts, oldest first. */
const drivingActs: Record<string, DrivingAct[]> = {};

/**
 * How many acts one machine remembers. Long enough to cover a real task,
 * bounded so a bot that drives all day cannot grow the record without end -
 * the oldest acts fall off, which is also what a human asking "what were you
 * doing" wants least.
 */
const DRIVING_LOG_MAX = 60;

/**
 * The focused window's title, or '' when the desktop cannot say (no window
 * manager up, xdotool missing). Never throws: a title is a nice-to-have on
 * the record, never worth failing the action it followed.
 */
async function activeWindowTitle(name: string): Promise<string> {
	const res = await dockerExec(name, ['xdotool', 'getactivewindow', 'getwindowname'], {
		timeoutMs: 4000,
		env: [`DISPLAY=${DISPLAY}`]
	}).catch(() => ({ output: '', exitCode: -1 }));
	return res.exitCode === 0 ? res.output.trim().slice(0, 120) : '';
}

/**
 * Put one bot action on the machine's driving record. Runs are deduplicated
 * against the previous act only - a bot clicking the same spot twice did
 * click twice, but a burst of identical scrolls or moves is one act drawn
 * out, and the report reads better without the stutter.
 */
export function recordDriving(botId: string, kind: string, say: string, title = ''): void {
	const acts = (drivingActs[botId] ??= []);
	const last = acts[acts.length - 1];
	if (last && last.kind === kind && last.say === say && last.title === title) return;
	acts.push({ at: Date.now(), kind, say, title });
	if (acts.length > DRIVING_LOG_MAX) acts.splice(0, acts.length - DRIVING_LOG_MAX);
}

/**
 * The acts since the last report, grouped into one short line each. A run of
 * acts under one window title folds into `pressed Return, clicked at (10, 20)
 * [in "Terminal"]` so the bot reads where it was, not a title per gesture.
 * Secret values are masked before they reach the bot's transcript, the same
 * treatment the tool result itself gets.
 */
function drivingReport(acts: DrivingAct[]): string {
	const lines: string[] = [];
	let run: string[] = [];
	let runTitle = '';
	const endRun = () => {
		if (!run.length) return;
		lines.push(run.join(', ') + (runTitle ? ` [in "${runTitle}"]` : ''));
		run = [];
	};
	for (const act of acts) {
		if (act.title !== runTitle) {
			endRun();
			runTitle = act.title;
		}
		run.push(act.say);
	}
	endRun();
	return redactEverySecret(lines.join('\n'));
}

/**
 * Hand the bot the record of what it did while it was driving, then start a
 * fresh one. Called when the human takes the machine over: the report rides
 * the same DM event as the handover itself, so the bot learns both at once.
 * Nothing recorded, nothing said - a bot that never touched the machine has
 * no homework to read back.
 */
function flushDrivingReport(botId: string, conversationId: string): void {
	const acts = drivingActs[botId];
	drivingActs[botId] = [];
	if (!acts?.length) return;
	const report = drivingReport(acts);
	if (!report) return;
	logEvent(
		conversationId,
		botId,
		'control',
		`While you were driving, you did this:\n${report}`
	);
}

export const machineName = (botId: string) => `obl-machine-${botId.slice(0, 12)}`;

/** The container names earlier versions gave this bot's machines. */
const legacyNames = (botId: string) => [
	`obl-sandbox-${botId.slice(0, 12)}`,
	`obl-shellbox-${botId.slice(0, 12)}`,
	`obl-kali-${botId.slice(0, 12)}`
];

async function findContainer(botId: string): Promise<ContainerInfo | null> {
	const res = await dockerRequest(
		'GET',
		`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: [machineName(botId)] }))}`
	);
	if (res.status !== 200) return null;
	const list = JSON.parse(res.body.toString()) as ContainerInfo[];
	return list[0] ?? null;
}

/** Every container this bot owns, whatever kind the label says it is. */
async function botContainers(botId: string): Promise<ContainerInfo[]> {
	const res = await dockerRequest(
		'GET',
		`/containers/json?all=1&filters=${encodeURIComponent(
			JSON.stringify({ label: [`obl.bot=${botId}`] })
		)}`
	).catch(() => null);
	if (!res || res.status !== 200) return [];
	try {
		return JSON.parse(res.body.toString()) as ContainerInfo[];
	} catch {
		return [];
	}
}

/** Every managed container Docker knows about, running or not. */
async function listManaged(): Promise<ContainerInfo[]> {
	const res = await dockerRequest(
		'GET',
		`/containers/json?all=1&filters=${encodeURIComponent(
			JSON.stringify({ label: ['obl.managed=true'] })
		)}`
	).catch(() => null);
	if (!res || res.status !== 200) return [];
	try {
		return JSON.parse(res.body.toString()) as ContainerInfo[];
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------ recipes

/**
 * A desktop recipe: the apk packages that make a desktop, and the command that
 * brings it up on DISPLAY. Only recipes verified to launch on alpine:latest
 * belong here - a bot picks from this list, it does not write its own.
 */
export interface DesktopRecipe {
	/** The recipe's name, as the stage markers and the recipes API name it. */
	name: string;
	label: string;
	packages: string[];
	/**
	 * Shell lines run with DISPLAY set, after Xvnc is up - inside the setup
	 * script, so they may use its `obl_alive`, and must never fall back to a
	 * bare pgrep: that counts a dead process's zombie as alive, which is how a
	 * killed panel came to look like a running one forever.
	 */
	start: string;
	/**
	 * A process pattern - the shape pgrep takes, a name or a regex over the
	 * command line - matching the desktop's main process. The setup script
	 * skips a start line whose process is already alive and the status probe
	 * tells a serving desktop from a bare X server, both by matching it against
	 * the process table with `obl_alive`, which ignores zombies.
	 */
	proc: string;
	/**
	 * The recipe's panel or taskbar, where it has one of its own: the status
	 * probe watches it, so a panel that died is restarted by the setup script
	 * instead of leaving a bare screen that reads as a healthy desktop. Leave
	 * it unset for a recipe that draws its own bars (icewm does).
	 */
	panel?: string;
}

export const DESKTOP_RECIPES: Record<string, DesktopRecipe> = {
	openbox: {
		name: 'openbox',
		label: 'Openbox - a plain window manager with a taskbar and a terminal',
		packages: ['openbox', 'xterm', 'tint2'],
		// Every guard is the setup script's `obl_alive` rather than pgrep, and
		// the panel's is the one that matters: tint2 that died once is a zombie
		// in a container whose PID 1 never reaps, so a pgrep guard reads the
		// corpse as a running panel and never starts it again - which is a
		// screen with no taskbar that no run of this script would ever fix.
		start:
			`${alive('[o]penbox')} || openbox-session &\n` +
			'sleep 1\n' +
			`${alive('[t]int2')} || tint2 &\n` +
			`${alive('[x]term')} || xterm &`,
		proc: 'openbox',
		panel: 'tint2'
	},
	xfce: {
		name: 'xfce',
		label: 'XFCE - a full desktop environment',
		packages: ['xfce4', 'xfce4-terminal', 'dbus'],
		start: `${alive('[x]fce4-session')} || dbus-launch --exit-with-session startxfce4 &`,
		proc: 'xfce4-session',
		panel: 'xfce4-panel'
	},
	icewm: {
		name: 'icewm',
		label: 'IceWM - a light desktop with a start menu and taskbar',
		packages: ['icewm'],
		start: `${alive('[i]cewm')} || icewm-session &`,
		proc: 'icewm'
	}
};

/**
 * A browser recipe: the apk packages and the command that launches it on
 * DISPLAY. `cdp` marks browsers the CDP driver can steer; the rest are opened
 * by exec'ing the binary with a URL and read through the framebuffer - which
 * reads the binary off the first word of `start`, so `start` is the launch
 * command and nothing else. The setup script adds the already-running guard
 * from `proc` itself.
 */
export interface BrowserRecipe {
	/** The recipe's name, as the stage markers and the recipes API name it. */
	name: string;
	label: string;
	packages: string[];
	start: string;
	cdp: boolean;
	/** A process pattern matching the browser's main process; see DesktopRecipe.proc. */
	proc: string;
}

export const BROWSER_RECIPES: Record<string, BrowserRecipe> = {
	chromium: {
		name: 'chromium',
		label: 'Chromium - the default; the bot can drive it properly',
		packages: ['chromium'],
		start:
			`chromium --user-data-dir=/tmp/obl-chrome --no-sandbox --disable-gpu ` +
			`--disable-dev-shm-usage --no-first-run --no-default-browser-check ` +
			// Chrome used to draw two notices of its own over the screen the
			// panel shows: the "unsupported command-line flag" infobar that
			// --no-sandbox earns, silenced by --test-type, and the crash-restore
			// bubble left behind by every run this app kills, hidden by
			// --hide-crash-restore-bubble. Neither was ever the bot's page.
			`--test-type --hide-crash-restore-bubble ` +
			// The ad blocker, forced on: the desktop script writes the unpacked
			// extension to ADBLOCK_DIR before this line runs, and Chromium reads
			// --load-extension once, at launch. It is a plain Chromium build, so
			// the switch is not the one Google Chrome ignores.
			`--load-extension=${ADBLOCK_DIR} ` +
			// Translate, the optimization-hints fetch and the media router are
			// three background services a bot never asks for; each one is a
			// request the machine makes on its own. The extension system itself
			// is left alone - the ad blocker is an extension.
			`--disable-features=Translate,OptimizationHints,MediaRouter ` +
			// The machine's network is internal; the egress proxy is the only
			// way out, and Chromium does not read the env vars on its own.
			`--proxy-server=${EGRESS_URL} ` +
			`--remote-debugging-port=${CDP_PORT} --start-maximized ` +
			// The setup script writes this page in the bot's own colour and
			// picture; about:blank left the screen a blank white sheet until a
			// task happened to navigate somewhere.
			`file:///tmp/obl-start.html &`,
		cdp: true,
		proc: 'chromium.*obl-chrome'
	},
	firefox: {
		name: 'firefox',
		label: 'Firefox - works, but the bot can only open pages, not read them',
		packages: ['firefox'],
		start: 'firefox file:///tmp/obl-start.html &',

		cdp: false,
		proc: 'firefox'
	}
};

export const DEFAULT_DESKTOP_RECIPE = 'openbox';
export const DEFAULT_BROWSER_RECIPE = 'chromium';

/** The recipe a bot's desktop uses; an unknown or unset name reads as the default. */
export function desktopRecipeFor(botId: string): DesktopRecipe {
	const name = getBot(botId)?.desktop_recipe ?? '';
	return DESKTOP_RECIPES[name] ?? DESKTOP_RECIPES[DEFAULT_DESKTOP_RECIPE];
}

export function browserRecipeFor(botId: string): BrowserRecipe {
	const name = getBot(botId)?.browser_recipe ?? '';
	return BROWSER_RECIPES[name] ?? BROWSER_RECIPES[DEFAULT_BROWSER_RECIPE];
}

/**
 * How much machine a bot gets: 'full' builds the desktop, 'terminal' gets the
 * container but no desktop, 'none' is a chat-only bot that never gets a
 * container. '' reads as 'full' - every bot made before the column was.
 */
export function machineTier(botId: string): 'full' | 'terminal' | 'none' {
	const tier = getBot(botId)?.machine_tier ?? '';
	return tier === 'terminal' || tier === 'none' ? tier : 'full';
}

// ---------------------------------------------------------------- lifecycle

/** Creates in flight, per bot - the same overlap guard the old sandbox used. */
const waking = new Map<string, Promise<string>>();

/**
 * Key installs in flight, per bot. The install execs into the machine, and
 * that exec wakes the machine back through `ensureMachine` - the flag is what
 * stops the inner wake from starting a second install, and from the install
 * waiting on itself.
 */
const keyInstalls = new Set<string>();

/**
 * The container id whose machine each bot's key was last installed into. A
 * key only has to land once per container: the copies on /shared and in the
 * writable layer both survive a stop, and a recreated container gets a new
 * id, which is what re-triggers the install. Without this guard every exec
 * re-ran the install, so a turn's worth of shell commands each carried the
 * bot's private key through the exec log.
 */
const keyInstalledFor: Record<string, string> = {};

async function installKey(botId: string, containerId: string): Promise<void> {
	if (keyInstalledFor[botId] === containerId) return;
	if (keyInstalls.has(botId)) return;
	keyInstalls.add(botId);
	try {
		// Only a verified install counts: a machine that refused the key
		// retries on the next exec rather than staying keyless until a rebuild.
		if (await materializeBotKey(botId)) keyInstalledFor[botId] = containerId;
	} finally {
		keyInstalls.delete(botId);
	}
}

/** Ensure the bot's machine is running; returns its container name. */
export function ensureMachine(botId: string): Promise<string> {
	const inFlight = waking.get(botId);
	if (inFlight) return inFlight;
	const attempt = ensureMachineOnce(botId)
		.finally(() => {
			// Cleared before the key install: the install's own exec wakes the
			// machine back through this function, and must not be handed this
			// promise - it would be waiting on itself.
			waking.delete(botId);
		})
		.then(async (up) => {
			// Awaited, not fired and forgotten: the first command a bot runs
			// after a wake can be the git push the key is for.
			await installKey(botId, up.id);
			return up.name;
		});
	waking.set(botId, attempt);
	return attempt;
}

async function ensureMachineOnce(botId: string): Promise<{ name: string; id: string }> {
	// A chat-only bot has no machine to ensure: refuse rather than build one.
	if (machineTier(botId) === 'none') {
		throw new Error('this bot has no machine - it was made chat-only');
	}
	const name = machineName(botId);
	// The machine's own internal network: no gateway, so no route to the app,
	// the host, the LAN, or another bot's machine. The egress proxy is the
	// only other member and the only way out. Creating it first means a
	// container is never attached to the shared app network.
	const network = await ensureMachineNetwork(botId);
	let c = await findContainer(botId);
	// A machine created before `Init` reaps nothing: every desktop process that
	// exits - the taskbar, the browser, a crashed X - stays a zombie, and a
	// zombie is what the liveness guards read as alive, so a dead taskbar stays
	// dead for the life of the container. Init only applies at create, so such a
	// machine is rebuilt. The check reads the inspect, not the list endpoint,
	// which does not carry HostConfig. Docker omits `Init` entirely when it was
	// never set, so anything but a true value counts as unreaping - but only
	// when the body really is an inspect (it always carries Id), and a request
	// that failed at all leaves the container alone: mistaking a dead socket for
	// an old container would throw away a running machine on every wake.
	const unreaping = await dockerRequest('GET', `/containers/${c?.Id ?? ''}/json`)
		.then((res) => {
			if (res.status !== 200) return false;
			const info = JSON.parse(res.body.toString()) as {
				Id?: string;
				HostConfig?: { Init?: boolean };
			};
			return typeof info.Id === 'string' && info.HostConfig?.Init !== true;
		})
		.catch(() => false);
	// What the container is attached to, by name. Null means the inspect could
	// not be read at all - a dead socket or a container that vanished since the
	// list - which is treated as "rebuild" rather than "attached to nothing".
	const attachments = c ? await networkAttachments(c.Id) : null;
	if (
		c &&
		(unreaping ||
			attachments === null ||
			// Attached to anything that is not this machine's own network - the
			// shared app network, say - means the boundary does not hold, so the
			// container is recreated rather than re-attached: env vars and Init
			// only apply at create, and the writable layer is disposable.
			// Zero attachments is NOT this case: a running container whose
			// network was deleted under it is re-attached below, not rebuilt.
			Object.keys(attachments).some((n) => n !== network))
	) {
		await dockerRequest('POST', `/containers/${c.Id}/stop`).catch(() => {});
		await dockerRequest('DELETE', `/containers/${c.Id}?force=1`).catch(() => {});
		c = null;
	}
	if (!c) {
		// The container is about to name this network in NetworkMode; a create
		// that ran while the network was absent - or a create that never ran
		// at all - would leave the machine on no network, running but unable
		// to resolve anything. Refuse rather than build that.
		const net = await dockerRequest('GET', `/networks/${network}`).catch(() => null);
		if (!net || net.status !== 200) {
			throw new Error(`machine network ${network} does not exist`);
		}
		logActivity(botId, 'sandbox', 'Creating the machine container');
		const res = await dockerRequest('POST', `/containers/create?name=${name}`, {
			Image: IMAGE,
			// The box idles between commands; tmux inside it holds the session.
			// The box is the bot's: its hostname is the bot's name, so a prompt
			// or a `hostname` call reads as theirs rather than a container hash.
			Hostname: (getBot(botId)?.name ?? 'bot')
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, '-')
				.replace(/^-+|-+$/g, '') || 'bot',
			Cmd: ['sleep', 'infinity'],
			Env: ['OBL_MACHINE=machine', ...machineEnv()],
			HostConfig: {
				// The boundary is the internal network plus the egress proxy, not
				// the kernel filter: the default seccomp profile stays on, and
				// Chromium runs --no-sandbox inside it.
				NetworkMode: network,
				// OS-level confinement on top of the network boundary. Docker's
				// default seccomp stays on; what is added here is the capability
				// drop, no-new-privileges and an AppArmor profile, so a process
				// inside cannot reach the host's Docker socket, another
				// container, or anything else through the kernel rather than the
				// proxy. The capabilities kept are the ones the desktop needs
				// and no more; each one names why.
				CapDrop: ['ALL'],
				CapAdd: [
					// The base of every desktop process, including Xvnc: bind
					// sockets (the websockify/VNC listeners) and read /proc.
					'CHOWN',
					'DAC_OVERRIDE',
					'FOWNER',
					'SETGID',
					'SETUID',
					'NET_BIND_SERVICE',
					'NET_RAW',
					'SYS_PTRACE',
					'MKNOD',
					// Chromium's own renderer sandbox (which --no-sandbox is
					// what keeps *off* here) needs to change namespaces at
					// process start; without these a desktop chromium dies at
					// spawn rather than just running unsandboxed.
					'SYS_ADMIN',
					'SYS_CHROOT'
				],
				// A setuid binary inside the machine cannot hand a shell more
				// power than the box already has: nothing here legitimately
				// escalates, and the box's root is only ever this container's.
				SecurityOpt: ['no-new-privileges'],
				// AppArmor is the MAC layer the host has (no SELinux here). The
				// profile is the one this app ships: obl-machine.profile, to be
				// loaded into the daemon's policy kit with `apparmor_parser -r`
				// before the first machine is created; until then Docker runs
				// the container unconfined, which is exactly what the
				// capability drop and no-new-privileges above are already
				// covering.
				AppArmorProfile: 'obl-machine',
				// /shared is this bot's own drive; /company is the one drive
				// every bot's machines share. A Nix-enabled bot gets a third:
				// the store lives on its own volume so what it installs
				// survives a rebuild.
				Binds: [
					`${shareVolume(botId)}:/shared`,
					`${COMPANY_VOLUME}:/company`,
					...(getBot(botId)?.nix_enabled ? [`${nixVolume(botId)}:/nix`] : [])
				],
				// `sleep infinity` never reaps. Every desktop process that exits
				// - the taskbar, the browser, a crashed X - would otherwise stay
				// a zombie, and a zombie is what pgrep still counts as alive,
				// which is how a dead taskbar stayed dead for the life of the
				// container. Docker's own init at PID 1 collects them. It has to
				// live in HostConfig: a top-level `Init` beside a HostConfig is
				// accepted and then silently ignored.
				Init: true,
				// A machine is one guest on a shared host: without a ceiling a
				// runaway build or a fork bomb starves every other bot's box and
				// the app itself. 2GB and one CPU is roomy for a desktop plus a
				// compile; the police's throttle (limitMachineMemory) tightens
				// the memory cap further when a bot earns it.
				Memory: 2 * 1024 * 1024 * 1024,
				NanoCpus: 1_000_000_000,
				// No PortBindings here on purpose: Docker silently drops a
				// published port on an `internal` network, so the binding for
				// websockify would show up in the container's config and never
				// in NetworkSettings.Ports. The bot's VNC gateway publishes the
				// desktop on loopback instead (ensureVncGateway in machine-net).
				RestartPolicy: { Name: 'unless-stopped' }
			},
			Labels: { 'obl.bot': botId, 'obl.managed': 'true', 'obl.kind': 'machine' }
		});
		if (res.status === 201) {
			const created: { Id: string } = JSON.parse(res.body.toString());
			c = { Id: created.Id, State: 'created', Names: [name] };
		} else if (res.status === 409) {
			// Another caller made it first; their container is the one we want.
			await delay(250);
			c = (await findContainer(botId)) ?? { Id: name, State: 'created', Names: [name] };
		} else if (res.status === 404 || res.body.includes('No such image')) {
			throw new Error(`machine image not pulled: docker pull ${IMAGE}`);
		} else {
			throw new Error(`Docker create failed ${res.status}: ${res.body.slice(0, 200)}`);
		}
	}
	if (!isRunning(c)) {
		// A stopped container keeps the endpoint it was created with. If the
		// network was deleted while the machine was down - Docker Desktop's
		// resyncer does it, and the boot sweep and a bot reset do it on
		// purpose - the ensureMachineNetwork above recreated it under a new
		// id, and the start would die with "failed to set up container
		// networking: network <old id> not found". Drop the dead attachment
		// first, then join the live network once the machine is up: a start
		// that finds no endpoint does not build one from NetworkMode.
		await dropDeadNetworks(c.Id);
		const res = await dockerRequest('POST', `/containers/${c.Id}/start`);
		if (res.status !== 204 && res.status !== 304) {
			throw new Error(`Docker start failed ${res.status}`);
		}
		logActivity(botId, 'sandbox', 'Machine waking up');
	} else {
		// A running container can hold a dead endpoint too: a reset deletes
		// the network out from under it, and the name still reads as attached
		// while the id is gone - the machine keeps running on nothing.
		await dropDeadNetworks(c.Id);
	}
	// However the machine got here - started just now or already running - it
	// must end the wake on the live network. A start that found no endpoint
	// built none, and a running container whose only endpoint was dropped
	// above is on nothing until this connect. Already-attached answers 403
	// and costs nothing, so the check is by live id, not by name.
	if (!(await attachedLiveNetworks(c.Id)).has(network)) {
		await dockerRequest('POST', `/networks/${network}/connect`, {
			Container: c.Id,
			EndpointConfig: { Aliases: [name] }
		}).catch(() => {});
	}
	// The machine's resolver is the egress proxy's forwarder: the internal
	// network gives Docker's own DNS no upstream, so names only resolve through
	// the one neighbour that has a way out. The proxy's name is pinned in
	// /etc/hosts first, or resolv.conf could never reach it by name.
	if (egressEnabled()) {
		const egressIp = await egressIpOn(network);
		if (egressIp) {
			await dockerExec(c.Id, [
				'sh',
				'-c',
				`grep -q '${EGRESS_NAME}' /etc/hosts || echo '${egressIp} ${EGRESS_NAME}' >> /etc/hosts; ` +
					`printf 'nameserver ${egressIp}\\n' > /etc/resolv.conf`
			]).catch(() => {});
		}
	}
	// The bot's page on the /company staff board is seeded the same way: once,
	// best-effort, and never over a page the bot rewrote itself.
	const self = getBot(botId);
	if (self) void ensureCompanyProfile(self).catch(() => {});
	// The /company audit watcher is one shared container, not a process inside
	// each machine; every wake makes sure it is alive. It goes before the tmux
	// setup so a wake that fails later still leaves the drive watched.
	// Best-effort, like the desktop's.
	void ensureAuditWatcher(listBots().map((b) => b.id)).catch(() => {});
	// The desktop is only watchable through the gateway (an internal network
	// cannot publish a port), so a 'full' machine without one is a machine
	// nobody can look at. A failure here is a failed wake on purpose: the
	// panel retries, and a silent half-built machine is worse.
	// The gateway and the tmux boot are independent: one is a sidecar container,
	// the other is work inside the machine. Awaiting them together halves the
	// serial wake time on a 'full' box; a 'terminal' box skips the gateway side.
	const gateway = machineTier(botId) === 'full' ? ensureVncGateway(botId, name, network) : Promise.resolve();
	await Promise.all([gateway, ensureTmux(c.Id, botId)]);
	// The machines this bot had under the two-container model are dead weight
	// now; clear them once, best-effort, the first time the new one is up.
	void removeLegacyContainers(botId).catch(() => {});
	lastActive[botId] = Date.now();
	// The id rides along for installKey: it is what tells a fresh container
	// (new id, empty writable layer) from one that already has the key.
	return { name, id: c.Id };
}

/** Remove the containers the two-container model left behind for this bot. */
async function removeLegacyContainers(botId: string): Promise<void> {
	for (const name of legacyNames(botId)) {
		const res = await dockerRequest(
			'GET',
			`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: [name] }))}`
		).catch(() => null);
		if (!res || res.status !== 200) continue;
		for (const c of JSON.parse(res.body.toString()) as ContainerInfo[]) {
			await dockerRequest('POST', `/containers/${c.Id}/stop`).catch(() => {});
			await dockerRequest('DELETE', `/containers/${c.Id}?force=1`).catch(() => {});
		}
	}
}

/** Boot installs in flight, per container - the same overlap guard waking uses. */
const bootInstalls = new Map<string, Promise<void>>();

/**
 * Make sure the box has tmux and a live session, with the pane ready to look
 * at before anyone types.
 *
 * Overlap guard first: the boot work is per container, and several paths reach
 * it at once - the wake, the status poll's screen repair, a desktop kick. A
 * second racer used to run its own `command -v tmux` while the first's apk was
 * still running, see no tmux, log the install line again and start a second
 * apk; the log showed the same line seven times in ten seconds. Now every
 * latecomer awaits the one install already running, as ensureMachine's `waking`
 * map does for wakes.
 *
 * The session is started with a script rather than by typing the setup into
 * the pane. A typed line is echoed by the shell at whatever width the pane
 * happens to have, so it lands in the scrollback and - once the terminal view
 * resizes the pane to its own grid - reflows into unreadable fragments
 * (`export PS1=…` wrapped mid-word, doubled at every fold). The script prints
 * the banner, sets the prompt and execs the shell, so the pane's first frame
 * is already the finished thing and nothing was ever typed into it.
 *
 * `history-limit` is set before the session exists: a session copies the
 * option when it is created, so setting it afterwards leaves the first pane
 * on tmux's own default and the scrollback the terminal view reads is
 * truncated.
 */
async function ensureTmux(id: string, botId: string): Promise<void> {
	const inFlight = bootInstalls.get(id);
	if (inFlight) {
		// Another caller - a wake, a status poll's screen repair, a desktop
		// kick - is already doing this container's boot work. Waiting on the
		// same work is the whole fix for the activity spam: every racer used to
		// run its own probe, see no tmux yet, log "Installing the toolset" and
		// start a second apk against the same box.
		await inFlight;
		return;
	}
	const attempt = ensureTmuxOnce(id, botId);
	bootInstalls.set(id, attempt);
	try {
		await attempt;
	} finally {
		bootInstalls.delete(id);
	}
}

/** The boot work itself; only ever one of these per container, via ensureTmux. */
async function ensureTmuxOnce(id: string, botId: string): Promise<void> {
	const has = await dockerExec(id, ['sh', '-lc', 'command -v tmux']);
	if (has.exitCode !== 0) {
		// tmux for the session, a ground set of CLI tools (git, curl/wget,
		// python3, nmap, netcat, dig, jq, htop, ssh) so the box is useful out of
		// the gate, and nodejs + npm, which run the plugin harness, the CDP
		// driver and the browser driver below.
		//
		// The line goes before the pull because that is when a watcher needs it,
		// and it is safe to speak there only because the bootInstalls guard
		// above has already collapsed every racer into this one caller: the
		// spam came from each racer logging it before any had installed
		// anything, not from the line being wrong about the work.
		logActivity(botId, 'sandbox', 'Installing the toolset in the machine (apk: tmux, git, python3, nodejs) - first boot takes a few minutes');
		const install = await dockerExec(
			id,
			['sh', '-lc', `apk add --no-cache ${MACHINE_PACKAGES.join(' ')}`],
			{ timeoutMs: MACHINE_SETUP_TIMEOUT_MS }
		);
		if (install.exitCode !== 0) {
			throw new Error(`could not install tmux in the machine: ${install.output.slice(-200)}`);
		}
		logActivity(botId, 'sandbox', 'Toolset installed');
	}
	// The machine's ssh client has to leave through the proxy too, and ssh is
	// the one tool that ignores the proxy environment: on its own it dials the
	// destination directly, finds no route on an internal network, and the bot
	// reads "Network unreachable". A drop-in in the system-wide ssh_config
	// (Alpine's openssh-client includes ssh_config.d/*.conf, and includes it
	// first, so this wins over the file's own defaults) gives every host a
	// ProxyCommand that opens the tunnel instead. The proxy refuses every
	// private destination whatever the port, so a LAN address, the app, or a
	// metadata endpoint is out of reach here exactly as it is over HTTPS; the
	// port is unrestricted, so a public host on any port - not just 22 - is
	// reachable. `nc -X connect` is the openbsd netcat - busybox's nc
	// has no -X, and with only that on the box the drop-in is inert: ssh fails
	// to connect rather than finding a way out the proxy did not open.
	if (egressEnabled()) {
		// A machine built before netcat-openbsd joined the toolset list has only
		// busybox's nc, and the install above is gated on tmux, which that box
		// already has - so the package is fetched here or ssh cannot use the
		// tunnel at all. Best effort: a box with no egress keeps the inert
		// drop-in rather than a failed wake.
		const proxyNc = await dockerExec(id, [
			'sh',
			'-lc',
			'command -v nc >/dev/null && ! nc -X connect 2>&1 | head -n 1 | grep -q unrecognized'
		]).catch(() => null);
		if (proxyNc?.exitCode !== 0) {
			logActivity(botId, 'sandbox', 'Installing netcat-openbsd: the proxy-capable nc ssh needs');
			await dockerExec(id, ['sh', '-lc', 'apk add --no-cache netcat-openbsd'], {
				timeoutMs: MACHINE_SETUP_TIMEOUT_MS
			}).catch(() => {});
		}
		const conf = Buffer.from(
			[
				'# openbotlounge: this machine has no route of its own and ssh',
				'# ignores the proxy environment, so every connection is opened',
				'# through the egress proxy, which allows any port to a public',
				'# host and refuses every private address.',
				'Host *',
				`  ProxyCommand nc -X connect -x ${EGRESS_NAME}:${EGRESS_PORT} %h %p`,
				// OpenSSH would otherwise hand the socket over on a pipe, which
				// the openbsd netcat cannot do.
				'  ProxyUseFdpass no',
				''
			].join('\n'),
			'utf8'
		).toString('base64');
		// cmp first: a wake that changes nothing leaves the file, and its mtime,
		// alone - and the log line is only worth writing when it did change.
		const marker = 'OBL_SSH_PROXY_SET';
		const wrote = await dockerExec(id, [
			'sh',
			'-lc',
			'd=/etc/ssh/ssh_config.d; f=$d/obl-proxy.conf; mkdir -p "$d"; ' +
				`echo ${conf} | base64 -d > "$f.new"; ` +
				`if cmp -s "$f.new" "$f"; then rm -f "$f.new"; else mv "$f.new" "$f"; echo ${marker}; fi`
		]).catch(() => null);
		if (wrote?.output.includes(marker)) {
			logActivity(botId, 'sandbox', 'Machine ssh pointed at the egress proxy');
		}
	}
	// The bot's browser driver. Patchright is a patched Playwright: the same
	// API, minus the CDP-level tells that give automation away, and it drives
	// the Chromium this box already runs instead of downloading one of its own
	// (23MB, about a minute of npm). Installed under the name `playwright` (an
	// npm alias), so bot code that says `require('playwright')` gets the
	// patched driver untouched; the /node_modules symlink lets a script
	// anywhere in the box resolve it, CommonJS or ESM. Attaching with
	// connectOverCDP('http://127.0.0.1:9222') talks to the same browser the
	// desktop shows and the app's own CDP tools (navigate, screenshot, pointer)
	// drive, so neither side is displaced. Runs once per container and is best
	// effort: a box without a driver still has a browser, a desktop and the
	// app's tools, and a container that failed once is not retried on every
	// wake (the marker dies with the container).
	const driverNeeded = await dockerExec(id, [
		'sh',
		'-lc',
		`test -d ${PW_DIR}/node_modules/playwright || test -f ${PW_DIR}/.nodriver`
	]);
	if (driverNeeded.exitCode !== 0) {
		logActivity(botId, 'sandbox', 'Installing the browser driver (npm patchright, about a minute)');
	}
	const driver = await dockerExec(
		id,
		[
			'sh',
			'-lc',
			[
				`if [ -d ${PW_DIR}/node_modules/playwright ]; then`,
				`	ln -sfn ${PW_DIR}/node_modules /node_modules`,
				`elif [ ! -f ${PW_DIR}/.nodriver ]; then`,
				`	mkdir -p ${PW_DIR} && cd ${PW_DIR} || exit 1`,
				`	npm init -y >/dev/null 2>&1`,
				`	if npm install --no-audit --no-fund --loglevel=error patchright playwright@npm:patchright; then`,
				`		ln -sfn ${PW_DIR}/node_modules /node_modules`,
				`	else`,
				`		touch ${PW_DIR}/.nodriver; exit 1`,
				`	fi`,
				`fi`
			].join('\n')
		],
		{ timeoutMs: MACHINE_SETUP_TIMEOUT_MS }
	);
	if (driver.exitCode !== 0) {
		// Worth a line: a bot whose browser code cannot find its driver should
		// not have to guess why.
		logActivity(botId, 'sandbox', 'Browser driver install failed (bots keep the built-in CDP tools)');
	} else if (driverNeeded.exitCode !== 0) {
		logActivity(botId, 'sandbox', 'Browser driver installed');
	}
	// The prompt is the bot's name - the box is theirs, and the terminal should
	// read that way. `$PWD` rather than `\w`: busybox ash expands it, so the
	// prompt works in whatever shell the pane opened.
	const botName = (getBot(botId)?.name ?? 'bot').replace(/[^A-Za-z0-9_-]/g, '') || 'bot';
	// Banner lines stay short: the terminal view can be narrow, and a line that
	// does not fit is a line that wraps.
	const banner = [
		`  ${botName} - Alpine Linux`,
		'  /shared  this machine',
		'  /company all bots (logged)'
	];
	// `/etc/profile` is sourced first so the pane keeps the login shell's
	// environment (PATH, locale, umask); the prompt is set after it, because
	// that is exactly what the profile installs for a login shell. Single
	// quotes around every piece of data: the banner is printed, never parsed.
	// DISPLAY is exported here, after the profile, so the shell a bot types
	// into - and anything it launches - reaches the display the desktop is
	// really on instead of guessing `:0` and hanging on an X server that is
	// not there.
	const start =
		[
			'#!/bin/sh',
			'. /etc/profile 2>/dev/null',
			`export DISPLAY=${DISPLAY}`,
			`printf '%s\\n' ${banner.map((line) => `'${line}'`).join(' ')}`,
			`PS1='${botName}:$PWD $ '`,
			'export PS1',
			'exec /bin/sh'
		].join('\n') + '\n';
	const script = Buffer.from(start, 'utf8').toString('base64');
	const session = await dockerExec(
		id,
		[
			'sh',
			'-lc',
			`tmux set-option -g history-limit ${SESSION_HISTORY}; ` +
				// The session's own environment, set whether or not the session
				// already exists: a pane opened later, or one that outlives a
				// re-attach, still finds the display the desktop is on.
				`tmux set-environment -g DISPLAY ${DISPLAY}; ` +
				`if ! tmux has-session -t ${SESSION} 2>/dev/null; then ` +
				`echo ${script} | base64 -d > ${START_SCRIPT}; ` +
				`tmux new-session -d -s ${SESSION} -x 220 -y 50 'sh ${START_SCRIPT}'; ` +
				`tmux set-option -t ${SESSION} history-limit ${SESSION_HISTORY}; ` +
				`fi`
		],
		{ env: TMUX_ENV }
	);
	if (session.exitCode !== 0) {
		throw new Error(`could not start tmux in the machine: ${session.output.slice(-200)}`);
	}
}

// ------------------------------------------------------------------ desktop

/**
 * The ad blocker's files as the machine receives them: the repo's own manifest
 * and rule list, re-serialised rather than retyped so the extension the browser
 * loads is byte-for-byte the one under src/lib/server/adblock. The paths are
 * absolute because the desktop script writes them with a heredoc, and the
 * bodies are plain JSON - no line of them can be mistaken for the heredoc's own
 * delimiter.
 */
const ADBLOCK_FILES: { path: string; body: string }[] = [
	{ path: `${ADBLOCK_DIR}/manifest.json`, body: JSON.stringify(adblockManifest, null, 2) },
	{ path: `${ADBLOCK_DIR}/rules.json`, body: JSON.stringify(adblockRules, null, 2) }
];

/**
 * The desktop script a machine runs to bring its screen up.
 *
 * Idempotent: every step checks before it acts, so the same script relaunches
 * whatever died (a container restart wipes the X server but keeps the
 * packages) without reinstalling what is already there. The recipe's packages
 * and start lines are baked in when the script is written. Each phase echoes
 * a marker into /tmp/obl-stage as it starts, so the app can narrate the first
 * install line by line instead of leaving the log silent for minutes - and a
 * phase that fails leaves its reason in the same file, which is what the panel
 * shows (see `run_stage`).
 *
 * "Checks before it acts" means `obl_alive`, never a bare pgrep: in a container
 * whose PID 1 never reaps, a dead panel is a zombie that pgrep keeps counting
 * as alive, and the run that was supposed to restart it skips it instead.
 */
function desktopScript(botId: string): string {
	const de = desktopRecipeFor(botId);
	const browser = browserRecipeFor(botId);
	const bot = getBot(botId);
	const name = (bot?.name ?? 'Bot').replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
	const palette = botPalette(bot?.color ?? '');
	// A phase body travels as ONE single-quoted shell argument, so a body that
	// spans lines (a recipe's own start lines) or carries quotes of its own
	// still reaches `run_stage` whole.
	const shq = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
	const phase = (n: number, label: string, body: string) =>
		`run_stage ${n} ${shq(label)} -- ${shq(body)}`;
	// The X server, with VNC on VNC_PORT. The wait probes with xdpyinfo, which
	// is in the package set above: without it the loop could never pass, and a
	// server that never answers now fails the phase instead of leaving the
	// desktop to start against it blind. A dead Xvnc's lock and socket survive
	// it in /tmp (a slept container keeps its filesystem), and a lock naming a
	// pid some other process now owns makes Xvnc refuse the display - so they
	// are cleared whenever the check says no Xvnc is actually alive.
	const xvnc = [
		`${alive(`[X]vnc ${DISPLAY}`)} || ` +
			`{ rm -f ${X_LOCKS}; ` +
			`(Xvnc ${DISPLAY} -geometry 1280x1024 -depth 24 -SecurityTypes None -rfbport ${VNC_PORT} >/tmp/obl-xvnc.log 2>&1 &); }`,
		'for i in $(seq 1 40); do xdpyinfo >/dev/null 2>&1 && exit 0; sleep 0.5; done',
		`echo "Xvnc never answered on ${DISPLAY} - see /tmp/obl-xvnc.log" >&2`,
		'exit 1'
	].join('\n');
	// noVNC: the web files and the websocket, proxying to VNC. The bridge is the
	// only door into the screen - the panel dials this port through the gateway
	// - so a websockify that never opened it is a failed phase, not a desktop
	// nobody can look at.
	const websockify = [
		`${alive('[w]ebsockify')} || ` +
			`(websockify --web /usr/share/novnc ${WEBSOCKIFY_PORT} localhost:${VNC_PORT} >/tmp/obl-websockify.log 2>&1 &)`,
		`for i in $(seq 1 20); do nc -z -w 2 127.0.0.1 ${WEBSOCKIFY_PORT} >/dev/null 2>&1 && exit 0; sleep 0.5; done`,
		`echo "nothing is serving noVNC on ${WEBSOCKIFY_PORT} - see /tmp/obl-websockify.log" >&2`,
		'exit 1'
	].join('\n');
	// The CDP driver the app steers the browser with. It runs under node in this
	// container, so a missing node or a driver file that did not survive being
	// written has to fail here rather than at the first browser_navigate.
	const cdp = [
		`cat > /tmp/obl-cdp.mjs <<'OBL_EOF'`,
		CDP_SCRIPT,
		'OBL_EOF',
		`command -v node >/dev/null 2>&1 || { echo "node is missing from the machine - the browser driver cannot run"; exit 1; }`,
		`node --check /tmp/obl-cdp.mjs || { echo "the browser driver did not survive being written"; exit 1; }`
	].join('\n');
	// The page the browser opens on. about:blank is a bare white sheet, and with
	// the flags Chromium needs under Docker it also carries two of Chrome's own
	// notices over it. This is a real page in the bot's own colour and picture,
	// so the screen says whose it is before a task sends the browser anywhere.
	const startPage = [
		`cat > /tmp/obl-start.html <<'OBL_EOF'`,
		'<!doctype html>',
		'<meta charset="utf-8">',
		`<title>${name}</title>`,
		'<style>',
		'\thtml, body { height: 100%; margin: 0; }',
		'\tbody {',
		`\t\tbackground: ${palette.wallSolid} center / cover no-repeat url('file://${THEME_DIR}/wall.png');`,
		'\t\tcolor: #fff;',
		'\t\tfont: 15px/1.5 system-ui, sans-serif;',
		'\t\tdisplay: grid;',
		'\t\tplace-items: center;',
		'\t}',
		'\t.panel {',
		'\t\tmax-width: 34rem;',
		'\t\tpadding: 1.1rem 1.5rem;',
		'\t\tbackground: rgba(0, 0, 0, 0.62);',
		'\t\tborder-radius: 10px;',
		'\t\ttext-align: center;',
		'\t}',
		'\th1 { margin: 0 0 0.3rem; font-size: 1.05rem; font-weight: 600; }',
		'\tp { margin: 0.3rem 0 0; font-size: 0.8rem; opacity: 0.88; }',
		'</style>',
		'<div class="panel">',
		`\t<h1>${name}</h1>`,
		'\t<p>This is the machine screen. The browser holds this page until a task sends it somewhere else.</p>',
		'</div>',
		'OBL_EOF',
		// A browser this app kills leaves "exit_type":"Crashed" in the profile it
		// was using, and that sentinel is what draws the restore bubble on the
		// next launch and reopens the pages of the run that died. Clearing it
		// makes a relaunch a clean start; the launch flags hide the bubble for
		// the case where the profile is not there yet.
		`sed -i 's/"exit_type":"Crashed"/"exit_type":"None"/' /tmp/obl-chrome/Default/Preferences 2>/dev/null`
	].join('\n');
	// The ad blocker. Chromium reads --load-extension once, at launch, so the
	// extension has to be on disk before the browser starts - and because its
	// rules are declarative, nothing has to run for them to take effect. It is
	// written inside the browser phase rather than earlier so a machine that
	// cannot write it fails the phase with a reason, instead of quietly
	// browsing unblocked.
	const adblock = [
		`mkdir -p ${ADBLOCK_DIR}`,
		...ADBLOCK_FILES.flatMap((file) => [
			`cat > ${file.path} <<'OBL_EOF'`,
			file.body,
			'OBL_EOF'
		])
	].join('\n');
	// The browser phase: the ad blocker, then the page, then the launch. The
	// already-running guard is added here rather than living in the recipe,
	// because a recipe's `start` is the launch command itself - the framebuffer
	// navigate path names the binary by its first word - and because the guard
	// needs this script's `obl_alive`, which counts a dead browser's corpse as
	// dead.
	const browserPhase = [
		adblock,
		startPage,
		`${alive(browser.proc.replace(/^(.)/, '[$1]'))} || ${browser.start}`
	].join('\n');
	const packages = [
		'tigervnc',
		'websockify',
		'novnc',
		'imagemagick',
		'xdotool',
		// xdpyinfo is what the X-ready wait below probes with; without the
		// package the loop can never pass and the desktop starts blind.
		'xdpyinfo',
		'font-noto',
		'xsetroot',
		'xrdb',
		...de.packages,
		...browser.packages
	].join(' ');
	return `#!/bin/sh
# Written by Openbotlounge; safe to run repeatedly.
set -u
export DISPLAY=${DISPLAY}
# Everything below - this script's own messages and every phase's output - goes
# to this file. The script runs detached through the Docker API, so without it a
# phase's error lands in the container's stdout and is thrown away, and nothing
# anywhere can say why the desktop did not come up.
exec >${DESKTOP_LOG} 2>&1
rm -f ${STAGE_FILE}
rm -f ${DESKTOP_READY}

${ALIVE_FN}

# Run one phase: name it in the stage file first, then leave a FAIL marker there
# naming the error if it exits non-zero. The marker is what the status payload,
# the panel and the activity log read, so a setup that dies says why instead of
# stopping at a stage that never advances.
#
# The body runs in a subshell: it needs this shell's functions, but its own exit
# must not take the script down before the marker has been written.
run_stage() {
	rs_n="$1"
	rs_label="$2"
	shift 2
	[ "\${1:-}" = '--' ] && shift
	rs_from=\$(( \$(wc -c < ${DESKTOP_LOG} 2>/dev/null || echo 0) + 0 ))
	printf '__OBL_STAGE_%s:%s__\\n' "\$rs_n" "\$rs_label" >> ${STAGE_FILE}
	( eval "\$*" )
	rs_status=\$?
	[ "\$rs_status" -eq 0 ] && return 0
	# The phase's own last line is the reason worth keeping: apk names what it
	# could not install, and the waits say what never answered. It has to arrive
	# as one line, because that is what the stage file and the panel hold. The
	# offset is in bytes, so a phase that printed nothing cannot inherit the tail
	# of the phase before it.
	# A phase that fails silently - the common case, a command that is simply not
	# there and exits 127 - has no line to quote, and "exited 127 without a
	# message" is the one thing this marker exists to avoid. The body it was
	# given is then the explanation, flattened to one line like everything else
	# and clipped with it.
	rs_why=\$(tail -c +\$((rs_from + 1)) ${DESKTOP_LOG} 2>/dev/null | sed -n '/[^[:space:]]/p' | tail -n 1)
	[ -n "\$rs_why" ] || rs_why="\$(printf '%s' "\$*" | tr '\\n' ' ') exited \$rs_status with no output"
	rs_why=\$(printf '%s' "\$rs_why" | tr -d '\\r' | cut -c1-200)
	printf '__OBL_STAGE_FAIL:%s:%s:%s__\\n' "\$rs_n" "\$rs_label" "\$rs_why" >> ${STAGE_FILE}
	exit "\$rs_status"
}

# One-time packages. They land in the container's writable layer, so this cost
# is paid once per container rather than once per start.
${phase(1, 'packages', `apk add --no-cache ${packages}`)}

${phase(2, 'xvnc', xvnc)}

# The pointer theme and the bot's colours, from the skin the app unpacked.
export XCURSOR_THEME=${CURSOR_THEME} XCURSOR_PATH=${CURSOR_PATH} XCURSOR_SIZE=${CURSOR_SIZE}
${wallpaperCommand(palette)}

# The desktop, then the browser on the page this script wrote for it.
${phase(3, de.name, de.start)}
sleep 1
${phase(4, browser.name, browserPhase)}

# noVNC: the web files and the websocket on ${WEBSOCKIFY_PORT}, proxying to VNC.
${phase(5, 'websockify', websockify)}

${phase(6, 'cdp', cdp)}

touch ${DESKTOP_READY}
exit 0
`;
}

/**
 * The CDP driver: a small node script written into the machine. Chrome's
 * remote-debugging port only binds localhost (the --remote-debugging-address
 * flag is ignored since Chrome 136), so the app cannot reach it over the
 * Docker network - this runs inside the container instead. Node's built-in
 * WebSocket client (v22+) is all it needs.
 *
 * Navigate waits for the page's load event (capped, so a page that never
 * finishes still answers) and reads back the title and the rendered
 * innerText as one JSON line. That text is the whole point: a screenshot
 * goes to the person's panel, never to the model, so without the read-back
 * a "what does this site say" task is answerable only by curl - which is
 * how bots ended up shell-scripping JS-heavy pages the browser renders fine.
 */
const CDP_SCRIPT = `// A crash without a handler dumps a stack whose last line is the Node
// version banner - the app reads the last line as the error, so an
// unhandled rejection would report "Node.js vX" instead of what broke.
process.on('uncaughtException', (e) => {
	console.error('browser driver failed: ' + ((e && e.message) || e));
	process.exit(1);
});
process.on('unhandledRejection', (e) => {
	console.error('browser driver failed: ' + ((e && e.message) || e));
	process.exit(1);
});
const [,, action, arg, arg2] = process.argv;
const deadline = Date.now() + 240000;
let page = null;
while (Date.now() < deadline) {
	try {
		const list = await (await fetch('http://127.0.0.1:${CDP_PORT}/json/list')).json();
		page = list.find((t) => t.type === 'page');
		if (page) break;
	} catch {}
	await new Promise((r) => setTimeout(r, 2000));
}
if (!page) {
	console.error('the browser is not up yet - the desktop is still installing (the first setup takes a minute or two); wait a bit and call browser_navigate again instead of switching to curl');
	process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
// Promise.withResolvers over executor form: the load wait and the socket
// open both resolve from outside their own constructor.
const loadDone = Promise.withResolvers();
const onLoaded = loadDone.resolve;
const socketOpen = Promise.withResolvers();
ws.onopen = socketOpen.resolve;
ws.onerror = socketOpen.reject;
const send = (method, params = {}) => new Promise((res, rej) => {
	const id = ++seq;
	pending.set(id, { res, rej });
	ws.send(JSON.stringify({ id, method, params }));
});
// Load listeners beyond the navigate wait: a click or key can navigate too,
// and each waiter is a one-shot resolved by the next load event.
const loadWaiters = new Set();
ws.onmessage = (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const p = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
	} else if (msg.method === 'Page.loadEventFired') {
		onLoaded();
		for (const f of loadWaiters) f();
		loadWaiters.clear();
	}
};
await socketOpen.promise;

// The page-side helpers below are stringified and run inside the page through
// Runtime.evaluate, so they must stay self-contained: no closure over driver
// state, no imports, nothing the page does not already have.

// The interactive elements worth numbering, in document order: what the walk
// lists and what click/fill index into. Only elements near the viewport count
// - a long page's whole DOM would bury the list - so the agent scrolls for
// the rest. el rides along for the actions and is dropped before the list
// is serialised.
const enumEls = function () {
	const sel =
		'a[href],button,input,select,textarea,summary,' +
		'[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[role="switch"],' +
		'[onclick],[contenteditable="true"]';
	const vh = window.innerHeight || 800;
	const out = [];
	for (const el of document.querySelectorAll(sel)) {
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) continue;
		if (r.bottom < -vh || r.top > vh * 3) continue;
		const tag = el.tagName.toLowerCase();
		const label = (
			el.innerText || el.value || el.getAttribute('aria-label') ||
			el.getAttribute('placeholder') || el.getAttribute('title') ||
			el.getAttribute('alt') || el.getAttribute('name') || ''
		).trim().replace(/\\s+/g, ' ').slice(0, 80);
		const href = tag === 'a' ? el.getAttribute('href') || '' : '';
		const type = tag === 'input' ? el.getAttribute('type') || 'text' : '';
		out.push({ tag: tag, label: label, href: href, type: type, el: el });
		if (out.length >= 150) break;
	}
	return out;
};

// The walk: the page as a text-mode view. Text is the direct text of elements
// intersecting the viewport - leaf text only, so nothing is counted twice -
// plus the numbered elements and how far the page can still scroll.
const walkPage = function () {
	const els = enumEls().map(function (e, i) {
		return { i: i, tag: e.tag, label: e.label, href: e.href, type: e.type };
	});
	const vh = window.innerHeight || 800;
	const chunks = [];
	let total = 0;
	for (const el of document.body ? document.body.querySelectorAll('*') : []) {
		if (total > 6000) break;
		if (!(el instanceof HTMLElement)) continue;
		const tag = el.tagName;
		if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
		const r = el.getBoundingClientRect();
		if (r.bottom < 0 || r.top > vh) continue;
		for (const n of el.childNodes) {
			if (n.nodeType !== 3) continue;
			const t = n.textContent.replace(/\\s+/g, ' ').trim();
			if (!t) continue;
			chunks.push(t);
			total += t.length;
		}
	}
	const doc = document.documentElement;
	return {
		title: document.title || '',
		url: location.href,
		text: chunks.join('\\n').slice(0, 6000),
		scrollY: Math.round(window.scrollY),
		maxScroll: Math.max(0, Math.round((doc ? doc.scrollHeight : 0) - vh)),
		els: els
	};
};

const clickPage = function (idx) {
	const els = enumEls();
	const e = els[idx];
	if (!e) return { error: 'no element ' + idx + ' - the page lists ' + els.length + '; walk again for fresh numbers' };
	e.el.scrollIntoView({ block: 'center' });
	e.el.click();
	return {};
};

const fillPage = function (idx, text) {
	const els = enumEls();
	const e = els[idx];
	if (!e) return { error: 'no element ' + idx + ' - the page lists ' + els.length + '; walk again for fresh numbers' };
	const el = e.el;
	el.scrollIntoView({ block: 'center' });
	el.focus();
	if (el.isContentEditable) {
		el.textContent = text;
	} else if (el.tagName === 'SELECT') {
		const want = String(text).toLowerCase();
		const opt = Array.prototype.find.call(el.options, function (o) {
			return o.value.toLowerCase() === want || o.text.toLowerCase() === want;
		});
		if (!opt) return { error: 'no option "' + text + '" on that select' };
		el.value = opt.value;
	} else if ('value' in el) {
		el.value = text;
	} else {
		return { error: 'element ' + idx + ' is not a field - click it instead' };
	}
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
	return {};
};

const scrollPage = function (dir, amount) {
	const vh = window.innerHeight || 800;
	const px = amount === 'line' ? Math.round(vh / 6) : vh;
	window.scrollBy(0, dir === 'up' ? -px : px);
	return {};
};

const backPage = function () {
	history.back();
	return {};
};

// Keys browser_press knows, as CDP Input.dispatchKeyEvent payloads. Enter
// carries text so a form submits the way a real keypress submits it.
const KEYS = {
	enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\\r' },
	return: { key: 'Enter', code: 'Enter', vk: 13, text: '\\r' },
	tab: { key: 'Tab', code: 'Tab', vk: 9 },
	escape: { key: 'Escape', code: 'Escape', vk: 27 },
	esc: { key: 'Escape', code: 'Escape', vk: 27 },
	backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
	delete: { key: 'Delete', code: 'Delete', vk: 46 },
	space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
	arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
	arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
	arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
	arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
	home: { key: 'Home', code: 'Home', vk: 36 },
	end: { key: 'End', code: 'End', vk: 35 },
	pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
	pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 }
};

// Run one page-side helper with arguments and return its value, surfacing a
// thrown page error instead of an undefined the caller would misread.
const pageEval = async (fn, args) => {
	// fn is serialised and evaluated inside the page, so helpers it closes
	// over (enumEls) must travel with it - the page has no scope of its own.
	const r = await send('Runtime.evaluate', {
		expression:
			'var enumEls = ' + String(enumEls) + ';(' + String(fn) + ').apply(null, ' + JSON.stringify(args || []) + ')',
		returnByValue: true
	});
	if (r && r.exceptionDetails) {
		const ex = r.exceptionDetails.exception;
		throw new Error('page script failed: ' + ((ex && ex.description) || r.exceptionDetails.text || 'unknown'));
	}
	return r && r.result ? r.result.value : undefined;
};

// Resolve on the next load event or the cap, whichever is first: a click that
// navigates gets its new page walked, one that only re-renders waits the cap.
const waitLoad = (ms) => new Promise((res) => {
	loadWaiters.add(res);
	setTimeout(res, ms);
});

try {
if (action === 'navigate') {
	await send('Page.enable');
	// The load event resolves the wait; the timer caps it, so a page that
	// never finishes loading still answers with whatever rendered.
	const loadTick = setTimeout(onLoaded, 20000);
	const nav = await send('Page.navigate', { url: arg });
	if (nav.errorText) {
		console.log(JSON.stringify({ error: nav.errorText }));
	} else {
		await loadDone.promise;
		clearTimeout(loadTick);
		// Late scripts keep rewriting the page after load; a short settle
		// buys the rendered text instead of the skeleton.
		await new Promise((r) => setTimeout(r, 1200));
		console.log(JSON.stringify({ walk: await pageEval(walkPage) }));
	}
} else if (['walk', 'click', 'fill', 'scroll', 'back', 'press'].includes(action)) {
	await send('Page.enable');
	let acted = {};
	let keyErr = '';
	if (action === 'click') acted = await pageEval(clickPage, [Number(arg)]);
	else if (action === 'fill') acted = await pageEval(fillPage, [Number(arg), arg2 || '']);
	else if (action === 'scroll') acted = await pageEval(scrollPage, [arg || 'down', arg2 || 'page']);
	else if (action === 'back') acted = await pageEval(backPage);
	else if (action === 'press') {
		const k = KEYS[String(arg || '').toLowerCase()];
		if (!k) {
			keyErr = 'unknown key "' + arg + '" - try enter, tab, escape, backspace, space, the arrows, home, end, pageup, pagedown';
		} else {
			const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
			await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
			if (k.text) await send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: k.text }, base));
			await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
		}
	}
	const err = keyErr || (acted && acted.error) || '';
	if (err) {
		console.log(JSON.stringify({ error: err }));
	} else {
		// Clicks, keys and back can navigate; give a load event a moment, then
		// settle for whatever rendered before walking the result.
		if (action === 'click' || action === 'back' || action === 'press') await waitLoad(1500);
		await new Promise((r) => setTimeout(r, action === 'scroll' ? 400 : 800));
		console.log(JSON.stringify({ walk: await pageEval(walkPage) }));
	}
} else if (action === 'shot') {
	await send('Page.enable');
	const r = await send('Page.captureScreenshot', { format: 'png' });
	// This script runs inside the bot's container, not in the app bundle, so
	// its own dynamic import is the runtime-selected-module case: node:fs is
	// only needed when a screenshot is actually written.
	const { writeFileSync } = await import('node:fs');
	writeFileSync(arg, Buffer.from(r.data, 'base64'));
	console.log('shot');
} else if (action === 'cookies') {
	// Every cookie the browser holds for one site, filtered here so the rest of
	// the jar never leaves the browser. The app filters again on the way back
	// (siteMatchesCookie); this is the boundary that keeps a handover to one
	// site even if the app's own filter were ever loosened.
	await send('Network.enable');
	const all = await send('Network.getAllCookies');
	const site = arg;
	const norm = (d) => String(d || '').toLowerCase().replace(/^[.]+/, '').replace(/[.]+$/, '');
	const mine = ((all && all.cookies) || []).filter((c) => {
		const d = norm(c.domain);
		return d === site || d.endsWith('.' + site);
	});
	console.log(JSON.stringify({ cookies: mine }));
} else if (action === 'setcookies') {
	// The payload arrives as a file, never as an argument: an exec command is
	// logged, and a cookie value in the activity feed is the leak this feature
	// exists to avoid.
	const { readFileSync } = await import('node:fs');
	const cookies = JSON.parse(readFileSync(arg, 'utf8'));
	await send('Network.enable');
	await send('Network.setCookies', { cookies });
	console.log(JSON.stringify({ set: cookies.length }));
}
} catch (e) {
	// One clean line on stderr: the app reads the driver's last line as the
	// error, and an unhandled throw would end on the Node version banner.
	console.error('browser driver failed: ' + ((e && e.message) || e));
	process.exit(1);
}
ws.close();
process.exit(0);
`;

/** When the desktop was last (re)launched, so kicks do not pile up. */
const desktopKicked: Record<string, number> = {};

/**
 * Bots whose desktop was asked for but whose machine is still coming up.
 * ensureDesktop returns before the container exists, so this is what lets a
 * status poll say 'starting' during the gap instead of 'off'.
 */
const desktopRequested = new Set<string>();

/** Desktop kicks in flight, per bot - the same overlap guard ensureTmux uses. */
const desktopKicking = new Map<string, Promise<void>>();

/**
 * Bring the bot's desktop up: unpack its skin, write the setup + CDP scripts,
 * and run the setup detached. Returns immediately - the install takes minutes
 * the first time, and callers poll for readiness rather than holding a turn.
 */
export async function ensureDesktop(botId: string): Promise<void> {
	// A terminal-only bot has a machine but no desktop to bring up.
	if (machineTier(botId) !== 'full') return;
	desktopRequested.add(botId);
	try {
		// The wake is deduped below this line, but the kick itself is not: the
		// panel's poll, the wake and a status poll's heal path can all reach
		// here inside the machine wake's window, and each used to write the
		// script, run it detached and speak the kick line of its own. Two
		// concurrent kicks ran two setups against one machine, and the log
		// carried the same "Desktop setup started" line twice.
		const inFlight = desktopKicking.get(botId);
		if (inFlight) {
			await inFlight;
			return;
		}
		const attempt = ensureDesktopOnce(botId);
		desktopKicking.set(botId, attempt);
		try {
			await attempt;
		} finally {
			desktopKicking.delete(botId);
		}
	} finally {
		desktopRequested.delete(botId);
	}
}

async function ensureDesktopOnce(botId: string): Promise<void> {
	const name = await ensureMachine(botId);
	const probe = await desktopProbe(botId, name);
	// Nothing to do only when the screen and its panel are both up: skipping
	// a kick because the screen serves is how a dead taskbar stayed gone for
	// the life of a container.
	if (probe.state === 'ready' && probe.panelAlive) return;
	const now = Date.now();
	if (now - (desktopKicked[botId] ?? 0) < 60_000) return;
	desktopKicked[botId] = now;
	const de = desktopRecipeFor(botId);
	const browser = browserRecipeFor(botId);
	// The kick itself is one line: what was asked for, by name. The stage
	// watcher below narrates the phases the script reaches from here.
	logActivity(
		botId,
		'sandbox',
		`Desktop setup started: image ${IMAGE}, desktop ${de.name}, browser ${browser.name}`
	);
	// The skin carries the wallpaper, the pointer art and the cursor theme; it
	// goes in before the script runs so the first frame already looks like the
	// bot. A failed upload costs the theme, never the desktop.
	try {
		const skin = await sandboxSkin(botId);
		if (skin) {
			await dockerRequest('PUT', `/containers/${name}/archive?path=${dirname(THEME_DIR)}`, undefined, {
				data: skin.bundle,
				contentType: 'application/x-tar'
			});
		}
	} catch (err) {
		console.warn(`machine skin for ${botId} not unpacked:`, err);
	}
	await machineWriteFile(botId, '/tmp/obl-desktop.sh', desktopScript(botId));
	await machineWriteFile(botId, '/tmp/obl-cdp.mjs', CDP_SCRIPT);
	await dockerExecDetached(name, ['sh', '/tmp/obl-desktop.sh']);
	watchDesktopStages(botId, name);
}

/**
 * How long a stage watcher may keep reading the stage file after its kick,
 * in checks. The first install is apk-bound - minutes - but a rebuild after a
 * crash re-installs nothing, so the watcher stops at the first 'ready' probe
 * and otherwise ages out: a stalled box's last line is the truth it died on.
 */
const STAGE_WATCH_CHECKS = positiveEnv('SANDBOX_STAGE_WATCH_CHECKS', 10);
/** Spacing is read per run, so a test can tighten it without a fresh module. */
const stageWatchSpacingMs = () =>
	positiveEnv('SANDBOX_STAGE_WATCH_SPACING_MS', 20_000);

/**
 * Sleep that never holds a process open: the watcher is narration, so its
 * pending timer must not keep a worker (a test run, an exiting app) alive.
 */
function watchDelay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const t = setTimeout(resolve, ms);
	t.unref();
	return promise;
}

/**
 * Bots whose stage watcher is running, so a re-kick inside the first install
 * (the probe's heal path, a second Wake) does not stack a second watcher on
 * the same script run. The stage file is shared, so two watchers would speak
 * every marker twice.
 */
const stageWatching = new Set<string>();

/**
 * Narrate the desktop script's phases after a kick: poll the stage file the
 * script echoes `__OBL_STAGE_<n>:<label>__` into and speak each marker the
 * log has not heard yet. Runs detached - nothing waits on it - and bounded:
 * a fixed number of checks spaced seconds apart, stopping early once the
 * probe reports the desktop serving. Every call is best effort; the log is
 * narration, not a promise.
 */
function watchDesktopStages(botId: string, container: string): void {
	if (stageWatching.has(botId)) return;
	stageWatching.add(botId);
	void (async () => {
		try {
			for (let i = 0; i < STAGE_WATCH_CHECKS; i++) {
				await watchDelay(stageWatchSpacingMs());
				// check reads every marker that landed in between.
				if (!stageWatching.has(botId)) return;
				const probe = await readStageProbe(botId, container);
				if (!probe) continue;
				for (const line of probe.newMarkers) {
					logActivity(botId, 'sandbox', `Desktop: ${line.label} (${line.detail})`);
				}
				// A phase that failed is the end of that run: the script exits
				// right after the marker, so say what stopped it and stop
				// watching - no further marker is coming, and the wait would
				// only delay the line the user needs.
				if (probe.failed) {
					logActivity(
						botId,
						'sandbox',
						`Desktop setup failed at ${probe.failed} - see ${DESKTOP_LOG}`
					);
					return;
				}
				if (probe.ready) return;
			}
		} catch {
			// Docker blipped or the bot left mid-watch: the log already has
			// whatever the watcher saw, and the desktop does not need it.
		} finally {
			stageWatching.delete(botId);
		}
	})();
}

/**
 * Test seam: the watcher runs detached, so a test needs a way to wait it out.
 * Resolves when `botId`'s watcher has finished (or is not running).
 */
export async function watchDesktopSettled(botId: string): Promise<void> {
	while (stageWatching.has(botId)) await delay(20);
}

/** The markers one stage check speaks, by the stage number they carry. */
const stagesSeen = new Map<string, Set<number>>();

/**
 * Read the stage file from `container` and return what the log has not heard
 * yet, or null when the read failed or said nothing new. Marks spoken stages
 * seen, so a re-read of the same file is silent. A failure marker rides along
 * separately: it is spoken once per run, whatever the stage numbers have done.
 */
async function readStageProbe(
	botId: string,
	container: string
): Promise<{ ready: boolean; failed: string; newMarkers: { label: string; detail: string }[] } | null> {
	const out = await dockerExec(
		container,
		[
			'sh',
			'-lc',
			`${ALIVE_FN}; echo ${PROBE_SPLIT}; cat ${STAGE_FILE} 2>/dev/null; ` +
				`${alive(`[X]vnc ${DISPLAY}`)} && ${alive('[w]ebsockify')} && echo serving`
		],
		{ timeoutMs: 15_000 }
	).catch(() => null);
	if (!out) return null;
	const split = out.output.indexOf(PROBE_SPLIT);
	const stageText = split < 0 ? '' : out.output.slice(split + PROBE_SPLIT.length);
	const ready = stageText.includes('serving');
	const failed = stageText.match(STAGE_FAIL_RE);
	const seen = stagesSeen.get(botId) ?? new Set<number>();
	if (!stagesSeen.has(botId)) stagesSeen.set(botId, seen);
	const newMarkers: { label: string; detail: string }[] = [];
	for (const m of stageText.matchAll(/__OBL_STAGE_(\d+):(.+?)__/g)) {
		const n = Number(m[1]);
		if (seen.has(n)) continue;
		seen.add(n);
		newMarkers.push({ label: m[2], detail: `stage ${n}/6` });
	}
	return newMarkers.length || ready || failed
		? { ready, failed: failed ? stageFailText(failed) : '', newMarkers }
		: null;
}

/**
 * What the desktop's processes are doing, in one exec: 'ready' when the X
 * server, the noVNC bridge and the desktop itself are all alive; 'heal' when
 * the screen serves but the desktop or the browser died underneath it;
 * 'starting' while the setup script runs; 'off' otherwise. The browser is not
 * part of 'ready' - a dead browser still leaves a desktop to look at, and the
 * script restarts it on the next kick.
 *
 * Alive means alive: the check ignores zombies, because PID 1 in these
 * containers reaps nothing and a corpse in the process table would otherwise
 * read as a serving screen - a dead tint2 was reported as a live panel, and the
 * setup script then skipped restarting it.
 *
 * The same exec also cats the script's stage file and returns the newest marker
 * and the failure marker, so the status poll reports what phase the box is in
 * and what killed the last run, for free. It reports the recipe's panel
 * separately: see below.
 */
async function desktopProbe(
	botId: string,
	container: string
): Promise<{
	state: 'ready' | 'heal' | 'starting' | 'off';
	stage: string;
	error: string;
	panelAlive: boolean;
}> {
	const de = desktopRecipeFor(botId);
	// Every pattern is written [x]rest - the literal ones by hand, the recipe's
	// with the bracket added here - so the probe's own `sh -lc` cmdline, which
	// carries the pattern text, can never match itself. Without the bracket the
	// probe reported 'ready' on a box with nothing running, which is how the
	// panel ended up watching a dead framebuffer.
	const probe = await dockerExec(container, [
		'sh',
		'-lc',
		`${ALIVE_FN}; ` +
			`if ${alive(`[X]vnc ${DISPLAY}`)} && ${alive('[w]ebsockify')}; then ` +
			`if ${alive(de.proc.replace(/^(.)/, '[$1]'))}; then echo ready; else echo heal; fi; ` +
			`elif ${alive('[o]bl-desktop.sh')}; then echo starting; ` +
			`else echo off; fi; ` +
			// The panel is asked after the splitter rather than folded into the
			// state: a screen whose taskbar died is still worth looking at and
			// driving, so it stays 'ready' - the caller uses this to put the
			// panel back, never to withhold the screen. A recipe with no panel
			// of its own is always 'panelled'.
			`echo ${PROBE_SPLIT}; ` +
			`${de.panel ? alive(de.panel.replace(/^(.)/, '[$1]')) : 'true'} && echo panelled; ` +
			`tail -n 3 ${STAGE_FILE} 2>/dev/null`
	]).catch(() => ({ output: '', exitCode: 1 }));
	// The markers ride after the splitter, so the probe's own one-word answer is
	// never mistaken for one. Three lines, because a failed run leaves its FAIL
	// line after the stage it died on; the newest of each kind wins.
	const split = probe.output.indexOf(PROBE_SPLIT);
	const stageText = split < 0 ? '' : probe.output.slice(split + PROBE_SPLIT.length);
	const stage = [...stageText.matchAll(/__OBL_STAGE_(\d+):(.+?)__/g)].pop();
	const fail = stageText.match(STAGE_FAIL_RE);
	return {
		state:
			(() => {
				const state = probe.output.slice(0, split < 0 ? undefined : split).trim();
				return state === 'ready' || state === 'heal' || state === 'starting' ? state : 'off';
			})(),
		stage: stage ? `stage ${stage[1]}/6 ${stage[2]}` : '',
		error: fail ? stageFailText(fail) : '',
		panelAlive: stageText.includes('panelled')
	};
}

/**
 * What the desktop inside a running container is doing, for status reporting.
 * 'starting' covers the whole window between "someone asked" and "it serves":
 * the request still in flight, the kick just sent, or the setup script still
 * running its apk install. A stale ready-file does not count - the processes
 * are what matter, so a container restart reads 'off' and a wake rebuilds it.
 * A desktop that died under a serving screen reads 'starting' too: the probe
 * is what kicks the rebuild, so the panel's next poll is already healing it.
 * A panel that died under one is the case that kicks *without* changing the
 * state - the screen is still the screen, and taking it away over a taskbar
 * would be the wrong trade.
 *
 * The stage rides along: the newest phase marker the setup script has reached,
 * or '' when it has not echoed one - a serving box's phase is old news, so the
 * stage is only reported while it is worth reading. So does the failure marker
 * of the last run: it is reported with whatever state the box is in, because a
 * run that died leaves nothing else to ask, and 'off' with no reason is exactly
 * the panel output this exists to replace.
 */
async function desktopState(
	botId: string,
	container: string
): Promise<{ desktop: 'off' | 'starting' | 'ready'; stage: string; error: string }> {
	const probe = await desktopProbe(botId, container);
	const detail = { stage: probe.stage, error: probe.error };
	if (probe.state === 'ready') {
		// The screen serves but the recipe's panel is not on it: kick the script,
		// which starts what is missing, and keep reporting 'ready'. Withholding
		// the live view over a missing taskbar would cost the user more than the
		// taskbar is worth - and the probe behind that kick agrees on what
		// 'ready' means, so the kick is not skipped as unnecessary.
		if (!probe.panelAlive) void ensureDesktop(botId);
		return { desktop: 'ready', ...detail };
	}
	if (probe.state === 'starting') return { desktop: 'starting', ...detail };
	if (probe.state === 'heal') {
		// The screen serves but the desktop process is gone; kick the script,
		// which restarts whatever is missing without reinstalling anything.
		void ensureDesktop(botId);
		return { desktop: 'starting', ...detail };
	}
	// The script is not running, but a request may be between "kicked" and
	// "script alive" (the skin upload and file writes sit in that gap), or a
	// wake may still be creating the container. Both read as 'starting' for a
	// short window so the panel does not flicker back to 'off'.
	if (desktopRequested.has(botId) || Date.now() - (desktopKicked[botId] ?? 0) < 90_000) {
		return { desktop: 'starting', ...detail };
	}
	return { desktop: 'off', ...detail, stage: '' };
}


/**
 * Pick the bot's desktop recipes and (re)build its desktop with them.
 *
 * The choice is stored on the bot row so it survives the container; an empty
 * name keeps the current one. Returns a line for the model naming what the
 * machine now runs.
 */
export async function setupDesktop(
	botId: string,
	opts: { desktop?: string; browser?: string }
): Promise<string> {
	if (machineTier(botId) !== 'full') {
		return 'error: this bot has no desktop - its machine is terminal-only';
	}
	const patch: { desktop_recipe?: string; browser_recipe?: string } = {};
	if (opts.desktop !== undefined) {
		const name = opts.desktop.trim().toLowerCase();
		if (name && !DESKTOP_RECIPES[name]) {
			return `error: no desktop recipe "${name}" - choose one of: ${Object.keys(DESKTOP_RECIPES).join(', ')}`;
		}
		if (name) patch.desktop_recipe = name;
	}
	if (opts.browser !== undefined) {
		const name = opts.browser.trim().toLowerCase();
		if (name && !BROWSER_RECIPES[name]) {
			return `error: no browser recipe "${name}" - choose one of: ${Object.keys(BROWSER_RECIPES).join(', ')}`;
		}
		if (name) patch.browser_recipe = name;
	}
	if (patch.desktop_recipe || patch.browser_recipe) updateBot(botId, patch);
	const de = desktopRecipeFor(botId);
	const browser = browserRecipeFor(botId);
	const name = await ensureMachine(botId);
	// Tear the old desktop down and let the next ensureDesktop rebuild it with
	// the new recipe; the kick guard is cleared so the rebuild is not skipped.
	await dockerExec(name, [
		'sh',
		'-lc',
		`rm -f ${DESKTOP_READY}; pkill -f websockify; pkill -f 'Xvnc ${DISPLAY}'; true`
	]).catch(() => {});
	desktopKicked[botId] = 0;
	await ensureDesktop(botId);
	logActivity(botId, 'sandbox', `Desktop recipe: ${opts.desktop || 'keep'} + ${opts.browser || 'keep'}`);
	return (
		`desktop is being set up with ${opts.desktop || 'the current window manager'} ` +
		`(${de.label.split(' - ')[0]}) and ${browser.label.split(' - ')[0]} - ` +
		'give it a minute to install, then browser_navigate or browser_screenshot to see it'
	);
}

// ------------------------------------------------------------------- status

/**
 * When a container last started, in ms, per Docker. 0 when that cannot be read.
 * Only ever asked about containers this process has no timestamp for.
 */
async function containerStartedAt(id: string): Promise<number> {
	const res = await dockerRequest('GET', `/containers/${id}/json`).catch(() => null);
	if (!res || res.status !== 200) return 0;
	try {
		const info = JSON.parse(res.body.toString()) as { State?: { StartedAt?: string } };
		const ms = Date.parse(info.State?.StartedAt ?? '');
		return Number.isFinite(ms) ? ms : 0;
	} catch {
		return 0;
	}
}

export async function machineStatus(botId: string): Promise<MachineStatus> {
	const name = machineName(botId);
	let c: ContainerInfo | null = null;
	try {
		c = await findContainer(botId);
	} catch {
		// Docker socket unavailable — report off rather than 500.
	}
	// The screen is only live when the desktop is actually serving: a running
	// container whose desktop was never asked for has nothing to watch, and a
	// port that is bound but dead would show a black reconnect loop. The
	// desktop's own phase is reported too, so a machine that is up but still
	// installing reads as 'starting' rather than an unexplained '…', with the
	// newest stage marker riding along to name the phase - and, when the last
	// run died, the reason it died, which is the one thing that must never be
	// swallowed: a desktop that never comes up otherwise leaves the stage
	// sitting still and nothing anywhere saying why.
	const desktop =
		c && isRunning(c) && machineTier(botId) === 'full'
			? await desktopState(botId, c.Id)
			: { desktop: 'off' as const, stage: '', error: '' };
	// The reported port is the VNC gateway's, not the machine's: a port
	// published from an internal network is dropped by Docker, so the
	// machine's own binding is a number that is never bound. A ready desktop
	// with no port is a gateway fault, not a sleeping machine - the gateway is
	// what republishes the desktop, and a bridge deleted and recreated under
	// it leaves the gateway on the internal network, where Docker drops the
	// binding entirely. Repair it once, then report the truth: the port, or
	// the fact that the screen cannot be reached. The panel needs that
	// difference, because a ready desktop with no port otherwise reads as a
	// machine that is off and it offers a Wake that cannot help.
	let vncPort = 0;
	if (desktop.desktop === 'ready') {
		vncPort = await vncGatewayPort(botId);
		if (!vncPort) {
			await ensureVncGateway(botId, name, await ensureMachineNetwork(botId)).catch(() => {});
			vncPort = await vncGatewayPort(botId);
		}
	}
	return {
		state: !c ? 'off' : isRunning(c) ? 'running' : 'sleeping',
		url: `http://${name}:${WEBSOCKIFY_PORT}`,
		vncPort,
		desktop: desktop.desktop,
		desktop_stage: desktop.stage,
		desktop_error: desktop.error,
		screen:
			desktop.desktop !== 'ready' ? 'off' : vncPort ? 'ok' : 'gateway',
		lastActive: lastActive[botId] ?? 0,
		hasThumbnail: await stat(thumbPath(botId)).then(
			() => true,
			() => false
		)
	};
}
// ---------------------------------------------------------------- presence

/**
 * Every asked-about bot's machine state in ONE daemon round-trip. The
 * header dots and the palette read this, so presence for the whole fleet
 * cannot cost a lookup per bot. Absent container is 'off', a stopped one
 * is 'sleeping' — the UI says "asleep" for that, never "offline": offline
 * is for a bot with no machine at all, not for one that is merely down.
 * A failed call returns {} and the caller keeps its last picture, the way
 * the other polls treat a lost request as no answer.
 */
export async function presenceForBots(botIds: string[]): Promise<Record<string, MachineState>> {
	let list: ContainerInfo[] = [];
	try {
		const res = await dockerRequest(
			'GET',
			`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: ['obl-machine-'] }))}`
		);
		if (res.status !== 200) return {};
		list = JSON.parse(res.body.toString()) as ContainerInfo[];
	} catch {
		return {};
	}
	// Container name carries the bot prefix (see machineName); a label filter
	// would need one call per bot, so the name is read instead.
	const byBot: Record<string, ContainerInfo> = {};
	for (const c of list) {
		const name = (c.Names?.[0] ?? '').replace(/^\//, '');
		if (name.startsWith('obl-machine-')) byBot[name.slice('obl-machine-'.length)] = c;
	}
	const out: Record<string, MachineState> = {};
	for (const id of botIds) {
		const c = byBot[id.slice(0, 12)];
		out[id] = !c ? 'off' : isRunning(c) ? 'running' : 'sleeping';
	}
	return out;
}

/**
 * Put a bot's machine to sleep, saying what it was doing beforehand.
 *
 * The reaper calls this with the default reason; a bot putting its own machine
 * down passes its own, so the log does not report an idle sleep that never
 * happened. Sidecars (tailscale) go down with it: they share its network
 * namespace and are useless without it.
 */
export async function sleepMachine(botId: string, why = 'idle'): Promise<MachineState> {
	// A wake in flight must finish first: stopping the container mid-wake
	// would make the wake fail with a misleading error, or leave it reporting
	// a running machine that was just stopped.
	await waking.get(botId)?.catch(() => {});
	const c = await findContainer(botId);
	if (!c) return 'off';
	if (!isRunning(c)) return 'sleeping';
	// Grab the screen first so the panel can still show what it was last doing.
	if ((await desktopProbe(botId, c.Id).catch(() => null))?.state === 'ready')
		await captureSnapshot(botId);
	for (const other of await botContainers(botId)) {
		if (other.Id !== c.Id) {
			await dockerRequest('POST', `/containers/${other.Id}/stop`).catch(() => {});
		}
	}
	// Xvnc's lock and socket live in /tmp, which a stopped container keeps; a
	// stale lock names a pid the next boot may reuse, and Xvnc then refuses the
	// display forever. Clear them while the box is still running so a sleeping
	// machine never carries one into its next wake.
	await dockerExec(c.Id, ['sh', '-lc', `rm -f ${X_LOCKS}`]).catch(() => {});
	await dockerRequest('POST', `/containers/${c.Id}/stop`);
	// A stop kills the setup script mid-install; the kick guard is cleared so
	// the next wake relaunches it instead of waiting out the throttle.
	delete desktopKicked[botId];
	logActivity(botId, 'sandbox', `Machine sleeping (${why})`);
	return 'running';
}

/**
 * Tear a bot's machine down completely. Sleeping only stops the container; a
 * deleted bot's containers would otherwise run forever, since nothing else
 * knows about them. Every container labelled for the bot goes - the machine,
 * legacy sandboxes and sidecars alike - plus its shared volume and its
 * last-seen screen.
 */
export async function destroyMachine(botId: string): Promise<void> {
	for (const c of await botContainers(botId)) {
		await dockerRequest('POST', `/containers/${c.Id}/stop`).catch(() => {});
		await dockerRequest('DELETE', `/containers/${c.Id}?force=1`).catch(() => {});
	}
	// Legacy containers predate the obl.bot label, so they are found by name.
	await removeLegacyContainers(botId).catch(() => {});
	await dockerRequest('DELETE', `/volumes/${shareVolume(botId)}`).catch(() => {});
	await dockerRequest('DELETE', `/volumes/obl-tailscale-${botId.slice(0, 12)}`).catch(() => {});
	// The bot's isolated network goes too; the egress proxy detaches with it.
	await removeMachineNetwork(botId);
	delete lastActive[botId];
	delete desktopKicked[botId];
	// The last-seen screen belongs to the bot, so nothing will ever read it again.
	await unlink(thumbPath(botId)).catch(() => {});
}

/**
 * Wipe a bot's machine but keep its documents: every .md file on the shared
 * drive is read out first, the machine and volume are destroyed, and the
 * files are written back onto the fresh volume. The bot asked for a clean
 * machine, not amnesia - personality.md and friends are who it is.
 * Best-effort on the way out: a file that cannot be read is not saved, and a
 * drive that cannot be read at all still resets - the request was to wipe.
 */
export async function resetMachineKeepDocs(botId: string): Promise<{ kept: string[] }> {
	const volume = shareVolume(botId);
	const saved = new Map<string, string>();
	try {
		const { files } = await listMountFiles(volume);
		for (const f of files) {
			if (!f.path.endsWith('.md')) continue;
			const text = await readMountFile(volume, f.path).catch(() => null);
			if (text !== null) saved.set(f.path, text);
		}
	} catch {
		// The drive could not be listed at all: nothing to carry over.
	}
	await destroyMachine(botId);
	for (const [path, text] of saved) {
		// The volume is recreated by the writer's bind; a file that refuses to
		// land is logged by the caller's failure, not retried here.
		await writeMountFile(volume, path, text).catch(() => {});
	}
	return { kept: [...saved.keys()] };
}

/**
 * Remove containers whose bot no longer exists, plus the pieces a container
 * does not have to be present to leave behind: the share volume, the
 * last-seen screen and the dated shots. Called at boot, so orphans left by an
 * earlier version - or by a bot removed behind the app's back - are cleared
 * rather than running until someone notices.
 */
export async function removeOrphanMachines(knownBotIds: Set<string>): Promise<number> {
	if (SWEEP_OFF[(process.env.SANDBOX_ORPHAN_SWEEP ?? '').trim().toLowerCase()]) return 0;

	let removed = 0;
	const swept = new Set<string>();
	for (const c of await listManaged()) {
		const botId = c.Labels?.['obl.bot'];
		if (!botId || knownBotIds.has(botId)) continue;
		await dockerRequest('POST', `/containers/${c.Id}/stop`).catch(() => {});
		const del = await dockerRequest('DELETE', `/containers/${c.Id}?force=1`).catch(() => null);
		if (del && del.status < 300) removed++;
		swept.add(botId);
	}
	// A bot whose containers were deleted out-of-band still owns a volume and
	// screen files; the container loop above never sees it, so the volumes are
	// enumerated too.
	const vols = await dockerRequest('GET', '/volumes').catch(() => null);
	if (vols && vols.status === 200) {
		try {
			const list = JSON.parse(vols.body.toString()) as { Volumes?: { Name: string }[] };
			for (const v of list.Volumes ?? []) {
				if (!v.Name.startsWith('obl-share-')) continue;
				const botId = v.Name.slice('obl-share-'.length);
				if (knownBotIds.has(botId)) continue;
				swept.add(botId);
				await dockerRequest('DELETE', `/volumes/${v.Name}`).catch(() => {});
			}
		} catch {
			// An unreadable volume list skips the file sweep below rather than
			// guessing at bot ids.
		}
	}
	for (const botId of swept) {
		await dockerRequest('DELETE', `/volumes/${shareVolume(botId)}`).catch(() => {});
		await removeMachineNetwork(botId);
		await unlink(thumbPath(botId)).catch(() => {});
		// Dated shots are named <botId-prefix>-<ts>.png; the prefix is enough
		// to match them to the dead bot.
		for (const name of await readdir(SHOT_DIR).catch(() => [] as string[])) {
			if (name.startsWith(`${botId.slice(0, 8)}-`)) {
				await unlink(join(SHOT_DIR, name)).catch(() => {});
			}
		}
	}
	if (removed) logActivity('', 'system', `Removed ${removed} orphaned machine container(s)`);
	return removed;
}

/**
 * Stop every managed container idle past IDLE_MS, and remove reader
 * containers that outlived the read they were made for. Called by the
 * scheduler.
 *
 * `lastActive` alone leaks. It is in-memory, so it is empty at boot: a
 * container that was running when the app restarted is one this process never
 * touches again, and a reaper that only walks the map would leave it running
 * until its bot is deleted. The containers are therefore enumerated from
 * Docker, and one this process has no timestamp for falls back to when Docker
 * says it started (0 - unreadable - counts as idle, since the app owns these).
 */
export async function reapIdleMachines(): Promise<void> {
	const now = Date.now();
	// A bot that has been talking is using the app even when nothing has woken
	// its machine - the Lounge, a routine and a plugin hook all write activity
	// without going near it - so its newest activity row counts as recent use.
	const activity = latestActivityByBot();
	for (const c of await listManaged()) {
		// A reader is a throwaway: the app makes one per file read and removes
		// it in the same call, and nothing ever reuses one. One still here long
		// after that is abandoned - the create answered after the request
		// deadline, so the caller never learned its id to clean up - and left
		// alone they pile up until the daemon is too slow to answer anything,
		// which is what abandons the next one. The grace period is what keeps
		// this from deleting a reader that is still being read.
		if (c.Labels?.['obl.kind'] === 'reader') {
			if (now - (c.Created ?? 0) * 1000 > READER_GRACE_MS) {
				await dockerRequest('DELETE', `/containers/${c.Id}?force=1`).catch(() => {});
			}
			continue;
		}
		if (!isRunning(c)) continue;
		const botId = c.Labels?.['obl.bot'];
		if (!botId) continue;
		// A wake in flight owns this machine until it settles; sleeping it out
		// from under the wake would fail the wake or race its lastActive stamp.
		if (waking.has(botId)) continue;
		// The newest of every signal wins. Docker's own start time is one of
		// them rather than a fallback: activity can predate the container, and a
		// stale row must not be able to sleep a machine that just came up. The
		// list payload's Created covers a container that has never restarted;
		// only one stale on every cheap signal is inspected, which is exactly
		// the set the reaper might stop - a fresh container costs no call.
		const known = Math.max(lastActive[botId] ?? 0, activity[botId] ?? 0, (c.Created ?? 0) * 1000);
		if (now - known <= IDLE_MS) continue;
		const since = Math.max(known, await containerStartedAt(c.Id));
		if (now - since <= IDLE_MS) continue;
		if (c.Labels?.['obl.kind'] !== 'machine') {
			// Legacy boxes and sidecars have no screen to capture; they just stop.
			await dockerRequest('POST', `/containers/${c.Id}/stop`).catch(() => {});
			logActivity(botId, 'sandbox', `Machine sleeping (idle)`);
			continue;
		}
		await sleepMachine(botId).catch(() => {});
		delete lastActive[botId];
	}
}

// -------------------------------------------------------------------- shell

/**
 * The pane as the user sees it: scrollback plus the visible screen, ANSI
 * colour escapes intact. `cols`/`rows` resize the window first so what the
 * user is shown matches the grid their terminal renders it on.
 *
 * Reading the screen counts as using the machine (touchMachine), so a watched
 * terminal is never reaped out from under its viewer.
 */
export async function shellScreen(botId: string, cols = 0, rows = 0): Promise<string> {
	const c = await findContainer(botId);
	if (!c || !isRunning(c)) return '';
	touchMachine(botId);
	if (cols > 0 && rows > 0) {
		// A detached session has no client to size to, so the window is sized
		// explicitly; `window-size manual` keeps tmux from snapping it back.
		await dockerExec(
			c.Id,
			[
				'tmux',
				'set-option',
				'-t',
				SESSION,
				'window-size',
				'manual',
				';',
				'resize-window',
				'-t',
				SESSION,
				'-x',
				String(cols),
				'-y',
				String(rows)
			],
			{ env: TMUX_ENV }
		).catch(() => {});
	}
	/**
	 * The pane as the viewer should draw it: scrollback plus the visible grid,
	 * ANSI colour escapes intact, with the unpainted rows below the cursor
	 * dropped.
	 *
	 * `capture-pane` returns the whole grid - six blank rows below the prompt
	 * at 35x24, sixteen at 80x24 - and a terminal widget puts its cursor after
	 * the last line it is given, so the caret used to sit line-heights below
	 * the prompt. The cursor's row is read in the same exec as the capture, so
	 * the two can never describe different frames, and the cut keeps every
	 * row that is either painted or at-or-above the cursor: trimming blank
	 * rows alone would give the same result for a shell, but would cut the
	 * bottom off a full-screen program (top, vim) whose whole grid is painted
	 * while its cursor sits mid-screen.
	 */
	const capturePane = async (): Promise<string | null> => {
		const res = await dockerExec(
			c.Id,
			[
				'sh',
				'-lc',
				`tmux display-message -p -t ${SESSION} 'OBL #{cursor_y} #{pane_height}' && ` +
					`tmux capture-pane -p -e -t ${SESSION} -S -${SCREEN_LINES}`
			],
			{ env: TMUX_ENV }
		).catch(() => ({ output: '', exitCode: 1 }));
		if (res.exitCode !== 0) return null;
		const raw = res.output.endsWith('\n') ? res.output.slice(0, -1) : res.output;
		const [head, ...rows] = raw.split('\n');
		const at = /^OBL (\d+) (\d+)$/.exec(head ?? '');
		if (!at) return null;
		const cursorY = Number(at[1]);
		const paneHeight = Number(at[2]);
		// The visible grid is the last paneHeight rows; the cursor's row is
		// counted from the grid's top, so it comes back as a row of the whole
		// capture once history is in front of it.
		const cursorRow = Math.max(0, rows.length - paneHeight) + Math.min(cursorY, paneHeight - 1);
		let lastPainted = -1;
		for (let i = rows.length - 1; i >= 0; i--) {
			// Visible content, not length: `-e` can leave a colour escape on a
			// row that prints nothing.
			if (rows[i].replace(ANSI_ESCAPES, '').trim() !== '') {
				lastPainted = i;
				break;
			}
		}
		return rows.slice(0, Math.max(1, Math.max(lastPainted, cursorRow) + 1)).join('\n');
	};
	let screen = await capturePane();
	if (screen === null) {
		// A container restarted outside ensureMachine has no tmux server; the
		// session is recreated once rather than reporting a blank screen until
		// the next command happens to rebuild it.
		await ensureTmux(c.Id, botId).catch(() => {});
		screen = await capturePane();
	}
	return screen ?? '';
}

/**
 * Run a command in the machine's tmux session and return its output.
 *
 * The command is pasted into the pane wrapped in a brace group piped through
 * `tee`, so the user watches it run live while a copy lands in a file. The
 * answer is read from that file, not sliced out of the pane: pane-slicing
 * dropped output that ended without a newline (it glued onto the prompt and
 * the sentinel line) and output that happened to contain the command's last
 * line as a substring. A done-file written after tee exits is the completion
 * signal, so tee has flushed before the output is read.
 */
export async function shellExec(botId: string, command: string, signal?: AbortSignal): Promise<string> {
	// On the driving record before it runs: a command that hangs or closes
	// the pane still happened, and the takeover report should say it did.
	recordDriving(botId, 'shell', `ran in the terminal: ${redactEverySecret(command).slice(0, 200)}`);
	const name = await ensureMachine(botId);
	// Stamped on entry, not just at the end of the wake: a long exec must not
	// let the reaper read the machine as idle while the command is still in it.
	touchMachine(botId);
	const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
	const outPath = `/tmp/obl-out-${nonce}`;
	const rcPath = `/tmp/obl-rc-${nonce}`;
	const donePath = `/tmp/obl-done-${nonce}`;
	// The wrapper is what the pane shows running. `rc` is captured inside the
	// group so `$?` is the command's, not tee's; the done file is written after
	// the pipeline so it can only appear once tee has flushed the output file.
	const wrapped =
		`{ ${command}\nrc=$?\necho $rc > ${rcPath}\n} 2>&1 | tee ${outPath}\n` +
		`echo done > ${donePath}`;
	const b64 = Buffer.from(wrapped, 'utf8').toString('base64');
	// load-buffer takes the text without any quoting hazard (base64 through a
	// pipe) and paste-buffer types it into the pane; the tty runs it when the
	// Enter lands.
	const send = await dockerExec(
		name,
		[
			'sh',
			'-lc',
			`echo ${b64} | base64 -d | tmux load-buffer - && tmux paste-buffer -t ${SESSION} \\; send-keys -t ${SESSION} Enter`
		],
		{ env: TMUX_ENV }
	);
	if (send.exitCode !== 0) {
		throw new Error(`could not type into the machine: ${send.output.slice(-200)}`);
	}
	// One exec polls for the done file instead of hammering the Docker API; it
	// exits 1 when the command outlives the deadline and 2 when the command
	// killed the pane's shell (e.g. `exit`), which ends the session.
	let wait: { output: string; exitCode: number };
	try {
		wait = await dockerExec(
			name,
			[
				'sh',
				'-lc',
				`for i in $(seq 1 ${Math.ceil(MACHINE_EXEC_TIMEOUT_MS / 250)}); do tmux has-session -t ${SESSION} 2>/dev/null || exit 2; [ -f ${donePath} ] && exit 0; sleep 0.25; done; exit 1`
			],
			{ timeoutMs: MACHINE_EXEC_TIMEOUT_MS + 15_000, env: TMUX_ENV, signal }
		);
	} catch (e) {
		// A cancelled turn leaves the command running in the pane: interrupt it
		// the way a person would, then hand back whatever tee had written.
		if (signal?.aborted) {
			await dockerExec(name, ['tmux', 'send-keys', '-t', SESSION, 'C-c'], { env: TMUX_ENV }).catch(() => {});
			const partial = await dockerExec(
				name,
				['sh', '-lc', `cat ${outPath} 2>/dev/null; rm -f ${outPath} ${rcPath} ${donePath}`]
			).catch(() => ({ output: '', exitCode: -1 }));
			return (
				(partial.output.replace(ANSI_ESCAPES, '').trim() || '(no output yet)') +
				'\n(cancelled - the command was interrupted; its output so far is on the machine screen)'
			);
		}
		throw e;
	}
	if (wait.exitCode === 2) {
		recordExec(botId, command, null, '(the command closed the shell)');
		return '(the command closed the shell - a fresh session starts on the next command)';
	}
	// Output and exit code come back in one read, split on a nonce marker. The
	// marker is printed with a leading newline because the output file may not
	// end with one (printf-style commands), and echo would glue onto it.
	const read = await dockerExec(
		name,
		[
			'sh',
			'-lc',
			`cat ${outPath} 2>/dev/null; printf '\\n${MARK}${nonce}\\n'; cat ${rcPath} 2>/dev/null; rm -f ${outPath} ${rcPath} ${donePath}`
		]
	);
	const split = read.output.split(`\n${MARK}${nonce}\n`);
	const out = ((split[0] ?? '').trim()).replace(ANSI_ESCAPES, '');
	const exitCode = Number((split[1] ?? '').trim());
	if (wait.exitCode === 1) {
		// The command is still running; whatever tee has written so far is the
		// partial answer, and the rest is on the machine screen.
		recordExec(botId, command, null, out || '(no output yet)');
		return (
			(out || '(no output yet)') +
			'\n(still running - the command did not finish in time; its output so far is on the machine screen)'
		);
	}
	recordExec(botId, command, Number.isFinite(exitCode) ? exitCode : null, out || '(no output)');
	return (out || '(no output)') + (exitCode === 0 ? '' : `\n(exit code ${Number.isFinite(exitCode) ? exitCode : '?'})`);
}

/**
 * Run a command inside the machine without touching the tmux pane - the quiet
 * counterpart of shellExec, for work the user does not need to watch.
 */
export async function machineExec(
	botId: string,
	command: string,
	signal?: AbortSignal,
	kind = 'exec'
): Promise<string> {
	const name = await ensureMachine(botId);
	// Stamped on entry: a long quiet exec must not read as idle to the reaper.
	touchMachine(botId);
	// Every quiet exec is on the record: the command, redacted of any secret
	// value it happens to carry. The file watcher covers what the command
	// changed; this covers what it was. The kind says whose work it is - the
	// site documenter's fetches land under 'documenter' rather than reading
	// as commands the bot itself ran.
	logActivity(botId, kind, redactEverySecret(command).slice(0, 200));
	// The takeover record only counts work the bot asked for: the same kind
	// check the activity log makes, so a documenter fetch or a plugin run does
	// not read as the bot's own doing when the human grabs the screen.
	if (kind === 'exec') {
		recordDriving(botId, 'shell', `ran quietly: ${redactEverySecret(command).slice(0, 200)}`);
	}
	const res = await dockerExec(name, ['sh', '-lc', command], {
		timeoutMs: MACHINE_EXEC_TIMEOUT_MS,
		signal
	});
	const output = res.output.replace(ANSI_ESCAPES, '');
	recordExec(botId, command, res.exitCode, output);
	return output + (res.exitCode === 0 ? '' : `\n(exit code ${res.exitCode})`);
}

/** How much of one command's output the exec log keeps; the skim clips further. */
const EXEC_LOG_OUTPUT_MAX = 4000;

/**
 * Put one command on the record the police skim reads: the command and its
 * output, both secret-redacted before they are stored, and the exit status -
 * null when the command outlived its deadline rather than finishing. Kept
 * small on purpose: the log is a sample of what the bot ran, not a transcript.
 */
function recordExec(botId: string, command: string, exitCode: number | null, output: string): void {
	try {
		recordExecSample(botId, {
			command: redactEverySecret(command).slice(0, 500),
			exit_code: exitCode,
			output: redactEverySecret(output).slice(0, EXEC_LOG_OUTPUT_MAX)
		});
	} catch {
		// The log is a bonus record: a command that ran is never unrun by a
		// failed write, so a database hiccup costs the sample, not the exec.
	}
}
/**
 * Write a file inside the machine. The content travels base64 through the exec
 * API, so no amount of quoting in it can break out of the command.
 */
export async function machineWriteFile(
	botId: string,
	path: string,
	content: string
): Promise<void> {
	const name = await ensureMachine(botId);
	const b64 = Buffer.from(content, 'utf8').toString('base64');
	const res = await dockerExec(name, [
		'sh',
		'-lc',
		`echo ${b64} | base64 -d > ${path}`
	]);
	if (res.exitCode !== 0) {
		throw new Error(`could not write ${path} in the machine: ${res.output.slice(-200)}`);
	}
}

/**
 * Read a file out of the machine without waking it or touching the network.
 *
 * The machine's network is internal, so the app cannot fetch from it - this
 * goes through the exec API instead. The path must be a plain relative path
 * of safe segments (the caller validates that first); it is read under
 * `root` and comes back base64 so binary files survive the exec framing.
 * Null when the machine is off or the file is not there.
 */
export async function readMachineFile(
	botId: string,
	root: string,
	path: string
): Promise<Buffer | null> {
	const c = await findContainer(botId);
	if (!c || !isRunning(c)) return null;
	const res = await dockerExec(c.Id, ['base64', `${root}/${path}`], { timeoutMs: 15_000 });
	if (res.exitCode !== 0) return null;
	try {
		return Buffer.from(res.output.replace(/\s+/g, ''), 'base64');
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------ browser

/**
 * One numbered interactive element from a page walk: its position in the
 * list is the index browser_click and browser_fill act on.
 */
export interface WalkElement {
	i: number;
	tag: string;
	label: string;
	href: string;
	type: string;
}

/**
 * The page as the browser agent reads it: the text on screen, the numbered
 * elements near the viewport, and how far the page can still scroll.
 */
export interface PageWalk {
	title: string;
	url: string;
	text: string;
	scrollY: number;
	maxScroll: number;
	els: WalkElement[];
}

/**
 * Render a walk as the text-mode page view the browser agent reads: title and
 * URL, the visible text, a scroll hint when there is more below, then the
 * numbered elements it can click or fill.
 */
export function formatWalk(walk: PageWalk): string {
	const lines = [`Title: ${walk.title || '(no title)'}`, `URL: ${walk.url}`, ''];
	if (walk.text) lines.push(walk.text, '');
	if (walk.maxScroll > walk.scrollY + 50) {
		lines.push(
			`[more below - browser_scroll down shows it; scroll ${walk.scrollY} of ${walk.maxScroll}]`,
			''
		);
	}
	if (walk.els.length) {
		lines.push('Elements (click or fill by number):');
		for (const e of walk.els) {
			let line = `[${e.i}] ${e.tag}`;
			if (e.type) line += `(${e.type})`;
			if (e.label) line += ` "${e.label}"`;
			if (e.href) line += ` -> ${e.href}`;
			lines.push(line);
		}
	} else {
		lines.push('(no clickable elements on screen)');
	}
	return lines.join('\n');
}

/** One browser action the in-container driver can take. */
export type BrowseAction =
	| { kind: 'walk' }
	| { kind: 'click'; index: number }
	| { kind: 'fill'; index: number; text: string }
	| { kind: 'scroll'; direction: 'up' | 'down'; amount: 'page' | 'line' }
	| { kind: 'back' }
	| { kind: 'press'; key: string };

/**
 * The line of driver output that names the failure. A Node crash dump ends on
 * the version banner ("Node.js v24.18.1") under a stack of "    at ..." frames,
 * so the last line is the wrong one to read; the real error is the last line
 * that is neither a frame nor the banner.
 */
function driverError(output: string): string {
	const lines = output.trim().split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i].trim();
		if (!l || l.startsWith('at ') || /^Node\.js v[\d.]+$/.test(l)) continue;
		return l;
	}
	return 'the browser did not answer';
}

/**
 * Drive the machine's browser one step and read the page back: click, fill,
 * scroll, back, a key press, or a bare re-read (walk). Every action answers
 * with the fresh walk - the page as it stands after the act - so the agent
 * never works off a stale view. Throws when the browser cannot be driven at
 * all; a page-side refusal (a stale element number, an unknown key) comes
 * back as an error string the agent can act on.
 */
export async function browseAction(
	botId: string,
	action: BrowseAction
): Promise<{ text: string; url: string }> {
	if (machineTier(botId) !== 'full') {
		throw new Error('this bot has no desktop - its machine is terminal-only');
	}
	if (!browserRecipeFor(botId).cdp) {
		throw new Error(
			'this browser cannot be read back - switch to chromium (setup_desktop browser:"chromium")'
		);
	}
	await ensureDesktop(botId);
	const name = machineName(botId);
	// Same refresh navigateBrowser does: a desktop built by an older build
	// keeps that build's driver until the next write.
	await machineWriteFile(botId, '/tmp/obl-cdp.mjs', CDP_SCRIPT);
	const argv = ['node', '/tmp/obl-cdp.mjs', action.kind];
	if (action.kind === 'click') argv.push(String(action.index));
	else if (action.kind === 'fill') argv.push(String(action.index), action.text);
	else if (action.kind === 'scroll') argv.push(action.direction, action.amount);
	else if (action.kind === 'press') argv.push(action.key);
	const res = await dockerExec(name, argv, { timeoutMs: 250_000 });
	if (res.exitCode !== 0) {
		throw new Error(driverError(res.output));
	}
	const line = res.output
		.split('\n')
		.reverse()
		.find((l) => l.startsWith('{'));
	let page: { error?: string; walk?: PageWalk } | null = null;
	if (line) {
		try {
			page = JSON.parse(line) as { error?: string; walk?: PageWalk };
		} catch {
			page = null;
		}
	}
	if (page?.error) throw new Error(page.error);
	if (!page?.walk) {
		throw new Error('the page could not be read back - it may still be loading');
	}
	return { text: formatWalk(page.walk), url: page.walk.url };
}

/**
 * Open a URL in the machine's browser and read the page back. CDP browsers
 * are steered through the in-container driver, which waits for the load and
 * returns the walk - title, URL, the text on screen and the numbered
 * elements - the answer a "what does this page say" task needs, since a
 * screenshot reaches the person's panel and never the model. Any other
 * browser is asked to open the URL itself, which for a running browser lands
 * as a new tab but cannot be read back.
 */
export async function navigateBrowser(botId: string, url: string): Promise<string> {
	if (machineTier(botId) !== 'full') {
		throw new Error('this bot has no desktop - its machine is terminal-only');
	}
	await ensureDesktop(botId);
	const name = machineName(botId);
	if (browserRecipeFor(botId).cdp) {
		// A desktop built by an older build keeps that build's driver, so the
		// script is refreshed before every drive - one small exec - rather
		// than letting a stale driver silently answer without the text.
		await machineWriteFile(botId, '/tmp/obl-cdp.mjs', CDP_SCRIPT);
		const res = await dockerExec(
			name,
			['node', '/tmp/obl-cdp.mjs', 'navigate', url],
			{ timeoutMs: 250_000 }
		);
		if (res.exitCode !== 0) {
			// The driver's last meaningful line names the situation and the fix;
			// a crash dump ends on the Node version banner, so the helper reads
			// past it rather than reporting "Node.js vX" as the error.
			throw new Error(driverError(res.output));
		}
		const line = res.output
			.split('\n')
			.reverse()
			.find((l) => l.startsWith('{'));
		let page: { error?: string; walk?: PageWalk } | null = null;
		if (line) {
			try {
				page = JSON.parse(line) as { error?: string; walk?: PageWalk };
			} catch {
				page = null;
			}
		}
		if (!page) {
			return (
				`opened ${url}, but the page text could not be read back - ` +
				'browser_screenshot shows the person the screen'
			);
		}
		if (page.error) throw new Error(`the page failed to load: ${page.error}`);
		if (!page.walk || (!page.walk.title.trim() && !page.walk.text.trim())) {
			return (
				`opened ${url}, but the page has no readable text yet - it is probably ` +
				'still running its JavaScript; browser_screenshot shows the person the screen'
			);
		}
		return formatWalk(page.walk);
	}
	const res = await dockerExec(name, [
		'sh',
		'-lc',
		`DISPLAY=${DISPLAY} ${browserRecipeFor(botId).start.split(' ')[0]} '${url.replace(/'/g, `'\\''`)}'`
	]);
	if (res.exitCode !== 0) throw new Error(`navigate failed: ${res.output.slice(-200)}`);
	return (
		`opened ${url} in a browser that cannot be read back - switch to chromium ` +
		'(setup_desktop browser:"chromium") to read pages, or curl when the text is the point'
	);
}

// ------------------------------------------------------------------ cookies

/**
 * One cookie as Chromium reports it, trimmed to the fields a re-import needs.
 * The value is a credential: it is never logged, never stored, and never
 * returned to a model - it lives only in the return value of exportCookies and
 * the argument of importCookies, both inside one tool call.
 */
export interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** Seconds since the epoch; absent for a session cookie. */
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: string;
}

/**
 * The hostname a site argument means: a bare hostname, or a URL reduced to its
 * host. Lowercased, with a leading dot (how Chromium reports a domain cookie)
 * and any port or path stripped, so "https://Example.com/x" and ".example.com"
 * both read as "example.com". '' when nothing usable is left.
 */
export function normalizeSite(raw: string): string {
	let s = raw.trim().toLowerCase();
	if (!s) return '';
	if (s.includes('://')) {
		try {
			s = new URL(s).hostname;
		} catch {
			return '';
		}
	} else {
		// A bare host[:port][/path]: keep the host only. An IPv6 literal keeps
		// its brackets and colons, so the port strip is skipped for it.
		s = s.split('/')[0].split('?')[0].split('#')[0];
		if (!s.includes(']')) s = s.split(':')[0];
	}
	return s.replace(/^\.+/, '').replace(/\.+$/, '');
}

/**
 * Whether a cookie belongs to the requested site. Chromium reports a domain
 * cookie with a leading dot (".example.com") and a host-only cookie without one
 * ("example.com"); both are the same site here. A cookie matches when its
 * domain is the site or a subdomain of it - "example.com" takes
 * "www.example.com" but never "notexample.com", because the subdomain test
 * requires the dot. The site's own parent is not included: asking for
 * "www.example.com" does not sweep up "example.com".
 */
export function siteMatchesCookie(site: string, cookieDomain: string): boolean {
	const s = normalizeSite(site);
	if (!s) return false;
	const d = cookieDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
	if (!d) return false;
	return d === s || d.endsWith(`.${s}`);
}

/**
 * Every cookie the bot's browser holds for one site, read over CDP.
 *
 * The site is passed into the driver, which filters before printing, so the
 * rest of the jar never leaves the browser; the app filters again on the way
 * back (siteMatchesCookie) so a driver that answered with more than it should
 * cannot widen the handover. The values travel only in this return value - the
 * driver is run with dockerExec, not machineExec, because an exec command is
 * logged and a cookie value in the activity feed is the leak this feature
 * exists to avoid.
 */
export async function exportCookies(botId: string, site: string): Promise<BrowserCookie[]> {
	if (machineTier(botId) !== 'full') {
		throw new Error('this bot has no desktop - its machine is terminal-only');
	}
	const wanted = normalizeSite(site);
	if (!wanted) throw new Error('site must be a hostname like example.com');
	await ensureDesktop(botId);
	const name = machineName(botId);
	await machineWriteFile(botId, '/tmp/obl-cdp.mjs', CDP_SCRIPT);
	const res = await dockerExec(name, ['node', '/tmp/obl-cdp.mjs', 'cookies', wanted], {
		timeoutMs: 250_000
	});
	if (res.exitCode !== 0) {
		// The driver's output may carry cookie values, so it is never quoted
		// back: an error is the one place a value could reach the model.
		throw new Error('could not read the browser cookies');
	}
	const line = res.output
		.split('\n')
		.reverse()
		.find((l) => l.startsWith('{'));
	let parsed: { cookies?: unknown } | null = null;
	if (line) {
		try {
			parsed = JSON.parse(line) as { cookies?: unknown };
		} catch {
			parsed = null;
		}
	}
	const list = parsed && Array.isArray(parsed.cookies) ? parsed.cookies : [];
	const raw = list.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object');
	return raw
		.filter(
			(c) =>
				typeof c?.name === 'string' &&
				typeof c?.value === 'string' &&
				typeof c?.domain === 'string'
		)
		.filter((c) => siteMatchesCookie(wanted, String(c.domain)))
		.map((c) => ({
			name: String(c.name),
			value: String(c.value),
			domain: String(c.domain),
			path: typeof c.path === 'string' && c.path ? c.path : '/',
			...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
			...(c.httpOnly === true ? { httpOnly: true } : {}),
			...(c.secure === true ? { secure: true } : {}),
			...(typeof c.sameSite === 'string' && c.sameSite ? { sameSite: c.sameSite } : {})
		}));
}

/**
 * Put cookies into the bot's own browser over CDP, so the tools that drive that
 * browser see them - the same profile, not a second one. The payload is written
 * as a file through machineWriteFile, never as an exec argument, because an
 * exec command is logged; the file is removed once the driver has read it, so
 * the only place a cookie value was written down does not outlive the import.
 * Returns how many the browser accepted.
 */
export async function importCookies(botId: string, cookies: BrowserCookie[]): Promise<number> {
	if (machineTier(botId) !== 'full') {
		throw new Error('this bot has no desktop - its machine is terminal-only');
	}
	if (!cookies.length) return 0;
	await ensureDesktop(botId);
	const name = machineName(botId);
	await machineWriteFile(botId, '/tmp/obl-cdp.mjs', CDP_SCRIPT);
	const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
	const path = `/tmp/obl-cookies-${nonce}.json`;
	await machineWriteFile(botId, path, JSON.stringify(cookies));
	try {
		const res = await dockerExec(name, ['node', '/tmp/obl-cdp.mjs', 'setcookies', path], {
			timeoutMs: 250_000
		});
		if (res.exitCode !== 0) throw new Error('the browser refused the cookies');
		const line = res.output
			.split('\n')
			.reverse()
			.find((l) => l.startsWith('{'));
		if (!line) return 0;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === 'object' && 'set' in parsed) {
				const n = Number(parsed.set);
				return Number.isFinite(n) ? n : 0;
			}
			return 0;
		} catch {
			return 0;
		}
	} finally {
		// The payload must not outlive the import: the file is the only place a
		// cookie value was written down.
		await dockerExec(name, ['sh', '-lc', `rm -f ${path}`]).catch(() => {});
	}
}

/**
 * Where the bot's pointer is, and how big its screen is.
 *
 * Read without waking anything: the panel polls this while it is watching, and
 * a sleeping machine has no pointer to report - polling must not be the thing
 * that keeps one awake. Returns null whenever the answer is not available.
 */
export async function readPointer(
	botId: string
): Promise<{ x: number; y: number; w: number; h: number } | null> {
	try {
		const c = await findContainer(botId);
		if (!c || !isRunning(c)) return null;
		const res = await dockerExec(
			c.Id,
			[
				'sh',
				'-lc',
				`DISPLAY=${DISPLAY} xdotool getmouselocation --shell; DISPLAY=${DISPLAY} xdotool getdisplaygeometry`
			],
			// Shorter than a shell command's ceiling: this is on a refresh timer.
			{ timeoutMs: 4000 }
		);
		if (res.exitCode !== 0) return null;
		const x = /^X=(\d+)/m.exec(res.output);
		const y = /^Y=(\d+)/m.exec(res.output);
		const geom = /^(\d+) (\d+)$/m.exec(res.output);
		if (!x || !y || !geom) return null;
		return { x: Number(x[1]), y: Number(y[1]), w: Number(geom[1]), h: Number(geom[2]) };
	} catch {
		return null;
	}
}

/**
 * A rectangle of the screen, in pixels, as a bot asks for one.
 */
export interface ShotRegion {
	/** Left edge in pixels. */
	x: number;
	/** Top edge in pixels. */
	y: number;
	/** Width in pixels. */
	w: number;
	/** Height in pixels. */
	h: number;
}

/**
 * Clamp a requested rectangle to the screen. Returns null when the rectangle
 * misses the screen entirely: there is nothing to capture, and ImageMagick's
 * own out-of-bounds crop answers with a 1x1 image rather than an error, which
 * would post a useless picture where a refusal belongs.
 */
export function clampRegion(
	region: ShotRegion,
	screen: { w: number; h: number }
): ShotRegion | null {
	const x = Math.max(0, Math.floor(region.x));
	const y = Math.max(0, Math.floor(region.y));
	const right = Math.min(screen.w, Math.floor(region.x + region.w));
	const bottom = Math.min(screen.h, Math.floor(region.y + region.h));
	const w = right - x;
	const h = bottom - y;
	if (w <= 0 || h <= 0) return null;
	return { x, y, w, h };
}

/**
 * Capture the machine's screen as base64 PNG, with the pointer drawn on it.
 *
 * X11 root-window captures do not contain the cursor at all - Xvnc has no way
 * to render it into the framebuffer - so a bot looking at a picture of its own
 * screen would not see its own hand. The arrow is therefore composited in,
 * from the same art as the X cursor theme, so the screenshot and the live
 * screen agree.
 *
 * All of it happens in one command in the container: reading the position in a
 * separate call would draw the arrow wherever the bot's hand was a round trip
 * ago, and the frame is grabbed first so the position that gets drawn is the
 * newest one there is. A pointer that cannot be read, or an arrow that is not
 * there, costs the arrow and never the screenshot.
 *
 * `gridPx` burns a labelled coordinate grid into the picture: a line every
 * that many pixels with its coordinate printed at the edge, so a model asked
 * to name a point on the screen can read the numbers off the image instead of
 * guessing at pixels. The grid is drawn after the crop, so the labels always
 * match the pixels the caller is looking at. A grid that fails to draw costs
 * the grid, never the screenshot - the ungridded frame is still worth having.
 */
export function screenshotCommand(
	outPath = SCREENSHOT_PATH,
	themeDir = THEME_DIR,
	region?: ShotRegion,
	gridPx = 0
): string {
	const { x: hotX, y: hotY } = CURSOR_HOTSPOT;
	const offset = (axis: 'x' | 'y', hot: number) => `+$(( ${axis} > ${hot} ? ${axis} - ${hot} : 0 ))`;
	const arrow = `${themeDir}/pointer.png`;
	// The region is clamped against the screen before this runs, so the crop
	// always lands inside the frame. It is applied after the arrow is
	// composited, so a region shows the same pointer the full screen would.
	const steps = [
		// A capture from an earlier call must not be mistaken for this one's:
		// the file is removed first, and its absence at the end is the failure.
		`rm -f ${outPath}`,
		'tmp=$(mktemp -d)',
		'shot="$tmp/shot.png"',
		`DISPLAY=${DISPLAY} import -window root "$shot" 2>/dev/null`,
		`pos=$(DISPLAY=${DISPLAY} xdotool getmouselocation --shell 2>/dev/null)`,
		"x=$(printf '%s\\n' \"$pos\" | sed -n 's/^X=//p')",
		"y=$(printf '%s\\n' \"$pos\" | sed -n 's/^Y=//p')",
		`[ -s "$shot" ] && [ -n "$x" ] && [ -n "$y" ] && [ -f ${arrow} ] && convert "$shot" ${arrow} -geometry "${offset('x', hotX)}${offset('y', hotY)}" -composite "$shot" 2>/dev/null`
	];
	// The crop is the source when one was asked for, so a crop that fails
	// leaves nothing to copy rather than falling back to the whole screen.
	let src = '"$shot"';
	if (region) {
		steps.push(
			`[ -s "$shot" ] && convert "$shot" -crop ${region.w}x${region.h}+${region.x}+${region.y} +repage "$tmp/crop.png" 2>/dev/null`
		);
		src = '"$tmp/crop.png"';
	}
	if (gridPx > 0) {
		// The grid is its own frame: the line and label strings are built over
		// the (possibly cropped) source's real size, and a failed draw leaves
		// the ungridded source to copy rather than nothing at all.
		steps.push(
			`[ -s ${src} ] && dim=$(identify -format '%w %h' ${src} 2>/dev/null)`,
			'gw=$(printf \'%s\' "$dim" | cut -d\' \' -f1); gh=$(printf \'%s\' "$dim" | cut -d\' \' -f2)',
			`[ -n "$gw" ] && [ -n "$gh" ] && lines='' && labels='' && ` +
				`gx=0; while [ "$gx" -le "$gw" ]; do lines="$lines line $gx,0 $gx,$gh"; ` +
				`labels="$labels text $((gx + 2)),10 '$gx'"; gx=$((gx + ${gridPx})); done; ` +
				`gy=0; while [ "$gy" -le "$gh" ]; do lines="$lines line 0,$gy $gw,$gy"; ` +
				`labels="$labels text 2,$((gy + 10)) '$gy'"; gy=$((gy + ${gridPx})); done; ` +
				`convert ${src} -fill none -stroke '#ff2020' -strokewidth 1 -draw "$lines" ` +
				`-stroke none -undercolor '#000000b0' -fill '#ffe000' -pointsize 11 -draw "$labels" "$tmp/grid.png" 2>/dev/null`
		);
		src = '"$tmp/grid.png"';
	}
	steps.push(
		`[ -s ${src} ] && cp ${src} ${outPath}`,
		'rm -rf "$tmp"',
		`[ -s ${outPath} ] || exit 1`
	);
	return steps.join('; ');
}

/**
 * Wait out a desktop that may still be installing: the ready marker the setup
 * script touches last, polled for the whole setup window so a first-ever call
 * on a cold machine does not fail while apk is still running.
 */
async function awaitDesktopReady(name: string): Promise<void> {
	const ready = await dockerExec(
		name,
		['sh', '-lc', `for i in $(seq 1 ${Math.ceil(DESKTOP_SETUP_TIMEOUT_MS / 2000)}); do [ -f ${DESKTOP_READY} ] && exit 0; sleep 2; done; exit 1`],
		{ timeoutMs: DESKTOP_SETUP_TIMEOUT_MS + 15_000 }
	);
	if (ready.exitCode !== 0) throw new Error('the desktop did not come up in time');
}

/** Take a screenshot of the bot's screen; returns base64 PNG. */
export async function machineScreenshot(
	botId: string,
	region?: ShotRegion,
	gridPx = 0
): Promise<string> {
	if (machineTier(botId) !== 'full') {
		throw new Error('this bot has no desktop - its machine is terminal-only');
	}
	await ensureDesktop(botId);
	const name = machineName(botId);
	await awaitDesktopReady(name);
	const res = await dockerExec(
		name,
		['sh', '-lc', screenshotCommand(SCREENSHOT_PATH, THEME_DIR, region, gridPx)],
		{
			timeoutMs: SCREENSHOT_TIMEOUT_MS
		}
	);
	if (res.exitCode !== 0) throw new Error(`screenshot failed: ${res.output.slice(-200)}`);
	const archive = await dockerRequest(
		'GET',
		`/containers/${name}/archive?path=${encodeURIComponent(SCREENSHOT_PATH)}`
	);
	if (archive.status !== 200) throw new Error(`screenshot read ${archive.status}`);
	const png = tarEntry(archive.body);
	if (!png || png.length === 0) throw new Error('screenshot came back empty');
	return png.toString('base64');
}

/**
 * One gesture against the desktop, as the input tools ask for it. Every kind
 * is an xdotool invocation on the desktop's display: coordinates are screen
 * pixels, the same frame the gridded screenshot labels.
 */
export type DesktopGesture =
	| { kind: 'move'; x: number; y: number }
	| { kind: 'click'; x: number; y: number; button: number; clicks: number }
	| { kind: 'scroll'; x: number; y: number; button: number; clicks: number }
	| { kind: 'type'; text: string }
	| { kind: 'key'; keys: string };

/**
 * Drive the desktop's mouse and keyboard through xdotool. The gesture's
 * arguments travel as exec argv, never through a shell, so typed text and key
 * names cannot be reinterpreted; the leading `--` keeps a value that starts
 * with a dash from being read as a flag. The desktop must be up: like a
 * screenshot, an input call waits out the install window rather than failing
 * a first gesture on a cold machine.
 */
export async function desktopInput(botId: string, gesture: DesktopGesture): Promise<void> {
	if (machineTier(botId) !== 'full') {
		throw new Error('this bot has no desktop - its machine is terminal-only');
	}
	await ensureDesktop(botId);
	const name = machineName(botId);
	await awaitDesktopReady(name);
	// A click and a scroll are the same xdotool pair - move, then click a
	// button some number of times - with the wheel buttons (4 up, 5 down)
	// standing in for the scroll direction.
	const args =
		gesture.kind === 'move'
			? ['mousemove', '--', String(gesture.x), String(gesture.y)]
			: gesture.kind === 'type'
				? ['type', '--', gesture.text]
				: gesture.kind === 'key'
					? ['key', '--', gesture.keys]
					: [
							'mousemove', '--', String(gesture.x), String(gesture.y),
							'click', '--repeat', String(gesture.clicks), '--', String(gesture.button)
						];
	const res = await dockerExec(name, ['xdotool', ...args], {
		timeoutMs: 15_000,
		env: [`DISPLAY=${DISPLAY}`]
	});
	if (res.exitCode !== 0) {
		throw new Error(`input failed: ${res.output.slice(-200) || `exit ${res.exitCode}`}`);
	}
	// On the driving record with the window the gesture left in focus: the
	// title is read after the input lands so a click that opened a window
	// names it. Typed text is recorded by length, never verbatim - the report
	// is a story of what the bot did, not a keylogger, and the text may carry
	// a secret the transcript must never see.
	recordDriving(
		botId,
		gesture.kind,
		gesture.kind === 'move'
			? `moved the pointer to (${gesture.x}, ${gesture.y})`
			: gesture.kind === 'type'
				? `typed ${gesture.text.length} characters`
				: gesture.kind === 'key'
					? `pressed ${gesture.keys}`
					: gesture.kind === 'scroll'
						? `scrolled ${gesture.button === 4 ? 'up' : 'down'} at (${gesture.x}, ${gesture.y})`
						: `${gesture.clicks === 2 ? 'double-' : ''}clicked at (${gesture.x}, ${gesture.y})`,
		await activeWindowTitle(name)
	);
}


// ------------------------------------------------------------- screen grabs

/** Directory holding each bot's last-seen screen grab. */
const SCREEN_DIR = join(config.dataDir, 'screens');

const thumbPath = (botId: string) => join(SCREEN_DIR, `${botId}.png`);

/** Save the machine's current screen as its last-seen image. Best effort. */
export async function captureSnapshot(botId: string): Promise<boolean> {
	try {
		const b64 = await machineScreenshot(botId);
		if (!b64) return false;
		await mkdir(SCREEN_DIR, { recursive: true });
		await writeFile(thumbPath(botId), Buffer.from(b64, 'base64'));
		return true;
	} catch {
		return false;
	}
}

/** Directory of dated screen grabs, used by the per-bot log view. */
const SHOT_DIR = join(config.dataDir, 'shots');

/** How many shots may be written between sweeps of the ones nothing points at. */
const SHOT_SWEEP_EVERY = 50;
/** A shot this new may still be waiting for the activity row that names it. */
const SHOT_GRACE_MS = 5 * 60_000;
let shotsSinceSweep = 0;

/** Save a screen grab for the log view; returns its filename. */
export async function captureShot(botId: string, region?: ShotRegion): Promise<string> {
	try {
		const b64 = await machineScreenshot(botId, region);
		if (!b64) return '';
		await mkdir(SHOT_DIR, { recursive: true });
		const name = `${botId.slice(0, 8)}-${Date.now()}.png`;
		await writeFile(join(SHOT_DIR, name), Buffer.from(b64, 'base64'));
		if (++shotsSinceSweep >= SHOT_SWEEP_EVERY) {
			shotsSinceSweep = 0;
			await sweepOrphanShots();
		}
		return name;
	} catch {
		return '';
	}
}

/**
 * Delete screen grabs no activity refers to.
 *
 * The log keeps the newest 2000 activities and drops the rest, which takes the
 * rows but not their pictures: every shot a bot ever took stayed on disk, about
 * 30KB each, with nothing left to name it.
 */
export async function sweepOrphanShots(): Promise<number> {
	try {
		// A shot is kept while either an activity row or a chat message still
		// names it: a screenshot a bot sent into the thread is referenced by the
		// message, not by an activity, and must not be swept out from under it.
		const referenced = new Set([...listActivityImages(), ...listMessageImages()]);
		let removed = 0;
		for (const name of await readdir(SHOT_DIR)) {
			if (referenced.has(name)) continue;
			const path = join(SHOT_DIR, name);
			try {
				// A shot younger than the grace period may be about to be named by
				// the activity row for the turn that just took it.
				if (Date.now() - (await stat(path)).mtimeMs < SHOT_GRACE_MS) continue;
				await unlink(path);
				removed++;
			} catch {
				// Gone already.
			}
		}
		return removed;
	} catch {
		// No shots directory yet.
		return 0;
	}
}

/** Read a stored screen grab. `name` comes from an activity row, never a user. */
export async function readShot(name: string): Promise<Buffer | null> {
	// Reject anything that is not a plain filename so a crafted name cannot
	// walk out of the shots directory.
	if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
	try {
		return await readFile(join(SHOT_DIR, name));
	} catch {
		return null;
	}
}

/** The stored last-seen screen for a bot, or null if none was captured. */
export async function readSnapshot(botId: string): Promise<Buffer | null> {
	try {
		return await readFile(thumbPath(botId));
	} catch {
		return null;
	}
}

// ---- Police sanctions ----

/**
 * Cap the bot's running machine at `bytes` of RAM, live: the update lands on
 * the running container, so the next fork that wants more is refused instead
 * of eating the host. No container - chat-only, or never built - throws 'no
 * machine': the caller files an alert and moves on, because a bot with no box
 * is not a failed round.
 */
export async function limitMachineMemory(botId: string, bytes: number): Promise<void> {
	if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('no machine');
	const c = await findContainer(botId);
	if (!c) throw new Error('no machine');
	const res = await dockerRequest('POST', `/containers/${c.Id}/update`, { Memory: bytes });
	if (res.status !== 200) throw new Error(`Docker update failed ${res.status}`);
}

/**
 * The host's real memory, read from /proc/meminfo: the app runs on the host,
 * so this is the figure the containers are all drawing against. Null when the
 * file cannot be read - a non-Linux host, or a proc mount that is not there -
 * which the caller treats as "unknown", never as "tight".
 */
export async function hostMemory(): Promise<{ totalKb: number; availableKb: number } | null> {
	try {
		const text = await readFile('/proc/meminfo', 'utf8');
		const total = /MemTotal:\s+(\d+)\s*kB/.exec(text);
		const available = /MemAvailable:\s+(\d+)\s*kB/.exec(text);
		if (!total || !available) return null;
		return { totalKb: Number(total[1]), availableKb: Number(available[1]) };
	} catch {
		return null;
	}
}

/**
 * The bot machine's own memory use, in bytes, read from the container's
 * cgroup rather than a `docker stats` stream: one exec, no sampling. Null
 * when there is no machine or the read fails - the review treats it as
 * unknown, the same as a bot with no box.
 */
export async function machineMemoryUsage(botId: string): Promise<number | null> {
	try {
		const c = await findContainer(botId);
		if (!c) return null;
		// cgroup v2 keeps it in memory.current; v1 in memory.usage_in_bytes.
		const res = await dockerExec(
			c.Id,
			['sh', '-lc', 'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null | head -1'],
			{ timeoutMs: 10_000 }
		);
		const bytes = Number(res.output.trim());
		return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
	} catch {
		return null;
	}
}

/**
 * Stop the bot's runaway children and return how many went. With a pattern
 * the review named one thing misbehaving and only its processes are stopped;
 * without one every child goes except the three that are the box itself: pid
 * 1, the `sleep infinity` it runs, and the tmux server holding the session.
 * Pids are gathered from one `ps` snapshot and matched in here, so the
 * pattern never enters the box as code - what runs inside is `ps` and `kill`
 * with numeric pids only.
 */
export async function killMachineChildren(botId: string, pattern?: string): Promise<number> {
	const c = await findContainer(botId);
	if (!c) throw new Error('no machine');
	const listing = await dockerExec(c.Id, ['sh', '-lc', 'ps -o pid,args']);
	const targets: string[] = [];
	for (const line of listing.output.split('\n')) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		if (Number(m[1]) <= 1) continue;
		const args = m[2];
		if (pattern) {
			if (args.includes(pattern)) targets.push(m[1]);
		} else {
			const base = (args.split(/\s+/)[0].split('/').pop() ?? '').toLowerCase();
			if (base === 'sleep' || base.startsWith('tmux')) continue;
			targets.push(m[1]);
		}
	}
	if (!targets.length) return 0;
	await dockerExec(c.Id, ['sh', '-lc', `kill -9 ${targets.join(' ')} 2>/dev/null; true`]);
	const after = await dockerExec(c.Id, ['sh', '-lc', 'ps -o pid']);
	const alive = new Set(
		after.output.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l))
	);
	return targets.filter((pid) => !alive.has(pid)).length;
}
