import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabaseRegistryRow } from '../../repositories/admin/tenant-database-registry';
import {
  createTenantDatabaseDerivedBindingManifest,
  reconcileTenantDatabaseDerivedBindings,
} from '../tenant-database-reconciliation';

function createRow(overrides: Partial<TenantDatabaseRegistryRow> = {}): TenantDatabaseRegistryRow {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    generation: 1,
    shard_group: 'default',
    shard_index: 0,
    provider: 'd1',
    database_id: 'db-id',
    database_name: 'authrim-dev-tenant-a-core',
    binding_ref: 'TDB_TENANT_A_CORE',
    connection_ref: null,
    schema_version: 1,
    status: 'active',
    shard_count: 1,
    shard_key_strategy: 'hash_user_id',
    worker_shard: 'primary',
    deployment_target: 'edge-a',
    region_hint: null,
    jurisdiction: null,
    signature: null,
    signature_key_id: null,
    metadata_json: null,
    created_at: '2026-05-16T00:00:00.000Z',
    updated_at: '2026-05-16T00:00:00.000Z',
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

describe('tenant database reconciliation', () => {
  it('treats generated bindings as registry-derived manifest entries', () => {
    const manifest = createTenantDatabaseDerivedBindingManifest([
      createRow({ tenant_id: 'tenant-b' }),
      createRow({ tenant_id: 'tenant-a' }),
    ]);

    expect(manifest.map((entry) => entry.tenantId)).toEqual(['tenant-a', 'tenant-b']);
    expect(manifest[0]).toMatchObject({
      bindingRef: 'TDB_TENANT_A_CORE',
      databaseId: 'db-id',
      derivedFrom: 'tenant_database_registry',
    });
  });

  it('finds missing Worker bindings and missing Cloudflare D1 database ids', () => {
    const result = reconcileTenantDatabaseDerivedBindings({
      env: {
        TDB_TENANT_A_CORE: { prepare: vi.fn(), batch: vi.fn() },
      },
      rows: [
        createRow(),
        createRow({
          tenant_id: 'tenant-b',
          database_id: 'missing-db-id',
          binding_ref: 'TDB_TENANT_B_CORE',
        }),
      ],
      cloudflareDatabaseIds: new Set(['db-id']),
    });

    expect(result.checked).toBe(2);
    expect(result.findings.map((finding) => finding.type)).toEqual([
      'missing_binding',
      'database_id_not_found',
    ]);
    expect(result.findings.every((finding) => finding.severity === 'critical')).toBe(true);
  });
});
