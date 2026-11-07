import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { LiteTxnStore } from '../LiteTxnStore';
import {
  LITE_TXN_MAX_DATA_BYTES,
  LITE_TXN_MAX_KEY_LENGTH,
  LITE_TXN_MAX_READS,
  LITE_TXN_MAX_RECORDS,
  LITE_TXN_MAX_RECORD_BYTES,
  LITE_TXN_MAX_RESULT_BYTES,
  LITE_TXN_MAX_START_GRANTS,
  LITE_TXN_MAX_UPDATES,
  LITE_TXN_OPERATION_LEASE_MS,
  LITE_TXN_TTL_MS,
  type LiteTxnBound,
} from '../../types/login-ui-lite-txn';

class Storage {
  readonly data = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
  }
  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (key.startsWith(options.prefix)) out.set(key, structuredClone(value) as T);
    }
    return out;
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }
}

const BINDING = 'a'.repeat(64);
const bound = (overrides: Partial<LiteTxnBound> = {}): LiteTxnBound => ({
  tenantId: 'tenant-a',
  publicOrigin: 'https://id.example',
  purpose: 'login',
  clientId: 'client-1',
  challengeId: 'challenge-1',
  returnTo: null,
  policyRevision: 'rev-1',
  sessionId: null,
  userId: null,
  ...overrides,
});

function createStore() {
  const storage = new Storage();
  const store = new LiteTxnStore({ storage } as unknown as DurableObjectState, {} as never);
  return { store, storage };
}

