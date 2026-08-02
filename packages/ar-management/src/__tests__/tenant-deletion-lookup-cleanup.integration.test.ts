// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  signLookupShardRegistry,
  type ControlTenantDeletionLookupShardTarget,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disableTenantLookupDirectory } from '../tenant-deletion-lookup-cleanup';

type SqlValue = string | number | null | Uint8Array;

function sqlValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_sqlite_test_value');
  });
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class UnboundStatement {
  constructor(
    private readonly sql: string,
    private readonly database: DatabaseSync
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.database.prepare(this.sql), sqlValues(values));
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  private session(constraint: string): D1DatabaseSession {
    if (constraint !== 'first-primary') throw new Error('primary_session_required');
    const session = {
      prepare: (sql: string) => new UnboundStatement(sql, this.database),
      batch: async (statements: BoundStatement[]) => {
        const results = [];
        this.database.exec('BEGIN IMMEDIATE');
        try {
          for (const statement of statements) results.push(await statement.run());
          this.database.exec('COMMIT');
          return results;
        } catch (error) {
          this.database.exec('ROLLBACK');
          throw error;
        }
      },
      getBookmark: () => null,
    };
    return session as unknown as D1DatabaseSession;
  }

  readonly binding = {
    withSession: (constraint: string) => this.session(constraint),
  } as unknown as D1Database;
}

function createLookupDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE lookup_identifiers (
      tenant_id TEXT NOT NULL,
      tenant_lifecycle_state TEXT NOT NULL,
      runtime_route_status TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      disabled_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE lookup_tenant_aliases (
      tenant_id TEXT NOT NULL,
      tenant_lifecycle_state TEXT NOT NULL,
      runtime_route_status TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE lookup_identifier_reservations (
      tenant_id TEXT NOT NULL,
      reservation_state TEXT NOT NULL,
      lease_expires_at INTEGER,
      released_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  return database;
}

function seedTenant(database: DatabaseSync, tenantId: string): void {
  database
    .prepare(`INSERT INTO lookup_identifiers VALUES (?, 'active', 'active', 'active', NULL, 1)`)
    .run(tenantId);
  database
    .prepare(`INSERT INTO lookup_tenant_aliases VALUES (?, 'active', 'active', 'active', 1)`)
    .run(tenantId);
  database
    .prepare(`INSERT INTO lookup_identifier_reservations VALUES (?, 'committed', 999, NULL, 1)`)
    .run(tenantId);
}

describe('disableTenantLookupDirectory', () => {
  let privateJwk: JWK;
  let publicJwk: JWK;
  let active: DatabaseSync;
  let draining: DatabaseSync;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'lookup-delete-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'lookup-delete-a', alg: 'EdDSA' };
  });

  beforeEach(() => {
    active = createLookupDatabase();
    draining = createLookupDatabase();
    seedTenant(active, 'tenant-a');
    seedTenant(draining, 'tenant-a');
    seedTenant(active, 'tenant-other');
  });

  afterEach(() => {
    active.close();
    draining.close();
  });

  async function environment(overrides: Record<string, unknown> = {}): Promise<Env> {
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
            endBucket: 4095,
            assignmentGeneration: 3,
            lookupShardId: 'lookup-active',
            bindingRef: 'LOOKUP_ACTIVE',
          },
        ],
      },
      privateJwk,
    });
    const values = new Map([
      [buildLookupShardRegistrySnapshotKey('test'), token],
      [buildLookupShardRegistryGenerationKey('test'), '3'],
    ]);
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => values.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      LOOKUP_ACTIVE: new SqliteD1(active).binding,
      LOOKUP_DRAINING: new SqliteD1(draining).binding,
      ...overrides,
    } as unknown as Env;
  }

  const inventory: ControlTenantDeletionLookupShardTarget[] = [
    { lookupShardId: 'lookup-active', bindingRef: 'LOOKUP_ACTIVE', status: 'active' },
    {
      lookupShardId: 'lookup-draining',
      bindingRef: 'LOOKUP_DRAINING',
      status: 'draining',
    },
  ];

  it('disables active and migration-source rows before tenant purge', async () => {
    await disableTenantLookupDirectory(await environment(), inventory, 'tenant-a');

    for (const database of [active, draining]) {
      expect(
        database
          .prepare(
            `SELECT tenant_lifecycle_state, runtime_route_status, lifecycle_state,
                    disabled_at IS NOT NULL AS has_disabled_at
               FROM lookup_identifiers WHERE tenant_id = 'tenant-a'`
          )
          .get()
      ).toEqual({
        tenant_lifecycle_state: 'disabled',
        runtime_route_status: 'disabled',
        lifecycle_state: 'disabled',
        has_disabled_at: 1,
      });
      expect(
        database
          .prepare(
            `SELECT tenant_lifecycle_state, runtime_route_status, lifecycle_state
               FROM lookup_tenant_aliases WHERE tenant_id = 'tenant-a'`
          )
          .get()
      ).toEqual({
        tenant_lifecycle_state: 'disabled',
        runtime_route_status: 'disabled',
        lifecycle_state: 'disabled',
      });
      expect(
        database
          .prepare(
            `SELECT reservation_state, lease_expires_at, released_at IS NOT NULL AS has_released_at
               FROM lookup_identifier_reservations WHERE tenant_id = 'tenant-a'`
          )
          .get()
      ).toEqual({ reservation_state: 'released', lease_expires_at: null, has_released_at: 1 });
    }

    expect(
      active
        .prepare(`SELECT lifecycle_state FROM lookup_identifiers WHERE tenant_id = 'tenant-other'`)
        .get()
    ).toEqual({ lifecycle_state: 'active' });
  });

  it('is idempotent when a deletion job resumes', async () => {
    const env = await environment();
    await disableTenantLookupDirectory(env, inventory, 'tenant-a');
    await disableTenantLookupDirectory(env, inventory, 'tenant-a');

    expect(
      active
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifiers
            WHERE tenant_id = 'tenant-a' AND lifecycle_state <> 'disabled'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('rejects a signed registry that disagrees with control inventory', async () => {
    const mismatched: ControlTenantDeletionLookupShardTarget[] = [
      {
        lookupShardId: 'lookup-active',
        bindingRef: 'LOOKUP_DRAINING',
        status: 'active',
      },
    ];

    await expect(
      disableTenantLookupDirectory(await environment(), mismatched, 'tenant-a')
    ).rejects.toThrow('tenant_deletion_lookup_registry_inventory_mismatch');
    expect(
      active
        .prepare(`SELECT lifecycle_state FROM lookup_identifiers WHERE tenant_id = 'tenant-a'`)
        .get()
    ).toEqual({ lifecycle_state: 'active' });
  });

  it('validates every physical binding before changing any shard', async () => {
    const env = await environment({ LOOKUP_DRAINING: undefined });

    await expect(disableTenantLookupDirectory(env, inventory, 'tenant-a')).rejects.toThrow(
      'tenant_deletion_lookup_binding_unavailable'
    );
    expect(
      active
        .prepare(`SELECT lifecycle_state FROM lookup_identifiers WHERE tenant_id = 'tenant-a'`)
        .get()
    ).toEqual({ lifecycle_state: 'active' });
  });
});
