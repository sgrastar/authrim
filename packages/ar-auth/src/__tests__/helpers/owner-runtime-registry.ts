/**
 * Production account resolver and signed runtime registry with real SQLite destination reads.
 * Only Lookup key-state/index/assignment discovery is doubled; membership/target/destination
 * validation and tenant isolation are production code. Keys are ephemeral local fixtures.
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import { signTenantRuntimeRegistrySnapshot } from '../../../../ar-lib-core/dist/services/tenant-runtime-registry-snapshot';
import { clearTenantDatabaseResolverMemoryCache } from '../../../../ar-lib-core/dist/services/tenant-database-resolver';
import { clearLookupRouteMemoryCache } from '../../../../ar-lib-core/dist/services/lookup-directory';
import type { RealSqlAdapter, SqliteDatabase } from './real-sql';

/** Actual SQL destinations behind the D1 statements used by production resolver/repositories. */
function d1Over(sqlite: SqliteDatabase): D1Database {
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async (column?: string) => {
      const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      return column ? (row?.[column] ?? null) : (row ?? null);
    },
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...params), meta: {} }),
    run: async () => ({
      success: true,
      results: [],
      meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) },
    }),
  });
  const session = {
    prepare,
    getBookmark: () => 'fixture-primary',
    batch: async (statements: Array<{ all(): Promise<unknown> }>) =>
      Promise.all(statements.map((s) => s.all())),
  };
  return { ...session, withSession: () => session } as unknown as D1Database;
}

export async function realOwnerRuntime(
  core: RealSqlAdapter,
  pii: RealSqlAdapter,
  scope: 'shared_pool' | 'tenant_exclusive',
  options: { tenantId?: string; lookupTenantId?: string; missingMembership?: boolean } = {}
): Promise<Partial<Env>> {
  clearLookupRouteMemoryCache();
  clearTenantDatabaseResolverMemoryCache();
  const tenantId = options.tenantId ?? 'default';
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in keys) || !('publicKey' in keys)) {
    throw new Error('fixture-signing-key-pair-required');
  }
  const privateJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  if (privateJwk instanceof ArrayBuffer || publicJwk instanceof ArrayBuffer) {
    throw new Error('fixture-json-web-key-required');
  }
  Object.assign(privateJwk, { kid: 'owner-runtime', alg: 'EdDSA', use: 'sig' });
  Object.assign(publicJwk, { kid: 'owner-runtime', alg: 'EdDSA', use: 'sig' });
  const targets = [
    {
      role: 'tenant_core',
      dataRole: 'tenant_core/users',
      shardId: 'owner-users',
      bindingRef: 'AUTHRIM_TDB_USERS_OWNER',
    },
    {
      role: 'tenant_pii',
      dataRole: 'tenant_pii',
      shardId: 'owner-pii',
      bindingRef: 'AUTHRIM_TDB_PII_OWNER',
    },
  ] as const;
  const snapshot = await signTenantRuntimeRegistrySnapshot(
    {
      version: 4,
      tenantId,
      snapshotScope: 'tenant',
      deploymentTarget: 'default',
      runtimeGeneration: 7,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      backend: { provider: 'd1', resolver: 'control-plane' },
      placement: { isolationPolicy: scope, policyGeneration: 1 },
      publishedAt: '2026-05-16T00:00:00.000Z',
      expiresAt: '2099-05-16T00:00:00.000Z',
      stores: targets.map((target) => ({
        ...target,
        tenantId,
        residencyPolicyId: 'owner-policy',
        residencyPartition: 'default',
        assignmentGeneration: 1,
        bindingRouteGeneration: 1,
        placementPolicyGeneration: 1,
        allocationScope: scope,
        ownerTenantId: scope === 'tenant_exclusive' ? tenantId : null,
        generation: 1,
        runtimeGeneration: 7,
        schemaVersion: 1,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        provider: 'd1',
        driver: 'd1',
        connectionRef: null,
        deploymentTarget: null,
        status: 'active',
        healthStatus: 'active',
        databaseId: target.shardId,
        databaseName: target.shardId,
        regionHint: null,
        jurisdiction: null,
      })),
      metadata: {
        storeCount: 2,
        roles: ['tenant_core', 'tenant_pii'],
        signature: null,
        signatureKeyId: null,
        signatureAlgorithm: null,
        signedAt: null,
      },
    },
    { privateJwk, keyId: 'owner-runtime' },
    '2026-05-16T00:00:00.000Z'
  );
  for (const [db, target] of [
    [core, targets[0]],
    [pii, targets[1]],
  ] as const) {
    await db.execute(
      `INSERT OR REPLACE INTO authrim_control_plane_shard_metadata
      (singleton_id,binding_ref,data_role,residency_partition,migration_generation,release_id,
       manifest_digest,expected_file_count,last_filename,updated_at)
      VALUES(1,?,?,'default',1,'fixture',?,1,'fixture.sql',1)`,
      [target.bindingRef, target.dataRole, 'a'.repeat(64)]
    );
  }
  const row = {
    virtual_bucket: 42,
    index_kind: 'account_id',
    normalization_version: 1,
    hmac_key_generation: 1,
    identifier_blind_digest: 'a'.repeat(64),
    tenant_id: options.lookupTenantId ?? tenantId,
    account_id: 'account:user_owned',
    route_schema_version: 1,
    account_route_generation: 1,
    required_binding_route_generation: 1,
    residency_policy_id: 'owner-policy',
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
    route_projection_json: JSON.stringify({
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'owner-policy',
      targets: targets.map((target) => ({
        dataRole: target.dataRole,
        residencyPartition: 'default',
        shardId: target.shardId,
        bindingRef: target.bindingRef,
        requiredBindingRouteGeneration: 1,
      })),
    }),
  };
  const lookupStatement = {
    bind: (..._values: unknown[]) => lookupStatement,
    all: async () => ({ success: true, results: options.missingMembership ? [] : [row], meta: {} }),
  };
  const lookupSession = {
    prepare: () => lookupStatement,
    getBookmark: () => 'fixture-lookup',
    batch: async (statements: Array<{ all(): Promise<unknown> }>) =>
      Promise.all(statements.map((s) => s.all())),
  };
  const lookup = { ...lookupSession, withSession: () => lookupSession };
  return {
    AUTHRIM_ENVIRONMENT_NAME: 'owner-test',
    TENANT_RUNTIME_REGISTRY: {
      get: async (key: string) =>
        key.includes(':runtime-registry:generation:')
          ? JSON.stringify({
              runtimeGeneration: 7,
              routeStatus: 'active',
              quarantineDenyGeneration: 0,
              publishedAt: '2026-05-16T00:00:00.000Z',
              expiresAt: '2099-05-16T00:00:00.000Z',
            })
          : JSON.stringify(snapshot),
    },
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    LOOKUP_HMAC_KEY_SLOT_A: 'local-fixture-only',
    LOOKUP_OWNER: lookup,
    AUTHRIM_TDB_USERS_OWNER: d1Over(core.raw),
    AUTHRIM_TDB_PII_OWNER: d1Over(pii.raw),
  } as unknown as Partial<Env>;
}
