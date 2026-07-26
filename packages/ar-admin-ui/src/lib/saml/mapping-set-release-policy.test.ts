import { describe, expect, it } from 'vitest';
import {
	buildSAMLFieldReleasePolicies,
	resolveSAMLMappingSetDestinationProfileIds,
	resolveSAMLMappingSetReleaseFields
} from './mapping-set-release-policy';

describe('SAML Mapping Set release policy', () => {
	it('lists attributes from the active SAML destination profile only', () => {
		const fields = resolveSAMLMappingSetReleaseFields({
			versions: [
				{
					id: 'version-1',
					tenantId: 'tenant-1',
					fieldMappingSetId: 'set-1',
					versionLabel: 'v1',
					lifecycleState: 'active',
					destinationProfileIds: ['saml-profile']
				}
			],
			destinationProfiles: [
				{
					id: 'saml-profile',
					tenantId: 'tenant-1',
					destinationType: 'saml',
					profileKey: 'saml',
					displayName: 'SAML',
					ownerScopeType: 'tenant',
					lifecycleState: 'active',
					version: {
						id: 'saml-version',
						schema: {
							attributes: [
								{ name: 'mail', label: 'Email', classification: 'pii' },
								{ name: 'displayName', friendlyName: 'Display name' }
							]
						}
					}
				}
			]
		});

		expect(fields).toEqual([
			{ key: 'mail', label: 'Email', friendlyName: undefined, classification: 'pii' },
			{
				key: 'displayName',
				label: 'Display name',
				friendlyName: 'Display name',
				classification: undefined
			}
		]);
		expect(
			resolveSAMLMappingSetDestinationProfileIds({
				versions: [
					{
						id: 'version-1',
						tenantId: 'tenant-1',
						fieldMappingSetId: 'set-1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						destinationProfileIds: ['saml-profile']
					}
				],
				destinationProfiles: [
					{
						id: 'saml-profile',
						tenantId: 'tenant-1',
						destinationType: 'saml',
						profileKey: 'saml',
						displayName: 'SAML',
						ownerScopeType: 'tenant',
						lifecycleState: 'active',
						version: { id: 'saml-version', schema: { attributes: [] } }
					}
				]
			})
		).toEqual(['saml-profile']);
	});

	it('defaults metadata required attributes to required and other fields to optional', () => {
		expect(
			buildSAMLFieldReleasePolicies({
				fields: [
					{ key: 'mail', label: 'Email' },
					{ key: 'displayName', label: 'Display name' },
					{ key: 'department', label: 'Department' }
				],
				existing: { department: 'hidden' },
				metadataRequestedAttributes: [
					{ name: 'mail', isRequired: true },
					{ name: 'displayName', isRequired: false }
				]
			})
		).toEqual({ mail: 'required', displayName: 'optional', department: 'hidden' });
	});
});
