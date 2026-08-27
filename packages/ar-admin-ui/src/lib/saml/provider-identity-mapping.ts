import type { SAMLDestinationFieldReleaseMode, SAMLProviderConfig } from '$lib/api/admin-saml';

type SAMLIdentityMapping = NonNullable<SAMLProviderConfig['identityMapping']>;

export function buildProviderIdentityMapping(input: {
	existing?: SAMLIdentityMapping;
	selectedFieldMappingSetId: string;
	providerType: 'saml_idp' | 'saml_sp';
	destinationFieldPolicies?: Record<string, SAMLDestinationFieldReleaseMode>;
}): SAMLIdentityMapping | undefined {
	if (!input.selectedFieldMappingSetId) return undefined;

	let preserved: Omit<SAMLIdentityMapping, 'destinationProfileId'> = {};
	if (input.existing?.fieldMappingSetId === input.selectedFieldMappingSetId) {
		preserved = withoutLegacyDestinationProfile(input.existing);
	}

	return {
		...preserved,
		fieldMappingSetId: input.selectedFieldMappingSetId,
		destinationNamespace:
			input.providerType === 'saml_sp'
				? (preserved.destinationNamespace ?? 'saml.attribute')
				: preserved.destinationNamespace,
		destinationFieldPolicies:
			input.providerType === 'saml_sp' ? input.destinationFieldPolicies : undefined
	};
}

function withoutLegacyDestinationProfile(
	identityMapping: SAMLIdentityMapping
): Omit<SAMLIdentityMapping, 'destinationProfileId'> {
	const preserved = { ...identityMapping };
	delete preserved.destinationProfileId;
	return preserved;
}
