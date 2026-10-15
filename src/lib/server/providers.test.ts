import { describe, expect, it } from 'vitest';
import { PROVIDERS, providerById, providerForBaseUrl } from '../providers';

/**
 * The catalogue is the one place a wrong endpoint would be invisible until a
 * user's first call fails, so its shape is pinned: no trailing slash (the app
 * appends `/chat/completions` to whatever is stored) and nothing but http(s).
 */
describe('the provider catalogue', () => {
	it('offers no trailing slash and no non-http endpoint', () => {
		for (const provider of PROVIDERS) {
			if (provider.baseUrl) {
				expect(provider.baseUrl, provider.id).toMatch(/^https?:\/\/[^/]+/);
				expect(provider.baseUrl, provider.id).not.toMatch(/\/$/);
			}
		}
	});

	it('gives every entry a distinct id, a mark and an auth story', () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const provider of PROVIDERS) {
			expect(provider.mark.length, provider.id).toBeGreaterThan(0);
			expect(provider.note.length, provider.id).toBeGreaterThan(20);
			if (provider.auth === 'key' && provider.id !== 'custom') {
				expect(provider.models.length, provider.id).toBeGreaterThan(0);
			}
		}
	});

	it('recognises the endpoint the picker would have filled in', () => {
		for (const provider of PROVIDERS) {
			if (!provider.baseUrl) continue;
			expect(providerForBaseUrl(provider.baseUrl)?.id, provider.id).toBe(provider.id);
			// A saved base URL with the slash the API strips is still recognised.
			expect(providerForBaseUrl(`${provider.baseUrl}/`)?.id, provider.id).toBe(provider.id);
		}
		expect(providerForBaseUrl('http://nas:11434/v1')).toBeUndefined();
		expect(providerById('nope')).toBeUndefined();
	});
});
