/** A model-specific OpenAI-compatible endpoint supplied by the operator. */
export interface ModelRoute {
	baseUrl: string;
	apiKey: string;
	contextWindow?: number;
	maxTokens?: number;
}

function optionalLimit(value: unknown, key: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`LLM_MODEL_ROUTES_JSON ${key} must be a positive integer`);
	}
	return value;
}

/**
 * Parse the server-only map from model IDs to additional provider endpoints.
 * The primary provider remains the settings-backed default; routes let one
 * bot use a local model while the rest keep their current provider.
 */
export function parseModelRoutes(raw: string | undefined): Record<string, ModelRoute> {
	if (!raw?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('LLM_MODEL_ROUTES_JSON must be valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('LLM_MODEL_ROUTES_JSON must be an object keyed by model ID');
	}
	const routes: Record<string, ModelRoute> = {};
	for (const [rawModel, value] of Object.entries(parsed)) {
		const model = rawModel.trim();
		if (!model || model.length > 120 || /[\0-\x1f\x7f]/.test(model)) {
			throw new Error('LLM_MODEL_ROUTES_JSON contains an invalid model ID');
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`LLM_MODEL_ROUTES_JSON route for ${model} must be an object`);
		}
		const route = value as Record<string, unknown>;
		const rawBaseUrl = route.baseUrl ?? route.base_url;
		if (typeof rawBaseUrl !== 'string' || !rawBaseUrl.trim()) {
			throw new Error(`LLM_MODEL_ROUTES_JSON route for ${model} needs baseUrl`);
		}
		let url: URL;
		try {
			url = new URL(rawBaseUrl.trim());
		} catch {
			throw new Error(`LLM_MODEL_ROUTES_JSON route for ${model} has an invalid baseUrl`);
		}
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
			throw new Error(`LLM_MODEL_ROUTES_JSON route for ${model} needs an http(s) baseUrl without embedded credentials`);
		}
		const apiKey = route.apiKey ?? route.api_key ?? '';
		if (typeof apiKey !== 'string') {
			throw new Error(`LLM_MODEL_ROUTES_JSON route for ${model} apiKey must be a string`);
		}
		const contextWindow = optionalLimit(route.contextWindow ?? route.context_window, 'contextWindow');
		const maxTokens = optionalLimit(route.maxTokens ?? route.max_tokens, 'maxTokens');
		if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) {
			throw new Error(`LLM_MODEL_ROUTES_JSON route for ${model} maxTokens cannot exceed contextWindow`);
		}
		routes[model] = {
			baseUrl: rawBaseUrl.trim().replace(/\/+$/, ''),
			apiKey,
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {})
		};
	}
	return routes;
}
