/** The part of a keyboard event that deciding about Enter needs. */
export type EnterKeyEvent = {
	key: string;
	isComposing?: boolean;
	keyCode?: number;
	preventDefault: () => void;
};

/**
 * Enter in a one-time-code field submits that code. The browser's own reaction to Enter (an
 * implicit submit of the surrounding form) is stopped: that form belongs to the sign-in step
 * (it sends the email code), not to the code being typed. Enter that confirms an IME conversion
 * is left alone. Returns whether the key was handled.
 */
export function handleCodeEnterKey(event: EnterKeyEvent, submit: () => void): boolean {
	if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) {
		return false;
	}
	event.preventDefault();
	submit();
	return true;
}
