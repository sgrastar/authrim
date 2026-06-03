import { describe, expect, it } from 'vitest';
import {
	createDestinationConsentSettingsDraft,
	summarizeDestinationConsentSettings
} from '../identity-mapping-profile-settings';

describe('identity mapping destination profile settings', () => {
	it('creates privacy-preserving tenant default release consent settings', () => {
		const draft = createDestinationConsentSettingsDraft('profile_oidc');

		expect(draft).toMatchObject({
			scope: 'tenant_default',
			profileId: 'profile_oidc',
			consentMode: 'until_attributes_change',
			legalBasis: 'consent',
			purpose: 'profile_release',
			regulatedPurposeGuard: true,
			rawValueDisplay: 'hidden'
		});
	});

	it('summarizes client overrides without exposing raw attribute values', () => {
		const draft = {
			...createDestinationConsentSettingsDraft('profile_saml', 'client_override'),
			clientId: 'client_academic_sp',
			consentMode: 'every_time' as const
		};

		expect(summarizeDestinationConsentSettings(draft)).toContain(
			'client override client_academic_sp'
		);
		expect(summarizeDestinationConsentSettings(draft)).toContain('every_time');
		expect(summarizeDestinationConsentSettings(draft)).not.toContain('raw');
	});
});
