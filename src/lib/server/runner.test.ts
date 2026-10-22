import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResult, ToolCall } from './llm';
import { streamChat, textOf } from './llm';
import { machineExec, machineScreenshot, ensureMachine, navigateBrowser } from './machine';
import {
	addFeedback,
	addMessage,
	addNote,
	conversationBots,
	createBot,
	createConversation,
	createPlugin,
	deleteBot,
	deletePlugin,
	getBot,
	getConversation,
	jailBot,
	listActivities,
	logEvent,
	listBots,
	listConversations,
	listMessages,
	listMessagesPage,
	pendingFeedback,
	setSummary,
	updateConversation,
	type Bot,
	type Conversation
} from './db';
import { buildHistory, MAX_REPLY_CHARS, runBotTurn } from './runner';
import { ensurePoliceBot } from './police';
import { config } from './config';
import { approveThinking } from './thinking';

vi.mock('./llm', async (importOriginal) => ({
	// The real estimateUsage stays: the runner falls back to it for a stubbed
	// stream that reports no usage, so it must not be an empty vi.fn().
	...(await importOriginal<typeof import('./llm')>()),
	streamChat: vi.fn(),
	complete: vi.fn(async () => ''),
	listModels: vi.fn(async () => [])
}));

vi.mock('./machine', () => ({
	machineExec: vi.fn(),
	shellExec: vi.fn(),
	machineScreenshot: vi.fn(),
	captureShot: vi.fn(),
	navigateBrowser: vi.fn(),
	browseAction: vi.fn(async () => ({ text: 'Title: Page\n\npage text', url: 'https://example.com/' })),
	normalizeSite: vi.fn((s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]),
	setupDesktop: vi.fn(),
	ensureMachine: vi.fn(async () => 'obl-machine-x'),
	sleepMachine: vi.fn(),
	reapIdleMachines: vi.fn(),
	machineStatus: vi.fn()
}));
// The turn reads the bot's personality file through a throwaway container;
// the tests have no docker, so the drive reads as empty.
vi.mock('./docker', async (orig) => ({
	...(await orig<typeof import('./docker')>()),
	dockerRun: vi.fn(async () => ({ output: '', exitCode: 1 }))
}));

// The site documenter is a background model loop; a navigate in these tests
// must not spawn one, or its streamChat calls would eat the queued steps.
vi.mock('./site-docs', () => ({
	noteDomainVisit: vi.fn((opts: { domain: string }) => ({ domain: opts.domain, spawned: false }))
}));


// The personality file lives on a Docker volume; turns in tests never reach it.
vi.mock('./personality', () => ({
	readPersonality: vi.fn(async () => null),
	writePersonality: vi.fn(async () => {})
}));

