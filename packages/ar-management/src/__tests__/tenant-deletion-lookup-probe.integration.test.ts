import type { D1Database } from '@cloudflare/workers-types';
import type { ControlTenantDeletionLookupShardTarget, Env } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';
import { tenantLookupIdentifierDisableEvidence } from '../tenant-deletion-lookup-cleanup';

/**
 * The read-only evidence the deletion cancel reads for a job that predates the durable marker: how
 * many identifier rows the tenant has on the Control inventory's shards, and how many are disabled. Real SQL (node:sqlite) behind a minimal
 * D1 `first-primary` session.
 */
function d1(database: SQLiteDatabase): D1Database {
  const session = {
    prepare: (sql: string) => ({
      bind: (...values: SQLInputValue[]) => ({
        first: async () => database.prepare(sql).get(...values) ?? null,
      }),
    }),
    batch: async () => [],
  };
  return { withSession: () => session } as unknown as D1Database;
}

function lookupDatabase(): SQLiteDatabase {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE lookup_identifiers (
      tenant_id TEXT NOT NULL, tenant_lifecycle_state TEXT NOT NULL,
      runtime_route_status TEXT NOT NULL, lifecycle_state TEXT NOT NULL
    );
    CREATE TABLE lookup_tenant_aliases (
      tenant_id TEXT NOT NULL, tenant_lifecycle_state TEXT NOT NULL,
      runtime_route_status TEXT NOT NULL, lifecycle_state TEXT NOT NULL
    );
  `);
  for (const table of ['lookup_identifiers', 'lookup_tenant_aliases']) {
    for (const tenantId of ['tenant-a', 'tenant-other']) {
      database
        .prepare(`INSERT INTO ${table} VALUES (?, 'active', 'active', 'active')`)
        .run(tenantId);
    }
  }
  return database;
}

describe('tenantLookupIdentifierDisableEvidence', () => {
  let first: SQLiteDatabase;
  let second: SQLiteDatabase;

  beforeEach(() => {
    first = lookupDatabase();
    second = lookupDatabase();
  });

  const env = (overrides: Record<string, unknown> = {}) =>
    ({
      LOOKUP_ONE: d1(first),
      LOOKUP_TWO: d1(second),
      ...overrides,
    }) as unknown as Env;
  const shards: ControlTenantDeletionLookupShardTarget[] = [
    { lookupShardId: 'lookup-one', bindingRef: 'LOOKUP_ONE', status: 'active' },
    { lookupShardId: 'lookup-two', bindingRef: 'LOOKUP_TWO', status: 'draining' },
  ];
  const disable = (database: SQLiteDatabase, table: string, tenantId = 'tenant-a') =>
    database
      .prepare(`UPDATE ${table} SET tenant_lifecycle_state = 'disabled' WHERE tenant_id = ?`)
      .run(tenantId);

  it('counts rows across shards and none disabled while the tenant is live', async () => {
    expect(await tenantLookupIdentifierDisableEvidence(env(), shards, 'tenant-a')).toEqual({
      identifierRows: 2,
      disabledIdentifierRows: 0,
    });
  });

  it('sees a disabled identifier row on any shard, only for that tenant', async () => {
    disable(second, 'lookup_identifiers');
    expect(await tenantLookupIdentifierDisableEvidence(env(), shards, 'tenant-a')).toEqual({
      identifierRows: 2,
      disabledIdentifierRows: 1,
    });
    expect(await tenantLookupIdentifierDisableEvidence(env(), shards, 'tenant-other')).toEqual({
      identifierRows: 2,
      disabledIdentifierRows: 0,
    });
  });

  it('is NOT fooled by a disabled alias row: client deletion, invitation cancel and custom-domain removal write those on a live tenant', async () => {
    disable(first, 'lookup_tenant_aliases');
    disable(second, 'lookup_tenant_aliases');
    expect(await tenantLookupIdentifierDisableEvidence(env(), shards, 'tenant-a')).toEqual({
      identifierRows: 2,
      disabledIdentifierRows: 0,
    });
  });

  it('reports no evidence (zero rows) for a tenant without identifiers, and never writes', async () => {
    expect(await tenantLookupIdentifierDisableEvidence(env(), shards, 'nobody')).toEqual({
      identifierRows: 0,
      disabledIdentifierRows: 0,
    });
    expect(
      first
        .prepare("SELECT COUNT(*) AS n FROM lookup_identifiers WHERE lifecycle_state <> 'active'")
        .get()
    ).toEqual({ n: 0 });
  });

  it('throws (the caller refuses) when a binding, the shard list or the tenant id is unusable', async () => {
    await expect(
      tenantLookupIdentifierDisableEvidence(env({ LOOKUP_TWO: undefined }), shards, 'tenant-a')
    ).rejects.toThrow('tenant_deletion_lookup_binding_unavailable');
    await expect(tenantLookupIdentifierDisableEvidence(env(), [], 'tenant-a')).rejects.toThrow(
      'tenant_deletion_lookup_shards_unavailable'
    );
    await expect(
      tenantLookupIdentifierDisableEvidence(env(), shards, "tenant'; DROP")
    ).rejects.toThrow('tenant_deletion_lookup_cleanup_unavailable');
  });
});
