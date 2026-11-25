/**
 * Tiny WebAudio chimes for UI feedback. No assets - each sound is a short
 * enveloped sine, kept mellow on purpose: slow attack, no square waves, and
 * everything through one lowpass so nothing ever rasps. The AudioContext is
 * created lazily on the first user-gesture-triggered call (browsers block
 * audio before interaction anyway, so a context made at module load would
 * start suspended and never play).
 *
 * Everything here is a no-op when audio is unavailable, still locked, or
 * muted in Settings, so callers can fire-and-forget without guarding.
 */

const MUTE_KEY = 'obl-sound';

/** False when the human switched interface sounds off in Settings. */
export function soundEnabled(): boolean {
	try {
		return localStorage.getItem(MUTE_KEY) !== 'off';
	} catch {
		return true;
	}
}

export function setSoundEnabled(on: boolean): void {
	try {
		localStorage.setItem(MUTE_KEY, on ? 'on' : 'off');
	} catch {
		// Private mode or no storage: the sounds just stay as they are.
	}
}

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;

function audio(): AudioContext | null {
	if (typeof AudioContext === 'undefined' || !soundEnabled()) return null;
	if (!ctx) {
		try {
			ctx = new AudioContext();
			// One gentle lowpass for the whole kit: takes the digital edge off
			// every note without changing any of the written pitches.
			const filter = ctx.createBiquadFilter();
			filter.type = 'lowpass';
			filter.frequency.value = 2600;
			filter.Q.value = 0.4;
			bus = ctx.createGain();
			bus.gain.value = 0.9;
			filter.connect(bus).connect(ctx.destination);
		} catch {
			return null;
		}
	}
	if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
	return ctx.state === 'suspended' ? null : ctx;
}

interface Note {
	freq: number;
	/** Glide target; unset holds the pitch. Used for the soft downward sigh. */
	freqEnd?: number;
	durMs: number;
	gain: number;
	when?: number;
}

/** One enveloped sine note: slow attack, natural decay, optional glide. */
function note({ freq, freqEnd, durMs, gain, when = 0 }: Note): void {
	const ac = audio();
	if (!ac || !bus) return;
	const t0 = ac.currentTime + when;
	const osc = ac.createOscillator();
	const g = ac.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(freq, t0);
	if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + durMs / 1000);
	// Raised-attack: no click at the start, then a natural exponential fall.
	g.gain.setValueAtTime(0, t0);
	g.gain.linearRampToValueAtTime(gain, t0 + 0.045);
	g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
	osc.connect(g).connect(bus);
	osc.start(t0);
	osc.stop(t0 + durMs / 1000 + 0.05);
}

/** Outgoing message: a soft two-note lift. */
export function sndSend(): void {
	note({ freq: 659.25, durMs: 170, gain: 0.11 });
	note({ freq: 987.77, durMs: 240, gain: 0.09, when: 0.08 });
}

/** Incoming reply: a gentle two-note fall. */
export function sndReceive(): void {
	note({ freq: 523.25, durMs: 170, gain: 0.11 });
	note({ freq: 392.0, durMs: 260, gain: 0.1, when: 0.09 });
}

/** Task finished: a small major arpeggio. */
export function sndDone(): void {
	note({ freq: 523.25, durMs: 200, gain: 0.1 });
	note({ freq: 659.25, durMs: 200, gain: 0.1, when: 0.1 });
	note({ freq: 783.99, durMs: 340, gain: 0.11, when: 0.2 });
}

/** Error/failure: a low downward sigh, not a buzz. */
export function sndError(): void {
	note({ freq: 220, freqEnd: 185, durMs: 280, gain: 0.1 });
	note({ freq: 174.61, durMs: 340, gain: 0.09, when: 0.16 });
}

/** Toggle flip: a short soft tick. */
export function sndClick(): void {
	note({ freq: 1250, durMs: 45, gain: 0.035 });
}
