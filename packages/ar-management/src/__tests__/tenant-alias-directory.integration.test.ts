// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  createLookupAliasIndex,
  signLookupShardRegistry,
  type Env,
  type LookupShardRegistryRange,
  type TenantAliasRouteProjection,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activateTenantAliasDirectory,
  activateTenantDiscoveryAliasDirectory,
  ensureActiveTenantDiscoveryAliasDirectory,
  prepareTenantAliasDirectory,
  prepareTenantDiscoveryAliasDirectory,
  prepareTenantAliasPlacementMigration,
} from '../tenant-alias-directory';

type SqlValue = string | number | null | Uint8Array;

function values(input: unknown[]): SqlValue[] {
  return input.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_test_sqlite_value');
  });
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly input: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.input) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.input) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T>() {
    const result = this.statement.run(...this.input);
    return {
      success: true,
      results: [] as T[],
      meta: { changes: Number(result.changes) },
    };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...input: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, values(input));
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    async batch<T>(statements: BoundStatement[]) {
      const results = [];
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of statements) results.push(await statement.run<T>());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    getBookmark: () => null,
  };
  return {
    ...session,
    withSession: (constraint: string) => {
      if (constraint !== 'first-primary') throw new Error('primary_session_required');
      return session as unknown as D1DatabaseSession;
    },
  } as unknown as D1Database;
}

function database(): DatabaseSync {
  const result = new DatabaseSync(':memory:');
  result.exec(`
    CREATE TABLE lookup_tenant_aliases (
      virtual_bucket INTEGER NOT NULL,
      alias_kind TEXT NOT NULL,
      alias_sha256_digest TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      route_schema_version INTEGER NOT NULL,
      route_projection_json TEXT NOT NULL,
      tenant_lifecycle_state TEXT NOT NULL,
      runtime_route_status TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (virtual_bucket, alias_kind, alias_sha256_digest, tenant_id)
    );
    CREATE UNIQUE INDEX idx_lookup_tenant_aliases_unique_live
      ON lookup_tenant_aliases(virtual_bucket, alias_kind, alias_sha256_digest)
      WHERE lifecycle_state <> 'disabled'
        AND alias_kind IN ('tenant_code', 'tenant_slug', 'invitation_token', 'custom_domain');
  `);
  return result;
}

function projection(generation = 3): TenantAliasRouteProjection {
  return {
    schemaVersion: 1,
    tenantRouteGeneration: generation,
    residencyPolicyId: 'builtin:residency:default',
    target: {
      dataRole: 'tenant_core/default',
      residencyPartition: 'default',
      shardId: 'tenant-default-a',
      bindingRef: 'TEST_TDB_DEFAULT_A',
      requiredBindingRouteGeneration: generation,
    },
  };
}

