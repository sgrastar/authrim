import { readSqliteRestoreSeedFingerprint } from '../sqlite-restore-seed';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { invalidateSqliteRestoreTarget, SqliteRestoreTarget } from '../sqlite-restore-target';
import type { SqliteDatasetInspectionPolicy } from '../sqlite-dataset-inspector';
import type { TenantBundleManifest } from '../bundle-manifest';
let db: DatabaseSync;
let now: number;
let denied: boolean;
const identity = {
  id: 'stage',
  tenantId: 'a',
  operationId: 'import',
  resourceId: 'isolated-db',
  planDigest: 'a'.repeat(64),
  seedFingerprint: 'b'.repeat(64),
};
const policy: SqliteDatasetInspectionPolicy = {
  dataset: {
    id: 'core.tenants',
    module: 'tenant-runtime',
    kind: 'settings',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  },
  schema: {
    table: 'tenants',
    columns: ['id', 'value', 'count', 'binary'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'id',
  },
  async inspectRow() {
    return [];
  },
};
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: 'a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
  selection: {
    settings: true,
    users: false,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' },
  },
  snapshotId: 's',
  boundaryUnixMs: 1,
  inventoryDigestSha256: 'c'.repeat(64),
  datasets: [policy.dataset],
};
const row = JSON.stringify({
  id: ['text', 'a'],
  value: ['text', '日本語'],
  count: ['integer', '9007199254740993'],
  binary: ['blob', '00FF'],
});
function input(fence = 1) {
  return {
    database: {
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
      },
      async execute(sql: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
        };
      },
    },
    identity,
    lease: { owner: 'worker-' + fence, fencingToken: fence, expiresAt: 1000 },
    now: () => now,
    async authorize() {
      if (denied) throw new Error('not_authorized');
    },
  };
}
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  now = 100;
  denied = false;
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/core/d1/010_tenant_backup_restore_target.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/core/d1/011_tenant_backup_restore_target_cancellation.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    'CREATE TABLE tenants(id TEXT NOT NULL PRIMARY KEY,value TEXT,count INTEGER,binary BLOB); CREATE TABLE writes(id TEXT); CREATE TRIGGER writes_once AFTER INSERT ON tenants BEGIN INSERT INTO writes VALUES(NEW.id); END'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
});
afterEach(() => db.close());

it('writes typed rows once and reopens after a lost response without replacing data', async () => {
  const target = await SqliteRestoreTarget.open(input());
  await target.writeRow(policy, manifest, row);
  await target.writeRow(policy, manifest, row);
  const resumed = await SqliteRestoreTarget.open(input(2));
  await resumed.writeRow(policy, manifest, row);
  expect(db.prepare('SELECT count(*) AS n FROM writes').get()?.n).toBe(1);
  expect(
    db.prepare('SELECT value,CAST(count AS TEXT) AS exact,hex(binary) AS binary FROM tenants').get()
  ).toEqual({ value: '日本語', exact: '9007199254740993', binary: '00FF' });
  await expect(target.writeRow(policy, manifest, row)).rejects.toThrow();
  await expect(
    resumed.writeRow(policy, manifest, row.replace('日本語', 'different'))
  ).rejects.toThrow();
  expect(db.prepare('SELECT value FROM tenants').get()?.value).toBe('日本語');
});
it('recovers from an uncertain insert response without replaying application triggers', async () => {
  const options = input();
  const execute = options.database.execute;
  let lost = false;
  options.database.execute = async (sql, params) => {
    const result = await execute(sql, params);
    if (!lost && sql.startsWith('INSERT INTO "tenants"')) {
      lost = true;
      throw new Error('response_lost');
    }
    return result;
  };
  const target = await SqliteRestoreTarget.open(options);
  await expect(target.writeRow(policy, manifest, row)).rejects.toThrow('response_lost');
  await target.writeRow(policy, manifest, row);
  expect(db.prepare('SELECT count(*) AS n FROM writes').get()?.n).toBe(1);
});
it('rejects used targets, wrong plans, other operations, expired leases and foreign rows', async () => {
  db.exec("INSERT INTO tenants(id) VALUES ('used')");
  await expect(SqliteRestoreTarget.open(input())).rejects.toThrow('backup_restore_target_rejected');
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(0);
  db.exec('DELETE FROM tenants; DELETE FROM writes');
  const target = await SqliteRestoreTarget.open(input());
  await expect(
    SqliteRestoreTarget.open({ ...input(2), identity: { ...identity, planDigest: 'd'.repeat(64) } })
  ).rejects.toThrow();
  await expect(
    SqliteRestoreTarget.open({ ...input(2), identity: { ...identity, operationId: 'other' } })
  ).rejects.toThrow();
  await expect(
    target.writeRow(policy, manifest, row.replace('["text","a"]', '["text","other"]'))
  ).rejects.toThrow();
  now = 1000;
  await expect(target.writeRow(policy, manifest, row)).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(0);
});
it('checks the local target fence inside INSERT even if admission changes after authorization', async () => {
  const options = input();
  const execute = options.database.execute;
  options.database.execute = async (sql, params) => {
    if (sql.startsWith('INSERT INTO "tenants"'))
      db.exec("UPDATE tenant_backup_restore_targets SET state='invalid'");
    return execute(sql, params);
  };
  const target = await SqliteRestoreTarget.open(options);
  await expect(target.writeRow(policy, manifest, row)).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(0);
  await expect(SqliteRestoreTarget.open(input(2))).rejects.toThrow();
});
it('does not write without plan authorization and preserves primary-key constraints', async () => {
  const target = await SqliteRestoreTarget.open(input());
  denied = true;
  await expect(target.writeRow(policy, manifest, row)).rejects.toThrow('not_authorized');
  denied = false;
  await expect(
    target.writeRow(policy, manifest, row.replace('["text","a"]', '["null",null]'))
  ).rejects.toThrow();
  expect(() => db.exec('UPDATE tenant_backup_restore_targets SET fencing_token=0')).toThrow();
  expect(() => db.exec("UPDATE tenant_backup_restore_targets SET operation_id='other'")).toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(0);
});

