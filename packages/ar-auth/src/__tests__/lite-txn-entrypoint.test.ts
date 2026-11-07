import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LitePolicyStore } from '@authrim/ar-lib-core/durable-objects/LitePolicyStore';
import { LiteTxnStore } from '@authrim/ar-lib-core/durable-objects/LiteTxnStore';
import { resetLitePolicyRuntimeCache } from '@authrim/ar-lib-core/services/lite-policy';
import { tenantPrimaryVanityDomainCacheKey } from '@authrim/ar-lib-core/services/tenant-vanity-domain-resolver';
import { consumeLiteStartGrant } from '@authrim/ar-lib-core';
import { LITE_TXN_AUDIENCE, LiteTxnEntrypoint, checkedReturnTo } from '../lite-txn-entrypoint';

const humanVerification = vi.hoisted(() => ({ verify: vi.fn(), challengeKind: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  verifyHumanVerificationWithRunner: humanVerification.verify,
  readAuthorizationChallengeKind: humanVerification.challengeKind,
}));

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
  humanVerification.verify.mockReset();
  humanVerification.verify.mockResolvedValue({ required: true, verified: true });
  humanVerification.challengeKind.mockReset();
  humanVerification.challengeKind.mockResolvedValue('login');
  policy = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
  txnStores = new Map();
  counts = new Map();
  env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    // The tenant's canonical issuer: ISSUER_URL, with no primary vanity domain.
    ISSUER_URL: ORIGIN,
    AUTHRIM_CONFIG: {
      get: async (key: string) =>
        key === tenantPrimaryVanityDomainCacheKey('default')
          ? '__authrim_no_primary_vanity_domain__'
          : null,
      put: async () => undefined,
    },
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
      entry().issueStartGrant({ ...call, txnId, provider: 'google', clientId: 'login-ui' })
    ).resolves.toEqual({
      ok: false,
      reason: 'policy_changed',
    });
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
      entry().issueStartGrant({ ...call, txnId, provider: 'google', clientId: 'login-ui' })
    ).resolves.toEqual({
      ok: false,
      reason: 'policy_changed',
    });
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

  it('refuses account and re-authentication transactions until their session check exists', async () => {
    await setPolicy('always');
    for (const purpose of ['account', 'reauth'] as const) {
      await expect(
        entry().create({
          ...call,
          clientIp: null,
          purpose,
          sessionId: 'someone-else',
          userId: 'u-other',
        })
      ).resolves.toEqual({ ok: false, reason: 'unsupported_purpose' });
    }
    expect(txnStores.size).toBe(0);
  });

  it('keeps only a return target of the public origin or a local path', async () => {
    await setPolicy('always');
    await expect(
      entry().create({
        ...call,
        clientIp: null,
        purpose: 'login',
        returnTo: 'https://evil.example/x',
      })
    ).resolves.toEqual({ ok: false, reason: 'invalid_return_to' });
    await expect(
      entry().create({ ...call, clientIp: null, purpose: 'login', returnTo: `${ORIGIN}/account` })
    ).resolves.toMatchObject({ ok: true, txn: { bound: { returnTo: `${ORIGIN}/account` } } });
  });
});

