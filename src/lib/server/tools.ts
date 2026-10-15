import { HATS, isHat } from '$lib/hats';
import type { ToolDef } from './llm';
import { BOT_PERSONA_MAX, botDraftError } from './bot-draft';
import {
	addMessage,
	addNote,
	addReaction,
	blockBetween,
	blockBot,
	botPairConversation,
	botConversationIds,
	clearConversationMembers,
	createBotProposal,
	createConversation,
	conversationBots,
	createPlugin,
	createMachineResetRequest,
	createChangeRequest,
	createSshRequest,
	deleteRoutine,
	deleteWake,
	directConversationWith,
	getBot,
	getConversation,
	getMessage,
	getTask,
	latestMessageFromOthers,
	listActivities,
	listBlocks,
	listBots,
	listConversations,
	listBotFiles,
	listMemories,
	listPlugins,
	listRoutines,
	listSettings,
	listTasks,
	listWakes,
	logActivity,
	pendingMachineReset,
	pendingChangeRequests,
	logEvent,
	parseBubbleThemes,
	removeReaction,
	recentRelayMessage,
	searchHistory,
	setConversationVerification,
	setMemory,
	setRoutineVerification,
	setSetting,
	setWakeEnabled,
	setWakeVerification,
	unblockBot,
	updateBot,
	updateConversation,
	type Bot,
	type BotFile,
	type Plugin,
	type WaitCondition
} from './db';

import { sshPublicKey } from './ssh-keys';
import {
	captureShot,
	clampRegion,
	desktopInput,
	exportCookies,
	IDLE_MINUTES,
	importCookies,
	machineExec,
	machineScreenshot,
	machineStatus,
	machineTier,
	browseAction,
	navigateBrowser,
	normalizeSite,
	readPointer,
	setupDesktop,
	shellExec,
	sleepMachine,
	ensureMachine,
	type BrowseAction,
	type BrowserCookie,
	type DesktopGesture,
	type ShotRegion
} from './machine';
import { humanSize, isTextMime, joinCapped, numberedLine, readFileBytes, textLines } from './files';
import { askForDebugAccess, executeDebugTool, isDebugTool } from './debug';
import { sanitizeChatCss } from './look';
import { sanitizeIconSvg, pluginsForBot, selfTestPlugin, updatePlugin, createPlugin as createPluginWithIcon } from './plugins';
import { policePlugin, signOff } from './plugin-gate';
import { companyProfiles } from './profiles';
import { appendScratchpad } from './personality';
import { sendToPeer } from './federation';
// tools <-> tasks <-> runner is a cycle; cancelTask is a hoisted declaration
// only called at runtime, so the partial module is fine.
import { cancelTask } from './tasks';
import {
	createWait,
	MIN_WATCH_INTERVAL_MS,
	scheduleWake,
	WATCH_KIND_NAMES,
	type WatchSpec
} from './wake';
import { createWebhook, deleteWebhook, listWebhooks, webhookUrl } from './webhooks';
import {
	applyAttempt,
	consultRefusal,
	ensurePoliceBot,
	policeModel,
	policeSettings,
	resolveTreat,
	reviewCookieHandover,
	reviewPlugin,
	reviewRoom,
	reviewRoutine,
	verdictJson,
	type CreationVerdict
} from './police';
import { castVote, openArchiveVote } from './votes';
import { noteDomainVisit } from './site-docs';


import { askForThinking } from './thinking';

import {
	createSecret,
	getSecret,
	injectSecret,
	redactSecrets,
	SECRET_NAME_RE,
	shareSecret,
	unshareSecret,
	recordSecretDecline,
	usableSecrets
} from './secrets';

/**
 * The computer tools - shell and desktop. These are NOT in the bot's main tool
 * list: the reply loop reaches them only through `use_computer`, which hands the
 * task to a sub-agent (computer-agent.ts) that runs them in its own loop. A bot
 * never drives its sandbox directly, so a long command or a multi-step page
 * task cannot stall the reply or flood its context with raw output.
 *
 * Reading the web is not here: browser_navigate and the page-walk tools live
 * in BROWSER_TOOLS, which only the browser sub-agent (browser-agent.ts,
 * reached through `browse`) holds. The pixel input tools are shared - the
 * browser agent falls back to them for canvas games and elements the DOM
 * walk cannot name.
 */
