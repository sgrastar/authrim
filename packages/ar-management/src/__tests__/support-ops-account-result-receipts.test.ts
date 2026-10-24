import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCoreStore } from './helpers/core-schema-sqlite';
import {
  acknowledgeSupportOpsAccountResult,
  assertSupportOpsAccountReceiptStore,
  cleanupSupportOpsAccountResultReceipts,
  readSupportOpsAccountResult,
  SUPPORT_OPS_ACCOUNT_RESULT_ACK_TTL_MS,
  suspendSupportOpsAccountOnce,
  type SupportOpsAccountMutation,
} from '../support-ops-execute';

const input: SupportOpsAccountMutation = {
  tenantId: 'receipt-tenant',
  actionId: 'action-1',
  accountId: 'account-1',
  userId: 'user-1',
  operationId: 'operation-1',
  sourceVersionMs: 10000,
  actorId: 'admin-1',
};
describe('durable Support Ops account results on routed Core shards', () => {
  let store: ReturnType<typeof openCoreStore>;
  let now: number;
  beforeEach(() => {
    store = openCoreStore(input.tenantId);
    store.db.exec('PRAGMA foreign_keys=ON');
    // A legitimate user shard has canonical accounts without the tenant metadata inventory row.
    store.db.prepare('DELETE FROM tenants WHERE id=?').run(input.tenantId);
    store.db
      .prepare(
        `INSERT INTO identity_subjects(id,tenant_id,subject_type,lifecycle_state,created_at,updated_at)
      VALUES('subject-1',?,'person','active',1,1)`
      )
      .run(input.tenantId);
    store.db
      .prepare(
        `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,primary_subject_id,created_at,updated_at)
      VALUES(?,?,'user','active',?,'subject-1',1,1)`
      )
      .run(input.accountId, input.tenantId, input.userId);
    now = Date.now();
  });
  afterEach(() => store.db.close());
  const result = () =>
    store.db
      .prepare('SELECT lifecycle_state,metadata_json,updated_at FROM identity_accounts WHERE id=?')
      .get(input.accountId) as {
      lifecycle_state: string;
      metadata_json: string | null;
      updated_at: number;
    };
  const apply = (allowed = true) =>
    suspendSupportOpsAccountOnce(store.adapter, input, allowed, now, now + 20000);

  it('uses the dedicated schema with FK ON and no tenant row', async () => {
    expect(store.db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(
      store.db.prepare('SELECT id FROM tenants WHERE id=?').get(input.tenantId)
    ).toBeUndefined();
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO idempotency_keys(id,tenant_id,actor_id,method,path,idempotency_key,body_hash,response_status,response_body,created_at,expires_at)
      VALUES('control',?,'actor','POST','/','key','hash',200,'{}',1,2)`
        )
        .run(input.tenantId)
    ).toThrow(/FOREIGN KEY/);
    await assertSupportOpsAccountReceiptStore(store.adapter);
    expect(await apply()).toBe(1);
    expect(result().lifecycle_state).toBe('suspended');
  });
  it('recovers the original result after commit response loss and a newer normal lifecycle', async () => {
    const batch = store.adapter.batch.bind(store.adapter);
    vi.spyOn(store.adapter, 'batch').mockImplementationOnce(async (statements) => {
      await batch(statements);
      throw new Error('response_lost');
    });
    await expect(apply()).rejects.toThrow('response_lost');
    store.db
      .prepare(
        "UPDATE identity_accounts SET lifecycle_state='active',metadata_json=?,updated_at=? WHERE id=?"
      )
      .run(
        JSON.stringify({
          lifecycle_version_ms: 20000,
          lifecycle_operation_id: 'normal-reactivate',
        }),
        now + 100,
        input.accountId
      );
    expect(await apply(false)).toBe(1);
    expect(result()).toMatchObject({ lifecycle_state: 'active', updated_at: now + 100 });
  });
  it('seals the same D1 batch retry before subject versions can change twice', async () => {
    const batch = store.adapter.batch.bind(store.adapter);
    vi.spyOn(store.adapter, 'batch').mockImplementationOnce(async (statements) => {
      await batch(statements);
      return batch(statements);
    });
    store.db
      .prepare("UPDATE identity_subjects SET updated_at=? WHERE id='subject-1'")
      .run(now + 100);
    expect(await apply()).toBe(1);
    expect(
      store.db.prepare("SELECT updated_at FROM identity_subjects WHERE id='subject-1'").get()
    ).toMatchObject({ updated_at: now + 101 });
  });
  it('rolls back account and receipt when the subject update fails', async () => {
    store.db.exec(
      "CREATE TRIGGER reject_subject BEFORE UPDATE ON identity_subjects BEGIN SELECT RAISE(ABORT,'subject_failure'); END"
    );
    await expect(apply()).rejects.toThrow('subject_failure');
    expect(result().lifecycle_state).toBe('active');
    expect(await readSupportOpsAccountResult(store.adapter, input)).toBeNull();
  });
  it('does not move future account or subject update timestamps backwards', async () => {
    store.db
      .prepare('UPDATE identity_accounts SET updated_at=? WHERE id=?')
      .run(now + 1000, input.accountId);
    store.db
      .prepare("UPDATE identity_subjects SET updated_at=? WHERE id='subject-1'")
      .run(now + 2000);
    expect(await apply()).toBe(1);
    expect(result().updated_at).toBe(now + 1000);
    expect(
      store.db.prepare("SELECT updated_at FROM identity_subjects WHERE id='subject-1'").get()
    ).toMatchObject({ updated_at: now + 2001 });
  });
  it('retains skip outcome and isolates tenant/account/action identity', async () => {
    expect(await apply(false)).toBe(0);
    expect(await apply(true)).toBe(0);
    for (const changed of [
      { tenantId: 'other-tenant' },
      { accountId: 'other-account' },
      { actionId: 'other-action' },
    ])
      expect(await readSupportOpsAccountResult(store.adapter, { ...input, ...changed })).toBeNull();
    expect(result().lifecycle_state).toBe('active');
  });
  it('keeps unACKed results and uses a fixed monotonic ACK TTL with bounded cleanup', async () => {
    await apply(false);
    expect(
      await cleanupSupportOpsAccountResultReceipts(
        store.adapter,
        now + SUPPORT_OPS_ACCOUNT_RESULT_ACK_TTL_MS + 1
      )
    ).toBe(0);
    await acknowledgeSupportOpsAccountResult(store.adapter, input, now - 100);
    await acknowledgeSupportOpsAccountResult(store.adapter, input, now + 100);
    expect(
      store.db
        .prepare(
          'SELECT acknowledged_at_ms,delete_after_ms FROM support_ops_account_result_receipts'
        )
        .get()
    ).toMatchObject({
      acknowledged_at_ms: now,
      delete_after_ms: now + SUPPORT_OPS_ACCOUNT_RESULT_ACK_TTL_MS,
    });
    const second = { ...input, actionId: 'action-2' },
      unacknowledged = { ...input, actionId: 'action-3' };
    await suspendSupportOpsAccountOnce(store.adapter, second, false, now, now + 20000);
    await acknowledgeSupportOpsAccountResult(store.adapter, second, now);
    await suspendSupportOpsAccountOnce(store.adapter, unacknowledged, false, now, now + 20000);
    expect(
      await cleanupSupportOpsAccountResultReceipts(
        store.adapter,
        now + SUPPORT_OPS_ACCOUNT_RESULT_ACK_TTL_MS + 1,
        1
      )
    ).toBe(1);
    expect(
      store.db.prepare('SELECT COUNT(*) n FROM support_ops_account_result_receipts').get()
    ).toMatchObject({ n: 2 });
    expect(await readSupportOpsAccountResult(store.adapter, unacknowledged)).toBe(0);
  });
  it('cannot recreate a deleted tombstone through an expired invocation permit', async () => {
    const past = Date.now() - 100000;
    await expect(
      suspendSupportOpsAccountOnce(store.adapter, input, true, past, past + 20000)
    ).rejects.toThrow('permit_expired');
    expect(result().lifecycle_state).toBe('active');
    expect(await readSupportOpsAccountResult(store.adapter, input)).toBeNull();
  });
  it('rejects unsupported adapters and unsafe times before changing the account', async () => {
    vi.spyOn(store.adapter, 'getType').mockReturnValue('postgres');
    await expect(apply()).rejects.toThrow('unsupported');
    vi.spyOn(store.adapter, 'getType').mockReturnValue('sqlite');
    await expect(
      suspendSupportOpsAccountOnce(store.adapter, input, true, Number.MAX_SAFE_INTEGER, now)
    ).rejects.toThrow('time_invalid');
    expect(result().lifecycle_state).toBe('active');
  });
});
