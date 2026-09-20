import { startTenantBackupSnapshotBoundary } from '../snapshot-boundary';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupMutationAdmission } from '../mutation-admission';
import { TenantBackupBoundaryReceipts } from '../boundary-receipts';
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let admission: TenantBackupMutationAdmission;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/control/d1/005_tenant_backup_mutation_admission.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/control/d1/006_tenant_backup_mutation_environment_scope.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/control/d1/007_tenant_backup_boundary_receipts.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/control/d1/010_tenant_backup_snapshot_timestamp.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/control/d1/011_tenant_backup_boundary_deadline.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  adapter = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  admission = new TenantBackupMutationAdmission(adapter);
});
afterEach(() => db.close());
const boundary = {
  id: 'boundary',
  tenantId: 'a',
  operationId: 'backup',
  inventoryDigest: 'ab'.repeat(32),
  now: 100,
};
it('backfills the former boundary timestamp when upgrading existing held and released rows', () => {
  const legacy = new DatabaseSync(':memory:');
  try {
    for (const file of [
      '005_tenant_backup_mutation_admission.sql',
      '006_tenant_backup_mutation_environment_scope.sql',
    ])
      legacy.exec(
        readFileSync(
          new URL(`../../../../../../migrations/control/d1/${file}`, import.meta.url),
          'utf8'
        )
      );
    const insert = legacy.prepare(
      `INSERT INTO tenant_backup_mutation_boundaries
       (id,tenant_id,operation_id,inventory_digest,state,created_at,deadline_at,released_at)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    insert.run('held', 'a', 'backup-a', 'ab'.repeat(32), 'held', 100, 2100, null);
    insert.run('released', 'b', 'backup-b', 'cd'.repeat(32), 'released', 200, 2200, 350);
    legacy.exec(
      readFileSync(
        new URL(
          '../../../../../../migrations/control/d1/010_tenant_backup_snapshot_timestamp.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    expect(
      legacy.prepare('SELECT id,held_at FROM tenant_backup_mutation_boundaries ORDER BY id').all()
    ).toEqual([
      { id: 'held', held_at: 100 },
      { id: 'released', held_at: 350 },
    ]);
  } finally {
    legacy.close();
  }
});
it('drains existing writers, excludes new writers, and isolates other tenants', async () => {
  expect(await admission.acquire('a', 'writer', 99)).toBe(true);
  expect((await admission.begin(boundary))?.deadline_at).toBe(5100);
  expect(await admission.acquire('a', 'new', 101)).toBe(false);
  expect(await admission.acquire('b', 'other', 101)).toBe(true);
  expect(await admission.acquire('a', 'writer', 101)).toBe(true);
  expect(await admission.hold('a', 'boundary', 102)).toBeNull();
  await admission.complete('b', 'writer', 102);
  expect(await admission.hold('a', 'boundary', 103)).toBeNull();
  await admission.complete('a', 'writer', 104);
  expect(await admission.hold('a', 'boundary', 105)).toMatchObject({ state: 'held', held_at: 105 });
  expect(await admission.acquire('a', 'new', 106)).toBe(false);
  expect(await admission.acquire('a', 'writer', 106)).toBe(false);
  await admission.abort('a', 'boundary', 107);
  expect(await admission.acquire('a', 'new', 108)).toBe(true);
  expect(await admission.hold('a', 'boundary', 109)).toBeNull();
});
it('never treats an unresolved permit as complete or extends a retried admission deadline', async () => {
  expect(await admission.acquire('a', 'unknown-completion', 1)).toBe(true);
  await admission.begin(boundary);
  const restarted = new TenantBackupMutationAdmission(adapter);
  expect((await restarted.begin({ ...boundary, now: 5099 }))?.deadline_at).toBe(5100);
  expect(await restarted.hold('a', 'boundary', 5100)).toBeNull();
  expect(await restarted.acquire('a', 'after-timeout', 5100)).toBe(true);
  expect(await restarted.begin({ ...boundary, now: 5101 })).toBeNull();
  expect((await restarted.begin({ ...boundary, id: 'retry-boundary', now: 5102 }))?.state).toBe(
    'draining'
  );
  await restarted.complete('a', 'after-timeout', 5103);
  expect(await restarted.hold('a', 'retry-boundary', 5104)).toBeNull();
  await restarted.complete('a', 'unknown-completion', 5105);
  expect((await restarted.hold('a', 'retry-boundary', 5106))?.state).toBe('held');
});
it('rejects overlapping attempts, changed identity and stale completion reuse', async () => {
  await admission.begin(boundary);
  expect(await admission.begin({ ...boundary, id: 'competing', now: 101 })).toBeNull();
  expect(
    await admission.begin({ ...boundary, inventoryDigest: 'cd'.repeat(32), now: 101 })
  ).toBeNull();
  await admission.abort('b', 'boundary', 102);
  expect(await admission.acquire('a', 'writer', 103)).toBe(false);
  await admission.abort('a', 'boundary', 104);
  expect(await admission.acquire('a', 'writer', 105)).toBe(true);
  await admission.complete('a', 'writer', 106);
  await admission.complete('a', 'writer', 107);
  expect(
    db.prepare('SELECT completed_at FROM tenant_backup_mutation_permits').get()?.completed_at
  ).toBe(106);
  expect(() => db.exec('UPDATE tenant_backup_mutation_permits SET completed_at=NULL')).toThrow();
  expect(await admission.acquire('a', 'writer', 108)).toBe(false);
});

it('recovers an uncertain permit acquisition without adding another active writer', async () => {
  let loseResponse = true;
  const uncertain = new TenantBackupMutationAdmission({
    ...adapter,
    async queryOne<T>(sql: string, params?: unknown[]) {
      const result = await adapter.queryOne<T>(sql, params);
      if (loseResponse && sql.startsWith('INSERT INTO tenant_backup_mutation_permits')) {
        loseResponse = false;
        throw new Error('lost response');
      }
      return result;
    },
  });
  await expect(uncertain.acquire('a', 'private-permit', 1)).rejects.toThrow('lost response');
  await admission.begin(boundary);
  expect(await new TenantBackupMutationAdmission(adapter).acquire('a', 'private-permit', 101)).toBe(
    true
  );
  expect(
    db
      .prepare('SELECT count(*) n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL')
      .get()?.n
  ).toBe(1);
  expect(await admission.hold('a', 'boundary', 102)).toBeNull();
  await admission.complete('a', 'private-permit', 103);
  expect((await admission.hold('a', 'boundary', 104))?.state).toBe('held');
});

it('drains shared writes for every tenant in the environment without blocking other environments', async () => {
  const first = new TenantBackupMutationAdmission(adapter, 'env-a');
  const other = new TenantBackupMutationAdmission(adapter, 'env-b');
  expect(await first.acquireEnvironment('shared-settings', 1)).toBe(true);
  await first.begin({ ...boundary, id: 'tenant-a-boundary' });
  await first.begin({ ...boundary, id: 'tenant-b-boundary', tenantId: 'b' });
  await other.begin({ ...boundary, id: 'other-environment' });
  expect(await first.hold('a', 'tenant-a-boundary', 101)).toBeNull();
  expect(await first.hold('b', 'tenant-b-boundary', 101)).toBeNull();
  expect((await other.hold('a', 'other-environment', 101))?.state).toBe('held');
  expect(await first.acquireEnvironment('new-shared-write', 102)).toBe(false);
  await other.completeEnvironment('shared-settings', 103);
  expect(await first.hold('a', 'tenant-a-boundary', 104)).toBeNull();
  await first.completeEnvironment('shared-settings', 105);
  expect((await first.hold('a', 'tenant-a-boundary', 106))?.state).toBe('held');
  expect((await first.hold('b', 'tenant-b-boundary', 106))?.state).toBe('held');
  await first.abort('a', 'tenant-a-boundary', 107);
  expect(await first.acquireEnvironment('new-shared-write', 108)).toBe(false);
  await first.abort('b', 'tenant-b-boundary', 109);
  expect(await first.acquireEnvironment('new-shared-write', 110)).toBe(true);
});

it('does not silently ignore unresolved permits created before environment scoping', async () => {
  await admission.acquire('legacy-tenant', 'legacy-writer', 1);
  const scoped = new TenantBackupMutationAdmission(adapter, 'env-a');
  await scoped.begin(boundary);
  expect(await scoped.hold('a', boundary.id, 101)).toBeNull();
  await admission.complete('legacy-tenant', 'legacy-writer', 102);
  expect((await scoped.hold('a', boundary.id, 103))?.state).toBe('held');
});

const receiptIdentity = {
  environmentId: 'legacy',
  tenantId: 'a',
  boundaryId: 'boundary',
  operationId: 'backup',
  inventoryDigest: 'ab'.repeat(32),
};
const participants = [
  { resourceId: 'core', snapshotId: 'core-snapshot' },
  { resourceId: 'pii', snapshotId: 'pii-snapshot' },
];
it('releases a frozen two-store boundary only after both receipts, including restart and lost responses', async () => {
  const receipts = new TenantBackupBoundaryReceipts(adapter);
  await admission.begin(boundary);
  expect(await receipts.plan(receiptIdentity, participants, 101)).toBe(true);
  expect(await receipts.plan(receiptIdentity, [...participants].reverse(), 102)).toBe(true);
  expect(await receipts.plan(receiptIdentity, participants.slice(0, 1), 103)).toBe(false);
  expect(await receipts.acknowledge(receiptIdentity, participants[0], 104)).toBe(false);
  await admission.hold('a', 'boundary', 105);
  expect(await receipts.release(receiptIdentity, 106)).toBeNull();
  expect(await receipts.acknowledge(receiptIdentity, participants[0], 107)).toBe(true);
  expect(await receipts.release(receiptIdentity, 108)).toBeNull();
  expect(await admission.acquire('a', 'blocked', 108)).toBe(false);
  const restarted = new TenantBackupBoundaryReceipts(adapter);
  expect(await restarted.acknowledge(receiptIdentity, participants[0], 109)).toBe(true);
  expect(await restarted.acknowledge(receiptIdentity, participants[1], 110)).toBe(true);
  expect((await restarted.release(receiptIdentity, 111))?.released_at).toBe(111);
  expect((await restarted.readReleased(receiptIdentity, participants, 112))?.held_at).toBe(105);
  expect((await restarted.release(receiptIdentity, 9999))?.released_at).toBe(111);
  expect(await admission.acquire('a', 'resumed', 112)).toBe(true);
  expect(() =>
    db.exec("UPDATE tenant_backup_mutation_boundaries SET released_at=112 WHERE id='boundary'")
  ).toThrow(/immutable/);
  expect(() =>
    db.exec("UPDATE tenant_backup_mutation_boundaries SET held_at=112 WHERE id='boundary'")
  ).toThrow(/held_at_invalid/);
});
it('rejects changed identities, unplanned snapshots, missing plans and late receipts or release', async () => {
  const receipts = new TenantBackupBoundaryReceipts(adapter);
  await admission.begin(boundary);
  expect(
    await receipts.plan({ ...receiptIdentity, environmentId: 'other' }, participants, 101)
  ).toBe(false);
  expect(await receipts.plan(receiptIdentity, participants, 101)).toBe(true);
  await admission.hold('a', 'boundary', 102);
  for (const identity of [
    { ...receiptIdentity, environmentId: 'other' },
    { ...receiptIdentity, tenantId: 'b' },
    { ...receiptIdentity, operationId: 'other' },
    { ...receiptIdentity, inventoryDigest: 'cd'.repeat(32) },
  ]) {
    expect(await receipts.acknowledge(identity, participants[0], 103)).toBe(false);
    expect(await receipts.release(identity, 104)).toBeNull();
  }
  expect(
    await receipts.acknowledge(receiptIdentity, { ...participants[0], snapshotId: 'other' }, 103)
  ).toBe(false);
  expect(
    await receipts.acknowledge(receiptIdentity, { resourceId: 'other', snapshotId: 'other' }, 103)
  ).toBe(false);
  expect(await receipts.acknowledge(receiptIdentity, participants[0], 104)).toBe(true);
  expect(await receipts.acknowledge(receiptIdentity, participants[1], 60100)).toBe(false);
  expect(await receipts.release(receiptIdentity, 60100)).toBeNull();
  expect(() =>
    db.exec(
      "UPDATE tenant_backup_mutation_boundaries SET state='released',released_at=110 WHERE id='boundary'"
    )
  ).toThrow(/incomplete/);
  expect(() => db.exec('DELETE FROM tenant_backup_boundary_receipts')).toThrow(/retained/);
  expect(() => db.exec("UPDATE tenant_backup_boundary_plans SET participants_json='[]'")).toThrow(
    /immutable/
  );
  await admission.begin({ ...boundary, id: 'no-plan', now: 60101 });
  await admission.hold('a', 'no-plan', 60102);
  expect(await receipts.release({ ...receiptIdentity, boundaryId: 'no-plan' }, 60103)).toBeNull();
  expect(() =>
    db.exec(
      "UPDATE tenant_backup_mutation_boundaries SET state='released',released_at=60103 WHERE id='no-plan'"
    )
  ).toThrow(/incomplete/);
});

it('does not release after deadline even with every receipt, or allow precompleted SQL insertion', async () => {
  const receipts = new TenantBackupBoundaryReceipts(adapter);
  await admission.begin(boundary);
  await receipts.plan(receiptIdentity, participants, 101);
  await admission.hold('a', 'boundary', 102);
  for (const participant of participants)
    await receipts.acknowledge(receiptIdentity, participant, 103);
  expect(await receipts.release(receiptIdentity, 60100)).toBeNull();
  expect(await admission.acquire('a', 'after-deadline', 60100)).toBe(true);
  await admission.abort('a', 'boundary', 60101);
  expect(await receipts.release(receiptIdentity, 60102)).toBeNull();
  expect(() =>
    db
      .prepare(
        `INSERT INTO tenant_backup_mutation_boundaries
    (id,tenant_id,operation_id,inventory_digest,state,created_at,deadline_at,released_at)
    VALUES ('forged','a','backup',?,'released',100,60100,101)`
      )
      .run('ab'.repeat(32))
  ).toThrow(/incomplete/);
});

it('coordinator waits for every participant and recovers a lost release without restarting stores', async () => {
  let starts = 0;
  let clock = 101;
  const receipts = new TenantBackupBoundaryReceipts(adapter);
  const input = {
    identity: receiptIdentity,
    admission,
    receipts,
    signal: new AbortController().signal,
    now: () => clock,
    async assertReady() {},
    participants: participants.map((participant) => ({
      ...participant,
      async start(assertHeld: () => Promise<void>, boundaryUnixMs: number) {
        await assertHeld();
        expect(boundaryUnixMs).toBe(101);
        starts++;
        expect(await admission.acquire('a', 'during-start', clock)).toBe(false);
      },
    })),
  };
  expect((await startTenantBackupSnapshotBoundary(input)).state).toBe('released');
  expect(starts).toBe(2);
  clock = 9999;
  expect(
    (
      await startTenantBackupSnapshotBoundary({
        ...input,
        receipts: new TenantBackupBoundaryReceipts(adapter),
      })
    ).released_at
  ).toBe(101);
  expect(starts).toBe(2);
  expect(await admission.acquire('a', 'after-start', clock)).toBe(true);
});
it('coordinator aborts incomplete attempts after all starts settle and never revives them', async () => {
  const receipts = new TenantBackupBoundaryReceipts(adapter);
  let settle: () => void = () => {};
  let entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const input = {
    identity: receiptIdentity,
    admission,
    receipts,
    signal: new AbortController().signal,
    now: () => 101,
    async assertReady() {},
    participants: [
      {
        ...participants[0],
        async start() {
          throw new Error('private source error');
        },
      },
      {
        ...participants[1],
        async start() {
          entered();
          await pending;
        },
      },
    ],
  };
  const operation = startTenantBackupSnapshotBoundary(input);
  const failure = expect(operation).rejects.toThrow('backup_snapshot_boundary_failed');
  await began;
  expect(
    db.prepare("SELECT state FROM tenant_backup_mutation_boundaries WHERE id='boundary'").get()
      ?.state
  ).toBe('held');
  settle();
  await failure;
  expect(
    db.prepare("SELECT state FROM tenant_backup_mutation_boundaries WHERE id='boundary'").get()
      ?.state
  ).toBe('aborted');
  expect(await admission.acquire('a', 'after-failure', 102)).toBe(true);
  await expect(startTenantBackupSnapshotBoundary(input)).rejects.toThrow(
    'backup_snapshot_boundary_failed'
  );
  expect(await receipts.readReleased(receiptIdentity, participants, 102)).toBeNull();
});
it('coordinator cannot admit while a writer is unresolved and rejects starts that run past deadline', async () => {
  const receipts = new TenantBackupBoundaryReceipts(adapter);
  let clock = 101;
  let starts = 0;
  const input = {
    identity: receiptIdentity,
    admission,
    receipts,
    signal: new AbortController().signal,
    now: () => clock,
    async assertReady() {},
    participants: participants.map((participant) => ({
      ...participant,
      async start() {
        starts++;
        clock = 99999;
      },
    })),
  };
  await admission.acquire('a', 'unresolved', 100);
  await expect(startTenantBackupSnapshotBoundary(input)).rejects.toThrow(
    'backup_snapshot_boundary_failed'
  );
  expect(starts).toBe(0);
  await admission.complete('a', 'unresolved', 101);
  await expect(
    startTenantBackupSnapshotBoundary({
      ...input,
      identity: { ...receiptIdentity, boundaryId: 'late' },
    })
  ).rejects.toThrow('backup_snapshot_boundary_failed');
  expect(
    await receipts.readReleased({ ...receiptIdentity, boundaryId: 'late' }, participants, clock)
  ).toBeNull();
});

it('recovers release persistence after an actual lost response and cannot abort another operation', async () => {
  let loseRelease = true;
  const receipts = new TenantBackupBoundaryReceipts({
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const result = await adapter.queryOne<T>(sql, params);
      if (loseRelease && sql.includes("SET state='released'")) {
        loseRelease = false;
        throw new Error('lost release response');
      }
      return result;
    },
  });
  let starts = 0;
  const input = {
    identity: receiptIdentity,
    admission,
    receipts,
    signal: new AbortController().signal,
    now: () => 101,
    async assertReady() {},
    participants: participants.map((participant) => ({
      ...participant,
      async start() {
        starts++;
      },
    })),
  };
  await expect(startTenantBackupSnapshotBoundary(input)).rejects.toThrow(
    'backup_snapshot_boundary_failed'
  );
  expect((await startTenantBackupSnapshotBoundary(input)).state).toBe('released');
  expect(starts).toBe(2);
  await admission.begin({ ...boundary, id: 'other', now: 102 });
  await receipts.abort({ ...receiptIdentity, boundaryId: 'other', operationId: 'wrong' }, 103);
  expect((await admission.hold('a', 'other', 104))?.state).toBe('held');
});

it.each(['plan', 'hold', 'acknowledge', 'release'])(
  'rejects delayed %s at SQL execution time even when the bound RPC timestamp is still valid',
  async (action) => {
    let databaseNow = 100;
    db.function('julianday', (_value: SQLInputValue) => 2440587.5 + databaseNow / 86400000);
    const timedAdmission = new TenantBackupMutationAdmission(adapter, 'legacy', true);
    const receipts = new TenantBackupBoundaryReceipts(adapter, true);
    const identity = {
      environmentId: 'legacy',
      tenantId: 'a',
      boundaryId: boundary.id,
      operationId: boundary.operationId,
      inventoryDigest: boundary.inventoryDigest,
    };
    const participant = { resourceId: 'core', snapshotId: 'snapshot' };
    expect(await timedAdmission.begin(boundary)).not.toBeNull();
    if (action !== 'plan') expect(await receipts.plan(identity, [participant], 100)).toBe(true);
    if (action === 'acknowledge' || action === 'release')
      expect(await timedAdmission.hold('a', boundary.id, 100)).not.toBeNull();
    if (action === 'release')
      expect(await receipts.acknowledge(identity, participant, 100)).toBe(true);
    databaseNow = 60101;
    if (action === 'plan') expect(await receipts.plan(identity, [participant], 100)).toBe(false);
    if (action === 'hold') expect(await timedAdmission.hold('a', boundary.id, 100)).toBeNull();
    if (action === 'acknowledge')
      expect(await receipts.acknowledge(identity, participant, 100)).toBe(false);
    if (action === 'release') expect(await receipts.release(identity, 100)).toBeNull();
    await expect(receipts.assertHeld(identity, 100)).rejects.toThrow('not_held');
    expect(await receipts.readReleased(identity, [participant], 60200)).toBeNull();
  }
);

it('records the database release time and recovers the immutable receipt after expiry', async () => {
  let databaseNow = 100;
  db.function('julianday', (_value: SQLInputValue) => 2440587.5 + databaseNow / 86400000);
  const timedAdmission = new TenantBackupMutationAdmission(adapter, 'legacy', true);
  const receipts = new TenantBackupBoundaryReceipts(adapter, true);
  const identity = {
    environmentId: 'legacy',
    tenantId: 'a',
    boundaryId: boundary.id,
    operationId: boundary.operationId,
    inventoryDigest: boundary.inventoryDigest,
  };
  const participant = { resourceId: 'core', snapshotId: 'snapshot' };
  await timedAdmission.begin(boundary);
  await receipts.plan(identity, [participant], 100);
  await timedAdmission.hold('a', boundary.id, 100);
  databaseNow = 150;
  expect(await receipts.acknowledge(identity, participant, 100)).toBe(true);
  databaseNow = 200;
  expect((await receipts.release(identity, 100))?.released_at).toBe(200);
  databaseNow = 70000;
  expect((await receipts.readReleased(identity, [participant], 100))?.released_at).toBe(200);
});
