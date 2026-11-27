import { describe, expect, it } from 'vitest';
import { parseModelRoutes } from './model-routes';

describe('parseModelRoutes', () => {
	it('maps model IDs to local OpenAI-compatible endpoints and normalizes trailing slashes', () => {
		expect(
			parseModelRoutes(
				JSON.stringify({
					'inkling-2-mini-uncensored': {
						baseUrl: 'http://192.168.69.110:8080/v1/',
						apiKey: '',
						contextWindow: 32_768,
						maxTokens: 4_096
					}
				})
			)
		).toEqual({
			'inkling-2-mini-uncensored': {
				baseUrl: 'http://192.168.69.110:8080/v1',
				apiKey: '',
				contextWindow: 32_768,
				maxTokens: 4_096
			}
		});
	});

	it('returns an empty map when no extra routes are configured', () => {
		expect(parseModelRoutes(undefined)).toEqual({});
		expect(parseModelRoutes('  ')).toEqual({});
	});

	it.each([
		'{',
		'[]',
		JSON.stringify({ model: { baseUrl: 'ftp://example.test/v1' } }),
		JSON.stringify({ model: { baseUrl: 'http://user:pass@example.test/v1' } }),
		JSON.stringify({ model: { baseUrl: 'http://example.test/v1', maxTokens: 5, contextWindow: 4 } })
	])('rejects invalid route configuration %s', (raw) => {
		expect(() => parseModelRoutes(raw)).toThrow('LLM_MODEL_ROUTES_JSON');
	});
});
