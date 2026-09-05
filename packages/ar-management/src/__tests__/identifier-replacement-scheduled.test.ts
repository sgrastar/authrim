import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Env } from '@authrim/ar-lib-core';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processScheduledIdentifierReplacements } from '../identifier-replacement-scheduled';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  private prepare(sql: string) {
    return {
      bind: (...values: unknown[]) =>
        new BoundStatement(this.database.prepare(sql), sqlValues(values)),
    };
  }

  readonly binding = {
    prepare: (sql: string) => this.prepare(sql),
    batch: async (statements: unknown[]) => this.batch(statements),
    exec: async (sql: string) => {
      this.database.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession: () => this.session(),
  } as unknown as D1Database;

  private session(): D1DatabaseSession {
    return {
      prepare: (sql: string) => this.prepare(sql),
      batch: async (statements: unknown[]) => this.batch(statements),
      getBookmark: () => 'test-bookmark',
    } as unknown as D1DatabaseSession;
  }

  private async batch(statements: unknown[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
        return statement.executeRun();
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

describe('identifier replacement scheduled recovery', () => {
  let admin: DatabaseSync;
  let pii: DatabaseSync;
  let adminD1: SqliteD1;
  let piiD1: SqliteD1;
  const info = vi.fn();
  const warn = vi.fn();

  beforeEach(() => {
    admin = new DatabaseSync(':memory:');
    pii = new DatabaseSync(':memory:');
    admin.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/admin/001_0_4_0_admin_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    pii.exec(readFileSync(resolve(REPO_ROOT, 'migrations/pii/001_0_4_0_pii_baseline.sql'), 'utf8'));
    adminD1 = new SqliteD1(admin);
    piiD1 = new SqliteD1(pii);
    vi.clearAllMocks();
  });

  afterEach(() => {
    admin.close();
    pii.close();
  });

  function env() {
    return {
      DB_ADMIN: adminD1.binding,
      PII_A: piiD1.binding,
      CONTROL: {
        listAccountRouteSourceShards: vi.fn(async ({ afterShardId }) =>
          afterShardId === null
            ? [
                {
                  dataRole: 'tenant_pii' as const,
                  shardId: 'pii-a',
                  bindingRef: 'PII_A',
                  residencyPartition: 'global',
                  routeGeneration: 1,
                },
              ]
            : []
        ),
      },
    } as unknown as Env;
  }

  it('advances the fenced Admin cursor only after a PII shard is drained', async () => {
    const workerEnv = env();
    const first = await processScheduledIdentifierReplacements(
      workerEnv,
      { info, warn },
      {
        nowMs: () => 10_000,
        ownerId: 'scheduler-a',
      }
    );
    const second = await processScheduledIdentifierReplacements(
      workerEnv,
      { info, warn },
      {
        nowMs: () => 20_000,
        ownerId: 'scheduler-b',
      }
    );

    expect(first).toEqual({
      skipped: false,
      scannedShards: 1,
      processedOperations: 0,
      nextShardId: 'pii-a',
    });
    expect(second.nextShardId).toBeNull();
    expect(
      admin
        .prepare(
          `SELECT after_shard_id, lease_owner, last_error_code
           FROM identifier_replacement_scheduler_state WHERE singleton_id = 1`
        )
        .get()
    ).toEqual({ after_shard_id: null, lease_owner: null, last_error_code: null });
  });

  it('skips a concurrent invocation while the scheduler lease is active', async () => {
    admin
      .prepare(
        `UPDATE identifier_replacement_scheduler_state
          SET lease_owner = 'other', lease_expires_at = 100, updated_at = 1
        WHERE singleton_id = 1`
      )
      .run();

    await expect(
      processScheduledIdentifierReplacements(
        env(),
        { info, warn },
        {
          nowMs: () => 10_000,
          ownerId: 'scheduler-a',
        }
      )
    ).resolves.toEqual({
      skipped: true,
      scannedShards: 0,
      processedOperations: 0,
      nextShardId: null,
    });
  });
});
