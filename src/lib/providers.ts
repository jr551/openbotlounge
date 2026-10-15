/**
 * The provider catalogue behind Settings → Models. It is deliberately small and
 * entirely public: a display name, the OpenAI-compatible base URL the provider
 * documents, and a handful of model ids it lists today. Nothing is fetched at
 * runtime and no logo is downloaded — each entry carries a coloured monogram
 * drawn in the dialog, so nothing in the UI implies a partnership.
 *
 * URLs and model ids were read from the providers' own documentation, cited
 * beside each entry. Model ids move; the picker's model field stays free text,
 * so an id this list has never heard of is still accepted.
 */
interface Provider {
	/** Stable id, used by the picker and by the OAuth routes. */
	id: string;
	/** Display name. */
	name: string;
	/** Base URL without a trailing slash; '' when the user supplies one. */
	baseUrl: string;
	/** Model ids offered as suggestions. */
	models: string[];
	/** Monogram shown in the picker (never a downloaded logo). */
	mark: string;
	/** Monogram colour. */
	tint: string;
	/** How the provider authenticates. `oauth` means this app can sign in for you. */
	auth: 'key' | 'oauth';
	/** One honest line about authentication, shown under the picker. */
	note: string;
	/** Placeholder for the base URL field when the user has to supply one. */
	basePlaceholder?: string;
}

/** OpenRouter's OpenAI-compatible base; shared by the picker and the OAuth route. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * The ChatGPT Codex backend a "Sign in with OpenAI" token is scoped to. It is
 * not api.openai.com: the OAuth access token only answers here, and only for
 * the Responses API - llm.ts routes these calls accordingly.
 */
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export const PROVIDERS: Provider[] = [
	{
		id: 'zai',
		name: 'Z.ai',
		// https://docs.z.ai/guides/develop/http/introduction — "General API Endpoint"
		baseUrl: 'https://api.z.ai/api/paas/v4',
		// https://docs.z.ai/llms.txt — the model guides that exist today
		models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4.6'],
		mark: 'Z',
		tint: '#4f8ef7',
		auth: 'key',
		note:
			'Z.ai authenticates with an API key. Its docs describe no OAuth flow for a third-party app. ' +
			'GLM Coding Plan subscribers call https://api.z.ai/api/coding/paas/v4 instead.'
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		// https://api-docs.deepseek.com/ — "base_url (OpenAI)"
		baseUrl: 'https://api.deepseek.com',
		// https://api-docs.deepseek.com/ — the model names it documents
		models: ['deepseek-flash', 'deepseek-v4-pro'],
		mark: 'D',
		tint: '#5b6cff',
		auth: 'key',
		note:
			'DeepSeek takes an API key only — its docs describe no OAuth flow for a self-hosted app.'
	},
	{
		id: 'openai',
		name: 'OpenAI',
		// https://developers.openai.com/api/reference/overview — the REST API is v1
		baseUrl: 'https://api.openai.com/v1',
		// https://developers.openai.com/api/docs/models — the featured models
		models: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
		mark: 'O',
		tint: '#10a37f',
		auth: 'key',
		note:
			'An API key bills against platform credit. To spend a ChatGPT ' +
			'subscription instead, pick ChatGPT and sign in.'
	},
	{
		id: 'chatgpt',
		name: 'ChatGPT',
		// The OAuth token is scoped to the Codex backend, not api.openai.com.
		baseUrl: CHATGPT_BASE_URL,
		// https://github.com/openai/codex — the models the Codex backend serves
		models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
		mark: 'CG',
		tint: '#10a37f',
		auth: 'oauth',
		note:
			'Sign in with your ChatGPT account and calls run on the subscription, ' +
			'the same way Codex CLI and opencode do. You get a code to type at ' +
			'auth.openai.com; nothing is copied by hand.'
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		// https://openrouter.ai/docs/guides/overview/auth/oauth — the exchange target
		baseUrl: OPENROUTER_BASE_URL,
		// https://openrouter.ai/api/v1/models, filtered to the current flagships.
		// First in the list is the model picking this provider fills in, and the
		// app's default driver model.
		models: [
			'deepseek/deepseek-v4.1-flash',
			'openai/gpt-5.6-terra',
			'anthropic/claude-sonnet-5',
			'google/gemini-3.8-flash'
		],
		mark: 'OR',
		tint: '#8b5cf6',
		auth: 'oauth',
		note:
			'OpenRouter signs in with PKCE and issues this app a key, so there is nothing to copy. ' +
			'The key is stored on the server and never sent back to this page.'
	},
	{
		id: 'custom',
		name: 'Custom',
		baseUrl: '',
		models: [],
		mark: '+',
		tint: '#8a8a93',
		auth: 'key',
		basePlaceholder: 'http://localhost:11434/v1',
		note:
			'Any OpenAI-compatible endpoint: Ollama, LM Studio, vLLM or a gateway. ' +
			'A local server usually needs no key.'
	}
];

export function providerById(id: string): Provider | undefined {
	return PROVIDERS.find((p) => p.id === id);
}

/** The catalogue entry the configured base URL belongs to, if any. */
export function providerForBaseUrl(baseUrl: string): Provider | undefined {
	const target = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
	if (!target) return undefined;
	return PROVIDERS.find(
		(p) => p.baseUrl !== '' && p.baseUrl.toLowerCase().replace(/\/+$/, '') === target
	);
}