describe('tenant alias directory', () => {
  let privateJwk: JWK;
  let publicJwk: JWK;
  let lookup: DatabaseSync;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'tenant-alias-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'tenant-alias-a', alg: 'EdDSA' };
  });

  beforeEach(() => {
    lookup = database();
  });

  afterEach(() => lookup.close());

  async function environment(
    ranges: LookupShardRegistryRange[] = [
      {
        startBucket: 0,
        endBucket: 4095,
        assignmentGeneration: 3,
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_A',
      },
    ],
    bindings: Record<string, unknown> = { LOOKUP_A: d1(lookup) }
  ): Promise<Env> {
    const now = Math.floor(Date.now() / 1000);
    const token = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 3,
        issuedAt: now - 1,
        expiresAt: now + 3600,
        ranges,
      },
      privateJwk,
    });
    const store = new Map([
      [buildLookupShardRegistrySnapshotKey('test'), token],
      [buildLookupShardRegistryGenerationKey('test'), '3'],
    ]);
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => store.get(key) ?? null },
      ...bindings,
    } as unknown as Env;
  }

  const input = {
    tenantId: 'tenant-a',
    tenantCode: 'acme',
    tenantSlug: 'tenant-a',
    routeProjection: projection(),
    now: 100,
  };

  it('prepares tenant aliases and the environment membership before activation', async () => {
    const env = await environment();
    await prepareTenantAliasDirectory(env, input);
    expect(
      lookup
        .prepare(
          `SELECT alias_kind, tenant_lifecycle_state, runtime_route_status, lifecycle_state
             FROM lookup_tenant_aliases ORDER BY alias_kind`
        )
        .all()
    ).toEqual([
      {
        alias_kind: 'environment_tenant',
        tenant_lifecycle_state: 'creating',
        runtime_route_status: 'pending',
        lifecycle_state: 'pending',
      },
      {
        alias_kind: 'tenant_code',
        tenant_lifecycle_state: 'creating',
        runtime_route_status: 'pending',
        lifecycle_state: 'pending',
      },
      {
        alias_kind: 'tenant_slug',
        tenant_lifecycle_state: 'creating',
        runtime_route_status: 'pending',
        lifecycle_state: 'pending',
      },
    ]);

    await activateTenantAliasDirectory(env, { ...input, now: 101 });
    await activateTenantAliasDirectory(env, { ...input, now: 102 });
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_tenant_aliases
            WHERE tenant_lifecycle_state = 'active' AND runtime_route_status = 'active'
              AND lifecycle_state = 'active'`
        )
        .get()
    ).toEqual({ count: 3 });
  });

  it('does not activate an alias that has not been prepared', async () => {
    await expect(activateTenantAliasDirectory(await environment(), input)).rejects.toThrow(
      'tenant_alias_not_prepared'
    );
    expect(lookup.prepare(`SELECT COUNT(*) AS count FROM lookup_tenant_aliases`).get()).toEqual({
      count: 0,
    });
  });

  it('rejects a second live owner without changing the first tenant', async () => {
    const env = await environment();
    await prepareTenantAliasDirectory(env, input);
    await expect(
      prepareTenantAliasDirectory(env, {
        ...input,
        tenantId: 'tenant-b',
        tenantSlug: 'tenant-b',
      })
    ).rejects.toThrow('tenant_alias_already_owned');
    expect(lookup.prepare(`SELECT DISTINCT tenant_id FROM lookup_tenant_aliases`).all()).toEqual([
      { tenant_id: 'tenant-a' },
    ]);
  });

  it('rejects a projection change during activation and leaves aliases pending', async () => {
    const env = await environment();
    await prepareTenantAliasDirectory(env, input);
    await expect(
      activateTenantAliasDirectory(env, {
        ...input,
        routeProjection: projection(4),
      })
    ).rejects.toThrow('tenant_alias_projection_changed_during_activation');
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_tenant_aliases WHERE lifecycle_state = 'pending'`
        )
        .get()
    ).toEqual({ count: 3 });
  });

  it('allows only the placement migration path to prepare an active alias at a newer generation', async () => {
    const env = await environment();
    await prepareTenantAliasDirectory(env, input);
    await activateTenantAliasDirectory(env, { ...input, now: 101 });
    const migrationInput = { ...input, routeProjection: projection(4), now: 102 };

    await expect(prepareTenantAliasDirectory(env, migrationInput)).rejects.toThrow(
      'tenant_alias_transition_invalid'
    );
    await prepareTenantAliasPlacementMigration(env, migrationInput);
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_tenant_aliases
            WHERE tenant_lifecycle_state = 'active' AND runtime_route_status = 'pending'
              AND lifecycle_state = 'pending'`
        )
        .get()
    ).toEqual({ count: 3 });

    await activateTenantAliasDirectory(env, { ...migrationInput, now: 103 });
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_tenant_aliases
            WHERE tenant_lifecycle_state = 'active' AND runtime_route_status = 'active'
              AND lifecycle_state = 'active'`
        )
        .get()
    ).toEqual({ count: 3 });
  });

  it('allows multiple tenants and client ids in multi-owner discovery indexes', async () => {
    const env = await environment();
    await prepareTenantAliasDirectory(env, input);
    await prepareTenantAliasDirectory(env, {
      ...input,
      tenantId: 'tenant-b',
      tenantCode: 'beta',
      tenantSlug: 'tenant-b',
    });
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      const alias = {
        tenantId,
        aliasKind: 'client_id' as const,
        aliasValue: 'shared-client-id',
        routeProjection: projection(),
        now: 100,
      };
      await prepareTenantDiscoveryAliasDirectory(env, alias);
      await activateTenantDiscoveryAliasDirectory(env, { ...alias, now: 101 });
    }
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_tenant_aliases
            WHERE alias_kind = 'environment_tenant' AND lifecycle_state = 'pending'`
        )
        .get()
    ).toEqual({ count: 2 });
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_tenant_aliases
            WHERE alias_kind = 'client_id' AND lifecycle_state = 'active'`
        )
        .get()
    ).toEqual({ count: 2 });
  });

  it('resumes a pending discovery alias after destination commit or response loss', async () => {
    const env = await environment();
    const alias = {
      tenantId: 'tenant-a',
      aliasKind: 'invitation_token' as const,
      aliasValue: 'retry-token',
      routeProjection: projection(),
      now: 100,
    };
    await prepareTenantDiscoveryAliasDirectory(env, alias);

    await ensureActiveTenantDiscoveryAliasDirectory(env, { ...alias, now: 101 });
    await ensureActiveTenantDiscoveryAliasDirectory(env, { ...alias, now: 102 });

    expect(
      lookup
        .prepare(
          `SELECT tenant_id, lifecycle_state FROM lookup_tenant_aliases
            WHERE alias_kind = 'invitation_token'`
        )
        .all()
    ).toEqual([{ tenant_id: 'tenant-a', lifecycle_state: 'active' }]);
  });

  it('does not rewrite a pending projection without a newer route generation', async () => {
    const env = await environment();
    const alias = {
      tenantId: 'tenant-a',
      aliasKind: 'custom_domain' as const,
      aliasValue: 'login.example.test',
      routeProjection: projection(),
      now: 100,
    };
    await prepareTenantDiscoveryAliasDirectory(env, alias);
    const changed = {
      ...alias,
      routeProjection: {
        ...projection(),
        target: { ...projection().target, bindingRef: 'TEST_TDB_DEFAULT_B' },
      },
      now: 101,
    };

    await expect(prepareTenantDiscoveryAliasDirectory(env, changed)).rejects.toThrow(
      'tenant_alias_transition_invalid'
    );
  });

  it('resolves every alias bucket binding before the first write', async () => {
    let slug = 'tenant-a';
    const code = await createLookupAliasIndex('tenant_code', input.tenantCode);
    let slugIndex = await createLookupAliasIndex('tenant_slug', slug);
    for (let index = 0; slugIndex.virtualBucket === code.virtualBucket; index += 1) {
      slug = `tenant-${index}`;
      slugIndex = await createLookupAliasIndex('tenant_slug', slug);
    }
    const missingBucket = slugIndex.virtualBucket;
    const ranges: LookupShardRegistryRange[] = [
      ...(missingBucket > 0
        ? [
            {
              startBucket: 0,
              endBucket: missingBucket - 1,
              assignmentGeneration: 3,
              lookupShardId: 'lookup-a',
              bindingRef: 'LOOKUP_A',
            },
          ]
        : []),
      {
        startBucket: missingBucket,
        endBucket: missingBucket,
        assignmentGeneration: 3,
        lookupShardId: 'lookup-missing',
        bindingRef: 'LOOKUP_MISSING',
      },
      ...(missingBucket < 4095
        ? [
            {
              startBucket: missingBucket + 1,
              endBucket: 4095,
              assignmentGeneration: 3,
              lookupShardId: 'lookup-a',
              bindingRef: 'LOOKUP_A',
            },
          ]
        : []),
    ];
    await expect(
      prepareTenantAliasDirectory(await environment(ranges), { ...input, tenantSlug: slug })
    ).rejects.toThrow('lookup_write_binding_unavailable');
    expect(lookup.prepare(`SELECT COUNT(*) AS count FROM lookup_tenant_aliases`).get()).toEqual({
      count: 0,
    });
  });
});
