export type DestinationConsentScope = 'tenant_default' | 'client_override';

export type DestinationConsentMode = 'once' | 'every_time' | 'until_attributes_change';

export type DestinationLegalBasis =
	| 'consent'
	| 'legal_obligation'
	| 'contract'
	| 'legitimate_interest';

export interface DestinationConsentSettingsDraft {
	scope: DestinationConsentScope;
	profileId: string;
	clientId: string;
	consentMode: DestinationConsentMode;
	legalBasis: DestinationLegalBasis;
	purpose: string;
	attributeSetPolicyVersion: string;
	termsVersion: string;
	privacyPolicyVersion: string;
	regulatedPurposeGuard: boolean;
	challengeExperience: 'login_flow' | 'step_up_required';
	rawValueDisplay: 'hidden';
}

export function createDestinationConsentSettingsDraft(
	profileId: string,
	scope: DestinationConsentScope = 'tenant_default'
): DestinationConsentSettingsDraft {
	return {
		scope,
		profileId,
		clientId: '',
		consentMode: 'until_attributes_change',
		legalBasis: 'consent',
		purpose: 'profile_release',
		attributeSetPolicyVersion: 'release-policy-v1',
		termsVersion: 'current',
		privacyPolicyVersion: 'current',
		regulatedPurposeGuard: true,
		challengeExperience: 'login_flow',
		rawValueDisplay: 'hidden'
	};
}

export function summarizeDestinationConsentSettings(
	settings: DestinationConsentSettingsDraft
): string {
	const scopeLabel =
		settings.scope === 'tenant_default' ? 'tenant default' : `client override ${settings.clientId}`;
	const challengeLabel =
		settings.challengeExperience === 'login_flow' ? 'login flow challenge' : 'step-up challenge';
	const guardLabel = settings.regulatedPurposeGuard ? 'purpose guard enabled' : 'purpose guard off';
	return `${scopeLabel}: ${settings.legalBasis}, ${settings.consentMode}, ${settings.purpose}, ${challengeLabel}, ${guardLabel}`;
}
