/** Tracks which provider check is current and avoids repeating an unchanged probe. */
export class ProviderProbeTracker {
	private revision = 0;
	private lastKey = '';

	/** Invalidate the current result and allow the same model to be checked again. */
	invalidate(): void {
		this.revision++;
		this.lastKey = '';
	}

	/** Start a new check, or return null when this endpoint/model was already checked. */
	begin(key: string): number | null {
		if (key === this.lastKey) return null;
		this.lastKey = key;
		return ++this.revision;
	}

	/** Older responses must not replace the result for a newer form state. */
	isCurrent(revision: number): boolean {
		return revision === this.revision;
	}

	/** A failed probe may be retried; a successful unchanged one stays deduped. */
	complete(revision: number, ok: boolean): void {
		if (!this.isCurrent(revision)) return;
		if (!ok) this.lastKey = '';
	}
}
