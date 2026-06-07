import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type {
  DatabaseAdapter,
  ExecuteResult,
  Env,
  HealthStatus,
  TransactionContext,
} from '@authrim/ar-lib-core';
import {
  adminIdentityMappingAttributeFieldCreateHandler,
  adminIdentityMappingAttributeGroupCreateHandler,
  adminIdentityMappingDestinationProfileCreateHandler,
  adminIdentityMappingProtocolSchemasListHandler,
  adminIdentityMappingPoliciesListHandler,
  adminIdentityMappingPolicyCreateHandler,
  adminIdentityMappingFederationMetadataDocumentsListHandler,
  adminIdentityMappingReviewTasksListHandler,
  adminIdentityMappingSchemaReadinessHandler,
  IdentityMappingControlPlaneRepository,
} from '../identity-mapping-control-plane';

interface RecordedExecute {
  sql: string;
  params: unknown[];
}

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function createAdapter(options: {
  queryRows?: Record<string, unknown>[];
  queryRowSets?: Record<string, unknown>[][];
  queryOneRows?: Array<Record<string, unknown> | null>;
}): DatabaseAdapter & { executes: RecordedExecute[]; queries: RecordedQuery[] } {
  const executes: RecordedExecute[] = [];
  const queries: RecordedQuery[] = [];
  const queryRows = [...(options.queryRows ?? [])];
  const queryRowSets = [...(options.queryRowSets ?? [])];
  const queryOneRows = [...(options.queryOneRows ?? [])];
  const executeResult: ExecuteResult = { rowsAffected: 1, success: true };
  return {
    executes,
    queries,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      queries.push({ sql, params });
      if (queryRowSets.length > 0) {
        return queryRowSets.shift() as T[];
      }
      return queryRows as T[];
    },
    async queryOne<T>(): Promise<T | null> {
      return (queryOneRows.shift() ?? null) as T | null;
    },
    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
      executes.push({ sql, params });
      return executeResult;
    },
    async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async batch(): Promise<ExecuteResult[]> {
      return [];
    },
    async isHealthy(): Promise<HealthStatus> {
      return { healthy: true, latencyMs: 1, type: 'test' };
    },
    getType(): string {
      return 'test';
    },
    async close(): Promise<void> {},
  };
}

const catalogEntry = {
  id: 'field.canonical.email',
  namespace: 'authrim.profile',
  path: 'email',
  targetType: 'canonical' as const,
  valueType: 'string',
  cardinality: 'single' as const,
  classification: 'pii' as const,
  uiGroupKey: 'contact',
  uiGroupLabel: 'Contact',
  uiGroupOrder: 20,
  uiFieldOrder: 10,
  examples: ['john@example.com'],
  note: 'Primary verified email address.',
  required: true,
};

