/**
 * Enter in the email field of the sign-in form. What it does follows the methods the page offers
 * (the ones it shows, so the tenant's settings, the Flow step and the like are already applied):
 *
 * - only the email code: it sends the code, as before;
 * - only the authenticator app: it goes on to the authenticator-app code screen, as the
 *   "sign in with authenticator app" button does;
 * - both, or neither: nothing. With both there is no telling which one was meant, so only the
 *   buttons act; with neither there is nothing to send, and an email code is never sent for a
 *   method the page does not offer.
 */
export type EmailFieldEnterAction = 'send_email_code' | 'start_totp' | 'ignore';

export type EmailFieldEnterMethods = {
	emailCode: boolean;
	totp: boolean;
};

export type EmailFieldEnterEvent = {
	key: string;
	isComposing?: boolean;
	keyCode?: number;
	preventDefault: () => void;
};

/**
 * The entries the page offers. A runtime screen reports what it draws; the classic sign-in, when
 * it is drawn too (a runtime step that is not an authentication step leaves it in place), adds
 * its own. Without a runtime screen the classic sign-in is all there is.
 */
export function combineEntryMethods(
	runtimeScreen: EmailFieldEnterMethods | null,
	classic: EmailFieldEnterMethods,
	classicShown: boolean
): EmailFieldEnterMethods {
	if (!runtimeScreen) return classic;
	if (!classicShown) return runtimeScreen;
	return {
		emailCode: runtimeScreen.emailCode || classic.emailCode,
		totp: runtimeScreen.totp || classic.totp
	};
}

export function resolveEmailFieldEnter(methods: EmailFieldEnterMethods): EmailFieldEnterAction {
	if (methods.emailCode && !methods.totp) return 'send_email_code';
	if (methods.totp && !methods.emailCode) return 'start_totp';
	return 'ignore';
}

/**
 * Applies the rule to a key event in the email field. The browser's own reaction to Enter (an
 * implicit submit of the form, which sends the email code) is stopped unless the rule is to send
 * the email code. Returns the action, or null when the key is not an Enter that counts (another
 * key, or an Enter that confirms an IME conversion).
 */
export function handleEmailFieldEnterKey(
	event: EmailFieldEnterEvent,
	methods: EmailFieldEnterMethods,
	handlers: { startTotp: () => void }
): EmailFieldEnterAction | null {
	if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return null;
	const action = resolveEmailFieldEnter(methods);
	if (action === 'send_email_code') return action;
	event.preventDefault();
	if (action === 'start_totp') handlers.startTotp();
	return action;
}
