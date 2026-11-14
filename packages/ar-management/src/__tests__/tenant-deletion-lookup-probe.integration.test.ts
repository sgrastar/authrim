import type { D1Database } from '@cloudflare/workers-types';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  signLookupShardRegistry,
  type ControlTenantDeletionLookupShardTarget,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  let privateJwk: JWK;
  let publicJwk: JWK;
  let registry: Map<string, string>;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'lookup-probe-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'lookup-probe-a', alg: 'EdDSA' };
  });

  beforeEach(async () => {
    first = lookupDatabase();
    second = lookupDatabase();
    // The verified bucket assignment the disable step checks the inventory against.
    const now = Math.floor(Date.now() / 1000);
    const token = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 3,
        issuedAt: now - 1,
        expiresAt: now + 3600,
        ranges: [
          {
            startBucket: 0,
            endBucket: 2047,
            assignmentGeneration: 3,
            lookupShardId: 'lookup-one',
            bindingRef: 'LOOKUP_ONE',
          },
          {
            startBucket: 2048,
            endBucket: 4095,
            assignmentGeneration: 3,
            lookupShardId: 'lookup-two',
            bindingRef: 'LOOKUP_TWO',
          },
        ],
      },
      privateJwk,
    });
    registry = new Map([
      [buildLookupShardRegistrySnapshotKey('test'), token],
      [buildLookupShardRegistryGenerationKey('test'), '3'],
    ]);
  });

  const env = (overrides: Record<string, unknown> = {}) =>
    ({
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
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

  it('throws instead of reporting "no disable seen" when the inventory disagrees with the verified assignment', async () => {
    const mismatched: ControlTenantDeletionLookupShardTarget[] = [
      { lookupShardId: 'lookup-one', bindingRef: 'LOOKUP_TWO', status: 'active' },
      { lookupShardId: 'lookup-two', bindingRef: 'LOOKUP_ONE', status: 'draining' },
    ];
    await expect(
      tenantLookupIdentifierDisableEvidence(env(), mismatched, 'tenant-a')
    ).rejects.toThrow('tenant_deletion_lookup_registry_inventory_mismatch');
    // A shard the assignment uses but the inventory lacks is the same inconsistency.
    await expect(
      tenantLookupIdentifierDisableEvidence(env(), [shards[0]], 'tenant-a')
    ).rejects.toThrow('tenant_deletion_lookup_registry_inventory_mismatch');
    // No registry at all: unavailable, not "clean".
    await expect(
      tenantLookupIdentifierDisableEvidence(
        env({ TENANT_RUNTIME_REGISTRY: undefined }),
        shards,
        'tenant-a'
      )
    ).rejects.toThrow('tenant_deletion_lookup_cleanup_unavailable');
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
