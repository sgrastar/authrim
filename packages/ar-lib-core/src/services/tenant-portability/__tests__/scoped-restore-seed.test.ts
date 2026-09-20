import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readScopedSqliteRestoreSeedFingerprint } from '../scoped-restore-seed';
import type { SqliteDatasetInspectionPolicy } from '../sqlite-dataset-inspector';

let db: DatabaseSync;

const settings: SqliteDatasetInspectionPolicy = {
  dataset: {
    id: 'admin.tenant_settings',
    module: 'settings',
    kind: 'settings',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  },
  schema: {
    table: 'tenant_settings',
    columns: ['id', 'tenant_id', 'value'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'tenant_id',
  },
  async inspectRow() {
    return [];
  },
};

const audit: SqliteDatasetInspectionPolicy = {
  dataset: {
    id: 'admin.audit_logs',
    module: 'audit',
    kind: 'audit',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  },
  schema: {
    table: 'audit_logs',
    columns: ['id', 'tenant_id', 'action'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'tenant_id',
  },
  async inspectRow() {
    return [];
  },
};

const database = {
  async query<T>(sql: string, params: unknown[] = []) {
    return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  },
};

const fingerprint = () =>
  readScopedSqliteRestoreSeedFingerprint({
    database,
    policies: [settings, audit],
    tenantId: 'tenant-a',
    tenantKey: 'tenant-key-a',
    assertAdmission: async () => {},
  });

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenant_settings(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, value TEXT);
    CREATE TABLE audit_logs(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, action TEXT);
  `);
});

afterEach(() => db.close());

it('pins only the selected tenant business rows in a shared restore database', async () => {
  const empty = await fingerprint();
  db.exec("INSERT INTO tenant_settings VALUES ('other', 'tenant-b', 'value')");
  expect(await fingerprint()).toBe(empty);

  db.exec("INSERT INTO tenant_settings VALUES ('selected', 'tenant-a', 'value')");
  const selected = await fingerprint();
  expect(selected).not.toBe(empty);

  db.exec("INSERT INTO audit_logs VALUES ('request-audit', 'tenant-a', 'restore.requested')");
  expect(await fingerprint()).toBe(selected);
});

it('fails when admission is lost during the scoped read', async () => {
  let checks = 0;
  await expect(
    readScopedSqliteRestoreSeedFingerprint({
      database,
      policies: [settings],
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      assertAdmission: async () => {
        if (++checks === 2) throw new Error('admission_lost');
      },
    })
  ).rejects.toThrow('admission_lost');
});
