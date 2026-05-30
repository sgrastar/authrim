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
			sourceProfiles: [],
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
		expect(csvSample?.nodes.some((node) => node.label === 'Subject identifier')).toBe(true);
		expect(csvSample?.nodes.some((node) => node.label === 'Email')).toBe(true);
		expect(csvSample?.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'target',
					label: 'Subject identifier',
					inputCardinality: 'one'
				}),
				expect.objectContaining({
					role: 'target',
					label: 'Group membership',
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

	it('shows built-in canonical targets when no source profiles are registered yet', () => {
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

		expect(samples).toHaveLength(1);
		expect(samples[0].id).toBe('schema-readiness-inventory');
		expect(samples[0].nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'target',
					label: 'Email'
				}),
				expect.objectContaining({
					role: 'target',
					label: 'Group membership'
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
					privacy: 'PII',
					required: true
				}),
				expect.objectContaining({
					role: 'destination',
					label: 'Library card',
					privacy: 'PII'
				})
			])
		);
	});
});