describe('checkedReturnTo', () => {
  it('allows the public origin and local paths only', () => {
    expect(checkedReturnTo(undefined, ORIGIN)).toBeNull();
    expect(checkedReturnTo('/authorize?x=1', ORIGIN)).toBe('/authorize?x=1');
    expect(checkedReturnTo(`${ORIGIN}/a`, ORIGIN)).toBe(`${ORIGIN}/a`);
    for (const bad of [
      '//evil.example/x',
      '/\\evil.example/x',
      'https://evil.example/',
      'https://id.example.evil/',
      'javascript:alert(1)',
      'https://user@id.example/account',
      'blob:https://id.example/1234',
      '/a\nb',
      'x'.repeat(3000),
      42,
    ]) {
      expect(checkedReturnTo(bad, ORIGIN)).toBeUndefined();
    }
  });

  it('checks the URL as a URL: case, default port, user info, length', () => {
    expect(checkedReturnTo('HTTPS://ID.EXAMPLE:443/a', ORIGIN)).toBe('HTTPS://ID.EXAMPLE:443/a');
    expect(checkedReturnTo('https://id.example:444/a', ORIGIN)).toBeUndefined();
    expect(checkedReturnTo('https://id.example@evil.example/', ORIGIN)).toBeUndefined();
    expect(checkedReturnTo('https://evil.example@id.example/', ORIGIN)).toBeUndefined();
    expect(checkedReturnTo(`/${'a'.repeat(2047)}`, ORIGIN)).toBe(`/${'a'.repeat(2047)}`);
    expect(checkedReturnTo(`/${'a'.repeat(2048)}`, ORIGIN)).toBeUndefined();
  });
});

describe('LiteTxnEntrypoint refusals before the store', () => {
  it('checks the caller first, whatever the refusal', async () => {
    await setPolicy('always');
    const refused = [
      { purpose: 'account' as const, sessionId: 's', userId: 'u' },
      { purpose: 'login' as const, returnTo: 'https://evil.example/' },
    ];
    for (const props of [{ caller: 'x' }, { audience: 'x' }, { environmentId: 'x' }]) {
      for (const input of refused) {
        await expect(entry(props).create({ ...call, clientIp: null, ...input })).rejects.toThrow(
          'lite_txn_unauthorized'
        );
      }
    }
    expect(txnStores.size).toBe(0);
  });

  it('makes no transaction for a malformed public origin, whatever the return target', async () => {
    await setPolicy('always');
    await expect(
      entry().create({
        ...call,
        publicOrigin: 'https://id.example/path',
        clientIp: null,
        purpose: 'login',
        returnTo: '/authorize',
      })
    ).resolves.toEqual({ ok: false, reason: 'tenant_unknown' });
    expect(txnStores.size).toBe(0);
  });

  it('makes a transaction only on the tenant canonical issuer origin', async () => {
    await setPolicy('always');
    // Another host of the same tenant (single-tenant mode resolves any host to it).
    await expect(
      entry().create({
        ...call,
        publicOrigin: 'https://ui.example.workers.dev',
        clientIp: null,
        purpose: 'login',
      })
    ).resolves.toEqual({ ok: false, reason: 'origin_not_canonical', canonicalOrigin: ORIGIN });
    // No transaction was made (a store stub may be addressed; nothing is written to it).
    const written = [...txnStores.values()].flatMap((store) => [
      ...(
        store as unknown as { ctx: { storage: { data: Map<string, unknown> } } }
      ).ctx.storage.data.keys(),
    ]);
    expect(written).toEqual([]);
  });

  it('keeps a transaction to the origin it was made on', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    await expect(
      entry().get({
        ...call,
        publicOrigin: 'https://ui.example.workers.dev',
        txnId: created.txn.id,
      })
    ).resolves.toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it('stores no session or user for a sign-in or sign-up, whatever the caller passes', async () => {
    await setPolicy('always');
    for (const purpose of ['login', 'signup'] as const) {
      const created = await entry().create({
        ...call,
        clientIp: null,
        purpose,
        sessionId: 'asserted-session',
        userId: 'asserted-user',
      });
      expect(created).toMatchObject({
        ok: true,
        txn: { bound: { sessionId: null, userId: null } },
      });
    }
  });

  it('gives a start grant the transaction purpose as its action', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'signup' });
    if (!created.ok) throw new Error(created.reason);
    const issued = await entry().issueStartGrant({
      ...call,
      txnId: created.txn.id,
      provider: 'google',
      clientId: 'login-ui',
      action: 'login',
    } as never);
    expect(issued).toMatchObject({ ok: true });
    const store = [...txnStores.values()][0] as unknown as {
      ctx: { storage: { data: Map<string, unknown> } };
    };
    const record = [...store.ctx.storage.data.values()].find(
      (value) => (value as { id?: string }).id === created.txn.id
    ) as { grants: Record<string, { spec: { action: string } }> };
    expect(Object.values(record.grants)[0]?.spec.action).toBe('signup');
  });

  it('reads a transaction against the current policy when asked, with the cache still warm', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    const lease = await policy.acquireLeaseRpc('default');
    if (!lease.acquired) throw new Error('lease');
    await policy.commitRpc({
      tenantId: 'default',
      token: lease.token,
      expectedGeneration: lease.generation,
      liteMode: 'always',
      humanVerificationRequired: { login: false, signup: false, reauth: false },
    });
    const txnId = created.txn.id;
    // The cached read still says the old revision; the current one refuses.
    await expect(entry().get({ ...call, txnId })).resolves.toMatchObject({ ok: true });
    await expect(entry().get({ ...call, txnId, current: true })).resolves.toEqual({
      ok: false,
      reason: 'policy_changed',
    });
  });

  it('sends another host of the tenant to the canonical origin before checking the return target', async () => {
    await setPolicy('always');
    await expect(
      entry().create({
        ...call,
        publicOrigin: 'https://ui.example.workers.dev',
        clientIp: null,
        purpose: 'login',
        returnTo: `${ORIGIN}/account`,
      })
    ).resolves.toEqual({ ok: false, reason: 'origin_not_canonical', canonicalOrigin: ORIGIN });
  });
});

