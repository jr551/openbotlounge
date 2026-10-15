import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { listSettings, providerConfig, setSetting } from '$lib/server/db';
import { checkVision } from '$lib/server/capability';
import { dockerAvailable } from '$lib/server/docker';
import { baseUrlField, boolField, numField, readJson, strField } from '$lib/server/http';

/**
 * The database's own state: when its last copy was taken, and whether it had to
 * be restored. A recovery the user has not seen is the one thing here that
 * deserves to be shouted about.
 */
function databaseState() {
	const s = listSettings();
	const num = (k: string) => Number(s[k] ?? 0) || 0;
	return {
		last_backup_at: num('db_last_backup_at'),
		last_backup_bytes: num('db_last_backup_bytes'),
		backup_error: s.db_backup_error ?? '',
		recovered_at: num('db_recovered_at'),
		recovered_from: s.db_recovered_from ?? '',
		recovery_seen: s.db_recovery_seen === '1'
	};
}

export const GET: RequestHandler = async () => {
	const cfg = providerConfig();
	const s = listSettings();
	return json({
		social: config.social,
		social_interval_min: config.socialIntervalMin,
		default_model: config.model,
		police_model: s.police_model ?? '',
		// Only ever written through the image check below, so this is a model
		// that has been seen to answer a picture.
		vision_model: s.vision_model ?? '',
		theme: s.theme ?? '',
		docker: { available: await dockerAvailable() },
		provider: {
			base_url: cfg.baseUrl,
			// The key itself never crosses to the page: the UI is told only
			// whether one is set, so a leaked response can expose nothing to spend.
			has_key: cfg.apiKey.length > 0,
			oauth: cfg.oauth.length > 0
		},
		exa: { has_key: Boolean(s.exa_api_key || process.env.EXA_API_KEY) },
		firecrawl: { has_key: Boolean(s.firecrawl_api_key || process.env.FIRECRAWL_API_KEY) },
		database: databaseState()
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);

	// Dismissing the notice that the database was restored.
	const acknowledge = boolField(body, 'acknowledge_recovery');
	if (acknowledge === true) {
		setSetting('db_recovery_seen', '1');
		return json({ ok: true, database: databaseState() });
	}

	const social = boolField(body, 'social');
	if (social !== undefined) {
		config.social = social;
		setSetting('social', String(social));
	}

	const interval = numField(body, 'social_interval_min');
	if (interval !== undefined) {
		if (interval < 5 || interval > 10080)
			throw error(400, 'social_interval_min must be between 5 and 10080 minutes');
		config.socialIntervalMin = interval;
		setSetting('social_interval_min', String(interval));
	}

	const model = strField(body, 'default_model', 120);
	if (model !== undefined) {
		config.model = model;
		setSetting('default_model', model);
	}
	// The Lounge's bot-to-bot rounds run on this model (default 'free'); an
	// empty value puts the shipped default back. Read fresh per social tick.
	const socialModel = strField(body, 'social_model', 120);
	if (socialModel !== undefined) setSetting('social_model', socialModel.trim());
	// The police round's own brain; empty falls back to the default model.
	const policeModel = strField(body, 'police_model', 120);
	if (policeModel !== undefined) setSetting('police_model', policeModel.trim());
	// The model that looks at pictures for a bot whose own cannot. It is stored
	// only once it has answered an image, so a pick with a likely name but no
	// eyes cannot be saved in - by the picker, or by a hand-written body. The
	// check is one cheap completion; there is nothing to cache, because a value
	// that got in has already passed. Empty clears it and skips the probe:
	// there is nothing to prove about "nobody", and the police model looks.
	const visionModel = strField(body, 'vision_model', 120);
	let visionCheck: { model: string; detail: string } | null = null;
	if (visionModel !== undefined) {
		const picked = visionModel.trim();
		if (picked) {
			const verdict = await checkVision(picked).catch((e: unknown) => ({
				pass: false,
				detail: e instanceof Error ? e.message : String(e)
			}));
			if (!verdict.pass) {
				throw error(400, `${picked} cannot do images: ${verdict.detail}`);
			}
			setSetting('vision_model', picked);
			visionCheck = { model: picked, detail: verdict.detail };
		} else {
			setSetting('vision_model', '');
			visionCheck = { model: '', detail: '' };
		}
	}
	// The whole-app theme; the client applies it to documentElement.dataset.theme.
	// Blank clears back to the shipped default. Validated against the shipped
	// theme ids so a hand-edited row cannot set a theme that styles nothing.
	const theme = strField(body, 'theme', 40);
	if (theme !== undefined) {
		const known = ['', 'midnight', 'forest', 'sunset', 'lavender', 'mono'];
		if (!known.includes(theme)) throw error(400, 'unknown theme');
		setSetting('theme', theme);
	}
	// baseUrlField, not strField: this value is what every provider call dials,
	// so a scheme fetch cannot reach must be refused here rather than saved in
	// to brick the fleet. So must the app itself: a provider URL answering on
	// this server's own host sends every completion back into the lounge.
	const baseUrl = baseUrlField(body, 'provider_base_url', 300);
	if (baseUrl && new URL(baseUrl).host === request.headers.get('host')) {
		throw error(400, 'provider_base_url points back at this server');
	}
	const apiKey = strField(body, 'provider_api_key', 400);
	if (baseUrl !== undefined || apiKey !== undefined) {
		// Pointing at a different endpoint or pasting a key ends any OAuth
		// sign-in: the stored session only authenticates the ChatGPT backend.
		if (baseUrl !== undefined) setSetting('provider_base_url', baseUrl);
		if (apiKey !== undefined) setSetting('provider_api_key', apiKey);
		setSetting('provider_oauth', '');
	}

	// The keys web search spends: Exa first, Firecrawl as the failover. Stored
	// like the provider key and blanked out of the response below for the
	// same reason.
	const exaKey = strField(body, 'exa_api_key', 200);
	if (exaKey !== undefined) setSetting('exa_api_key', exaKey.trim());
	const firecrawlKey = strField(body, 'firecrawl_api_key', 200);
	if (firecrawlKey !== undefined) setSetting('firecrawl_api_key', firecrawlKey.trim());

	// The police console's knobs. Numbers are stored as given; policeSettings()
	// is what decides whether a value is usable, and falls back to the shipped
	// constant for anything missing or silly - so this route does not have to
	// duplicate the bounds, and a hand-edited row cannot switch a rule off by
	// accident.
	for (const key of [
		'police_interval_hours',
		'police_waste_tokens',
		'police_bloat_tokens',
		'police_outlier_floor',
		'police_outlier_multiple',
		'police_max_writes',
		'police_max_alerts'
	] as const) {
		const value = numField(body, key);
		if (value !== undefined) setSetting(key, String(value));
	}
	// The duties and the three creation gates, each on or off on its own.
	for (const key of ['police_writeups', 'police_patrol', 'police_check_plugins', 'police_check_routines', 'police_check_wakes', 'police_check_rooms'] as const) {
		const raw = strField(body, key, 10);
		if (raw === 'on' || raw === 'off') setSetting(key, raw);
	}
	// How a proposed jail lands. The console has offered this since the police
	// landed and policeSettings has always read it, but no route ever wrote it -
	// the select saved nothing and every fleet stayed on 'confirm'.
	const jailMode = strField(body, 'police_jail_mode', 10);
	if (jailMode === 'confirm' || jailMode === 'on' || jailMode === 'off') {
		setSetting('police_jail_mode', jailMode);
	}

	// The key never crosses to the page, on a write any more than on a read:
	// listSettings carries it raw, so it is blanked here rather than trusting
	// every caller to ignore it.
	const settings = {
		...listSettings(),
		provider_api_key: '',
		exa_api_key: '',
		firecrawl_api_key: ''
	};
	// What the image check made of the pick, when the body carried one: the
	// picker shows it as the confirmation, so the officer's answer rides back
	// with the write rather than being asked for twice. null = nothing was
	// picked this time.
	return json({ ok: true, settings, vision: visionCheck, database: databaseState() });
};
