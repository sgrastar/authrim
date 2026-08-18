import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupBucketMigrationService } from '../lookup-bucket-migration';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('required_test_value_missing');
  return value;
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[],
    private readonly sql: string,
    private readonly beforeRun: () => ((sql: string) => void) | null
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    this.beforeRun()?.(this.sql);
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  executeRun() {
    this.beforeRun()?.(this.sql);
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly sql: string,
    private readonly beforeRun: () => ((sql: string) => void) | null
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      }),
      this.sql,
      this.beforeRun
    );
  }
}

function d1(database: DatabaseSync, beforeRun: () => ((sql: string) => void) | null): D1Database {
  const binding = {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql), sql, beforeRun);
    },
    withSession() {
      return binding;
    },
    async batch(statements: unknown[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
          return statement.executeRun();
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return binding as unknown as D1Database;
}

describe('LookupBucketMigrationService', () => {
  let database: DatabaseSync;
  let now: number;
  let service: LookupBucketMigrationService;
  let runHook: ((sql: string) => void) | null;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_control_plane.sql'), 'utf8')
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/003_lookup_bucket_migrations.sql'),
        'utf8'
      )
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/025_lookup_scale_out_and_retention.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (
         'seed', 'test', 'provision_shard', 'seed', 'succeeded', 'setup', 1, 1, 1, 1
       );
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         created_at, updated_at
       ) VALUES ('test', 2, 2, 10, 10, 100000, 1, 1);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, created_at, updated_at
       ) VALUES
         ('resource-a', 'test', 'd1', 'lookup-a', 'lookup-a', 'fingerprint-a', 'active', 'seed', '{}', 1, 1),
         ('resource-b', 'test', 'd1', 'lookup-b', 'lookup-b', 'fingerprint-b', 'active', 'seed', '{}', 1, 1),
         ('resource-c', 'test', 'd1', 'lookup-c', 'lookup-c', 'fingerprint-c', 'active', 'seed', '{}', 1, 1);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES
         ('lookup-a', 'test', 'default', 'LOOKUP_A', 'resource-a', 'active', 1, 1),
         ('lookup-b', 'test', 'default', 'LOOKUP_B', 'resource-b', 'active', 1, 1),
         ('lookup-c', 'test', 'eu', 'LOOKUP_C', 'resource-c', 'active', 1, 1);
       INSERT INTO control_lookup_bucket_assignments (
         environment_id, virtual_bucket, lookup_shard_id, assignment_generation, state, updated_at
       ) VALUES
         ('test', 7, 'lookup-a', 3, 'active', 1),
         ('test', 8, 'lookup-a', 1, 'active', 1),
         ('test', 9, 'lookup-a', 1, 'active', 1);`
    );
    now = 100;
    runHook = null;
    service = new LookupBucketMigrationService(
      d1(database, () => runHook),
      () => now
    );
  });

  afterEach(() => database.close());

  it('automatically moves the bucket that best improves active route-bearing load', async () => {
    const snapshot = {
      ownerId: 'management-planner',
      observedAt: now,
      buckets: [
        {
          virtualBucket: 7,
          lookupShardId: 'lookup-a',
          assignmentGeneration: 3,
          activeIdentifierCount: 90,
          activeAliasCount: 0,
          counterUpdatedAt: now,
        },
        {
          virtualBucket: 8,
          lookupShardId: 'lookup-a',
          assignmentGeneration: 1,
          activeIdentifierCount: 1,
          activeAliasCount: 0,
          counterUpdatedAt: now,
        },
        {
          virtualBucket: 9,
          lookupShardId: 'lookup-a',
          assignmentGeneration: 1,
          activeIdentifierCount: 9,
          activeAliasCount: 0,
          counterUpdatedAt: now,
        },
      ],
    };
    await expect(
      service.planNextAutomaticMigration('test', {
        ...snapshot,
        buckets: snapshot.buckets.map((observation) =>
          observation.virtualBucket === 8
            ? { ...observation, lookupShardId: 'lookup-c' }
            : observation
        ),
      })
    ).rejects.toThrow('control_lookup_bucket_load_assignment_mismatch');
    const planned = await service.planNextAutomaticMigration('test', snapshot);

    expect(planned).toMatchObject({
      virtualBucket: 7,
      source: { lookupShardId: 'lookup-a' },
      target: { lookupShardId: 'lookup-b' },
      state: 'dual_write',
    });
    await expect(service.planNextAutomaticMigration('test', snapshot)).resolves.toBeNull();
  });

  it('compares shard load after normalizing by configured capacity weight', async () => {
    database.exec(
      `UPDATE control_lookup_physical_shards SET capacity_weight = 2
        WHERE lookup_shard_id = 'lookup-a';
       UPDATE control_lookup_bucket_assignments SET lookup_shard_id = 'lookup-b'
        WHERE virtual_bucket = 8;`
    );

    await expect(
      service.planNextAutomaticMigration('test', {
        ownerId: 'management-planner',
        observedAt: now,
        buckets: [
          {
            virtualBucket: 7,
            lookupShardId: 'lookup-a',
            assignmentGeneration: 3,
            activeIdentifierCount: 90,
            activeAliasCount: 0,
            counterUpdatedAt: now,
          },
          {
            virtualBucket: 8,
            lookupShardId: 'lookup-b',
            assignmentGeneration: 1,
            activeIdentifierCount: 60,
            activeAliasCount: 0,
            counterUpdatedAt: now,
          },
          {
            virtualBucket: 9,
            lookupShardId: 'lookup-a',
            assignmentGeneration: 1,
            activeIdentifierCount: 9,
            activeAliasCount: 0,
            counterUpdatedAt: now,
          },
        ],
      })
    ).resolves.toBeNull();
  });

  it('starts dual-write atomically and adopts the exact idempotent retry', async () => {
    const request = {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'management-run-1',
    };
    const first = await service.start('test', request);
    const second = await service.start('test', request);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      virtualBucket: 7,
      source: { lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_A', assignmentGeneration: 3 },
      target: { lookupShardId: 'lookup-b', bindingRef: 'LOOKUP_B', assignmentGeneration: 4 },
      state: 'dual_write',
      fencingToken: 1,
    });
    await expect(service.writeRoute('test', 7)).resolves.toMatchObject({
      primary: { lookupShardId: 'lookup-a', assignmentGeneration: 3 },
      mirrors: [{ lookupShardId: 'lookup-b', assignmentGeneration: 4 }],
      migration: { operationId: first.operationId, state: 'dual_write' },
    });
    expect(
      database
        .prepare(
          `SELECT state, target_lookup_shard_id FROM control_lookup_bucket_assignments
            WHERE environment_id = 'test' AND virtual_bucket = 7`
        )
        .get()
    ).toEqual({ state: 'copying', target_lookup_shard_id: 'lookup-b' });
  });

  it('removes a provisional operation when the pre-mutation rewrite lease is raced', async () => {
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, updated_at
       ) VALUES
         ('old-rewrite', 'test', 'hmac_reindex', 'old-rewrite', 'queued', 'scheduler', 0, 1, 1),
         ('rival-rewrite', 'test', 'hmac_reindex', 'rival-rewrite', 'queued', 'scheduler', 0, 1, 1);
       INSERT INTO control_directory_rewrite_leases (
         environment_id, operation_id, operation_kind, owner_id, fencing_token,
         checkpoint_json, lease_expires_at, mutation_started, updated_at
       ) VALUES ('test', 'old-rewrite', 'hmac_reindex', 'old-owner', 1, '{}', 1, 0, 1);`
    );
    runHook = (sql) => {
      if (!sql.includes('UPDATE control_directory_rewrite_leases')) return;
      runHook = null;
      database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET operation_id = 'rival-rewrite', operation_kind = 'hmac_reindex',
                  owner_id = 'rival-owner', fencing_token = 2, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = 'test' AND operation_id = 'old-rewrite'`
        )
        .run(now + 120, now);
    };

    await expect(
      service.start('test', {
        virtualBucket: 7,
        targetLookupShardId: 'lookup-b',
        idempotencyKey: 'raced-move-bucket-7',
        ownerId: 'management-run-1',
      })
    ).rejects.toThrow('control_lookup_bucket_migration_start_stale');
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM control_operations WHERE idempotency_key = ?`)
        .get('raced-move-bucket-7')
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT state, target_lookup_shard_id FROM control_lookup_bucket_assignments
            WHERE environment_id = 'test' AND virtual_bucket = 7`
        )
        .get()
    ).toEqual({ state: 'active', target_lookup_shard_id: null });
  });

  it('rejects idempotency reuse with a different target', async () => {
    const request = {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'management-run-1',
    };
    await service.start('test', request);
    await expect(
      service.start('test', { ...request, targetLookupShardId: 'lookup-c' })
    ).rejects.toThrow('control_lookup_bucket_migration_idempotency_conflict');
  });

  it('allows only the same operation to take over an expired post-mutation lease', async () => {
    const migration = await service.start('test', {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'management-run-1',
    });
    now = 300;
    const claimed = await service.claim('test', {
      operationId: migration.operationId,
      ownerId: 'management-run-2',
    });
    expect(claimed.fencingToken).toBe(2);

    await expect(
      service.checkpoint('test', {
        operationId: migration.operationId,
        ownerId: 'management-run-1',
        fencingToken: migration.fencingToken,
        expectedState: 'dual_write',
        nextState: 'backfilling',
        backfillCursor: '{}',
        sourceRowCount: null,
        targetRowCount: null,
        verificationDigest: null,
      })
    ).rejects.toThrow('control_lookup_bucket_migration_assignment_stale');
    expect(
      database
        .prepare(
          `SELECT migration.state AS migration_state, assignment.state AS assignment_state
             FROM control_lookup_bucket_migrations migration
             JOIN control_lookup_bucket_assignments assignment
               ON assignment.environment_id = migration.environment_id
              AND assignment.virtual_bucket = migration.virtual_bucket
            WHERE migration.operation_id = ?`
        )
        .get(migration.operationId)
    ).toEqual({ migration_state: 'dual_write', assignment_state: 'copying' });

    now = 500;
    await expect(
      service.start('test', {
        virtualBucket: 8,
        targetLookupShardId: 'lookup-b',
        idempotencyKey: 'move-bucket-8',
        ownerId: 'management-run-3',
      })
    ).rejects.toThrow('directory_rewrite_cross_operation_takeover_forbidden_after_mutation');
  });

  it('claims scheduled work after lease expiry and blocks permanent failures without losing dual-write', async () => {
    await service.start('test', {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'request-run',
    });
    now = 300;
    const claimed = await service.claimNext('test', 'scheduled-run');
    expect(claimed).toMatchObject({ state: 'dual_write', fencingToken: 2 });
    if (!claimed) throw new Error('missing_claimed_migration');

    const blocked = await service.block('test', {
      operationId: claimed.operationId,
      ownerId: 'scheduled-run',
      fencingToken: claimed.fencingToken,
      errorCode: 'lookup_bucket_migration_verification_mismatch',
    });
    expect(blocked.state).toBe('blocked');
    await expect(service.writeRoute('test', 7)).resolves.toMatchObject({
      primary: { lookupShardId: 'lookup-a' },
      mirrors: [{ lookupShardId: 'lookup-b' }],
      migration: { state: 'blocked' },
    });
    expect(
      database
        .prepare(`SELECT status, last_error_code FROM control_operations WHERE operation_id = ?`)
        .get(claimed.operationId)
    ).toEqual({
      status: 'blocked',
      last_error_code: 'lookup_bucket_migration_verification_mismatch',
    });
    now = 500;
    await expect(service.claimNext('test', 'another-run')).resolves.toBeNull();
  });

  it('resolves the pinned source and target generations during migration', async () => {
    await service.start('test', {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'management-run-1',
    });

    await expect(service.resolveRouteVersion('test', 7, 3)).resolves.toMatchObject({
      lookupShardId: 'lookup-a',
      bindingRef: 'LOOKUP_A',
    });
    await expect(service.resolveRouteVersion('test', 7, 4)).resolves.toMatchObject({
      lookupShardId: 'lookup-b',
      bindingRef: 'LOOKUP_B',
    });
    await expect(service.resolveRouteVersion('test', 7, 5)).rejects.toThrow(
      'control_lookup_bucket_route_version_unavailable'
    );
  });

  it('persists bounded verification retries across backfill restarts', async () => {
    let migration = await service.start('test', {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'management-run-1',
    });
    const advance = (nextState: 'backfilling' | 'verifying', cursor = '{}') =>
      service.checkpoint('test', {
        operationId: migration.operationId,
        ownerId: 'management-run-1',
        fencingToken: migration.fencingToken,
        expectedState: migration.state,
        nextState,
        backfillCursor: cursor,
        sourceRowCount: null,
        targetRowCount: null,
        verificationDigest: null,
      });

    migration = await advance('backfilling');
    migration = await advance('verifying', '{"complete":true}');
    migration = await advance('backfilling');
    expect(migration).toMatchObject({ state: 'backfilling', verificationAttemptCount: 1 });

    migration = await advance('verifying', '{"complete":true}');
    migration = await advance('backfilling');
    expect(migration).toMatchObject({ state: 'backfilling', verificationAttemptCount: 2 });
    expect(
      database
        .prepare(
          `SELECT verification_attempt_count FROM control_lookup_bucket_migrations
            WHERE operation_id = ?`
        )
        .get(migration.operationId)
    ).toEqual({ verification_attempt_count: 2 });
  });

  it('advances only after verified counts and releases the rewrite lease after grace', async () => {
    let migration = await service.start('test', {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'management-run-1',
    });
    const checkpoint = (overrides: Record<string, unknown>) => ({
      operationId: migration.operationId,
      ownerId: 'management-run-1',
      fencingToken: migration.fencingToken,
      expectedState: migration.state,
      nextState: 'backfilling' as const,
      backfillCursor: '{}',
      sourceRowCount: null,
      targetRowCount: null,
      verificationDigest: null,
      ...overrides,
    });
    migration = await service.checkpoint('test', checkpoint({}));
    migration = await service.checkpoint(
      'test',
      checkpoint({
        nextState: 'verifying',
        backfillCursor: '{"complete":true}',
        sourceRowCount: 12,
        targetRowCount: 12,
      })
    );
    await expect(
      service.checkpoint(
        'test',
        checkpoint({
          nextState: 'cutover_pending',
          sourceRowCount: 12,
          targetRowCount: 11,
          verificationDigest: 'a'.repeat(64),
        })
      )
    ).rejects.toThrow('control_lookup_bucket_migration_verification_required');
    migration = await service.checkpoint(
      'test',
      checkpoint({
        nextState: 'cutover_pending',
        sourceRowCount: 12,
        targetRowCount: 12,
        verificationDigest: 'a'.repeat(64),
      })
    );
    migration = await service.prepareCutover('test', {
      operationId: migration.operationId,
      ownerId: 'management-run-1',
      fencingToken: migration.fencingToken,
    });
    runHook = (sql) => {
      if (!sql.includes("SET state = 'grace'")) return;
      runHook = null;
      database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET owner_id = 'cutover-racing-run', fencing_token = fencing_token + 1,
                  lease_expires_at = ?, updated_at = ?
            WHERE environment_id = 'test' AND operation_id = ?`
        )
        .run(now + 120, now, migration.operationId);
    };
    await expect(
      service.confirmCutover(
        'test',
        {
          operationId: migration.operationId,
          ownerId: 'management-run-1',
          fencingToken: migration.fencingToken,
        },
        8
      )
    ).rejects.toThrow('control_lookup_bucket_migration_cutover_stale');
    expect(
      database
        .prepare(
          `SELECT state, cutover_registry_generation
             FROM control_lookup_bucket_migrations WHERE operation_id = ?`
        )
        .get(migration.operationId)
    ).toEqual({ state: 'cutover_pending', cutover_registry_generation: null });

    now += 121;
    migration = await service.claim('test', {
      operationId: migration.operationId,
      ownerId: 'management-run-2',
    });
    migration = await service.confirmCutover(
      'test',
      {
        operationId: migration.operationId,
        ownerId: 'management-run-2',
        fencingToken: migration.fencingToken,
      },
      9
    );
    expect(migration.state).toBe('grace');
    await expect(
      service.complete('test', {
        operationId: migration.operationId,
        ownerId: 'management-run-2',
        fencingToken: migration.fencingToken,
        oldRowsQuarantined: true,
      })
    ).rejects.toThrow('control_lookup_bucket_migration_grace_active');

    now = required(migration.graceExpiresAt) + 1;
    migration = await service.claim('test', {
      operationId: migration.operationId,
      ownerId: 'management-run-3',
    });
    runHook = (sql) => {
      if (!sql.includes("SET status = 'succeeded'")) return;
      runHook = null;
      database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET owner_id = 'racing-run', fencing_token = fencing_token + 1,
                  lease_expires_at = ?, updated_at = ?
            WHERE environment_id = 'test' AND operation_id = ?`
        )
        .run(now + 120, now, migration.operationId);
    };
    await expect(
      service.complete('test', {
        operationId: migration.operationId,
        ownerId: 'management-run-3',
        fencingToken: migration.fencingToken,
        oldRowsQuarantined: true,
      })
    ).rejects.toThrow('control_lookup_bucket_migration_complete_stale');
    expect(
      database
        .prepare(
          `SELECT migration.state, operation.status
             FROM control_lookup_bucket_migrations migration
             JOIN control_operations operation ON operation.operation_id = migration.operation_id
            WHERE migration.operation_id = ?`
        )
        .get(migration.operationId)
    ).toEqual({ state: 'grace', status: 'running' });

    now += 121;
    migration = await service.claim('test', {
      operationId: migration.operationId,
      ownerId: 'management-run-4',
    });
    const completed = await service.complete('test', {
      operationId: migration.operationId,
      ownerId: 'management-run-4',
      fencingToken: migration.fencingToken,
      oldRowsQuarantined: true,
    });
    expect(completed.state).toBe('complete');
    await expect(service.writeRoute('test', 7)).resolves.toMatchObject({
      primary: { lookupShardId: 'lookup-b', assignmentGeneration: 4 },
      mirrors: [],
      migration: null,
    });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_directory_rewrite_leases`).get()
    ).toEqual({ count: 0 });
  });

  it('fences cutover and block mutations when the lease changes after claim validation', async () => {
    let migration = await service.start('test', {
      virtualBucket: 7,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'move-bucket-7',
      ownerId: 'management-run-1',
    });
    const checkpoint = (nextState: 'backfilling' | 'verifying' | 'cutover_pending') => ({
      operationId: migration.operationId,
      ownerId: 'management-run-1',
      fencingToken: migration.fencingToken,
      expectedState: migration.state,
      nextState,
      backfillCursor: nextState === 'backfilling' ? '{}' : '{"complete":true}',
      sourceRowCount: nextState === 'backfilling' ? null : 12,
      targetRowCount: nextState === 'backfilling' ? null : 12,
      verificationDigest: nextState === 'cutover_pending' ? 'a'.repeat(64) : null,
    });
    migration = await service.checkpoint('test', checkpoint('backfilling'));
    migration = await service.checkpoint('test', checkpoint('verifying'));
    migration = await service.checkpoint('test', checkpoint('cutover_pending'));

    runHook = (sql) => {
      if (!sql.includes('UPDATE control_lookup_bucket_assignments')) return;
      runHook = null;
      database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET owner_id = 'racing-run', fencing_token = fencing_token + 1,
                  lease_expires_at = ?, updated_at = ?
            WHERE environment_id = 'test' AND operation_id = ?`
        )
        .run(now + 120, now, migration.operationId);
    };
    await expect(
      service.prepareCutover('test', {
        operationId: migration.operationId,
        ownerId: 'management-run-1',
        fencingToken: migration.fencingToken,
      })
    ).rejects.toThrow('control_lookup_bucket_migration_cutover_stale');
    expect(
      database
        .prepare(
          `SELECT lookup_shard_id, assignment_generation, state
             FROM control_lookup_bucket_assignments
            WHERE environment_id = 'test' AND virtual_bucket = 7`
        )
        .get()
    ).toEqual({ lookup_shard_id: 'lookup-a', assignment_generation: 3, state: 'cutover_pending' });

    now += 121;
    migration = await service.claim('test', {
      operationId: migration.operationId,
      ownerId: 'management-run-2',
    });
    runHook = (sql) => {
      if (!sql.includes("SET state = 'blocked'")) return;
      runHook = null;
      database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET owner_id = 'second-racing-run', fencing_token = fencing_token + 1,
                  lease_expires_at = ?, updated_at = ?
            WHERE environment_id = 'test' AND operation_id = ?`
        )
        .run(now + 120, now, migration.operationId);
    };
    await expect(
      service.block('test', {
        operationId: migration.operationId,
        ownerId: 'management-run-2',
        fencingToken: migration.fencingToken,
        errorCode: 'lookup_bucket_migration_verification_mismatch',
      })
    ).rejects.toThrow('control_lookup_bucket_migration_block_stale');
    expect(
      database
        .prepare(
          `SELECT migration.state, assignment.state AS assignment_state, operation.status
             FROM control_lookup_bucket_migrations migration
             JOIN control_lookup_bucket_assignments assignment
               ON assignment.environment_id = migration.environment_id
              AND assignment.virtual_bucket = migration.virtual_bucket
             JOIN control_operations operation ON operation.operation_id = migration.operation_id
            WHERE migration.operation_id = ?`
        )
        .get(migration.operationId)
    ).toEqual({ state: 'cutover_pending', assignment_state: 'cutover_pending', status: 'running' });
  });

  it('rejects a target in another residency partition before mutation', async () => {
    await expect(
      service.start('test', {
        virtualBucket: 9,
        targetLookupShardId: 'lookup-c',
        idempotencyKey: 'move-bucket-9',
        ownerId: 'management-run-1',
      })
    ).rejects.toThrow('control_lookup_bucket_migration_target_unavailable');
    expect(
      database
        .prepare(
          `SELECT state FROM control_lookup_bucket_assignments
            WHERE environment_id = 'test' AND virtual_bucket = 9`
        )
        .get()
    ).toEqual({ state: 'active' });
  });
});
