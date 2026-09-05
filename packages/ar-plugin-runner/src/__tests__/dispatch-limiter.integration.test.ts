import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1PluginDispatchLimiter } from '../dispatch-limiter';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async run() {
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
    };
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

const input = {
  installationId: 'installation-a',
  tenantId: 'tenant-a',
  capability: 'notifier.send',
  concurrencyCap: 1,
  ratePerMinute: 2,
  now: 1_000,
};

describe('D1PluginDispatchLimiter', () => {
  let database: DatabaseSync;
  let limiter: D1PluginDispatchLimiter;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['001_0_4_0_plugin_runner_baseline.sql']) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migration), 'utf8')
      );
    }
    database.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, created_at, updated_at
       ) VALUES (
         'installation-a', 'tenant-a', 'plugin-a', 'dynamic_worker',
         'plugin-a', 'enabled', 1, 1
       )`
    );
    limiter = new D1PluginDispatchLimiter(d1(database));
  });

  afterEach(() => database.close());

  it('uses a fenced lease to enforce the platform concurrency cap', async () => {
    const first = await limiter.acquire(input);
    expect(first).not.toBeNull();
    await expect(limiter.acquire(input)).resolves.toBeNull();
    if (!first) throw new Error('missing_dispatch_lease');
    await limiter.release(first);
    await expect(limiter.acquire(input)).resolves.not.toBeNull();
  });

  it('enforces the per-minute cap even after concurrency leases are released', async () => {
    const first = await limiter.acquire(input);
    if (!first) throw new Error('missing_dispatch_lease');
    await limiter.release(first);
    const second = await limiter.acquire(input);
    if (!second) throw new Error('missing_dispatch_lease');
    await limiter.release(second);

    await expect(limiter.acquire(input)).resolves.toBeNull();
    await expect(limiter.acquire({ ...input, now: 1_010 })).resolves.toBeNull();
    await expect(limiter.acquire({ ...input, now: 1_020 })).resolves.not.toBeNull();
  });

  it('keeps tenant and capability limit buckets isolated', async () => {
    const first = await limiter.acquire(input);
    expect(first).not.toBeNull();
    await expect(
      limiter.acquire({ ...input, tenantId: 'tenant-b', installationId: 'installation-a' })
    ).resolves.toBeNull();
    await expect(
      limiter.acquire({ ...input, capability: 'notifier.retry' })
    ).resolves.not.toBeNull();
  });
});
