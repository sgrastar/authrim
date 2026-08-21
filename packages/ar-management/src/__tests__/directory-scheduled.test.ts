import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY_SCHEDULED_CRON,
  isDirectoryScheduledCron,
  reconcileLookupBucketCounters,
  runDirectoryScheduledJobs,
  type DirectoryJobProcessor,
} from '../directory-scheduled';

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

class SqliteAdapter implements DatabaseAdapter {
  constructor(private readonly database: DatabaseSync) {}

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return this.database.prepare(sql).all(...values(params)) as T[];
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    return (this.database.prepare(sql).get(...values(params)) as T | undefined) ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const result = this.database.prepare(sql).run(...values(params));
    return { success: true, rowsAffected: Number(result.changes) };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn({
        query: (sql, params) => this.query(sql, params),
        queryOne: (sql, params) => this.queryOne(sql, params),
        execute: (sql, params) => this.execute(sql, params),
      });
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({ sql, params }) => {
        const result = this.database.prepare(sql).run(...values(params));
        return { success: true, rowsAffected: Number(result.changes) };
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'sqlite-test' };
  }

  getType(): string {
    return 'sqlite-test';
  }

  async close(): Promise<void> {}
}

describe('directory scheduled processing', () => {
  let database: DatabaseSync;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/001_pre_1_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    adapter = new SqliteAdapter(database);
  });

  afterEach(() => database.close());

  it('dispatches only the dedicated two-minute cron', () => {
    expect(DIRECTORY_SCHEDULED_CRON).toBe('*/2 * * * *');
    expect(isDirectoryScheduledCron('*/2 * * * *')).toBe(true);
    expect(isDirectoryScheduledCron('* * * * *')).toBe(false);
    expect(isDirectoryScheduledCron('0 */6 * * *')).toBe(false);
  });

  it('runs classes in priority order with independent row budgets and cursors', async () => {
    const order: string[] = [];
    const processor =
      (expectedRows: number): DirectoryJobProcessor =>
      async (input) => {
        order.push(input.jobClass);
        expect(input.rowLimit).toBe(expectedRows);
        return { cursor: { completed: input.jobClass }, processedRows: 1 };
      };

    const summary = await runDirectoryScheduledJobs(
      adapter,
      {
        routing_outbox: processor(100),
        hmac_reindex: processor(50),
        bucket_counter_reconciliation: processor(32),
      },
      { nowMs: () => 10_000, ownerId: 'directory-test' }
    );

    expect(order).toEqual(['routing_outbox', 'hmac_reindex', 'bucket_counter_reconciliation']);
    expect(summary.processedRows).toBe(3);
    expect(
      database
        .prepare(
          `SELECT job_class, owner_id, budget_remaining, cursor_json
             FROM lookup_directory_job_cursors ORDER BY job_class`
        )
        .all()
    ).toEqual([
      {
        job_class: 'bucket_counter_reconciliation',
        owner_id: null,
        budget_remaining: 31,
        cursor_json: '{"completed":"bucket_counter_reconciliation"}',
      },
      {
        job_class: 'hmac_reindex',
        owner_id: null,
        budget_remaining: 49,
        cursor_json: '{"completed":"hmac_reindex"}',
      },
      {
        job_class: 'routing_outbox',
        owner_id: null,
        budget_remaining: 99,
        cursor_json: '{"completed":"routing_outbox"}',
      },
    ]);
  });

  it('does not touch lower-priority checkpoints after the invocation budget is exhausted', async () => {
    let now = 10_000;
    const lowerProcessor = vi.fn<DirectoryJobProcessor>();
    const summary = await runDirectoryScheduledJobs(
      adapter,
      {
        routing_outbox: async () => {
          now += 21_000;
          return { cursor: { routed: true }, processedRows: 1 };
        },
        hmac_reindex: lowerProcessor,
        bucket_counter_reconciliation: lowerProcessor,
      },
      { nowMs: () => now, ownerId: 'directory-budget', invocationWallClockMs: 20_000 }
    );

    expect(summary.classes).toEqual([
      { jobClass: 'routing_outbox', status: 'completed', processedRows: 1 },
      { jobClass: 'hmac_reindex', status: 'budget_exhausted', processedRows: 0 },
    ]);
    expect(lowerProcessor).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `SELECT last_started_at, cursor_json FROM lookup_directory_job_cursors
            WHERE job_class = 'hmac_reindex'`
        )
        .get()
    ).toEqual({ last_started_at: null, cursor_json: '{}' });
  });

  it('cannot claim a class held by an overlapping invocation', async () => {
    database.exec(
      `UPDATE lookup_directory_job_cursors
          SET owner_id = 'other-invocation', lease_expires_at = 999, fencing_token = 7
        WHERE job_class = 'routing_outbox'`
    );
    const processor = vi.fn<DirectoryJobProcessor>();

    const summary = await runDirectoryScheduledJobs(
      adapter,
      { routing_outbox: processor },
      { nowMs: () => 10_000, ownerId: 'directory-overlap' }
    );

    expect(summary.classes).toEqual([
      { jobClass: 'routing_outbox', status: 'lease_unavailable', processedRows: 0 },
    ]);
    expect(processor).not.toHaveBeenCalled();
  });

  it('preserves the cursor and stores only a fixed error code on processor failure', async () => {
    const summary = await runDirectoryScheduledJobs(
      adapter,
      {
        routing_outbox: async () => {
          throw new Error('secret provider response');
        },
      },
      { nowMs: () => 10_000, ownerId: 'directory-failure' }
    );

    expect(summary.classes[0]).toEqual({
      jobClass: 'routing_outbox',
      status: 'failed',
      processedRows: 0,
      errorCode: 'directory_job_failed',
    });
    expect(
      database
        .prepare(
          `SELECT owner_id, cursor_json, last_error_code
             FROM lookup_directory_job_cursors WHERE job_class = 'routing_outbox'`
        )
        .get()
    ).toEqual({
      owner_id: null,
      cursor_json: '{}',
      last_error_code: 'directory_job_failed',
    });
  });

  it('retains an allowlisted HMAC error code without exposing arbitrary exception text', async () => {
    const summary = await runDirectoryScheduledJobs(
      adapter,
      {
        hmac_reindex: async () => {
          throw new Error('lookup_hmac_reindex_key_state_mismatch');
        },
      },
      { nowMs: () => 10_000, ownerId: 'directory-hmac-failure' }
    );

    expect(summary.classes[0]).toEqual({
      jobClass: 'hmac_reindex',
      status: 'failed',
      processedRows: 0,
      errorCode: 'lookup_hmac_reindex_key_state_mismatch',
    });
    expect(
      database
        .prepare(
          `SELECT last_error_code FROM lookup_directory_job_cursors
            WHERE job_class = 'hmac_reindex'`
        )
        .get()
    ).toEqual({ last_error_code: 'lookup_hmac_reindex_key_state_mismatch' });
  });

  it('reconciles exact identifier and alias counts with a persistent bounded cursor', async () => {
    database.exec(
      `INSERT INTO lookup_identifiers (
         virtual_bucket, index_kind, normalization_version, hmac_key_generation,
         identifier_blind_digest, tenant_id, account_id, route_schema_version,
         account_route_generation, required_binding_route_generation, residency_policy_id,
         route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state,
         created_at, updated_at
       ) VALUES (
         0, 'email_exact', 1, 1, 'digest', 'tenant-a', 'account-a', 1, 1, 1, 'default',
         '{}', 'active', 'active', 'active', 1, 1
       );
       INSERT INTO lookup_tenant_aliases (
         virtual_bucket, alias_kind, alias_sha256_digest, tenant_id, route_schema_version,
         route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state,
         created_at, updated_at
       ) VALUES (
         0, 'tenant_slug', 'alias-digest', 'tenant-a', 1, '{}', 'active', 'active', 'active', 1, 1
       );
       UPDATE lookup_bucket_counters
          SET estimated_active_identifier_count = 99,
              estimated_active_alias_count = 99,
              updated_at = 1
        WHERE virtual_bucket = 0;`
    );

    const summary = await runDirectoryScheduledJobs(
      adapter,
      { bucket_counter_reconciliation: reconcileLookupBucketCounters },
      { nowMs: () => 20_000, ownerId: 'directory-counter' }
    );

    expect(summary.processedRows).toBe(32);
    expect(
      database
        .prepare(
          `SELECT estimated_active_identifier_count, estimated_active_alias_count,
                  exact_count_checked_at
             FROM lookup_bucket_counters WHERE virtual_bucket = 0`
        )
        .get()
    ).toEqual({
      estimated_active_identifier_count: 1,
      estimated_active_alias_count: 1,
      exact_count_checked_at: 20,
    });
    expect(
      database
        .prepare(
          `SELECT cursor_json FROM lookup_directory_job_cursors
            WHERE job_class = 'bucket_counter_reconciliation'`
        )
        .get()
    ).toEqual({ cursor_json: '{"next_bucket":32}' });
  });

  it('fails closed on malformed counter cursors and provider rows', async () => {
    await expect(
      reconcileLookupBucketCounters({
        adapter,
        jobClass: 'bucket_counter_reconciliation',
        cursor: { next_bucket: '0' },
        rowLimit: 1,
        deadlineMs: 30_000,
        ownerId: 'directory-invalid-cursor',
        fencingToken: 1,
        nowMs: () => 20_000,
      })
    ).rejects.toThrow('directory_counter_cursor_invalid');

    vi.spyOn(adapter, 'query').mockResolvedValueOnce([
      {
        virtual_bucket: 1,
        active_identifier_count: -1,
        active_alias_count: 0,
      },
    ] as never);
    const batch = vi.spyOn(adapter, 'batch');

    await expect(
      reconcileLookupBucketCounters({
        adapter,
        jobClass: 'bucket_counter_reconciliation',
        cursor: { next_bucket: 0 },
        rowLimit: 1,
        deadlineMs: 30_000,
        ownerId: 'directory-invalid-row',
        fencingToken: 1,
        nowMs: () => 20_000,
      })
    ).rejects.toThrow('directory_counter_result_invalid');
    expect(batch).not.toHaveBeenCalled();
  });
});
