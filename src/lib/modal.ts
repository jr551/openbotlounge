/**
 * The keyboard contract every modal in the app shares: Escape closes it and
 * Tab cycles inside it. Each dialog wires this to <svelte:window> and guards
 * it with its own `open` flag.
 */

/** Tab stops inside the dialog, in document order. */
function focusables(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(
		'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
	)].filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
}

/** The same Escape press must not also close a dialog stacked under this one. */
type ClaimedEscape = KeyboardEvent & { oblEscapeHandled?: boolean };

/**
 * Escape closes the dialog - but only while the keyboard is in it, so a
 * dialog stacked on top can't be closed by the same key press, and only
 * once. Tab is held in the modal for the same reason: nothing behind it
 * should take focus.
 */
export function modalKeydown(e: KeyboardEvent, dialog: HTMLElement | null, close: () => void) {
	if (e.key === 'Escape') {
		const holder = document.activeElement?.closest('[role="dialog"]');
		if (holder && holder !== dialog) return;
		const claimed = e as ClaimedEscape;
		if (claimed.oblEscapeHandled) return;
		claimed.oblEscapeHandled = true;
		close();
		return;
	}
	if (e.key !== 'Tab' || !dialog) return;
	const items = focusables(dialog);
	if (!items.length) return;
	const at = document.activeElement ? items.indexOf(document.activeElement as HTMLElement) : -1;
	if (e.shiftKey ? at <= 0 : at === -1 || at === items.length - 1) {
		e.preventDefault();
		(e.shiftKey ? items[items.length - 1] : items[0]).focus();
	}
}
