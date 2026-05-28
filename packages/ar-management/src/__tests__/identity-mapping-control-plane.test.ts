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
  adminIdentityMappingProtocolSchemasListHandler,
  adminIdentityMappingPoliciesListHandler,
  adminIdentityMappingPolicyCreateHandler,
  IdentityMappingControlPlaneRepository,
} from '../identity-mapping-control-plane';

interface RecordedExecute {
  sql: string;
  params: unknown[];
}

function createAdapter(options: {
  queryRows?: Record<string, unknown>[];
  queryOneRows?: Array<Record<string, unknown> | null>;
}): DatabaseAdapter & { executes: RecordedExecute[] } {
  const executes: RecordedExecute[] = [];
  const queryRows = [...(options.queryRows ?? [])];
  const queryOneRows = [...(options.queryOneRows ?? [])];
  const executeResult: ExecuteResult = { rowsAffected: 1, success: true };
  return {
    executes,
    async query<T>(): Promise<T[]> {
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
});

describe('IdentityMappingControlPlaneRepository policy activation', () => {
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
    app.get('/api/admin/identity-mapping/policies', adminIdentityMappingPoliciesListHandler);

    const response = await app.request(
      '/api/admin/identity-mapping/policies',
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
      '/api/admin/identity-mapping/protocol-schemas',
      adminIdentityMappingProtocolSchemasListHandler
    );

    const response = await app.request(
      '/api/admin/identity-mapping/protocol-schemas',
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

  it('requires idempotency keys for mutation handlers', async () => {
    const adapter = createAdapter({});
    const app = new Hono<{ Bindings: Env }>();
    app.post('/api/admin/identity-mapping/policies', adminIdentityMappingPolicyCreateHandler);

    const response = await app.request(
      '/api/admin/identity-mapping/policies',
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