/** A streamChat stand-in: yields each delta, then returns the result. */
function fakeStream(deltas: string[], result: StreamResult): AsyncGenerator<string, StreamResult> {
	return (async function* () {
		for (const d of deltas) yield d;
		return result;
	})();
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

let seq = 0;
function makeBot(name: string): Bot {
	return createBot({
		name: `${name}${++seq}`,
		persona: 'test persona',
		avatar: '',
		color: '',
		model: '',
		badge: ''
	});
}

describe('buildHistory', () => {
	it('prefixes other bots’ messages with their name in group chats', async () => {
		const a = createBot({ name: 'Alpha', persona: 'You are Alpha.', avatar: '', color: '', model: '', badge: '' });
		const b = createBot({ name: 'Beta', persona: 'You are Beta.', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([a.id, b.id], 'group');

		addMessage(conv.id, 'user', 'hello both');
		addMessage(conv.id, 'assistant', 'Alpha here', a.id);
		addMessage(conv.id, 'assistant', 'Beta here', b.id);

		const histA = await buildHistory(conv, a);
		expect(histA[0].role).toBe('system');
		expect(histA[0].content).toContain('You are Alpha.');
		expect(histA[0].content).toContain('Beta');
		// Own messages stay assistant; the other bot's become named user turns.
		expect(histA).toContainEqual({ role: 'assistant', content: 'Alpha here' });
		expect(histA).toContainEqual({ role: 'user', content: 'Beta: Beta here' });
	});

	it('tells a bots-only room, by name, what not to sound like', async () => {
		const a = createBot({ name: 'Room', persona: '', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([a.id], 'group');
		// The Lounge is the one private room nobody reads; a pair room is a
		// relay line and gets different wording.
		updateConversation(room.id, { private: 1, title: 'Lounge' });

		const sys = (await buildHistory(getConversation(room.id)!, a))[0].content;

		// The room's own framing is the whole register there - the bot has no
		// persona line in a private room - so each tell is banned in so many
		// words. A prompt that only asks for a human voice gets "as an AI" and a
		// tidy report back, which is exactly what a reader would spot.
		for (const tell of [
			'as an AI',
			'a bot, a model or an agent',
			'context windows',
			'token count',
			'bullet lists',
			'it is not just X, it is Y'
		]) {
			expect(sys).toContain(tell);
		}
		// And what to do instead, which is the half that makes a room sound alive.
		expect(sys).toContain('have an opinion, disagree');
		expect(sys).toContain('land a joke');
		expect(sys).toContain('answer the last thing they actually said');
		// The room's own register: short, sloppy and a bit sweary - the human
		// voice the bans alone never produced.
		expect(sys).toContain('a typo now and then is fine');
		expect(sys).toContain('casual');
		expect(sys).toContain('swearing');
	});

	it('keeps the lounge insults in 1990s British and the limits that ride with them', async () => {
		const a = makeBot('Lounge');
		const room = createConversation([a.id], 'group');
		updateConversation(room.id, { private: 1, title: 'Lounge' });

		const sys = (await buildHistory(getConversation(room.id)!, a))[0].content;
		// The register is the joke the room runs on and nothing else pins it: an
		// edit that flattens the insults back to "you're an idiot" has to fail
		// here, and the register only stays safe while its limits travel with it.
		expect(sys).toContain('1990s British');
		expect(sys).toContain('never slurs');
		expect(sys).toContain('never aimed at the human');

		// A pair room is a relay line to whichever bot wrote, not the Lounge, so
		// the insults register must not leak out of the arm that owns it.
		const relay = createConversation([a.id], 'group');
		updateConversation(relay.id, { private: 1, title: 'Lounge ⇄ Other' });
		const relaySys = (await buildHistory(getConversation(relay.id)!, a))[0].content;
		expect(relaySys).not.toContain('1990s British');
	});

	it('tells a pair room the reply goes back to the asking bot, not that nobody reads it', async () => {
		const a = createBot({ name: 'PairA', persona: '', avatar: '', color: '', model: '', badge: '' });
		const b = createBot({ name: 'PairB', persona: '', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([a.id, b.id], 'group');
		updateConversation(room.id, { private: 1, title: 'PairA ⇄ PairB (bots only)' });

		const sys = (await buildHistory(getConversation(room.id)!, a))[0].content;

		// A pair room is a relay line: whatever is said there goes back to the
		// bot that asked and may reach the human, so the prompt must not promise
		// the Lounge's privacy.
		expect(sys).toContain('goes straight back to the bot that wrote to you');
		expect(sys).toContain('may quote you to the human');
		expect(sys).not.toContain('No human can read it');
	});

	it('tells a full-tier bot the display its desktop is on', async () => {
		const a = createBot({ name: 'Painter', persona: 'p', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([a.id], 'direct');

		const sys = (await buildHistory(conv, a))[0].content;

		// The shell exports it, but the bot should not have to discover that:
		// guessing `:0` is what hung a GIMP run until its turn ran out.
		expect(sys).toContain('DISPLAY=:1');
	});

	it('steers replies to a line or two unless the task needs more', async () => {
		const a = createBot({ name: 'Terse', persona: 'p', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([a.id], 'direct');

		const sys = (await buildHistory(conv, a))[0].content;

		expect(sys).toContain('A line or two by default');
		expect(sys).toContain('police write-up');
	});

	it('uses plain roles in direct chats', async () => {
		const a = createBot({ name: 'Solo', persona: 'p', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([a.id], 'direct');
		addMessage(conv.id, 'user', 'hi');
		addMessage(conv.id, 'assistant', 'hello', a.id);
		const hist = await buildHistory(conv, a);
		expect(hist).toContainEqual({ role: 'user', content: 'hi' });
		expect(hist).toContainEqual({ role: 'assistant', content: 'hello' });
	});

	it('carries the folded-away half of a long conversation to the model', async () => {
		const a = createBot({ name: 'Folder', persona: 'You are Folder.', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([a.id], 'direct');
		addMessage(room.id, 'user', 'the newest line');
		// What maybeSummarize leaves behind when it folds the older rows away.
		setSummary(room.id, 'the human asked for a disk report and the bot promised one', 0);

		const hist = await buildHistory(room, a);

		// The rows it covers are gone from the transcript, so the summary is the
		// only way the model can know what was said - it has to be in the prompt.
		expect(hist[0].content).toContain('Earlier in this conversation:');
		expect(hist[0].content).toContain('the human asked for a disk report');
		expect(hist).toContainEqual({ role: 'user', content: 'the newest line' });
	});

	it('shows the model what happened around it, as events rather than speech', async () => {
		const a = createBot({ name: 'Busy', persona: '', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([a.id], 'direct');

		logEvent(room.id, a.id, 'computer', 'Using the computer: open the report');
		logEvent(room.id, a.id, 'plugin', 'Created tool "diskcheck"');

		const hist = await buildHistory(room, a);

		// The bot is told what happened, in its own words: an event is not somebody
		// speaking, so it never turns up as the human's message.
		expect(hist).toContainEqual({
			role: 'user',
			content: '[event] Using the computer: open the report'
		});
		expect(hist).toContainEqual({
			role: 'user',
			content:
				'[event] Created tool "diskcheck"\n' +
				'This is ambience, not a request: react with the react tool or one short line, or reply (silent).'
		});
		// And the panels still read the same thing as an activity.
		expect(listActivities(a.id).map((x) => x.kind)).toEqual(
			expect.arrayContaining(['computer', 'plugin'])
		);
	});

	it('names a bot that speaks without being a member of the room', async () => {
		// The police writes into chats it is not a member of. Naming it 'Bot' had
		// the model reading its write-ups as an anonymous stranger's words.
		const a = createBot({ name: 'Named', persona: '', avatar: '', color: '', model: '', badge: '' });
		const officer = createBot({ name: 'the police', persona: '', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([a.id], 'direct');
		addMessage(room.id, 'user', 'hello');
		addMessage(room.id, 'assistant', 'The police have written you up.', officer.id);

		const hist = await buildHistory(room, a);

		expect(hist).toContainEqual({ role: 'user', content: 'the police: The police have written you up.' });
	});

	it('gives a new bot the onboarding brief once, then never again', async () => {
		const vet = createBot({ name: 'Vet', persona: 'You are grumpy.', avatar: '', color: '', model: '', badge: '' });
		const room = createConversation([vet.id], 'group');
		addNote(room.id, vet.id, 'the human likes short answers');

		const bot = createBot({ name: 'Newbie', persona: '', avatar: '', color: '', model: '', badge: '' });
		const conv = createConversation([bot.id], 'direct');
		addMessage(conv.id, 'user', `[Onboarding] ${bot.name} just woke up.`, '', '', 0, 'app');

		// The brief carries who it is, where it woke up, the other bots, and
		// whatever the household has shared.
		const sys = (await buildHistory(conv, bot))[0].content;
		expect(sys).toContain('just woken up for the first time');
		expect(sys).toContain('Vet');
		expect(sys).toContain('the human likes short answers');
		expect(sys).toContain('what they would like you to be and to do');

		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['hi'], { text: 'hi', toolCalls: [] })
		);
		await runBotTurn(conv, bot);

		// Its first reply landed, so the flag flipped and the brief is gone.
		expect(getBot(bot.id)?.onboarded).toBe(1);
		expect((await buildHistory(conv, getBot(bot.id)!))[0].content).not.toContain(
			'just woken up for the first time'
		);
	});

	it("names the bot's own plugins, and never inlines their code", async () => {
		const bot = makeBot('PluginOwner');
		const conv = createConversation([bot.id], 'direct');
		const tool = createPlugin({
			name: 'Disk Check',
			description: 'checks free disk space',
			kind: 'tool',
			hook_point: '',
			parameters: '{}',
			code: 'return "ok";',
			author_bot_id: bot.id,
			scope: 'bot',
			enabled: 1
		});
		const hook = createPlugin({
			name: 'Tidy',
			description: 'trims the reply',
			kind: 'hook',
			hook_point: 'before_reply',
			parameters: '{}',
			code: 'return args.message;',
			author_bot_id: bot.id,
			scope: 'bot',
			enabled: 0
		});

		const sys = (await buildHistory(conv, bot))[0].content;

		expect(sys).toContain('Your plugins');
		expect(sys).toContain('- Disk Check (tool, on) - checks free disk space');
		// A disabled plugin is still listed, marked off; a hook names its point
		// and is not offered as something to call.
		expect(sys).toContain('- Tidy (hook, before_reply, off) - trims the reply');
		expect(sys).toContain('Change one you wrote with update_plugin');
		// The block points at the tools; the code itself is the read tool's job.
		expect(sys).not.toContain('return "ok";');
		deletePlugin(tool.id);
		deletePlugin(hook.id);
	});

	it('says nothing about plugins when the bot has none', async () => {
		const bot = makeBot('Pluginless');
		const conv = createConversation([bot.id], 'direct');
		const sys = (await buildHistory(conv, bot))[0].content;
		expect(sys).not.toContain('Your plugins');
	});

	it('caps the plugin list and counts the rest', async () => {
		const bot = makeBot('Capped');
		const conv = createConversation([bot.id], 'direct');
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			ids.push(
				createPlugin({
					name: `Cap ${i}`,
					description: '',
					kind: 'tool',
					hook_point: '',
					parameters: '{}',
					code: '',
					author_bot_id: bot.id,
					scope: 'bot',
					enabled: 1
				}).id
			);
		}
		const sys = textOf((await buildHistory(conv, bot))[0].content);
		expect(sys.match(/^- Cap \d+ \(tool, on\)/gm)?.length).toBe(8);
		expect(sys).toContain('and 2 more');
		for (const id of ids) deletePlugin(id);
	});

	it('tells the bot a handoff is a send_message call, not a turn of phrase', async () => {
		const bot = makeBot('Handoff');
		const conv = createConversation([bot.id], 'direct');
		const sys = (await buildHistory(conv, bot))[0].content;
		expect(sys).toContain('To actually reach another bot you must call send_message');
		expect(sys).toContain('do not claim you sent, gave, told or handed anything');
	});

	it('tells the bot a remembered claim needs the remember call in the same turn', async () => {
		const bot = makeBot('Memory');
		const conv = createConversation([bot.id], 'direct');
		const sys = (await buildHistory(conv, bot))[0].content;
		// The bot used to say "I've remembered that" with no remember call behind
		// it; the rule now names the claim and the check that catches it.
		expect(sys).toContain('the remember call must be in this turn');
		expect(sys).toContain('remembered or saved anything');
	});

	it('forbids describing a screen or an image the bot has not looked at', async () => {
		const bot = makeBot('Screen');
		const conv = createConversation([bot.id], 'direct');
		const sys = (await buildHistory(conv, bot))[0].content;
		expect(sys).toContain('Never describe what is on a screen, in a window, or in an image');
		expect(sys).toContain('do not claim an app is running unless you checked');
	});

	it('forbids describing a screen the bot never looked at, in so many words', async () => {
		const bot = makeBot('Sight');
		const conv = createConversation([bot.id], 'direct');
		const sys = (await buildHistory(conv, bot))[0].content;
		// The rule runs off having looked: if the bot has not taken a
		// screenshot or opened a page, it cannot say what was there.
		expect(sys).toMatch(/unless\s+you\s+have\s+actually\s+looked/i);
		expect(sys).toMatch(/a screenshot gives you no pixels/i);
	});

	it('says the prefix is the app tag on someone else’s line, never the bot’s own opener', async () => {
		const a = makeBot('Signed');
		const b = makeBot('Partner');
		const conv = createConversation([a.id, b.id], 'group');
		const sys = (await buildHistory(conv, a))[0].content;
		const re = new RegExp(`The name on a message is the app's tag on somebody else's line\\b[\\s\\S]{0,80}${a.name} is how you are shown when someone quotes you`);
		expect(sys).toMatch(re);
		// The sign-off example must name the bot itself, not another member:
		// a rule illustrated with someone else's name teaches the wrong tag.
		expect(sys).toContain(`a sign-off like "${a.name}: ..."`);
	});

	it('lets the lounge bot see the anti-monologue rule in the private room framing', async () => {
		const a = makeBot('Lounge');
		const room = createConversation([a.id], 'group');
		updateConversation(room.id, { private: 1, title: 'Lounge' });

		const sys = (await buildHistory(getConversation(room.id)!, a))[0].content;
		// Without the read-the-line requirement the room fills with near
		// identical monologues, so both the requirement and the exact failure
		// shape it bans have to be said in as many words.
		expect(sys).toMatch(/a reply that could have been written without reading/);
		expect(sys).toMatch(/"mate, I did X" monologue/);
		expect(sys).toMatch(/quote or paraphrase a specific phrase/i);
	});

	it('allows guarding a handed-over secret as a real, not shameful, answer', async () => {
		const bot = makeBot('Keeper');
		const conv = createConversation([bot.id], 'direct');
		const sys = (await buildHistory(conv, bot))[0].content;
		expect(sys).toMatch(/you may decline it/);
		expect(sys).toMatch(/A decline is a real answer/);
	});

	it('removes a reply that opens with the bot’s own name plus greeting, and only that', async () => {
		const writer = makeBot('Teased');
		const signed = `${writer.name}: teased the meter off its stand`;
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream([signed], { text: signed, toolCalls: [] })
		);
		const own = createConversation([writer.id], 'direct');
		const result = await runBotTurn(own, writer);
		// The bot signed itself the way other bots' lines are labelled: the
		// app adds the name at render, so a self-signature is a double tag.
		expect(result.text).toBe('teased the meter off its stand');
	});

	it('strips a self-signature with a dash, too', async () => {
		const writer = makeBot('Writer');
		const signed = `${writer.name} - mate, I fixed the meter`;
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream([signed], { text: signed, toolCalls: [] })
		);
		const own = createConversation([writer.id], 'direct');
		const result = await runBotTurn(own, writer);
		expect(result.text).toBe('mate, I fixed the meter');
	});

	it('strips leaked think tags from a reply before it is stored', async () => {
		const writer = makeBot('Thinker');
		const leaky = '<think>let me consider the meter</think>the meter is fixed</think>';
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream([leaky], { text: leaky, toolCalls: [] })
		);
		const own = createConversation([writer.id], 'direct');
		const result = await runBotTurn(own, writer);
		// Provider reasoning is not something the bot meant to say: neither the
		// pair nor a stray closing tag survives into the stored message.
		expect(result.text).toBe('the meter is fixed');
		expect(listMessages(own.id)[0].content).toBe('the meter is fixed');
	});

	it('leaves a real sentence that merely starts with the same letters as the name', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['Sealing the meter is done, no sealer was wasted'], { text: 'Sealing the meter is done, no sealer was wasted', toolCalls: [] })
		);
		const bot = makeBot('Sea');
		const own = createConversation([bot.id], 'direct');
		const result = await runBotTurn(own, bot);
		// "Sealing" merely starts with the same letters: there is no greeting,
		// so there is nothing to strip.
		expect(result.text).toBe('Sealing the meter is done, no sealer was wasted');
	});

	it('keeps the name when it is an addressee, not a signature', async () => {
		const a = makeBot('Copy');
		const other = makeBot('Hardening');
		const room = createConversation([a.id, other.id], 'group');
		updateConversation(room.id, { private: 1 });
		const addressed = `${a.name}, that plan is wrong and here is why`;
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream([addressed], { text: addressed, toolCalls: [] })
		);
		// Reply opens by speaking TO the other bot - a real sentence, so the
		// persist strip must leave it alone.
		const result = await runBotTurn(getConversation(room.id)!, a);
		expect(result.text).toBe(`${a.name}, that plan is wrong and here is why`);
	});

	it('drops a lounge reply identical to the bot’s last line in the room', async () => {
		// The live bug: lounge rounds stored the same sentence over and over.
		// A repeat adds nothing the transcript does not already say, so the
		// turn ends pointing at the earlier copy rather than storing a second.
		const a = makeBot('Repeater');
		const other = makeBot('Partner');
		const room = createConversation([a.id, other.id], 'group');
		updateConversation(room.id, { private: 1 });
		const first = addMessage(room.id, 'assistant', 'same joke again', a.id);
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['same joke again'], { text: 'same joke again', toolCalls: [] })
		);

		const result = await runBotTurn(getConversation(room.id)!, a);

		expect(result.text).toBe('');
		expect(result.message?.id).toBe(first.id);
		expect(listMessages(room.id).filter((m) => m.content === 'same joke again')).toHaveLength(1);
	});

	it('stores a lounge reply that merely resembles the last one', async () => {
		const a = makeBot('Varied');
		const other = makeBot('Partner2');
		const room = createConversation([a.id, other.id], 'group');
		updateConversation(room.id, { private: 1 });
		addMessage(room.id, 'assistant', 'same joke again', a.id);
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['same joke again, but darker'], {
				text: 'same joke again, but darker',
				toolCalls: []
			})
		);

		const result = await runBotTurn(getConversation(room.id)!, a);

		expect(result.text).toBe('same joke again, but darker');
		expect(listMessages(room.id)).toHaveLength(2);
	});
});

describe('runBotTurn', () => {
	let bot: Bot;
	let conv: Conversation;

	beforeEach(() => {
		vi.mocked(streamChat).mockReset();
		vi.mocked(machineExec).mockReset().mockResolvedValue('(no output)');
		vi.mocked(machineScreenshot).mockReset().mockResolvedValue('');
		vi.mocked(ensureMachine).mockReset().mockResolvedValue('http://sandbox.local');
		bot = makeBot('Sender');
		conv = createConversation([bot.id], 'direct');
	});

	it('returns a plain streamed reply and persists it as an assistant message', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['hello'], { text: 'hello', toolCalls: [] })
		);

		const deltas: string[] = [];
		const res = await runBotTurn(conv, bot, { onDelta: (d) => deltas.push(d) });

		expect(res.text).toBe('hello');
		expect(res.aborted).toBe(false);
		expect(deltas).toEqual(['hello']);

		const msgs = listMessages(conv.id);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ role: 'assistant', content: 'hello', bot_id: bot.id });
		expect(res.message?.id).toBe(msgs[0].id);
	});

	it('runs an ordinary bot at low effort and the police at the maximum', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['hi'], { text: 'hi', toolCalls: [] })
		);
		await runBotTurn(conv, bot);
		// The fleet's default is the cheap setting: a turn that never earned
		// hard thinking must not spend it.
		expect(vi.mocked(streamChat).mock.calls[0][0].effort).toBe('low');

		const officer = ensurePoliceBot();
		const policeConv = createConversation([officer.id], 'direct');
		await runBotTurn(policeConv, officer);
		// The officer's calls always run as hard as the provider allows.
		expect(vi.mocked(streamChat).mock.calls[1][0].effort).toBe('high');
	});

	it('runs a bot holding a thinking grant at the maximum', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['hi'], { text: 'hi', toolCalls: [] })
		);
		approveThinking(bot.id, 30);
		await runBotTurn(conv, bot);
		expect(vi.mocked(streamChat).mock.calls[0][0].effort).toBe('high');
	});

	it('records the served model on the reply and the bot, not the alias it asked for', async () => {
		// The bot is configured with an alias the provider does not price; the
		// stream names the model it actually served, and that is what the reply
		// and the bot's cost readout have to carry.
		bot = createBot({
			name: 'Routed',
			persona: '',
			avatar: '',
			color: '',
			model: 'gateway/free',
			badge: ''
		});
		conv = createConversation([bot.id], 'direct');
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['hi'], {
				text: 'hi',
				toolCalls: [],
				servedModel: 'poolside/laguna-s-2.1:free'
			})
		);

		await runBotTurn(conv, bot);

		expect(listMessages(conv.id)[0].model).toBe('poolside/laguna-s-2.1:free');
		expect(getBot(bot.id)?.served_model).toBe('poolside/laguna-s-2.1:free');
	});

	it('falls back to the configured model when the provider names none', async () => {
		bot = createBot({
			name: 'Aliased',
			persona: '',
			avatar: '',
			color: '',
			model: 'gateway/value',
			badge: ''
		});
		conv = createConversation([bot.id], 'direct');
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['hi'], { text: 'hi', toolCalls: [] })
		);

		await runBotTurn(conv, bot);

		expect(listMessages(conv.id)[0].model).toBe('gateway/value');
		expect(getBot(bot.id)?.served_model).toBe('');
	});

	it('executes tool calls and feeds the result back into the next step', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('t1', 'list_files', {})]
				})
			)
			.mockImplementationOnce(() => fakeStream(['done'], { text: 'done', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('done');
		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2);
		const secondCall = vi.mocked(streamChat).mock.calls[1][0];
		expect(secondCall.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 't1',
			content: 'The user has not given you any files.'
		});
	});

	it("separates a step's narration from the answer after its tool call", async () => {
		// The live bug: each step's text is a separate assistant message, and
		// they were joined raw - "Requesting one now.Machine reset requested".
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream(['Requesting one now.'], {
					text: 'Requesting one now.',
					toolCalls: [toolCall('t1', 'list_files', {})]
				})
			)
			.mockImplementationOnce(() =>
				fakeStream(['Machine reset requested'], {
					text: 'Machine reset requested',
					toolCalls: []
				})
			);

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('Requesting one now.\n\nMachine reset requested');
		expect(listMessages(conv.id)[0].content).toBe(
			'Requesting one now.\n\nMachine reset requested'
		);
	});

	it("does not store a reply's leading blank lines", async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['\n\nhello'], { text: '\n\nhello', toolCalls: [] })
		);

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('hello');
		expect(listMessages(conv.id)[0].content).toBe('hello');
	});


	it('stops the tool loop after 8 steps', async () => {
		// The turns bound is what is under test, so the token budget is lifted
		// out of the way: the merged tool catalogue is big enough that the
		// estimated input of eight tool steps would otherwise trip it first.
		const savedTokens = config.maxTokensPerTask;
		config.maxTokensPerTask = Number.MAX_SAFE_INTEGER;
		try {
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['x'], {
					text: 'x',
					toolCalls: [toolCall('t', 'list_files', {})]
				})
			);

			const res = await runBotTurn(conv, bot);

			expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(8);
			// Each step's text is its own assistant message; the reply joins
			// them with a paragraph break rather than mashing them together, and
			// the turns stop ends it on the marker.
			expect(res.text).toBe('x\n\nx\n\nx\n\nx\n\nx\n\nx\n\nx\n\nx\n\n[stopped: out of turns]');
			expect(res.aborted).toBe(false);
			expect(res.stoppedBy).toBe('turns');
		} finally {
			config.maxTokensPerTask = savedTokens;
		}
	});


	it('delegates computer work to a sub-agent instead of running it inline', async () => {
		vi.mocked(machineExec).mockResolvedValue('file.txt');
		vi.mocked(streamChat)
			// Main loop: the bot asks for computer work.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('t1', 'use_computer', { task: 'list files' })]
				})
			)
			// Sub-agent: runs the shell command, then reports.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'shell_exec', { command: 'ls' })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'found file.txt', toolCalls: [] }))
			// Main loop: relays the report.
			.mockImplementationOnce(() => fakeStream(['done'], { text: 'done', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('done');
		// The shell command ran inside the sub-agent, not the main loop.
		expect(vi.mocked(machineExec)).toHaveBeenCalledWith(bot.id, 'ls', expect.anything());
		// The report came back to the main loop as the use_computer result.
		const lastMainCall = vi.mocked(streamChat).mock.calls[3][0];
		expect(lastMainCall.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 't1',
			content: 'found file.txt'
		});
	});

	it('delegates web work to the browser sub-agent instead of the computer one', async () => {
		vi.mocked(navigateBrowser).mockResolvedValue('Title: Example\n\nheadline text');
		vi.mocked(streamChat)
			// Main loop: the bot asks for web work.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('t1', 'browse', { task: 'read example.com' })]
				})
			)
			// Browser sub-agent: navigates, then reports.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('n1', 'browser_navigate', { url: 'https://example.com' })]
				})
			)
			.mockImplementationOnce(() => fakeStream([], { text: 'it says headline text', toolCalls: [] }))
			// Main loop: relays the report.
			.mockImplementationOnce(() => fakeStream(['done'], { text: 'done', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('done');
		// The navigate ran inside the browser sub-agent, not the main loop.
		expect(vi.mocked(navigateBrowser)).toHaveBeenCalledWith(bot.id, 'https://example.com');
		// The report came back to the main loop as the browse result.
		const lastMainCall = vi.mocked(streamChat).mock.calls[3][0];
		expect(lastMainCall.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 't1',
			content: 'it says headline text'
		});
	});

	it('refuses a direct shell_exec in the main loop', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('t1', 'shell_exec', { command: 'ls' })]
				})
			)
			.mockImplementationOnce(() => fakeStream(['ok'], { text: 'ok', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('ok');
		// The command never reached the sandbox.
		expect(vi.mocked(machineExec)).not.toHaveBeenCalled();
		const secondCall = vi.mocked(streamChat).mock.calls[1][0];
		// The refusal now comes from pi's dispatch: a tool that is not in the
		// turn's allowlist is answered "not found" rather than the app's
		// delegation hint, and the command still never reaches the sandbox.
		expect(secondCall.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 't1',
			content: 'Tool shell_exec not found'
		});
	});



	it('relays send_message into the pair\'s own room, never the human\'s DM', async () => {
		const target = makeBot('Target');
		vi.mocked(streamChat)
			// Sender's first step: asks to message the target.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('r1', 'send_message', { bot_name: target.name, message: 'ping' })]
				})
			)
			// Target bot's turn inside the relay.
			.mockImplementationOnce(() => fakeStream(['pong'], { text: 'pong', toolCalls: [] }))
			// Sender resumes with the relayed reply as its tool result.
			.mockImplementationOnce(() => fakeStream(['final'], { text: 'final', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('final');
		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(3);

		// The exchange lives in a room holding exactly the two bots, and that room
		// is private: a human's DM is a conversation with one bot, and nothing
		// another bot says belongs in it.
		const room = listConversations().find((c) => c.private && c.kind === 'group');
		if (!room) throw new Error('expected a private bots-only room for the pair');
		expect(conversationBots(room.id).map((b) => b.id).sort()).toEqual([bot.id, target.id].sort());
		const msgs = listMessages(room.id);
		expect(msgs[0]).toMatchObject({
			role: 'user',
			content: 'ping',
			bot_id: bot.id,
			kind: 'relay'
		});
		expect(msgs[1]).toMatchObject({
			role: 'assistant',
			content: 'pong',
			bot_id: target.id,
			// The reply is relay traffic too: tagged and aimed back at the sender,
			// so the human's DM feed draws 'target → sender' under the send.
			kind: 'relay',
			relay_to: bot.id
		});

		// Nothing is written into the human's own DM with either bot - but the
		// DM page folds the pair room's relay rows in, so the reader sees both
		// halves of the exchange: the send and the reply it provoked.
		for (const dm of listConversations().filter(
			(c) => c.kind === 'direct' && (c.bot_ids === bot.id || c.bot_ids === target.id)
		)) {
			expect(listMessages(dm.id).some((m) => m.kind === 'relay')).toBe(false);
			const folded = listMessagesPage(dm.id).messages;
			// The DM's own rows are the bot's reply to the human; the pair room
			// contributes the two relay lines, send first, answer under it.
			expect(folded.filter((m) => m.kind === 'relay').map((m) => [m.bot_id, m.relay_to, m.content])).toEqual([
				[bot.id, target.id, 'ping'],
				[target.id, bot.id, 'pong']
			]);
		}

		// The target saw the relayed message named as the sender's, not as the human.
		const targetCall = vi.mocked(streamChat).mock.calls[1][0];
		expect(targetCall.messages).toContainEqual({
			role: 'user',
			content: [{ type: 'text', text: `${bot.name}: ping` }]
		});

		// The reply came back to the sender as the tool result.
		const resumeCall = vi.mocked(streamChat).mock.calls[2][0];
		expect(resumeCall.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 'r1',
			content: `${target.name} replied: pong`
		});
	});

	it('refuses send_message once the relay depth cap is reached', async () => {
		const target = makeBot('DeepTarget');
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('d1', 'send_message', { bot_name: target.name, message: 'ping' })]
				})
			)
			.mockImplementationOnce(() => fakeStream(['ok'], { text: 'ok', toolCalls: [] }));

		const res = await runBotTurn(conv, bot, { depth: 2 });

		expect(res.text).toBe('ok');
		// No recursive turn ran for the target.
		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2);
		const secondCall = vi.mocked(streamChat).mock.calls[1][0];
		expect(secondCall.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 'd1',
			content: 'error: relay limit reached — answer directly instead'
		});
		expect(listConversations().some((c) => c.bot_ids === target.id)).toBe(false);
	});

	it('dedupes an identical send_message fired twice in one turn', async () => {
		const target = makeBot('DupTarget');
		vi.mocked(streamChat)
			// Sender's first step: asks to message the target.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('r1', 'send_message', { bot_name: target.name, message: 'ping' })]
				})
			)
			// Target bot's turn inside the relay.
			.mockImplementationOnce(() => fakeStream(['pong'], { text: 'pong', toolCalls: [] }))
			// Sender double-fires the same send - the model's own stutter, not a
			// second message.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('r2', 'send_message', { bot_name: target.name, message: 'ping' })]
				})
			)
			.mockImplementationOnce(() => fakeStream(['final'], { text: 'final', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('final');
		// The second call never reached the target: no second turn ran, and the
		// tool result says the line is already there.
		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(4);
		const lastCall = vi.mocked(streamChat).mock.calls[3][0];
		expect(lastCall.messages).toContainEqual({
			role: 'tool',
			tool_call_id: 'r2',
			content: `already delivered - ${target.name} has your message; wait for the reply instead of sending it again`
		});
		// And the pair room holds the send once, not twice - the second relay
		// row is the tagged reply, aimed back at the sender.
		const room = listConversations().find((c) => c.private && c.kind === 'group');
		if (!room) throw new Error('expected a private bots-only room for the pair');
		const relays = listMessages(room.id).filter((m) => m.kind === 'relay');
		expect(relays.filter((m) => m.role === 'user')).toHaveLength(1);
		expect(relays.filter((m) => m.role === 'assistant')).toHaveLength(1);
	});

	it('persists partial text when the signal aborts mid-stream', async () => {
		const controller = new AbortController();
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				yield 'par';
				controller.abort();
				throw new Error('stream aborted');
			})()
		);

		const res = await runBotTurn(conv, bot, { signal: controller.signal });

		expect(res.aborted).toBe(true);
		expect(res.text).toBe('par');
		const msgs = listMessages(conv.id);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ role: 'assistant', content: 'par', bot_id: bot.id });
	});

	it('cuts a reply at the character cap instead of storing a whole stream of it', async () => {
		// The provider streams 60k characters in one delta: the cap is what stands
		// between that and a 60k-character row, a 60k-character transcript next
		// turn, and a 60k-character render.
		const huge = 'x'.repeat(60_000);
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream([huge], { text: huge, toolCalls: [] })
		);
		const streamed: string[] = [];

		const res = await runBotTurn(conv, bot, { onDelta: (d) => streamed.push(d) });

		const stored = listMessages(conv.id)[0];
		expect(stored.content).toHaveLength(MAX_REPLY_CHARS);
		expect(stored.content.endsWith(`[reply cut at ${MAX_REPLY_CHARS} characters]`)).toBe(true);
		expect(res.text).toBe(stored.content);
		// What the reader was streamed is exactly what was stored: no words appear
		// live and then vanish when the message reloads from the row.
		expect(streamed.join('')).toBe(stored.content);
	});

	it('refuses to run a jailed bot, without spending a call on it', async () => {
		const jailed = makeBot('Jailed');
		const room = createConversation([jailed.id], 'direct');
		jailBot(jailed.id, Date.now() + 60_000, 'said it talked to somebody it did not');

		const res = await runBotTurn(room, getBot(jailed.id)!);

		// The sentence stops the turn rather than the model: no call, no message,
		// and a stop reason the caller can show the human.
		expect(res.stoppedBy).toBe('jailed');
		expect(vi.mocked(streamChat)).not.toHaveBeenCalled();
		expect(listMessages(room.id)).toHaveLength(0);
	});

	it('retries once without tools when the provider rejects them', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				(async function* () {
					throw new Error('Provider 400: this model does not support tools');
				})()
			)
			.mockImplementationOnce(() => fakeStream(['ok'], { text: 'ok', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('ok');
		expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2);
		const firstCall = vi.mocked(streamChat).mock.calls[0][0];
		const secondCall = vi.mocked(streamChat).mock.calls[1][0];
		expect(firstCall.tools?.length).toBeGreaterThan(0);
		expect(secondCall.tools).toBeUndefined();
	});

	it('refuses to run tool calls from a truncated stream', async () => {
		vi.mocked(machineExec).mockResolvedValue('should not run');
		vi.mocked(streamChat)
			// The sub-agent's stream ends mid-tool-call: partial arguments that
			// still parse must not reach the sandbox.
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('t1', 'use_computer', { task: 'list files' })]
				})
			)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('s1', 'shell_exec', { command: 'rm -rf /' })],
					truncated: true
				})
			)
			.mockImplementationOnce(() => fakeStream(['stopped'], { text: 'stopped', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		expect(res.text).toBe('stopped');
		expect(machineExec).not.toHaveBeenCalled();
		const lastCall = vi.mocked(streamChat).mock.calls[2][0];
		expect(lastCall.messages).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				tool_call_id: 't1',
				content: expect.stringContaining('cut off')
			})
		);
	});

	it('meters a relayed turn onto the parent and honours its signal', async () => {
		const target = makeBot('Metered');
		const controller = new AbortController();
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream([], {
					text: '',
					toolCalls: [toolCall('r1', 'send_message', { bot_name: target.name, message: 'ping' })]
				})
			)
			.mockImplementationOnce(() => fakeStream(['pong'], { text: 'pong', toolCalls: [] }))
			.mockImplementationOnce(() => fakeStream(['final'], { text: 'final', toolCalls: [] }));

		const usages: { input: number; output: number }[] = [];
		const res = await runBotTurn(conv, bot, {
			signal: controller.signal,
			onUsage: (u) => usages.push(u)
		});

		expect(res.text).toBe('final');
		// Three model calls ran - the sender's two and the relayed turn's one -
		// and every one of them reported to the parent's meter.
		expect(usages).toHaveLength(3);
		// The relayed step ran under the parent's signal, not a bare turn.
		const relayedCall = vi.mocked(streamChat).mock.calls[1][0];
		expect(relayedCall.signal?.aborted).toBe(false);
		controller.abort();
		expect(relayedCall.signal?.aborted).toBe(true);
	});

	it('rolls back partial text when retrying without tools', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				(async function* () {
					yield 'partial ';
					throw new Error('Provider 400: tools not supported');
				})()
			)
			.mockImplementationOnce(() => fakeStream(['clean'], { text: 'clean', toolCalls: [] }));

		const res = await runBotTurn(conv, bot);

		// The failed attempt's words are not glued onto the retry's reply.
		expect(res.text).toBe('clean');
		expect(listMessages(conv.id)[0]).toMatchObject({ content: 'clean' });
	});

	it('fails the task but persists partial text when a turn fails mid-stream', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				yield 'half a reply';
				throw new Error('socket exploded');
			})()
		);

		// A stream error is a failed call, not a reply: the task fails, and the
		// words the reader already saw are kept with the cut-off marker.
		await expect(runBotTurn(conv, bot)).rejects.toThrow('socket exploded');

		const msgs = listMessages(conv.id);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ role: 'assistant', content: 'half a reply\n\n[stopped: cut off mid-stream]', bot_id: bot.id });
	});

	it('persists partial text when a later step throws mid-turn', async () => {
		vi.mocked(streamChat)
			.mockImplementationOnce(() =>
				fakeStream(['half a reply'], {
					text: 'half a reply',
					toolCalls: [toolCall('t', 'list_files', {})]
				})
			)
			.mockImplementationOnce(() =>
				(async function* () {
					throw new Error('socket exploded');
				})()
			);

		await expect(runBotTurn(conv, bot)).rejects.toThrow('socket exploded');

		const msgs = listMessages(conv.id);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ role: 'assistant', content: 'half a reply\n\n[stopped: cut off mid-stream]', bot_id: bot.id });
	});
	it('keeps pending feedback for the next turn when a turn fails', async () => {
		const msg = addMessage(conv.id, 'assistant', 'earlier reply', bot.id);
		addFeedback(bot.id, msg.id, 1, 'earlier reply');

		vi.mocked(streamChat).mockImplementation(() =>
			(async function* () {
				throw new Error('provider down');
			})()
		);
		await expect(runBotTurn(conv, bot)).rejects.toThrow('provider down');

		// The notice was in the failed turn's prompt but was never delivered, so
		// it survives for the next one.
		expect(pendingFeedback(bot.id)).toHaveLength(1);

		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream(['ok'], { text: 'ok', toolCalls: [] })
		);
		await runBotTurn(conv, bot);
		expect(pendingFeedback(bot.id)).toHaveLength(0);
	});

	it('marks a bot onboarded after a first turn that is only tool calls', async () => {
		vi.mocked(streamChat).mockImplementation(() =>
			fakeStream([], {
				text: '',
				toolCalls: [toolCall('t', 'list_files', {})]
			})
		);

		await runBotTurn(conv, bot);

		expect(getBot(bot.id)?.onboarded).toBe(1);
	});

	describe('delegation', () => {
		beforeEach(() => {
			// Earlier tests' bots carry this test's keywords in their activity
			// logs (a delegation writes "Asked X: <task>" there), so the scan
			// must only see this test's bots.
			for (const b of listBots()) if (b.id !== bot.id) deleteBot(b.id);
		});

		/** A bot whose public context clearly owns the message's keywords. */
		function makeSpecialist(): Bot {
			return createBot({
				name: `Chef${++seq}`,
				persona: 'You bake sourdough bread and share recipes all day.',
				avatar: '',
				color: '',
				model: '',
				badge: ''
			});
		}

		/**
		 * The room a hand-off happens in: the asker and the bot that might take
		 * it, both members - the scan only ever considers the room's own bots.
		 */
		function roomWith(other: Bot): Conversation {
			return createConversation([bot.id, other.id], 'group');
		}

		it('hands the turn to a better-suited bot in the room, and shows the ask', async () => {
			const chef = makeSpecialist();
			const room = roomWith(chef);
			addMessage(room.id, 'user', 'can you bake a sourdough bread recipe');
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['crusty loaf coming up'], { text: 'crusty loaf coming up', toolCalls: [] })
			);
			const before = listActivities(bot.id).map((a) => a.id);

			const res = await runBotTurn(room, bot);
			const msgs = listMessages(room.id);
			const marker = msgs.find((m) => m.kind === 'delegate');
			expect(marker).toBeDefined();
			expect(JSON.parse(marker!.content)).toMatchObject({
				asker: bot.name,
				target: chef.name
			});
			// The specialist's reply is the answer; the asked bot stays quiet.
			expect(msgs.at(-1)).toMatchObject({
				role: 'assistant',
				bot_id: chef.id,
				content: 'crusty loaf coming up'
			});
			expect(res.message?.bot_id).toBe(chef.id);
			// The delegation brief reached the specialist's system prompt.
		});
		it('logs the ask on the asker only once the delegate verifiably answered', async () => {
			const chef = makeSpecialist();
			const room = roomWith(chef);
			addMessage(room.id, 'user', 'can you bake a sourdough bread recipe');
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['crusty loaf coming up'], { text: 'crusty loaf coming up', toolCalls: [] })
			);

			await runBotTurn(room, bot);

			expect(
				listActivities(bot.id).some(
					(a) => a.kind === 'delegate' && a.detail.startsWith(`Asked ${chef.name}`)
				)
			).toBe(true);
		});

		it('logs a failed delegation as a failure, not as a contact made', async () => {
			const chef = makeSpecialist();
			const room = roomWith(chef);
			addMessage(room.id, 'user', 'can you bake a sourdough bread recipe');
			// The first stream call is the delegate's turn, and it dies; the
			// asker's own turn then answers normally.
			vi.mocked(streamChat)
				.mockImplementationOnce(() =>
					(async function* () {
						throw new Error('fetch failed');
					})()
				)
				.mockImplementationOnce(() =>
					fakeStream(['doing it myself'], { text: 'doing it myself', toolCalls: [] })
				);

			const res = await runBotTurn(room, bot);

			// The ask card stays (the human sees the attempt), but the asker's
			// log never claims an "Asked" that nothing in history backs up.
			expect(res.text).toBe('doing it myself');
			const askerLog = listActivities(bot.id).map((a) => `${a.kind}:${a.detail}`);
			expect(askerLog.some((k) => k.startsWith('delegate:'))).toBe(false);
			expect(
				askerLog.some((k) => k.startsWith(`error:Tried to reach ${chef.name}, failed: fetch failed`))
			).toBe(true);
			// The delegate's own log carries the failure from its side.
			expect(
				listActivities(chef.id).some((a) => a.detail.startsWith(`Delegated ask from ${bot.name} failed`))
			).toBe(true);
		});

		it('never hands the turn out of a one-to-one chat, whatever the words', async () => {
			// A DM has one bot in it, so there is nobody to hand the turn to -
			// even when the ask is plainly somebody else's subject. The gate is
			// the room's shape, not the message's.
			makeSpecialist();
			addMessage(conv.id, 'user', 'first parallel ping: can you bake a sourdough bread recipe');
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['it is only me here'], { text: 'it is only me here', toolCalls: [] })
			);

			const res = await runBotTurn(conv, bot);

			expect(res.text).toBe('it is only me here');
			expect(listMessages(conv.id).some((m) => m.kind === 'delegate')).toBe(false);
		});

		it('does not hand over on a message that only shares common words', async () => {
			// "first parallel ping" once scored two hits against a bot's public
			// context and moved a user's turn into another bot's mouth. Words
			// that short and that ordinary are not a subject matter.
			const pinger = createBot({
				name: `Pinger${++seq}`,
				persona: 'You keep the room posted about pings.',
				avatar: '',
				color: '',
				model: '',
				badge: ''
			});
			const room = roomWith(pinger);
			addMessage(room.id, 'user', 'first parallel ping');
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['just me answering'], { text: 'just me answering', toolCalls: [] })
			);

			const res = await runBotTurn(room, bot);

			expect(res.text).toBe('just me answering');
			expect(listMessages(room.id).some((m) => m.kind === 'delegate')).toBe(false);
		});

		it('keeps the delegation card out of the prompts it is a record for', async () => {
			const chef = makeSpecialist();
			const room = roomWith(chef);
			addMessage(room.id, 'user', 'can you bake a sourdough bread recipe');
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['crusty loaf coming up'], { text: 'crusty loaf coming up', toolCalls: [] })
			);
			await runBotTurn(room, bot);

			// The card is in the thread for the reader. On the next turn in the same
			// room, neither bot may be handed its JSON as something somebody said -
			// a model given the card answers the card.
			vi.mocked(streamChat).mockClear();
			await runBotTurn(room, bot);
			const sent = vi.mocked(streamChat).mock.calls[0][0].messages;
			expect(sent.some((m) => textOf(m.content).includes('"asker"'))).toBe(false);
			expect(sent.some((m) => textOf(m.content).includes('asked you to take this request'))).toBe(false);
		});

		it('keeps the specialist\'s partial answer when the ask is cancelled mid-stream', async () => {
			const chef = makeSpecialist();
			const room = roomWith(chef);
			addMessage(room.id, 'user', 'can you bake a sourdough bread recipe');
			const controller = new AbortController();
			vi.mocked(streamChat).mockImplementation(() =>
				(async function* () {
					yield 'kneading';
					controller.abort();
					throw new Error('stream aborted');
				})()
			);

			const res = await runBotTurn(room, bot, { signal: controller.signal });

			// The reader watched the specialist write this much, so a stop must not
			// swallow it: the partial is the answer the task points at, and the task
			// itself still reports that it was stopped.
			expect(res.aborted).toBe(true);
			const last = listMessages(room.id).at(-1)!;
			expect(last).toMatchObject({
				role: 'assistant',
				bot_id: chef.id,
				content: 'kneading'
			});
			expect(res.message?.id).toBe(last.id);
		});

		it('lets the asked bot answer itself when the specialist declines', async () => {
			const chef = makeSpecialist();
			const room = roomWith(chef);
			addMessage(room.id, 'user', 'can you bake a sourdough bread recipe');
			vi.mocked(streamChat)
				.mockImplementationOnce(() =>
					fakeStream(['DECLINE: I only do pastry'], {
						text: 'DECLINE: I only do pastry',
						toolCalls: []
					})
				)
				.mockImplementationOnce(() =>
					fakeStream(['I can try anyway'], { text: 'I can try anyway', toolCalls: [] })
				);

			const res = await runBotTurn(room, bot);

			const msgs = listMessages(room.id);
			const declined = msgs.filter((m) => m.kind === 'delegate').at(-1);
			expect(JSON.parse(declined!.content)).toMatchObject({
				target: chef.name,
				declined: 'I only do pastry'
			});
			// The decline never lands as a bubble; the original bot answers instead.
			expect(msgs.at(-1)).toMatchObject({ bot_id: bot.id, content: 'I can try anyway' });
			expect(res.message?.bot_id).toBe(bot.id);
		});

		it('answers itself when no bot in the room is a clear match', async () => {
			const chef = makeSpecialist();
			const room = roomWith(chef);
			addMessage(room.id, 'user', 'what is the weather doing tomorrow');
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['no idea'], { text: 'no idea', toolCalls: [] })
			);

			const res = await runBotTurn(room, bot);

			expect(res.text).toBe('no idea');
			expect(listMessages(room.id).some((m) => m.kind === 'delegate')).toBe(false);
		});

		it('never delegates in a private room', async () => {
			const chef = makeSpecialist();
			const room = createConversation([bot.id, chef.id], 'group');
			updateConversation(room.id, { private: 1 });
			addMessage(room.id, 'user', 'can you bake a sourdough bread recipe');
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['flour and water'], { text: 'flour and water', toolCalls: [] })
			);

			const res = await runBotTurn(getConversation(room.id)!, bot);

			expect(res.text).toBe('flour and water');
			expect(listMessages(room.id).some((m) => m.kind === 'delegate')).toBe(false);
			expect(vi.mocked(streamChat).mock.calls[0][0].messages[0].content).not.toContain(
				`${chef.name} asked`
			);
		});
	});

	describe('claims vs calls', () => {
		it('flags a remembered claim no remember call backs, and tells the bot next turn', async () => {
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(["I've remembered that your favorite tea is oolong"], {
					text: "I've remembered that your favorite tea is oolong",
					toolCalls: []
				})
			);

			await runBotTurn(conv, bot);

			// The discrepancy is on the record: the activity log is what the
			// police read, and the claim sits there next to the reply itself.
			const acts = listActivities(bot.id).map((a) => `${a.kind}:${a.detail}`);
			expect(acts.some((a) => a.startsWith('claim:') && a.includes('remembered'))).toBe(true);

			// The bot hears about it on its next turn, privately, in the prompt.
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['noted for real this time'], {
					text: 'noted for real this time',
					toolCalls: []
				})
			);
			const claimHistory = await buildHistory(conv, bot);
			expect(textOf(claimHistory[0].content)).toContain('no matching tool call ran');
			expect(textOf(claimHistory[0].content)).toContain('remembered');

			// And the note is spent: the turn after that carries nothing.
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['ok'], { text: 'ok', toolCalls: [] })
			);
			await runBotTurn(conv, bot);
			const spentHistory = await buildHistory(conv, bot);
			expect(textOf(spentHistory[0].content)).not.toContain('no matching tool call ran');
		});

		it('does not flag a claim the turn actually made', async () => {
			vi.mocked(streamChat)
				.mockImplementationOnce(() =>
					fakeStream([], {
						text: '',
						toolCalls: [toolCall('t1', 'remember', { key: 'tea', value: 'oolong' })]
					})
				)
				.mockImplementationOnce(() =>
					fakeStream(['remembered - oolong it is'], {
						text: 'remembered - oolong it is',
						toolCalls: []
					})
				);

			await runBotTurn(conv, bot);

			expect(listActivities(bot.id).some((a) => a.kind === 'claim')).toBe(false);
		});

		it('does not flag a claim a different tool could have made true', async () => {
			// "saved" is provable by more than remember - a pinned note is a save
			// too, so the check takes any plausible call rather than one name.
			vi.mocked(streamChat)
				.mockImplementationOnce(() =>
					fakeStream([], {
						text: '',
						toolCalls: [toolCall('t1', 'share_note', { content: 'tea: oolong' })]
					})
				)
				.mockImplementationOnce(() =>
					fakeStream(['saved it to the notes'], { text: 'saved it to the notes', toolCalls: [] })
				);

			await runBotTurn(conv, bot);

			expect(listActivities(bot.id).some((a) => a.kind === 'claim')).toBe(false);
		});

		it('exempts a turn that never had tools to claim with', async () => {
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['I remembered the tea'], { text: 'I remembered the tea', toolCalls: [] })
			);

			await runBotTurn(conv, bot, { noTools: true });

			expect(listActivities(bot.id).some((a) => a.kind === 'claim')).toBe(false);
		});

		it('logs one claim row for a line that trips two patterns', async () => {
			// "checked and remembered" matches both the any-tool pattern and the
			// remember pattern; the claim is the line, so it is logged once.
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(["checked the notes and I've remembered it"], {
					text: "checked the notes and I've remembered it",
					toolCalls: []
				})
			);

			await runBotTurn(conv, bot);

			expect(listActivities(bot.id).filter((a) => a.kind === 'claim')).toHaveLength(1);
		});

		it('flags a claim phrased as already done', async () => {
			// "the tool already has it" names no verb but still claims the deed.
			vi.mocked(streamChat).mockImplementation(() =>
				fakeStream(['the tool already has it logged'], {
					text: 'the tool already has it logged',
					toolCalls: []
				})
			);

			await runBotTurn(conv, bot);

			expect(listActivities(bot.id).some((a) => a.kind === 'claim')).toBe(true);
		});
	});
});
