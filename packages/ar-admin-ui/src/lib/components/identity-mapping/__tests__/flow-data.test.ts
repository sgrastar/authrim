import { describe, expect, it } from 'vitest';
import { buildIdentityMappingFlowSamples } from '../flow-data';

describe('identity mapping flow data adapter', () => {
	it('builds graph nodes from control-plane schemas instead of preview fixtures', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [
				{
					id: 'policy_1',
					tenantId: 'tenant_a',
					policyKey: 'default',
					displayName: 'Default policy',
					lifecycleState: 'draft'
				}
			],
			catalogs: [],
			sourceProfiles: [
				{
					id: 'source_csv',
					tenantId: 'tenant_a',
					sourceType: 'csv',
					profileKey: 'people_csv',
					displayName: 'People CSV',
					lifecycleState: 'active',
					version: {
						id: 'source_csv_v1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schemaHash: 'hash',
						schema: {
							sourceType: 'csv',
							columns: [
								{
									stableColumnId: 'csv.given_name',
									headerName: 'First Name',
									label: 'First Name',
									valueType: 'string',
									required: false,
									classification: 'pii'
								}
							]
						},
						warningSummary: {}
					}
				}
			],
			destinationProfiles: [],
			protocolSchemas: [
				{
					id: 'protocol_oidc',
					tenantId: 'tenant_a',
					protocol: 'oidc',
					schemaKey: 'userinfo',
					schemaVersion: '1.0',
					schema: { claims: { email: { type: 'string' }, name: { type: 'string' } } },
					lifecycleState: 'active'
				}
			],
			externalSchemas: [
				{
					id: 'external_csv',
					tenantId: 'tenant_a',
					sourceType: 'csv',
					sourceId: 'hr-import',
					schemaKey: 'employee-columns',
					schema: { columns: ['employee_id', 'email', 'department'] },
					lifecycleState: 'active'
				}
			],
			schemaReadinessRows: [
				{
					id: 'UIM-SCH-001',
					objectName: 'identity_accounts',
					area: 'Canonical identity account',
					introducedPr: 'PR1',
					expectedConnectionPr: 'PR6',
					runtimePath: 'canonical repository',
					status: 'repo_connected',
					gate: 'connected',
					schemaObject: 'identity_accounts',
					requiredForTier2Gate: true,
					schemaPresent: true,
					gateState: 'pass'
				}
			]
		});

		const csvSample = samples.find((sample) => sample.title === 'employee-columns');
		expect(csvSample).toBeDefined();
		expect(csvSample?.nodes.some((node) => node.label === 'employee_id')).toBe(true);
		expect(csvSample?.nodes.some((node) => node.label === 'Subject Identifier')).toBe(true);
		expect(csvSample?.nodes.some((node) => node.label === 'Email')).toBe(true);
		expect(csvSample?.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'target',
					label: 'Subject Identifier',
					inputCardinality: 'one'
				}),
				expect.objectContaining({
					role: 'target',
					label: 'Group Membership',
					inputCardinality: 'many'
				})
			])
		);
		expect(
			csvSample?.nodes.some((node) => node.label === 'email' && node.role === 'destination')
		).toBe(true);
		expect(csvSample?.rules[csvSample.activeRuleId].runtime).toBe('loaded control-plane schema');
		expect(JSON.stringify(samples)).not.toContain('Salesforce');
		expect(JSON.stringify(samples)).not.toContain('sample policy preview only');
	});

	it('does not create a fake source profile when no source profiles are registered yet', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [],
			catalogs: [],
			sourceProfiles: [],
			destinationProfiles: [],
			protocolSchemas: [],
			externalSchemas: [],
			schemaReadinessRows: [
				{
					id: 'UIM-SCH-010',
					objectName: 'contact_points',
					area: 'Canonical contact storage',
					introducedPr: 'PR1',
					expectedConnectionPr: 'PR6',
					runtimePath: 'PII repository',
					status: 'repo_connected',
					gate: 'connected',
					schemaObject: 'contact_points',
					requiredForTier2Gate: true,
					schemaPresent: true,
					gateState: 'pass'
				}
			]
		});

		expect(samples).toEqual([]);
	});

	it('uses field catalog entries as canonical target nodes when catalogs are available', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [],
			catalogs: [
				{
					id: 'catalog_1',
					tenantId: 'tenant_a',
					catalogKey: 'default',
					displayName: 'Default Catalog',
					versionLabel: 'v1',
					lifecycleState: 'active',
					entries: [
						{
							id: 'entry_given_name',
							stableFieldId: 'field.canonical.given_name',
							namespace: 'authrim.profile',
							path: 'given_name',
							targetTaxonomy: 'canonical',
							valueType: 'string',
							cardinality: 'single',
							classification: 'pii',
							uiGroupKey: 'name',
							uiGroupLabel: 'Name',
							uiGroupOrder: 10,
							uiFieldOrder: 20,
							examples: ['John Doe']
						},
						{
							id: 'entry_groups',
							stableFieldId: 'field.canonical.group_membership',
							namespace: 'authrim.profile',
							path: 'group_membership',
							targetTaxonomy: 'canonical',
							valueType: 'array',
							cardinality: 'multi',
							classification: 'internal'
						}
					]
				}
			],
			sourceProfiles: [
				{
					id: 'source_csv',
					tenantId: 'tenant_a',
					sourceType: 'csv',
					profileKey: 'people_csv',
					displayName: 'People CSV',
					lifecycleState: 'active',
					version: {
						id: 'source_csv_v1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schemaHash: 'hash',
						schema: {
							sourceType: 'csv',
							columns: [
								{
									stableColumnId: 'csv.given_name',
									headerName: 'First Name',
									label: 'First Name',
									valueType: 'string',
									required: false,
									classification: 'pii'
								}
							]
						},
						warningSummary: {}
					}
				}
			],
			destinationProfiles: [],
			protocolSchemas: [],
			externalSchemas: [],
			schemaReadinessRows: []
		});

		expect(samples[0].nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'target',
					label: 'First Name',
					caption: '',
					type: 'String',
					storageTarget: 'Profile attribute',
					uiGroupKey: 'name',
					uiGroupLabel: 'Name',
					examples: ['John Doe']
				}),
				expect.objectContaining({
					role: 'target',
					label: 'Group Membership',
					type: 'Array',
					inputCardinality: 'many',
					privacy: 'non-PII'
				})
			])
		);
	});

	it('prefers registered source profiles in Flow Editor samples', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [],
			catalogs: [],
			sourceProfiles: [
				{
					id: 'source_profile_1',
					tenantId: 'tenant_a',
					sourceType: 'csv',
					profileKey: 'workday_csv',
					displayName: 'Workday CSV',
					lifecycleState: 'active',
					version: {
						id: 'version_1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schema: {
							sourceType: 'csv',
							columns: [
								{
									stableColumnId: 'csv.email.1',
									headerName: 'Email',
									label: 'Email',
									valueType: 'email',
									required: true,
									classification: 'pii'
								}
							]
						}
					}
				}
			],
			destinationProfiles: [
				{
					id: 'destination_profile_1',
					tenantId: 'tenant_a',
					destinationType: 'oidc',
					profileKey: 'library_oidc',
					displayName: 'Library OIDC',
					ownerScopeType: 'tenant',
					lifecycleState: 'active',
					version: {
						id: 'destination_version_1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schema: {
							destinationType: 'oidc',
							claims: [
								{
									claimName: 'sub',
									label: 'Subject',
									valueType: 'string',
									classification: 'internal',
									surfaces: ['id_token']
								},
								{
									claimName: 'library_card',
									label: 'Library card',
									valueType: 'string',
									classification: 'pii',
									surfaces: ['userinfo']
								}
							]
						}
					}
				}
			],
			protocolSchemas: [],
			externalSchemas: [],
			schemaReadinessRows: []
		});

		expect(samples[0]).toMatchObject({
			title: 'Workday CSV',
			inboundAdapter: 'CSV'
		});
		expect(samples[0].nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'source',
					label: 'Email',
					profileId: 'source-profile-source_profile_1',
					profileTitle: 'Workday CSV',
					privacy: 'PII',
					required: true
				}),
				expect.objectContaining({
					role: 'destination',
					label: 'Library card',
					profileId: 'destination-profile-destination_profile_1',
					profileTitle: 'Library OIDC',
					privacy: 'PII'
				})
			])
		);
	});
});
