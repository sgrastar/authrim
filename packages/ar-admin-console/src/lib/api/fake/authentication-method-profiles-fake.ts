import type {
	AuthenticationMethodProfile,
	AuthenticationMethodProfileInput,
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
	initial: AuthenticationMethodProfile[] = []
): AuthenticationMethodProfilesClient {
	const profiles = new Map<string, AuthenticationMethodProfile>();
	profiles.set('default', {
		id: 'default',
		name: 'Default',
		is_system: true,
		values: { ...defaults },
		version: 'rev-1',
		created_at: null,
		updated_at: null
	});
	for (const profile of initial) profiles.set(profile.id, structuredClone(profile));
	let next = 1;
	return {
		async list() {
			return [...profiles.values()].map((item) => structuredClone(item));
		},
		async get(id) {
			const profile = profiles.get(id);
			if (!profile) throw new Error('Profile not found');
			return structuredClone(profile);
		},
		async create(input: AuthenticationMethodProfileInput) {
			const now = Date.now();
			const profile: AuthenticationMethodProfile = {
				id: `amp_${next++}`,
				name: input.name,
				values: structuredClone(input.values),
				is_system: false,
				version: 1,
				created_at: now,
				updated_at: now
			};
			profiles.set(profile.id, profile);
			return structuredClone(profile);
		},
		async update(id, version, input) {
			const before = profiles.get(id);
			if (!before || before.version !== version) throw new Error('Profile changed');
			const profile = {
				...before,
				name: input.name,
				values: structuredClone(input.values),
				version: typeof version === 'number' ? version + 1 : 'rev-2',
				updated_at: Date.now()
			};
			profiles.set(id, profile);
			return structuredClone(profile);
		},
		async remove(id) {
			profiles.delete(id);
		}
	};
}
