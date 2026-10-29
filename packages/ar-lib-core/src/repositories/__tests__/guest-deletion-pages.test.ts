import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuestLifecycleRepository } from '../guest-lifecycle';
import { sqliteAdapter } from './sqlite-core-schema';
import { guestDeletionReceiptFixture } from '../../services/__tests__/guest-deletion-receipt-fixture';
import {
  guestDirectoryRemovalOperationPrefix,
  guestErasureBoundaryId,
  parseGuestDeletionReceiptV2,
} from '../../services/guest-deletion-receipt';
import {
  createGuestDeletionProgress,
  guestDeletionReceiptDigest,
  type GuestDeletionProgress,
} from '../../services/guest-deletion-progress';
import { createLookupBlindIndex } from '../../services/lookup-directory/blind-index';
import {
  accountDirectoryRemovalOutboxId,
  type AccountDirectoryRemovalPublication,
} from '../../services/lookup-directory/publication';
import type { PreparedStatement } from '../../db/adapter';

const stores: ReturnType<typeof sqliteAdapter>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.db.close()));
async function fixture(options: { credentials?: boolean; sharedSubject?: boolean } = {}) {
  const store = sqliteAdapter();
  stores.push(store);
  store.db.exec('PRAGMA foreign_keys=ON');
  const raw = guestDeletionReceiptFixture();
  const accepted = parseGuestDeletionReceiptV2(JSON.stringify(raw), {
    tenantId: raw.tenantId,
    userId: raw.userId,
  });
  store.db
    .prepare(
      'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,1,1)'
    )
    .run(accepted.tenantId, accepted.tenantId, 'fixture', 'Fixture');
  if (options.sharedSubject)
    store.db
      .prepare(
        "INSERT INTO identity_subjects(id,tenant_id,subject_type,created_at,updated_at) VALUES(?,?,'person',1,1)"
      )
      .run('shared-subject', accepted.tenantId);
  store.db
    .prepare(
      `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,primary_subject_id,created_at,updated_at)
    VALUES(?,?,'user','active',?,'guest','active',1,?,1,1)`
    )
    .run(
      accepted.accountId,
      accepted.tenantId,
      accepted.userId,
      options.sharedSubject ? 'shared-subject' : null
    );
  if (options.sharedSubject)
    store.db
      .prepare(
        `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,primary_subject_id,created_at,updated_at) VALUES(?,?,'user','active',?,'registered','shared-subject',1,1)`
      )
      .run('another-account', accepted.tenantId, 'another-user');
  store.db
    .prepare(
      'INSERT INTO guest_account_lifecycle(tenant_id,user_id,client_id,created_at,deletion_due_at,policy_version,updated_at) VALUES(?,?,?,1,100,?,1)'
    )
    .run(accepted.tenantId, accepted.userId, 'app', 'policy:1');
  if (options.credentials) {
    store.db
      .prepare(
        'INSERT INTO passkeys(id,tenant_id,user_id,credential_id,public_key,created_at) VALUES(?,?,?,?,?,1)'
      )
      .run('key-1', accepted.tenantId, accepted.userId, 'credential-1', 'fixture');
    store.db
      .prepare(
        'INSERT INTO guest_devices(id,tenant_id,user_id,resume_credential_hash,created_at,last_used_at) VALUES(?,?,?,?,1,1)'
      )
      .run('device-1', accepted.tenantId, accepted.userId, 'ab'.repeat(32));
    store.db
      .prepare(
        'INSERT INTO totp_credentials(id,tenant_id,user_id,secret_encrypted,created_at) VALUES(?,?,?,?,1)'
      )
      .run('totp-1', accepted.tenantId, accepted.userId, 'fixture');
    store.db
      .prepare(
        'INSERT INTO totp_backup_codes(id,tenant_id,user_id,credential_id,code_hash,code_prefix,created_at) VALUES(?,?,?,?,?,?,1)'
      )
      .run('backup-1', accepted.tenantId, accepted.userId, 'totp-1', 'fixture-hash', 'fixture');
  }
  const adapter = { ...store.adapter, getType: () => 'd1' };
  const repository = new GuestLifecycleRepository(adapter, accepted.tenantId);
  await repository.admitDeletion({
    userId: accepted.userId,
    accountId: accepted.accountId,
    operationId: accepted.operationId,
    routeJson: JSON.stringify(accepted),
    expectedRevision: 1,
    accountRouteGeneration: 1,
    now: 2000,
    startedAtMs: 2000000,
    origin: 'admin',
    task: {
      auditId: accepted.completionAuditId,
      actorUserId: 'original-admin',
      ipAddress: 'fixture-ip',
      userAgent: 'fixture-agent',
      metadataJson: JSON.stringify({ guestDeletionVersion: 2, operationId: accepted.operationId }),
      createdAt: 2000,
    },
  });
  const route = {
    ...accepted,
    execution: {
      phase: 'erasure_started' as const,
      boundaryId: await guestErasureBoundaryId(accepted.operationId),
      erasureStartedAtMs: 2000001,
    },
  };
  const routeJson = JSON.stringify(route);
  await repository.confirmErasureStart({
    userId: route.userId,
    accountId: route.accountId,
    operationId: route.operationId,
    expectedRevision: 2,
    acceptedRouteJson: JSON.stringify(accepted),
    erasureStartedRouteJson: routeJson,
    accountRouteGeneration: 1,
    now: 2001,
  });
  const initial = await createGuestDeletionProgress(route, [1]);
  const save = (progress: GuestDeletionProgress) =>
    store.db
      .prepare('UPDATE guest_deletion_audit_outbox SET execution_progress_json=?')
      .run(JSON.stringify(progress));
  const request = (old: GuestDeletionProgress, next: GuestDeletionProgress) => ({
    routeJson,
    userId: route.userId,
    expectedProgressJson: JSON.stringify(old),
    nextProgressJson: JSON.stringify(next),
  });
  return { ...store, adapter, repository, route, routeJson, initial, save, request };
}
async function publication(
  f: Awaited<ReturnType<typeof fixture>>,
  suffix = '1'
): Promise<AccountDirectoryRemovalPublication> {
  const operationId = (await guestDirectoryRemovalOperationPrefix(f.route)) + suffix.repeat(32);
  return {
    operationId,
    idempotencyKey: operationId,
    tenantId: f.route.tenantId,
    accountId: f.route.accountId,
    routeProjection: f.route.routeProjection,
    scope: 'account',
    indexes: [
      await createLookupBlindIndex('account_id', f.route.accountId, {
        generation: 1,
        secret: '0123456789abcdef0123456789abcdef',
      }),
    ],
  };
}
function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return f.db.prepare('SELECT * FROM guest_deletion_audit_outbox').get();
}

