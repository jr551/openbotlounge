/**
 * Tiny WebAudio blips for UI feedback. No assets - each sound is a short
 * oscillator envelope synthesized on the fly. The AudioContext is created
 * lazily on the first user-gesture-triggered call (browsers block audio
 * before interaction anyway, so a context made at module load would start
 * suspended and never play).
 *
 * Everything here is a no-op when audio is unavailable or still locked, so
 * callers can fire-and-forget without guarding.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
	if (typeof AudioContext === 'undefined') return null;
	if (!ctx) {
		try {
			ctx = new AudioContext();
		} catch {
			return null;
		}
	}
	if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
	return ctx.state === 'suspended' ? null : ctx;
}

/** One enveloped oscillator note. */
function blip(freq: number, durMs: number, type: OscillatorType, gain: number, when = 0): void {
	const ac = audio();
	if (!ac) return;
	const t0 = ac.currentTime + when;
	const osc = ac.createOscillator();
	const g = ac.createGain();
	osc.type = type;
	osc.frequency.value = freq;
	g.gain.setValueAtTime(0, t0);
	g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
	g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
	osc.connect(g).connect(ac.destination);
	osc.start(t0);
	osc.stop(t0 + durMs / 1000 + 0.02);
}

/** Outgoing message: a short soft tick upward. */
export function sndSend(): void {
	blip(660, 90, 'sine', 0.08);
	blip(880, 120, 'sine', 0.07, 0.05);
}

/** Incoming reply: a two-note pop downward. */
export function sndReceive(): void {
	blip(880, 90, 'sine', 0.08);
	blip(587, 140, 'sine', 0.07, 0.06);
}

/** Task finished: a small three-note chime. */
export function sndDone(): void {
	blip(523, 100, 'triangle', 0.07);
	blip(659, 100, 'triangle', 0.07, 0.07);
	blip(784, 160, 'triangle', 0.07, 0.14);
}

/** Error/failure: a low dull thud. */
export function sndError(): void {
	blip(196, 180, 'square', 0.05);
	blip(147, 220, 'square', 0.04, 0.08);
}

/** Toggle flip (lightswitch): a quick click. */
export function sndClick(): void {
	blip(1200, 40, 'square', 0.05);
}