it('invalidates loading or sealed unpublished targets under a newer cleanup fence', async () => {
  const target = await SqliteRestoreTarget.open(input());
  await target.seal();
  await expect(target.writeRow(policy, manifest, row)).rejects.toThrow();
  expect(await invalidateSqliteRestoreTarget(input(2))).toEqual({ found: true });
  expect(
    db.prepare('SELECT owner,fencing_token,state FROM tenant_backup_restore_targets').get()
  ).toEqual({ owner: 'worker-2', fencing_token: 2, state: 'invalid' });
  expect(() => db.exec("UPDATE tenant_backup_restore_targets SET state='sealed'")).toThrow(
    'backup_restore_target_regression'
  );
  await expect(invalidateSqliteRestoreTarget(input())).rejects.toThrow(
    'backup_restore_target_rejected'
  );
});

it('reports an unopened target without creating cleanup metadata', async () => {
  expect(await invalidateSqliteRestoreTarget(input(2))).toEqual({ found: false });
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(0);
});

it('preserves composite keys and foreign keys without disabling target constraints', async () => {
  db.exec(
    'PRAGMA foreign_keys=ON; CREATE TABLE children(tenant_id TEXT NOT NULL REFERENCES tenants(id), child_id TEXT NOT NULL, value TEXT, PRIMARY KEY(tenant_id,child_id))'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const childPolicy: SqliteDatasetInspectionPolicy = {
    dataset: { ...policy.dataset, id: 'core.children' },
    schema: {
      table: 'children',
      columns: ['tenant_id', 'child_id', 'value'],
      primaryKey: ['tenant_id', 'child_id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    async inspectRow() {
      return [];
    },
  };
  const childManifest = { ...manifest, datasets: [policy.dataset, childPolicy.dataset] };
  const target = await SqliteRestoreTarget.open(input());
  const childRow = JSON.stringify({
    tenant_id: ['text', 'a'],
    child_id: ['text', 'child'],
    value: ['null', null],
  });
  await expect(target.writeRow(childPolicy, childManifest, childRow)).rejects.toThrow(
    'FOREIGN KEY'
  );
  expect(db.prepare('SELECT count(*) AS n FROM children').get()?.n).toBe(0);
  await target.writeRow(policy, manifest, row);
  await target.writeRow(childPolicy, childManifest, childRow);
  await target.writeRow(childPolicy, childManifest, childRow);
  await expect(
    target.writeRow(
      childPolicy,
      childManifest,
      childRow.replace('["text","child"]', '["null",null]')
    )
  ).rejects.toThrow();
  expect(db.prepare('SELECT * FROM children').all()).toEqual([
    { tenant_id: 'a', child_id: 'child', value: null },
  ]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  await target.verifyRow(childPolicy, childManifest, childRow);
  await target.verifyDataset(childPolicy, 1);
  db.exec("INSERT INTO children VALUES ('a','extra',NULL)");
  await expect(target.verifyDataset(childPolicy, 1)).rejects.toThrow();
  db.exec("DELETE FROM children WHERE child_id='extra'");
  db.exec('PRAGMA foreign_keys=OFF; DELETE FROM tenants');
  await expect(target.verifyDataset(childPolicy, 1)).rejects.toThrow();

  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(0);
});

it('readback detects missing and changed rows without repairing them', async () => {
  const target = await SqliteRestoreTarget.open(input());
  await expect(target.verifyRow(policy, manifest, row)).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(0);
  await target.writeRow(policy, manifest, row);
  await target.verifyRow(policy, manifest, row);
  await target.verifyDataset(policy, 1);
  await expect(target.verifyDataset(policy, 0)).rejects.toThrow();
  db.exec("UPDATE tenants SET value='changed'");
  await expect(target.verifyRow(policy, manifest, row)).rejects.toThrow();
  expect(db.prepare('SELECT value FROM tenants').get()?.value).toBe('changed');
  expect(db.prepare('SELECT count(*) AS n FROM writes').get()?.n).toBe(1);
});

it('applies installed target-only restore values and verifies against the transformed row', async () => {
  const target = await SqliteRestoreTarget.open(input());
  const overridePolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreOverrides: { value: ['text', 'pending'] },
  };
  await target.writeRow(overridePolicy, manifest, row);
  expect(db.prepare('SELECT value FROM tenants').get()).toEqual({ value: 'pending' });
  await target.verifyRow(overridePolicy, manifest, row);
  await expect(target.verifyRow(policy, manifest, row)).rejects.toThrow();
});

it('leaves sidecar-owned columns out of SQL byte verification only', async () => {
  const target = await SqliteRestoreTarget.open(input());
  const sidecarPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreOverrides: { value: ['null', null] },
    verificationIgnoredColumns: ['value'],
  };
  await target.writeRow(sidecarPolicy, manifest, row);
  expect(db.prepare('SELECT value FROM tenants').get()).toEqual({ value: null });
  db.exec("UPDATE tenants SET value='reencrypted'");
  await target.verifyRow(sidecarPolicy, manifest, row);
  db.exec('UPDATE tenants SET count=1');
  await expect(target.verifyRow(sidecarPolicy, manifest, row)).rejects.toThrow();
});

it('rejects restore overrides for identity columns', async () => {
  const target = await SqliteRestoreTarget.open(input());
  await expect(
    target.writeRow({ ...policy, restoreOverrides: { id: ['text', 'other'] } }, manifest, row)
  ).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()).toEqual({ n: 0 });
});

