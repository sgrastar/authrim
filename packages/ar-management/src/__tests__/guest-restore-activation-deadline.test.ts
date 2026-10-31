import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { activateProvisionedTenantLifecycle } from '../admin-tenants';

const databases: SQLiteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function fixture(initialClock = 1000) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    "CREATE TABLE tenants(id TEXT PRIMARY KEY,lifecycle_state TEXT,updated_at INTEGER);INSERT INTO tenants VALUES('tenant-a','provisioning',0)"
  );
  let clock = initialClock;
  database.function('julianday', (_value) => 2440587.5 + clock / 86400000);
  const adapter: DatabaseAdapter = {
    query: async <T>(sql: string, params: unknown[] = []) =>
      database.prepare(sql).all(...(params as SQLInputValue[])) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) =>
      (database.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null,
    execute: async (sql, params = []) => ({
      success: true,
      rowsAffected: Number(database.prepare(sql).run(...(params as SQLInputValue[])).changes),
    }),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    getType: () => 'd1',
    close: async () => {},
  };
  return {
    database,
    adapter,
    setClock: (value: number) => {
      clock = value;
    },
    state: () =>
      (
        database.prepare('SELECT lifecycle_state FROM tenants').get() as
          | { lifecycle_state: string }
          | undefined
      )?.lifecycle_state,
  };
}
it('uses database execution time to reject a delayed activation after its held deadline', async () => {
  const platform = fixture(2000),
    core = fixture(2000);
  await expect(
    activateProvisionedTenantLifecycle({
      platformAdapter: platform.adapter,
      tenantAdapter: core.adapter,
      tenantId: 'tenant-a',
      now: 1,
      admissionDeadlineMs: 1500,
    })
  ).rejects.toThrow('lifecycle_commit_failed');
  expect(platform.state()).toBe('provisioning');
  expect(core.state()).toBe('provisioning');
});
it('does not report partial platform activation as success and can complete under a fresh admitted deadline', async () => {
  const platform = fixture(1000),
    core = fixture(2000);
  await expect(
    activateProvisionedTenantLifecycle({
      platformAdapter: platform.adapter,
      tenantAdapter: core.adapter,
      tenantId: 'tenant-a',
      now: 1,
      admissionDeadlineMs: 1500,
    })
  ).rejects.toThrow('lifecycle_commit_failed');
  expect(platform.state()).toBe('active');
  expect(core.state()).toBe('provisioning');
  platform.setClock(2000);
  await expect(
    activateProvisionedTenantLifecycle({
      platformAdapter: platform.adapter,
      tenantAdapter: core.adapter,
      tenantId: 'tenant-a',
      now: 2,
      admissionDeadlineMs: 3000,
    })
  ).resolves.toBeUndefined();
  expect(platform.state()).toBe('active');
  expect(core.state()).toBe('active');
});
it('keeps the ordinary provisioning path and uses the PostgreSQL execution clock on its native port', async () => {
  const platform = fixture(),
    core = fixture();
  await activateProvisionedTenantLifecycle({
    platformAdapter: platform.adapter,
    tenantAdapter: core.adapter,
    tenantId: 'tenant-a',
    now: 1,
  });
  expect(core.state()).toBe('active');
  const statements: string[] = [];
  const postgres: DatabaseAdapter = {
    ...core.adapter,
    getType: () => 'postgres',
    execute: async (sql) => {
      statements.push(sql);
      return { success: true, rowsAffected: 1 };
    },
    queryOne: async <T>(sql: string) => {
      statements.push(sql);
      return { lifecycle_state: 'active' } as T;
    },
  };
  await activateProvisionedTenantLifecycle({
    platformAdapter: postgres,
    tenantAdapter: postgres,
    tenantId: 'tenant-a',
    now: 1,
    admissionDeadlineMs: 3000,
  });
  expect(
    statements.every((sql) => sql.includes('clock_timestamp()') && sql.includes('GREATEST('))
  ).toBe(true);
  expect(statements.some((sql) => sql.includes('julianday'))).toBe(false);
});
