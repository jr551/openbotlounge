/**
 * Mid-task steering: when the human sends a message while a bot's turn is
 * still running, something has to decide whether it belongs to the work in
 * flight or starts work of its own. A correction ("use the blue one",
 * "stop, wrong file") steers the running turn - it is queued into the live
 * tool loop and the model sees it before its next provider call. A new ask
 * ("also, what's the weather?") gets a fresh task, so the running one is not
 * derailed and the new one is answered on its own thread.
 *
 * The call is made by one cheap completion against the police model - the
 * fleet's standing judgment model - not by the working bot, whose next step
 * may be minutes away. A classifier that cannot answer defaults to steering:
 * the running turn reads the message and decides for itself, which is the
 * safer wrong answer than silently starting a second task.
 */
import { complete } from './llm';
import { meterPoliceCall, policeModel } from './police';

export type InterruptionKind = 'steer' | 'new';

/**
 * The classifier's verdict, and whether it is a verdict at all.
 *
 * `confident: false` is the failure default - no model, a provider error, an
 * unparseable answer. It still reads as 'steer', because the running turn can
 * read the message and decide for itself, which is the safer wrong answer than
 * silently starting a second task *in the same conversation*. It is not good
 * enough to route a message into a different conversation on: a guess there
 * posts the human's words into a room they are not reading and leaves their own
 * with no answer, so callers that reach across conversations insist on this.
 */
export interface Interruption {
	kind: InterruptionKind;
	confident: boolean;
}

/**
 * The longest the classifier may hold a chat POST open. The call rides the
 * provider's own ceiling too, but a human waiting on a send cannot wait that
 * out: past this the message takes the safe default below rather than the
 * request hanging past the point a client gives up.
 */
const CLASSIFY_TIMEOUT_MS = 5_000;

/**
 * 'steer' when the message belongs to the task in flight, 'new' when it is a
 * separate ask. Any failure - no model, a provider error, an unparseable
 * answer, a provider too slow to answer inside CLASSIFY_TIMEOUT_MS - is
 * 'steer' with `confident: false`: the running turn still gets to read the
 * message.
 */
export async function classifyInterruption(
	taskPrompt: string,
	message: string
): Promise<Interruption> {
	const model = policeModel();
	if (!model) return { kind: 'steer', confident: false };
	try {
		const answer = (
			await complete(
				model,
				[
					{
						role: 'system',
						content:
							'A bot is mid-task. The human just sent another message. ' +
							'Decide whether it steers the work in progress - a correction, ' +
							'a refinement, an answer to the bot, or "stop that" - or is a ' +
							'new, separate ask that should start its own task. Reply with ' +
							'exactly one word: steer or new.'
					},
					{
						role: 'user',
						content: `Task in progress: ${taskPrompt}\n\nNew message: ${message}`
					}
				],
				// The police model may be a reasoner: it spends tokens on hidden
				// reasoning before the one-word verdict, so a tiny cap returns
				// finish_reason 'length' with empty content - which reads as the
				// failure default and steers every message. 512 leaves room for
				// the reasoning and the verdict; a non-reasoner still stops at one
				// word and spends almost none of it.
				{
					onUsage: meterPoliceCall,
					maxTokens: 512,
					signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
				}
			)
		).toLowerCase();
		// Only a named verdict counts as one: a reply that rambles or answers
		// something else is the failure default with a model's words on it. The
		// verdict is searched rather than anchored, because a reasoner can put
		// a word of its own ahead of it.
		const named = answer.match(/\b(steer|new)\b/);
		if (!named) return { kind: 'steer', confident: false };
		return { kind: named[1] === 'new' ? 'new' : 'steer', confident: true };
	} catch {
		return { kind: 'steer', confident: false };
	}
}
