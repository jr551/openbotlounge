import { describe, expect, it } from 'vitest';
import { sendOnEnter } from './keys';

const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

describe('sendOnEnter', () => {
	it('sends on a plain Enter', () => {
		expect(sendOnEnter(ev({ key: 'Enter', shiftKey: false, isComposing: false }))).toBe(true);
	});

	it('keeps Shift+Enter as a newline', () => {
		expect(sendOnEnter(ev({ key: 'Enter', shiftKey: true, isComposing: false }))).toBe(false);
	});

	it('never sends the Enter that confirms an IME candidate', () => {
		// CJK input emits Enter keydowns with isComposing while the candidate
		// window is open; sending there fires half-typed text.
		expect(sendOnEnter(ev({ key: 'Enter', shiftKey: false, isComposing: true }))).toBe(false);
	});

	it('ignores other keys', () => {
		expect(sendOnEnter(ev({ key: 'a', shiftKey: false, isComposing: false }))).toBe(false);
	});
});
