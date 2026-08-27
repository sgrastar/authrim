import { describe, expect, it } from 'vitest';
import { buildProviderIdentityMapping } from './provider-identity-mapping';

describe('buildProviderIdentityMapping', () => {
	it('preserves advanced selector fields across normalized save responses', () => {
		const firstSave = buildProviderIdentityMapping({
			existing: {
				fieldMappingSetId: 'mapping-set-1',
				fieldMappingVersionId: 'mapping-version-7',
				sourceProfileId: 'directory-subject',
				destinationProfileId: 'legacy-destination-profile',
				attributeDescriptors: {
					mail: { name: 'mail', friendlyName: 'Email address' }
				}
			},
			selectedFieldMappingSetId: 'mapping-set-1',
			providerType: 'saml_sp',
			destinationFieldPolicies: { mail: 'required' }
		});

		expect(firstSave).toMatchObject({
			fieldMappingVersionId: 'mapping-version-7',
			sourceProfileId: 'directory-subject',
			attributeDescriptors: { mail: { name: 'mail' } },
			destinationFieldPolicies: { mail: 'required' }
		});
		expect(firstSave).not.toHaveProperty('destinationProfileId');

		const normalizedResponse = { ...firstSave };
		const secondSave = buildProviderIdentityMapping({
			existing: normalizedResponse,
			selectedFieldMappingSetId: 'mapping-set-1',
			providerType: 'saml_sp',
			destinationFieldPolicies: { mail: 'optional' }
		});

		expect(secondSave).toMatchObject({
			fieldMappingVersionId: 'mapping-version-7',
			sourceProfileId: 'directory-subject',
			attributeDescriptors: { mail: { name: 'mail' } },
			destinationFieldPolicies: { mail: 'optional' }
		});
	});

	it('clears selector fields that belong to a different Mapping Set', () => {
		const result = buildProviderIdentityMapping({
			existing: {
				fieldMappingSetId: 'mapping-set-1',
				fieldMappingVersionId: 'mapping-version-7',
				sourceProfileId: 'directory-subject',
				attributeDescriptors: { mail: { name: 'mail' } }
			},
			selectedFieldMappingSetId: 'mapping-set-2',
			providerType: 'saml_sp',
			destinationFieldPolicies: { eduPersonPrincipalName: 'required' }
		});

		expect(result).toEqual({
			fieldMappingSetId: 'mapping-set-2',
			destinationNamespace: 'saml.attribute',
			destinationFieldPolicies: { eduPersonPrincipalName: 'required' }
		});
	});

	it('returns no mapping for an explicitly cleared selection', () => {
		expect(
			buildProviderIdentityMapping({
				existing: { fieldMappingSetId: 'mapping-set-1' },
				selectedFieldMappingSetId: '',
				providerType: 'saml_idp'
			})
		).toBeUndefined();
	});
});
