import { beforeEach, describe, expect, it } from 'vitest';
import { LitePolicyStore } from '@authrim/ar-lib-core/durable-objects/LitePolicyStore';
import { LiteTxnStore } from '@authrim/ar-lib-core/durable-objects/LiteTxnStore';
import { resetLitePolicyRuntimeCache } from '@authrim/ar-lib-core/services/lite-policy';
import { LITE_TXN_AUDIENCE, LiteTxnEntrypoint } from '../lite-txn-entrypoint';

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
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }
}

const BINDING = 'b'.repeat(43);
const ORIGIN = 'https://id.example';

let policy: LitePolicyStore;
let txnStores: Map<string, LiteTxnStore>;
let counts: Map<string, number>;
let env: Record<string, unknown>;

async function setPolicy(liteMode: 'off' | 'always') {
  if (liteMode === 'always') await policy.markEverLiteRpc('default');
  resetLitePolicyRuntimeCache();
  const lease = await policy.acquireLeaseRpc('default');
  if (!lease.acquired) throw new Error('lease');
  const result = await policy.commitRpc({
    tenantId: 'default',
    token: lease.token,
    expectedGeneration: lease.generation,
    liteMode,
    humanVerificationRequired: { login: true, signup: true, reauth: false },
  });
  if (!result.committed) throw new Error('commit');
  return result.snapshot;
}

function entry(props: Record<string, unknown> = {}) {
  return new LiteTxnEntrypoint(
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {
        caller: 'ar-login-ui',
        audience: LITE_TXN_AUDIENCE,
        environmentId: 'test',
        ...props,
      },
    } as never,
    env as never
  );
}

beforeEach(() => {
  resetLitePolicyRuntimeCache();
  policy = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
  txnStores = new Map();
  counts = new Map();
  env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    LITE_POLICY_STORE: { idFromName: (n: string) => n, get: () => policy },
    LITE_TXN_STORE: {
      idFromName: (n: string) => n,
      get: (id: string) => {
        if (!txnStores.has(id)) {
          txnStores.set(id, new LiteTxnStore({ storage: new Storage() } as never, {} as never));
        }
        return txnStores.get(id);
      },
    },
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({
        incrementRpc: async (key: string, config: { maxRequests: number }) => {
          const current = (counts.get(key) ?? 0) + 1;
          counts.set(key, current);
          return {
            allowed: current <= config.maxRequests,
            current,
            limit: config.maxRequests,
            resetAt: Math.floor(Date.now() / 1000) + 60,
            retryAfter: 60,
          };
        },
      }),
    },
    SETTINGS: {
      get: async (key: string) =>
        key === 'settings:tenant:default:authentication-methods'
          ? JSON.stringify({
              'authentication-methods.human_verification.lite_txn_per_ip_per_minute': 2,
              'authentication-methods.human_verification.lite_txn_per_browser': 3,
            })
          : null,
    },
  };
});

const call = { publicOrigin: ORIGIN, binding: BINDING };

