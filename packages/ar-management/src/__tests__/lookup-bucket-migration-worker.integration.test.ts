import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ControlLookupBucketMigrationView } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupBucketMigrationWorker } from '../lookup-bucket-migration-worker';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BUCKET = 41;

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run<T>() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [] as T[], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

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
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    async batch<T>(statements: BoundStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run<T>());
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    getBookmark: () => 'bookmark',
  };
  return { ...session, withSession: () => session } as unknown as D1Database;
}

function migrationView(
  state: 'backfilling' | 'verifying' | 'grace'
): ControlLookupBucketMigrationView {
  return {
    operationId: 'lookup-bucket:test',
    virtualBucket: BUCKET,
    source: {
      lookupShardId: 'lookup-a',
      bindingRef: 'LOOKUP_A',
      assignmentGeneration: 1,
    },
    target: {
      lookupShardId: 'lookup-b',
      bindingRef: 'LOOKUP_B',
      assignmentGeneration: 2,
    },
    state,
    fencingToken: 1,
    leaseExpiresAt: 10_000,
    backfillCursor: '{}',
    sourceRowCount: null,
    targetRowCount: null,
    verificationDigest: null,
    verificationAttemptCount: 0,
    graceExpiresAt: state === 'grace' ? 1_000 : null,
  };
}

