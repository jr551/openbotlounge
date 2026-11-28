/** A small FIFO concurrency gate for one provider endpoint. */
export class ProviderGate {
	private active = 0;
	private readonly limit: number;
	private waiters: {
		resolve: (release: () => void) => void;
		reject: (error: unknown) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}[] = [];

	constructor(limit: number) {
		this.limit = limit;
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new Error('provider concurrency must be a positive integer');
		}
	}

	/** Wait for a slot, or reject immediately when the caller is already aborted. */
	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve(this.releaser());
		}
		return new Promise((resolve, reject) => {
			const waiter: {
				resolve: (release: () => void) => void;
				reject: (error: unknown) => void;
				signal?: AbortSignal;
				onAbort?: () => void;
			} = { resolve, reject, signal };
			waiter.onAbort = () => {
				const at = this.waiters.indexOf(waiter);
				if (at >= 0) this.waiters.splice(at, 1);
				reject(signal?.reason ?? new Error('aborted'));
			};
			this.waiters.push(waiter);
			signal?.addEventListener('abort', waiter.onAbort, { once: true });
		});
	}

	private releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			const next = this.waiters.shift();
			if (!next) return;
			if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
			this.active++;
			next.resolve(this.releaser());
		};
	}
}