describe('LiteTxnEntrypoint', () => {
  it('exposes no internal method to RPC', () => {
    // A TypeScript `private` method is callable over RPC; the internal ones are `#` methods.
    const exposed = Object.getOwnPropertyNames(LiteTxnEntrypoint.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(exposed.sort()).toEqual(
      [
        'beginOperation',
        'completeOperation',
        'create',
        'get',
        'issueStartGrant',
        'transition',
      ].sort()
    );
    const store = Object.getOwnPropertyNames(LiteTxnStore.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(store.sort()).toEqual(
      [
        'alarm',
        'beginOperationRpc',
        'completeOperationRpc',
        'consumeStartGrantRpc',
        'createTxnRpc',
        'getTxnRpc',
        'issueStartGrantRpc',
        'transitionRpc',
      ].sort()
    );
  });

  it('is for the Login UI of this environment only', async () => {
    await setPolicy('always');
    for (const props of [
      { caller: 'ar-router' },
      { audience: 'other' },
      { environmentId: 'prod' },
    ]) {
      await expect(
        entry(props).create({ ...call, clientIp: '203.0.113.1', purpose: 'login' })
      ).rejects.toThrow('lite_txn_unauthorized');
    }
  });

  it('makes a transaction bound to the tenant of the public origin and its policy revision', async () => {
    const snapshot = await setPolicy('always');
    const created = await entry().create({
      ...call,
      clientIp: '203.0.113.1',
      purpose: 'login',
      clientId: 'client-1',
      challengeId: 'challenge-1',
    });
    expect(created).toMatchObject({
      ok: true,
      txn: {
        state: 'open',
        bound: {
          tenantId: 'default',
          publicOrigin: ORIGIN,
          clientId: 'client-1',
          policyRevision: snapshot.policyRevision,
        },
      },
    });
    // The store instance is named by the binding's hash, never the binding itself.
    const [name] = [...txnStores.keys()];
    expect(name).toMatch(/^lite-txn:default:[0-9a-f]{64}$/u);
    expect(name).not.toContain(BINDING);
  });

  it('refuses a tenant not in lite mode, and a malformed binding or origin', async () => {
    await setPolicy('off');
    await expect(entry().create({ ...call, clientIp: null, purpose: 'login' })).resolves.toEqual({
      ok: false,
      reason: 'not_lite',
    });
    await setPolicy('always');
    await expect(
      entry().create({ ...call, binding: 'short', clientIp: null, purpose: 'login' })
    ).resolves.toEqual({ ok: false, reason: 'invalid_binding' });
    await expect(
      entry().create({
        ...call,
        publicOrigin: 'https://id.example/path',
        clientIp: null,
        purpose: 'login',
      })
    ).resolves.toEqual({ ok: false, reason: 'tenant_unknown' });
  });

  it('counts creations per IP and per browser', async () => {
    await setPolicy('always');
    const create = (clientIp: string, binding = BINDING) =>
      entry().create({ ...call, binding, clientIp, purpose: 'login' });
    await expect(create('203.0.113.1')).resolves.toMatchObject({ ok: true });
    await expect(create('203.0.113.1')).resolves.toMatchObject({ ok: true });
    await expect(create('203.0.113.1')).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
    // Another IP, same browser: the browser's limit of live transactions (3) applies.
    await expect(create('203.0.113.2')).resolves.toMatchObject({ ok: true });
    await expect(create('203.0.113.3')).resolves.toEqual({ ok: false, reason: 'budget_exceeded' });
  });

  it('refuses a transaction of an earlier policy revision, before any change', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    // The tenant's policy changes (stricter requirements: a new revision).
    resetLitePolicyRuntimeCache();
    const lease = await policy.acquireLeaseRpc('default');
    if (!lease.acquired) throw new Error('lease');
    await policy.commitRpc({
      tenantId: 'default',
      token: lease.token,
      expectedGeneration: lease.generation,
      liteMode: 'always',
      humanVerificationRequired: { login: true, signup: true, reauth: true },
    });
    resetLitePolicyRuntimeCache();
    const txnId = created.txn.id;
    await expect(entry().get({ ...call, txnId })).resolves.toEqual({
      ok: false,
      reason: 'policy_changed',
    });
    await expect(
      entry().transition({ ...call, txnId, expectedVersion: 1, to: 'pending' })
    ).resolves.toEqual({ ok: false, reason: 'policy_changed' });
    await expect(
      entry().issueStartGrant({ ...call, txnId, provider: 'google', action: 'login' })
    ).resolves.toEqual({ ok: false, reason: 'policy_changed' });
  });

  it('keeps another browser out of a transaction', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    await expect(
      entry().get({ ...call, binding: 'c'.repeat(43), txnId: created.txn.id })
    ).resolves.toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('records an operation result even after the policy changed', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    const txnId = created.txn.id;
    await expect(entry().beginOperation({ ...call, txnId, operationId: 'op' })).resolves.toEqual({
      ok: true,
      status: 'started',
      attempt: 1,
    });
    await setPolicy('always');
    resetLitePolicyRuntimeCache();
    const lease = await policy.acquireLeaseRpc('default');
    if (lease.acquired) {
      await policy.commitRpc({
        tenantId: 'default',
        token: lease.token,
        expectedGeneration: lease.generation,
        liteMode: 'always',
        humanVerificationRequired: { login: false, signup: false, reauth: false },
      });
    }
    resetLitePolicyRuntimeCache();
    await expect(
      entry().completeOperation({
        attempt: 1,
        ...call,
        txnId,
        operationId: 'op',
        result: { sent: true },
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses a change under an earlier revision at once, with the runtime cache still warm', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    // The policy changes; the runtime cache of this isolate is NOT reset.
    const lease = await policy.acquireLeaseRpc('default');
    if (!lease.acquired) throw new Error('lease');
    await policy.commitRpc({
      tenantId: 'default',
      token: lease.token,
      expectedGeneration: lease.generation,
      liteMode: 'always',
      humanVerificationRequired: { login: true, signup: true, reauth: true },
    });
    const txnId = created.txn.id;
    await expect(entry().beginOperation({ ...call, txnId, operationId: 'op' })).resolves.toEqual({
      ok: false,
      reason: 'policy_changed',
    });
    await expect(
      entry().issueStartGrant({ ...call, txnId, provider: 'google', action: 'login' })
    ).resolves.toEqual({ ok: false, reason: 'policy_changed' });
  });

  it('records a result after the tenant left lite mode, and makes no move', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    const txnId = created.txn.id;
    await entry().beginOperation({ ...call, txnId, operationId: 'op' });
    await setPolicy('off');
    await expect(
      entry().completeOperation({
        attempt: 1,
        ...call,
        txnId,
        operationId: 'op',
        result: 'sent',
        transition: { expectedVersion: 1, to: 'pending' },
      })
    ).resolves.toEqual({ ok: false, reason: 'policy_changed' });
    // The result was recorded: back in lite mode, a retry gets it.
    await setPolicy('always');
    const store = [...txnStores.values()][0];
    const record = [
      ...(store as unknown as { ctx: { storage: Storage } }).ctx.storage.data.values(),
    ].find((value) => (value as { id?: string }).id === txnId) as {
      operations: Record<string, { status: string; result: unknown }>;
    };
    expect(record.operations.op).toMatchObject({ status: 'done', result: 'sent' });
  });
});
