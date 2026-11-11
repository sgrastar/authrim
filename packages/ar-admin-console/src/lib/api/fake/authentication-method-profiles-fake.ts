import { createFakeProfileStore, type FakeProfilesOptions } from './profile-fake-core';
import type {
	AuthenticationMethodProfile,
	AuthenticationMethodProfilesClient
} from '../authentication-method-profiles';

const defaults = {
	'authentication-methods.passkey.signup_enabled': true,
	'authentication-methods.passkey.login_enabled': true,
	'authentication-methods.passkey.reauth_enabled': true,
	'authentication-methods.passkey.account_link_enabled': true,
	'authentication-methods.email_otp.signup_enabled': true,
	'authentication-methods.email_otp.login_enabled': true,
	'authentication-methods.email_otp.reauth_enabled': true,
	'authentication-methods.email_otp.account_link_enabled': true,
	'authentication-methods.totp.signup_enabled': false,
	'authentication-methods.totp.login_enabled': false,
	'authentication-methods.totp.reauth_enabled': false,
	'authentication-methods.totp.account_link_enabled': false,
	'authentication-methods.did.login_enabled': false,
	'authentication-methods.directory_password.enabled': false,
	'authentication-methods.guest.login_enabled': false,
	'authentication-methods.passkey.guest_upgrade_enabled': true,
	'authentication-methods.email_otp.guest_upgrade_enabled': true
};

export function createFakeAuthenticationMethodProfiles(
	initial: AuthenticationMethodProfile[] = [],
	options: FakeProfilesOptions = {}
): AuthenticationMethodProfilesClient {
	return createFakeProfileStore(
		'amp_',
		defaults,
		initial,
		options
	) as AuthenticationMethodProfilesClient;
}
