import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addPoliceRule,
	deletePoliceRule,
	listPoliceRules,
	listSettings,
	MAX_POLICE_RULES,
	setSetting,
	updatePoliceRule
} from '$lib/server/db';
import { readJson, strField } from '$lib/server/http';
import { BUILT_IN_CRITERIA } from '$lib/server/police-review';
import { policeSettings } from '$lib/server/police';

/**
 * The criteria book, as the console lists it: the built-ins with their enabled
 * flags, then the human's own rules - always enabled, because retiring one is
 * deleting it.
 */
export const GET: RequestHandler = () => {
	const disabled = policeSettings().disabledRules;
	return json({
		rules: [
			...BUILT_IN_CRITERIA.map((c) => ({
				id: c.id,
				name: c.name,
				summary: c.text,
				pattern: '',
				custom: false,
				enabled: !disabled.has(c.id)
			})),
			...listPoliceRules().map((r) => ({
				id: r.id,
				name: r.name || r.summary || 'custom rule',
				summary: r.summary,
				pattern: r.pattern,
				custom: true,
				enabled: true
			}))
		]
	});
};

/**
 * A new criterion: a name, a pattern the review is pointed at, and the words
 * the alert carries. The pattern must compile - a rule that cannot be aimed
 * is refused here rather than stored to be silently ignored.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const name = (strField(body, 'name', 120) ?? '').trim();
	const pattern = (strField(body, 'pattern', 500) ?? '').trim();
	const summary = (strField(body, 'summary', 200) ?? '').trim();
	if (!pattern) throw error(400, 'pattern required');
	// The book is bounded: every rule is compiled and run each round, so an
	// unbounded one is unbounded review cost. Refuse before compiling.
	if (listPoliceRules().length >= MAX_POLICE_RULES) {
		throw error(409, `the criteria book is full (${MAX_POLICE_RULES} rules)`);
	}
	try {
		new RegExp(pattern, 'i');
	} catch {
		throw error(400, 'pattern is not a valid regular expression');
	}
	return json({ rule: addPoliceRule(name, pattern, summary) }, { status: 201 });
};

/**
 * Tune the book: `enabled` flips a built-in criterion (stored as the
 * police_disabled_rules setting); `name`/`pattern`/`summary` edit a custom
 * rule in place. A custom rule's enabled flag is always true - the switch for
 * one of those is DELETE.
 */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const id = strField(body, 'id', 80) ?? '';
	if (!id) throw error(400, 'id required');

	const enabled = body.enabled;
	if (enabled !== undefined) {
		if (typeof enabled !== 'boolean') throw error(400, 'enabled must be a boolean');
		if (!BUILT_IN_CRITERIA.some((c) => c.id === id)) throw error(404, 'no such built-in criterion');
		const disabled = new Set(
			(listSettings().police_disabled_rules ?? '').split(',').map((s) => s.trim()).filter(Boolean)
		);
		if (enabled) disabled.delete(id);
		else disabled.add(id);
		setSetting('police_disabled_rules', [...disabled].join(','));
		return json({ ok: true, enabled });
	}

	const fields: { name?: string; pattern?: string; summary?: string } = {};
	const name = strField(body, 'name', 120);
	const pattern = strField(body, 'pattern', 500);
	const summary = strField(body, 'summary', 200);
	if (name !== undefined) fields.name = name.trim();
	if (summary !== undefined) fields.summary = summary.trim();
	if (pattern !== undefined) {
		try {
			new RegExp(pattern.trim(), 'i');
		} catch {
			throw error(400, 'pattern is not a valid regular expression');
		}
		fields.pattern = pattern.trim();
	}
	if (!Object.keys(fields).length) throw error(400, 'nothing to change');
	if (!updatePoliceRule(id, fields)) throw error(404, 'rule not found');
	return json({ ok: true });
};

/** Retire one custom rule; the review stops reading it next round. */
export const DELETE: RequestHandler = async ({ request, url }) => {
	const body = await readJson(request).catch(() => null);
	const bodyId = body && typeof body.id === 'string' ? body.id : '';
	const id = url.searchParams.get('id') ?? bodyId;
	if (!id) throw error(400, 'id required');
	if (!deletePoliceRule(id)) throw error(404, 'rule not found');
	return json({ ok: true });
};
