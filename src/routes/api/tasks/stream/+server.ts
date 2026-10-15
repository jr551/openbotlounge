import type { RequestHandler } from './$types';
import { getTask, listTasks } from '$lib/server/db';
import { subscribeTaskEvents, subscribeTaskProgress, subscribeTaskStarts } from '$lib/server/tasks';

/**
 * The live reply stream: one Server-Sent Events connection per client, carrying
 * the partial text of every turn this process is running as it is written.
 *
 * The `/api/tasks` polls still carry the rows and their statuses - this exists
 * only so the composing bubble can show the words arriving rather than a
 * placeholder that jumps to the finished message. A poll fast enough to read as
 * typing would be a request per few hundred milliseconds per client; the deltas
 * already exist in-process, so this hands them over as they happen.
 *
 * It sits behind the same session gate as every other `/api` path: the hook
 * refuses an unauthenticated request before the handler is reached.
 */
export const GET: RequestHandler = ({ url, request }) => {
	const conversationId = url.searchParams.get('conversation_id') ?? undefined;
	const encoder = new TextEncoder();
	/** Per-task teardown, keyed by task id: the progress and lifecycle subscriptions. */
	const attached = new Map<string, () => void>();
	let closed = false;
	let keepAlive: ReturnType<typeof setInterval> | null = null;
	let offStarts: (() => void) | null = null;
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

	const send = (event: string, data: unknown) => {
		if (closed || !controller) return;
		try {
			controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
		} catch {
			// The client went away between the check and the write; the stream's
			// own cancel handler does the teardown.
		}
	};

	const detach = (taskId: string) => {
		attached.get(taskId)?.();
		attached.delete(taskId);
	};

	const attach = (taskId: string) => {
		if (attached.has(taskId)) return;
		const offProgress = subscribeTaskProgress(taskId, (p) =>
			send('preview', { taskId: p.taskId, preview: p.preview })
		);
		const offEvents = subscribeTaskEvents(taskId, (e) => {
			if (e.type !== 'agent_end') return;
			// The turn is over: the client drops the partial, and the finished
			// message (or the failure) takes its place from the task poll.
			send('task_end', { taskId });
			detach(taskId);
		});
		attached.set(taskId, () => {
			offProgress();
			offEvents();
		});
		// A subscriber that arrives mid-turn has missed the deltas already sent,
		// so it starts from the row's own tail rather than waiting for the end.
		const row = getTask(taskId);
		if (row?.preview) send('preview', { taskId, preview: row.preview });
	};

	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (keepAlive) clearInterval(keepAlive);
		offStarts?.();
		for (const id of [...attached.keys()]) detach(id);
	};

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			// Every turn already running when the client connects - a reconnect
			// mid-turn picks up the partial instead of showing nothing until the
			// end.
			for (const t of listTasks({ conversationId })) {
				if (t.status === 'running') attach(t.id);
			}
			// A turn that starts after this connection opened: the registry tells
			// us the moment it exists, so there is no gap to poll for.
			offStarts = subscribeTaskStarts((task) => {
				if (conversationId && task.conversation_id !== conversationId) return;
				attach(task.id);
			});
			// A comment frame keeps a proxy from closing an idle connection; the
			// client ignores an event it does not listen for.
			keepAlive = setInterval(() => send('ping', {}), 15_000);
			// The request's own abort fires when the client disconnects.
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller?.close();
				} catch {
					// Already closed by the stream machinery.
				}
			});
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			// nginx and friends buffer a proxied response by default, which would
			// hold the deltas until the turn ended - exactly what this avoids.
			'x-accel-buffering': 'no'
		}
	});
};
