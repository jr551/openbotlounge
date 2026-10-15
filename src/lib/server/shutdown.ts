import { db } from './db';
import { stopScheduler } from './scheduler';
import { stopAllTasks } from './tasks';

/**
 * Graceful exit for `systemctl stop` and Ctrl-C.
 *
 * adapter-node answers SIGTERM by closing the HTTP server and emitting
 * `sveltekit:shutdown`, but nothing exits the process: Node only exits when the
 * event loop empties, and the app holds it open forever - the scheduler's
 * 15-second interval, plus any running turn's provider socket or retry sleep
 * (a turn's own ceiling is minutes). Every stop therefore ran out systemd's
 * timeout and ended in SIGKILL.
 *
 * The sequence here: stop the tick loop, refuse and abort running turns, give
 * them a moment to write their final task rows, checkpoint and close the
 * database, then exit. The deadline is the guarantee: whatever is still open
 * when it fires is abandoned, so a wedged handle can never again hold the
 * process to SIGKILL.
 */

/** How long running turns get to write their final rows before exit. */
const TASK_DRAIN_MS = 8_000;
/** The last word: exit no matter what is still open. */
const SHUTDOWN_DEADLINE_MS = 10_000;

let stopping = false;

async function begin(reason: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log(`shutting down (${reason})`);
	// The deadline is armed first so nothing below - a stuck abort, a blocked
	// close - can postpone exit past it.
	const deadline = setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS);
	try {
		stopScheduler();
		await stopAllTasks(TASK_DRAIN_MS);
	} finally {
		clearTimeout(deadline);
		finish();
	}
}

function finish(): void {
	// Closing flushes the WAL into the main file, so the next boot reads a
	// checkpointed database rather than replaying the log.
	try {
		db.close();
	} catch {
		// Already closed, or a write was mid-flight: the exit matters, not this.
	}
	process.exit(0);
}

/**
 * Register the shutdown path. Called once from hooks.server.ts at server boot.
 * `sveltekit:shutdown` is adapter-node's own signal, emitted once its HTTP
 * server has closed - under `vite dev` it never fires, and the signal handlers
 * carry the whole path.
 */
export function armShutdown(): void {
	process.on('sveltekit:shutdown', (reason: string) => void begin(reason));
	process.once('SIGTERM', () => void begin('SIGTERM'));
	process.once('SIGINT', () => void begin('SIGINT'));
}
