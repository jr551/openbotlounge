/**
 * The one ModelRuntime the app's bot turns share.
 *
 * It lives in its own module because both llm.ts (which syncs refreshed OAuth
 * tokens into it) and pi-bridge.ts (which registers the provider and builds
 * sessions on it) need it, and importing the bridge from llm would close a
 * cycle through tools.ts.
 *
 * The runtime is deliberately inert: in-memory credentials and model stores,
 * no models.json, no create-time catalogue refresh. The app's settings table
 * stays the credential store of record; pi's file-backed one is not used.
 */
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';

/** The provider id the app's configured endpoint registers under. */
export const LOUNGE_PROVIDER_ID = 'openbotlounge';

let runtime: Promise<ModelRuntime> | null = null;

/** The shared runtime, created once per process. */
export function loungeRuntime(): Promise<ModelRuntime> {
	runtime ??= ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false
	});
	return runtime;
}
