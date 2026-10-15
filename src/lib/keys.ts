/**
 * The keyboard contract the message composers share: Enter sends, Shift+Enter
 * is a newline. An IME candidate window also produces Enter keydowns - with
 * `isComposing` set - and treating those as "send" fires the half-typed text
 * the moment a CJK reader confirms a candidate.
 */
export function sendOnEnter(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>): boolean {
	return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}
