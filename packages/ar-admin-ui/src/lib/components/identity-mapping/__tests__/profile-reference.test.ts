import { describe, expect, it } from 'vitest';
import { profileReferencesMatch } from '../profile-reference';

describe('field mapping profile references', () => {
	it('matches persisted source profile ids with editor ids', () => {
		expect(
			profileReferencesMatch('source_profile_scim', 'source-profile-source_profile_scim', 'source')
		).toBe(true);
	});

	it('matches persisted destination profile ids with editor ids', () => {
		expect(
			profileReferencesMatch(
				'destination_profile_oidc',
				'destination-profile-destination_profile_oidc',
				'destination'
			)
		).toBe(true);
	});

	it('matches ids that already contain the UI prefix before graph normalization', () => {
		expect(
			profileReferencesMatch(
				'destination-profile-oidc-core',
				'destination-profile-destination-profile-oidc-core',
				'destination'
			)
		).toBe(true);
	});

	it('does not match unrelated profiles', () => {
		expect(
			profileReferencesMatch(
				'destination_profile_oidc',
				'destination-profile-destination_profile_saml',
				'destination'
			)
		).toBe(false);
	});
});