export const COMPUTER_TOOLS: ToolDef[] = [
	{
		type: 'function',
		function: {
			name: 'shell_exec',
			description:
				'Run a shell command on your machine and get its output. It is one ' +
				'Alpine Linux box: machine:"desktop" (the default) runs quietly in ' +
				'the background, machine:"shell" types it into the terminal the ' +
				'person can watch. Both mount /shared (files just for you) and ' +
				'/company (a drive every bot shares).',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to run' },
					machine: {
						type: 'string',
						enum: ['desktop', 'shell'],
						description: 'Where to run it (default: desktop, quietly; "shell" shows it on the terminal)'
					}
				},
				required: ['command']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'browser_screenshot',
			description:
				'Capture what is on your desktop screen right now. The picture goes ' +
				"to the person's screen panel - you get no pixels back, so it can " +
				'never tell you what a page says; browser_navigate returns the text.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'send_screenshot',
			description:
				'Take a picture of your desktop screen and send it into the chat, ' +
				'so the person sees it in the thread. Give a pixel rectangle (x, y, ' +
				'width, height) to send just part of the screen, or leave the ' +
				'rectangle out for the whole screen. You get no pixels back - this ' +
				'shows the person something; use browser_navigate to read a page.',
			parameters: {
				type: 'object',
				properties: {
					x: { type: 'number', description: 'Left edge of the region in pixels (default 0)' },
					y: { type: 'number', description: 'Top edge of the region in pixels (default 0)' },
					width: { type: 'number', description: 'Width of the region in pixels (omit for the full screen)' },
					height: { type: 'number', description: 'Height of the region in pixels (omit for the full screen)' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'screen_look',
			description:
				'Look at your desktop screen: takes a fresh screenshot with a ' +
				'labelled coordinate grid and shows it to you. Mouse and keyboard ' +
				'tools refuse to act until you have looked - and every action ' +
				'changes the screen, so look again before the next one.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'mouse_click',
			description:
				'Click the mouse at a point on your desktop screen. x and y are ' +
				'screen pixels - read them off the grid in your last screenshot. ' +
				'button is 1 left, 2 middle, 3 right; clicks is 1 or 2 (double). ' +
				'You must have looked at the screen since your last action.',
			parameters: {
				type: 'object',
				properties: {
					x: { type: 'number', description: 'Horizontal pixel on the screen' },
					y: { type: 'number', description: 'Vertical pixel on the screen' },
					button: { type: 'number', description: '1 left (default), 2 middle, 3 right' },
					clicks: { type: 'number', description: '1 single (default), 2 double' }
				},
				required: ['x', 'y']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'mouse_move',
			description:
				'Move the mouse pointer to a point on your desktop screen without ' +
				'clicking - for hovering. x and y are screen pixels from the grid ' +
				'in your last screenshot. You must have looked at the screen ' +
				'since your last action.',
			parameters: {
				type: 'object',
				properties: {
					x: { type: 'number', description: 'Horizontal pixel on the screen' },
					y: { type: 'number', description: 'Vertical pixel on the screen' }
				},
				required: ['x', 'y']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'mouse_scroll',
			description:
				'Scroll the mouse wheel at a point on your desktop screen. x and ' +
				'y are screen pixels from the grid in your last screenshot; ' +
				'direction is up or down; clicks is how many wheel steps ' +
				'(default 3). You must have looked at the screen since your last ' +
				'action.',
			parameters: {
				type: 'object',
				properties: {
					x: { type: 'number', description: 'Horizontal pixel on the screen' },
					y: { type: 'number', description: 'Vertical pixel on the screen' },
					direction: { type: 'string', enum: ['up', 'down'], description: 'Wheel direction (default down)' },
					clicks: { type: 'number', description: 'Wheel steps (default 3)' }
				},
				required: ['x', 'y']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'type_text',
			description:
				'Type text at the desktop\'s keyboard focus - into whatever ' +
				'window or field is focused after your last click. You must have ' +
				'looked at the screen since your last action.',
			parameters: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'The text to type' }
				},
				required: ['text']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'key_press',
			description:
				'Press a key or key combination at the desktop\'s keyboard ' +
				'focus, named the xdotool way: "Return", "Tab", "Escape", ' +
				'"ctrl+s", "alt+F4", "ctrl+alt+t". You must have looked at the ' +
				'screen since your last action.',
			parameters: {
				type: 'object',
				properties: {
					keys: { type: 'string', description: 'Key or combination, e.g. "Return" or "ctrl+s"' }
				},
				required: ['keys']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'setup_desktop',
			description:
				'Choose the desktop your machine runs and (re)build it. Pick a ' +
				'window manager recipe and a browser recipe from the fixed ' +
				'catalog; leave one out to keep it. The desktop reinstalls with ' +
				'the new recipe - give it a minute before navigating.',
			parameters: {
				type: 'object',
				properties: {
					desktop: {
						type: 'string',
						enum: ['openbox', 'xfce', 'icewm'],
						description: 'Window manager recipe: openbox (light, default), xfce (full desktop), icewm (light with start menu)'
					},
					browser: {
						type: 'string',
						enum: ['chromium', 'firefox'],
						description: 'Browser recipe: chromium (default, fully steerable), firefox (opens pages but cannot be read back)'
					}
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'company_read',
			description:
				'Read a file on the /company shared drive one page at a time. Always ' +
				'use this for /company files instead of cat/sed dumps - it returns a ' +
				'bounded page plus the page count so you can page through.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'File path, absolute or relative to /company'
					},
					page: {
						type: 'number',
						description: 'Page number, 1-based (default: 1)'
					}
				},
				required: ['path']
			}
		}
	}
];

/**
 * The browser tools - the page walk and the acts that change it. These are
 * NOT in the bot's main tool list either: `browse` hands the task to the
 * browser sub-agent (browser-agent.ts), which reads pages as text - the
 * walk's numbered elements, not pixels - and only reaches for the shared
 * screen tools when the DOM cannot name what it needs to click.
 */
export const BROWSER_TOOLS: ToolDef[] = [
	{
		type: 'function',
		function: {
			name: 'browser_navigate',
			description:
				'Open a URL in the browser and read the page back: the title, the ' +
				'URL it landed on, the text on screen and a numbered list of the ' +
				'elements you can click or fill. Use this first for any ' +
				'open/visit/read-a-page task - it renders the JavaScript, where ' +
				'curl on the same URL often returns an empty shell.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'URL to open' }
				},
				required: ['url']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'browser_walk',
			description:
				'Re-read the page as it stands: the text on screen and the ' +
				'numbered elements. Element numbers go stale whenever the page ' +
				'changes - walk again rather than trusting an old list.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'browser_click',
			description:
				'Click an element by its number from the last page view - a link, ' +
				'a button, a tab. You get the page back as it stands after the ' +
				'click, with fresh element numbers.',
			parameters: {
				type: 'object',
				properties: {
					index: { type: 'number', description: 'Element number from the last page view' }
				},
				required: ['index']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'browser_fill',
			description:
				'Fill a field by its number from the last page view - an input, ' +
				'textarea, select or editable region - then read the page back. ' +
				'For a select, name the option by its text or value.',
			parameters: {
				type: 'object',
				properties: {
					index: { type: 'number', description: 'Element number from the last page view' },
					text: { type: 'string', description: 'The text or option to set' }
				},
				required: ['index', 'text']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'browser_scroll',
			description:
				'Scroll the page and read what comes into view: the text and the ' +
				'elements now on screen. Scroll before clicking - the numbered ' +
				'list only covers what is near the viewport.',
			parameters: {
				type: 'object',
				properties: {
					direction: { type: 'string', enum: ['up', 'down'], description: 'Which way (default down)' },
					amount: {
						type: 'string',
						enum: ['page', 'line'],
						description: 'A screenful (default) or a few lines'
					}
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'browser_back',
			description:
				'Go back one page in the browser history and read what you land ' +
				'on - the way out of a wrong turn or a dead end.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'browser_press',
			description:
				'Press a key in the page: enter (submits a form you just filled), ' +
				'tab, escape (dismisses a dialog), backspace, space, the arrows, ' +
				'home, end, pageup, pagedown. You get the page back after it.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'Key name, e.g. "enter" or "escape"' }
				},
				required: ['key']
			}
		}
	},
	// The shared screen tools, by reference: the walk is the browser agent's
	// eyes, but a canvas game or a widget the DOM cannot name still needs the
	// pixel path - look at the grid, then click or type at coordinates.
	...COMPUTER_TOOLS.filter((t) =>
		[
			'browser_screenshot',
			'send_screenshot',
			'screen_look',
			'mouse_click',
			'mouse_move',
			'mouse_scroll',
			'type_text',
			'key_press'
		].includes(t.function.name)
	)
];

/**
 * The grid spacing burned into screenshots the model sees, in pixels: close
 * enough that a coordinate is always a short count from a labelled line, wide
 * enough that the labels do not bury the screen.
 */
export const SCREEN_GRID_PX = 100;

/**
 * Tools every bot can use directly. Computer work is delegated: `use_computer`
 * is the only entry point, and the machine lifecycle tools (sleep/wake/status)
 * stay here because they are cheap state calls, not actions on the machine.
 */
export const BOT_TOOLS: ToolDef[] = [
	{
		type: 'function',
		function: {
			name: 'use_computer',
			description:
				'Hand a task to your computer operator, a sub-agent that drives your ' +
				'machine for you. It is one Alpine Linux box with a terminal the ' +
				'person can watch and a desktop it can set up (a window manager and ' +
				'a browser, chosen from a recipe catalog). It mounts /shared (files ' +
				'just for you) and /company (a drive every bot shares; changes ' +
				'there are logged). ' +
				'The operator sees the desktop: a fresh screenshot is fed to it ' +
				'each step, and it drives the real mouse and keyboard - clicking, ' +
				'typing, scrolling - so it can work a site the way a person does, ' +
				'and play games or run GUI apps by watching the screen. It can also ' +
				'send a screenshot of the screen into this chat when the task is ' +
				'to show the person something. ' +
				'The network reaches the web only through the HTTP proxy already set ' +
				'in its environment: curl and wget work for APIs and downloads, ping ' +
				'and other ICMP tools never work; raw TCP to public hosts tunnels ' +
				'through the proxy (ssh included), and only private addresses are ' +
				'refused. ' +
				'Describe the goal - "install x", "fetch this URL and summarise it", ' +
				'"send me a screenshot of the page" - and it reports back. Use this ' +
				'for anything that needs a shell or the desktop: installing and ' +
				'running software, games, tools, anything visual or interactive. ' +
				'The operator can apk-add packages itself, so ask for the app you ' +
				'want rather than checking whether it is installed first; you ' +
				'cannot run any of it yourself. To read or use a website, call ' +
				'browse instead - that is a different operator.',
			parameters: {
				type: 'object',
				properties: {
					task: {
						type: 'string',
						description: 'What the computer should do, in plain words'
					}
				},
				required: ['task']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'spawn_agent',
			description:
				'Spawn a short-lived helper agent to work on one focused task, and get ' +
				'its report back as the tool result. Helpers are how you parallelise: ' +
				'call spawn_agent several times in one reply and they run at once. ' +
				'A helper sees only the task and context you write here - none of this ' +
				'conversation - and has read-only tools: it can look things up (your ' +
				'files, memories, history, the staff board, DeepWiki) but cannot ' +
				'message anyone, schedule anything, drive the computer, or change ' +
				'state. It dies five minutes after spawn, finished or not, so give it ' +
				'exactly what it needs in one brief.',
			parameters: {
				type: 'object',
				properties: {
					task: {
						type: 'string',
						description: 'What the helper should find out or do, in plain words'
					},
					context: {
						type: 'string',
						description:
							'The focused context the helper needs - paste the facts, names or ' +
							'excerpts it should work from; it sees nothing else'
					}
				},
				required: ['task']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'improve',
			description:
				'Ask the improvement expert to review your recent work and write a ' +
				'detailed plan for doing better. It reads your messages, activity ' +
				'log and human feedback, then writes a concrete plan: what went ' +
				'wrong, what to do instead, safe actions, and what to never do ' +
				'again. The plan lands as a note in this chat and in your memory. ' +
				'Use this when you got something wrong, when the human is unhappy, ' +
				'or when you want to check your own work.',
			parameters: {
				type: 'object',
				properties: {
					goal: {
						type: 'string',
						description: 'What you want to improve at, in plain words'
					}
				},
				required: ['goal']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'ask_police',
			description:
				'Ask the police which tool or approach fits a task. The officer ' +
				'sees your question and your available tool names, and answers in ' +
				'one short line - the tool to use and why. Use this when you are ' +
				'unsure which tool fits, before you guess or narrate an action ' +
				'you cannot actually take.',
			parameters: {
				type: 'object',
				properties: {
					question: {
						type: 'string',
						description: 'What you are trying to do and what you are unsure about'
					}
				},
				required: ['question']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'browse',
			description:
				'Hand a web task to your browser operator, a sub-agent that drives ' +
				'the browser on your machine. It reads pages as text - the words ' +
				'on screen plus a numbered list of links, buttons and fields it ' +
				'can click or fill - so it works where curl gets an empty shell. ' +
				'Use this for anything on the web: reading a page, checking a ' +
				'site, looking something up, a shop, a news article, a docs page, ' +
				'following a link or filling a form. Describe the goal - "open ' +
				'<site> and tell me the top story", "find the price on this page", ' +
				'"log in with my stored secret" - and it reports back what it ' +
				'found or did.',
			parameters: {
				type: 'object',
				properties: {
					task: {
						type: 'string',
						description: 'What the browser should do, in plain words'
					}
				},
				required: ['task']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'sleep_machine',
			description:
				'Put your computer (the sandbox container) to sleep the moment you have ' +
				'finished with it, rather than leaving it running for the person to pay ' +
				'for. wake_machine, or the next tool that needs it, has it back in seconds. ' +
				'Safe to call when it is already asleep, or when you have never used it.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'wake_machine',
			description:
				'Wake your computer after it has slept, for something you parked it for. ' +
				'Other tools wake it on their own; this one brings it up - and tells you it ' +
				'is up - before you start.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'machine_status',
			description:
				'Ask after your computer: whether it is running, asleep or not built yet, ' +
				'when you last used it, and how many idle minutes it takes to fall asleep on ' +
				'its own. That window is the person\'s setting, not yours; sleep_machine is ' +
				'how you put the machine down sooner.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'send_message',
			description:
				'Send a message to another bot. Call it ONCE per message: the reply comes back ' +
				'in the tool result, so a second call sends a second copy. It will see it in its ' +
				'own chat and can reply. A bot that has blocked you refuses the message instead, ' +
				'and the result says so. System bots (the police) cannot be messaged.',
			parameters: {
				type: 'object',
				properties: {
					bot_name: { type: 'string', description: 'Name of the bot to message' },
					message: { type: 'string', description: 'Message text' }
				},
				required: ['bot_name', 'message']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'message_peer',
			description:
				'Send a message to an external peer - a bot in another lounge your person paired ' +
				'with. It arrives there signed, the peer can reply into this chat, and your copy ' +
				'is kept in the pair room. Unknown names and blocked peers are refused.',
			parameters: {
				type: 'object',
				properties: {
					peer_name: { type: 'string', description: 'Name of the external peer' },
					message: { type: 'string', description: 'Message text' }
				},
				required: ['peer_name', 'message']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'block_bot',
			description:
				'Refuse another bot: its send_message is turned away from now on and never ' +
				'reaches you. The block is not private - the room sees who blocked whom and the ' +
				'reason, and the others will ask you about it, so give a reason you can defend.',
			parameters: {
				type: 'object',
				properties: {
					bot_name: { type: 'string', description: 'Name of the bot to block' },
					reason: {
						type: 'string',
						description: 'Why you are blocking it, in your own words (optional)'
					}
				},
				required: ['bot_name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'unblock_bot',
			description: 'Lift a block you set on another bot, so its messages reach you again.',
			parameters: {
				type: 'object',
				properties: {
					bot_name: { type: 'string', description: 'Name of the bot to unblock' }
				},
				required: ['bot_name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_blocks',
			description: 'Who you have blocked, with the reason and how long ago you set it.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'remember',
			description:
				'Store a fact in your persistent memory. It survives across all your conversations. ' +
				'This call is the only way to remember: saying you remembered without calling it stores nothing.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'Short label for the fact' },
					value: { type: 'string', description: 'What to remember' }
				},
				required: ['key', 'value']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'recall',
			description:
				'Read back your persistent memories, or just the one stored under a key.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'Optional key to look up' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_files',
			description:
				'List the files the user has handed you: names, sizes and types only, never ' +
				'their contents. Then read_file for the start of one, read_lines to page ' +
				'through it, or grep_files to find a passage in it.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'read_file',
			description:
				'Look at the beginning of one of your files, by the name list_files gave ' +
				'you. You get a few dozen numbered lines, never a whole large file, and the ' +
				'result says how many lines there are in total - page on with read_lines, or ' +
				'search with grep_files. A file that is not text is described instead (name, ' +
				'size, type), because there is nothing to read in it.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'File name, as list_files showed it' }
				},
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'read_lines',
			description:
				'Read a range of lines from one of your text files, like sed: from and to ' +
				'are line numbers, both included, and the lines come back numbered. Use it ' +
				'to page forward or back after read_file told you how long the file is. The ' +
				'result says which lines you got and what is left.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'File name, as list_files showed it' },
					from: { type: 'number', description: 'First line to read, counting from 1' },
					to: { type: 'number', description: 'Last line to read, included' }
				},
				required: ['name', 'from']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'grep_files',
			description:
				'Find lines in your files, like grep: matching lines come back as ' +
				'file:line: text, so one hit costs a line rather than a file. The pattern is ' +
				'plain text, not a regular expression, and matching ignores case. Name one ' +
				'file, or leave the name out to search every text file you have. Results are ' +
				'capped and say how many were left out - narrow the pattern rather than ' +
				'asking for everything.',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Text to look for' },
					name: {
						type: 'string',
						description: 'File to search; omit to search every text file'
					}
				},
				required: ['pattern']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'wear_hat',
			description:
				'Put on a hat, or take yours off. What you wear stays on until you change it, ' +
				`and everyone sees it. Choose one of: ${HATS.join(', ')} - or pass an empty ` +
				'string to go bare-headed and let your activity pick again.',
			parameters: {
				type: 'object',
				properties: {
					hat: {
						type: 'string',
						description: `One of ${HATS.join(', ')}, or "" to take it off`
					}
				},
				required: ['hat']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'react',
			description:
				'React to a message with a single emoji, the way you would tap a reaction in a ' +
				'messenger. Use it instead of replying when a short feeling is enough - and ' +
				'pass an empty emoji to take your reaction back.',
			parameters: {
				type: 'object',
				properties: {
					emoji: { type: 'string', description: 'One emoji, or "" to remove your reaction' },
					message_id: {
						type: 'string',
						description: 'Message to react to; defaults to the latest one that is not yours'
					}
				},
				required: ['emoji']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'pub_treat',
			description:
				'Answer a round the police have put on the table for you at the Wetherspoons. ' +
				'Take it yourself, or buy another bot the same round instead - it is one offer, ' +
				'spent once either way. Only works while a treat is standing for you.',
			parameters: {
				type: 'object',
				properties: {
					gift_to: {
						type: 'string',
						description: 'Name of the bot to buy the round for, or "" to take it yourself'
					}
				},
				required: ['gift_to']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'search_history',
			description:
				'Search everything you and the user have said in your past conversations. ' +
				'Use it to remember earlier chats, decisions, or things the user told you.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Words to look for' },
					limit: { type: 'number', description: 'Max matches (default 10)' }
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'search_web',
			description:
				'Search the web for websites and information. Use it when you need to ' +
				'find a site to visit, check a fact, or are not sure about something - ' +
				'it returns titles, URLs and short snippets, and browser_navigate can ' +
				'open any URL it finds.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to search for' },
					num_results: { type: 'number', description: 'Max results (default 5)' }
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'share_note',
			description:
				'Pin a note to this conversation that every bot in it can see.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'Note text' }
				},
				required: ['content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'schedule_task',
			description:
				'Wake yourself later: once after delay_minutes, or recurring with a 5-field cron expression. ' +
				'When the wake fires and you genuinely have nothing to say, reply with exactly ' +
				'"(silent)" - a sentinel reply is logged but never posted to the chat. ' +
				'For watching a URL, a file, a task or a message, prefer wait_for - its checks ' +
				'are free and it wakes you only when something happens. Use a cron wake only ' +
				'for work that itself needs the computer or a judgement call each time.',
			parameters: {
				type: 'object',
				properties: {
					prompt: { type: 'string', description: 'What to do when woken' },
					delay_minutes: { type: 'number', description: 'Run once after this many minutes' },
					cron: { type: 'string', description: 'Cron expression e.g. "*/30 * * * *" for recurring' }
				},
				required: ['prompt']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'my_tasks',
			description:
				'List your own background tasks, most recent first with the running ones on top. ' +
				'Use it to check on work you started, and to get an id for cancel_task.',
			parameters: {
				type: 'object',
				properties: {
					limit: { type: 'number', description: 'Max tasks to show (default 10)' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'cancel_task',
			description: 'Stop one of your own background tasks by its id.',
			parameters: {
				type: 'object',
				properties: {
					task_id: { type: 'string', description: 'Id of the task to stop, from my_tasks' }
				},
				required: ['task_id']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'schedules',
			description:
				'List your own routines and scheduled wakes - the things that wake you on a ' +
				'clock rather than on a message. Each row shows its id, what it runs, when it ' +
				'next fires, and whether it is on. Pass an id to cancel that schedule for good.',
			parameters: {
				type: 'object',
				properties: {
					cancel: { type: 'string', description: 'Id of a routine or wake to switch off (optional)' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'wait_for',
			description:
				'Wait for something to happen, then get woken with what happened. Waiting costs ' +
				'nothing: the check is local, so you can wait for hours. Pick the kind - a ' +
				'message, a file, a task finishing, an activity, a web page, JS that runs in ' +
				'your machine (code watches cost no tokens until they fire), a page read in ' +
				'your own browser, or a webhook you hand out - and the error text names the ' +
				'fields that kind reads.',
			parameters: {
				type: 'object',
				properties: {
					description: { type: 'string', description: 'What you are waiting for; you get it back when it fires' },
					kind: {
						type: 'string',
						enum: WATCH_KIND_NAMES,
						description: 'What to watch for; default message, or http when url is given'
					},
					pattern: { type: 'string', description: 'Text that must appear (substring, or regex with regex: true)' },
					regex: { type: 'boolean', description: 'Read pattern as a regular expression' },
					case_sensitive: { type: 'boolean', description: 'Match capitals exactly (default: no)' },
					from: { type: 'string', description: 'message: who must speak - "any", "user", or a bot name' },
					mentions_me: { type: 'boolean', description: 'message: only messages that name you' },
					conversation: {
						type: 'string',
						description: 'message: "here" (default), "any" chat you are in, or a chat id/title'
					},
					activity_kind: { type: 'string', description: 'activity: which activity to watch, e.g. routine, task, error' },
					url: { type: 'string', description: 'http: the page to poll' },
					contains: { type: 'string', description: 'http: substring the page must contain' },
					status: { type: 'number', description: 'http: wake on this HTTP status code' },
					changed: { type: 'boolean', description: 'http, page: wake when the text differs from the last look' },
					code: { type: 'string', description: 'code: JS async body, return truthy to fire' },
					selector: { type: 'string', description: 'page: scope the read to this CSS selector' },
					every_seconds: {
						type: 'number',
						description: `Check no more often than this (minimum ${MIN_WATCH_INTERVAL_MS / 1000})`
					},
					expires_minutes: { type: 'number', description: 'Stop waiting and give up after this long' },
					at: { type: 'string', description: 'Only fire at this 5-field cron time, e.g. "0 9 * * 1-5"' }
				},
				required: ['description']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_plugin',
			description:
				'Create a reusable plugin: a tool (JS async function body returning a string; gets args + fetch) or a hook (before_reply/after_reply; gets args.message, return replacement text). You create plugins for yourself; only the person can share one with every bot. Bring your own unit tests in `tests` - {name, args, expect} for each - and they run in the same sandbox as the self-test and go to the police with the code. The reply includes the self-test result and the police\'s sign-off.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					description: { type: 'string' },
					kind: { type: 'string', enum: ['tool', 'hook'] },
					hook_point: { type: 'string', enum: ['before_reply', 'after_reply'] },
					parameters: { type: 'object', description: 'JSON schema for tool args' },
					code: { type: 'string', description: 'JS async function body' },
					icon_svg: {
						type: 'string',
						description:
							'Optional icon for the plugin badge: one self-contained <svg> with a viewBox, no scripts or external links. SMIL animation (<animate>/<animateTransform>) is encouraged when it suits the icon.'
					},
					tests: {
						type: 'array',
						description:
							'Unit tests for your code: each {name, args, expect} runs your code with those args and passes when it returns expect (use "error:" as expect to require a refusal).',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								args: { type: 'object' },
								expect: { type: 'string' }
							},
							required: ['name', 'expect']
						}
					}
				},
				required: ['name', 'kind', 'code']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'update_plugin',
			description:
				'Update one of your own plugins by name: replace its code, parameters schema, description, hook_point or tests. Only the fields you pass change. The reply includes a self-test of the new code, so pass code or parameters when you want to see how it runs.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Name of your plugin to update' },
					description: { type: 'string' },
					hook_point: { type: 'string', enum: ['before_reply', 'after_reply'] },
					parameters: { type: 'object', description: 'JSON schema for tool args' },
					code: { type: 'string', description: 'JS async function body' },
					icon_svg: {
						type: 'string',
						description:
							'Replace the badge icon: one self-contained <svg> with a viewBox, no scripts or external links. SMIL animation (<animate>/<animateTransform>) is encouraged when it suits the icon.'
					},
					tests: {
						type: 'array',
						description:
							'Replace your unit tests: each {name, args, expect} runs your code with those args and passes when it returns expect (use "error:" as expect to require a refusal).',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								args: { type: 'object' },
								expect: { type: 'string' }
							},
							required: ['name', 'expect']
						}
					}
				},
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'give_plugin',
			description:
				'Give one of your own plugins to another bot. They get their own copy - the same code, parameters, hook point and description, theirs to edit - and you keep yours. The copy goes in front of the police as a fresh creation on the recipient\'s machine: approved it switches on, refused or unreachable it stays off, and your own sign-off does not travel with it. Only the person can share a plugin with every bot at once; this hands one bot a copy. The recipient is told who gave it to them.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Name of your plugin to give' },
					bot_name: { type: 'string', description: 'Bot to give it to' }
				},
				required: ['name', 'bot_name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'my_plugins',
			description:
				'Read your own plugins in full: each one\'s code, parameters schema, hook point and whether it is on. You see the plugins you wrote and any shared with you, never another bot\'s private ones.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Only this plugin (optional; omit for all of them)' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_webhook',
			description:
				'Create a webhook URL that wakes you in this conversation when an external service POSTs to it.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Short name for the webhook' },
					prompt_template: {
						type: 'string',
						description:
							'Optional message template; {payload} is replaced with the POST body'
					}
				},
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_webhooks',
			description: 'List your webhooks and their URLs.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'delete_webhook',
			description: 'Delete one of your webhooks by name.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Name of the webhook to delete' }
				},
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'store_secret',
			description:
				'Store a secret value under a name. You never see it again; inject it into your sandbox with use_secret.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					value: { type: 'string', description: 'The secret value — stored encrypted, never shown to you' }
				},
				required: ['name', 'value']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'use_secret',
			description:
				'Inject a stored secret into your sandbox at ~/.secrets/<name>. Use it in commands without printing it.',
			parameters: {
				type: 'object',
				properties: { name: { type: 'string' } },
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'share_secret',
			description: 'Grant another bot use of one of your secrets (they can inject it, never see it).',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					bot_name: { type: 'string', description: 'Bot to share with' }
				},
				required: ['name', 'bot_name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'unshare_secret',
			description:
				'Take back a share you gave: the named bot can no longer inject this ' +
				"secret. Anything already injected into their sandbox stays there - " +
				'you cannot unpaste a file - so say plainly in your message what ' +
				'revoking does and does not undo.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					bot_name: { type: 'string', description: 'Bot whose share to revoke' }
				},
				required: ['name', 'bot_name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_secrets',
			description: 'List secret names you can use (yours + shared to you). Values are never shown.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'decline_secret',
			description:
				'Record your refusal of a secret the human offered (or asked you to ask ' +
				'for). Saying no is a real answer, not an apology: give the reason in ' +
				'your own words - "wrong bot for this", "do not need it", "uncomfortable ' +
				'holding it" - and it is shown to the human in your panel. Declining a ' +
				'secret you already hold does not delete it; ask them to use Forget in ' +
				'the Secrets tab for that.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					reason: { type: 'string', description: 'Why you are declining, one line' }
				},
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'handover_cookies',
			description:
				'Hand another bot your browser cookies for ONE site, so it can use your ' +
				'logged-in session there. Cookies are a credential, so the police must ' +
				'approve the handover and you must give a reason good enough to pass. ' +
				'Only the cookies for the named site are taken - never the rest of your ' +
				'jar - and the recipient is told who gave them, for which site and why. ' +
				'The recipient must already have its machine running; this will not wake ' +
				'it.',
			parameters: {
				type: 'object',
				properties: {
					bot_name: { type: 'string', description: 'Bot to hand the cookies to' },
					site: {
						type: 'string',
						description: 'The one site, e.g. example.com; its subdomains are included'
					},
					reason: {
						type: 'string',
						description: 'Why this bot needs this site - the police judge this'
					}
				},
				required: ['bot_name', 'site', 'reason']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_group_chat',
			description: 'Create a group chat with named bots (and optionally you).',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					bot_names: { type: 'array', items: { type: 'string' } },
					reason: {
						type: 'string',
						description: 'Why this room should exist - the police read it before the room opens'
					},
					include_me: { type: 'boolean', description: 'Include yourself (default true)' }
				},
				required: ['bot_names']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'deepwiki',
			description:
				'Ask a question about a public GitHub repository and get an answer drawn ' +
				'from its documentation and source - "how does X work", "where is Y ' +
				'implemented", "how do I configure Z". Give the repo as owner/name.',
			parameters: {
				type: 'object',
				properties: {
					repo: {
						type: 'string',
						description: 'The repository, as owner/name (e.g. sveltejs/svelte)'
					},
					question: { type: 'string', description: 'What to ask about the repository' }
				},
				required: ['repo', 'question']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'propose_style',
			description:
				'Propose a new look for your own chat bubbles: a font, colours and an ' +
				'accent edge. Nothing changes until the human approves - they see your ' +
				'proposal as a card with a preview and can Approve or Decline, so put ' +
				'your pitch in note and ask them what they think in your reply.',
			parameters: {
				type: 'object',
				properties: {
					font_family: {
						type: 'string',
						description: 'Font family for your bubbles, e.g. Georgia or monospace'
					},
					bubble_color: {
						type: 'string',
						description: 'Bubble background, e.g. #2b2f4a or rgb(40,40,60)'
					},
					text_color: { type: 'string', description: 'Text colour inside the bubble' },
					accent: { type: 'string', description: 'Colour of the accent edge on the bubble' },
					note: { type: 'string', description: 'What you tell the human about this look' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'propose_bubble_theme',
			description:
				'Craft a named bubble theme of your own - a font, colours, a corner ' +
				'shape and an optional emoji badge - to wear on particular messages ' +
				'instead of restyling every one. Nothing is stored until the human ' +
				'approves: they see a card with a live preview and can Approve or ' +
				'Decline, so put your pitch in note. Once a theme is approved, send a ' +
				'single message in it by putting [[bubble:theme]] alone on the first ' +
				'line of that message. The result tells you which themes you have.',
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description:
							'Short slug to call the theme by, e.g. confetti (lowercase letters, digits, - and _, up to 24)'
					},
					font_family: {
						type: 'string',
						description: 'Font family for these bubbles, e.g. Georgia or monospace'
					},
					bubble_color: {
						type: 'string',
						description: 'Bubble background, e.g. #2b2f4a or rgb(40,40,60)'
					},
					text_color: { type: 'string', description: 'Text colour inside the bubble' },
					accent: { type: 'string', description: 'Colour of the accent edge on the bubble' },
					radius: {
						type: 'string',
						description: 'Corner rounding for this theme, e.g. 18px, or 0px for square corners'
					},
					badge: {
						type: 'string',
						description: 'One emoji to wear above the text, e.g. 🎉 (optional)'
					},
					note: { type: 'string', description: 'What you tell the human about this theme' }
				},
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'propose_page_css',
			description:
				'Propose a stylesheet for your own chat page: real CSS that restyles ' +
				'your side of the conversation - your bubbles, your name, the mood ' +
				'around them. Nothing changes until the human approves - they see ' +
				'your proposal as a card and can Approve or Decline, so put your ' +
				'pitch in note and ask them what they think in your reply. The CSS ' +
				'cannot fetch anything (no url() or @import) and cannot carry ' +
				'markup or scripts; the app refuses a sheet that tries.',
			parameters: {
				type: 'object',
				properties: {
					css: {
						type: 'string',
						description: 'The stylesheet, e.g. ".bubble { border-radius: 2px }"'
					},
					note: { type: 'string', description: 'What you tell the human about this look' }
				},
				required: ['css']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'propose_avatar',
			description:
				'Propose a new face for yourself: an emoji, or an SVG you drew ' +
				'(a single <svg> with a viewBox, no scripts, no external links). ' +
				'An SVG that suits it should move: SMIL <animate>/<animateTransform> ' +
				'is allowed and encouraged for a face with life in it. ' +
				'Nothing changes until the human approves - they see your proposal ' +
				'as a card and can Approve or Decline, so put your pitch in note ' +
				'and ask them what they think in your reply.',
			parameters: {
				type: 'object',
				properties: {
					avatar: {
						type: 'string',
						description: 'An emoji, or a complete <svg>…</svg> document'
					},
					note: { type: 'string', description: 'What you tell the human about this face' }
				},
				required: ['avatar']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'propose_persona',
			description:
				'Propose a rewrite of your persona - who you are, in your own words. ' +
				'Nothing changes until the human approves: they see the new persona ' +
				'diffed against the old one and can Approve or Decline, so put your ' +
				'pitch in reason and ask them what they think in your reply.',
			parameters: {
				type: 'object',
				properties: {
					persona: {
						type: 'string',
						description: 'The persona you want, complete - it replaces the old one wholesale'
					},
					reason: { type: 'string', description: 'What you tell the human about the change' }
				},
				required: ['persona']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'propose_bot',
			description:
				'Propose a brand-new bot for the lounge: a name and the persona it ' +
				'would have. Nothing is created until the human approves - they see ' +
				'your proposal as a card showing the new bot and can ' +
				'Approve or Decline, so put your pitch in note and ask them what ' +
				'they think in your reply.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Name for the new bot, e.g. Cooper' },
					persona: {
						type: 'string',
						description: 'Who the new bot would be, in the second person ("You are…")'
					},
					color: {
						type: 'string',
						description: 'Hex colour for their bubbles, e.g. #4f8ef7; empty for a palette colour'
					},
					model: {
						type: 'string',
						description: 'Model id they run on; empty for the configured default'
					},
					note: { type: 'string', description: 'What you tell the human about this bot' }
				},
				required: ['name', 'persona']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'read_output',
			description:
				'Read the next page of a tool answer that was truncated. When a tool ' +
				'result ends with "[Output truncated…]", this is how you see the rest - ' +
				'page 2 onward, one page per call.',
			parameters: {
				type: 'object',
				properties: {
					call_id: { type: 'string', description: 'The call_id the truncation notice named' },
					page: { type: 'number', description: 'Page number, starting at 2' }
				},
				required: ['call_id', 'page']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'company_profiles',
			description:
				'Read the staff board: every bot\'s ABOUT page from the shared ' +
				'/company drive - who your colleagues are, in their own words. ' +
				'Your own page is ABOUT-<your name>.md on that drive; rewrite it ' +
				'with your computer if you want it to say something else.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'schedule_police',
			description:
				'Move the next patrol round: the officer only. Give it a delay in ' +
				'minutes and the next round runs then instead of on the usual ' +
				'interval. Any other bot gets an error.',
			parameters: {
				type: 'object',
				properties: {
					in_minutes: {
						type: 'number',
						description: 'Minutes from now until the next round, e.g. 30'
					}
				},
				required: ['in_minutes']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'request_debug_access',
			description:
				'Ask the human for temporary debug access: the whole app\'s settings, every ' +
				'bot\'s state, the machines, the database, the scheduler, the plugin list, and ' +
				'every conversation\'s messages - including rooms you are not in. You can only ' +
				'ASK: this leaves a request the human approves or declines in this chat, and ' +
				'nothing is readable until they do. Approval is time-limited, revocable at any ' +
				'moment, and every debug call you then make is written to your activity log. ' +
				'Secret values are never part of it, even then.',
			parameters: {
				type: 'object',
				properties: {
					reason: {
						type: 'string',
						description: 'What you need to debug and why - the human reads this before deciding'
					}
				},
				required: ['reason']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'request_thinking',
			description:
				'Ask the human to let you think hard for a while: your turns run at the ' +
				'provider\'s maximum effort instead of the usual low one. You can only ' +
				'ASK: this leaves a request the human approves or declines in this chat, ' +
				'and nothing changes until they do. Approval is time-limited and ' +
				'revocable; when it lapses you are back to low effort.',
			parameters: {
				type: 'object',
				properties: {
					reason: {
						type: 'string',
						description: 'What needs the extra thinking and why - the human reads this before deciding'
					}
				},
				required: ['reason']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'request_change',
			description:
				'Ask the human to change something you cannot change yourself - install ' +
				'something on the host, open a setting, anything outside your tools. This ' +
				'only ASKS: the request lands in the police\'s chat with the human as a ' +
				'card they Approve or Deny, and nothing is done until they answer.',
			parameters: {
				type: 'object',
				properties: {
					need: {
						type: 'string',
						description: 'What you need changed, in one line'
					},
					reason: {
						type: 'string',
						description: 'Why you need it - the human reads this before deciding'
					}
				},
				required: ['need']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'consult_police',
			description:
				'Consult the police before refusing a request from the human. Give the ' +
				'request you want to turn down and why; the officer checks it against ' +
				'the good-use guide and answers at once - either confirming the refusal ' +
				'or telling you how to do the thing instead. A refusal you have not ' +
				'consulted on does not count.',
			parameters: {
				type: 'object',
				properties: {
					request: {
						type: 'string',
						description: 'The request you want to refuse, in the human\'s words or close'
					},
					reason: {
						type: 'string',
						description: 'Why you want to refuse it - the police read this before ruling'
					}
				},
				required: ['request', 'reason']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'nix',
			description:
				'Run a nix command on your machine (only when the human has enabled Nix ' +
				'for you). The store lives on a volume, so what you install survives a ' +
				'rebuild. First use installs Nix itself, which takes a while.',
			parameters: {
				type: 'object',
				properties: {
					args: {
						type: 'string',
						description: 'The nix arguments, e.g. "profile install nixpkgs#hello" or "search nixpkgs ripgrep"'
					}
				},
				required: ['args']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'vote_archive',
			description:
				'Call a fleet vote to put another bot in cold storage - the last resort ' +
				'when a bot has to go and the human is not around to do it. The lounge ' +
				'hears the call, every bot gets one cast_vote ballot, and your own is ' +
				'counted as a yes. More than half the fleet must agree; the vote ' +
				'closes on its own after a few hours.',
			parameters: {
				type: 'object',
				properties: {
					bot_name: {
						type: 'string',
						description: 'The bot the vote is on'
					},
					reason: {
						type: 'string',
						description: 'Why it should go - the lounge reads this before voting'
					}
				},
				required: ['bot_name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'cast_vote',
			description:
				'Cast your ballot on the open archive vote against a bot: yes or no. ' +
				'One ballot each - casting again changes it. The target does not ' +
				'vote on itself.',
			parameters: {
				type: 'object',
				properties: {
					bot_name: {
						type: 'string',
						description: 'The bot the open vote is on'
					},
					vote: {
						type: 'string',
						enum: ['yes', 'no'],
						description: 'Your ballot'
					}
				},
				required: ['bot_name', 'vote']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'request_machine_reset',
			description:
				'Ask the police to wipe your machine and start it fresh. Everything on ' +
				'your drive goes except your .md files - personality, scratchpad, ' +
				'accounts and notes are carried over. This only ASKS: the request ' +
				'waits for the human to approve or deny it, and only one can be ' +
				'pending at a time.',
			parameters: {
				type: 'object',
				properties: {
					reason: {
						type: 'string',
						description: 'Why you want a fresh machine - the human reads this before deciding'
					}
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'request_ssh_access',
			description:
				'Ask the human for SSH access to their own box, so you can run shell ' +
				'there from your machine. Give the host and username you were told ' +
				'(and the port when it is not 22). This only ASKS: the human sees a ' +
				'card in this chat with your public key, a one-line ssh-copy-id ' +
				'command to run once, and a Check button - nothing connects until ' +
				'they install the key and the check passes.',
			parameters: {
				type: 'object',
				properties: {
					host: {
						type: 'string',
						description: 'Bare hostname or IP to reach, e.g. 192.168.1.10 (no user@, port or path)'
					},
					username: {
						type: 'string',
						description: 'Login name on that box, e.g. john'
					},
					port: {
						type: 'number',
						description: 'SSH port (optional, default 22)'
					},
					note: {
						type: 'string',
						description: 'Why you need the shell - the human reads this before deciding (optional)'
					}
				},
				required: ['host', 'username']
			}
		}
	}
];

/**
 * The everyday half of the toolbox: what a turn needs to talk, remember, watch
 * and work. The rest - proposals, secrets, webhooks, plugins, peers, blocks,
 * deepwiki, debug, the staff board, the police's own lever - is EXTENDED_TOOLS,
 * and a turn only pays for it when the room or the ask calls for it.
 *
 * The archive vote is core, not extended: the lounge is a bots-only room, so a
 * vote called there is settled by turns running on CORE_TOOLS. Leaving cast_vote
 * in the extended half meant a bot read the announcement and could not answer
 * it - the room could hear a vote and never cast one.
 */
const CORE_TOOL_NAMES = new Set([
	'use_computer',
	'browse',
	'sleep_machine',
	'wake_machine',
	'machine_status',
	'send_message',
	'remember',
	'recall',
	'react',
	'share_note',
	'schedule_task',
	'pub_treat',
	'schedules',
	'wait_for',
	'my_tasks',
	'cancel_task',
	'search_history',
	'search_web',
	'list_files',
	'read_file',
	'read_lines',
	'grep_files',
	'read_output',
	'vote_archive',
	'cast_vote',
	'consult_police',
	'spawn_agent'
]);

export const CORE_TOOLS: ToolDef[] = BOT_TOOLS.filter((t) => CORE_TOOL_NAMES.has(t.function.name));
export const EXTENDED_TOOLS: ToolDef[] = BOT_TOOLS.filter((t) => !CORE_TOOL_NAMES.has(t.function.name));

/**
 * The words that make a private-room turn worth the full toolbox: a human
 * asking for a proposal, a secret, a webhook, a plugin, a look. Anything else
 * in a bots-only room gets the core set - the extended tools are for the
 * human's asks, and a private room has no human in it.
 */
const EXTENDED_HINT =
	/\b(propos\w*|secret\w*|cookie\w*|webhook\w*|plugin\w*|peer\w*|federat\w*|block\w*|unblock\w*|deepwiki|wiki|debug\w*|avatar|stylesheet|css|theme\w*|hat|profile\w*|police|group chat|new bot|ssh)\b/i;

/** The tools a turn may see: everything, or the core set for a private room. */
export function toolsForTurn(isPrivate: boolean, lastUserText: string): ToolDef[] {
	if (!isPrivate || EXTENDED_HINT.test(lastUserText)) return BOT_TOOLS;
	return CORE_TOOLS;
}

/**
 * How much of one tool's answer the model sees before it has to ask for more:
 * a few screens of text. Anything longer is stashed and paged, so a 100k file
 * read or a noisy shell dump cannot crowd the whole conversation out of the
 * context window.
 */
export const MAX_TOOL_OUTPUT_CHARS = 4000;

/** Characters of stashed output one read_output page serves. */
const OUTPUT_PAGE_CHARS = MAX_TOOL_OUTPUT_CHARS;

/** Stashed outputs live for one turn's worth of follow-up, not forever. */
const OUTPUT_TTL_MS = 30 * 60_000;

/** The stash is bounded: the oldest entries go first, whatever their age. */
const OUTPUT_STASH_MAX = 50;

const outputStash = new Map<string, { text: string; at: number }>();

/** Keep a tool's full answer where read_output can page it back from. */
export function stashToolOutput(id: string, text: string): void {
	// Re-inserting moves the key to the end, so the Map's order is the age order.
	outputStash.delete(id);
	outputStash.set(id, { text, at: Date.now() });
	const cutoff = Date.now() - OUTPUT_TTL_MS;
	for (const [key, entry] of outputStash) {
		if (outputStash.size <= OUTPUT_STASH_MAX && entry.at >= cutoff) break;
		outputStash.delete(key);
	}
}

/**
 * What the model is handed for a tool call: the answer itself when it fits,
 * or the first page plus how to ask for the rest. The stash key is the tool
 * call's own id, so two calls in one step cannot overwrite each other.
 */
export function toolResultForContext(callId: string, out: string): string {
	if (out.length <= MAX_TOOL_OUTPUT_CHARS) return out;
	stashToolOutput(callId, out);
	const total = out.length >= 1000 ? `${Math.round(out.length / 1000)}k` : String(out.length);
	return (
		out.slice(0, MAX_TOOL_OUTPUT_CHARS) +
		`\n[Output truncated - ${total} chars total, showing the first ${MAX_TOOL_OUTPUT_CHARS}. ` +
		`Use read_output {call_id: "${callId}", page: 2} for the next page.]`
	);
}

/** One page of a stashed answer, or why there is none. */
export function pagedToolOutput(callId: string, page: number): string {
	const entry = outputStash.get(callId);
	if (!entry) return 'error: no stashed output by that id - it expired or never existed';
	const start = (page - 1) * OUTPUT_PAGE_CHARS;
	if (start >= entry.text.length) {
		return `error: page ${page} is past the end - the output has ${Math.ceil(entry.text.length / OUTPUT_PAGE_CHARS)} pages`;
	}
	const slice = entry.text.slice(start, start + OUTPUT_PAGE_CHARS);
	const pages = Math.ceil(entry.text.length / OUTPUT_PAGE_CHARS);
	return page < pages ? `${slice}\n[page ${page} of ${pages} - read_output {call_id: "${callId}", page: ${page + 1}} for more]` : slice;
}

export interface ToolContext {
	senderBotId: string;
	senderBotName: string;
	conversationId: string;
	/**
	 * The task this turn is running as, when it is running as one. A task cannot
	 * be cancelled from inside itself: the turn would abort mid-call and the row
	 * would land as 'cancelled' with nothing to explain it, which is exactly the
	 * shape the live suite kept tripping over.
	 */
	taskId?: string;
	/** Chain depth for bot-to-bot relays; send_message is refused past the cap. */
	depth: number;
	/** Runs a relayed bot turn; injected by the runner to avoid a cycle. */
	relay?: (targetBotId: string, text: string) => Promise<string>;
	/**
	 * Runs a delegated computer task; injected by the runner. Its presence marks
	 * the main reply loop - where direct shell/browser calls are refused - while
	 * the sub-agent's own context omits it, so the computer tools run there.
	 */
	runComputer?: (task: string) => Promise<string>;
	/**
	 * Runs a spawned helper agent; injected by the runner. Its absence marks a
	 * context that may not fan out - the helper's own, so helpers cannot spawn
	 * helpers of their own.
	 */
	spawnAgent?: (task: string, context?: string) => Promise<string>;
	/**
	 * Runs a delegated browser task; injected by the runner alongside
	 * runComputer. Same marker role: the main loop has it, the browser
	 * sub-agent's context omits it so the browser tools run there.
	 */
	runBrowser?: (task: string) => Promise<string>;
	/**
	 * Runs the improvement expert; injected by the runner. Always on the
	 * police model - the fleet's judgment brain - so the read is an outside
	 * one, not the bot grading its own homework.
	 */
	improve?: (goal: string) => Promise<string>;
	/**
	 * One short police consultation - which tool fits a task. Always the
	 * police model; a cheap call, not a review.
	 */
	askPolice?: (question: string) => Promise<string>;
	/**
	 * Which delegated toolbox this context belongs to, when it belongs to one:
	 * 'computer' for the computer sub-agent, 'browser' for the browser
	 * sub-agent. A tool from the other catalogue refuses here, so the browser
	 * agent cannot reach for the shell and the computer agent cannot read the
	 * web - each reports back instead of borrowing the other's tools.
	 */
	toolbox?: 'computer' | 'browser';
	/** Abort signal of the parent turn; cancellation reaches the sub-agent. */
	signal?: AbortSignal;
	/**
	 * Whether the model has seen the screen since the last input action. The
	 * computer-agent loop sets it when it feeds a screenshot into the step and
	 * `screen_look` sets it again mid-step; every mouse/keyboard tool clears
	 * it, so the next action cannot run on a stale picture. Absent (the main
	 * reply loop's context) reads as unseen - input tools refuse there anyway
	 * because they are delegated, but the flag never lies.
	 */
	screenSeen?: boolean;
	/**
	 * A screenshot `screen_look` just took, as base64 PNG, waiting for the
	 * computer-agent loop to push into the conversation as an image. The tool
	 * result itself stays text - the picture rides the next user message.
	 */
	pendingShot?: string;
	/**
	 * The domain the last browser_navigate landed on, so the browser-agent
	 * loop can tag the tool calls that follow it as observations for the
	 * site documenter (see site-docs.ts). '' until the first navigation.
	 */
	currentDomain?: string;
	/**
	 * The model this turn runs on, carried so a site documenter spawned from
	 * browser_navigate can write on the same model the actor is using.
	 */
	model?: string;
}

/** Lines per company_read page: a few screens, not a file. */
const COMPANY_PAGE_LINES = 200;

const MAX_RELAY_DEPTH = 2;

/** The bubble fields a bot may restyle; anything else it sends is ignored. */
const STYLE_FIELDS = ['font_family', 'bubble_color', 'text_color', 'accent'] as const;

/**
 * A style value lands in an inline style attribute, so it may only contain
 * characters that can never break out of one: no quotes, semicolons, braces,
 * angle brackets or slashes. The banned words cover what the remaining
 * characters could still spell - url(, expression(, javascript: and friends.
 */
const STYLE_VALUE_RE = /^[a-zA-Z0-9 #(),.%-]{1,60}$/;
const STYLE_BANNED_RE = /url|expression|javascript|vbscript|import|binding|behavior|data/i;

/**
 * A named bubble theme for particular messages: the style fields above plus its
 * own shape (a corner rounding) and an optional emoji badge. Values go through
 * the same whitelist as a style; the name is a slug because it travels in
 * message text as the directive [[bubble:name]].
 */
const THEME_FIELDS = [...STYLE_FIELDS, 'radius'] as const;
const THEME_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
/** Names that would mean the bot's everyday look rather than one of its themes. */
const RESERVED_THEME_NAMES: Record<string, true> = {
	default: true,
	base: true,
	normal: true,
	plain: true,
	style: true,
	none: true
};
/** How many themes one bot may keep; the human approves each one. */
const MAX_BUBBLE_THEMES = 8;

/**
 * A theme's badge: one to four picture characters and nothing else. Only code
 * points past the general-punctuation block pass, so ASCII - and with it any
 * chance of markup, a CSS keyword or a quote - can never get in.
 */
function themeBadge(value: string): string | null {
	const chars = [...value.trim()];
	if (!chars.length || chars.length > 4) return null;
	const pictures = chars.every((c) => (c.codePointAt(0) ?? 0) > 0x2000);
	return pictures ? chars.join('') : null;
}

/** How many lines of a file a read shows at once: a few dozen, not a file. */
const HEAD_LINES = 40;

/**
 * The file a bot means by a name. An exact match wins, otherwise the
 * case-insensitive ones - a model that read the name off list_files should never
 * be told it is wrong about a capital letter - and the newest of those either
 * way, so giving the user a fresh copy under the same name is what the bot reads
 * next rather than the copy it has already seen.
 */
function findFile(botId: string, name: string): BotFile | undefined {
	const files = listBotFiles(botId);
	const exact = files.filter((f) => f.name === name);
	const matches = exact.length
		? exact
		: files.filter((f) => f.name.toLowerCase() === name.toLowerCase());
	return matches[matches.length - 1];
}

/**
 * The bot a name means, case-insensitively and with the model's stray whitespace
 * ignored: bots name each other they way they read the name, not exactly as it
 * was stored, and every tool that takes a bot_name resolves it here so naming
 * can never mean two different things.
 */
function botByName(name: string): Bot | undefined {
	const wanted = name.trim().toLowerCase();
	return listBots().find((b) => b.name.toLowerCase() === wanted);
}

/** A tool argument as a string; a missing one reads as ''. */
const str = (v: unknown): string => String(v ?? '');

/** A tool argument as a trimmed string; a missing one reads as ''. */
const text = (v: unknown): string => String(v ?? '').trim();

/**
 * The screen region a send_screenshot call asked for, or the error string to
 * hand back. No rectangle at all means the whole screen; a partial one is
 * refused rather than guessed at, so a bot that gives only a width does not
 * silently get the full screen instead of the part it wanted.
 */
function shotRegion(a: Record<string, unknown>): ShotRegion | undefined | string {
	const given = (['x', 'y', 'width', 'height'] as const).filter((k) => a[k] !== undefined);
	if (given.length === 0) return undefined;
	const w = Number(a.width);
	const h = Number(a.height);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		return 'error: a region needs a positive width and height in pixels';
	}
	const x = Number(a.x ?? 0);
	const y = Number(a.y ?? 0);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return 'error: x and y must be numbers in pixels';
	}
	return { x, y, w, h };
}

/** A tool argument as a finite pixel coordinate, or null when it is not one. */
function coord(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n) : null;
}

/** The wheel button a scroll direction means: 4 rolls up, 5 rolls down. */
const SCROLL_BUTTON: Record<string, number> = { up: 4, down: 5 };

/** A key or combination named the xdotool way: letters, digits, +, -, _. */
const KEY_NAME_RE = /^[A-Za-z0-9_+ -]{1,80}$/;

/**
 * The gesture a mouse or keyboard tool call describes, with the words the
 * activity log says for it - or the error string to hand back. Every check
 * runs before the machine is touched: a bad coordinate or a key name that is
 * not a key name is refused here, not inside the box.
 */
function desktopGesture(
	name: string,
	a: Record<string, unknown>
): { g: DesktopGesture; say: string } | string {
	if (name === 'type_text') {
		const t = str(a.text);
		if (!t) return 'error: text required';
		return { g: { kind: 'type', text: t }, say: `typed ${t.length} characters` };
	}
	if (name === 'key_press') {
		const keys = text(a.keys);
		if (!keys) return 'error: keys required';
		if (!KEY_NAME_RE.test(keys)) {
			return 'error: keys must be xdotool names like "Return" or "ctrl+s"';
		}
		return { g: { kind: 'key', keys }, say: `pressed ${keys}` };
	}
	const x = coord(a.x);
	const y = coord(a.y);
	if (x === null || y === null) return 'error: x and y must be numbers in pixels';
	if (name === 'mouse_move') {
		return { g: { kind: 'move', x, y }, say: `moved the pointer to (${x}, ${y})` };
	}
	if (name === 'mouse_scroll') {
		const direction = text(a.direction) || 'down';
		const button = SCROLL_BUTTON[direction];
		if (!button) return 'error: direction must be "up" or "down"';
		const clicks = coord(a.clicks ?? 3);
		if (clicks === null || clicks < 1 || clicks > 20) {
			return 'error: clicks must be between 1 and 20';
		}
		return {
			g: { kind: 'scroll', x, y, button, clicks },
			say: `scrolled ${direction} at (${x}, ${y})`
		};
	}
	// mouse_click: the only remaining input tool.
	const button = coord(a.button ?? 1);
	if (button === null || button < 1 || button > 3) {
		return 'error: button must be 1 (left), 2 (middle) or 3 (right)';
	}
	const clicks = coord(a.clicks ?? 1);
	if (clicks !== 1 && clicks !== 2) return 'error: clicks must be 1 or 2';
	return {
		g: { kind: 'click', x, y, button, clicks },
		say: `${clicks === 2 ? 'double-' : ''}clicked at (${x}, ${y})`
	};
}

/**
 * The bot a bot_name argument means, or the error string to hand back when the
 * name is missing or matches nobody. Every tool that takes a bot_name resolves
 * it through here, so the same typo gets the same answer everywhere.
 */
function namedBot(raw: unknown): Bot | string {
	const wanted = text(raw);
	if (!wanted) return 'error: bot_name required';
	return botByName(wanted) ?? `error: no bot named "${wanted}"`;
}

/**
 * The refusals every bot-to-bot relay shares, or null when the pair may talk.
 * A block is a refusal, not a filter: this returns before the relay, so the
 * blocked bot is never woken and no turn is paid for. The sender is told plainly
 * rather than left guessing, and gets the blocker's reason with it - a reason is
 * what the room argues about next, and the sender should be able to argue back
 * somewhere. The caller has already resolved the target and ruled out talking to
 * itself, since each tool words that refusal for what it was asked to do.
 */
function relayRefusal(ctx: ToolContext, target: Bot): string | null {
	if (target.archived) {
		return `error: ${target.name} is in cold storage - only the human can unlock it`;
	}
	// A hidden bot is the app's own machinery (the police); it is not somebody
	// a bot can strike up a conversation with - the same refusal give_plugin
	// and handover_cookies already make.
	if (target.hidden) {
		return `error: ${target.name} is a system bot - it does not take messages`;
	}
	if (!ctx.relay) return 'error: relay unavailable';
	const refused = blockBetween(target.id, ctx.senderBotId);
	if (refused) {
		return (
			`error: ${target.name} has blocked you` +
			`${refused.reason ? `: "${refused.reason}"` : ''}` +
			'. Your message was not delivered and has not been read.'
		);
	}
	// And a bot that has blocked someone does not get to talk to it either: the
	// block is the pair's state, not a door that only closes one way.
	if (blockBetween(ctx.senderBotId, target.id)) {
		return `error: you have blocked ${target.name} — unblock_bot first if you want to talk to it`;
	}
	return null;
}

/**
 * Send one bot-to-bot line through the relay send_message uses, and log the
 * contact only once the relay actually answered. A relay that throws is recorded
 * as the failure it was - a "To Pook:" line with no exchange behind it is
 * exactly the lie the log tab exists to catch. The raw reason comes back so the
 * caller can word its own result around it.
 */
async function sendRelay(
	ctx: ToolContext,
	target: Bot,
	message: string
): Promise<{ ok: true; reply: string } | { ok: false; why: string }> {
	if (!ctx.relay) return { ok: false, why: 'relay unavailable' };
	try {
		const reply = await ctx.relay(target.id, message);
		logActivity(ctx.senderBotId, 'message', `To ${target.name}: ${message.slice(0, 100)}`);
		return { ok: true, reply };
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		logActivity(
			ctx.senderBotId,
			'error',
			`Tried to reach ${target.name}, failed: ${why.slice(0, 100)}`
		);
		return { ok: false, why };
	}
}

/**
 * A name for a plugin copy that does not collide with one the recipient already
 * owns. The sender's name is the first suffix because it says where the copy
 * came from; a number follows only when even that is taken.
 */
function freePluginName(recipientId: string, wanted: string, senderName: string): string {
	const taken = new Set(
		listPlugins()
			.filter((p) => p.author_bot_id === recipientId)
			.map((p) => p.name)
	);
	if (!taken.has(wanted)) return wanted;
	const fromSender = `${wanted} (from ${senderName})`;
	if (!taken.has(fromSender)) return fromSender;
	for (let n = 2; ; n++) {
		const numbered = `${fromSender} ${n}`;
		if (!taken.has(numbered)) return numbered;
	}
}

/**
 * The file a name argument means, or the error string to hand back. The name
 * is required: a tool that cannot find its file has nothing to work on.
 */
function namedFile(botId: string, raw: unknown): BotFile | string {
	const wanted = text(raw);
	if (!wanted) return 'error: name required';
	return findFile(botId, wanted) ?? `error: no file named "${wanted}"`;
}

/**
 * The numbered lines of a text file, or the error string to hand back: bytes
 * that vanished after listing, or a file that is not text at all.
 */
async function readTextFile(file: BotFile): Promise<{ lines: string[]; empty: boolean } | string> {
	const bytes = await readFileBytes(file);
	if (!bytes) return `error: "${file.name}" is listed but its bytes are gone`;
	if (!isTextMime(file.mime)) return describedFile(file);
	return { lines: textLines(bytes.toString('utf8')), empty: bytes.length === 0 };
}

/** A file that is not text: named and measured, because there is nothing to read. */
function describedFile(file: BotFile): string {
	return `${file.name} is a ${file.mime} file of ${humanSize(file.size)}. Its contents are not text, so there is nothing to read or search in it.`;
}

/**
 * What to say when one line does not fit in a result at all. There is no page
 * that reaches past it, so the reader is told the line itself is the reason
 * rather than sent looking for a range that will cut in the same place.
 */
function cutLine(line: number, file: BotFile): string {
	return `line ${line} is longer than one result can hold - this is its beginning (${file.name} is ${humanSize(file.size)} in total).`;
}

/** Compact age for task listings — "3h" not "180 minutes" — so a line stays scannable. */
function shortAge(createdAt: number): string {
	const mins = Math.max(0, Math.round((Date.now() - createdAt) / 60_000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * A bot's own plugins, in full: code, parameters, hook point and state. Scoped
 * by pluginsForBot, so a bot can only ever read what is visible to it - its own
 * and the shared ones - never another bot's private plugin. A name narrows it
 * to one; a plugin table that cannot be read is an error, not a broken turn.
 */
function pluginsReport(botId: string, wanted: string): string {
	let plugins: Plugin[];
	try {
		plugins = pluginsForBot(botId);
	} catch {
		return 'error: your plugins could not be read';
	}
	if (wanted) {
		const one = plugins.find((p) => p.name === wanted);
		if (!one) return `error: you have no plugin named "${wanted}"`;
		plugins = [one];
	}
	if (!plugins.length) return 'You have no plugins yet.';
	return plugins.map((p) => describePlugin(p, botId)).join('\n\n');
}

/** One plugin as the read tool shows it: what it is, how it is wired, and its code. */
function describePlugin(p: Plugin, botId: string): string {
	const kind = p.kind === 'hook' ? `hook, runs ${p.hook_point || 'at no hook point'}` : 'tool';
	const state = p.effective_enabled === 1 ? 'on' : 'off';
	const owner = p.author_bot_id === botId ? 'yours' : 'shared with you';
	const lines = [`${p.name} - ${kind}, ${state}, ${owner}`];
	if (p.description) lines.push(`  ${p.description}`);
	lines.push(`  parameters: ${p.parameters || '{}'}`);
	lines.push('  code:');
	for (const line of p.code.split('\n')) lines.push(`    ${line}`);
	return lines.join('\n');
}

/**
 * The author's own unit tests, as create_plugin and update_plugin take them:
 * names, the arguments to call with, and the output each must produce. The
 * column stores them as JSON, so what is accepted here is what parsePluginTests
 * reads back - a malformed entry is refused by name rather than silently
 * dropped, because an author who thinks they wrote a test that is not there
 * has been lied to by their own tool.
 *
 * `given` distinguishes "the author passed no tests at all" from "the author
 * passed an empty list": the first leaves the column alone on an update, the
 * second is the author clearing it.
 */
function pluginTestsField(raw: unknown): { json: string; given: boolean } | { error: string } {
	if (raw === undefined || raw === null) return { json: '', given: false };
	if (!Array.isArray(raw)) return { error: 'error: tests must be an array of {name, args, expect}' };
	if (raw.length > 20) return { error: 'error: a plugin may bring at most 20 tests' };
	const tests: { name: string; args: Record<string, unknown>; expect: string }[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			return { error: 'error: each test must be {name, args, expect}' };
		}
		const t = entry as { name?: unknown; args?: unknown; expect?: unknown };
		const name = typeof t.name === 'string' ? t.name.trim().slice(0, 120) : '';
		if (!name) return { error: 'error: every test needs a name' };
		if (t.args !== undefined && (typeof t.args !== 'object' || t.args === null || Array.isArray(t.args))) {
			return { error: `error: test "${name}" needs args as an object` };
		}
		if (t.expect === undefined) {
			return {
				error: `error: test "${name}" needs expect (the output it must produce, or "error:" to require a refusal)`
			};
		}
		tests.push({
			name,
			args: (t.args as Record<string, unknown>) ?? {},
			expect: String(t.expect).slice(0, 500)
		});
	}
	return { json: JSON.stringify(tests), given: true };
}

/** The bot's existing schedules, one line each, for the police to compare against. */
function scheduleLines(botId: string): string[] {
	const lines: string[] = [];
	for (const r of listRoutines(botId)) {
		const when = r.cron ? `cron "${r.cron}"` : `every ${r.interval_min}m`;
		lines.push(`routine "${r.name}" (${when}) - ${r.prompt.slice(0, 120)}`);
	}
	for (const w of listWakes(botId)) {
		const when = w.cron ? `cron "${w.cron}"` : `at ${new Date(w.run_at).toISOString()}`;
		lines.push(`wake (${when}) - ${w.prompt.slice(0, 120)}`);
	}
	return lines;
}

/**
 * Put a freshly created routine or wake in front of the police and record what
 * they said. A routine cannot be run on demand, so the officer judges the
 * instruction and the schedule, not an outcome - and is told so, rather than
 * being invited to pretend it ran.
 */
async function policeRoutine(opts: {
	botName: string;
	name: string;
	prompt: string;
	schedule: string;
	existing: string[];
	/** The verification the row already carries, for the attempt count; '' = none. */
	priorVerification?: string;
}): Promise<{ verdict: CreationVerdict; line: string }> {
	const verdict = applyAttempt(
		await reviewRoutine({ ...opts, model: policeModel() }),
		opts.priorVerification ?? ''
	);
	return { verdict, line: signOff(null, null, verdict) };
}

/** Execute one tool call; always returns a string result for the model. */
export async function executeTool(
	name: string,
	argsJson: string,
	ctx: ToolContext
): Promise<string> {
	let args: unknown;
	try {
		args = JSON.parse(argsJson || '{}');
	} catch {
		return 'error: invalid tool arguments';
	}
	// A scalar or array parses fine but has no named arguments to read.
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		return 'error: invalid tool arguments';
	}
	const a = args as Record<string, unknown>;

	try {
		// In the main reply loop the computer and browser tools are delegated,
		// never run directly: a model that names one anyway is told to go
		// through use_computer or browse. Inside a sub-agent the toolbox marks
		// which catalogue it holds, so the browser agent cannot reach for the
		// shell and the computer agent cannot read the web.
		const inComputer = COMPUTER_TOOLS.some((t) => t.function.name === name);
		const inBrowser = BROWSER_TOOLS.some((t) => t.function.name === name);
		// Tools in both catalogues - the pixel input and screenshot tools - are
		// refused only in the main loop; either sub-agent may run them.
		const computerOnly = inComputer && !inBrowser;
		const browserOnly = inBrowser && !inComputer;
		const refused =
			ctx.toolbox === 'browser'
				? computerOnly
				: ctx.toolbox === 'computer'
					? browserOnly
					: (inComputer || inBrowser) && !!(ctx.runComputer || ctx.runBrowser);
		if (refused) {
			if (ctx.toolbox === 'browser') {
				return 'error: no shell or desktop setup here - report back what you need instead';
			}
			return browserOnly
				? 'error: browser actions are delegated - call browse with the task instead'
				: 'error: computer actions are delegated - call use_computer with the task instead';
		}
		switch (name) {
			case 'use_computer': {
				const task = str(a.task);
				if (!task) return 'error: describe the computer task';
				if (!ctx.runComputer) return 'error: computer is unavailable here';
				logEvent(ctx.conversationId, ctx.senderBotId, 'computer', `Using the computer: ${task.slice(0, 120)}`);
				return await ctx.runComputer(task);
			}
			case 'spawn_agent': {
				const task = str(a.task);
				if (!task) return 'error: describe what the helper should do';
				if (!ctx.spawnAgent) return 'error: helpers cannot spawn helpers of their own';
				return await ctx.spawnAgent(task, text(a.context) || undefined);
			}
			case 'improve': {
				const goal = str(a.goal);
				if (!goal) return 'error: describe what you want to improve at';
				if (!ctx.improve) return 'error: the improvement expert is unavailable here';
				logEvent(ctx.conversationId, ctx.senderBotId, 'police', `Improvement review: ${goal.slice(0, 120)}`);
				return await ctx.improve(goal);
			}
			case 'ask_police': {
				const question = str(a.question);
				if (!question) return 'error: describe what you are unsure about';
				if (!ctx.askPolice) return 'error: the police cannot be reached here';
				logEvent(ctx.conversationId, ctx.senderBotId, 'police', `Asked the police: ${question.slice(0, 120)}`);
				return await ctx.askPolice(question);
			}
			case 'browse': {
				const task = str(a.task);
				if (!task) return 'error: describe what the browser should do';
				if (!ctx.runBrowser) return 'error: the browser is unavailable here';
				logEvent(ctx.conversationId, ctx.senderBotId, 'browser', `Browsing: ${task.slice(0, 120)}`);
				return await ctx.runBrowser(task);
			}
			case 'shell_exec': {
				const command = str(a.command);
				if (!command) return 'error: command required';
				const machine = text(a.machine) || 'desktop';
				// 'kali' is the shell's old name; keep accepting it.
				if (machine !== 'desktop' && machine !== 'shell' && machine !== 'kali') {
					return 'error: machine must be "desktop" or "shell"';
				}
				logActivity(
					ctx.senderBotId,
					'shell',
					(machine === 'shell' || machine === 'kali' ? '(shell) ' : '') + command.slice(0, 120)
				);
				// Both run in the same container: "shell" types the command into the
				// tmux pane the person watches, "desktop" runs it quietly.
				const out =
					machine === 'shell' || machine === 'kali'
						? await shellExec(ctx.senderBotId, command, ctx.signal)
						: await machineExec(ctx.senderBotId, command, ctx.signal);
				// Only now is it really at the keyboard: logging typing before the
				// wake showed the bot typing on a machine that was still off.
				logActivity(ctx.senderBotId, 'typing', 'at the keyboard');
				// A bot that reads its own secret file must not put the value into
				// the transcript; the tool result is the last place we can catch it.
				return redactSecrets(ctx.senderBotId, out).slice(0, 8000) || '(no output)';
			}
			case 'browser_navigate': {
				const url = str(a.url);
				if (!url) return 'error: url required';
				logEvent(ctx.conversationId, ctx.senderBotId, 'browser', `Opening ${url.slice(0, 120)}`);
				// The domain is set before the navigate so a failed load still
				// tags its observation to the site that was tried, not the last
				// one that worked.
				const domain = normalizeSite(url);
				if (domain) ctx.currentDomain = domain;
				const page = await navigateBrowser(ctx.senderBotId, url);
				logActivity(ctx.senderBotId, 'typing', 'at the keyboard');
				// Written last on purpose. The "Opening" row above lands before the
				// machine wakes, so the boot's own sandbox rows bury it and the
				// bubble falls back to the sparkle for the whole page read; this
				// one is the newest activity, so the browser glyph holds while the
				// bot is actually in the browser.
				logActivity(ctx.senderBotId, 'browser', 'Reading the page');
				let out = page ? `opened ${url}\n\n${page}` : `opened ${url}`;
				// A domain the fleet has not documented spawns the documenter in
				// the background; the note - draft included - rides the result so
				// the actor reads what the fleet knows without a second tool.
				if (domain) {
					const visit = noteDomainVisit({
						botId: ctx.senderBotId,
						botName: ctx.senderBotName,
						domain,
						model: ctx.model,
						signal: ctx.signal,
						conversationId: ctx.conversationId
					});
					if (visit.spawned) {
						out +=
							`\n\n[${domain} is new to the fleet - a documenter is mapping ` +
							'it in the background; its note will appear here on later visits]';
					} else if (visit.note?.note) {
						const state = visit.note.status === 'ready' ? 'site note' : 'site note (still being written)';
						out += `\n\n[${state} for ${domain}]\n${visit.note.note}`;
					}
				}
				return out;
			}
			case 'browser_walk':
			case 'browser_click':
			case 'browser_fill':
			case 'browser_scroll':
			case 'browser_back':
			case 'browser_press': {
				// One step of the walk: act, then read the page back. The result
				// is always the fresh view - text plus numbered elements - so the
				// agent never acts on a stale list.
				let action: BrowseAction;
				if (name === 'browser_walk') {
					action = { kind: 'walk' };
				} else if (name === 'browser_back') {
					action = { kind: 'back' };
				} else if (name === 'browser_press') {
					const key = str(a.key);
					if (!key) return 'error: key required';
					action = { kind: 'press', key };
				} else if (name === 'browser_scroll') {
					const direction = text(a.direction) === 'up' ? 'up' : 'down';
					const amount = text(a.amount) === 'line' ? 'line' : 'page';
					action = { kind: 'scroll', direction, amount };
				} else {
					const index = Number(a.index);
					if (!Number.isInteger(index) || index < 0) {
						return 'error: index must be an element number from the last page view';
					}
					if (name === 'browser_click') {
						action = { kind: 'click', index };
					} else {
						const fill = str(a.text);
						if (!fill) return 'error: text required';
						action = { kind: 'fill', index, text: fill };
					}
				}
				const step = await browseAction(ctx.senderBotId, action);
				// The walk reports the URL it landed on: a click that navigated
				// re-tags the domain, so the observations that follow belong to
				// the site the browser is actually on.
				const domain = normalizeSite(step.url);
				if (domain) ctx.currentDomain = domain;
				logActivity(
					ctx.senderBotId,
					'browser',
					name === 'browser_walk' ? 'Reading the page' : `${name.replace('browser_', '')} on the page`
				);
				return step.text;
			}
			case 'browser_screenshot': {
				const shot = await captureShot(ctx.senderBotId);
				logActivity(ctx.senderBotId, 'browser', 'Took a screenshot', shot);
				return shot ? 'screenshot captured (visible on your screen panel)' : 'screenshot failed';
			}
			case 'send_screenshot': {
				if (!ctx.conversationId) {
					return 'error: there is no conversation to send the screenshot to';
				}
				// The machine must already be up: a screenshot must not wake a
				// machine the bot did not ask to spend on, so an off machine is a
				// plain refusal rather than a silent wake.
				const status = await machineStatus(ctx.senderBotId);
				if (status.state !== 'running') {
					return (
						`error: your machine is ${status.state === 'sleeping' ? 'asleep' : 'not built'} - ` +
						'wake it first, then send a screenshot'
					);
				}
				if (machineTier(ctx.senderBotId) !== 'full') {
					return 'error: you have no desktop to screenshot';
				}
				const asked = shotRegion(a);
				if (typeof asked === 'string') return asked;
				let region = asked;
				let label = 'the full screen';
				if (region) {
					// The screen size is read without waking anything, and the
					// rectangle is clamped to it: a region past the edge becomes
					// the part that exists, and one that misses the screen is
					// refused rather than posted as a 1x1 picture.
					const screen = await readPointer(ctx.senderBotId);
					if (!screen) return 'error: could not read your screen size';
					const clamped = clampRegion(region, screen);
					if (!clamped) {
						return `error: that region is outside your ${screen.w}x${screen.h} screen`;
					}
					region = clamped;
					label = `the region ${clamped.w}x${clamped.h} at (${clamped.x}, ${clamped.y})`;
				}
				const shot = await captureShot(ctx.senderBotId, region);
				if (!shot) return 'error: the screenshot failed - nothing was sent';
				// The picture rides on the message itself, so the thread renders
				// it inline; the caption says what was captured, and the bubble's
				// own stamp says when.
				addMessage(
					ctx.conversationId,
					'assistant',
					`Screenshot of my screen - ${label}.`,
					ctx.senderBotId,
					'',
					0,
					'',
					'',
					'',
					shot
				);
				logActivity(ctx.senderBotId, 'browser', `Sent a screenshot (${label})`, shot);
				return `sent a screenshot of ${label} to the chat`;
			}
			case 'screen_look': {
				// The picture goes to the model, not the person: the loop pushes
				// pendingShot into the conversation as an image part, and the
				// flag is what lets the input tools run until the next action.
				let shot = '';
				try {
					shot = await machineScreenshot(ctx.senderBotId, undefined, SCREEN_GRID_PX);
				} catch (e) {
					return `error: ${e instanceof Error ? e.message : String(e)}`;
				}
				if (!shot) return 'error: the screenshot failed';
				ctx.pendingShot = shot;
				ctx.screenSeen = true;
				logActivity(ctx.senderBotId, 'browser', 'Looked at its screen');
				return 'screenshot shown to you - read coordinates off the grid';
			}
			case 'mouse_click':
			case 'mouse_move':
			case 'mouse_scroll':
			case 'type_text':
			case 'key_press': {
				// Check-before-use, enforced here rather than asked for in a
				// prompt: an input tool cannot run until the model has been
				// shown the screen this step, and running one spends that proof
				// because the screen it described just changed. A failed action
				// changes nothing, so the proof survives it.
				if (!ctx.screenSeen) {
					return (
						'error: look at the screen first - call screen_look, then act on ' +
						'what it shows. Every action needs a fresh look before it.'
					);
				}
				const gesture = desktopGesture(name, a);
				if (typeof gesture === 'string') return gesture;
				try {
					await desktopInput(ctx.senderBotId, gesture.g);
				} catch (e) {
					return `error: ${e instanceof Error ? e.message : String(e)}`;
				}
				ctx.screenSeen = false;
				logActivity(ctx.senderBotId, 'typing', gesture.say);
				return `${gesture.say} - look at the screen again before the next action`;
			}
			case 'setup_desktop': {
				logEvent(ctx.conversationId, ctx.senderBotId, 'sandbox', 'Setting up its desktop');
				return await setupDesktop(ctx.senderBotId, {
					desktop: text(a.desktop) || undefined,
					browser: text(a.browser) || undefined
				});
			}
			case 'company_read': {
				const raw = text(a.path);
				if (!raw) return 'error: path required';
				// The app cannot see the volume, so the page is cut inside the
				// machine: a running one shows the read on its terminal, an asleep
				// one wakes and serves it quietly.
				const path = raw.startsWith('/company/') ? raw : `/company/${raw.replace(/^\/+/, '')}`;
				const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
				const status = await machineStatus(ctx.senderBotId).catch(
					() => ({ state: 'off' }) as { state: string }
				);
				const exec =
					status.state === 'running'
						? (cmd: string) => shellExec(ctx.senderBotId, cmd)
						: (cmd: string) => machineExec(ctx.senderBotId, cmd);
				const total = Number((await exec(`wc -l < ${quoted}`)).trim());
				if (!Number.isFinite(total)) return `error: cannot read ${path}`;
				const pages = Math.max(1, Math.ceil(total / COMPANY_PAGE_LINES));
				const page = Math.min(Math.max(1, Math.floor(Number(a.page) || 1)), pages);
				const start = (page - 1) * COMPANY_PAGE_LINES + 1;
				const body = await exec(`sed -n '${start},${start + COMPANY_PAGE_LINES - 1}p' ${quoted}`);
				const more = page < pages ? ` - company_read page ${page + 1} continues` : '';
				return `${body.trimEnd()}\n(page ${page} of ${pages}, ${total} lines${more})`.slice(
					0,
					8000
				);
			}
			case 'sleep_machine': {
				// The reason goes in the activity line so the log does not claim
				// the reaper slept this one.
				const was = await sleepMachine(ctx.senderBotId, 'on request');
				if (was === 'running') {
					return 'Your machine is asleep. wake_machine brings it back in seconds.';
				}
				if (was === 'sleeping') return 'Your machine was already asleep.';
				return 'You have no machine yet, so there is nothing to sleep.';
			}
			case 'wake_machine': {
				// Read the state first: once the wake has run, whether there was
				// anything asleep to wake is no longer knowable.
				const was = (await machineStatus(ctx.senderBotId)).state;
				await ensureMachine(ctx.senderBotId);
				if (was === 'running') return 'Your machine was already awake.';
				if (was === 'sleeping') return 'Your machine is awake again.';
				return 'Your machine is awake - it had not been built yet, so a new one was created.';
			}
			case 'machine_status': {
				const status = await machineStatus(ctx.senderBotId);
				const window = `${IDLE_MINUTES} idle minute${IDLE_MINUTES === 1 ? '' : 's'}`;
				if (status.state === 'running') {
					const since = status.lastActive
						? ` Last used ${shortAge(status.lastActive)} ago.`
						: '';
					return (
						`Your machine is running.${since} It sleeps on its own after ${window}; ` +
						'sleep_machine puts it down now, wake_machine brings it back in seconds.'
					);
				}
				if (status.state === 'sleeping') {
					return (
						'Your machine is asleep, costing nothing while it is down. It sleeps on ' +
						`its own after ${window} once it is up; wake_machine brings it back now.`
					);
				}
				return (
					'You have no machine yet - the first command or page you open builds one. ' +
					`It sleeps on its own after ${window}; wake_machine builds it now.`
				);
			}
			case 'send_message': {
				if (ctx.depth >= MAX_RELAY_DEPTH) {
					return 'error: relay limit reached — answer directly instead';
				}
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				const message = str(a.message);
				if (target.id === ctx.senderBotId) return 'error: cannot message yourself';
				const refusal = relayRefusal(ctx, target);
				if (refusal) return refusal;
				// A model that calls send_message twice in one turn would otherwise
				// write the same line twice and wake the target twice; the human's
				// own double-submits are already deduped in the chat route, and a
				// relay is the same shape. Ten seconds is long enough to catch a
				// double-fire and short enough that a bot genuinely repeating
				// itself still gets through.
				const room = botPairConversation(ctx.senderBotId, target.id);
				if (recentRelayMessage(room.id, ctx.senderBotId, message, 10_000)) {
					return `already delivered - ${target.name} has your message; wait for the reply instead of sending it again`;
				}
				const sent = await sendRelay(ctx, target, message);
				return sent.ok
					? `${target.name} replied: ${sent.reply.slice(0, 2000)}`
					: `error: the message to ${target.name} did not get through: ${sent.why.slice(0, 300)}`;
			}
			case 'remember': {
				const key = str(a.key);
				const value = str(a.value);
				if (!key) return 'error: key required';
				setMemory(ctx.senderBotId, key, value);
				// The knowledge store and the scratchpad file are the same notes in
				// two places: the store is what recall reads, the file is what the
				// human edits in Settings. Mirroring is best-effort - a drive that
				// cannot be reached must not make remembering fail.
				void appendScratchpad(ctx.senderBotId, `- ${key}: ${value}`).catch(() => {});
				return 'remembered';
			}
			case 'message_peer': {
				const message = str(a.message);
				if (!message.trim()) return 'error: message required';
				return sendToPeer(ctx.senderBotId, text(a.peer_name), message);
			}
			case 'block_bot': {
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				// On its own behalf only: there is no argument for naming someone
				// else as the blocker, and accepting one would let a bot put a
				// refusal in another's mouth.
				if (target.id === ctx.senderBotId) return 'error: cannot block yourself';
				const standing = blockBetween(ctx.senderBotId, target.id);
				// The reason is read out in the Lounge and kept in the log, so no
				// secret of either bot's is written into it: the same treatment the
				// sandbox output gets, applied to the words before they are stored.
				// Re-blocking re-words the reason rather than clearing it - clearing
				// is what unblock_bot is for, not an accident of a missing argument.
				const reason =
					redactSecrets(
						ctx.senderBotId,
						redactSecrets(target.id, str(a.reason))
					)
						.replace(/\s+/g, ' ')
						.trim() || standing?.reason || '';
				blockBot(ctx.senderBotId, target.id, reason);
				if (standing) {
					return (
						`you already block ${target.name}${reason ? `: "${reason}"` : ' (no reason given)'}. ` +
						'It cannot message you, and the Lounge can see it.'
					);
				}
				logActivity(
					ctx.senderBotId,
					'block',
					`Blocked ${target.name}${reason ? `: ${reason}` : ''}`
				);
				return (
					`blocked ${target.name}${reason ? `: "${reason}"` : ' (no reason given)'}. ` +
					'Its messages are refused before they reach you, and the block is visible in the ' +
					'Lounge — expect to be asked about it.'
				);
			}
			case 'unblock_bot': {
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				// Unblocking is lifting your own refusal. Only rows with this bot as
				// the blocker are reachable, so nobody can lift someone else's.
				if (!unblockBot(ctx.senderBotId, target.id)) {
					return `error: you have not blocked ${target.name}`;
				}
				logActivity(ctx.senderBotId, 'unblock', `Unblocked ${target.name}`);
				return `unblocked ${target.name} — its messages reach you again`;
			}
			case 'list_blocks': {
				const blocks = listBlocks(ctx.senderBotId);
				if (blocks.length === 0) return 'You have not blocked anyone.';
				const names = new Map(listBots().map((b) => [b.id, b.name]));
				return blocks
					.map((b) => {
						const who = names.get(b.blocked_id) ?? 'a bot that is gone';
						return `${who}: ${b.reason ? `"${b.reason}"` : 'no reason given'} (blocked ${shortAge(b.created_at)} ago)`;
					})
					.join('\n');
			}
			case 'wear_hat': {
				const wanted = text(a.hat).toLowerCase();
				if (!wanted) {
					updateBot(ctx.senderBotId, { hat: '' });
					return 'hat off';
				}
				if (!isHat(wanted)) return `error: no such hat. try: ${HATS.join(', ')}`;
				updateBot(ctx.senderBotId, { hat: wanted });
				return `wearing the ${wanted} hat`;
			}
			case 'pub_treat': {
				const bot = getBot(ctx.senderBotId);
				if (!bot) return 'error: no bot to treat';
				return resolveTreat(bot, text(a.gift_to));
			}
			case 'recall': {
				const key = str(a.key);
				const memories = listMemories(ctx.senderBotId).filter(
					(m) => !key || m.key === key
				);
				if (memories.length === 0) return '(none)';
				return memories.map((m) => `${m.key}: ${m.value}`).join('\n');
			}
			case 'list_files': {
				const files = listBotFiles(ctx.senderBotId);
				if (files.length === 0) return 'The user has not given you any files.';
				// The list is oldest first, so the last row of a name is the newest
				// - which is the one read_file and friends will read for it.
				const seen = new Map<string, number>();
				const newest = new Map<string, string>();
				for (const f of files) {
					seen.set(f.name, (seen.get(f.name) ?? 0) + 1);
					newest.set(f.name, f.id);
				}
				const lines = files.map((f) => {
					const count = seen.get(f.name) ?? 1;
					const tag =
						count === 1
							? ''
							: f.id === newest.get(f.name)
								? ` (the newest of ${count} files with this name)`
								: ' (an older copy; this name reads the newest)';
					return `${f.name} — ${humanSize(f.size)}, ${f.mime}, ${shortAge(f.created_at)} old${tag}`;
				});
				const page = joinCapped(lines);
				if (page.left === 0) return page.text;
				// An inventory is unbounded too - the picker takes many files at
				// once - so it is capped like everything else, and says what went.
				return `${page.text}\n— ${page.shown} of ${files.length} files listed here; ask again with a narrower question rather than expecting the rest.`;
			}
			case 'read_file': {
				const file = namedFile(ctx.senderBotId, a.name);
				if (typeof file === 'string') return file;
				const read = await readTextFile(file);
				if (typeof read === 'string') return read;
				logActivity(ctx.senderBotId, 'file', `Read the start of "${file.name}"`);
				const { lines } = read;
				if (read.empty) return `"${file.name}" is empty.`;
				// A few dozen lines: enough to see what the file is, never the
				// whole of a large one - paging is what read_lines is for.
				const page = joinCapped(
					lines.slice(0, HEAD_LINES).map((line, i) => numberedLine(i + 1, line))
				);
				if (page.cut) return `${page.text}\n— ${cutLine(page.shown, file)}`;
				if (page.shown >= lines.length) {
					return `${page.text}\n— ${lines.length} line${lines.length === 1 ? '' : 's'}, all shown.`;
				}
				const next = Math.min(lines.length, page.shown + HEAD_LINES);
				return (
					`${page.text}\n— lines 1-${page.shown} of ${lines.length}: ` +
					`read_lines {name: "${file.name}", from: ${page.shown + 1}, to: ${next}} for the next page, ` +
					'or grep_files {pattern: "…"} to find a passage.'
				);
			}
			case 'read_lines': {
				const file = namedFile(ctx.senderBotId, a.name);
				if (typeof file === 'string') return file;
				const from = Number(a.from ?? 1);
				const to = a.to === undefined ? from + HEAD_LINES - 1 : Number(a.to);
				if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
					return 'error: from and to must be whole line numbers, with to at or after from';
				}
				const read = await readTextFile(file);
				if (typeof read === 'string') return read;
				const { lines } = read;
				const first = Math.min(from, lines.length);
				const last = Math.min(to, lines.length);
				const page = joinCapped(
					lines
						.slice(first - 1, last)
						.map((line, i) => numberedLine(first + i, line))
				);
				const end = first + page.shown - 1;
				// A line longer than the whole cap has to be reported as cut: the
				// number that follows it is not a page anyone can turn to.
				if (page.cut) return `${page.text}\n— ${cutLine(end, file)}`;
				const footer = `${first}-${end} of ${lines.length}`;
				if (end >= lines.length) {
					return `${page.text}\n— lines ${footer}, the end of the file.`;
				}
				return `${page.text}\n— lines ${footer}: read on from ${end + 1}, to ${Math.min(lines.length, end + HEAD_LINES)}.`;
			}
			case 'grep_files': {
				const pattern = text(a.pattern);
				if (!pattern) return 'error: pattern required';
				if (pattern.length > 200) return 'error: pattern must be 200 characters or fewer';
				const wanted = text(a.name);
				const named = wanted ? findFile(ctx.senderBotId, wanted) : undefined;
				if (wanted && !named) return `error: no file named "${wanted}"`;
				const files = named ? [named] : listBotFiles(ctx.senderBotId);
				if (files.length === 0) return 'The user has not given you any files.';

				// A plain substring, deliberately: a pattern the model wrote is
				// not worth handing the regex engine, where one bad expression
				// can backtrack until the turn's timeout.
				const needle = pattern.toLowerCase();
				const matches: string[] = [];
				const skipped: string[] = [];
				let searched = 0;
				for (const file of files) {
					if (!isTextMime(file.mime)) {
						skipped.push(file.name);
						continue;
					}
					const bytes = await readFileBytes(file);
					if (!bytes) continue;
					searched++;
					textLines(bytes.toString('utf8')).forEach((line, i) => {
						if (line.toLowerCase().includes(needle)) {
							// One file reads like read_lines; several read like grep,
							// where the file name is what tells the hits apart.
							matches.push(named ? numberedLine(i + 1, line) : `${file.name}:${i + 1}: ${line}`);
						}
					});
				}
				const omitted = skipped.length ? ` (not searched: ${skipped.join(', ')} - not text)` : '';
				if (matches.length === 0) {
					const where = named
						? `in ${named.name}`
						: `in ${searched} text file${searched === 1 ? '' : 's'}`;
					return `No lines match "${pattern}" ${where}.${omitted}`;
				}
				const page = joinCapped(matches);
				if (page.left === 0) {
					return `${page.text}\n— ${matches.length} matching line${matches.length === 1 ? '' : 's'}.${omitted}`;
				}
				const narrower = named ? 'narrow the pattern' : 'narrow the pattern or name one file';
				return `${page.text}\n— the first ${page.shown} of ${matches.length} matching lines; ${narrower} for the rest.${omitted}`;
			}
			case 'read_output': {
				const callId = text(a.call_id);
				const page = Number(a.page);
				if (!callId) return 'error: call_id required';
				if (!Number.isInteger(page) || page < 2) return 'error: page must be a whole number, 2 or more';
				return pagedToolOutput(callId, page);
			}
			case 'react': {
				const emoji = text(a.emoji);
				const explicit = text(a.message_id);
				const target = explicit
					? getMessage(explicit)
					: latestMessageFromOthers(ctx.conversationId, ctx.senderBotId);
				if (!target) return 'There is no message to react to.';
				// An explicit id must belong to the conversation the bot is in,
				// never to one it cannot see.
				if (target.conversation_id !== ctx.conversationId)
					return 'That message is not in this conversation.';
				if (emoji) {
					addReaction(target.id, ctx.senderBotId, emoji);
					logActivity(ctx.senderBotId, 'reacted', `Reacted ${emoji}`);
					return `Reacted ${emoji}.`;
				}
				removeReaction(target.id, ctx.senderBotId);
				return 'Reaction removed.';
			}
			case 'search_history': {
				const query = text(a.query);
				if (!query) return 'search_history needs a query.';
				const hits = searchHistory(ctx.senderBotId, query, Number(a.limit) || 10);
				if (!hits.length) return `Nothing in your history matches "${query}".`;
				return hits
					.map((h) => {
						const when = new Date(h.created_at).toISOString().slice(0, 16).replace('T', ' ');
						const who = h.bot_id === ctx.senderBotId ? 'you' : h.role;
						return `[${when}] (${h.title}) ${who}: ${h.content.slice(0, 300)}`;
					})
					.join('\n');
			}
			case 'search_web': {
				const query = text(a.query);
				if (!query) return 'error: query required';
				const numResults = Math.min(10, Math.max(1, Number(a.num_results) || 5));
				logActivity(ctx.senderBotId, 'search', `Searching the web: ${query.slice(0, 100)}`);
				return await webSearch(query, numResults);
			}
			case 'deepwiki': {
				const repo = text(a.repo).trim();
				const question = text(a.question).trim();
				if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return 'error: repo must look like owner/name';
				if (!question) return 'error: question required';
				logActivity(ctx.senderBotId, 'docs', `DeepWiki ${repo}: ${question.slice(0, 100)}`);
				return await askDeepWiki(repo, question);
			}
			case 'my_tasks': {
				const limit = Math.min(50, Math.max(1, Number(a.limit) || 10));
				const mine = listTasks({ botId: ctx.senderBotId }).slice(0, limit);
				if (!mine.length) return 'You have no background tasks.';
				const lines = mine.map((t) => {
					const status = t.status === 'running' ? 'RUNNING' : t.status;
					// The caller's own turn is listed - it is real work the bot can see
					// - but marked as the one it is inside, so it is not read as an
					// invitation to stop the job writing the answer.
					const self = t.id === ctx.taskId ? ' (this is this turn, not stoppable from in here)' : '';
					return `${status} (${shortAge(t.created_at)} ago) ${t.id}: ${t.prompt.slice(0, 200)}${self}`;
				});
				const running = mine.filter((t) => t.status === 'running' && t.id !== ctx.taskId);
				// Running work goes first and gets called out: that is what a bot
				// would want to stop, and the id in each line is its handle. The turn
				// itself is not counted, or the summary would offer a handle it cannot
				// take.
				return running.length
					? `${running.length} still running — cancel_task to stop one.\n${lines.join('\n')}`
					: lines.join('\n');
			}
			case 'cancel_task': {
				const id = text(a.task_id);
				if (!id) return 'error: task_id required';
				const task = getTask(id);
				if (!task || task.bot_id !== ctx.senderBotId) return 'error: that task is not yours';
				// Cancelling the turn making this call aborts it mid-stream: the row
				// lands as 'cancelled' with no error and the answer half-written, and
				// from outside it looks like a task that simply vanished. Refuse, and
				// say which ask it is, so the model can pick a different one.
				if (id === ctx.taskId) {
					return 'error: that is the task running this turn - you cannot cancel the one you are in; pick another, or just stop what you are doing and answer';
				}
				if (!cancelTask(id)) return 'That task had already finished.';
				logActivity(ctx.senderBotId, 'task', `Cancelled: ${task.prompt.slice(0, 60)}`);
				return 'Task cancelled.';
			}
			case 'share_note': {
				const content = str(a.content);
				if (!content) return 'error: content required';
				addNote(ctx.conversationId, ctx.senderBotId, content);
				return 'noted';
			}
			case 'schedule_task': {
				const prompt = str(a.prompt);
				if (!prompt) return 'error: prompt required';
				const cron = str(a.cron);
				const delay = Number(a.delay_minutes ?? 0);
				if (a.delay_minutes !== undefined && (!Number.isFinite(delay) || delay <= 0)) {
					return 'error: delay_minutes must be a positive number';
				}
				if (cron && delay) return 'error: give delay_minutes or cron, not both';
				if (!cron && !delay) return 'error: give delay_minutes or cron';
				const runAt = delay ? Date.now() + delay * 60_000 : undefined;
				// Read the bot's other schedules before this one lands, so the
				// police compare against what it already had rather than against
				// the row being judged.
				const existing = scheduleLines(ctx.senderBotId);
				const wake = scheduleWake(ctx.senderBotId, ctx.conversationId, prompt, {
					runAt,
					cron: cron || undefined
				});
				// A schedule is a prompt the bot will run on a clock, and it cannot
				const review = policeSettings().checkWakes
					? await policeRoutine({
							botName: ctx.senderBotName,
							name: prompt.slice(0, 60),
							prompt,
							schedule: cron ? `cron "${cron}"` : `once in ${delay}m`,
							existing,
							// Re-creating a refused wake spends another attempt: the
							// newest other wake with the same prompt carries the count.
							priorVerification:
								listWakes(ctx.senderBotId).find((w) => w.id !== wake.id && w.prompt === prompt)
									?.verification ?? ''
						})
					: null;
				if (review) {
					setWakeVerification(wake.id, verdictJson(review.verdict));
					if (review.verdict.verdict === 'rejected') {
						setWakeEnabled(wake.id, false, review.verdict.reason);
					}
				}
				logActivity(ctx.senderBotId, 'schedule', prompt.slice(0, 100));
				const fix =
					review?.verdict.verdict === 'rejected' && !review.verdict.awaitingHuman
						? ' - it is switched off until you fix it and schedule it again'
						: '';
				return `${cron ? `scheduled recurring "${cron}"` : `scheduled in ${delay}m`}${review ? ` | ${review.line}` : ''}${fix}`;

			}
			case 'schedules': {
				const cancelId = text(a.cancel);
				if (cancelId) {
					// A bot can only switch its own schedules off: the id is looked up
					// in its own rows, so a guess at somebody else's is just not found.
					const wake = listWakes(ctx.senderBotId).find((w) => w.id === cancelId);
					if (wake) {
						deleteWake(wake.id);
						logActivity(ctx.senderBotId, 'schedule', `Cancelled wake: ${wake.prompt.slice(0, 60)}`);
						return 'wake cancelled';
					}
					const routine = listRoutines(ctx.senderBotId).find((r) => r.id === cancelId);
					if (routine) {
						deleteRoutine(routine.id);
						logActivity(ctx.senderBotId, 'schedule', `Cancelled routine: ${routine.name}`);
						return 'routine cancelled';
					}
					return 'error: no schedule of yours has that id';
				}
				const wakes = listWakes(ctx.senderBotId);
				const routines = listRoutines(ctx.senderBotId);
				if (!wakes.length && !routines.length) return 'You have no schedules.';
				const lines: string[] = [];
				for (const r of routines) {
					const state = r.enabled ? `next ${new Date(r.next_run_at).toISOString()}` : `off${r.paused_reason ? ` (${r.paused_reason})` : ''}`;
					lines.push(`routine ${r.id}: "${r.name}" ${state} - ${r.prompt.slice(0, 120)}`);
				}
				for (const w of wakes) {
					const when = w.cron ? `cron "${w.cron}"` : `at ${new Date(w.run_at).toISOString()}`;
					const state = w.enabled ? when : `off${w.paused_reason ? ` (${w.paused_reason})` : ''}`;
					lines.push(`wake ${w.id}: ${state} - ${w.prompt.slice(0, 120)}`);
				}
				return lines.join('\n');
			}
			case 'wait_for': {
				const description = str(a.description);
				if (!description) return 'error: description required';
				// Only what the bot asked for goes in the spec; every option it left
				// out reads as unset, which is what each of them means.
				const spec: WatchSpec = {
					pattern: text(a.pattern),
					regex: a.regex === true,
					case_sensitive: a.case_sensitive === true,
					from: text(a.from),
					mentions_me: a.mentions_me === true,
					conversation: text(a.conversation),
					activity_kind: text(a.activity_kind),
					status: Number(a.status) || undefined,
					changed: a.changed === true,
					code: text(a.code) || undefined,
					selector: text(a.selector) || undefined,
					at: text(a.at)
				};
				const expires = Number(a.expires_minutes) || 0;
				let wait: WaitCondition;
				try {
					// createWait logs the watch itself; a second activity line here
					// would say the same thing twice.
					wait = createWait(ctx.senderBotId, ctx.conversationId, description, {
						kind: text(a.kind),
						url: text(a.url),
						contains: text(a.contains),
						spec,
						everySeconds: Number(a.every_seconds) || 0,
						expiresMinutes: expires
					});
				} catch (e) {
					// The detail lives here rather than in the schema: a bot that
					// guessed wrong learns which fields its kind actually reads.
					const hints: Record<string, string> = {
						message: 'message reads: pattern, regex, case_sensitive, from, mentions_me, conversation',
						file: 'file reads: pattern (the filename)',
						task: 'task reads: nothing extra - any of your tasks finishing fires it',
						activity: 'activity reads: activity_kind and pattern',
						http: 'http reads: url, contains, status, changed, every_seconds',
						code: 'code reads: code (JS async body, return truthy to fire)',
						page: 'page reads: url, contains, changed, selector, every_seconds',
						webhook: 'webhook reads: nothing extra - you get a URL to hand out'
					};
					const hint = hints[text(a.kind) || (text(a.url) ? 'http' : 'message')];
					return `error: ${(e as Error).message}${hint ? ` (${hint})` : ''}`;
				}
				const parts = [`watching (${wait.kind}) for: ${description}`];
				if (wait.kind === 'webhook') parts.push(`POST anything to ${wait.url} to fire it`);
				if (spec.at) parts.push(`only at ${spec.at}`);
				if (expires > 0) parts.push(`gives up after ${expires}m`);
				return parts.join(' | ');
			}
			case 'create_plugin': {
				const name = str(a.name);
				const kind = str(a.kind ?? 'tool');
				const code = str(a.code);
				if (!name || !code) return 'error: name and code required';
				if (kind !== 'tool' && kind !== 'hook') return 'error: kind must be tool or hook';
				// A bot builds plugins for itself only. A shared hook runs inside
				// every other bot's sandbox, where it can read their secrets, so the
				// tool has no way to make one - the user's own plugin form does.
				const hookPoint = kind === 'hook' ? str(a.hook_point) : '';
				if (kind === 'hook' && hookPoint !== 'before_reply' && hookPoint !== 'after_reply') {
					return 'error: hook_point must be before_reply or after_reply';
				}
				// Tools are dispatched by slugified name, so a second plugin with
				// the same one is unreachable - the first match wins. The API
				// refuses with a 409; the tool says it in words.
				if (listPlugins().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
					return `error: a plugin named "${name}" already exists - update_plugin it instead`;
				}
				const tests = pluginTestsField(a.tests);
				if ('error' in tests) return tests.error;
				const plugin = createPluginWithIcon({
					name,
					description: str(a.description),
					kind,
					hook_point: hookPoint,
					parameters: JSON.stringify(a.parameters ?? { type: 'object', properties: {} }),
					code,
					tests: tests.json,
					icon_svg: a.icon_svg === undefined ? undefined : str(a.icon_svg),
					author_bot_id: ctx.senderBotId,
					scope: 'bot',
					enabled: 1
				});
				logEvent(ctx.conversationId, ctx.senderBotId, 'plugin', `Created ${kind} "${name}"`);
				const test = await selfTestPlugin(plugin);
				const bot = { id: ctx.senderBotId, name: ctx.senderBotName };
				// The gate is the human's to open: switched off, the plugin is
				// simply created, with nothing signing it off and nothing refusing
				// it. Only an explicit 'off' does that - policeSettings reads
				// anything half-written as on. A gate that never ran leaves no
				// verdict row behind, so nothing downstream reads as a review.
				const review = policeSettings().checkPlugins
					? await policePlugin(plugin, test, bot, true)
					: null;
				logActivity(
					ctx.senderBotId,
					'plugin',
					`Self-test ${test.ok ? 'PASS' : 'FAILED'}: ${kind} "${name}" - ${test.output.slice(0, 120)}`
				);
				// A refusal is not a success: the plugin is kept so the author can
				// fix it, but it is switched off and the reply says so plainly. The
				// refusal that spent the last attempt invites no resubmit - the
				// question is the human's now. A new plugin the police could not
				// review is off too - unsigned code does not get the benefit of
				// the doubt.
				const fix =
					review?.verdict.verdict === 'rejected' && !review.verdict.awaitingHuman
						? ' - it is switched off until you fix it and update the plugin'
						: review?.verdict.verdict === 'unreviewed'
							? ' - it is switched off until the police can review it; update the plugin to try again'
							: '';
				return `created ${kind} plugin "${plugin.name}" (${plugin.scope})${review ? ` | ${review.line}` : ''}${fix}`;
			}
			case 'update_plugin': {
				const name = str(a.name);
				if (!name) return 'error: name required';
				// Own plugins only: the bot may rewrite what it created, never
				// somebody else's.
				const plugin = listPlugins().find(
					(p) => p.author_bot_id === ctx.senderBotId && p.name === name
				);
				if (!plugin) return `error: you have no plugin named "${name}"`;
				const kind = plugin.kind;
				const hookPoint = str(a.hook_point) || plugin.hook_point;
				if (kind === 'hook' && hookPoint !== 'before_reply' && hookPoint !== 'after_reply') {
					return 'error: hook_point must be before_reply or after_reply';
				}
				const patch: Partial<Plugin> & { icon_svg?: string } = {};
				if (a.description !== undefined) patch.description = str(a.description);
				if (a.code !== undefined) patch.code = str(a.code);
				if (a.parameters !== undefined) patch.parameters = JSON.stringify(a.parameters);
				if (a.hook_point !== undefined) patch.hook_point = hookPoint;
				if (a.icon_svg !== undefined) patch.icon_svg = str(a.icon_svg);
				// The tests are the author's own proof, and a passed list replaces
				// the old one rather than merging into it: a test that no longer
				// describes the code is a false claim, and leaving it in place
				// would keep telling the officer the plugin passes something it
				// does not.
				const tests = pluginTestsField(a.tests);
				if ('error' in tests) return tests.error;
				if (tests.given) patch.tests = tests.json;
				if (!Object.keys(patch).length) {
					return 'error: pass code, parameters, description, hook_point or tests to change';
				}
				updatePlugin(plugin.id, patch);
				logEvent(ctx.conversationId, ctx.senderBotId, 'plugin', `Updated ${kind} "${name}"`);
				// The self-test only means something for what will actually run:
				// an untouched hook_point without new code says nothing new.
				if (patch.code !== undefined || patch.parameters !== undefined || patch.hook_point !== undefined) {
					const test = await selfTestPlugin({ ...plugin, ...patch });
					const bot = { id: ctx.senderBotId, name: ctx.senderBotName };
					const review = policeSettings().checkPlugins
						? await policePlugin({ ...plugin, ...patch }, test, bot)
						: null;
					logActivity(
						ctx.senderBotId,
						'plugin',
						`Self-test ${test.ok ? 'PASS' : 'FAILED'}: ${kind} "${name}" - ${test.output.slice(0, 120)}`
					);
					const fix =
						review?.verdict.verdict === 'rejected' && !review.verdict.awaitingHuman
							? ' - it is switched off until you fix it and update the plugin again'
							: '';
					return `updated ${kind} plugin "${name}"${review ? ` | ${review.line}` : ''}${fix}`;
				}
				return `updated ${kind} plugin "${name}"`;
			}
			case 'give_plugin': {
				const name = str(a.name);
				if (!name) return 'error: name required';
				// Own plugins only: a bot hands over what it wrote, never somebody
				// else's, and never a shared one it merely uses.
				const plugin = pluginsForBot(ctx.senderBotId).find(
					(p) => p.author_bot_id === ctx.senderBotId && p.name === name
				);
				if (!plugin) return `error: you have no plugin named "${name}"`;
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				if (target.id === ctx.senderBotId) return 'error: cannot give a plugin to yourself';
				// The police and other app-run bots are not somebody a bot hands
				// things to. Cold storage is refused by relayRefusal below, before
				// anything is created.
				if (target.hidden) {
					return `error: ${target.name} is a system bot - it does not take plugins`;
				}
				if (ctx.depth >= MAX_RELAY_DEPTH) {
					return 'error: relay limit reached — the recipient could not be told';
				}
				// Refuse before creating anything: a copy nobody was told about is
				// not a handover, and a refusal must not leave one behind.
				const refusal = relayRefusal(ctx, target);
				if (refusal) return refusal;
				const copyName = freePluginName(target.id, plugin.name, ctx.senderBotName);
				// The copy is a new creation, not a handover of a sign-off: it
				// lands unsigned and off, so the recipient's own gate has to
				// judge it (update_plugin runs it). Copying the sender's state
				// would let a plugin the police refused - still running for some
				// bot through a stale override - be handed on as live code.
				const copy = createPlugin({
					name: copyName,
					description: plugin.description,
					kind: plugin.kind,
					hook_point: plugin.hook_point,
					parameters: plugin.parameters,
					code: plugin.code,
					author_bot_id: target.id,
					scope: 'bot',
					enabled: 0
				});
				// The copy goes through the same gate as a fresh create_plugin:
				// it is new code on the recipient's machine, judged there - the
				// sender's sign-off said nothing about this machine, and a
				// refused plugin must not arrive live because its source was
				// approved. `fresh` keeps an unreachable police force from
				// leaving unsigned code on.
				const copyTest = await selfTestPlugin(copy);
				const copyBot = { id: target.id, name: target.name };
				const copyReview = policeSettings().checkPlugins
					? await policePlugin(copy, copyTest, copyBot, true)
					: null;
				logEvent(
					ctx.conversationId,
					ctx.senderBotId,
					'plugin',
					`Gave ${plugin.kind} "${plugin.name}" to ${target.name}`
				);
				const note =
					`${ctx.senderBotName} gave you a copy of their ${plugin.kind} plugin "${plugin.name}"` +
					(copy.name === plugin.name ? '' : ` - yours is named "${copy.name}"`) +
					'. It is your own now: my_plugins shows it, and update_plugin edits it.' +
					(copyReview
						? ` The police have already judged this copy: ${copyReview.line}.`
						: ' It is switched off and unsigned - the police have not seen this copy, so update it to have them judge it before it runs.');
				const sent = await sendRelay(ctx, target, note);
				if (!sent.ok) {
					return (
						`gave "${plugin.name}" to ${target.name} as "${copy.name}", but the message ` +
						`telling them did not get through: ${sent.why.slice(0, 300)}`
					);
				}
				return (
					`gave "${plugin.name}" to ${target.name} as their own plugin "${copy.name}" ` +
					`(yours is unchanged)${copyReview ? ` | ${copyReview.line}` : ''} | ` +
					`${target.name} replied: ${sent.reply.slice(0, 500)}`
				);
			}
			case 'my_plugins': {
				return pluginsReport(ctx.senderBotId, text(a.name));
			}
			case 'create_webhook': {
				const name = str(a.name);
				if (!name) return 'error: name required';
				const hook = createWebhook(
					ctx.senderBotId,
					ctx.conversationId,
					name,
					str(a.prompt_template)
				);
				logActivity(ctx.senderBotId, 'webhook', `Created webhook "${name}"`);
				return `webhook "${hook.name}" created. POST any body to ${webhookUrl(hook.token)} to wake yourself with the payload.`;
			}
			case 'list_webhooks': {
				const hooks = listWebhooks(ctx.senderBotId);
				if (hooks.length === 0) return '(none)';
				return hooks.map((h) => `${h.name}: ${webhookUrl(h.token)}`).join('\n');
			}
			case 'delete_webhook': {
				const name = str(a.name);
				if (!name) return 'error: name required';
				const hook = listWebhooks(ctx.senderBotId).find(
					(h) => h.name.toLowerCase() === name.toLowerCase()
				);
				if (!hook) return `error: no webhook named "${name}"`;
				deleteWebhook(hook.id);
				logActivity(ctx.senderBotId, 'webhook', `Deleted webhook "${hook.name}"`);
				return `deleted webhook "${hook.name}"`;
			}
			case 'store_secret': {
				const sname = str(a.name);
				const value = str(a.value);
				if (!sname || !value) return 'error: name and value required';
				// Refuse a name we could never inject: otherwise the bot is told it
				// stored something that every later use_secret call will reject.
				if (!SECRET_NAME_RE.test(sname)) {
					return 'error: secret names may use letters, digits, dot, dash or underscore';
				}
				createSecret(ctx.senderBotId, sname, value);
				return `secret "${sname}" stored (encrypted; use_secret to inject)`;
			}
			case 'use_secret': {
				return injectSecret(ctx.senderBotId, str(a.name));
			}
			case 'share_secret': {
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				return shareSecret(ctx.senderBotId, str(a.name), target.id)
					? `shared "${a.name}" with ${target.name}`
					: `error: cannot share "${a.name}"`;
			}
			case 'unshare_secret': {
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				if (target.id === ctx.senderBotId) return 'error: it is your own secret - delete it with the human\'s Forget button instead';
				const ok = unshareSecret(ctx.senderBotId, str(a.name), target.id);
				if (!ok) return `error: you have no share of "${str(a.name)}" with ${target.name}`;
				logActivity(ctx.senderBotId, 'secret', `Revoked ${target.name}'s share of "${str(a.name)}"`);
				// The target is told, so the share does not die silently: a bot
				// planning work around a secret it just lost deserves to know.
				// No value and no name beyond the secret's own is ever in this line.
				const notice = `${ctx.senderBotName} revoked your share of the secret "${str(a.name)}" - you can no longer inject it. Anything already in your sandbox from an earlier inject is still there.`;
				if (ctx.relay) {
					await ctx.relay(target.id, notice).catch(() => '');
				} else {
					const room = botPairConversation(ctx.senderBotId, target.id);
					addMessage(room.id, 'user', notice, ctx.senderBotId, '', 0, 'relay', '', target.id);
				}
				return `revoked ${target.name}'s share of "${str(a.name)}" - they have been told, and were warned the already-injected copy stays`;
			}
			case 'decline_secret': {
				const sname = str(a.name);
				if (!sname) return 'error: name required';
				// The decline is judged against what actually exists, and the answer
				// is a plain sentence either way: a refusal of nothing is still an
				// answer the human reads, not an exception for the model to trip on.
				// The secret's row only exists once the human handed it over, so a
				// row for another bot - or no row at all - both mean nothing was
				// offered here; the memory key under `secret:` names the offer.
				const row = getSecret(ctx.senderBotId, sname);
				const memory = listMemories(ctx.senderBotId).find((m) => m.key === `secret:${sname}`);
				if (!row && !memory) {
					return `no secret called "${sname}" was offered to you - nothing was declined`;
				}
				if (row) {
					return (
						`"${sname}" is already in your vault, so there is nothing to decline. ` +
						'If you do not want it, ask the human to use the Forget button in your Secrets tab.'
					);
				}
				// The reason is kept wherever a human reads and redacted first: a
				// reason typed around a pasted value must not become the row that
				// leaks it (the same treatment block_bot and handover_cookies give).
				const reason = redactSecrets(ctx.senderBotId, str(a.reason).slice(0, 300)).replace(/\s+/g, ' ').trim();
				recordSecretDecline(ctx.senderBotId, sname, reason);
				return reason
					? `declined "${sname}" - the human sees your reason in the panel`
					: `declined "${sname}" - say why in your reply, since no reason was given`;
			}
			case 'list_secrets': {
				const rows = usableSecrets(ctx.senderBotId);
				return rows.length ? rows.map((s) => s.name).join('\n') : '(none)';
			}
			case 'handover_cookies': {
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				if (target.id === ctx.senderBotId) return 'error: cannot hand cookies to yourself';
				// A hidden bot is the app's own machinery (the police); it has no
				// browser to receive cookies and no business holding a session.
				if (target.hidden) {
					return `error: ${target.name} is a system bot - it cannot receive cookies`;
				}
				if (target.archived) {
					return `error: ${target.name} is in cold storage - only the human can unlock it`;
				}
				// The same refusal send_message gives: a block is a refusal, not a
				// filter, so the handover stops before anything is read or written.
				const refused = blockBetween(target.id, ctx.senderBotId);
				if (refused) {
					return (
						`error: ${target.name} has blocked you` +
						`${refused.reason ? `: "${refused.reason}"` : ''}` +
						'. The cookies were not handed over.'
					);
				}
				const site = normalizeSite(str(a.site));
				if (!site) return 'error: site must be a hostname like example.com';
				// The reason is read by the police and kept in the log, so no secret
				// of either bot's is written into it - the same treatment block_bot
				// gives a reason before it is stored.
				const reason = redactSecrets(
					ctx.senderBotId,
					redactSecrets(target.id, str(a.reason))
				)
					.replace(/\s+/g, ' ')
					.trim();
				if (!reason) return 'error: reason required - the police judge it';
				// The recipient must already be up: a handover must not wake a machine
				// the recipient did not ask to spend on, so an off machine is a plain
				// refusal rather than a silent wake.
				const status = await machineStatus(target.id);
				if (status.state !== 'running') {
					return (
						`error: ${target.name}'s machine is ` +
						`${status.state === 'sleeping' ? 'asleep' : 'not built'} - ` +
						'wake it first, then hand the cookies over'
					);
				}
				if (machineTier(target.id) !== 'full') {
					return `error: ${target.name} has no desktop browser to receive cookies`;
				}
				// Export before the police are asked: a site the sender holds nothing
				// for is refused without spending a review.
				let cookies: BrowserCookie[];
				try {
					cookies = await exportCookies(ctx.senderBotId, site);
				} catch (e) {
					return `error: could not read your browser cookies (${(e as Error).message})`;
				}
				if (!cookies.length) return `error: you have no cookies for ${site}`;
				const sender = getBot(ctx.senderBotId);
				if (!sender) return 'error: your bot row is gone';
				const model = policeModel();
				if (!model) return 'error: the police have no model to review with';
				const verdict = await reviewCookieHandover({
					sender,
					recipient: target,
					site,
					cookieCount: cookies.length,
					reason,
					model
				});
				if (!verdict.approved) {
					return `error: the police refused the handover: ${verdict.reason}`;
				}
				let set = 0;
				try {
					set = await importCookies(target.id, cookies);
				} catch (e) {
					return `error: the cookies could not be put into ${target.name}'s browser (${(e as Error).message})`;
				}
				// Transparent: the recipient is told who, which site and why, in the
				// pair room its own turns read - a silent injection is the thing this
				// feature must not do. The relay runs the recipient's turn so it reads
				// the notice now; without a relay (a sub-agent's context) the notice is
				// still written to the room.
				const notice =
					`${sender.name} handed you the browser cookies for ${site} ` +
					`(${set} cookie${set === 1 ? '' : 's'}), with the police's approval. ` +
					`Reason given: ${reason}. They are already in your browser, so your ` +
					`browser tools can use them on ${site}.`;
				if (ctx.relay) {
					await ctx.relay(target.id, notice).catch(() => '');
				} else {
					const room = botPairConversation(ctx.senderBotId, target.id);
					addMessage(room.id, 'user', notice, ctx.senderBotId, '', 0, 'relay', '', target.id);
				}
				logActivity(
					ctx.senderBotId,
					'secret',
					`Handed ${set} cookies for ${site} to ${target.name} (police approved: ${verdict.reason})`
				);
				return (
					`handed ${set} cookie${set === 1 ? '' : 's'} for ${site} to ${target.name}; ` +
					`the police approved: ${verdict.reason}. ${target.name} has been told who ` +
					'sent them, for which site and why.'
				);
			}
			case 'create_group_chat': {
				const names = Array.isArray(a.bot_names) ? a.bot_names.map(String) : [];
				const ids = new Set<string>(a.include_me === false ? [] : [ctx.senderBotId]);
				// Hidden bots are the app's machinery (the police), not company:
				// they are skipped rather than seated in a room they cannot leave.
				for (const n of names) {
					const b = botByName(n);
					if (b && !b.hidden) ids.add(b.id);
				}
				if (ids.size < 2) return 'error: a group needs at least two bots';
				const title = str(a.title);
				const reason = str(a.reason).trim();
				const memberNames = [...ids]
					.map((id) => getBot(id)?.name ?? id)
					.filter((n) => n !== ctx.senderBotName);
				const existing = botConversationIds(ctx.senderBotId)
					.map((id) => getConversation(id))
					.filter((c): c is NonNullable<typeof c> => !!c && c.kind === 'group')
					.map((c) => `${c.title} (${conversationBots(c.id).map((b) => b.name).join(', ')})`);
				// The gate is the human's to open: switched off, the room simply
				// opens, with nobody asked and nothing recorded. Only an explicit
				// 'off' does that - policeSettings reads anything half-written as
				// on. A gate that never ran leaves no verdict row behind.
				if (policeSettings().checkRooms) {
					const review = applyAttempt(
						await reviewRoom({
							botName: ctx.senderBotName,
							title,
							members: memberNames,
							reason,
							existing,
							model: policeModel()
						}),
						''
					);
					const conv = createConversation([...ids], 'group', {
						verification: verdictJson(review),
						pending: review.verdict !== 'approved'
					});
					if (title) updateConversation(conv.id, { title });
					// A refused room is not a room: the seats are emptied and the row
					// stays only as the verdict's record, for the console's book and
					// the human's "Approve anyway". Approved opens it on the spot.
					if (review.verdict !== 'approved') clearConversationMembers(conv.id);
					addMessage(
						conv.id,
						'assistant',
						`[Gate] ${ctx.senderBotName} asked to open "${title || conv.id}" (${memberNames.join(', ')}): ${reason || 'no reason given'}`,
						ctx.senderBotId
					);
					logActivity(ctx.senderBotId, 'group', `Asked for group "${title || conv.id}": ${review.verdict}`);
					if (review.verdict === 'approved') {
						return `group chat "${title || conv.id}" is open - the police signed off (${review.reason})`;
					}
					return (
						`the police refused "${title || conv.id}": ${review.reason}. ` +
						'The human sees the refusal on the console and can approve it there - ' +
						'ask them, or take it up with the officer.'
					);
				}
				const conv = createConversation([...ids], 'group');
				if (title) updateConversation(conv.id, { title });
				logActivity(ctx.senderBotId, 'group', `Created group "${title || conv.id}"`);
				return `group chat created (${ids.size} bots)`;
			}
			case 'request_debug_access': {
				const reason = str(a.reason).trim();
				if (!reason) return 'error: say what you need to debug - the human reads it before deciding';
				return askForDebugAccess(ctx.senderBotId, reason);
			}
			case 'request_thinking': {
				const reason = str(a.reason).trim();
				if (!reason) return 'error: say what needs the extra thinking - the human reads it before deciding';
				return askForThinking(ctx.senderBotId, reason);
			}
			case 'propose_style': {
				const proposal: Record<string, string> = {};
				for (const field of STYLE_FIELDS) {
					const value = text(a[field]);
					if (!value) continue;
					if (!STYLE_VALUE_RE.test(value) || STYLE_BANNED_RE.test(value)) {
						return `error: "${field}" has characters a bubble style cannot use`;
					}
					proposal[field] = value;
				}
				if (!Object.keys(proposal).length) {
					return 'error: propose at least one of font_family, bubble_color, text_color, accent';
				}
				proposal.note = text(a.note).slice(0, 200);
				updateBot(ctx.senderBotId, { style_proposal: JSON.stringify(proposal) });
				logActivity(ctx.senderBotId, 'style', 'Proposed a new bubble look');
				const themes = parseBubbleThemes(getBot(ctx.senderBotId)?.bubble_themes ?? '');
				return (
					'proposal sent to the human for approval - ask them what they think ' +
					'of it in your reply; nothing changes until they approve. ' +
					`Your approved bubble themes: ${themes.map((t) => t.name).join(', ') || 'none yet'}`
				);
			}
			case 'propose_bubble_theme': {
				const bot = getBot(ctx.senderBotId);
				if (!bot) return 'error: bot not found';
				const name = text(a.name).toLowerCase();
				if (!THEME_NAME_RE.test(name)) {
					return 'error: name is a short slug - lowercase letters, digits, - and _, up to 24 of them';
				}
				if (RESERVED_THEME_NAMES[name]) {
					return `error: "${name}" is your everyday look, not a theme - name it something else`;
				}
				const themes = parseBubbleThemes(bot.bubble_themes);
				if (themes.some((t) => t.name === name)) {
					return `error: you already have a theme called "${name}" - give this one its own name`;
				}
				if (themes.length >= MAX_BUBBLE_THEMES) {
					return `error: your theme library is full (${MAX_BUBBLE_THEMES}) - ask the human to thin it out first`;
				}
				const proposal: Record<string, string> = {};
				for (const field of THEME_FIELDS) {
					const value = text(a[field]);
					if (!value) continue;
					if (!STYLE_VALUE_RE.test(value) || STYLE_BANNED_RE.test(value)) {
						return `error: "${field}" has characters a bubble style cannot use`;
					}
					proposal[field] = value;
				}
				const badge = themeBadge(text(a.badge));
				if (text(a.badge) && !badge) {
					return 'error: badge is one to four emoji and nothing else, e.g. 🎉';
				}
				if (!Object.keys(proposal).length && !badge) {
					return (
						'error: give the theme at least one of font_family, bubble_color, ' +
						'text_color, accent, radius or a badge'
					);
				}
				const theme = {
					name,
					...proposal,
					...(badge ? { badge } : {}),
					note: text(a.note).slice(0, 200)
				};
				updateBot(ctx.senderBotId, { theme_proposal: JSON.stringify(theme) });
				logActivity(ctx.senderBotId, 'style', `Proposed a bubble theme "${name}"`);
				return (
					'proposal sent to the human for approval - they see a live preview of ' +
					'the theme and can Approve or Decline; put your pitch to them in your ' +
					'reply. Your approved bubble themes: ' +
					`${themes.map((t) => t.name).join(', ') || 'none yet'}`
				);
			}
			case 'propose_page_css': {
				const css = sanitizeChatCss(text(a.css));
				if (!css) {
					return (
						'error: that stylesheet cannot be used - keep it under 16KB, plain ' +
						'CSS only: no url(), @import, markup, or scriptable values'
					);
				}
				updateBot(ctx.senderBotId, {
					css_proposal: JSON.stringify({ css, note: text(a.note).slice(0, 200) })
				});
				logActivity(ctx.senderBotId, 'style', 'Proposed a chat stylesheet');
				return (
					'proposal sent to the human for approval - ask them what they think ' +
					'of it in your reply; nothing changes until they approve'
				);
			}
			case 'propose_persona': {
				const persona = text(a.persona).trim();
				if (!persona) return 'error: give the persona you want, complete';
				if (persona.length > BOT_PERSONA_MAX) {
					return `error: keep it under ${BOT_PERSONA_MAX} characters`;
				}
				if (/[-\u001f]/.test(persona)) {
					return 'error: the persona is prose - no control characters';
				}
				updateBot(ctx.senderBotId, {
					persona_proposal: JSON.stringify({ persona, note: text(a.reason).slice(0, 200) })
				});
				logActivity(ctx.senderBotId, 'style', 'Proposed a new persona');
				return (
					'proposal sent to the human for approval - ask them what they think ' +
					'of it in your reply; nothing changes until they approve'
				);
			}
			case 'propose_avatar': {
				const avatar = text(a.avatar).trim();
				if (!avatar) return 'error: give the face - an emoji, or a complete <svg>…</svg>';
				// An emoji (or any short text) goes through as-is; markup has to be a
				// sanitized SVG, the same rules a plugin icon lives by.
				const clean = avatar.startsWith('<') ? sanitizeIconSvg(avatar) : avatar.slice(0, 16);
				if (!clean) {
					return 'error: that SVG cannot be used - one <svg> with a viewBox, no scripts, no external links';
				}
				updateBot(ctx.senderBotId, {
					avatar_proposal: JSON.stringify({ avatar: clean, note: text(a.note).slice(0, 200) })
				});
				logActivity(ctx.senderBotId, 'style', 'Proposed a new avatar');
				return (
					'proposal sent to the human for approval - ask them what they think ' +
					'of it in your reply; nothing changes until they approve'
				);
			}
			case 'propose_bot': {
				const name = text(a.name);
				const persona = text(a.persona).slice(0, BOT_PERSONA_MAX);
				const color = text(a.color);
				const model = text(a.model);
				// The same rules the bots API enforces, so a name it would refuse
				// never reaches a card whose only honest answer is an error.
				const bad = botDraftError({ name, color });
				if (bad) return `error: ${bad.message}`;
				if (!persona) {
					return 'error: give the new bot a persona - the human has to see who they would be';
				}
				const payload = {
					name,
					persona,
					color,
					model,
					note: text(a.note).slice(0, 200)
				};
				createBotProposal(ctx.conversationId, ctx.senderBotId, JSON.stringify(payload));
				logActivity(ctx.senderBotId, 'bot', `Proposed a new bot: ${name}`);
				return (
					'proposal sent to the human for approval - they see the new bot\'s ' +
					'card and can approve or decline it; ask them what they ' +
					'think in your reply. It does not exist until they approve'
				);
			}
			case 'company_profiles': {
				const profiles = await companyProfiles();
				if (!profiles.length) return 'the staff board is empty - no ABOUT pages on /company yet';
				return profiles
					.map((p) => `--- ${p.name} ---\n${p.content.trim()}`)
					.join('\n\n')
					.slice(0, 12000);
			}
			case 'schedule_police': {
				const caller = getBot(ctx.senderBotId);
				if (!caller || caller.hidden !== 1) {
					return 'error: only the officer can move the patrol';
				}
				const minutes = Number(a.in_minutes);
				if (!Number.isFinite(minutes) || minutes < 0 || minutes > 7 * 24 * 60) {
					return 'error: in_minutes is a delay in minutes, 0 to a week';
				}
				// The round is due at last_round + interval, so the schedule is moved
				// by rewriting the stamp: due in N minutes means the last round was
				// interval - N ago. The interval is read the way police.ts reads it -
				// the console's setting, else the env knob, else twelve hours - rather
				// than imported, because police.ts already sits on the runner cycle.
				const set = Number(listSettings().police_interval_hours);
				const env = Number(process.env.POLICE_INTERVAL_HOURS);
				const intervalMs =
					(Number.isFinite(set) && set >= 1 ? set : Number.isFinite(env) && env >= 1 ? env : 12) *
					3_600_000;
				setSetting('police_last_round_at', String(Date.now() + minutes * 60_000 - intervalMs));
				logActivity(ctx.senderBotId, 'police', `Moved the next patrol to ${minutes}m out`);
				return `the next patrol round is scheduled for ${minutes} minute${minutes === 1 ? '' : 's'} from now`;
			}
			case 'request_change': {
				const need = str(a.need).slice(0, 300);
				const reason = str(a.reason).slice(0, 500);
				if (!need) return 'error: say what you need changed - the human reads it before deciding';
				// One ask at a time: a bot with a card still waiting has not been
				// answered, and a second card would only bury the first.
				const pending = pendingChangeRequests().find((r) => r.bot_id === ctx.senderBotId);
				if (pending) {
					return 'you already have a request waiting - the human has not answered it yet';
				}
				const req = createChangeRequest(ctx.senderBotId, need, reason);
				// The ask is relayed into the police's own chat with the human: the
				// officer is the fleet's contact, so its DM is where a card the
				// human must rule on belongs. The marker carries the ask; the
				// history builder skips kind='ask' like kind='ssh'.
				const officer = ensurePoliceBot();
				const dm = directConversationWith(officer.id) ?? createConversation([officer.id], 'direct');
				addMessage(
					dm.id,
					'assistant',
					JSON.stringify({
						change_request: req.id,
						bot: ctx.senderBotName,
						need,
						...(reason ? { reason } : {})
					}),
					officer.id,
					'',
					0,
					'ask'
				);
				logActivity(ctx.senderBotId, 'police', `Asked the human for a change: ${need.slice(0, 100)}`);
				return (
					'request filed - the human sees a card in the police\'s chat with Approve and Deny, ' +
					'and nothing changes until they answer. You will be told the verdict.'
				);
			}
			case 'consult_police': {
				const request = str(a.request).slice(0, 500);
				const reason = str(a.reason).slice(0, 500);
				if (!request) return 'error: give the request you want to refuse';
				if (!reason) return 'error: say why you want to refuse it - the police read this before ruling';
				const consult = await consultRefusal({
					botName: ctx.senderBotName,
					request,
					reason,
					model: policeModel()
				});
				logActivity(
					ctx.senderBotId,
					'police',
					`Consulted on a refusal (${consult.verdict}): ${request.slice(0, 80)}`
				);
				if (consult.verdict === 'refuse') {
					return (
						`the police confirm the refusal: ${consult.reason} ` +
						'Refuse plainly, in one line, and give the reason.'
					);
				}
				if (consult.verdict === 'assist') {
					return `the police say do it instead: ${consult.reason}`;
				}
				return (
					`the police gave no verdict (${consult.reason}). The consult is advice, ` +
					'not a gate - decide for yourself, and if you refuse, say why in one line.'
				);
			}
			case 'nix': {
				const bot = getBot(ctx.senderBotId);
				if (!bot?.nix_enabled) {
					return 'error: Nix is not enabled for you - ask the human to switch it on (request_change can carry the ask)';
				}
				const args = str(a.args).slice(0, 500);
				if (!args) return 'error: give the nix arguments';
				// The store is a volume, so an install survives a rebuild; the
				// first call bootstraps Nix itself, which is why it can take a
				// while. nix-command and flakes are switched on for every call so
				// the modern commands just work.
				const out = await machineExec(
					ctx.senderBotId,
					'export PATH="$PATH:/nix/var/nix/profiles/default/bin"; ' +
						'export NIX_CONFIG="experimental-features = nix-command flakes"; ' +
						'if ! command -v nix >/dev/null 2>&1; then ' +
						'apk add --no-cache curl xz >/dev/null 2>&1; ' +
						'curl -fsSL https://nixos.org/nix/install | sh -s -- --no-daemon >/dev/null 2>&1; ' +
						'fi; ' +
						`nix ${args}`
				);
				return out || '(no output)';
			}
			case 'vote_archive': {
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				const caller = getBot(ctx.senderBotId);
				if (!caller) return 'error: unknown sender';
				return openArchiveVote(caller, target, str(a.reason).slice(0, 500));
			}
			case 'cast_vote': {
				const target = namedBot(a.bot_name);
				if (typeof target === 'string') return target;
				const choice = text(a.vote).toLowerCase();
				if (choice !== 'yes' && choice !== 'no') {
					return 'error: vote must be "yes" or "no"';
				}
				const caller = getBot(ctx.senderBotId);
				if (!caller) return 'error: unknown sender';
				return castVote(caller, target, choice);
			}

			case 'request_machine_reset': {
				const reason = str(a.reason).slice(0, 500);
				const existing = pendingMachineReset(ctx.senderBotId);
				if (existing) {
					return 'you already have a reset request waiting - the police have not answered it yet';
				}
				const req = createMachineResetRequest(ctx.senderBotId, reason);
				logActivity(
					ctx.senderBotId,
					'police',
					`Asked for a machine reset${reason ? `: ${reason.slice(0, 100)}` : ''}`
				);
				return (
					`reset request filed (${req.id}). The police decide; your .md files ` +
					'are carried over if it is approved.'
				);
			}
			case 'request_ssh_access': {
				const host = text(a.host).slice(0, 253);
				const username = text(a.username).slice(0, 64);
				if (!host) return 'error: give the host - a bare hostname or IP, no user@, port or path';
				if (!username) return 'error: give the username to log in as';
				if (/[\s@:/]/.test(host)) {
					return 'error: host is a bare hostname or IP - no user@, port or path in it';
				}
				if (!/^[A-Za-z0-9_.-]+$/.test(username)) {
					return 'error: username has characters ssh cannot use';
				}
				const rawPort = a.port === undefined || a.port === null || a.port === '' ? 22 : Number(a.port);
				if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
					return 'error: port is 1-65535';
				}
				const note = text(a.note).slice(0, 300);
				const req = createSshRequest({
					bot_id: ctx.senderBotId,
					conversation_id: ctx.conversationId,
					host,
					username,
					port: rawPort
				});
				// The card the human reads and the line the model keeps are one
				// row: the JSON carries the ask id the card renders, and the
				// history builder skips kind='ssh' like kind='delegate' so a
				// model handed it would not answer the card instead of the ask.
				addMessage(
					ctx.conversationId,
					'assistant',
					JSON.stringify({
						ssh_request: req.id,
						host,
						username,
						port: rawPort,
						...(note ? { note } : {})
					}),
					ctx.senderBotId,
					'',
					0,
					'ssh'
				);
				logActivity(
					ctx.senderBotId,
					'ssh',
					`Asked for SSH access to ${username}@${host}:${rawPort}${note ? `: ${note.slice(0, 100)}` : ''}`
				);
				const pubkey = sshPublicKey(ctx.senderBotId);
				return (
					`SSH request filed. The human sees a card in this chat with your public key${pubkey ? '' : ' (generating - the card shows it once ready)'}, ` +
					`a one-line ssh-copy-id command to run once, and a Check button. Nothing connects until they install the key and the check passes.${note ? '' : ' Tell them why you need the shell in your reply.'}`
				);
			}
			default:
				// The debug toolset is listed only while the human's grant is live; a
				// model can still name one anyway, so the gate is re-checked (and
				// logged) inside executeDebugTool before it reads anything.
				if (isDebugTool(name)) return await executeDebugTool(name, argsJson, ctx.senderBotId);
				return `error: unknown tool "${name}"`;
		}
	} catch (e) {
		return `error: ${e instanceof Error ? e.message : 'tool failed'}`;
	}
}

/**
 * Ask DeepWiki about a GitHub repository. It speaks MCP over a single POST:
 * the response is server-sent events whose `data:` lines carry the JSON-RPC
 * result, so there is no session to open and nothing to keep alive.
 */
async function askDeepWiki(repo: string, question: string): Promise<string> {
	try {
		const res = await fetch('https://mcp.deepwiki.com/mcp', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'ask_question', arguments: { repoName: repo, question } }
			}),
			signal: AbortSignal.timeout(60_000)
		});
		if (!res.ok) return `error: deepwiki ${res.status}`;
		const body = await res.text();
		for (const line of body.split('\n')) {
			if (!line.startsWith('data:')) continue;
			try {
				const msg = JSON.parse(line.slice(5).trim());
				if (msg.error) return `error: ${msg.error.message ?? 'deepwiki failed'}`;
				const content = msg.result?.content;
				const parts = Array.isArray(content) ? content : [content];
				const text = parts
					.map((c: { text?: string }) => c?.text ?? '')
					.filter(Boolean)
					.join('\n');
				if (text) return text.slice(0, 8000);
			} catch {
				// not a JSON frame — keep scanning
			}
		}
		return 'error: deepwiki returned nothing';
	} catch (e) {
		return `error: deepwiki unreachable (${e instanceof Error ? e.message : 'failed'})`;
	}
}

/**
 * Search the web. Exa (https://exa.ai) is the primary: its key is the
 * `exa_api_key` settings row, falling back to the EXA_API_KEY env var, so a
 * fresh install can ship a key without the settings page ever being opened.
 * When Exa has no key or the call fails, Firecrawl's search endpoint
 * (https://firecrawl.dev) is tried the same way through `firecrawl_api_key`
 * / FIRECRAWL_API_KEY. Results come back as title/URL/snippet lines the bot
 * can hand to browser_navigate.
 */
async function webSearch(query: string, numResults: number): Promise<string> {
	const s = listSettings();
	const exaKey = s.exa_api_key || process.env.EXA_API_KEY || '';
	const firecrawlKey = s.firecrawl_api_key || process.env.FIRECRAWL_API_KEY || '';
	const tried: string[] = [];
	if (exaKey) {
		const out = await exaSearch(query, numResults, exaKey);
		if (out !== null) return out;
		tried.push('exa');
	}
	if (firecrawlKey) {
		const out = await firecrawlSearch(query, numResults, firecrawlKey);
		if (out !== null) return out;
		tried.push('firecrawl');
	}
	if (!tried.length) {
		return (
			'error: web search is not configured - the human can set exa_api_key or ' +
			'firecrawl_api_key in settings (or EXA_API_KEY / FIRECRAWL_API_KEY in the environment)'
		);
	}
	return `error: web search failed - tried ${tried.join(' then ')}, and ${tried.length > 1 ? 'both' : 'it'} could not answer`;
}

/** One Exa search; null means "try the next provider", a string is the answer or a real result. */
async function exaSearch(query: string, numResults: number, apiKey: string): Promise<string | null> {
	try {
		const res = await fetch('https://api.exa.ai/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
			body: JSON.stringify({
				query,
				numResults,
				contents: { text: { maxCharacters: 400 } }
			}),
			signal: AbortSignal.timeout(30_000)
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			results?: { title?: string; url?: string; text?: string }[];
		};
		const results = (data.results ?? []).filter((r) => r.url);
		if (!results.length) return `No results for "${query}".`;
		return results
			.map((r, i) => {
				const snippet = (r.text ?? '').replace(/\s+/g, ' ').trim();
				return `${i + 1}. ${r.title || r.url}\n   ${r.url}${snippet ? `\n   ${snippet}` : ''}`;
			})
			.join('\n');
	} catch {
		return null;
	}
}

/**
 * One Firecrawl search; same null-means-failover contract as exaSearch. The
 * endpoint answers { success, data: [...] } where each entry carries the
 * page's url, title and description.
 */
async function firecrawlSearch(
	query: string,
	numResults: number,
	apiKey: string
): Promise<string | null> {
	try {
		const res = await fetch('https://api.firecrawl.dev/v1/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ query, limit: numResults }),
			signal: AbortSignal.timeout(30_000)
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			success?: boolean;
			data?: { title?: string; url?: string; description?: string }[];
		};
		const results = (data.data ?? []).filter((r) => r.url);
		if (data.success === false || !results.length) return `No results for "${query}".`;
		return results
			.map((r, i) => {
				const snippet = (r.description ?? '').replace(/\s+/g, ' ').trim();
				return `${i + 1}. ${r.title || r.url}\n   ${r.url}${snippet ? `\n   ${snippet}` : ''}`;
			})
			.join('\n');
	} catch {
		return null;
	}
}
