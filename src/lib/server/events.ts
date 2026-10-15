/**
 * A typed lifecycle event stream for one bot turn.
 *
 * This is the one idea worth taking from the Pi SDK: a discriminated union of
 * turn events, emitted at the points the runner already knows about, so a
 * consumer can react to a tool starting or a turn ending without polling the
 * tasks table. It is deliberately local - no SDK dependency, no new transport -
 * and additive: the existing `onDelta`/`onUsage` callbacks and the `/api/tasks`
 * poll keep working exactly as before.
 *
 * The event names mirror the SDK's session events (`turn_start`,
 * `tool_execution_start`, `tool_execution_end`, `message_end`, `agent_end`) so
 * the shape is familiar, but nothing here imports the SDK.
 */

/** Where a turn is in its life. `taskId` is absent for a turn run outside a task row. */
export type TurnEvent =
	| { type: 'turn_start'; taskId?: string; botId: string; conversationId: string; model: string }
	| {
			type: 'tool_execution_start';
			taskId?: string;
			botId: string;
			callId: string;
			name: string;
			args: string;
	  }
	| {
			type: 'tool_execution_end';
			taskId?: string;
			botId: string;
			callId: string;
			name: string;
			output: string;
	  }
	| { type: 'message_end'; taskId?: string; botId: string; text: string; messageId: string }
	| { type: 'agent_end'; taskId?: string; botId: string; stoppedBy: string; aborted: boolean };

export type TurnEventListener = (event: TurnEvent) => void;

/**
 * The smallest thing that can fan one turn's events out to several listeners.
 * A listener that throws is swallowed for that event rather than allowed to
 * take the turn down with it: a tray subscriber must never be able to fail a
 * reply.
 */
export class TurnEventEmitter {
	private readonly listeners = new Set<TurnEventListener>();

	/** Register a listener; the returned function removes it. */
	subscribe(listener: TurnEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Deliver one event to every current listener. */
	emit(event: TurnEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A subscriber's failure is its own; the turn carries on.
			}
		}
	}
}