describe('bounded same-Core Guest execution pages', () => {
  it('binds progress to the closed receipt regardless of object property insertion order', async () => {
    const f = await fixture();
    const pin = f.route.corePin;
    const reordered = {
      ...f.route,
      corePin: {
        bindingRouteGeneration: pin.bindingRouteGeneration,
        assignmentGeneration: pin.assignmentGeneration,
        shardId: pin.shardId,
        residencyPartition: pin.residencyPartition,
        dataRole: pin.dataRole,
        bindingRef: pin.bindingRef,
        databaseId: pin.databaseId,
      },
    };
    expect(await guestDeletionReceiptDigest(reordered)).toBe(
      await guestDeletionReceiptDigest(f.route)
    );
    const progress = await createGuestDeletionProgress(reordered, [1]);
    expect(
      await f.repository.compareAndSwapExecutionProgress({
        routeJson: f.routeJson,
        userId: f.route.userId,
        expectedProgressJson: null,
        nextProgressJson: JSON.stringify(progress),
      })
    ).toBe(true);
  });
  it('recovers lost CAS acknowledgement only from the exact primary progress and preserves the original task', async () => {
    const f = await fixture();
    const before = snapshot(f);
    const execute = f.adapter.execute.bind(f.adapter);
    f.adapter.execute = vi.fn(async (sql: string, params?: unknown[]) => {
      await execute(sql, params);
      throw new Error('lost_ack');
    });
    expect(
      await f.repository.compareAndSwapExecutionProgress({
        routeJson: f.routeJson,
        userId: f.route.userId,
        expectedProgressJson: null,
        nextProgressJson: JSON.stringify(f.initial),
      })
    ).toBe(true);
    expect(snapshot(f)).toEqual({ ...before, execution_progress_json: JSON.stringify(f.initial) });
    f.adapter.execute = execute;
    expect(
      await f.repository.compareAndSwapExecutionProgress({
        routeJson: f.routeJson,
        userId: f.route.userId,
        expectedProgressJson: null,
        nextProgressJson: JSON.stringify({ ...f.initial, pinnedHmacGenerations: [2] }),
      })
    ).toBe(false);
    expect(snapshot(f)).toEqual({ ...before, execution_progress_json: JSON.stringify(f.initial) });
  });
  it('a stale CAS cannot delete another page or leave a transient permit', async () => {
    const f = await fixture({ credentials: true });
    const old = { ...f.initial, stage: 'drain_passkeys' as const };
    const winner = { ...old, revision: old.revision + 2, cursor: 'winner', highWater: 'z' };
    f.save(winner);
    expect(
      await f.repository.drainCorePage({
        ...f.request(old, {
          ...old,
          revision: old.revision + 2,
          cursor: 'key-1',
          highWater: 'key-1',
        }),
        table: 'passkeys',
        ids: ['key-1'],
      })
    ).toBe(false);
    expect(f.db.prepare('SELECT id FROM passkeys').all()).toEqual([{ id: 'key-1' }]);
    expect(snapshot(f)?.execution_progress_json).toBe(JSON.stringify(winner));
  });
  it('rolls back a completed DELETE and its permit when a later statement fails, then recovers a lost successful ACK', async () => {
    const f = await fixture({ credentials: true });
    const old = { ...f.initial, stage: 'drain_passkeys' as const };
    f.save(old);
    const input = {
      ...f.request(old, {
        ...old,
        revision: old.revision + 2,
        cursor: 'key-1',
        highWater: 'key-1',
      }),
      table: 'passkeys' as const,
      ids: ['key-1'],
    };
    const batch = f.adapter.batch.bind(f.adapter);
    f.adapter.batch = vi.fn((statements: PreparedStatement[]) =>
      batch([
        ...statements.slice(0, 2),
        { sql: "SELECT json_extract('injected-failure','$.value')" },
        ...statements.slice(2),
      ])
    );
    await expect(f.repository.drainCorePage(input)).rejects.toThrow('guest_deletion_page_unknown');
    expect(f.db.prepare('SELECT id FROM passkeys').all()).toEqual([{ id: 'key-1' }]);
    expect(snapshot(f)?.execution_progress_json).toBe(JSON.stringify(old));
    f.adapter.batch = vi.fn(async (statements: PreparedStatement[]) => {
      await batch(statements);
      throw new Error('lost_ack');
    });
    expect(await f.repository.drainCorePage(input)).toBe(true);
    expect(f.db.prepare('SELECT id FROM passkeys').all()).toEqual([]);
    expect(snapshot(f)?.execution_progress_json).toBe(input.nextProgressJson);
  });
  it('drains all four credential sources before confirming the Core terminal state', async () => {
    const f = await fixture({ credentials: true });
    for (const [table, id] of [
      ['guest_devices', 'device-1'],
      ['passkeys', 'key-1'],
      ['totp_backup_codes', 'backup-1'],
      ['totp_credentials', 'totp-1'],
    ] as const) {
      const old = { ...f.initial, stage: `drain_${table}` as const };
      f.save(old);
      expect(
        await f.repository.drainCorePage({
          ...f.request(old, { ...old, revision: old.revision + 2, cursor: id, highWater: id }),
          table,
          ids: [id],
        })
      ).toBe(true);
      expect(f.db.prepare(`SELECT id FROM ${table}`).all()).toEqual([]);
    }
    const old = { ...f.initial, stage: 'final_core' as const };
    f.save(old);
    expect(
      await f.repository.finishCoreErasure({
        ...f.request(old, { ...old, revision: old.revision + 2, stage: 'directory_ready' }),
        now: 2002,
      })
    ).toBe(true);
    expect((await f.repository.get(f.route.userId))?.phase).toBe('deleted');
    expect(
      f.db
        .prepare('SELECT lifecycle_state FROM identity_accounts WHERE id=?')
        .get(f.route.accountId)
    ).toEqual({ lifecycle_state: 'deleted' });
    expect(snapshot(f)?.execution_progress_json).not.toContain('"corePermit":{');
  });
  it.each(['totp_credentials', 'totp_backup_codes'])(
    'refuses a terminal state when only %s remains and rolls the whole batch back',
    async (remaining) => {
      const f = await fixture({ credentials: true });
      for (const [table, id] of [
        ['guest_devices', 'device-1'],
        ['passkeys', 'key-1'],
        ['totp_backup_codes', 'backup-1'],
        ['totp_credentials', 'totp-1'],
      ] as const) {
        if (table === remaining) continue;
        const page = { ...f.initial, stage: `drain_${table}` as const };
        f.save(page);
        expect(
          await f.repository.drainCorePage({
            ...f.request(page, { ...page, revision: page.revision + 2, cursor: id, highWater: id }),
            table,
            ids: [id],
          })
        ).toBe(true);
        expect(f.db.prepare(`SELECT id FROM ${table}`).all()).toEqual([]);
      }
      expect(f.db.prepare(`SELECT count(*) AS n FROM ${remaining}`).get()).toEqual({ n: 1 });
      const old = { ...f.initial, stage: 'final_core' as const };
      f.save(old);
      await expect(
        f.repository.finishCoreErasure({
          ...f.request(old, { ...old, revision: old.revision + 2, stage: 'directory_ready' }),
          now: 2002,
        })
      ).rejects.toThrow('guest_deletion_terminal_unknown');
      expect((await f.repository.get(f.route.userId))?.phase).toBe('deleting');
      expect(
        f.db
          .prepare('SELECT lifecycle_state FROM identity_accounts WHERE id=?')
          .get(f.route.accountId)
      ).toEqual({ lifecycle_state: 'deleting' });
      expect(snapshot(f)?.execution_progress_json).toBe(JSON.stringify(old));
    }
  );
  it('deletes one account while preserving a subject shared with another live account', async () => {
    const f = await fixture({ sharedSubject: true });
    const old = { ...f.initial, stage: 'final_core' as const };
    f.save(old);
    expect(
      await f.repository.finishCoreErasure({
        ...f.request(old, { ...old, revision: old.revision + 2, stage: 'directory_ready' }),
        now: 2002,
      })
    ).toBe(true);
    expect((await f.repository.get(f.route.userId))?.phase).toBe('deleted');
    expect(
      f.db.prepare('SELECT lifecycle_state FROM identity_subjects WHERE id=?').get('shared-subject')
    ).toEqual({ lifecycle_state: 'active' });
    expect(
      f.db
        .prepare('SELECT lifecycle_state FROM identity_accounts WHERE id=?')
        .get('another-account')
    ).toEqual({ lifecycle_state: 'active' });
  });
  it('schedules a Core-terminal deletion until its original task is acknowledged, including retry state', async () => {
    const f = await fixture();
    const old = { ...f.initial, stage: 'final_core' as const };
    f.save(old);
    expect(
      await f.repository.finishCoreErasure({
        ...f.request(old, { ...old, revision: old.revision + 2, stage: 'directory_ready' }),
        now: 2002,
      })
    ).toBe(true);
    expect((await f.repository.listDeletionCandidates(2003)).map((row) => row.user_id)).toContain(
      f.route.userId
    );
    f.db.prepare("UPDATE guest_deletion_audit_outbox SET status='retry'").run();
    expect((await f.repository.listDeletionCandidates(2003)).map((row) => row.user_id)).toContain(
      f.route.userId
    );
    f.db.prepare("UPDATE guest_deletion_audit_outbox SET operation_id='foreign-operation'").run();
    expect(
      (await f.repository.listDeletionCandidates(2003)).map((row) => row.user_id)
    ).not.toContain(f.route.userId);
    f.db.prepare('DELETE FROM guest_deletion_audit_outbox').run();
    expect(
      (await f.repository.listDeletionCandidates(2003)).map((row) => row.user_id)
    ).not.toContain(f.route.userId);
  });
  it('prepares deterministic directory effects, confirms ready counts and replays a lost ACK without duplicates', async () => {
    const f = await fixture();
    f.save(f.initial);
    const pub = await publication(f);
    const prepared = {
      ...f.initial,
      revision: 2,
      stage: 'capture_linked' as const,
      preparedCount: 1,
    };
    const input = { ...f.request(f.initial, prepared), publications: [pub], now: 2002 };
    const batch = f.adapter.batch.bind(f.adapter);
    f.adapter.batch = vi.fn(async (statements: PreparedStatement[]) => {
      await batch(statements);
      throw new Error('lost_ack');
    });
    expect(await f.repository.prepareDirectoryRemovalPage(input)).toBe(true);
    expect(await f.repository.prepareDirectoryRemovalPage(input)).toBe(true);
    const id = accountDirectoryRemovalOutboxId(pub.operationId);
    expect(f.db.prepare('SELECT outbox_id,status FROM account_routing_outbox').all()).toEqual([
      { outbox_id: id, status: 'prepared' },
    ]);
    f.adapter.batch = batch;
    const final = { ...prepared, stage: 'final_core' as const };
    f.save(final);
    const ready = { ...final, stage: 'directory_ready' as const, revision: final.revision + 2 };
    expect(await f.repository.finishCoreErasure({ ...f.request(final, ready), now: 2003 })).toBe(
      true
    );
    const confirmed = {
      ...ready,
      revision: ready.revision + 1,
      confirmedCount: 1,
      cursor: id,
      highWater: id,
    };
    expect(
      await f.repository.markDirectoryRemovalPageReady({
        ...f.request(ready, confirmed),
        ids: [id],
        now: 2004,
      })
    ).toBe(true);
    expect(snapshot(f)?.execution_progress_json).toBe(JSON.stringify(confirmed));
    expect(f.db.prepare('SELECT outbox_id,status FROM account_routing_outbox').all()).toEqual([
      { outbox_id: id, status: 'pending' },
    ]);
  });
  it('rejects a same-ID directory effect with different content without advancing progress', async () => {
    const f = await fixture();
    f.save(f.initial);
    const pub = await publication(f);
    const id = accountDirectoryRemovalOutboxId(pub.operationId);
    f.db
      .prepare(
        `INSERT INTO account_routing_outbox(outbox_id,tenant_id,account_id,event_kind,route_generation,route_schema_version,hmac_key_generation,payload_json,status,created_at,updated_at) VALUES(?,?,?,'account_deleted',1,1,1,'{}','prepared',1,1)`
      )
      .run(id, f.route.tenantId, f.route.accountId);
    await expect(
      f.repository.prepareDirectoryRemovalPage({
        ...f.request(f.initial, {
          ...f.initial,
          revision: 2,
          preparedCount: 1,
          stage: 'capture_linked',
        }),
        publications: [pub],
        now: 2002,
      })
    ).rejects.toThrow('guest_directory_page_unknown');
    expect(snapshot(f)?.execution_progress_json).toBe(JSON.stringify(f.initial));
    expect(f.db.prepare('SELECT payload_json FROM account_routing_outbox').get()).toEqual({
      payload_json: '{}',
    });
  });
});
