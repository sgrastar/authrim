import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginRunnerRegistryClaims } from '@authrim/ar-lib-core/control-plane';
import { D1PluginRunnerStateRepository } from '../registry-state';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly database: DatabaseSync,
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

  execute() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class Session {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      bind: (...values: unknown[]) =>
        new BoundStatement(
          this.database,
          statement,
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
        ),
      first: async <T>() => (statement.get() as T | undefined) ?? null,
    };
  }

  async batch(statements: BoundStatement[]) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

function registry(generation: number, shardCount: number): PluginRunnerRegistryClaims {
  const issuedAt = 1_000;
  return {
    iss: 'authrim-control:test',
    aud: 'authrim-plugin-runner',
    iat: issuedAt,
    exp: issuedAt + 1_800,
    environmentId: 'test',
    generation,
    shards: Array.from({ length: shardCount }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      return {
        shardId: `shard-${suffix}`,
        bindingRef: `TDB_USERS_JP_${suffix}_CORE`,
        dataRole: 'tenant_core/users' as const,
        residencyPartition: 'jp',
        routeGeneration: generation,
      };
    }),
  };
}

describe('D1PluginRunnerStateRepository', () => {
  let database: DatabaseSync;
  let repository: D1PluginRunnerStateRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner/001_plugin_runner.sql'), 'utf8')
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/plugin-runner/002_registry_installations_and_config.sql'),
        'utf8'
      )
    );
    repository = new D1PluginRunnerStateRepository(d1(database));
  });

  afterEach(() => database.close());

  it('checkpoints a registry sweep at the bounded probe boundary and resumes it', async () => {
    const first = await repository.advanceSweep(registry(1, 201), 1_100);
    expect(first).toMatchObject({ startIndex: 0, nextIndex: 200, complete: false });
    expect(
      database.prepare(`SELECT pending_cursor FROM plugin_runner_registry_state`).get()
    ).toEqual({ pending_cursor: 200 });

    const second = await repository.advanceSweep(registry(1, 201), 1_101);
    expect(second).toMatchObject({ startIndex: 200, nextIndex: 201, complete: true });
    expect(
      database
        .prepare(
          `SELECT active_generation, pending_generation, sweep_completed_at
             FROM plugin_runner_registry_state`
        )
        .get()
    ).toEqual({ active_generation: 1, pending_generation: null, sweep_completed_at: 1101 });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_registry_shards`).get()
    ).toEqual({ count: 201 });
  });

  it('completes a 1,000-shard sweep within five one-minute invocations', async () => {
    const snapshot = registry(1, 1_000);
    for (let invocation = 0; invocation < 5; invocation += 1) {
      const progress = await repository.advanceSweep(snapshot, 1_100 + invocation * 60);
      expect(progress).toMatchObject({
        nextIndex: (invocation + 1) * 200,
        complete: invocation === 4,
        overdue: false,
      });
    }
    expect(
      database
        .prepare(
          `SELECT active_generation, pending_generation, sweep_overdue,
                  sweep_completed_at FROM plugin_runner_registry_state`
        )
        .get()
    ).toEqual({
      active_generation: 1,
      pending_generation: null,
      sweep_overdue: 0,
      sweep_completed_at: 1340,
    });
  });

  it('rejects a signed generation rollback without changing active inventory', async () => {
    await repository.advanceSweep(registry(2, 1), 1_100);
    await expect(repository.advanceSweep(registry(1, 1), 1_101)).rejects.toThrow(
      'plugin_runner_registry_generation_rollback'
    );
    expect(
      database.prepare(`SELECT active_generation FROM plugin_runner_registry_state`).get()
    ).toEqual({ active_generation: 2 });
  });

  it('supersedes an incomplete sweep when a newer signed generation arrives', async () => {
    await repository.advanceSweep(registry(1, 201), 1_100);
    await expect(repository.advanceSweep(registry(2, 1), 1_101)).resolves.toMatchObject({
      generation: 2,
      startIndex: 0,
      nextIndex: 1,
      complete: true,
    });
    expect(
      database
        .prepare(`SELECT active_generation, pending_generation FROM plugin_runner_registry_state`)
        .get()
    ).toEqual({ active_generation: 2, pending_generation: null });
    expect(
      database
        .prepare(
          `SELECT tenant_shard_id, active FROM plugin_runner_registry_shards
            WHERE active = 1 ORDER BY tenant_shard_id`
        )
        .all()
    ).toEqual([{ tenant_shard_id: 'shard-0000', active: 1 }]);
  });

  it('leases each due shard to only one overlapping runner and fences completion', async () => {
    await repository.advanceSweep(registry(1, 1), 1_100);
    const first = await repository.claimDueShards({ ownerId: 'runner-a', now: 1_101, limit: 1 });
    const overlapping = await repository.claimDueShards({
      ownerId: 'runner-b',
      now: 1_101,
      limit: 1,
    });
    expect(first).toHaveLength(1);
    expect(overlapping).toEqual([]);

    await expect(
      repository.finishShard({
        claim: { ...first[0], ownerId: 'runner-b' },
        now: 1_102,
        nextDueAt: 1_200,
      })
    ).rejects.toThrow('plugin_runner_shard_finish_stale');
    await expect(
      repository.finishShard({ claim: first[0], now: 1_102, nextDueAt: 1_200 })
    ).resolves.toBeUndefined();
  });

  it('starts a periodic full sweep after five minutes without changing generation', async () => {
    await repository.advanceSweep(registry(1, 1), 1_100);
    await expect(repository.advanceSweep(registry(1, 1), 1_399)).resolves.toBeNull();
    await expect(repository.advanceSweep(registry(1, 1), 1_401)).resolves.toMatchObject({
      generation: 1,
      complete: true,
    });
  });

  it('persists an operator-visible alert without discarding an overdue sweep checkpoint', async () => {
    await repository.advanceSweep(registry(1, 201), 1_100);
    await expect(repository.advanceSweep(registry(1, 201), 1_401)).resolves.toMatchObject({
      startIndex: 200,
      complete: true,
      overdue: true,
    });
    expect(
      database
        .prepare(`SELECT sweep_overdue, last_error_code FROM plugin_runner_registry_state`)
        .get()
    ).toEqual({
      sweep_overdue: 1,
      last_error_code: 'plugin_runner_full_sweep_overdue',
    });
  });
});
