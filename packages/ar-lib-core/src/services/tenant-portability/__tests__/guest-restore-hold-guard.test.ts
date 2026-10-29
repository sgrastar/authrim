import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TenantBundleManifest } from '../bundle-manifest';
import type { SqliteDatasetInspectionPolicy } from '../sqlite-dataset-inspector';
import { SqliteRestoreTarget } from '../sqlite-restore-target';
import { loadGuestRestoreHoldGuards } from '../guest-restore-hold-guard';
import {
  guestDeletionReceiptFixture,
  GUEST_TEST_TENANT,
} from '../../__tests__/guest-deletion-receipt-fixture';

let db: DatabaseSync;
let primaryReads: number;
let maxBinds: number;
let beforeBatch: (() => void) | undefined;
let failReadback: boolean;
const text = (value: string) => ['text', value] as const;
const identity = {
  id: 'target',
  tenantId: GUEST_TEST_TENANT,
  operationId: 'import',
  resourceId: 'core',
  planDigest: 'a'.repeat(64),
  seedFingerprint: 'b'.repeat(64),
};
const policy: SqliteDatasetInspectionPolicy = {
  dataset: {
    id: 'core.legal_holds',
    module: 'users',
    kind: 'users',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  },
  schema: {
    table: 'legal_holds',
    columns: ['id', 'tenant_id', 'subject_type', 'subject_id', 'state'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'tenant_id',
  },
  inspectRow: async () => [],
};
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: {
    tenantId: GUEST_TEST_TENANT,
    issuer: 'https://fixture.example',
    productVersion: '0.4.2',
  },
  selection: {
    settings: false,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' },
  },
  snapshotId: 'snapshot',
  boundaryUnixMs: 1,
  inventoryDigestSha256: 'c'.repeat(64),
  datasets: [policy.dataset],
};
function hold(id: string, accountId: string) {
  return JSON.stringify({
    id: text(id),
    tenant_id: text(GUEST_TEST_TENANT),
    subject_type: text('account'),
    subject_id: text(accountId),
    state: text('active'),
  });
}
function seed(number = 1) {
  const receipt = guestDeletionReceiptFixture();
  if (number !== 1) {
    const suffix = String(number).padStart(12, '0');
    receipt.userId = `10000000-0000-4000-8000-${suffix}`;
    receipt.accountId = `20000000-0000-4000-8000-${suffix}`;
    receipt.operationId += number;
  }
  db.prepare(`INSERT INTO identity_accounts VALUES(?,?,?,'user','guest',1)`).run(
    receipt.accountId,
    GUEST_TEST_TENANT,
    receipt.userId
  );
  db.prepare(`INSERT INTO guest_account_lifecycle VALUES(?,?,'deleting',1,?,?,1)`).run(
    GUEST_TEST_TENANT,
    receipt.userId,
    receipt.operationId,
    JSON.stringify(receipt)
  );
  return receipt;
}
function database() {
  const binds = (params: unknown[]) => {
    maxBinds = Math.max(maxBinds, params.length);
  };
  return {
    async query<T>(sql: string, params: unknown[] = [], options?: { consistencyClass?: string }) {
      expect(options?.consistencyClass).toBe('primary_required');
      primaryReads++;
      binds(params);
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      if (failReadback && sql.startsWith('SELECT COUNT(*) AS matches'))
        throw new Error('primary_read_unavailable');
      binds(params);
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      binds(params);
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
    async batch(statements: { sql: string; params?: unknown[] }[]) {
      beforeBatch?.();
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => {
          binds(params);
          return {
            success: true,
            rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
          };
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
async function target() {
  return SqliteRestoreTarget.open({
    database: database(),
    identity,
    lease: { owner: 'worker', fencingToken: 1, expiresAt: 1000 },
    now: () => 10,
    authorize: async () => {},
    readSeedFingerprint: async () => identity.seedFingerprint,
  });
}
beforeEach(() => {
  primaryReads = 0;
  maxBinds = 0;
  beforeBatch = undefined;
  failReadback = false;
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE identity_accounts(id TEXT PRIMARY KEY,tenant_id TEXT,legacy_user_id TEXT,
    account_type TEXT,registration_state TEXT,account_route_generation INTEGER);
    CREATE TABLE guest_account_lifecycle(tenant_id TEXT,user_id TEXT,phase TEXT,revision INTEGER,
      deletion_operation_id TEXT,deletion_route_json TEXT,deletion_started_at_ms INTEGER,
      PRIMARY KEY(tenant_id,user_id));
    CREATE TABLE legal_holds(id TEXT PRIMARY KEY,tenant_id TEXT,subject_type TEXT,subject_id TEXT,state TEXT);
    CREATE TABLE tenant_backup_restore_targets(id TEXT PRIMARY KEY,tenant_id TEXT,operation_id TEXT,
      resource_id TEXT,plan_digest TEXT,seed_fingerprint TEXT,owner TEXT,fencing_token INTEGER,
      lease_expires_at INTEGER,state TEXT);`);
});
afterEach(() => db.close());

it('restores a hold on the same exact accepted receipt, including an exact retry', async () => {
  const receipt = seed();
  const destination = await target();
  const row = hold('hold', receipt.accountId);
  await destination.writeRow(policy, manifest, row);
  await destination.writeRow(policy, manifest, row);
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(1);
});

it('rejects a boundary committed after the primary read and never accepts an old exact hold row', async () => {
  const receipt = seed();
  const destination = await target();
  const row = hold('hold', receipt.accountId);
  await destination.writeRow(policy, manifest, row);
  beforeBatch = () => db.prepare('UPDATE guest_account_lifecycle SET revision=revision+1').run();
  await expect(destination.writeRows(policy, manifest, [row])).rejects.toThrow(
    'backup_restore_target_rejected'
  );
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(1);
});

it('does not create a hold when the accepted receipt changes before its INSERT', async () => {
  const receipt = seed();
  const destination = await target();
  beforeBatch = () =>
    db.prepare("UPDATE guest_account_lifecycle SET phase='deleted',revision=revision+1").run();
  await expect(
    destination.writeRows(policy, manifest, [hold('hold', receipt.accountId)])
  ).rejects.toThrow('backup_restore_target_rejected');
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(0);
});

it('takes only twelve primary snapshot queries for 500 distinct accepted owners', async () => {
  const rows = Array.from({ length: 500 }, (_, index) => {
    const receipt = seed(index + 1);
    return hold(`hold-${index}`, receipt.accountId);
  });
  const destination = await target();
  await destination.writeRows(policy, manifest, rows);
  expect(primaryReads).toBe(12);
  expect(maxBinds).toBeLessThanOrEqual(99);
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(500);
});

it('rejects malformed, foreign, started and mismatched-generation receipts before target effects', async () => {
  const receipt = seed();
  const destination = await target();
  const row = hold('hold', receipt.accountId);
  for (const changed of [
    { ...receipt, extra: true },
    { ...receipt, accountRouteGeneration: 2 },
    { ...receipt, tenantId: 'foreign' },
    {
      ...receipt,
      execution: { phase: 'erasure_started', boundaryId: 'a'.repeat(64), erasureStartedAtMs: 5 },
    },
  ]) {
    db.prepare('UPDATE guest_account_lifecycle SET deletion_route_json=?').run(
      JSON.stringify(changed)
    );
    await expect(destination.writeRow(policy, manifest, row)).rejects.toThrow();
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(0);
});

it('does not infer an accepted owner from missing primary rows or another tenant', async () => {
  const receipt = guestDeletionReceiptFixture();
  await expect(
    loadGuestRestoreHoldGuards(database(), GUEST_TEST_TENANT, [
      {
        table: 'legal_holds',
        rowJson: hold('hold', receipt.accountId),
      },
    ]).then((guard) => guard('legal_holds', hold('hold', receipt.accountId), []))
  ).rejects.toThrow();
  const foreign = JSON.parse(hold('hold', receipt.accountId)) as Record<string, unknown>;
  foreign.tenant_id = text('foreign');
  await expect(
    loadGuestRestoreHoldGuards(database(), GUEST_TEST_TENANT, [
      {
        table: 'legal_holds',
        rowJson: JSON.stringify(foreign),
      },
    ])
  ).rejects.toThrow();
});

it('preserves normal registered account holds without inventing a Guest lifecycle', async () => {
  const receipt = seed();
  db.exec(
    "DELETE FROM guest_account_lifecycle; UPDATE identity_accounts SET registration_state='registered'"
  );
  const destination = await target();
  await destination.writeRows(policy, manifest, [hold('registered-hold', receipt.accountId)]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(1);
});

it('requires positive primary readback after a committed insert and recovers the exact retry', async () => {
  const receipt = seed();
  const destination = await target();
  const row = hold('hold', receipt.accountId);
  failReadback = true;
  await expect(destination.writeRows(policy, manifest, [row])).rejects.toThrow(
    'primary_read_unavailable'
  );
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(1);
  failReadback = false;
  await destination.writeRows(policy, manifest, [row]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(1);
});

it('does not fall back to concurrent per-row writes for an active hold batch', async () => {
  const receipt = seed();
  const source = database();
  const withoutBatch = {
    query: <T>(sql: string, params: unknown[] = [], options?: { consistencyClass?: string }) =>
      source.query<T>(sql, params, options),
    queryOne: <T>(sql: string, params: unknown[] = []) => source.queryOne<T>(sql, params),
    execute: (sql: string, params: unknown[] = []) => source.execute(sql, params),
  };
  const destination = await SqliteRestoreTarget.open({
    database: withoutBatch,
    identity,
    lease: { owner: 'worker', fencingToken: 1, expiresAt: 1000 },
    now: () => 10,
    authorize: async () => {},
    readSeedFingerprint: async () => identity.seedFingerprint,
  });
  await expect(
    destination.writeRows(policy, manifest, [hold('hold', receipt.accountId)])
  ).rejects.toThrow('backup_restore_target_rejected');
  expect(db.prepare('SELECT COUNT(*) AS n FROM legal_holds').get()?.n).toBe(0);
});

it('keeps same-store exact terminal marker merges idempotent without advancing the source epoch', async () => {
  db.exec(`CREATE TABLE guest_pii_mutation_epoch(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);INSERT INTO guest_pii_mutation_epoch VALUES(1,7);
    CREATE TABLE guest_pii_erasure_markers(schema_version INTEGER,tenant_id TEXT,user_id TEXT,account_id TEXT,account_route_generation INTEGER,state TEXT,revision INTEGER,operation_id TEXT,boundary_id TEXT,source_started_at_ms INTEGER,permit_table TEXT,permit_keys_json TEXT,PRIMARY KEY(tenant_id,user_id));`);
  const marker = {
    schema_version: 1,
    tenant_id: identity.tenantId,
    user_id: 'erased-user',
    account_id: 'erased-account',
    account_route_generation: 2,
    state: 'deleted',
    revision: 4,
    operation_id: null,
    boundary_id: null,
    source_started_at_ms: null,
    permit_table: null,
    permit_keys_json: null,
  } as const;
  db.prepare('INSERT INTO guest_pii_erasure_markers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    ...Object.values(marker)
  );
  db.exec(
    "CREATE TRIGGER immutable_duplicate BEFORE INSERT ON guest_pii_erasure_markers WHEN EXISTS(SELECT 1 FROM guest_pii_erasure_markers WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'guest_pii_marker_identity_conflict'); END"
  );
  const destination = await target();
  await destination.mergeCurrentGuestDeletedMarkers([marker]);
  await destination.mergeCurrentGuestDeletedMarkers([marker]);
  expect(db.prepare('SELECT revision FROM guest_pii_mutation_epoch').get()).toEqual({
    revision: 7,
  });
  expect(db.prepare('SELECT * FROM guest_pii_erasure_markers').all()).toEqual([marker]);
  await expect(
    destination.mergeCurrentGuestDeletedMarkers([{ ...marker, revision: 3 }])
  ).rejects.toThrow();
  expect(db.prepare('SELECT * FROM guest_pii_erasure_markers').all()).toEqual([marker]);
});