describe('LookupBucketMigrationWorker', () => {
  let source: DatabaseSync;
  let target: DatabaseSync;
  let now: number;
  let worker: LookupBucketMigrationWorker;

  beforeEach(() => {
    source = new DatabaseSync(':memory:');
    target = new DatabaseSync(':memory:');
    const schema = readFileSync(
      resolve(REPO_ROOT, 'migrations/lookup/001_pre_1_0_lookup_baseline.sql'),
      'utf8'
    )
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
    source.exec(schema);
    target.exec(schema);
    const metricsMigration = readFileSync(
      resolve(REPO_ROOT, 'migrations/lookup/002_lookup_scale_out_publication_metrics.sql'),
      'utf8'
    );
    source.exec(metricsMigration);
    target.exec(metricsMigration);
    for (let index = 0; index < 105; index += 1) {
      const digest = index.toString(16).padStart(64, '0');
      source
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, 'account_id', 1, 1, ?, 'tenant-a', ?, 1, 1, 1, 'default', '{}',
                     'active', 'active', 'active', 100, 100)`
        )
        .run(BUCKET, digest, `account-${index.toString().padStart(3, '0')}`);
    }
    source.exec(
      `INSERT INTO lookup_tenant_aliases (
         virtual_bucket, alias_kind, alias_sha256_digest, tenant_id, route_schema_version,
         route_projection_json, tenant_lifecycle_state, runtime_route_status,
         lifecycle_state, created_at, updated_at
       ) VALUES (${BUCKET}, 'tenant_slug', '${'a'.repeat(64)}', 'tenant-a', 1, '{}',
                 'active', 'active', 'active', 100, 100);
       INSERT INTO lookup_identifier_reservations (
         virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
         identifier_blind_digest, account_id, reservation_state, operation_id,
         lease_expires_at, created_at, updated_at
       ) VALUES (${BUCKET}, 'tenant-a', 'email_exact', 1, 1, '${'b'.repeat(64)}',
                 'account-000', 'committed', 'account-create-1', 1000, 100, 100);
       INSERT INTO lookup_identifier_replacements (
         replacement_id, tenant_id, account_id, index_kind, normalization_version,
         hmac_key_generation, old_virtual_bucket, old_blind_digest,
         new_virtual_bucket, new_blind_digest, gate_state, authoritative_checked_at,
         created_at, completed_at, updated_at
       ) VALUES ('replacement-1', 'tenant-a', 'account-000', 'email_exact',
                 1, 1, ${BUCKET}, '${'e'.repeat(64)}', ${BUCKET}, '${'f'.repeat(64)}',
                 'completed', 99, 100, 100, 100);`
    );
    source
      .prepare(
        `UPDATE lookup_bucket_counters
            SET successful_route_publication_count = 123,
                publication_counter_updated_at = 99
          WHERE virtual_bucket = ?`
      )
      .run(BUCKET);
    now = 100;
    worker = new LookupBucketMigrationWorker(d1(source), d1(target), () => now);
  });

  afterEach(() => {
    source.close();
    target.close();
  });

  async function copyAll(): Promise<void> {
    let cursor = '{}';
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const result = await worker.copyNext(migrationView('backfilling'), cursor);
      cursor = result.cursor;
      if (result.done) return;
    }
    throw new Error('copy_did_not_complete');
  }

  async function verifyAll(): Promise<{
    sourceRowCount: number | null;
    targetRowCount: number | null;
    verificationDigest: string | null;
  }> {
    let cursor: string | undefined;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const result = await worker.verifyNext(migrationView('verifying'), cursor);
      cursor = result.cursor;
      if (result.done) return result;
    }
    throw new Error('verification_did_not_complete');
  }

  it('maintains active identifier and alias counters on every lifecycle mutation', () => {
    expect(
      source
        .prepare(
          `SELECT estimated_active_identifier_count, estimated_active_alias_count
             FROM lookup_bucket_counters WHERE virtual_bucket = ?`
        )
        .get(BUCKET)
    ).toEqual({ estimated_active_identifier_count: 105, estimated_active_alias_count: 1 });

    source
      .prepare(
        `UPDATE lookup_identifiers SET lifecycle_state = 'disabled', updated_at = 200
          WHERE virtual_bucket = ? AND account_id = 'account-000'`
      )
      .run(BUCKET);
    source
      .prepare(
        `DELETE FROM lookup_identifiers
          WHERE virtual_bucket = ? AND account_id = 'account-001'`
      )
      .run(BUCKET);
    source
      .prepare(
        `UPDATE lookup_identifiers SET lifecycle_state = 'active', updated_at = 201
          WHERE virtual_bucket = ? AND account_id = 'account-000'`
      )
      .run(BUCKET);
    source
      .prepare(
        `UPDATE lookup_tenant_aliases SET lifecycle_state = 'disabled', updated_at = 202
          WHERE virtual_bucket = ?`
      )
      .run(BUCKET);

    expect(
      source
        .prepare(
          `SELECT estimated_active_identifier_count, estimated_active_alias_count,
                  reconciliation_cursor
             FROM lookup_bucket_counters WHERE virtual_bucket = ?`
        )
        .get(BUCKET)
    ).toEqual({
      estimated_active_identifier_count: 104,
      estimated_active_alias_count: 0,
      reconciliation_cursor: 'alias-trigger',
    });
  });

  it('copies in bounded keyset batches and verifies exact content', async () => {
    await copyAll();

    expect(
      target
        .prepare(`SELECT COUNT(*) AS count FROM lookup_identifiers WHERE virtual_bucket = ?`)
        .get(BUCKET)
    ).toEqual({ count: 105 });
    expect(target.prepare(`SELECT COUNT(*) AS count FROM lookup_tenant_aliases`).get()).toEqual({
      count: 1,
    });
    expect(
      target
        .prepare(
          `SELECT successful_route_publication_count, publication_counter_updated_at
             FROM lookup_bucket_counters WHERE virtual_bucket = ?`
        )
        .get(BUCKET)
    ).toEqual({
      successful_route_publication_count: 123,
      publication_counter_updated_at: 99,
    });
    expect(
      target.prepare(`SELECT COUNT(*) AS count FROM lookup_identifier_replacements`).get()
    ).toEqual({ count: 1 });
    const verified = await verifyAll();
    expect(verified.sourceRowCount).toBe(108);
    expect(verified.targetRowCount).toBe(108);
    expect(verified.verificationDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('refreshes older residual target rows when a bucket returns to a shard', async () => {
    target
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status,
           lifecycle_state, created_at, updated_at, disabled_at
         ) VALUES (?, 'account_id', 1, 1, ?, 'tenant-a', 'account-000', 1, 1, 1,
                   'default', '{"stale":true}', 'active', 'disabled', 'disabled', 50, 50, 50)`
      )
      .run(BUCKET, '0'.repeat(64));
    target
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status,
           lifecycle_state, created_at, updated_at
         ) VALUES (?, 'account_id', 1, 1, ?, 'tenant-a', 'residual-account', 1, 1, 1,
                   'default', '{"residual":true}', 'active', 'active', 'active', 40, 40)`
      )
      .run(BUCKET, 'f'.repeat(64));

    await copyAll();

    expect(
      target
        .prepare(
          `SELECT route_projection_json, runtime_route_status, lifecycle_state, disabled_at,
                  updated_at
             FROM lookup_identifiers
            WHERE virtual_bucket = ? AND account_id = 'account-000'`
        )
        .get(BUCKET)
    ).toEqual({
      route_projection_json: '{}',
      runtime_route_status: 'active',
      lifecycle_state: 'active',
      disabled_at: null,
      updated_at: 100,
    });
    expect(
      target
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifiers
            WHERE virtual_bucket = ? AND account_id = 'residual-account'`
        )
        .get(BUCKET)
    ).toEqual({ count: 0 });
    await expect(verifyAll()).resolves.toMatchObject({ sourceRowCount: 108, targetRowCount: 108 });
  });

  it('does not overwrite a newer dual-written target row with a stale source page', async () => {
    const first = await worker.copyNext(migrationView('backfilling'), '{}');
    expect(first.done).toBe(false);
    target
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status,
           lifecycle_state, created_at, updated_at
         ) VALUES (?, 'account_id', 1, 1, ?, 'tenant-a', 'account-104', 1, 2, 2,
                   'default', '{"newer":true}', 'active', 'active', 'active', 100, 200)`
      )
      .run(BUCKET, (104).toString(16).padStart(64, '0'));

    await worker.copyNext(migrationView('backfilling'), first.cursor);

    expect(
      target
        .prepare(
          `SELECT route_projection_json, account_route_generation, updated_at
             FROM lookup_identifiers
            WHERE virtual_bucket = ? AND account_id = 'account-104'`
        )
        .get(BUCKET)
    ).toEqual({
      route_projection_json: '{"newer":true}',
      account_route_generation: 2,
      updated_at: 200,
    });
  });

  it('preserves a route and publication counter dual-written during backfill', async () => {
    const first = await worker.copyNext(migrationView('backfilling'), '{}');
    expect(first.done).toBe(false);
    const digest = 'f'.repeat(64);
    const insert = (database: DatabaseSync) => {
      database
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, 'account_id', 1, 1, ?, 'tenant-a', 'account-dual-write',
                     1, 1, 1, 'default', '{"dualWrite":true}', 'active', 'active',
                     'active', 150, 150)`
        )
        .run(BUCKET, digest);
      database
        .prepare(
          `UPDATE lookup_bucket_counters
              SET successful_route_publication_count =
                    successful_route_publication_count + 1,
                  publication_counter_updated_at = 150
            WHERE virtual_bucket = ?`
        )
        .run(BUCKET);
    };
    insert(source);
    insert(target);

    let cursor = first.cursor;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const result = await worker.copyNext(migrationView('backfilling'), cursor);
      cursor = result.cursor;
      if (result.done) break;
      if (iteration === 19) throw new Error('copy_did_not_complete');
    }

    await expect(verifyAll()).resolves.toMatchObject({
      sourceRowCount: 109,
      targetRowCount: 109,
    });
    expect(
      target
        .prepare(
          `SELECT route_projection_json FROM lookup_identifiers
            WHERE virtual_bucket = ? AND account_id = 'account-dual-write'`
        )
        .get(BUCKET)
    ).toEqual({ route_projection_json: '{"dualWrite":true}' });
    expect(
      target
        .prepare(
          `SELECT successful_route_publication_count, publication_counter_updated_at
             FROM lookup_bucket_counters WHERE virtual_bucket = ?`
        )
        .get(BUCKET)
    ).toEqual({
      successful_route_publication_count: 124,
      publication_counter_updated_at: 150,
    });
  });

  it('detects extra or altered target content', async () => {
    await copyAll();
    target
      .prepare(
        `UPDATE lookup_identifiers SET route_projection_json = '{"tampered":true}'
          WHERE virtual_bucket = ? AND account_id = 'account-000'`
      )
      .run(BUCKET);

    await expect(verifyAll()).rejects.toThrow('lookup_bucket_migration_verification_mismatch');
  });

  it('waits for pinned challenges before quarantining old route rows', async () => {
    source
      .prepare(
        `INSERT INTO lookup_discovery_otp_challenges (
           challenge_id, normalization_version, email_blind_digest, hmac_key_generation,
           virtual_bucket,
           otp_verifier, delivery_state, attempt_count, attempt_limit, expires_at,
           consumed_at, created_at, updated_at
         ) VALUES (?, 1, ?, 1, ?, ?, 'sent', 0, 5, ?, NULL, ?, ?)`
      )
      .run(
        `discovery-${BUCKET}-1-00000000-0000-4000-8000-000000000001`,
        '1'.repeat(64),
        BUCKET,
        '2'.repeat(64),
        2_000,
        100,
        100
      );
    now = 1_001;
    await expect(worker.quarantineSource(migrationView('grace'))).rejects.toThrow(
      'lookup_bucket_migration_challenge_grace_active'
    );

    now = 2_001;
    await worker.quarantineSource(migrationView('grace'));
    expect(
      source
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifiers
            WHERE virtual_bucket = ? AND lifecycle_state <> 'disabled'`
        )
        .get(BUCKET)
    ).toEqual({ count: 0 });
    expect(
      source
        .prepare(
          `SELECT estimated_active_identifier_count, estimated_active_alias_count,
                  reconciliation_cursor
             FROM lookup_bucket_counters WHERE virtual_bucket = ?`
        )
        .get(BUCKET)
    ).toEqual({
      estimated_active_identifier_count: 0,
      estimated_active_alias_count: 0,
      reconciliation_cursor: 'migration-quarantine',
    });
  });
});
