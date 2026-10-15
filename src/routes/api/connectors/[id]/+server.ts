import { error, isHttpError, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	connectorOf,
	connectWhatsapp,
	decryptedConfig,
	elevenlabsPhoneNumbers,
	ensureTailscale,
	listWhatsappChats,
	tailscaleStatus,
	uninstallConnector,
	updateConnector,
	type ConnectorPatch
} from '$lib/server/connectors';
import { getBot, getPlugin } from '$lib/server/db';
import { boolField, readJson } from '$lib/server/http';

/**
 * Configure an installed connector: `values` (blank secret fields keep the
 * stored value), `bots` (the full assignment list), `allowed_chats`
 * (WhatsApp's allowlist) and `enabled`.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	const patch: ConnectorPatch = {};
	if (body.values !== undefined) {
		if (typeof body.values !== 'object' || body.values === null || Array.isArray(body.values)) {
			throw error(400, 'values must be an object of field values');
		}
		const values: Record<string, string> = {};
		for (const [key, value] of Object.entries(body.values)) {
			if (typeof value !== 'string') throw error(400, `values.${key} must be a string`);
			values[key] = value;
		}
		patch.values = values;
	}
	if (body.bots !== undefined) {
		if (!Array.isArray(body.bots) || body.bots.some((b) => typeof b !== 'string')) {
			throw error(400, 'bots must be an array of bot ids');
		}
		patch.bots = body.bots as string[];
	}
	if (body.allowed_chats !== undefined) {
		if (
			!Array.isArray(body.allowed_chats) ||
			body.allowed_chats.some(
				(c) =>
					!c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.alias !== 'string'
			)
		) {
			throw error(400, 'allowed_chats must be an array of {id, alias}');
		}
		patch.allowed_chats = body.allowed_chats as { id: string; alias: string }[];
	}
	const enabled = boolField(body, 'enabled');
	if (enabled !== undefined) patch.enabled = enabled;
	return json(updateConnector(params.id, patch));
};

/** Connector actions that are not plain config. */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	// WhatsApp pairing: start the session and hand back the QR image.
	if (body.action === 'connect') {
		return json(await connectWhatsapp(params.id));
	}
	// WhatsApp: the chats the session can see, for the allowlist picker.
	if (body.action === 'chats') {
		return json({ chats: await listWhatsappChats(params.id) });
	}
	// ElevenLabs: the account's numbers, for the phone-number-id picker.
	if (body.action === 'numbers') {
		return json({ numbers: await elevenlabsPhoneNumbers(params.id) });
	}
	// Tailscale: bring one bot's machine onto the tailnet, or just report.
	if (body.action === 'join' || body.action === 'status') {
		const botId = typeof body.bot_id === 'string' ? body.bot_id : '';
		if (!botId) throw error(400, 'bot_id required');
		if (!getBot(botId)) throw error(404, `bot ${botId} not found`);
		try {
			if (body.action === 'join') {
				const plugin = getPlugin(params.id);
				if (!plugin) throw error(404, 'connector not found');
				if (connectorOf(plugin)?.id !== 'tailscale') {
					throw error(400, 'only the tailscale connector can join a machine');
				}
				const authKey = String(decryptedConfig(plugin).auth_key ?? '');
				if (!authKey) throw error(400, 'set the Tailscale auth key first');
				await ensureTailscale(botId, authKey);
			}
			return json(await tailscaleStatus(botId));
		} catch (e) {
			// A refused input above keeps its status; a Docker or sidecar failure
			// is an upstream problem, not a 500 with no message.
			if (isHttpError(e)) throw e;
			throw error(502, `tailscale join failed: ${(e as Error).message}`);
		}
	}
	throw error(400, 'unknown action');
};

export const DELETE: RequestHandler = ({ params }) => {
	uninstallConnector(params.id);
	return new Response(null, { status: 204 });
};