it('compares text bytes exactly even when target columns use NOCASE collation', async () => {
  db.exec(
    'CREATE TABLE case_rows(id TEXT PRIMARY KEY NOT NULL,value TEXT COLLATE NOCASE,count INTEGER,binary BLOB)'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const casePolicy = { ...policy, schema: { ...policy.schema, table: 'case_rows' } };
  const target = await SqliteRestoreTarget.open(input());
  const original = row.replace('日本語', 'Original');
  await target.writeRow(casePolicy, manifest, original);
  db.exec("UPDATE case_rows SET value='original'");
  await expect(target.verifyRow(casePolicy, manifest, original)).rejects.toThrow();
  expect(db.prepare('SELECT value FROM case_rows').get()?.value).toBe('original');
});

it('seals idempotently after response loss and allows readback takeover without reopening writes', async () => {
  const options = input();
  const execute = options.database.execute;
  let lost = false;
  options.database.execute = async (sql, params) => {
    const result = await execute(sql, params);
    if (!lost && sql.startsWith("UPDATE tenant_backup_restore_targets SET state='sealed'")) {
      lost = true;
      throw new Error('seal_response_lost');
    }
    return result;
  };
  const writer = await SqliteRestoreTarget.open(options);
  await writer.writeRow(policy, manifest, row);
  await expect(writer.seal()).rejects.toThrow('seal_response_lost');
  await writer.seal();
  await expect(writer.writeRow(policy, manifest, row)).rejects.toThrow();
  await expect(SqliteRestoreTarget.open(input(2))).rejects.toThrow();
  const reader = await SqliteRestoreTarget.open({ ...input(2), mode: 'verify' });
  await reader.verifyRow(policy, manifest, row);
  await reader.verifyDataset(policy, 1);
  await expect(reader.writeRow(policy, manifest, row)).rejects.toThrow();
  await expect(writer.seal()).rejects.toThrow();
  expect(db.prepare('SELECT state FROM tenant_backup_restore_targets').get()?.state).toBe('sealed');
  expect(() => db.exec("UPDATE tenant_backup_restore_targets SET state='loading'")).toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM writes').get()?.n).toBe(1);
});

it('requires an existing sealed target for final verification and does not initialize through sealing', async () => {
  await expect(SqliteRestoreTarget.open({ ...input(), mode: 'verify' })).rejects.toThrow();
  await expect(SqliteRestoreTarget.open({ ...input(), mode: 'seal' })).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(0);
  await SqliteRestoreTarget.open(input());
  await expect(SqliteRestoreTarget.open({ ...input(), mode: 'verify' })).rejects.toThrow();
  const sealer = await SqliteRestoreTarget.open({ ...input(), mode: 'seal' });
  await expect(sealer.writeRow(policy, manifest, row)).rejects.toThrow();
  await sealer.seal();
  const reader = await SqliteRestoreTarget.open({ ...input(2), mode: 'verify' });
  await reader.verifyDataset(policy, 0);
});
