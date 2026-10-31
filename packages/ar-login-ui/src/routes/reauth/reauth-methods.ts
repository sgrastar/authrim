import type { AuthenticationMethods } from '$lib/api/authentication-methods';

/**
 * The methods the re-authentication screen offers, and whether it asks for human verification:
 * what the tenant allows for re-authentication (`reauthEnabled`), which is not what it allows for
 * sign-in (`loginEnabled`). A method turned on for sign-in only is not offered; one turned on for
 * re-authentication only is. The authentication APIs check the same switch for a re-authentication
 * challenge, so a method shown here is one the API accepts. Settings that predate the separate
 * switches have none and fall back to `enabled`.
 */
export function resolveReauthMethods(methods: AuthenticationMethods): {
	passkey: boolean;
	emailCode: boolean;
	totp: boolean;
	humanVerification: boolean;
} {
	return {
		passkey: methods.passkey.reauthEnabled ?? methods.passkey.enabled,
		emailCode: methods.emailCode.reauthEnabled ?? methods.emailCode.enabled,
		totp: methods.totp.reauthEnabled ?? methods.totp.enabled,
		humanVerification: methods.humanVerification.enabled && methods.humanVerification.reauthEnabled
	};
}