async function create(store: LiteTxnStore, extra: Record<string, unknown> = {}) {
  const result = await store.createTxnRpc({
    tenantId: 'tenant-a',
    bindingHash: BINDING,
    bound: bound(),
    maxActive: 4,
    ...extra,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.txn;
}

const ref = (txnId: string) => ({ tenantId: 'tenant-a', bindingHash: BINDING, txnId });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('LiteTxnStore: creating', () => {
  it('makes an open transaction with an absolute expiry and schedules its cleanup', async () => {
    const { store, storage } = createStore();
    const txn = await create(store);
    expect(txn).toMatchObject({ state: 'open', version: 1, bound: bound() });
    expect(txn.expiresAt - txn.createdAt).toBe(LITE_TXN_TTL_MS);
    expect(txn.csrfToken).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(storage.alarmAt).toBe(txn.expiresAt);
  });

  it('answers the same live transaction on a reload, without extending it', async () => {
    const { store } = createStore();
    const first = await create(store, { reuseKey: 'login:challenge-1' });
    vi.advanceTimersByTime(60_000);
    const again = await store.createTxnRpc({
      tenantId: 'tenant-a',
      bindingHash: BINDING,
      bound: bound(),
      reuseKey: 'login:challenge-1',
      maxActive: 4,
    });
    expect(again).toMatchObject({ ok: true, reused: true });
    if (again.ok) expect(again.txn).toEqual(first);
    // Another bound under the same key is a new transaction.
    const other = await store.createTxnRpc({
      tenantId: 'tenant-a',
      bindingHash: BINDING,
      bound: bound({ clientId: 'client-2' }),
      reuseKey: 'login:challenge-1',
      maxActive: 4,
    });
    expect(other).toMatchObject({ ok: true, reused: false });
  });

  it('limits the live transactions of one browser', async () => {
    const { store } = createStore();
    for (let i = 0; i < 2; i++) await create(store, { maxActive: 2 });
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: bound(),
        maxActive: 2,
      })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
    // Expired ones do not count.
    vi.advanceTimersByTime(LITE_TXN_TTL_MS);
    await expect(create(store, { maxActive: 2 })).resolves.toBeDefined();
  });

  it('limits the records of one browser, finished transactions included', async () => {
    const { store } = createStore();
    for (let i = 0; i < LITE_TXN_MAX_RECORDS; i++) {
      const txn = await create(store, { maxActive: 2 });
      await store.transitionRpc({ ...ref(txn.id), expectedVersion: 1, to: 'abandoned' });
    }
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: bound(),
        maxActive: 2,
      })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
    vi.advanceTimersByTime(LITE_TXN_TTL_MS);
    await expect(create(store, { maxActive: 2 })).resolves.toBeDefined();
  });

  it('refuses another tenant or browser than the instance was made for, and oversized data', async () => {
    const { store } = createStore();
    const txn = await create(store);
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-b',
        bindingHash: BINDING,
        bound: bound({ tenantId: 'tenant-b' }),
        maxActive: 4,
      })
    ).resolves.toEqual({ ok: false, reason: 'binding_mismatch' });
    await expect(
      store.getTxnRpc({ tenantId: 'tenant-a', bindingHash: 'b'.repeat(64), txnId: txn.id })
    ).resolves.toEqual({ ok: false, reason: 'binding_mismatch' });
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: bound({ tenantId: 'tenant-b' }),
        maxActive: 4,
      })
    ).resolves.toEqual({ ok: false, reason: 'binding_mismatch' });
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: bound(),
        data: { blob: 'x'.repeat(LITE_TXN_MAX_DATA_BYTES) },
        maxActive: 4,
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('LiteTxnStore: moving', () => {
  it('moves only from the version read, along the allowed transitions', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const sent = await store.transitionRpc({
      ...ref(txn.id),
      expectedVersion: 1,
      to: 'pending',
      patch: { email_attempt: 'a-1' },
    });
    expect(sent).toMatchObject({ ok: true, txn: { state: 'pending', version: 2 } });
    // A second tab that read version 1 cannot move it.
    await expect(
      store.transitionRpc({ ...ref(txn.id), expectedVersion: 1, to: 'verified' })
    ).resolves.toEqual({ ok: false, reason: 'version_mismatch' });
    await expect(
      store.transitionRpc({ ...ref(txn.id), expectedVersion: 2, to: 'open' })
    ).resolves.toEqual({ ok: false, reason: 'invalid_transition' });
    const verified = await store.transitionRpc({
      ...ref(txn.id),
      expectedVersion: 2,
      to: 'verified',
      patch: { email_attempt: null, verified_at: 1 },
    });
    expect(verified).toMatchObject({ ok: true, txn: { data: { verified_at: 1 } } });
    if (verified.ok) expect(verified.txn.data).not.toHaveProperty('email_attempt');
  });

  it('never moves a finished transaction again', async () => {
    const { store } = createStore();
    const txn = await create(store);
    await store.transitionRpc({ ...ref(txn.id), expectedVersion: 1, to: 'verified' });
    await store.transitionRpc({ ...ref(txn.id), expectedVersion: 2, to: 'completed' });
    for (const to of ['open', 'pending', 'verified', 'abandoned'] as const) {
      await expect(
        store.transitionRpc({ ...ref(txn.id), expectedVersion: 3, to })
      ).resolves.toEqual({ ok: false, reason: 'finished' });
    }
    // It can still be read, so a page can tell how it ended.
    await expect(store.getTxnRpc(ref(txn.id))).resolves.toMatchObject({
      ok: true,
      txn: { state: 'completed' },
    });
  });

  it('ends at its absolute expiry, however often it moved', async () => {
    const { store } = createStore();
    const txn = await create(store);
    let version = 1;
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(LITE_TXN_TTL_MS / 20);
      const moved = await store.transitionRpc({
        ...ref(txn.id),
        expectedVersion: version,
        to: 'pending',
      });
      if (moved.ok) version = moved.txn.version;
    }
    vi.advanceTimersByTime(LITE_TXN_TTL_MS / 2);
    await expect(store.getTxnRpc(ref(txn.id))).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('limits the reads and changes of one transaction', async () => {
    const { store } = createStore();
    const txn = await create(store);
    for (let i = 0; i < LITE_TXN_MAX_READS; i++) await store.getTxnRpc(ref(txn.id));
    await expect(store.getTxnRpc(ref(txn.id))).resolves.toEqual({
      ok: false,
      reason: 'budget_exceeded',
    });
    const other = await create(store);
    let version = 1;
    for (let i = 0; i < LITE_TXN_MAX_UPDATES; i++) {
      const moved = await store.transitionRpc({
        ...ref(other.id),
        expectedVersion: version,
        to: 'pending',
      });
      if (!moved.ok) throw new Error(moved.reason);
      version = moved.txn.version;
    }
    await expect(
      store.transitionRpc({ ...ref(other.id), expectedVersion: version, to: 'pending' })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
  });
});

describe('LiteTxnStore: policy revision', () => {
  it('refuses a call under another policy revision than the transaction was made under', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const changed = { ...ref(txn.id), policyRevision: 'rev-2' };
    await expect(store.getTxnRpc(changed)).resolves.toEqual({
      ok: false,
      reason: 'policy_changed',
    });
    await expect(
      store.transitionRpc({ ...changed, expectedVersion: 1, to: 'pending' })
    ).resolves.toEqual({ ok: false, reason: 'policy_changed' });
    await expect(store.beginOperationRpc({ ...changed, operationId: 'op' })).resolves.toEqual({
      ok: false,
      reason: 'policy_changed',
    });
    await expect(
      store.transitionRpc({
        ...ref(txn.id),
        policyRevision: 'rev-1',
        expectedVersion: 1,
        to: 'pending',
      })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('LiteTxnStore: idempotent operations', () => {
  it('answers a retry of a finished operation with its result, and a running one as running', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'send-email-1' };
    await expect(store.beginOperationRpc(op)).resolves.toEqual({
      ok: true,
      status: 'started',
      attempt: 1,
    });
    await expect(store.beginOperationRpc(op)).resolves.toEqual({ ok: true, status: 'running' });
    const done = await store.completeOperationRpc({
      attempt: 1,
      ...op,
      result: { attemptId: 'a-1' },
      transition: { expectedVersion: 1, to: 'pending', patch: { email_attempt: 'a-1' } },
    });
    expect(done).toMatchObject({ ok: true, txn: { state: 'pending', version: 2 } });
    await expect(store.beginOperationRpc(op)).resolves.toEqual({
      ok: true,
      status: 'done',
      result: { attemptId: 'a-1' },
    });
    // Completing again changes nothing.
    await expect(
      store.completeOperationRpc({ attempt: 1, ...op, result: 'other' })
    ).resolves.toMatchObject({
      ok: true,
      txn: { version: 2 },
    });
  });

  it('lets a retry start an operation again once its lease ran out', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'op' };
    await store.beginOperationRpc(op);
    vi.advanceTimersByTime(LITE_TXN_OPERATION_LEASE_MS);
    await expect(store.beginOperationRpc(op)).resolves.toEqual({
      ok: true,
      status: 'started',
      attempt: 2,
    });
  });

  it('records the result of a carried-out operation even when its move is refused', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'op' };
    await store.beginOperationRpc(op);
    // A concurrent post moved the transaction meanwhile.
    await store.transitionRpc({ ...ref(txn.id), expectedVersion: 1, to: 'pending' });
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...op,
        result: 'sent',
        transition: { expectedVersion: 1, to: 'verified' },
      })
    ).resolves.toEqual({ ok: false, reason: 'version_mismatch' });
    // A retry gets the result; it does not run the side effect again.
    await expect(store.beginOperationRpc(op)).resolves.toEqual({
      ok: true,
      status: 'done',
      result: 'sent',
    });
  });

  it('records the result after a policy change, but makes no move under it', async () => {
    const { store } = createStore();
    const txn = await create(store);
    await store.beginOperationRpc({ ...ref(txn.id), policyRevision: 'rev-1', operationId: 'op' });
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...ref(txn.id),
        policyRevision: 'rev-2',
        operationId: 'op',
        result: 'sent',
        transition: { expectedVersion: 1, to: 'verified' },
      })
    ).resolves.toEqual({ ok: false, reason: 'policy_changed' });
    await expect(store.getTxnRpc(ref(txn.id))).resolves.toMatchObject({
      ok: true,
      txn: { state: 'open', version: 1 },
    });
    await expect(store.beginOperationRpc({ ...ref(txn.id), operationId: 'op' })).resolves.toEqual({
      ok: true,
      status: 'done',
      result: 'sent',
    });
  });

  it('checks the size of the whole record and the length of keys', async () => {
    const { store } = createStore();
    const txn = await create(store);
    await expect(
      store.beginOperationRpc({
        ...ref(txn.id),
        operationId: 'x'.repeat(LITE_TXN_MAX_KEY_LENGTH + 1),
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    await store.beginOperationRpc({ ...ref(txn.id), operationId: 'op' });
    // A result too large to keep is recorded as such: the operation is final, not run again.
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...ref(txn.id),
        operationId: 'op',
        result: 'r'.repeat(20_000),
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(store.beginOperationRpc({ ...ref(txn.id), operationId: 'op' })).resolves.toEqual({
      ok: true,
      status: 'done',
      result: { error: 'result_too_large' },
    });
    await expect(
      store.issueStartGrantRpc({
        ...ref(txn.id),
        spec: { provider: 'p'.repeat(200), action: 'login', policyRevision: 'rev-1' },
        start: { clientId: 'login-ui', interactionId: null },
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: bound(),
        reuseKey: 'k'.repeat(LITE_TXN_MAX_KEY_LENGTH + 1),
        maxActive: 4,
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('LiteTxnStore: start grants', () => {
  const spec = { provider: 'google', action: 'login' as const, policyRevision: 'rev-1' };
  const start = { clientId: 'login-ui', interactionId: 'interaction-1' };

  it('is used once, and only for the provider, action and revision it was issued for', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const issued = await store.issueStartGrantRpc({ ...ref(txn.id), spec, start });
    if (!issued.ok) throw new Error(issued.reason);
    for (const wrong of [
      { ...spec, provider: 'github' },
      { ...spec, action: 'signup' as const },
      { ...spec, policyRevision: 'rev-2' },
    ]) {
      await expect(
        store.consumeStartGrantRpc({ ...ref(txn.id), grantId: issued.grantId, spec: wrong })
      ).resolves.toEqual({ ok: false, reason: 'grant_invalid' });
    }
    await expect(
      store.consumeStartGrantRpc({ ...ref(txn.id), grantId: issued.grantId, spec })
    ).resolves.toMatchObject({ ok: true, txn: { bound: { clientId: 'client-1' } }, start });
    await expect(
      store.consumeStartGrantRpc({ ...ref(txn.id), grantId: issued.grantId, spec })
    ).resolves.toEqual({ ok: false, reason: 'grant_invalid' });
  });

  it('limits the grants of one transaction', async () => {
    const { store } = createStore();
    const txn = await create(store);
    for (let i = 0; i < LITE_TXN_MAX_START_GRANTS; i++) {
      await store.issueStartGrantRpc({ ...ref(txn.id), spec, start });
    }
    await expect(store.issueStartGrantRpc({ ...ref(txn.id), spec, start })).resolves.toEqual({
      ok: false,
      reason: 'budget_exceeded',
    });
  });

  it('refuses a start it cannot carry, and makes no grant for it', async () => {
    const { store } = createStore();
    const txn = await create(store);
    for (const wrong of [
      { clientId: '', interactionId: null },
      { clientId: 'c'.repeat(LITE_TXN_MAX_KEY_LENGTH + 1), interactionId: null },
      { clientId: 'login-ui', interactionId: 'i'.repeat(LITE_TXN_MAX_KEY_LENGTH + 1) },
      { clientId: 'login-ui', interactionId: '' },
    ]) {
      await expect(
        store.issueStartGrantRpc({ ...ref(txn.id), spec, start: wrong })
      ).resolves.toEqual({ ok: false, reason: 'too_large' });
    }
    // All the grants are still there to be made.
    for (let i = 0; i < LITE_TXN_MAX_START_GRANTS; i++) {
      await expect(
        store.issueStartGrantRpc({ ...ref(txn.id), spec, start })
      ).resolves.toMatchObject({ ok: true });
    }
  });
});

describe('LiteTxnStore: nothing kept for nothing', () => {
  it('keeps no record of a browser whose first transaction was refused', async () => {
    const { store, storage } = createStore();
    await store.createTxnRpc({
      tenantId: 'tenant-a',
      bindingHash: BINDING,
      bound: bound(),
      data: { blob: 'x'.repeat(LITE_TXN_MAX_DATA_BYTES) },
      maxActive: 4,
    });
    expect(storage.data.size).toBe(0);
  });
});

describe('LiteTxnStore: cleanup', () => {
  it('deletes expired transactions and schedules the next expiry', async () => {
    const { store, storage } = createStore();
    const first = await create(store);
    vi.advanceTimersByTime(60_000);
    const second = await create(store);
    vi.setSystemTime(first.expiresAt);
    await store.alarm();
    expect(storage.data.has(`txn:${first.id}`)).toBe(false);
    expect(storage.data.has(`txn:${second.id}`)).toBe(true);
    expect(storage.alarmAt).toBe(second.expiresAt);
    // Once the last one expires, the instance keeps nothing (its claim included).
    vi.setSystemTime(second.expiresAt);
    await store.alarm();
    expect(storage.data.size).toBe(0);
  });

  it('deletes a bounded number per run and comes back for the rest', async () => {
    const { store, storage } = createStore();
    for (let i = 0; i < 130; i++) {
      await storage.put(`txn:old-${i}`, { expiresAt: 0 });
    }
    await store.alarm();
    const left = [...storage.data.keys()].filter((key) => key.startsWith('txn:'));
    expect(left).toHaveLength(2);
    expect(storage.alarmAt).toBe(Date.now() + 1_000);
  });
});

describe('LiteTxnStore: what reaches storage', () => {
  it('stores data and results as JSON, so nothing larger than measured is kept', async () => {
    const { store, storage } = createStore();
    const created = await store.createTxnRpc({
      tenantId: 'tenant-a',
      bindingHash: BINDING,
      bound: bound(),
      data: { blob: new ArrayBuffer(32 * 1024), map: new Map([['a', 1]]) },
      maxActive: 4,
    });
    if (!created.ok) throw new Error(created.reason);
    const id = created.txn.id;
    await store.beginOperationRpc({ ...ref(id), operationId: 'op' });
    await store.completeOperationRpc({
      attempt: 1,
      ...ref(id),
      operationId: 'op',
      result: new Uint8Array(32 * 1024).buffer,
    });
    const stored = storage.data.get(`txn:${id}`) as {
      data: Record<string, unknown>;
      operations: Record<string, { result: unknown }>;
    };
    expect(stored.data).toEqual({ blob: {}, map: {} });
    expect(stored.operations.op?.result).toEqual({});
  });

  it('never takes an inherited property for an operation or grant', async () => {
    const { store } = createStore();
    const txn = await create(store);
    for (const operationId of ['__proto__', 'constructor', 'prototype']) {
      await expect(store.beginOperationRpc({ ...ref(txn.id), operationId })).resolves.toEqual({
        ok: false,
        reason: 'too_large',
      });
    }
    // `toString` is an ordinary ID: the inherited function is not mistaken for it.
    const op = { ...ref(txn.id), operationId: 'toString' };
    await expect(store.beginOperationRpc(op)).resolves.toEqual({
      ok: true,
      status: 'started',
      attempt: 1,
    });
    await expect(store.beginOperationRpc(op)).resolves.toEqual({ ok: true, status: 'running' });
    await expect(
      store.completeOperationRpc({ attempt: 1, ...ref(txn.id), operationId: 'valueOf', result: 1 })
    ).resolves.toEqual({ ok: false, reason: 'not_found' });
    await expect(
      store.consumeStartGrantRpc({
        ...ref(txn.id),
        grantId: 'hasOwnProperty',
        spec: { provider: 'google', action: 'login', policyRevision: 'rev-1' },
      })
    ).resolves.toEqual({ ok: false, reason: 'grant_invalid' });
  });

  it('counts operations against the change budget, keeping room to record each result', async () => {
    const { store } = createStore();
    const txn = await create(store);
    // Each start takes two changes (itself and the result it reserves).
    const starts = Math.floor(LITE_TXN_MAX_UPDATES / 2);
    for (let i = 0; i < starts - 1; i++) {
      await store.beginOperationRpc({ ...ref(txn.id), operationId: `op-${i}` });
      await store.completeOperationRpc({
        attempt: 1,
        ...ref(txn.id),
        operationId: `op-${i}`,
        result: i,
      });
    }
    await expect(
      store.beginOperationRpc({ ...ref(txn.id), operationId: 'last' })
    ).resolves.toMatchObject({ ok: true, status: 'started' });
    await expect(
      store.beginOperationRpc({ ...ref(txn.id), operationId: 'one-more' })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
    // The last started operation can still record its result.
    await expect(
      store.completeOperationRpc({ attempt: 1, ...ref(txn.id), operationId: 'last', result: 'x' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      store.transitionRpc({ ...ref(txn.id), expectedVersion: 1, to: 'pending' })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
  });

  it('makes the move a completion asks for with the change its start reserved, at the limit', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const starts = Math.floor(LITE_TXN_MAX_UPDATES / 2);
    for (let i = 0; i < starts - 1; i++) {
      await store.beginOperationRpc({ ...ref(txn.id), operationId: `op-${i}` });
      await store.completeOperationRpc({
        attempt: 1,
        ...ref(txn.id),
        operationId: `op-${i}`,
        result: i,
      });
    }
    await store.beginOperationRpc({ ...ref(txn.id), operationId: 'last' });
    // The budget is spent now; the side effect was carried out: what it leaves is recorded.
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...ref(txn.id),
        operationId: 'last',
        result: 'x',
        transition: { expectedVersion: 1, to: 'verified', patch: { checked: 'artifact' } },
      })
    ).resolves.toMatchObject({
      ok: true,
      txn: { state: 'verified', data: { checked: 'artifact' } },
    });
    // And nothing more: an ordinary move is still refused.
    await expect(
      store.transitionRpc({ ...ref(txn.id), expectedVersion: 2, to: 'pending' })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
  });

  it('keeps the room it promised a running operation, so its result is always recorded', async () => {
    const { store } = createStore();
    const txn = await create(store);
    await store.beginOperationRpc({ ...ref(txn.id), operationId: 'a' });
    // Other writes fill the record up to what is left beside the reserved room.
    let version = 1;
    for (let i = 0; ; i++) {
      const moved = await store.transitionRpc({
        ...ref(txn.id),
        expectedVersion: version,
        to: 'pending',
        patch: { [`k${i}`]: 'v'.repeat(1_000) },
      });
      if (!moved.ok) {
        expect(moved.reason).toMatch(/too_large|budget_exceeded/u);
        break;
      }
      version = moved.txn.version;
    }
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...ref(txn.id),
        operationId: 'a',
        result: 'r'.repeat(900),
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it('answers a resent completion as the first one did, without moving again', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'op' };
    await store.beginOperationRpc(op);
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...op,
        result: 'x',
        transition: { expectedVersion: 1, to: 'verified' },
      })
    ).resolves.toMatchObject({ ok: true, txn: { state: 'verified', version: 2 } });
    // The same completion again, even with another move: nothing moves.
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...op,
        result: 'x',
        transition: { expectedVersion: 2, to: 'completed' },
      })
    ).resolves.toMatchObject({ ok: true, txn: { state: 'verified', version: 2 } });
  });

  it('counts a resent completion as a read', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'op' };
    await store.beginOperationRpc(op);
    await store.completeOperationRpc({ attempt: 1, ...op, result: 'x' });
    for (let i = 0; i < LITE_TXN_MAX_READS; i++) await store.getTxnRpc(ref(txn.id));
    await expect(store.completeOperationRpc({ attempt: 1, ...op, result: 'x' })).resolves.toEqual({
      ok: false,
      reason: 'budget_exceeded',
    });
  });

  it('stores only checked bound values', async () => {
    const { store } = createStore();
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: { ...bound(), clientId: new ArrayBuffer(64 * 1024) as unknown as string },
        maxActive: 4,
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: { ...bound(), purpose: 'admin' as 'login' },
        maxActive: 4,
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('LiteTxnStore: completions that could not be stored as given', () => {
  it('records a result that is not JSON as a fixed marker, and the operation is final', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const [operationId, result] of [
      ['big', 1n],
      ['cycle', cycle],
    ] as const) {
      const op = { ...ref(txn.id), operationId };
      await store.beginOperationRpc(op);
      await expect(
        store.completeOperationRpc({ attempt: 1, ...op, result })
      ).resolves.toMatchObject({
        ok: true,
      });
      await expect(store.beginOperationRpc(op)).resolves.toEqual({
        ok: true,
        status: 'done',
        result: { error: 'result_invalid' },
      });
    }
  });

  it('records the result when the move asked for with it carries a value that is not JSON', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'op' };
    await store.beginOperationRpc(op);
    await expect(
      store.completeOperationRpc({
        attempt: 1,
        ...op,
        result: 'sent',
        transition: { expectedVersion: 1, to: 'pending', patch: { x: 2n } },
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    await expect(store.beginOperationRpc(op)).resolves.toEqual({
      ok: true,
      status: 'done',
      result: 'sent',
    });
  });

  it('completes and answers again right at the record limit', async () => {
    const { store, storage } = createStore();
    // Long bound values make the record large without reaching the data limit.
    const created = await store.createTxnRpc({
      tenantId: 'tenant-a',
      bindingHash: BINDING,
      bound: bound({ returnTo: `https://rp.example/${'p'.repeat(2_000)}` }),
      data: { a: 'x'.repeat(7_000) },
      maxActive: 4,
    });
    if (!created.ok) throw new Error(created.reason);
    const id = created.txn.id;
    // The operation to complete at the limit starts first: its room is reserved from now on.
    await expect(
      store.beginOperationRpc({ ...ref(id), operationId: 'last' })
    ).resolves.toMatchObject({ ok: true, status: 'started' });
    // Completed operations with full-size results fill most of what is left.
    for (let index = 0; ; index++) {
      const op = { ...ref(id), operationId: `fill-${index}` };
      const begun = await store.beginOperationRpc(op);
      if (!begun.ok) break;
      await store.completeOperationRpc({
        ...op,
        attempt: 1,
        result: 'r'.repeat(LITE_TXN_MAX_RESULT_BYTES - 2),
      });
    }
    // Then data, in ever smaller pieces, up to the last bytes the reserve leaves.
    let version = 1;
    for (let size = 512; size >= 1; ) {
      const moved = await store.transitionRpc({
        ...ref(id),
        expectedVersion: version,
        to: 'pending',
        patch: { [`f${version}`]: 'v'.repeat(size) },
      });
      if (moved.ok) version = moved.txn.version;
      else if (moved.reason === 'too_large') size = Math.floor(size / 2);
      else break;
    }
    const recordBytes = () =>
      new TextEncoder().encode(JSON.stringify(storage.data.get(`txn:${id}`))).byteLength;
    // At the limit: the record and the one reserve leave less than a small field of room.
    expect(recordBytes()).toBeGreaterThan(
      LITE_TXN_MAX_RECORD_BYTES - LITE_TXN_MAX_RESULT_BYTES - 300
    );
    const result = 'r'.repeat(LITE_TXN_MAX_RESULT_BYTES - 2);
    await expect(
      store.completeOperationRpc({
        ...ref(id),
        operationId: 'last',
        attempt: 1,
        result,
        transition: { expectedVersion: version, to: 'verified', patch: { more: 'x'.repeat(500) } },
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(recordBytes()).toBeLessThanOrEqual(LITE_TXN_MAX_RECORD_BYTES);
    await expect(store.getTxnRpc(ref(id))).resolves.toMatchObject({ ok: true });
    await expect(store.beginOperationRpc({ ...ref(id), operationId: 'last' })).resolves.toEqual({
      ok: true,
      status: 'done',
      result,
    });
  });

  it('refuses a late completion from an earlier attempt after a retry started again', async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'op' };
    await store.beginOperationRpc(op);
    vi.advanceTimersByTime(LITE_TXN_OPERATION_LEASE_MS);
    await expect(store.beginOperationRpc(op)).resolves.toMatchObject({ attempt: 2 });
    await expect(
      store.completeOperationRpc({ ...op, attempt: 1, result: 'failed' })
    ).resolves.toEqual({ ok: false, reason: 'superseded' });
    await expect(
      store.completeOperationRpc({ ...op, attempt: 2, result: 'sent' })
    ).resolves.toMatchObject({ ok: true });
    await expect(store.beginOperationRpc(op)).resolves.toEqual({
      ok: true,
      status: 'done',
      result: 'sent',
    });
  });

  it("refuses a late completion from an earlier attempt after the retry's own completion", async () => {
    const { store } = createStore();
    const txn = await create(store);
    const op = { ...ref(txn.id), operationId: 'op' };
    await store.beginOperationRpc(op);
    vi.advanceTimersByTime(LITE_TXN_OPERATION_LEASE_MS);
    await store.beginOperationRpc(op);
    await expect(
      store.completeOperationRpc({ ...op, attempt: 2, result: 'sent' })
    ).resolves.toMatchObject({ ok: true });
    // Not the later attempt's answer: the earlier one learns it lost the operation.
    await expect(
      store.completeOperationRpc({ ...op, attempt: 1, result: 'late' })
    ).resolves.toEqual({ ok: false, reason: 'superseded' });
    // The later attempt's own resend still reads its completion back.
    await expect(
      store.completeOperationRpc({ ...op, attempt: 2, result: 'sent' })
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses a session or user on a sign-in or sign-up', async () => {
    const { store } = createStore();
    for (const purpose of ['login', 'signup'] as const) {
      await expect(
        store.createTxnRpc({
          tenantId: 'tenant-a',
          bindingHash: BINDING,
          bound: bound({ purpose, sessionId: 's1', userId: null }),
          maxActive: 4,
        })
      ).resolves.toEqual({ ok: false, reason: 'too_large' });
    }
  });

  it('refuses a call for another public origin than the transaction was made on', async () => {
    const { store } = createStore();
    const txn = await create(store);
    await expect(
      store.getTxnRpc({ ...ref(txn.id), publicOrigin: 'https://other.example' })
    ).resolves.toEqual({ ok: false, reason: 'binding_mismatch' });
    await expect(
      store.getTxnRpc({ ...ref(txn.id), publicOrigin: 'https://id.example' })
    ).resolves.toMatchObject({ ok: true });
  });

  it('requires the signed-in session and user for account and re-authentication', async () => {
    const { store } = createStore();
    for (const purpose of ['account', 'reauth'] as const) {
      for (const who of [
        { sessionId: null, userId: null },
        { sessionId: 's1', userId: null },
        { sessionId: null, userId: 'u1' },
      ]) {
        await expect(
          store.createTxnRpc({
            tenantId: 'tenant-a',
            bindingHash: BINDING,
            bound: bound({ purpose, ...who }),
            maxActive: 4,
          })
        ).resolves.toEqual({ ok: false, reason: 'too_large' });
      }
      await expect(
        store.createTxnRpc({
          tenantId: 'tenant-a',
          bindingHash: BINDING,
          bound: bound({ purpose, sessionId: 's1', userId: 'u1' }),
          maxActive: 4,
        })
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it('counts a reload by reuse key as a read', async () => {
    const { store } = createStore();
    const first = await create(store, { reuseKey: 'k' });
    for (let i = 0; i < LITE_TXN_MAX_READS; i++) await store.getTxnRpc(ref(first.id));
    await expect(
      store.createTxnRpc({
        tenantId: 'tenant-a',
        bindingHash: BINDING,
        bound: bound(),
        reuseKey: 'k',
        maxActive: 4,
      })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
  });
});

describe('LiteTxnStore: finishing', () => {
  it('completes from pending, and finishes even with the change budget spent', async () => {
    const { store } = createStore();
    const txn = await create(store);
    let version = 1;
    for (let i = 0; i < LITE_TXN_MAX_UPDATES; i++) {
      const moved = await store.transitionRpc({
        ...ref(txn.id),
        expectedVersion: version,
        to: 'pending',
      });
      if (!moved.ok) break;
      version = moved.txn.version;
    }
    await expect(
      store.transitionRpc({ ...ref(txn.id), expectedVersion: version, to: 'pending' })
    ).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
    await expect(
      store.transitionRpc({ ...ref(txn.id), expectedVersion: version, to: 'completed' })
    ).resolves.toMatchObject({ ok: true, txn: { state: 'completed' } });
  });
});
