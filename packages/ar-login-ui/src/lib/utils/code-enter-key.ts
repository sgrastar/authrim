/** The part of a keyboard event that deciding about Enter needs. */
export type EnterKeyEvent = {
	key: string;
	isComposing?: boolean;
	keyCode?: number;
	preventDefault: () => void;
};

/**
 * Enter in a one-time-code field submits that code. The browser's own reaction to Enter (an
 * implicit submit of the surrounding form, or a click on its default button, which sends the
 * email code) is always stopped: that form belongs to the sign-in step, not to the code being
 * typed. An Enter that confirms an IME conversion only has that default stopped (the browser
 * itself keeps the conversion going); it does not submit the code. Returns whether the code was
 * submitted.
 */
export function handleCodeEnterKey(event: EnterKeyEvent, submit: () => void): boolean {
	if (event.key !== 'Enter') {
		return false;
	}
	event.preventDefault();
	if (event.isComposing || event.keyCode === 229) {
		return false;
	}
	submit();
	return true;
}
