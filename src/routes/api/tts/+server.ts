import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJson, strField } from '$lib/server/http';
import { piperConfig, synthesizeSpeech, TTS_TEXT_MAX } from '$lib/server/voice';

/**
 * Text to speech through the household Piper server: POST { text, voice? }
 * answers audio/wav. Unconfigured Piper (no PIPER_HOST) is a 503 the UI
 * turns into hidden speaker buttons rather than a broken player.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const text = strField(body, 'text', TTS_TEXT_MAX) ?? '';
	const voice = strField(body, 'voice', 80);
	if (!text.trim()) throw error(400, 'text is required');
	const cfg = piperConfig();
	if (!cfg.host) throw error(503, 'voice is not configured on this lounge (PIPER_HOST is empty)');
	try {
		const out = await synthesizeSpeech(text, cfg, voice ?? undefined);
		return new Response(new Uint8Array(out.wav), {
			headers: {
				'Content-Type': 'audio/wav',
				'Content-Length': String(out.wav.length),
				'Cache-Control': 'no-store'
			}
		});
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(502, `voice synthesis failed: ${e instanceof Error ? e.message : 'unknown error'}`);
	}
};
