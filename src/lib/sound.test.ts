import { describe, expect, it } from 'vitest';
import { setSoundEnabled, sndClick, sndDone, sndError, sndReceive, sndSend, soundEnabled } from './sound';

describe('interface sounds', () => {
	it('are silent no-ops without a browser AudioContext', () => {
		expect(() => {
			sndSend();
			sndReceive();
			sndDone();
			sndError();
			sndClick();
		}).not.toThrow();
	});

	it('mute round-trips without storage', () => {
		expect(soundEnabled()).toBe(true);
		expect(() => setSoundEnabled(false)).not.toThrow();
		sndSend();
		expect(() => setSoundEnabled(true)).not.toThrow();
	});
});
