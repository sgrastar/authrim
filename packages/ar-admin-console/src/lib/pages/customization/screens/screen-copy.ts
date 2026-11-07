/**
 * The words of the screen builder, from the console's messages (`messages/screens`): each part's
 * name and description, the part groups, the settings and the sign-in methods.
 */
import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { Method, PartGroup } from './screen-model.js';

/** A setting's words, by its key after `sc.set.` (`label`, `showLabel`…). */
export const setting = (key: string, params?: Record<string, string | number>) =>
	t(`sc.set.${key}` as MessageKey, params);

/** A part's name; an unknown kind is shown as it is. */
export function partName(kind: string): string {
	const key = `sc.part.${kind}` as MessageKey;
	const name = t(key);
	return name === key ? kind : name;
}

export const partDescription = (kind: string) => t(`sc.part.${kind}.desc` as MessageKey);

export const groupName = (group: PartGroup) => t(`sc.group.${group}` as MessageKey);

const METHOD_KEYS: Record<Method, string> = {
	passkey: 'methodPasskey',
	mail_otp: 'methodMailOtp',
	mail_otp_totp: 'methodMailOtpTotp',
	totp: 'methodTotp',
	external_idp: 'methodExternal',
	directory_password: 'methodDirectory'
};

export const methodName = (method: Method) => setting(METHOD_KEYS[method]);
