/**
 * Which sign-in methods a Flow runtime screen really offers. A screen lists its blocks, and a
 * block can be hidden by its display condition or by the layout row it sits in, or left out
 * because the method is not available; what the person sees is what is left. The rules here are
 * the ones RuntimeScreen draws with, so the page can tell what an Enter key would act on.
 */
export type RuntimeScreenAuthMethod =
	| 'passkey'
	| 'mail_otp'
	| 'mail_otp_totp'
	| 'totp'
	| 'external_idp'
	| 'directory_password';

export type RuntimeScreenBlock = {
	block_type?: string;
	auth_method?: string | null;
	display_condition?: {
		mode?: string;
		feature?: RuntimeScreenAuthMethod | null;
	} | null;
};

export type RuntimeScreenMethodAvailability = (method: RuntimeScreenAuthMethod) => boolean;

/** Whether a block's display condition lets it show. */
export function isDisplayConditionMet(
	block: RuntimeScreenBlock,
	isAvailable: RuntimeScreenMethodAvailability
): boolean {
	const condition = block.display_condition;
	if (!condition || condition.mode === 'always') return true;
	if (condition.mode === 'hidden') return false;
	if (condition.mode === 'feature_enabled') {
		return condition.feature ? isAvailable(condition.feature) : false;
	}
	return true;
}

/** The method an authentication widget stands for (an unknown one is the passkey). */
export function authWidgetMethod(block: RuntimeScreenBlock): RuntimeScreenAuthMethod {
	const method = block.auth_method ?? 'passkey';
	if (
		method === 'mail_otp' ||
		method === 'mail_otp_totp' ||
		method === 'totp' ||
		method === 'external_idp' ||
		method === 'directory_password' ||
		method === 'passkey'
	) {
		return method;
	}
	return 'passkey';
}

/**
 * The email code and authenticator-app entries among the blocks that are on the screen (hidden
 * blocks already left out).
 */
export function shownEntryMethods(
	shownBlocks: RuntimeScreenBlock[],
	isAvailable: RuntimeScreenMethodAvailability
): { emailCode: boolean; totp: boolean } {
	let emailCode = false;
	let totp = false;
	for (const block of shownBlocks) {
		if ((block.block_type ?? 'identity_field') !== 'auth_widget') continue;
		const method = authWidgetMethod(block);
		if (method === 'mail_otp' && isAvailable('mail_otp')) emailCode = true;
		if (method === 'totp' && isAvailable('totp')) totp = true;
		if (method === 'mail_otp_totp') {
			if (isAvailable('mail_otp')) emailCode = true;
			if (isAvailable('totp')) totp = true;
		}
	}
	return { emailCode, totp };
}
