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
let batchCalls: number;
let aggregateVerifyCalls: number;
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
        if (sql.includes('SELECT COUNT(*) AS matches')) aggregateVerifyCalls++;
        return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
      },
      async execute(sql: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
        };
      },
      async batch(statements: { sql: string; params?: unknown[] }[]) {
        batchCalls++;
        db.exec('BEGIN');
        try {
          const results = statements.map(({ sql, params = [] }) => ({
            success: true,
            rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
          }));
          db.exec('COMMIT');
          return results;
        } catch (cause) {
          db.exec('ROLLBACK');
          throw cause;
        }
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
  batchCalls = 0;
  aggregateVerifyCalls = 0;
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
    'CREATE TABLE tenants(id TEXT NOT NULL PRIMARY KEY,value TEXT,count INTEGER,binary BLOB); CREATE TABLE audit_entries(tenant_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(tenant_id,id)); CREATE TABLE writes(id TEXT); CREATE TRIGGER writes_once AFTER INSERT ON tenants BEGIN INSERT INTO writes VALUES(NEW.id); END'
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
it('writes multiple restore rows with one atomic database batch', async () => {
  db.exec(
    'CREATE TABLE batch_rows(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,value TEXT NOT NULL)'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const batchPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.batch_rows' },
    schema: {
      table: 'batch_rows',
      columns: ['id', 'tenant_id', 'value'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
  };
  const batchManifest = { ...manifest, datasets: [batchPolicy.dataset] };
  const target = await SqliteRestoreTarget.open(input());
  await target.writeRows(batchPolicy, batchManifest, [
    '{"id":["text","one"],"tenant_id":["text","a"],"value":["text","first"]}',
    '{"id":["text","two"],"tenant_id":["text","a"],"value":["text","second"]}',
  ]);
  expect(batchCalls).toBe(1);
  expect(db.prepare('SELECT id,value FROM batch_rows ORDER BY id').all()).toEqual([
    { id: 'one', value: 'first' },
    { id: 'two', value: 'second' },
  ]);
  const sealer = await SqliteRestoreTarget.open({ ...input(2), mode: 'seal' });
  await sealer.seal();
  const verifier = await SqliteRestoreTarget.open({ ...input(3), mode: 'verify' });
  await verifier.verifyRows(batchPolicy, batchManifest, [
    '{"id":["text","one"],"tenant_id":["text","a"],"value":["text","first"]}',
    '{"id":["text","two"],"tenant_id":["text","a"],"value":["text","second"]}',
  ]);
  expect(aggregateVerifyCalls).toBe(1);
});

it('atomically removes restore-generated outbox rows before final verification', async () => {
  db.exec(
    'CREATE TABLE generated_outbox(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,value TEXT NOT NULL)'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const outboxPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.generated_outbox' },
    schema: {
      table: 'generated_outbox',
      columns: ['id', 'tenant_id', 'value'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    restoreReconcilesGeneratedRows: true,
    restoreHold: {
      id: 'test-hold',
      async shouldHold() {
        return false;
      },
      async write() {},
      async verify() {},
    },
  };
  const outboxManifest = { ...manifest, datasets: [outboxPolicy.dataset] };
  const expected = '{"id":["text","source"],"tenant_id":["text","a"],"value":["text","done"]}';
  const target = await SqliteRestoreTarget.open(input());
  db.exec(
    "INSERT INTO generated_outbox VALUES ('source','a','done'),('restore-generated','a','pending')"
  );

  await target.reconcileGeneratedRows(outboxPolicy, outboxManifest, [expected]);

  expect(batchCalls).toBe(1);
  expect(db.prepare('SELECT * FROM generated_outbox').all()).toEqual([
    { id: 'source', tenant_id: 'a', value: 'done' },
  ]);
});

it('writes dependency-ordered rows from multiple tables with one atomic database batch', async () => {
  db.exec(
    'CREATE TABLE batch_parent(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL); CREATE TABLE batch_child(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,parent_id TEXT NOT NULL REFERENCES batch_parent(id))'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const parent: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.batch_parent' },
    schema: {
      table: 'batch_parent',
      columns: ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
  };
  const child: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.batch_child' },
    schema: {
      table: 'batch_child',
      columns: ['id', 'tenant_id', 'parent_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
  };
  const batchManifest = { ...manifest, datasets: [parent.dataset, child.dataset] };
  const target = await SqliteRestoreTarget.open(input());
  await target.writeDatasetRows([
    {
      policy: parent,
      manifest: batchManifest,
      rowJsons: ['{"id":["text","parent"],"tenant_id":["text","a"]}'],
    },
    {
      policy: child,
      manifest: batchManifest,
      rowJsons: ['{"id":["text","child"],"tenant_id":["text","a"],"parent_id":["text","parent"]}'],
    },
  ]);
  expect(batchCalls).toBe(1);
  expect(db.prepare('SELECT parent_id FROM batch_child').get()).toEqual({ parent_id: 'parent' });
});

it('verifies multiple empty tenant datasets in one target window', async () => {
  db.exec(
    'CREATE TABLE empty_one(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL); CREATE TABLE empty_two(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL)'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const policies = ['empty_one', 'empty_two'].map(
    (table): SqliteDatasetInspectionPolicy => ({
      ...policy,
      dataset: { ...policy.dataset, id: `core.${table}` },
      schema: {
        table,
        columns: ['id', 'tenant_id'],
        primaryKey: ['id'],
        uniqueKeys: [],
        tenantColumn: 'tenant_id',
      },
    })
  );
  const target = await SqliteRestoreTarget.open(input());
  await expect(target.verifyEmptyDatasets(policies)).resolves.toBeUndefined();
  db.prepare('INSERT INTO empty_two(id,tenant_id) VALUES (?,?)').run('row', 'a');
  await expect(target.verifyEmptyDatasets(policies)).rejects.toThrow(
    'backup_restore_target_rejected'
  );
});
it('verifies wide rows in primary-key-pinned chunks below the D1 parameter limit', async () => {
  const valueColumns = Array.from({ length: 70 }, (_, index) => `value_${index}`);
  db.exec(
    `CREATE TABLE wide_rows(id TEXT NOT NULL PRIMARY KEY,${valueColumns
      .map((column) => `"${column}" TEXT`)
      .join(',')})`
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const widePolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    schema: {
      ...policy.schema,
      table: 'wide_rows',
      columns: ['id', ...valueColumns],
      primaryKey: ['id'],
    },
  };
  const wideRow = JSON.stringify(
    Object.fromEntries([
      ['id', ['text', 'a']],
      ...valueColumns.map((column, index) => [column, ['text', `value-${index}`]]),
    ])
  );
  const options = input();
  const queryOne = options.database.queryOne;
  options.database.queryOne = async (sql, params = []) => {
    if (params.length > 100) throw new Error('d1_parameter_limit');
    return queryOne(sql, params);
  };
  const target = await SqliteRestoreTarget.open(options);
  await target.writeRow(widePolicy, manifest, wideRow);
  await target.verifyRow(widePolicy, manifest, wideRow);
  expect(db.prepare('SELECT value_69 FROM wide_rows WHERE id=?').get('a')).toEqual({
    value_69: 'value-69',
  });
});
it('replaces an identity only for a policy bound to the pinned installed seed', async () => {
  db.prepare('INSERT INTO tenants VALUES (?,?,?,?)').run('a', 'installed', 1, new Uint8Array());
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const target = await SqliteRestoreTarget.open(input());
  const seedPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreReplacesInstalledSeedRows: true,
    identityAliases: {
      id: 'seed-alias-v1',
      aliases: (_row, recordIdentity) => [{ ...recordIdentity, id: 'installed-alias' }],
    },
  };
  await target.writeRow(seedPolicy, manifest, row);
  await target.writeRow(seedPolicy, manifest, row);
  expect(
    db.prepare('SELECT value,CAST(count AS TEXT) AS exact,hex(binary) AS binary FROM tenants').get()
  ).toEqual({ value: '日本語', exact: '9007199254740993', binary: '00FF' });
  expect(db.prepare('SELECT count(*) AS n FROM writes').get()?.n).toBe(1);
});
it('preserves target-owned seed columns and refuses to synthesize a missing seed row', async () => {
  db.prepare('INSERT INTO tenants VALUES (?,?,?,?)').run('a', 'installed', 1, new Uint8Array());
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const seedPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreReplacesInstalledSeedRows: true,
    verificationIgnoredColumns: ['value'],
    restorePreservedSeedColumns: ['value'],
    restoreTransform: {
      id: 'preserve-target-seed-v1',
      transform: async (_context, rowJson) => rowJson,
    },
  };
  const target = await SqliteRestoreTarget.open(input());
  await target.writeRow(seedPolicy, manifest, row);
  expect(
    db.prepare('SELECT value,CAST(count AS TEXT) AS exact,hex(binary) AS binary FROM tenants').get()
  ).toEqual({ value: 'installed', exact: '9007199254740993', binary: '00FF' });

  db.prepare("DELETE FROM tenants WHERE id='a'").run();
  await expect(target.writeRow(seedPolicy, manifest, row)).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()).toEqual({ n: 0 });
});
it('batches a fully target-owned seed as a verified no-op', async () => {
  db.prepare('INSERT INTO tenants VALUES (?,?,?,?)').run('a', 'installed', 1, new Uint8Array());
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const seedPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreReplacesInstalledSeedRows: true,
    verificationIgnoredColumns: ['value', 'count', 'binary'],
    restorePreservedSeedColumns: ['value', 'count', 'binary'],
    restoreTransform: {
      id: 'fully-target-owned-seed-v1',
      transform: async (_context, rowJson) => rowJson,
    },
  };
  const target = await SqliteRestoreTarget.open(input());
  await target.writeRows(seedPolicy, manifest, [row]);
  await target.verifyRows(seedPolicy, manifest, [row]);
  expect(db.prepare('SELECT value FROM tenants WHERE id=?').get('a')).toEqual({
    value: 'installed',
  });

  db.prepare("DELETE FROM tenants WHERE id='a'").run();
  await target.writeRows(seedPolicy, manifest, [row]);
  await expect(target.verifyRows(seedPolicy, manifest, [row])).rejects.toThrow();
});
it('accepts target-local settings projection completion during loading verification', async () => {
  db.exec(
    'CREATE TABLE tenant_settings_documents(id TEXT NOT NULL PRIMARY KEY,projection_state TEXT NOT NULL,projected_at INTEGER,body TEXT NOT NULL)'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const settingsPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'admin.tenant_settings_documents' },
    schema: {
      table: 'tenant_settings_documents',
      columns: ['id', 'projection_state', 'projected_at', 'body'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'id',
    },
  };
  const settingsManifest: TenantBundleManifest = {
    ...manifest,
    datasets: [settingsPolicy.dataset],
  };
  const settingsRow = JSON.stringify({
    id: ['text', 'a'],
    projection_state: ['text', 'pending'],
    projected_at: ['null', null],
    body: ['text', 'source'],
  });
  const target = await SqliteRestoreTarget.open(input());
  await target.writeRows(settingsPolicy, settingsManifest, [settingsRow]);
  db.prepare(
    "UPDATE tenant_settings_documents SET projection_state='applied',projected_at=200 WHERE id='a'"
  ).run();
  await target.verifyRows(settingsPolicy, settingsManifest, [settingsRow]);
  db.prepare("UPDATE tenant_settings_documents SET body='changed' WHERE id='a'").run();
  await expect(
    target.verifyRows(settingsPolicy, settingsManifest, [settingsRow])
  ).rejects.toThrow();
});
it('keeps the installed tenant isolation policy while restoring tenant settings', async () => {
  db.exec(
    "CREATE TABLE placement_tenants(id TEXT NOT NULL PRIMARY KEY,name TEXT NOT NULL,isolation_policy TEXT NOT NULL); INSERT INTO placement_tenants VALUES ('a','installed','tenant_exclusive')"
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const placementPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    schema: {
      ...policy.schema,
      table: 'placement_tenants',
      columns: ['id', 'name', 'isolation_policy'],
      primaryKey: ['id'],
    },
    restoreReplacesInstalledSeedRows: true,
    verificationIgnoredColumns: ['isolation_policy'],
    restorePreservedSeedColumns: ['isolation_policy'],
  };
  const target = await SqliteRestoreTarget.open(input());
  await target.writeRow(
    placementPolicy,
    manifest,
    JSON.stringify({
      id: ['text', 'a'],
      name: ['text', 'restored'],
      isolation_policy: ['text', 'shared_pool'],
    })
  );
  expect(db.prepare('SELECT name,isolation_policy FROM placement_tenants').get()).toEqual({
    name: 'restored',
    isolation_policy: 'tenant_exclusive',
  });
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

it('keeps destination-generated log rows while settings still require exact cardinality', async () => {
  const target = await SqliteRestoreTarget.open(input());
  const auditPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'admin.audit_entries', kind: 'audit' },
    schema: {
      table: 'audit_entries',
      columns: ['tenant_id', 'id'],
      primaryKey: ['tenant_id', 'id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
  };
  db.exec("INSERT INTO audit_entries VALUES ('a','from-backup'),('a','restore-generated')");

  await target.verifyDataset(auditPolicy, 1);
  await expect(
    target.verifyDataset(
      { ...auditPolicy, dataset: { ...auditPolicy.dataset, kind: 'settings' } },
      1
    )
  ).rejects.toThrow('backup_restore_target_rejected');
  await expect(target.verifyDataset(auditPolicy, 3)).rejects.toThrow(
    'backup_restore_target_rejected'
  );
  await target.verifyDataset(
    {
      ...auditPolicy,
      dataset: { ...auditPolicy.dataset, kind: 'admin' },
      restoreAllowsAdditionalRows: true,
    },
    1
  );
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
  const options = input();
  const execute = options.database.execute;
  let loseSidecarResponse = true;
  options.database.execute = async (sql, params) => {
    const result = await execute(sql, params);
    if (loseSidecarResponse && sql.startsWith('UPDATE "tenants" SET "value"=')) {
      loseSidecarResponse = false;
      throw new Error('sidecar_response_lost');
    }
    return result;
  };
  const target = await SqliteRestoreTarget.open(options);
  const sidecarPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreOverrides: { value: ['null', null] },
    verificationIgnoredColumns: ['value'],
  };
  await target.writeRow(sidecarPolicy, manifest, row);
  expect(db.prepare('SELECT value FROM tenants').get()).toEqual({ value: null });
  await expect(
    target.writeSidecarText(
      sidecarPolicy,
      manifest,
      row,
      'value',
      'reencrypted',
      async (stored) => stored === 'reencrypted'
    )
  ).rejects.toThrow('sidecar_response_lost');
  await target.writeSidecarText(
    sidecarPolicy,
    manifest,
    row,
    'value',
    'different-random-ciphertext',
    async (stored) => stored === 'reencrypted'
  );
  await target.verifyRow(sidecarPolicy, manifest, row);
  await target.seal();
  const verifier = await SqliteRestoreTarget.open({ ...input(2), mode: 'verify' });
  await verifier.verifySidecarValue(
    sidecarPolicy,
    manifest,
    row,
    'value',
    async (stored) => stored === 'reencrypted'
  );
  db.exec('UPDATE tenants SET count=1');
  await expect(verifier.verifyRow(sidecarPolicy, manifest, row)).rejects.toThrow();
});

it('moves a NOT NULL integer sidecar from its exact placeholder with response-loss safety', async () => {
  const options = input();
  const execute = options.database.execute;
  let loseSidecarResponse = true;
  options.database.execute = async (sql, params) => {
    const result = await execute(sql, params);
    if (loseSidecarResponse && sql.startsWith('UPDATE "tenants" SET "count"=')) {
      loseSidecarResponse = false;
      throw new Error('sidecar_response_lost');
    }
    return result;
  };
  const target = await SqliteRestoreTarget.open(options);
  const sidecarPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreOverrides: { count: ['integer', '1'] },
    verificationIgnoredColumns: ['count'],
  };
  await target.writeRow(sidecarPolicy, manifest, row);
  expect(db.prepare('SELECT count FROM tenants').get()).toEqual({ count: 1 });
  await expect(
    target.writeSidecarValue(
      sidecarPolicy,
      manifest,
      row,
      'count',
      ['integer', '7'],
      async (stored) => stored[0] === 'integer' && stored[1] === '7'
    )
  ).rejects.toThrow('sidecar_response_lost');
  await target.writeSidecarValue(
    sidecarPolicy,
    manifest,
    row,
    'count',
    ['integer', '8'],
    async (stored) => stored[0] === 'integer' && stored[1] === '7'
  );
  expect(db.prepare('SELECT count FROM tenants').get()).toEqual({ count: 7 });
  await target.verifyRow(sidecarPolicy, manifest, row);
  await target.seal();
  const verifier = await SqliteRestoreTarget.open({ ...input(2), mode: 'verify' });
  await verifier.verifySidecarTypedValue(
    sidecarPolicy,
    manifest,
    row,
    'count',
    async (stored) => stored[0] === 'integer' && stored[1] === '7'
  );
});

it('rejects restore overrides for identity columns', async () => {
  const target = await SqliteRestoreTarget.open(input());
  await expect(
    target.writeRow({ ...policy, restoreOverrides: { id: ['text', 'other'] } }, manifest, row)
  ).rejects.toThrow();
  await expect(
    target.writeRow(
      {
        ...policy,
        tenantKey: 'authrim-portable-tenant-v1',
        restoreTenantKey: 'other',
        restoreIdentityOverrides: { id: ['text', 'other'] },
      },
      manifest,
      row
    )
  ).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenants').get()).toEqual({ n: 0 });
});

it('rekeys an installed tenant-key primary key and verifies the target ownership', async () => {
  db.exec(
    'CREATE TABLE log_index(tenant_key TEXT NOT NULL,record_id TEXT NOT NULL,value TEXT,PRIMARY KEY(tenant_key,record_id))'
  );
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const keyPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    schema: {
      table: 'log_index',
      columns: ['tenant_key', 'record_id', 'value'],
      primaryKey: ['tenant_key', 'record_id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_key',
      tenantIdentity: 'tenantKey',
    },
    tenantKey: 'authrim-portable-tenant-v1',
    restoreTenantKey: 'target-key',
    restoreIdentityOverrides: { tenant_key: ['text', 'target-key'] },
  };
  const keyRow = JSON.stringify({
    tenant_key: ['text', 'authrim-portable-tenant-v1'],
    record_id: ['text', 'record-a'],
    value: ['text', 'value-a'],
  });
  const target = await SqliteRestoreTarget.open(input());
  await expect(
    target.writeRow(
      keyPolicy,
      manifest,
      keyRow.replace('authrim-portable-tenant-v1', 'source-environment-key')
    )
  ).rejects.toThrow();
  await target.writeRow(keyPolicy, manifest, keyRow);
  await target.writeRow(keyPolicy, manifest, keyRow);
  expect(db.prepare('SELECT * FROM log_index').all()).toEqual([
    { tenant_key: 'target-key', record_id: 'record-a', value: 'value-a' },
  ]);
  await target.seal();
  const verifier = await SqliteRestoreTarget.open({ ...input(2), mode: 'verify' });
  await verifier.verifyRow(keyPolicy, manifest, keyRow);
  await verifier.verifyDataset(keyPolicy, 1);
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

it('verifies R2-finalized catalog fields through the R2 receipt and stable SQLite fields on readback', async () => {
  db.exec(`CREATE TABLE log_object_catalog(
    id TEXT NOT NULL PRIMARY KEY,
    tenant_key TEXT NOT NULL,
    object_key TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    status TEXT NOT NULL
  )`);
  identity.seedFingerprint = await readSqliteRestoreSeedFingerprint(
    input().database,
    async () => {}
  );
  const catalogPolicy: SqliteDatasetInspectionPolicy = {
    dataset: {
      id: 'admin.log_object_catalog',
      module: 'logs',
      kind: 'log_dependencies',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
    schema: {
      table: 'log_object_catalog',
      columns: ['id', 'tenant_key', 'object_key', 'checksum_sha256', 'status'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_key',
      tenantIdentity: 'tenantKey',
    },
    tenantKey: 'tenant-key-a',
    async inspectRow() {
      return [];
    },
  };
  const catalogManifest = {
    ...manifest,
    selection: {
      ...manifest.selection,
      artifacts: true,
      logs: { audit: true, other: true, sensitive: true, period: 'all' as const },
    },
    datasets: [catalogPolicy.dataset],
  };
  const catalogRow = JSON.stringify({
    id: ['text', 'object-a'],
    tenant_key: ['text', 'tenant-key-a'],
    object_key: ['text', 'source-key'],
    checksum_sha256: ['text', 'a'.repeat(64)],
    status: ['text', 'committed'],
  });
  const writer = await SqliteRestoreTarget.open(input());
  await writer.writeRow(catalogPolicy, catalogManifest, catalogRow);
  db.exec(
    `UPDATE log_object_catalog SET object_key='restored-key',checksum_sha256='${'b'.repeat(64)}'`
  );
  await expect(writer.verifyRow(catalogPolicy, catalogManifest, catalogRow)).rejects.toThrow();
  await writer.seal();
  const reader = await SqliteRestoreTarget.open({ ...input(2), mode: 'verify' });
  await reader.verifyRow(catalogPolicy, catalogManifest, catalogRow);
  db.exec("UPDATE log_object_catalog SET status='deleted'");
  await expect(reader.verifyRow(catalogPolicy, catalogManifest, catalogRow)).rejects.toThrow();
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