describe('LiteTxnEntrypoint start grants', () => {
  function storedGrants(txnId: string) {
    const record = [...txnStores.values()]
      .flatMap((store) => [
        ...(
          store as unknown as { ctx: { storage: { data: Map<string, unknown> } } }
        ).ctx.storage.data.values(),
      ])
      .find((value) => (value as { id?: string }).id === txnId) as {
      grants: Record<string, { consumed: boolean }>;
    };
    return Object.values(record.grants);
  }

  it.each([
    ['login', ['signup']],
    ['signup', ['login']],
  ] as const)(
    'verifies the proof for a %s, with the requirement of the other (JIT, or signing in)',
    async (purpose, alsoRequiredFor) => {
      await setPolicy('always');
      const created = await entry().create({ ...call, clientIp: null, purpose });
      if (!created.ok) throw new Error(created.reason);
      await expect(
        entry().issueStartGrant({
          ...call,
          txnId: created.txn.id,
          provider: 'google',
          clientId: 'login-ui',
          humanVerificationResponse: 'proof',
        })
      ).resolves.toMatchObject({ ok: true });
      expect(humanVerification.verify).toHaveBeenCalledWith(expect.anything(), {
        tenantId: 'default',
        action: purpose,
        alsoRequiredFor,
        responseToken: 'proof',
      });
    }
  );

  it.each(['reauth', null] as const)(
    'makes no grant for a sign-in that answers a %s challenge, spending no proof',
    async (kind) => {
      await setPolicy('always');
      humanVerification.challengeKind.mockResolvedValue(kind);
      const created = await entry().create({
        ...call,
        clientIp: null,
        purpose: 'login',
        challengeId: 'challenge-1',
      });
      if (!created.ok) throw new Error(created.reason);
      await expect(
        entry().issueStartGrant({
          ...call,
          txnId: created.txn.id,
          provider: 'google',
          clientId: 'login-ui',
          humanVerificationResponse: 'proof',
        })
      ).resolves.toEqual({ ok: false, reason: 'unsupported_purpose' });
      expect(humanVerification.challengeKind).toHaveBeenCalledWith(
        expect.anything(),
        'default',
        'challenge-1'
      );
      expect(humanVerification.verify).not.toHaveBeenCalled();
      expect(storedGrants(created.txn.id)).toEqual([]);
    }
  );

  it('makes no grant when the proof does not verify, or its check fails', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    humanVerification.verify.mockResolvedValueOnce({ required: true, verified: false });
    humanVerification.verify.mockRejectedValueOnce(new Error('store down'));
    for (let i = 0; i < 2; i++) {
      await expect(
        entry().issueStartGrant({
          ...call,
          txnId: created.txn.id,
          provider: 'google',
          clientId: 'login-ui',
          humanVerificationResponse: 'proof',
        })
      ).resolves.toEqual({ ok: false, reason: 'human_verification_failed' });
    }
    expect(storedGrants(created.txn.id)).toEqual([]);
  });

  it('spends no proof for a transaction it cannot use, nor without the UI client', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    await expect(
      entry().issueStartGrant({
        ...call,
        txnId: 'missing',
        provider: 'google',
        clientId: 'login-ui',
        humanVerificationResponse: 'proof',
      })
    ).resolves.toEqual({ ok: false, reason: 'not_found' });
    await expect(
      entry().issueStartGrant({
        ...call,
        txnId: created.txn.id,
        provider: 'google',
        clientId: '',
        humanVerificationResponse: 'proof',
      })
    ).resolves.toEqual({ ok: false, reason: 'invalid_request' });
    expect(humanVerification.verify).not.toHaveBeenCalled();
  });

  it('carries the UI client and the interaction to the start that consumes it, once', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    const issued = await entry().issueStartGrant({
      ...call,
      txnId: created.txn.id,
      provider: 'google',
      clientId: 'login-ui',
      interactionId: 'interaction-1',
      humanVerificationResponse: 'proof',
    });
    if (!issued.ok) throw new Error(issued.reason);
    const consume = (overrides: Record<string, unknown> = {}) =>
      consumeLiteStartGrant(env as never, {
        tenantId: 'default',
        binding: BINDING,
        txnId: created.txn.id,
        grantId: issued.grantId,
        provider: 'google',
        ...overrides,
      });
    // Another browser, another provider: refused, and the grant is still there.
    await expect(consume({ binding: 'c'.repeat(43) })).resolves.toEqual({
      ok: false,
      reason: 'binding_mismatch',
    });
    // Another tenant's store instance does not hold it.
    await expect(consume({ tenantId: 'other' })).resolves.toMatchObject({ ok: false });
    await expect(consume({ provider: 'github' })).resolves.toEqual({
      ok: false,
      reason: 'grant_invalid',
    });
    await expect(consume()).resolves.toMatchObject({
      ok: true,
      txn: { id: created.txn.id, bound: { purpose: 'login', publicOrigin: ORIGIN } },
      start: { clientId: 'login-ui', interactionId: 'interaction-1' },
    });
    await expect(consume()).resolves.toEqual({ ok: false, reason: 'grant_invalid' });
  });

  it('consumes no grant once the tenant changed its policy or left lite mode', async () => {
    await setPolicy('always');
    const created = await entry().create({ ...call, clientIp: null, purpose: 'login' });
    if (!created.ok) throw new Error(created.reason);
    const issued = await entry().issueStartGrant({
      ...call,
      txnId: created.txn.id,
      provider: 'google',
      clientId: 'login-ui',
      humanVerificationResponse: 'proof',
    });
    if (!issued.ok) throw new Error(issued.reason);
    const consume = () =>
      consumeLiteStartGrant(env as never, {
        tenantId: 'default',
        binding: BINDING,
        txnId: created.txn.id,
        grantId: issued.grantId,
        provider: 'google',
      });
    const lease = await policy.acquireLeaseRpc('default');
    if (!lease.acquired) throw new Error('lease');
    await policy.commitRpc({
      tenantId: 'default',
      token: lease.token,
      expectedGeneration: lease.generation,
      liteMode: 'always',
      humanVerificationRequired: { login: true, signup: false, reauth: false },
    });
    await expect(consume()).resolves.toEqual({ ok: false, reason: 'policy_changed' });
    await setPolicy('off');
    await expect(consume()).resolves.toEqual({ ok: false, reason: 'not_lite' });
  });
});
