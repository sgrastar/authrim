import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type {
  AccountRouteProjection,
  ControlTenantPlacementMigrationView,
  Env,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processTenantPlacementLookupCutoverPage } from '../tenant-placement-lookup-cutover';

type SqliteValue = string | number | bigint | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function values(input: readonly unknown[] = []): SqliteValue[] {
  return input.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError('unsupported SQLite value');
  });
}

class BoundStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]) {
    return new BoundStatement(this.database, this.sql, params);
  }

  async all<T>() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...values(this.params)) as T[],
      meta: {},
    };
  }

  async run<T>() {
    const result = this.database.prepare(this.sql).run(...values(this.params));
    return { success: true, results: [] as T[], meta: { changes: Number(result.changes) } };
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare(sql: string) {
      return new BoundStatement(database, sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await (statement as unknown as BoundStatement).run());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    prepare: session.prepare,
    batch: session.batch,
    withSession: () => session,
  } as unknown as D1Database;
}

function migration(): ControlTenantPlacementMigrationView {
  const roles = ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const;
  return {
    operationId: 'placement-a',
    tenantId: 'tenant-a',
    state: 'cutover_ready',
    sourceIsolationPolicy: 'shared_pool',
    targetIsolationPolicy: 'tenant_exclusive',
    sourcePolicyGeneration: 1,
    targetPolicyGeneration: 2,
    writeFenceState: 'active',
    routeCutoverStarted: true,
    canCancel: false,
    canApprovePurge: false,
    sourceRetentionExpiresAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    shards: roles.map((dataRole, index) => ({
      dataRole,
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      sourceShardId: `source-${index}`,
      sourceAssignmentGeneration: 1,
      targetShardId: `target-${index}`,
      target: {
        shardId: `target-${index}`,
        assignmentGeneration: 2,
        routeGeneration: 2,
        bindingRef: `TDB_TARGET_${index}`,
        databaseId: `target-db-${index}`,
        databaseName: `target-db-${index}`,
      },
      state: 'write_fenced',
      inventoryTableCount: 1,
      sourceRowCount: 1,
      targetRowCount: 1,
      lastObservedSourceSequence: 0,
      lastAppliedSourceSequence: 0,
      lastErrorCode: null,
      updatedAt: 1,
    })),
  };
}

function projection(accountRouteGeneration = 7): AccountRouteProjection {
  return {
    schemaVersion: 1,
    accountRouteGeneration,
    residencyPolicyId: 'default',
    targets: [
      {
        dataRole: 'tenant_core/users',
        residencyPartition: 'default',
        shardId: 'source-1',
        bindingRef: 'TDB_SOURCE_1',
        requiredBindingRouteGeneration: 1,
      },
      {
        dataRole: 'tenant_pii',
        residencyPartition: 'default',
        shardId: 'source-2',
        bindingRef: 'TDB_SOURCE_2',
        requiredBindingRouteGeneration: 1,
      },
    ],
  };
}

describe('tenant placement Lookup cutover', () => {
  let database: DatabaseSync;
  let lookup: D1Database;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    lookup = d1(database);
    for (const [index, tenantId] of ['tenant-a', 'tenant-b', 'tenant-a'].entries()) {
      database
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, 'account_id', 1, 1, ?, ?, ?, 1, 7, 1, 'default', ?,
                     'active', 'active', 'active', 1, 1)`
        )
        .run(index, `digest-${index}`, tenantId, `account-${index}`, JSON.stringify(projection()));
    }
  });

  afterEach(() => database.close());

  const env = { AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env;
  const dependencies = {
    ranges: [
      {
        startBucket: 0,
        endBucket: 4095,
        assignmentGeneration: 1,
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_A',
      },
    ],
    resolveBinding: () => lookup,
  };

  it('prepares and activates bounded pages without changing HMAC or account generation', async () => {
    const first = await processTenantPlacementLookupCutoverPage(
      env,
      { tenantId: 'tenant-a', migration: migration(), phase: 'prepare', limit: 1 },
      dependencies
    );
    expect(first).toMatchObject({ processedRows: 1, complete: false });
    const second = await processTenantPlacementLookupCutoverPage(
      env,
      {
        tenantId: 'tenant-a',
        migration: migration(),
        phase: 'prepare',
        cursor: first.cursor,
        limit: 1,
      },
      dependencies
    );
    expect(second).toMatchObject({ processedRows: 1, complete: false });
    const preparedTail = await processTenantPlacementLookupCutoverPage(
      env,
      {
        tenantId: 'tenant-a',
        migration: migration(),
        phase: 'prepare',
        cursor: second.cursor,
        limit: 1,
      },
      dependencies
    );
    expect(preparedTail).toMatchObject({ processedRows: 0, complete: true, cursor: null });

    const prepared = database
      .prepare(
        `SELECT tenant_id, account_route_generation, identifier_blind_digest,
                lifecycle_state, runtime_route_status, route_projection_json
           FROM lookup_identifiers ORDER BY rowid`
      )
      .all() as Array<Record<string, unknown>>;
    expect(prepared[0]).toMatchObject({
      tenant_id: 'tenant-a',
      account_route_generation: 7,
      identifier_blind_digest: 'digest-0',
      lifecycle_state: 'pending',
      runtime_route_status: 'pending',
    });
    expect(prepared[1]).toMatchObject({
      tenant_id: 'tenant-b',
      lifecycle_state: 'active',
      runtime_route_status: 'active',
    });
    expect(JSON.parse(String(prepared[0]!.route_projection_json))).toMatchObject({
      accountRouteGeneration: 7,
      targets: [{ shardId: 'target-1' }, { shardId: 'target-2' }],
    });

    let cursor = null;
    do {
      const page = await processTenantPlacementLookupCutoverPage(
        env,
        { tenantId: 'tenant-a', migration: migration(), phase: 'activate', cursor, limit: 1 },
        dependencies
      );
      cursor = page.cursor;
      if (page.complete) break;
    } while (cursor);

    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifiers
            WHERE tenant_id = 'tenant-a' AND lifecycle_state = 'active'
              AND runtime_route_status = 'active'`
        )
        .get()
    ).toEqual({ count: 2 });
  });

  it('fails closed when an existing route is outside the migration inventory', async () => {
    const broken = projection();
    broken.targets[0] = { ...broken.targets[0]!, shardId: 'wrong-source' };
    database
      .prepare(
        `UPDATE lookup_identifiers SET route_projection_json = ?
          WHERE tenant_id = 'tenant-a' AND account_id = 'account-0'`
      )
      .run(JSON.stringify(broken));

    await expect(
      processTenantPlacementLookupCutoverPage(
        env,
        { tenantId: 'tenant-a', migration: migration(), phase: 'prepare' },
        dependencies
      )
    ).rejects.toThrow('tenant_placement_lookup_source_route_unmapped');
    expect(
      database
        .prepare(
          `SELECT lifecycle_state FROM lookup_identifiers
            WHERE tenant_id = 'tenant-a' AND account_id = 'account-0'`
        )
        .get()
    ).toEqual({ lifecycle_state: 'active' });
  });
});
