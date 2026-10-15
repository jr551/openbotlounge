import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMessage, getTask, listActivitiesInWindow } from '$lib/server/db';
import { cancelTask } from '$lib/server/tasks';

/**
 * One task in full: the row itself, the reply it saved (when it finished into
 * a message), and the activity the bot logged while it ran. Activities carry
 * no task id, so the window is the task's own lifetime - a couple of seconds
 * past the end catches the "Cancelled:"/"Task failed:" line the task writes
 * after finishTask stamps finished_at.
 */
export const GET: RequestHandler = ({ params }) => {
	const task = getTask(params.id);
	if (!task) throw error(404, 'task not found');
	const until = task.finished_at ? task.finished_at + 2000 : Date.now();
	return json({
		task,
		message: task.message_id ? (getMessage(task.message_id) ?? null) : null,
		activities: listActivitiesInWindow(task.bot_id, task.created_at, until)
	});
};

/**
 * Stop a running task. Whatever the model had already written is kept and
 * saved, and the task records that message; only the rest of the turn is cut.
 * A stop that lands before the model has written anything saves nothing and
 * records no message, because there is nothing to save.
 */
export const DELETE: RequestHandler = ({ params }) => {
	const task = getTask(params.id);
	if (!task) throw error(404, 'task not found');
	const cancelled = cancelTask(params.id);
	// cancelTask aborts the turn; the row is stamped by the task's own finally,
	// which has not necessarily run yet. A successful cancel therefore reports
	// 'cancelled' rather than the pre-cancel row's stale 'running'.
	const after = getTask(params.id) ?? task;
	const status = cancelled && after.status === 'running' ? 'cancelled' : after.status;
	return json({ ok: cancelled, status });
};
