import { describe, expect, it } from 'vitest';
import { buildIdentityMappingFlowSamples } from '../flow-data';

describe('field mapping flow data adapter', () => {
	it('builds graph nodes from control-plane schemas instead of preview fixtures', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [
				{
					id: 'policy_1',
					tenantId: 'tenant_a',
					fieldMappingKey: 'default',
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
		expect(csvSample?.nodes.some((node) => node.role === 'target')).toBe(false);
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

	it('does not show catalog fallback targets when no Schema Settings fields exist', () => {
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
							id: 'entry_subject_id',
							stableFieldId: 'field.canonical.subject_id',
							namespace: 'authrim.profile',
							path: 'subject_id',
							targetTaxonomy: 'canonical',
							valueType: 'string',
							cardinality: 'single',
							classification: 'internal',
							uiGroupKey: 'identity',
							uiGroupLabel: 'Identity',
							uiGroupOrder: 90,
							uiFieldOrder: 10
						},
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

		expect(samples[0].nodes.filter((node) => node.role === 'target')).toEqual([]);
	});

	it('uses Schema Settings claim fields as identity schema target nodes before field catalogs', () => {
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
							id: 'entry_unused',
							stableFieldId: 'field.canonical.unused',
							namespace: 'authrim.profile',
							path: 'unused',
							targetTaxonomy: 'canonical',
							valueType: 'string',
							cardinality: 'single',
							classification: 'internal'
						}
					]
				}
			],
			identitySchemas: [
				{
					id: 'schema_email',
					tenant_id: 'tenant_a',
					field_key: 'email',
					display_label: 'Email',
					field_type: 'string',
					is_pii: 1,
					is_required: 1,
					is_active: 1,
					validation_rules: null,
					include_in_id_token: 0,
					include_in_userinfo: 1,
					include_in_introspection: 0,
					required_scopes: null,
					scope_mode: 'any',
					is_system: 1,
					is_searchable: 1,
					is_exportable: 0,
					is_vc_claim: 0,
					claim_namespace: null,
					description: 'Email address',
					display_order: 20,
					schema_version: 1,
					operation_status: 'active',
					operation_detail: null,
					created_by: null,
					created_at: 0,
					updated_at: 0,
					ui_group_key: 'contact',
					ui_group_label: 'Contact',
					ui_group_order: 20,
					ui_field_order: 10
				},
				{
					id: 'schema_disabled',
					tenant_id: 'tenant_a',
					field_key: 'disabled',
					display_label: 'Disabled',
					field_type: 'string',
					is_pii: 0,
					is_required: 0,
					is_active: 0,
					validation_rules: null,
					include_in_id_token: 0,
					include_in_userinfo: 0,
					include_in_introspection: 0,
					required_scopes: null,
					scope_mode: 'any',
					is_system: 0,
					is_searchable: 0,
					is_exportable: 0,
					is_vc_claim: 0,
					claim_namespace: null,
					description: null,
					display_order: 30,
					schema_version: 1,
					operation_status: 'active',
					operation_detail: null,
					created_by: null,
					created_at: 0,
					updated_at: 0
				},
				{
					id: 'schema_nickname',
					tenant_id: 'tenant_a',
					field_key: 'nickname',
					display_label: 'Nickname',
					field_type: 'string',
					is_pii: 1,
					is_required: 0,
					is_active: 1,
					validation_rules: null,
					include_in_id_token: 0,
					include_in_userinfo: 1,
					include_in_introspection: 0,
					required_scopes: null,
					scope_mode: 'any',
					is_system: 0,
					is_searchable: 0,
					is_exportable: 0,
					is_vc_claim: 0,
					claim_namespace: null,
					description: 'Casual display handle',
					display_order: 40,
					schema_version: 1,
					operation_status: 'active',
					operation_detail: null,
					created_by: null,
					created_at: 0,
					updated_at: 0,
					examples_json: '{"values":["taro","yamada_t"]}',
					ui_group_key: 'profile',
					ui_group_label: 'Profile',
					ui_group_order: 30,
					ui_field_order: 10
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
						schema: {
							sourceType: 'csv',
							columns: [
								{
									stableColumnId: 'csv.email',
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
			destinationProfiles: [],
			protocolSchemas: [],
			externalSchemas: [],
			schemaReadinessRows: []
		});

		const targetNodes = samples[0].nodes.filter((node) => node.role === 'target');
		expect(targetNodes[0]).toEqual(
			expect.objectContaining({
				label: 'UUID',
				uiGroupKey: 'system',
				fieldRef: expect.objectContaining({
					path: 'account_id',
					catalogEntryId: 'system.identity.account_uuid'
				})
			})
		);
		expect(targetNodes.some((node) => node.label === 'User ID')).toBe(false);
		expect(targetNodes.some((node) => node.label === 'Subject ID')).toBe(false);
		expect(targetNodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					label: 'Email',
					fieldRef: expect.objectContaining({
						path: 'email',
						catalogEntryId: 'custom-claim.email'
					}),
					uiGroupKey: 'contact',
					uiGroupLabel: 'Contact',
					privacy: 'PII',
					required: true,
					examples: ['taro.yamada@example.edu']
				}),
				expect.objectContaining({
					label: 'Nickname',
					fieldRef: expect.objectContaining({
						path: 'nickname',
						catalogEntryId: 'custom-claim.nickname'
					}),
					examples: ['taro', 'yamada_t']
				})
			])
		);
		expect(JSON.stringify(samples)).not.toContain('unused');
		expect(JSON.stringify(samples)).not.toContain('Disabled');
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
			sourceAdapter: 'CSV'
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

	it('builds a destination release graph when only destination profiles are registered', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [
				{
					id: 'policy_1',
					tenantId: 'tenant_a',
					fieldMappingKey: 'draft',
					displayName: 'Draft policy',
					lifecycleState: 'draft'
				}
			],
			catalogs: [],
			sourceProfiles: [],
			destinationProfiles: [
				{
					id: 'destination_saml_gakunin',
					tenantId: 'tenant_a',
					destinationType: 'saml',
					profileKey: 'gakunin_application_standard',
					displayName: 'GakuNin application standard',
					ownerScopeType: 'tenant',
					lifecycleState: 'active',
					version: {
						id: 'destination_saml_gakunin_v1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schema: {
							destinationType: 'saml',
							attributes: [
								{
									name: 'urn:oid:2.5.4.42',
									label: 'givenName',
									valueType: 'string',
									classification: 'pii'
								}
							]
						}
					}
				},
				{
					id: 'destination_saml_kafe',
					tenantId: 'tenant_a',
					destinationType: 'saml',
					profileKey: 'kafe_attribute_map',
					displayName: 'KAFE attribute map',
					ownerScopeType: 'tenant',
					lifecycleState: 'active',
					version: {
						id: 'destination_saml_kafe_v1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schema: {
							destinationType: 'saml',
							attributes: [
								{
									name: 'urn:oid:0.9.2342.19200300.100.1.3',
									label: 'mail',
									valueType: 'email',
									classification: 'pii'
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

		expect(samples).toHaveLength(1);
		expect(samples[0]).toMatchObject({
			title: 'Destination release',
			destinationAdapter: 'SAML',
			reviewGates: '2 destination fields'
		});
		expect(samples[0].nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'destination',
					label: 'givenName',
					profileId: 'destination-profile-destination_saml_gakunin',
					profileTitle: 'GakuNin application standard'
				}),
				expect.objectContaining({
					role: 'destination',
					label: 'mail',
					profileId: 'destination-profile-destination_saml_kafe',
					profileTitle: 'KAFE attribute map'
				})
			])
		);
		expect(samples[0].nodes.some((node) => node.role === 'source')).toBe(false);
		expect(samples[0].nodes.some((node) => node.role === 'target')).toBe(false);
	});

	it('does not build profile nodes for registered profiles without schema', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [],
			catalogs: [],
			sourceProfiles: [],
			destinationProfiles: [
				{
					id: 'destination_saml_empty',
					tenantId: 'tenant_a',
					destinationType: 'saml',
					profileKey: 'empty_destination',
					displayName: 'Empty destination',
					ownerScopeType: 'tenant',
					lifecycleState: 'active',
					version: {
						id: 'destination_saml_empty_v1',
						versionLabel: 'v1',
						lifecycleState: 'active'
					}
				}
			],
			protocolSchemas: [],
			externalSchemas: [],
			schemaReadinessRows: []
		});

		expect(samples).toEqual([]);
	});

	it('keeps source node ids unique for Japanese CSV headers', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [],
			catalogs: [],
			sourceProfiles: [
				{
					id: 'source_library_patrons_ja',
					tenantId: 'tenant_a',
					sourceType: 'csv',
					profileKey: 'library_patrons_ja',
					displayName: 'Library patrons JA',
					lifecycleState: 'active',
					version: {
						id: 'source_library_patrons_ja_v1',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schemaHash: 'hash',
						schema: {
							sourceType: 'csv',
							columns: [
								{
									stableColumnId: 'csv.利用者id',
									headerName: '利用者ID',
									label: '利用者ID',
									valueType: 'string',
									required: false,
									classification: 'internal'
								},
								{
									stableColumnId: 'csv.メール',
									headerName: 'メール',
									label: 'メール',
									valueType: 'email',
									required: false,
									classification: 'pii'
								},
								{
									stableColumnId: 'csv.姓',
									headerName: '姓',
									label: '姓',
									valueType: 'string',
									required: false,
									classification: 'pii'
								},
								{
									stableColumnId: 'csv.名',
									headerName: '名',
									label: '名',
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

		const sourceNodeIds = samples[0].nodes
			.filter((node) => node.role === 'source')
			.map((node) => node.id);

		expect(new Set(sourceNodeIds).size).toBe(sourceNodeIds.length);
		expect(sourceNodeIds.some((id) => id.includes('利用者id'))).toBe(true);
		expect(sourceNodeIds.some((id) => id.includes('メール'))).toBe(true);
	});

	it('exposes directory facts as directory source nodes', () => {
		const samples = buildIdentityMappingFlowSamples({
			policies: [],
			catalogs: [],
			sourceProfiles: [],
			destinationProfiles: [],
			protocolSchemas: [],
			externalSchemas: [
				{
					id: 'builtin_directory_facts',
					tenantId: 'tenant_a',
					sourceType: 'directory',
					sourceId: 'wordwarden',
					sourceKey: 'directory-facts',
					schemaKey: 'directory-facts',
					displayName: 'Directory Facts',
					schema: {
						fields: [
							{
								key: 'directory.identity.subject',
								label: 'Directory Subject',
								type: 'string',
								classification: 'internal'
							},
							{
								key: 'directory.groups',
								label: 'Directory Groups',
								type: 'array',
								classification: 'internal'
							}
						]
					},
					lifecycleState: 'active'
				}
			],
			schemaReadinessRows: []
		});

		const directorySample = samples.find((sample) => sample.title === 'Directory Facts');
		expect(directorySample?.sourceAdapter).toBe('DIRECTORY');
		expect(
			directorySample?.nodes.some(
				(node) =>
					node.fieldRef?.namespace === 'directory' &&
					node.fieldRef.path === 'directory.identity.subject'
			)
		).toBe(true);
	});
});