describe('IdentityMappingControlPlaneRepository catalog operations', () => {
  it('stores deterministic catalog metadata and entries', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.createCatalog('tenant_a', {
      catalogKey: 'default',
      displayName: 'Default Catalog',
      versionLabel: '2026-05-28',
      entries: [catalogEntry],
      customEntries: [
        {
          customKey: 'custom.department',
          displayName: 'Department',
          valueType: 'string',
          classification: 'internal',
        },
      ],
    });

    expect(result.catalogKey).toBe('default');
    expect(result.activeVersion.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO field_catalogs'),
      expect.stringContaining('INSERT INTO field_catalog_versions'),
      expect.stringContaining('INSERT INTO field_catalog_entries'),
      expect.stringContaining('INSERT INTO custom_field_catalog_entries'),
    ]);
    expect(adapter.executes[2].params).toEqual(
      expect.arrayContaining([
        'contact',
        'Contact',
        20,
        10,
        '["john@example.com"]',
        'Primary verified email address.',
        '{"required":true}',
      ])
    );
  });

  it('rejects custom fields that shadow built-in catalog fields', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createCatalog('tenant_a', {
        catalogKey: 'default',
        displayName: 'Default Catalog',
        versionLabel: '2026-05-28',
        entries: [catalogEntry],
        customEntries: [
          {
            customKey: 'field.canonical.email',
            displayName: 'Email Shadow',
            valueType: 'string',
          },
        ],
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('lists catalog entries with catalog summaries', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'catalog_1',
          tenant_id: 'tenant_a',
          catalog_key: 'default',
          display_name: 'Default Catalog',
          lifecycle_state: 'active',
          version_id: 'version_1',
          version_label: 'v1',
          bundle_hash: 'hash_1',
          entry_id: 'entry_1',
          stable_field_id: 'field.canonical.email',
          namespace: 'authrim.profile',
          path: 'email',
          target_taxonomy: 'canonical',
          value_type: 'string',
          cardinality: 'single',
          classification: 'pii',
          aliases_json: '[{"namespace":"oidc","path":"email"}]',
          ui_group_key: 'contact',
          ui_group_label: 'Contact',
          ui_group_order: 20,
          ui_field_order: 10,
          examples_json: '["john@example.com"]',
          note: 'Primary verified email address.',
          validation_json:
            '{"allowedValues":["student","faculty"],"valueMultiplicity":"multi","nullable":false,"required":true}',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const catalogs = await repository.listCatalogs('tenant_a');

    expect(catalogs).toEqual([
      expect.objectContaining({
        id: 'catalog_1',
        entries: [
          {
            id: 'entry_1',
            stableFieldId: 'field.canonical.email',
            namespace: 'authrim.profile',
            path: 'email',
            targetTaxonomy: 'canonical',
            valueType: 'string',
            cardinality: 'single',
            classification: 'pii',
            aliases: [{ namespace: 'oidc', path: 'email' }],
            uiGroupKey: 'contact',
            uiGroupLabel: 'Contact',
            uiGroupOrder: 20,
            uiFieldOrder: 10,
            examples: ['john@example.com'],
            note: 'Primary verified email address.',
            allowedValues: ['student', 'faculty'],
            valueMultiplicity: 'multi',
            nullable: false,
            required: true,
          },
        ],
      }),
    ]);
  });

  it('deletes inactive policy sets with their control-plane children', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'mapping_policy_1',
          tenant_id: 'tenant_a',
          policy_key: 'library',
          display_name: 'Library policy',
          description: null,
          owner_scope_type: 'tenant',
          owner_scope_id: null,
          lifecycle_state: 'draft',
          created_at: 1000,
          updated_at: 1000,
        },
        null,
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.deletePolicySet('tenant_a', 'mapping_policy_1');

    expect(result).toEqual({
      id: 'mapping_policy_1',
      tenantId: 'tenant_a',
      deleted: true,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('DELETE FROM mapping_transform_steps'),
      expect.stringContaining('DELETE FROM mapping_rule_edges'),
      expect.stringContaining('DELETE FROM mapping_validation_rules'),
      expect.stringContaining('DELETE FROM mapping_release_rules'),
      expect.stringContaining('DELETE FROM mapping_conflict_rules'),
      expect.stringContaining('DELETE FROM dependency_graph_snapshots'),
      expect.stringContaining('DELETE FROM compiled_mapping_snapshots'),
      expect.stringContaining('DELETE FROM mapping_rules'),
      expect.stringContaining('DELETE FROM mapping_policy_activations'),
      expect.stringContaining('DELETE FROM mapping_policy_versions'),
      expect.stringContaining('DELETE FROM mapping_policy_sets'),
    ]);
  });

  it('rejects deleting active policy sets', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'mapping_policy_1',
          tenant_id: 'tenant_a',
          policy_key: 'library',
          display_name: 'Library policy',
          description: null,
          owner_scope_type: 'tenant',
          owner_scope_id: null,
          lifecycle_state: 'active',
          created_at: 1000,
          updated_at: 1000,
        },
        { id: 'mapping_activation_1' },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(repository.deletePolicySet('tenant_a', 'mapping_policy_1')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository source profiles', () => {
  it('parses CSV into a schema-only draft without persisting raw sampled values', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);
    const contentBase64 = btoa('Email,TaxId\nalice@example.test,123-45-6789');

    const result = await repository.parseCsvSourceProfile('tenant_a', {
      contentBase64,
      encoding: 'utf-8',
      parserOptions: { headerMode: 'first_row' },
      sourceMetadata: { fileName: 'users.csv' },
    });

    expect(result.schema.summary.blockingWarningCount).toBe(2);
    expect(adapter.executes[0]?.sql).toContain('INSERT INTO source_profile_parse_drafts');
    expect(JSON.stringify(adapter.executes[0]?.params)).not.toContain('alice@example.test');
    expect(JSON.stringify(adapter.executes[0]?.params)).not.toContain('123-45-6789');
    expect(JSON.parse(String(adapter.executes[0]?.params[7]))).toMatchObject({
      rawContentPersisted: false,
    });
  });

  it('rejects CSV source profile parse payloads above the encoded size budget', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.parseCsvSourceProfile('tenant_a', {
        contentBase64: 'A'.repeat(2_800_000),
        encoding: 'utf-8',
        parserOptions: { headerMode: 'first_row' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects CSV parser row and column limits above the profile budget', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.parseCsvSourceProfile('tenant_a', {
        contentBase64: btoa('Email\nalice@example.test'),
        encoding: 'utf-8',
        parserOptions: { headerMode: 'first_row', maxRows: 1001 },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    await expect(
      repository.parseCsvSourceProfile('tenant_a', {
        contentBase64: btoa('Email\nalice@example.test'),
        encoding: 'utf-8',
        parserOptions: { headerMode: 'first_row', maxColumns: 501 },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('creates, reviews, and activates CSV source profile versions', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        null,
        {
          warning_summary_json: '{"blockingWarningCount":1,"confirmedBlockingWarningCount":1}',
          lifecycle_state: 'draft',
        },
        {
          lifecycle_state: 'reviewed',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const created = await repository.createSourceProfile('tenant_a', {
      sourceType: 'csv',
      profileKey: 'workday_csv',
      displayName: 'Workday CSV',
      schema: {
        sourceType: 'csv',
        columns: [{ stableColumnId: 'csv.email.1', headerName: 'Email' }],
      },
      warningSummary: {
        blockingWarningCount: 1,
        confirmedBlockingWarningCount: 1,
      },
    });

    await repository.reviewSourceProfileVersion('tenant_a', created.id, created.version.id);
    await repository.activateSourceProfileVersion('tenant_a', created.id, created.version.id);

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO source_profiles'),
      expect.stringContaining('INSERT INTO source_profile_versions'),
      expect.stringContaining('UPDATE source_profile_versions'),
      expect.stringContaining('UPDATE source_profile_versions'),
      expect.stringContaining('UPDATE source_profile_versions'),
      expect.stringContaining('UPDATE source_profiles'),
    ]);
  });

  it('blocks review until PII and regulated candidates are confirmed', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          warning_summary_json: '{"blockingWarningCount":2,"confirmedBlockingWarningCount":1}',
          lifecycle_state: 'draft',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.reviewSourceProfileVersion('tenant_a', 'profile_1', 'version_1')
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects duplicate source profile keys before hitting database constraints', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'existing_source_profile' }],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createSourceProfile('tenant_a', {
        sourceType: 'csv',
        profileKey: 'workday_csv',
        displayName: 'Workday CSV',
        schema: {
          sourceType: 'csv',
          columns: [{ stableColumnId: 'csv.email.1', headerName: 'Email' }],
        },
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('updates CSV source profiles by adding a new draft version', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'source_profile_1',
          source_type: 'csv',
          profile_key: 'workday_csv',
          display_name: 'Workday CSV',
        },
        null,
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const updated = await repository.updateSourceProfile('tenant_a', 'source_profile_1', {
      sourceType: 'csv',
      profileKey: 'workday_csv_v2',
      displayName: 'Workday CSV v2',
      versionLabel: 'v2',
      schema: {
        sourceType: 'csv',
        columns: [{ stableColumnId: 'csv.email.1', headerName: 'Email' }],
      },
      warningSummary: {
        blockingWarningCount: 0,
      },
    });

    expect(updated).toMatchObject({
      id: 'source_profile_1',
      profileKey: 'workday_csv_v2',
      displayName: 'Workday CSV v2',
      lifecycleState: 'draft',
      version: {
        versionLabel: 'v2',
        lifecycleState: 'draft',
      },
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE source_profiles'),
      expect.stringContaining('INSERT INTO source_profile_versions'),
    ]);
    expect(adapter.executes[0].params).toEqual([
      'csv',
      'workday_csv_v2',
      'Workday CSV v2',
      'draft',
      1000,
      'tenant_a',
      'source_profile_1',
    ]);
  });

  it('rejects oversized source profile schema JSON before stable hashing', async () => {
    const adapter = createAdapter({
      queryOneRows: [null],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createSourceProfile('tenant_a', {
        sourceType: 'csv',
        profileKey: 'workday_csv',
        displayName: 'Workday CSV',
        schema: {
          sourceType: 'csv',
          columns: [
            {
              stableColumnId: 'csv.notes.1',
              headerName: 'Notes',
              description: 'x'.repeat(4097),
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('deletes source profiles and their versions', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'source_profile_1' }],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const deleted = await repository.deleteSourceProfile('tenant_a', 'source_profile_1');

    expect(deleted).toEqual({ id: 'source_profile_1', deleted: true });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('DELETE FROM source_profile_versions'),
      expect.stringContaining('DELETE FROM source_profiles'),
    ]);
    expect(adapter.executes[0].params).toEqual(['tenant_a', 'source_profile_1']);
    expect(adapter.executes[1].params).toEqual(['tenant_a', 'source_profile_1']);
  });

  it('rejects deleting missing source profiles', async () => {
    const adapter = createAdapter({
      queryOneRows: [null],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(repository.deleteSourceProfile('tenant_a', 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository destination profiles', () => {
  it('creates OIDC attribute registries and validates destination profile release contracts', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'attribute_group_library',
          tenant_id: 'tenant_a',
          owner_scope_type: 'tenant',
          owner_scope_id: null,
          protocol: 'oidc',
          group_type: 'scope',
          group_key: 'library',
          display_name: 'Library',
          description: null,
          field_keys_json: '["library_card"]',
          lifecycle_state: 'active',
          created_at: 1000,
          updated_at: 1000,
        },
      ],
      queryOneRows: [
        null,
        {
          tenant_id: 'tenant_a',
          validation_summary_json: '{"errorCount":0}',
          warning_summary_json: '{"blockingWarningCount":1,"confirmedBlockingWarningCount":1}',
          release_impact_json: '{"claimCount":2}',
          lifecycle_state: 'draft',
        },
        {
          tenant_id: 'tenant_a',
          lifecycle_state: 'reviewed',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await repository.createAttributeGroup('tenant_a', {
      protocol: 'oidc',
      groupType: 'scope',
      groupKey: 'library',
      displayName: 'Library',
      fieldKeys: ['library_card'],
    });
    await repository.createAttributeField('tenant_a', {
      protocol: 'oidc',
      fieldKey: 'library_card',
      displayName: 'Library card',
      classification: 'pii',
      surfaces: ['userinfo'],
    });
    const created = await repository.createDestinationProfile('tenant_a', {
      destinationType: 'oidc',
      profileKey: 'library_oidc',
      displayName: 'Library OIDC',
      schema: {
        destinationType: 'oidc',
        subjectContract: { required: true, strategySource: 'tenant_default_with_client_override' },
        claimsParameter: {
          userinfo: {
            library_card: { essential: true },
          },
          acr_values: ['urn:authrim:loa:2'],
        },
        claims: [
          {
            claimName: 'sub',
            valueType: 'string',
            classification: 'internal',
            surfaces: ['id_token', 'userinfo'],
            requiredScopes: ['openid'],
          },
          {
            claimName: 'library_card',
            valueType: 'string',
            classification: 'pii',
            surfaces: ['userinfo'],
            requiredScopes: ['library'],
          },
        ],
      },
      warningSummary: {
        blockingWarningCount: 1,
        confirmedBlockingWarningCount: 1,
      },
    });

    await repository.reviewDestinationProfileVersion('tenant_a', created.id, created.version.id);
    await repository.activateDestinationProfileVersion('tenant_a', created.id, created.version.id);

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO attribute_group_registry'),
      expect.stringContaining('INSERT INTO attribute_field_registry'),
      expect.stringContaining('INSERT INTO destination_profiles'),
      expect.stringContaining('INSERT INTO destination_profile_versions'),
      expect.stringContaining('UPDATE destination_profile_versions'),
      expect.stringContaining('UPDATE destination_profile_versions'),
      expect.stringContaining('UPDATE destination_profile_versions'),
      expect.stringContaining('UPDATE destination_profiles'),
    ]);
    expect(created.version.releaseImpact).toMatchObject({
      destinationType: 'oidc',
      claimCount: 2,
      claimsParameterClaimCount: 1,
      essentialClaimCount: 1,
      piiClaimCount: 1,
    });
  });

  it('rejects OIDC destination profiles without sub', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createDestinationProfile('tenant_a', {
        destinationType: 'oidc',
        profileKey: 'bad_oidc',
        displayName: 'Bad OIDC',
        schema: {
          destinationType: 'oidc',
          claims: [
            {
              claimName: 'email',
              classification: 'pii',
              surfaces: ['userinfo'],
              requiredScopes: ['email'],
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  it('rejects invalid destination field value constraints', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createDestinationProfile('tenant_a', {
        destinationType: 'oidc',
        profileKey: 'bad_value_constraints',
        displayName: 'Bad value constraints',
        schema: {
          destinationType: 'oidc',
          claims: [
            {
              claimName: 'sub',
              classification: 'internal',
              surfaces: ['id_token'],
              requiredScopes: ['openid'],
              allowedValues: ['active'],
              valueMultiplicity: 'many',
              nullable: false,
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  it('rejects OIDC claims parameter entries that are not defined by the destination profile', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createDestinationProfile('tenant_a', {
        destinationType: 'oidc',
        profileKey: 'bad_claims_parameter',
        displayName: 'Bad claims parameter',
        schema: {
          destinationType: 'oidc',
          claimsParameter: {
            userinfo: {
              unknown_claim: { essential: true },
            },
          },
          claims: [
            {
              claimName: 'sub',
              classification: 'internal',
              surfaces: ['id_token'],
              requiredScopes: ['openid'],
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  it('rejects oversized destination profile schema JSON before validation and hashing', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createDestinationProfile('tenant_a', {
        destinationType: 'csv',
        profileKey: 'oversized_export',
        displayName: 'Oversized export',
        schema: {
          destinationType: 'csv',
          columns: [
            {
              columnName: 'notes',
              label: 'Notes',
              order: 1,
              valueType: 'string',
              classification: 'internal',
              description: 'x'.repeat(4097),
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('creates CSV destination profile versions with formatter and null handling policy', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const created = await repository.createDestinationProfile('tenant_a', {
      destinationType: 'csv',
      profileKey: 'weekly_export',
      displayName: 'Weekly export',
      schema: {
        destinationType: 'csv',
        defaults: {
          encoding: 'utf-8-bom',
          includeHeader: true,
          nullHandling: 'empty',
          requiredMissingPolicy: 'review',
        },
        columns: [
          {
            columnName: 'email',
            label: 'Email',
            order: 1,
            valueType: 'email',
            classification: 'pii',
            required: true,
            formatter: { operation: 'lower' },
            nullHandling: 'empty',
            requiredMissingPolicy: 'review',
            exportPolicy: { legalBasis: 'consent', purpose: 'library_export' },
          },
        ],
      },
      warningSummary: {
        blockingWarningCount: 0,
      },
    });

    expect(created.version.releaseImpact).toMatchObject({
      destinationType: 'csv',
      columnCount: 1,
      piiColumnCount: 1,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO destination_profiles'),
      expect.stringContaining('INSERT INTO destination_profile_versions'),
    ]);
  });

  it('creates SAML destination profile versions with NameID and attributes', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const created = await repository.createDestinationProfile('tenant_a', {
      destinationType: 'saml',
      profileKey: 'standard_saml',
      displayName: 'Standard SAML',
      schema: {
        destinationType: 'saml',
        nameId: {
          format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          source: 'subject_identifier',
        },
        attributes: [
          {
            name: 'urn:oid:0.9.2342.19200300.100.1.3',
            label: 'Email',
            valueType: 'email',
            classification: 'pii',
            releasePolicy: { legalBasis: 'consent', purpose: 'attribute_release' },
          },
        ],
      },
      warningSummary: {
        blockingWarningCount: 0,
      },
    });

    expect(created.destinationType).toBe('saml');
    expect(created.version.releaseImpact).toMatchObject({
      destinationType: 'saml',
      attributeCount: 1,
      piiAttributeCount: 1,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO destination_profiles'),
      expect.stringContaining('INSERT INTO destination_profile_versions'),
    ]);
  });

  it('rejects duplicate destination profile keys before hitting database constraints', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'existing_destination_profile' }],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createDestinationProfile('tenant_a', {
        destinationType: 'csv',
        profileKey: 'weekly_export',
        displayName: 'Weekly export',
        schema: {
          destinationType: 'csv',
          columns: [
            {
              columnName: 'email',
              label: 'Email',
              order: 1,
              valueType: 'email',
              classification: 'pii',
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('updates destination profiles by adding a new draft version', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'destination_profile_1',
          tenant_id: 'tenant_a',
          destination_type: 'csv',
          profile_key: 'weekly_export',
          display_name: 'Weekly export',
          owner_scope_type: 'tenant',
          owner_scope_id: null,
          base_profile_id: null,
        },
        null,
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const updated = await repository.updateDestinationProfile('tenant_a', 'destination_profile_1', {
      destinationType: 'csv',
      profileKey: 'weekly_export_v2',
      displayName: 'Weekly export v2',
      versionLabel: 'v2',
      schema: {
        destinationType: 'csv',
        columns: [
          {
            columnName: 'email',
            label: 'Email',
            order: 1,
            valueType: 'email',
            classification: 'pii',
          },
        ],
      },
      warningSummary: {
        blockingWarningCount: 0,
      },
    });

    expect(updated).toMatchObject({
      id: 'destination_profile_1',
      profileKey: 'weekly_export_v2',
      displayName: 'Weekly export v2',
      lifecycleState: 'draft',
      version: {
        versionLabel: 'v2',
        lifecycleState: 'draft',
        releaseImpact: {
          destinationType: 'csv',
          columnCount: 1,
          piiColumnCount: 1,
        },
      },
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE destination_profiles'),
      expect.stringContaining('INSERT INTO destination_profile_versions'),
    ]);
    expect(adapter.executes[0].params).toEqual([
      'tenant_a',
      'csv',
      'weekly_export_v2',
      'Weekly export v2',
      'tenant',
      null,
      null,
      'draft',
      1000,
      'tenant_a',
      'destination_profile_1',
    ]);
  });

  it('rejects moving destination profiles across tenant storage scopes', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'destination_profile_1',
          tenant_id: 'tenant_a',
          destination_type: 'csv',
          profile_key: 'weekly_export',
          display_name: 'Weekly export',
          owner_scope_type: 'tenant',
          owner_scope_id: null,
          base_profile_id: null,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.updateDestinationProfile(
        'tenant_a',
        'destination_profile_1',
        {
          ownerScopeType: 'platform',
          destinationType: 'csv',
          schema: {
            destinationType: 'csv',
            columns: [{ columnName: 'email', label: 'Email', order: 1 }],
          },
        },
        true
      )
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('deletes destination profiles and their versions', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'destination_profile_1', tenant_id: 'tenant_a' }],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const deleted = await repository.deleteDestinationProfile('tenant_a', 'destination_profile_1');

    expect(deleted).toEqual({ id: 'destination_profile_1', deleted: true });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('DELETE FROM destination_profile_versions'),
      expect.stringContaining('DELETE FROM destination_profiles'),
    ]);
    expect(adapter.executes[0].params).toEqual(['tenant_a', 'destination_profile_1']);
    expect(adapter.executes[1].params).toEqual(['tenant_a', 'destination_profile_1']);
  });

  it('can delete platform destination profiles when platform scope is allowed', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'platform_destination_profile_1', tenant_id: 'platform' }],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await repository.deleteDestinationProfile('tenant_a', 'platform_destination_profile_1', true);

    expect(adapter.executes[0].params).toEqual(['platform', 'platform_destination_profile_1']);
    expect(adapter.executes[1].params).toEqual(['platform', 'platform_destination_profile_1']);
  });

  it('rejects deleting missing destination profiles', async () => {
    const adapter = createAdapter({
      queryOneRows: [null],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(repository.deleteDestinationProfile('tenant_a', 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository policy activation', () => {
  it('lists policy versions with latest compiled snapshot for operations UI', async () => {
    const adapter = createAdapter({
      queryRowSets: [
        [
          {
            id: 'policy_version_1',
            tenant_id: 'tenant_a',
            policy_set_id: 'policy_1',
            version_label: 'draft-1',
            lifecycle_state: 'draft',
            policy_hash: 'policy_hash_1',
            compatibility_range: '^1',
            author_id: null,
            published_at: null,
            created_at: 1000,
            updated_at: 1000,
            snapshot_id: 'snapshot_1',
            snapshot_catalog_version_id: 'catalog_version_1',
            snapshot_lifecycle_state: 'draft',
            snapshot_compiled_at: 1100,
          },
        ],
        [
          {
            policy_version_id: 'policy_version_1',
            rule_id: 'rule_1',
            rule_key: 'email-source',
            rule_kind: 'source_mapping',
            action: 'map',
            priority: 0,
            metadata_json: JSON.stringify({ source: 'test' }),
            edge_id: 'edge_1',
            source_ref_json: JSON.stringify({ profileId: 'source-profile-workforce' }),
            target_ref_json: JSON.stringify({ nodeId: 'canonical-email' }),
            edge_kind: 'direct',
            display_order: 0,
          },
          {
            policy_version_id: 'policy_version_1',
            rule_id: 'rule_2',
            rule_key: 'email-destination',
            rule_kind: 'destination_release',
            action: 'map',
            priority: 0,
            metadata_json: JSON.stringify({ source: 'test' }),
            edge_id: 'edge_2',
            source_ref_json: JSON.stringify({ nodeId: 'canonical-email' }),
            target_ref_json: JSON.stringify({ profileId: 'destination-profile-oidc' }),
            edge_kind: 'transform_input',
            display_order: 0,
          },
        ],
        [
          {
            policy_version_id: 'policy_version_1',
            rule_id: 'rule_2',
            transform_id: 'transform_1',
            edge_id: 'edge_2',
            step_order: 0,
            operation: 'trim',
            parameters_json: JSON.stringify({ mode: 'whitespace' }),
          },
        ],
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const versions = await repository.listPolicyVersions('tenant_a', 'policy_1');

    expect(adapter.queries[0]).toMatchObject({ params: ['tenant_a', 'policy_1'] });
    expect(versions).toEqual([
      expect.objectContaining({
        id: 'policy_version_1',
        policySetId: 'policy_1',
        versionLabel: 'draft-1',
        directions: { source: true, destination: true },
        sourceProfileIds: ['source-profile-workforce'],
        destinationProfileIds: ['destination-profile-oidc'],
        rules: [
          expect.objectContaining({
            id: 'rule_1',
            ruleKind: 'source_mapping',
            edges: [
              expect.objectContaining({
                id: 'edge_1',
                sourceRef: { profileId: 'source-profile-workforce' },
                targetRef: { nodeId: 'canonical-email' },
              }),
            ],
            transforms: [],
          }),
          expect.objectContaining({
            id: 'rule_2',
            ruleKind: 'destination_release',
            edges: [
              expect.objectContaining({
                id: 'edge_2',
                edgeKind: 'transform_input',
              }),
            ],
            transforms: [
              expect.objectContaining({
                id: 'transform_1',
                operation: 'trim',
                parameters: { mode: 'whitespace' },
              }),
            ],
          }),
        ],
        latestSnapshot: expect.objectContaining({
          id: 'snapshot_1',
          catalogVersionId: 'catalog_version_1',
          lifecycleState: 'draft',
        }),
      }),
    ]);
  });

  it('compiles a load-time verified snapshot with dependency graph hash', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'policy_version_1',
          tenant_id: 'tenant_a',
          policy_set_id: 'policy_1',
          version_label: 'v1',
          lifecycle_state: 'published',
          policy_hash: 'policy_hash_1',
          compatibility_range: '^1',
        },
        {
          id: 'catalog_version_1',
          tenant_id: 'tenant_a',
          catalog_id: 'catalog_1',
          version_label: 'v1',
          bundle_hash: 'catalog_hash_1',
          compatibility_range: '^1',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.compilePolicyVersion(
      'tenant_a',
      'policy_1',
      'policy_version_1',
      {
        catalogVersionId: 'catalog_version_1',
      }
    );

    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshotHash).not.toBe('policy_hash_1');
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO dependency_graph_snapshots'),
      expect.stringContaining('INSERT INTO compiled_mapping_snapshots'),
    ]);
    const snapshotMetadata = String(adapter.executes[1].params[11]);
    expect(snapshotMetadata).toContain('"loadTimeHashVerified":true');
    expect(snapshotMetadata).toContain('"dependencyGraphId"');
  });

  it('blocks activation when another holder has an unexpired lease', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'policy_version_1',
          tenant_id: 'tenant_a',
          policy_set_id: 'policy_1',
          version_label: 'v1',
          lifecycle_state: 'published',
          policy_hash: 'policy_hash_1',
        },
        {
          id: 'snapshot_1',
          tenant_id: 'tenant_a',
          policy_version_id: 'policy_version_1',
          catalog_version_id: 'catalog_version_1',
          snapshot_hash: 'snapshot_hash_1',
          lifecycle_state: 'draft',
        },
        {
          holder_id: 'other-holder',
          expires_at: 2000,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.activatePolicyVersion('tenant_a', 'policy_1', 'policy_version_1', {
        snapshotId: 'snapshot_1',
        activationScope: { kind: 'tenant', id: 'tenant_a' },
        holderId: 'current-holder',
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('deactivates an active field mapping set version', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.deactivatePolicyVersion(
      'tenant_a',
      'policy_1',
      'policy_version_1'
    );

    expect(result).toMatchObject({
      id: 'policy_version_1',
      tenantId: 'tenant_a',
      policySetId: 'policy_1',
      lifecycleState: 'published',
      deactivatedAt: 1000,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE mapping_policy_activations'),
      expect.stringContaining('UPDATE compiled_mapping_snapshots'),
      expect.stringContaining('UPDATE mapping_policy_versions'),
    ]);
  });

  it('prevents idempotency-key reuse with a different request hash', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          request_hash: 'previous_hash',
          response_ref: null,
          status: 'in_progress',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.runIdempotent(
        'tenant_a',
        'policy.create',
        'idem-1',
        { policyKey: 'new' },
        async () => ({
          id: 'policy_1',
        })
      )
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects sensitive policy metadata before persistence', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'policy_1',
          tenant_id: 'tenant_a',
          policy_key: 'default',
          display_name: 'Default policy',
          description: null,
          lifecycle_state: 'draft',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createPolicyVersion('tenant_a', 'policy_1', {
        versionLabel: 'v1',
        rules: [
          {
            ruleKey: 'unsafe',
            ruleKind: 'mapping',
            action: 'allow',
            metadata: {
              rawValue: 'person@example.test',
            },
          },
        ],
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects sensitive policy rule references before persistence', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createPolicyVersion('tenant_a', 'policy_1', {
        versionLabel: 'v1',
        rules: [
          {
            ruleKey: 'unsafe-edge',
            ruleKind: 'mapping',
            action: 'allow',
            edges: [
              {
                sourceRef: {
                  namespace: 'csv',
                  path: 'email',
                  rawValue: 'person@example.test',
                },
                targetRef: {
                  namespace: 'authrim.profile',
                  path: 'email',
                },
              },
            ],
          },
        ],
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects oversized or unsupported policy transforms before persistence', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createPolicyVersion('tenant_a', 'policy_1', {
        versionLabel: 'v1',
        rules: [
          {
            ruleKey: 'unsafe-transform',
            ruleKind: 'mapping',
            action: 'allow',
            edges: [
              {
                sourceRef: { namespace: 'csv', path: 'email' },
                targetRef: { namespace: 'authrim.profile', path: 'email' },
              },
            ],
            transforms: [
              {
                edgeIndex: 0,
                operation: 'custom_script',
                parameters: {},
              },
            ],
          },
        ],
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository identity registry operations', () => {
  it('stores source authority contracts and queues projection work without raw values', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const authority = await repository.createSourceAuthorityContract('tenant_a', {
      sourceType: 'scim',
      sourceId: 'scim-directory',
      fieldRef: { namespace: 'authrim.profile', path: 'email' },
      authorityActions: ['write', 'verify'],
      condition: { assuranceLevel: 'ial2' },
      priority: 10,
    });
    const event = await repository.recordMappingEvent('tenant_a', {
      eventType: 'identity.binding.matched',
      sourceId: 'scim-directory',
      subjectId: 'subject-1',
      outcome: 'matched',
      reasonCodes: ['identity.hard_match'],
      traceRef: 'trace://identity/1',
    });
    const outbox = await repository.enqueueProjectionOutbox('tenant_a', {
      eventType: 'subject.updated',
      subjectId: 'subject-1',
      aggregateType: 'identity_subject',
      aggregateId: 'subject-1',
      payload: { changedFields: ['email'] },
    });

    expect(authority.priority).toBe(10);
    expect(event.reasonCodes).toEqual(['identity.hard_match']);
    expect(outbox.status).toBe('pending');
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO source_authority_contracts'),
      expect.stringContaining('INSERT INTO mapping_events'),
      expect.stringContaining('INSERT INTO projection_outbox'),
    ]);
  });

  it('evaluates source authority contracts by source, action, and field ref', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'authority-1',
          tenant_id: 'tenant_a',
          source_type: 'scim',
          source_id: 'scim-directory',
          field_ref_json: JSON.stringify({ namespace: 'authrim.profile', path: 'email' }),
          authority_actions_json: JSON.stringify(['write', 'verify']),
          condition_json: null,
          priority: 10,
          lifecycle_state: 'active',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateSourceAuthorityContract('tenant_a', {
        sourceType: 'scim',
        sourceId: 'scim-directory',
        fieldRef: { path: 'email', namespace: 'authrim.profile' },
        authorityAction: 'write',
      })
    ).resolves.toMatchObject({
      allowed: true,
      contractId: 'authority-1',
      reasonCode: 'source_authority.allowed',
    });

    await expect(
      repository.evaluateSourceAuthorityContract('tenant_a', {
        sourceType: 'scim',
        sourceId: 'scim-directory',
        fieldRef: { namespace: 'authrim.profile', path: 'email' },
        authorityAction: 'revoke',
      })
    ).resolves.toMatchObject({
      allowed: false,
      contractId: null,
      reasonCode: 'source_authority.no_matching_active_contract',
    });
  });

  it('creates replay and projection jobs with safe scoped payloads', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const projectionJob = await repository.createProjectionJob('tenant_a', {
      jobType: 'tenant_discovery_rebuild',
      scope: { tenantId: 'tenant_a', subjectIds: ['subject-1'] },
    });
    const replayJob = await repository.createReplayJob('tenant_a', {
      replayType: 'mapping_policy_impact',
      impactScope: { policyVersionId: 'policy-version-1' },
    });
    const projection = await repository.upsertAdminSearchProjection('tenant_a', {
      id: 'projection-1',
      subjectId: 'subject-1',
      projectionKind: 'identity_summary',
      projection: { displayLabel: 'Ada L.', matchReasons: ['email_domain'] },
      classification: 'internal',
    });

    expect(projectionJob.status).toBe('queued');
    expect(replayJob.status).toBe('queued');
    expect(projection.id).toBe('projection-1');
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO projection_jobs'),
      expect.stringContaining('INSERT INTO replay_jobs'),
      expect.stringContaining('INSERT INTO admin_search_projections'),
    ]);
  });

  it('rejects sensitive projection and outbox payloads', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.enqueueProjectionOutbox('tenant_a', {
        eventType: 'subject.updated',
        aggregateType: 'identity_subject',
        aggregateId: 'subject-1',
        payload: { rawValue: 'person@example.edu' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    await expect(
      repository.upsertAdminSearchProjection('tenant_a', {
        projectionKind: 'identity_summary',
        projection: { token: 'secret-token' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository review and notification operations', () => {
  it('creates redacted review tasks and records idempotent state transitions', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'review-task-1',
          status: 'open',
          subject_id: 'subject-1',
          account_id: 'account-1',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const task = await repository.createReviewTask('tenant_a', {
      taskType: 'identity_link_review',
      subjectId: 'subject-1',
      accountId: 'account-1',
      priority: 20,
      payload: {
        source: 'saml',
        destination: 'oidc',
        riskSummary: 'verified-anchor candidate requires admin approval',
      },
    });
    const transition = await repository.transitionReviewTask('tenant_a', 'review-task-1', {
      status: 'approved',
      assignedTo: 'admin-1',
      reasonCodes: ['admin_approved_candidate_link'],
    });

    expect(task.status).toBe('open');
    expect(transition).toMatchObject({
      previousStatus: 'open',
      status: 'approved',
      idempotent: false,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO review_tasks'),
      expect.stringContaining('UPDATE review_tasks'),
      expect.stringContaining('INSERT INTO mapping_events'),
    ]);
  });

  it('lists review tasks with safe filters for the resolution center', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'review-task-1',
          tenant_id: 'tenant_a',
          task_type: 'mapping_conflict',
          subject_id: 'subject-1',
          account_id: null,
          status: 'open',
          priority: 30,
          assigned_to: 'admin-1',
          payload_json: JSON.stringify({
            title: 'Department conflict needs review',
            source: 'SCIM Directory',
            riskSummary: 'Two trusted sources disagree on a non-PII department label.',
          }),
          due_at: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const tasks = await repository.listReviewTasks('tenant_a', {
      status: 'open',
      taskType: 'mapping_conflict',
      assignedTo: 'admin-1',
      limit: 500,
    });

    expect(tasks).toEqual([
      expect.objectContaining({
        id: 'review-task-1',
        tenantId: 'tenant_a',
        taskType: 'mapping_conflict',
        status: 'open',
        priority: 30,
        assignedTo: 'admin-1',
        payload: expect.objectContaining({
          title: 'Department conflict needs review',
        }),
      }),
    ]);
    expect(adapter.queries[0]).toEqual({
      sql: expect.stringContaining('FROM review_tasks'),
      params: ['tenant_a', 'open', 'mapping_conflict', 'admin-1', 200],
    });
  });

  it('fails closed when stored review task payload contains raw identifiers', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'review-task-raw',
          tenant_id: 'tenant_a',
          task_type: 'identity_link_review',
          subject_id: null,
          account_id: null,
          status: 'open',
          priority: 10,
          assigned_to: null,
          payload_json: JSON.stringify({ email: 'person@example.test' }),
          due_at: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(repository.listReviewTasks('tenant_a')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  it('groups bulk review impact without storing raw values', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const group = await repository.createReviewTaskGroup('tenant_a', {
      groupKey: 'bulk-impact:policy-version-1',
      summary: {
        affectedTenant: 'tenant_a',
        source: 'scim-directory',
        destination: 'saml-sp',
        affectedSubjects: 35,
        risk: 'medium',
      },
    });

    expect(group.groupKey).toBe('bulk-impact:policy-version-1');
    expect(adapter.executes[0].sql).toContain('INSERT INTO review_task_groups');
    expect(String(adapter.executes[0].params[4])).toContain('"affectedSubjects":35');
  });

  it('creates operational notification state for high priority identity mapping events', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const notification = await repository.enqueueOperationalNotification('tenant_a', {
      category: 'identity_mapping_manual_review',
      eventType: 'identity_mapping.review_required',
      severity: 'high',
      subjectType: 'review_task',
      subjectId: 'review-task-1',
      deduplicationKey: 'review-task-1:manual-review',
      payload: {
        reviewTaskId: 'review-task-1',
        reasonCodes: ['candidate_requires_admin_approval'],
      },
    });

    expect(notification).toMatchObject({
      state: 'open',
      severity: 'high',
      category: 'identity_mapping_manual_review',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.stringContaining('INSERT INTO operational_notification_states'),
    ]);
    expect(adapter.executes[0].params[6]).toBe('tenant_a:review-task-1:manual-review');
  });

  it('returns an existing operational notification state for duplicate deduplication keys', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'notification-state-1',
          notification_event_id: 'notification-event-1',
          state: 'open',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const notification = await repository.enqueueOperationalNotification('tenant_a', {
      category: 'identity_mapping_manual_review',
      eventType: 'identity_mapping.review_required',
      severity: 'high',
      subjectType: 'review_task',
      subjectId: 'review-task-1',
      deduplicationKey: 'review-task-1:manual-review',
      payload: {
        reviewTaskId: 'review-task-1',
        reasonCodes: ['candidate_requires_admin_approval'],
      },
    });

    expect(notification).toMatchObject({
      id: 'notification-state-1',
      notificationEventId: 'notification-event-1',
      idempotent: true,
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('acknowledges and resolves operational notification states idempotently', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'notification-state-1',
          state: 'open',
        },
        {
          id: 'notification-state-1',
          state: 'resolved',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.transitionOperationalNotificationState('tenant_a', 'notification-state-1', {
        state: 'resolved',
        assignedTo: 'admin-1',
      })
    ).resolves.toMatchObject({
      previousState: 'open',
      state: 'resolved',
      idempotent: false,
    });
    await expect(
      repository.transitionOperationalNotificationState('tenant_a', 'notification-state-1', {
        state: 'resolved',
      })
    ).resolves.toMatchObject({
      state: 'resolved',
      idempotent: true,
    });
    expect(adapter.executes).toHaveLength(1);
    expect(adapter.executes[0].sql).toContain('UPDATE operational_notification_states');
  });

  it('rejects raw values in review and notification payloads', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createReviewTask('tenant_a', {
        taskType: 'release_review',
        payload: { email: 'person@example.edu' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    await expect(
      repository.enqueueOperationalNotification('tenant_a', {
        category: 'identity_mapping_signal',
        eventType: 'identity_mapping.high_signal',
        severity: 'critical',
        subjectType: 'subject',
        subjectId: 'subject-1',
        payload: { token: 'secret-token' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects unsupported review statuses and notification categories before storage', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'review-task-1',
          status: 'open',
          subject_id: 'subject-1',
          account_id: null,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.transitionReviewTask('tenant_a', 'review-task-1', {
        status: 'raw_user_supplied_status',
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    await expect(
      repository.enqueueOperationalNotification('tenant_a', {
        category: 'storage_registry_security',
        eventType: 'identity_mapping.review_required',
        severity: 'high',
        subjectType: 'review_task',
        subjectId: 'review-task-1',
        payload: {
          reviewTaskId: 'review-task-1',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository provisioning assignment operations', () => {
  it('creates groups, memberships, entitlements, and ownership records', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'group-1',
          group_key: 'faculty',
          display_name: 'Faculty',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createGroup('tenant_a', {
        groupKey: 'faculty',
        displayName: 'Faculty',
        metadata: {
          source: 'provisioning',
        },
      })
    ).resolves.toMatchObject({
      id: 'group-1',
      groupKey: 'faculty',
    });
    await repository.createGroupMembership('tenant_a', {
      groupId: 'group-1',
      subjectId: 'subject-1',
      assignmentSource: 'rule:assignment-rule-1',
      ownershipPolicy: 'source_owned',
      revokePolicy: 'review',
    });
    await repository.grantEntitlement('tenant_a', {
      subjectId: 'subject-1',
      entitlementType: 'permission',
      entitlementKey: 'profile:read',
      sourceId: 'assignment-rule-1',
      revokePolicy: 'auto',
    });

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO "groups"'),
      expect.stringContaining('INSERT INTO group_memberships'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
      expect.stringContaining('INSERT INTO entitlements'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
    ]);
  });

  it('updates existing subject-only assignments before inserting duplicates', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'existing-membership',
        },
        null,
        {
          id: 'existing-entitlement',
        },
        null,
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createGroupMembership('tenant_a', {
        groupId: 'group-1',
        subjectId: 'subject-1',
        assignmentSource: 'rule:assignment-rule-1',
      })
    ).resolves.toMatchObject({
      id: 'existing-membership',
    });
    await expect(
      repository.grantEntitlement('tenant_a', {
        subjectId: 'subject-1',
        entitlementType: 'permission',
        entitlementKey: 'profile:read',
      })
    ).resolves.toMatchObject({
      id: 'existing-entitlement',
    });

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE group_memberships'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
      expect.stringContaining('UPDATE entitlements'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
    ]);
  });

  it('evaluates conditional assignment and grants a group on import, JIT, or registration context', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'group',
          target_id: 'group-1',
          condition_json: JSON.stringify({
            eventTypes: ['import', 'jit', 'registration'],
            sourceTypes: ['scim'],
            domains: ['example.edu'],
          }),
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const evaluation = await repository.evaluateProvisioningAssignmentRule(
      'tenant_a',
      'assignment-rule-1',
      {
        eventType: 'jit',
        sourceType: 'scim',
        domain: 'example.edu',
        subjectId: 'subject-1',
      }
    );

    expect(evaluation).toMatchObject({
      matched: true,
      outcome: 'assigned',
      targetType: 'group',
      targetId: 'group-1',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO group_memberships'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
      expect.stringContaining('INSERT INTO provisioning_assignment_events'),
    ]);
  });

  it('records dry-run assignment events without granting memberships or entitlements', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'permission',
          target_id: 'profile:read',
          condition_json: JSON.stringify({
            eventTypes: ['import'],
          }),
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateProvisioningAssignmentRule('tenant_a', 'assignment-rule-1', {
        eventType: 'import',
        subjectId: 'subject-1',
        dryRun: true,
      })
    ).resolves.toMatchObject({
      matched: true,
      outcome: 'assigned',
      dryRun: true,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO provisioning_assignment_events'),
    ]);
  });

  it('does not grant assignments when a persisted rule has malformed condition JSON', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'group',
          target_id: 'group-1',
          condition_json: '{not-json',
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateProvisioningAssignmentRule('tenant_a', 'assignment-rule-1', {
        eventType: 'jit',
        sourceType: 'scim',
        domain: 'example.edu',
        subjectId: 'subject-1',
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects raw identifiers in assignment conditions and entitlement values', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createProvisioningAssignmentRule('tenant_a', {
        ruleType: 'email_exact_match',
        targetType: 'group',
        targetId: 'group-1',
        condition: {
          claims: {
            email: 'person@example.edu',
          },
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    await expect(
      repository.grantEntitlement('tenant_a', {
        subjectId: 'subject-1',
        entitlementType: 'permission',
        entitlementKey: 'profile:read',
        value: {
          email: 'person@example.edu',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('creates domain group rules that can match later source contexts by domain hash', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'group',
          target_id: 'group-1',
          condition_json: JSON.stringify({
            claims: {
              domainHash: 'blind-domain-hash',
            },
          }),
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateProvisioningAssignmentRule('tenant_a', 'assignment-rule-1', {
        eventType: 'jit',
        sourceType: 'scim',
        subjectId: 'subject-1',
        claims: {
          domainHash: 'blind-domain-hash',
        },
      })
    ).resolves.toMatchObject({
      matched: true,
      outcome: 'assigned',
      targetType: 'group',
      targetId: 'group-1',
    });
  });

  it('records SCIM active:false lifecycle signal as an account suspension decision', async () => {
    const adapter = createAdapter({
      queryOneRows: [null],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.recordExternalLifecycleSignal('tenant_a', {
      sourceType: 'scim',
      sourceId: 'directory-1',
      sourceEventId: 'event-1',
      signalType: 'scim_active_false',
      accountId: 'account-1',
      targetType: 'account',
      targetId: 'account-1',
    });

    expect(result).toMatchObject({
      decision: 'suspend_account',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO external_lifecycle_signal_events'),
      expect.stringContaining('INSERT INTO external_lifecycle_signal_decisions'),
      expect.stringContaining('UPDATE identity_accounts'),
      expect.stringContaining('INSERT INTO provisioning_revocation_events'),
      expect.stringContaining('UPDATE external_lifecycle_signal_events'),
    ]);
  });

  it('routes protected SCIM group removal, CSV diff, and claim disappearance to review instead of silent revoke', async () => {
    for (const signalType of [
      'scim_group_removed',
      'csv_diff_removed',
      'claim_disappeared',
    ] as const) {
      const adapter = createAdapter({
        queryOneRows: [null],
      });
      const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

      const result = await repository.recordExternalLifecycleSignal('tenant_a', {
        sourceType: signalType.startsWith('scim') ? 'scim' : 'csv',
        sourceId: 'source-1',
        sourceEventId: `${signalType}-source-event`,
        signalType,
        subjectId: 'subject-1',
        targetType: signalType === 'scim_group_removed' ? 'group_membership' : 'entitlement',
        targetId: 'assignment-1',
        ownership: {
          assignmentType: signalType === 'scim_group_removed' ? 'group_membership' : 'entitlement',
          assignmentId: 'assignment-1',
          ownershipPolicy: 'manual',
          revokePolicy: 'auto',
          protectedUntil: 2000,
        },
      });

      expect(result.decision).toBe('review');
      expect(adapter.executes.map((item) => item.sql).join('\n')).not.toContain(
        'SET lifecycle_state = ?'
      );
      expect(adapter.executes.map((item) => item.sql)).toEqual([
        expect.stringContaining('INSERT INTO external_lifecycle_signal_events'),
        expect.stringContaining('INSERT INTO external_lifecycle_signal_decisions'),
        expect.stringContaining('INSERT INTO provisioning_revocation_events'),
        expect.stringContaining('UPDATE external_lifecycle_signal_events'),
      ]);
    }
  });

  it('applies source-owned auto revocation for entitlement lifecycle signals', async () => {
    const adapter = createAdapter({
      queryOneRows: [null],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.recordExternalLifecycleSignal('tenant_a', {
      sourceType: 'csv',
      sourceId: 'directory-export',
      sourceEventId: 'event-1',
      signalType: 'csv_diff_removed',
      subjectId: 'subject-1',
      targetType: 'entitlement',
      targetId: 'entitlement-1',
      ownership: {
        assignmentType: 'entitlement',
        assignmentId: 'entitlement-1',
        ownershipPolicy: 'source_owned',
        revokePolicy: 'auto',
      },
    });

    expect(result).toMatchObject({
      decision: 'revoke',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO external_lifecycle_signal_events'),
      expect.stringContaining('INSERT INTO external_lifecycle_signal_decisions'),
      expect.stringContaining('UPDATE entitlements'),
      expect.stringContaining('INSERT INTO provisioning_revocation_events'),
      expect.stringContaining('UPDATE external_lifecycle_signal_events'),
    ]);
  });

  it('does not duplicate lifecycle signal decisions or revocation side effects for retries', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'signal-event-1',
          processing_state: 'processed',
        },
        {
          decision: 'review',
          reason_codes_json: JSON.stringify([
            'lifecycle_signal.scim_group_removed',
            'provisioning.revocation.review_required',
          ]),
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.recordExternalLifecycleSignal('tenant_a', {
        sourceType: 'scim',
        sourceId: 'directory-1',
        sourceEventId: 'event-1',
        signalType: 'scim_group_removed',
        subjectId: 'subject-1',
        targetType: 'group_membership',
        targetId: 'membership-1',
      })
    ).resolves.toMatchObject({
      signalEventId: 'signal-event-1',
      decision: 'review',
      idempotent: true,
      reasonCodes: [
        'lifecycle_signal.scim_group_removed',
        'provisioning.revocation.review_required',
      ],
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository federation trust and key lifecycle operations', () => {
  it('creates key registries with external material references only', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createKeyRegistry('tenant_a', {
        keyPurpose: 'blind_index',
        scope: { table: 'contact_points', field: 'normalized_hash' },
        algorithm: 'hmac-sha256',
        backendType: 'wrangler_secret',
        materialRef: 'wrangler-secret:CONTACT_BLIND_INDEX_KEY_V1',
        materialMetadata: { rotationWindowDays: 30 },
        actorId: 'admin-1',
      })
    ).resolves.toMatchObject({
      tenantId: 'tenant_a',
      keyPurpose: 'blind_index',
      status: 'active',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO key_registries'),
      expect.stringContaining('INSERT INTO key_versions'),
      expect.stringContaining('INSERT INTO key_material_refs'),
      expect.stringContaining('INSERT INTO key_access_events'),
    ]);
    expect(adapter.executes[2].params[4]).toBe('wrangler-secret:CONTACT_BLIND_INDEX_KEY_V1');
  });

  it('lists key registry metadata without material references', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'key-registry-1',
          key_purpose: 'blind_index',
          scope_json: JSON.stringify({ table: 'contact_points' }),
          active_version_id: 'key-version-1',
          status: 'active',
          created_at: 1000,
          updated_at: 1100,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(repository.listKeyRegistries('tenant_a')).resolves.toEqual([
      {
        id: 'key-registry-1',
        tenantId: 'tenant_a',
        keyPurpose: 'blind_index',
        scope: { table: 'contact_points' },
        activeVersionId: 'key-version-1',
        status: 'active',
        createdAt: 1000,
        updatedAt: 1100,
      },
    ]);
  });

  it('rejects inline private key material for key lifecycle references', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createKeyRegistry('tenant_a', {
        keyPurpose: 'signing',
        scope: { surface: 'saml' },
        algorithm: 'rsa-pss-sha256',
        backendType: 'inline',
        materialRef: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rotates key registries and queues resumable rewrap and blind-index jobs', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ active_version_id: 'key-version-1' }, { version: 1 }],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.rotateKeyRegistry('tenant_a', 'key-registry-1', {
        algorithm: 'hmac-sha256',
        backendType: 'wrangler_secret',
        materialRef: 'wrangler-secret:CONTACT_BLIND_INDEX_KEY_V2',
        jobMode: 'both',
        artifactScope: { tables: ['contact_points', 'identity_binding_lookup_indexes'] },
        actorId: 'admin-1',
      })
    ).resolves.toMatchObject({
      keyRegistryId: 'key-registry-1',
      version: 2,
      jobs: [{ type: 'rewrap' }, { type: 'blind_index_rotation' }],
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO key_versions'),
      expect.stringContaining('INSERT INTO key_material_refs'),
      expect.stringContaining('UPDATE key_versions'),
      expect.stringContaining('UPDATE key_registries'),
      expect.stringContaining('INSERT INTO rewrap_jobs'),
      expect.stringContaining('INSERT INTO blind_index_rotation_jobs'),
      expect.stringContaining('INSERT INTO key_access_events'),
    ]);
    expect(String(adapter.executes[5].params[6])).toContain('dual_read');
  });

  it('creates normalized SAML federation trust sources with anchors and scope bindings', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createFederationTrustSource('tenant_a', {
        sourceType: 'saml_aggregate',
        sourceKey: 'edugain-pilot',
        displayName: 'eduGAIN pilot',
        lifecycleState: 'active',
        protocolPayload: {
          metadataUrlPatterns: ['https://metadata.example.test/*.xml'],
          policy: 'strict',
        },
        anchors: [
          {
            anchorType: 'x509_sha256',
            anchorHash: 'sha256:abc',
            anchorRef: 'cert-1',
          },
        ],
        scopeBindings: [{ scopeType: 'tenant', scopeId: 'tenant_a' }],
      })
    ).resolves.toMatchObject({
      tenantId: 'tenant_a',
      sourceType: 'saml_aggregate',
      sourceKey: 'edugain-pilot',
      lifecycleState: 'active',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO federation_trust_sources'),
      expect.stringContaining('INSERT INTO federation_trust_anchors'),
      expect.stringContaining('INSERT INTO federation_trust_scope_bindings'),
      expect.stringContaining('INSERT INTO federation_trust_context_snapshots'),
    ]);
    expect(String(adapter.executes[3].params[4])).toContain('sourceKey');
  });

  it('rejects unsupported federation trust source lifecycle states', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createFederationTrustSource('tenant_a', {
        sourceType: 'saml_aggregate',
        sourceKey: 'edugain-pilot',
        displayName: 'eduGAIN pilot',
        lifecycleState: 'deleted' as never,
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('lists normalized federation trust source metadata for Admin UI migration', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'trust-source-1',
          source_type: 'saml_aggregate',
          source_key: 'legacy-saml-profile:profile-1',
          display_name: 'Legacy Federation',
          lifecycle_state: 'active',
          protocol_payload_json: JSON.stringify({ policy: 'strict' }),
          created_at: 1000,
          updated_at: 1100,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(repository.listFederationTrustSources('tenant_a')).resolves.toEqual([
      {
        id: 'trust-source-1',
        tenantId: 'tenant_a',
        sourceType: 'saml_aggregate',
        sourceKey: 'legacy-saml-profile:profile-1',
        displayName: 'Legacy Federation',
        lifecycleState: 'active',
        protocolPayload: { policy: 'strict' },
        createdAt: 1000,
        updatedAt: 1100,
      },
    ]);
  });

  it('registers federation metadata documents with validation and entity summaries', async () => {
    const adapter = createAdapter({ queryOneRows: [{ id: 'trust-source-1' }] });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.registerFederationMetadataDocument('tenant_a', {
        trustSourceId: 'trust-source-1',
        documentType: 'saml_aggregate',
        sourceUrl: 'https://metadata.example.test/aggregate.xml',
        documentHash: 'sha256:metadata',
        documentRef: 'r2://metadata/aggregate.xml',
        validationState: 'valid',
        entitySummaries: [
          {
            entityId: 'https://sp.example.test/sp',
            entityRole: 'sp',
            displayName: 'Example SP',
            summary: { requestedAttributes: ['mail'] },
          },
        ],
      })
    ).resolves.toMatchObject({
      trustSourceId: 'trust-source-1',
      validationState: 'valid',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO federation_metadata_documents'),
      expect.stringContaining('INSERT INTO federation_metadata_validation_events'),
      expect.stringContaining('INSERT INTO federation_metadata_entity_summaries'),
    ]);
    expect(String(adapter.executes[2].params[6])).toContain('requestedAttributes');
  });

  it('lists federation metadata documents with normalized entity summaries', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'trust-source-1' }],
      queryRows: [
        {
          id: 'metadata-document-1',
          trust_source_id: 'trust-source-1',
          document_type: 'saml_aggregate',
          source_url: 'https://metadata.example.test/aggregate.xml',
          document_hash: 'sha256:metadata',
          document_ref: 'r2://metadata/aggregate.xml',
          fetched_at: 1000,
          validated_at: 1100,
          validation_state: 'valid',
          created_at: 1000,
          updated_at: 1100,
          entity_summary_id: 'entity-summary-1',
          entity_id: 'https://sp.example.test/sp',
          entity_role: 'sp',
          display_name: 'Example SP',
          summary_json: JSON.stringify({ requestedAttributes: ['mail'] }),
        },
        {
          id: 'metadata-document-1',
          trust_source_id: 'trust-source-1',
          document_type: 'saml_aggregate',
          source_url: 'https://metadata.example.test/aggregate.xml',
          document_hash: 'sha256:metadata',
          document_ref: 'r2://metadata/aggregate.xml',
          fetched_at: 1000,
          validated_at: 1100,
          validation_state: 'valid',
          created_at: 1000,
          updated_at: 1100,
          entity_summary_id: 'entity-summary-2',
          entity_id: 'https://idp.example.test/idp',
          entity_role: 'idp',
          display_name: 'Example IdP',
          summary_json: null,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.listFederationMetadataDocuments('tenant_a', 'trust-source-1')
    ).resolves.toEqual([
      {
        id: 'metadata-document-1',
        tenantId: 'tenant_a',
        trustSourceId: 'trust-source-1',
        documentType: 'saml_aggregate',
        sourceUrl: 'https://metadata.example.test/aggregate.xml',
        documentHash: 'sha256:metadata',
        documentRef: 'r2://metadata/aggregate.xml',
        fetchedAt: 1000,
        validatedAt: 1100,
        validationState: 'valid',
        createdAt: 1000,
        updatedAt: 1100,
        entitySummaries: [
          {
            id: 'entity-summary-1',
            entityId: 'https://sp.example.test/sp',
            entityRole: 'sp',
            displayName: 'Example SP',
            summary: { requestedAttributes: ['mail'] },
          },
          {
            id: 'entity-summary-2',
            entityId: 'https://idp.example.test/idp',
            entityRole: 'idp',
            displayName: 'Example IdP',
            summary: null,
          },
        ],
      },
    ]);
    expect(adapter.queries[0].sql).toContain('FROM federation_metadata_documents');
  });

  it('rejects federation metadata documents for unknown trust sources', async () => {
    const adapter = createAdapter({ queryOneRows: [null] });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.registerFederationMetadataDocument('tenant_a', {
        trustSourceId: 'missing-source',
        documentType: 'saml_aggregate',
        documentHash: 'sha256:metadata',
      })
    ).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('records key access only for existing tenant-scoped registries and versions', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'key-registry-1' }, { id: 'key-version-1' }],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.recordKeyAccess('tenant_a', 'key-registry-1', {
        keyVersionId: 'key-version-1',
        accessType: 'material.sign',
        outcome: 'success',
        actorId: 'admin-1',
      })
    ).resolves.toEqual({ keyRegistryId: 'key-registry-1', recorded: true });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO key_access_events'),
    ]);
  });

  it('rejects unsupported key access event values before writing audit rows', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.recordKeyAccess('tenant_a', 'key-registry-1', {
        accessType: 'arbitrary.event',
        outcome: 'success',
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository schema and template catalogs', () => {
  it('stores protocol schemas, external schemas, and mapping templates', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await repository.createProtocolSchema('tenant_a', {
      protocol: 'scim',
      schemaKey: 'User',
      schemaVersion: '2.0',
      schema: { attributes: [{ name: 'userName', type: 'string' }] },
    });
    await repository.importExternalSchema('tenant_a', {
      sourceType: 'saml',
      sourceId: 'idp-1',
      schemaKey: 'attributes',
      schema: { attributes: [{ name: 'mail' }] },
    });
    await repository.createMappingTemplate('tenant_a', {
      templateKey: 'csv-basic',
      displayName: 'CSV Basic',
      template: { rules: [{ from: 'email', to: 'authrim.profile.email' }] },
    });

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO protocol_schema_catalogs'),
      expect.stringContaining('INSERT INTO external_schema_catalogs'),
      expect.stringContaining('INSERT INTO mapping_templates'),
    ]);
    expect(String(adapter.executes[0].params[5])).toBe(
      '{"attributes":[{"name":"userName","type":"string"}]}'
    );
  });

  it('rejects oversized imported schema catalogs before persistence', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.importExternalSchema('tenant_a', {
        sourceType: 'saml',
        sourceId: 'idp-1',
        schemaKey: 'attributes',
        schema: {
          attributes: [{ name: 'mail', description: 'x'.repeat(4097) }],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('identity mapping control plane Admin API handlers', () => {
  it('lists policy sets through the Admin API response shape', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'policy_1',
          tenant_id: 'tenant_a',
          policy_key: 'default',
          display_name: 'Default policy',
          description: null,
          owner_scope_type: 'tenant',
          owner_scope_id: null,
          lifecycle_state: 'draft',
          created_at: 1000,
          updated_at: 1000,
        },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.get('/api/admin/field-mapping/field-mapping-sets', adminIdentityMappingPoliciesListHandler);

    const response = await app.request(
      '/api/admin/field-mapping/field-mapping-sets',
      { headers: { 'X-Tenant-Id': 'tenant_a' } },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      policies: [
        {
          id: 'policy_1',
          tenantId: 'tenant_a',
          policyKey: 'default',
          displayName: 'Default policy',
          description: null,
          lifecycleState: 'draft',
        },
      ],
    });
  });

  it('lists protocol schemas through the Admin API response shape', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'protocol_schema_1',
          tenant_id: 'tenant_a',
          protocol: 'scim',
          schema_key: 'User',
          schema_version: '2.0',
          schema_json: '{"attributes":[{"name":"userName"}]}',
          lifecycle_state: 'active',
          created_at: 1000,
          updated_at: 1000,
        },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.get(
      '/api/admin/field-mapping/protocol-schemas',
      adminIdentityMappingProtocolSchemasListHandler
    );

    const response = await app.request(
      '/api/admin/field-mapping/protocol-schemas',
      { headers: { 'X-Tenant-Id': 'tenant_a' } },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      protocolSchemas: [
        {
          id: 'protocol_schema_1',
          tenantId: 'tenant_a',
          protocol: 'scim',
          schemaKey: 'User',
          schemaVersion: '2.0',
          schema: { attributes: [{ name: 'userName' }] },
          lifecycleState: 'active',
        },
      ],
    });
  });

  it('rejects tenant admins creating platform-scoped destination profiles', async () => {
    const adapter = createAdapter({});
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', 'tenant_a');
      (c as unknown as { set(key: string, value: unknown): void }).set('adminAuth', {
        roles: ['tenant_admin'],
        is_platform_admin: false,
      });
      await next();
    });
    app.post(
      '/api/admin/field-mapping/destination-profiles',
      adminIdentityMappingDestinationProfileCreateHandler
    );

    const response = await app.request(
      '/api/admin/field-mapping/destination-profiles',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': 'tenant_a',
          'Idempotency-Key': 'deny-platform-destination',
        },
        body: JSON.stringify({
          ownerScopeType: 'platform',
          destinationType: 'csv',
          profileKey: 'platform_export',
          displayName: 'Platform export',
          schema: {
            destinationType: 'csv',
            columns: [{ columnName: 'email', label: 'Email', order: 1 }],
          },
        }),
      },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(403);
    expect(adapter.executes.map((item) => item.sql).join('\n')).not.toContain(
      'INSERT INTO destination_profiles'
    );
  });

  it('rejects tenant admins creating platform-scoped attribute registries', async () => {
    const adapter = createAdapter({});
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', 'tenant_a');
      (c as unknown as { set(key: string, value: unknown): void }).set('adminAuth', {
        roles: ['tenant_admin'],
        is_platform_admin: false,
      });
      await next();
    });
    app.post(
      '/api/admin/field-mapping/attribute-groups',
      adminIdentityMappingAttributeGroupCreateHandler
    );
    app.post(
      '/api/admin/field-mapping/attribute-fields',
      adminIdentityMappingAttributeFieldCreateHandler
    );

    const groupResponse = await app.request(
      '/api/admin/field-mapping/attribute-groups',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': 'tenant_a',
          'Idempotency-Key': 'deny-platform-scope',
        },
        body: JSON.stringify({
          ownerScopeType: 'platform',
          protocol: 'oidc',
          groupType: 'scope',
          groupKey: 'library',
          displayName: 'Library',
          fieldKeys: ['library_card'],
        }),
      },
      { DB_ADMIN: adapter } as unknown as Env
    );
    const fieldResponse = await app.request(
      '/api/admin/field-mapping/attribute-fields',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': 'tenant_a',
          'Idempotency-Key': 'deny-platform-claim',
        },
        body: JSON.stringify({
          ownerScopeType: 'platform',
          protocol: 'oidc',
          fieldKey: 'library_card',
          displayName: 'Library card',
          classification: 'pii',
          surfaces: ['userinfo'],
        }),
      },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(groupResponse.status).toBe(403);
    expect(fieldResponse.status).toBe(403);
    const executedSql = adapter.executes.map((item) => item.sql).join('\n');
    expect(executedSql).not.toContain('INSERT INTO attribute_group_registry');
    expect(executedSql).not.toContain('INSERT INTO attribute_field_registry');
  });

  it('lists review tasks through the Admin API response shape', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'review-task-1',
          tenant_id: 'tenant_a',
          task_type: 'missing_mapping',
          subject_id: null,
          account_id: 'account-1',
          status: 'open',
          priority: 12,
          assigned_to: null,
          payload_json: JSON.stringify({
            title: 'CSV department needs target',
            source: 'CSV import profile',
            impact: 'Activation remains blocked until the target field is selected.',
          }),
          due_at: null,
          created_at: 1000,
          updated_at: 1100,
        },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: string): void }).set('tenantId', 'tenant_a');
      await next();
    });
    app.get('/api/admin/field-mapping/review-tasks', adminIdentityMappingReviewTasksListHandler);

    const response = await app.request(
      '/api/admin/field-mapping/review-tasks?status=open&limit=5',
      { headers: { 'X-Tenant-Id': 'tenant_a' } },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reviewTasks: [
        {
          id: 'review-task-1',
          tenantId: 'tenant_a',
          taskType: 'missing_mapping',
          subjectId: null,
          accountId: 'account-1',
          status: 'open',
          priority: 12,
          assignedTo: null,
          payload: {
            title: 'CSV department needs target',
            source: 'CSV import profile',
            impact: 'Activation remains blocked until the target field is selected.',
          },
          dueAt: null,
          createdAt: 1000,
          updatedAt: 1100,
        },
      ],
    });
    expect(adapter.queries[0].params).toEqual(['tenant_a', 'open', 5]);
  });

  it('lists schema readiness with gate state and schema presence from sqlite metadata', async () => {
    const adapter = createAdapter({
      queryRows: [
        { name: 'mapping_policy_sets' },
        { name: 'mapping_policy_versions' },
        { name: 'mapping_rule_edges' },
        { name: 'review_tasks' },
        { name: 'attribute_release_consents' },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: string): void }).set('tenantId', 'tenant_a');
      await next();
    });
    app.get(
      '/api/admin/field-mapping/schema-readiness',
      adminIdentityMappingSchemaReadinessHandler
    );

    const response = await app.request(
      '/api/admin/field-mapping/schema-readiness',
      { headers: { 'X-Tenant-Id': 'tenant_a' } },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rows: Array<{
        id: string;
        schemaObject?: string;
        schemaPresent: boolean | null;
        gateState: string;
      }>;
      summary: { blocked: number; deferred: number; total: number };
    };
    expect(body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'UIM-SCH-016',
          schemaObject: 'mapping_policy_sets',
          schemaPresent: true,
          gateState: 'pass',
        }),
        expect.objectContaining({
          id: 'UIM-SCH-071',
          schemaObject: 'federation_trust_sources',
          schemaPresent: false,
          gateState: 'blocked',
        }),
        expect.objectContaining({
          id: 'UIM-SCH-086',
          schemaPresent: null,
          gateState: 'deferred',
        }),
      ])
    );
    expect(body.summary.total).toBeGreaterThan(10);
    expect(body.summary.blocked).toBeGreaterThan(0);
    expect(body.summary.deferred).toBeGreaterThan(0);
  });

  it('lists federation metadata documents through the Admin API response shape', async () => {
    const adapter = createAdapter({
      queryOneRows: [{ id: 'trust-source-1' }],
      queryRows: [
        {
          id: 'metadata-document-1',
          trust_source_id: 'trust-source-1',
          document_type: 'saml_aggregate',
          source_url: null,
          document_hash: 'sha256:metadata',
          document_ref: null,
          fetched_at: 1000,
          validated_at: 1100,
          validation_state: 'valid',
          created_at: 1000,
          updated_at: 1100,
          entity_summary_id: 'entity-summary-1',
          entity_id: 'https://sp.example.test/sp',
          entity_role: 'sp',
          display_name: 'Example SP',
          summary_json: '{}',
        },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: string): void }).set('tenantId', 'tenant_a');
      await next();
    });
    app.get(
      '/api/admin/field-mapping/federation-trust-sources/:trustSourceId/metadata-documents',
      adminIdentityMappingFederationMetadataDocumentsListHandler
    );

    const response = await app.request(
      '/api/admin/field-mapping/federation-trust-sources/trust-source-1/metadata-documents',
      {},
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      federationMetadataDocuments: [
        {
          id: 'metadata-document-1',
          tenantId: 'tenant_a',
          trustSourceId: 'trust-source-1',
          validationState: 'valid',
          entitySummaries: [
            {
              id: 'entity-summary-1',
              entityId: 'https://sp.example.test/sp',
              entityRole: 'sp',
              displayName: 'Example SP',
            },
          ],
        },
      ],
    });
  });

  it('requires idempotency keys for mutation handlers', async () => {
    const adapter = createAdapter({});
    const app = new Hono<{ Bindings: Env }>();
    app.post('/api/admin/field-mapping/field-mapping-sets', adminIdentityMappingPolicyCreateHandler);

    const response = await app.request(
      '/api/admin/field-mapping/field-mapping-sets',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant_a',
        },
        body: JSON.stringify({
          policyKey: 'default',
          displayName: 'Default policy',
        }),
      },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Idempotency-Key header is required',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});
