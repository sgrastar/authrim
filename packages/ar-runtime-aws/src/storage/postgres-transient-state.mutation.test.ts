import { describe, expect, it, vi } from 'vitest';
import { PostgresTransientStateStore, type PostgresQueryClient } from './postgres-transient-state';

function make(rows: unknown[] = [], rowCount: number | null = rows.length) {
  const query = vi.fn(async () => ({ rows, rowCount }));
  const store = new PostgresTransientStateStore({ query } as unknown as PostgresQueryClient);
  return { store, query };
}

const T = 'tenant-a';
const sessionRow = (over: Record<string, unknown> = {}) => ({
  payload: { userId: 'user-1' },
  created_at_ms: 10,
  expires_at_ms: 20,
  revocation_bound_at_ms: 5,
  ...over,
});
const challengeRow = (payload: unknown = {}) => ({
  payload: { type: 'passkey', userId: 'user-1', challenge: 'c', ...(payload as object) },
  created_at_ms: 10,
  expires_at_ms: 20,
});
const samlPayload = (
  over: Record<string, unknown> = {},
  reqOver: Record<string, unknown> = {}
) => ({
  spEntityId: 'sp',
  request: { requestId: 'r1', issuer: 'sp', type: 'authn_request', expiresAt: 30, ...reqOver },
  ...over,
});
const samlRow = (payload: unknown = samlPayload()) => ({
  payload,
  created_at_ms: 10,
  expires_at_ms: 40,
});
const samlKey = { tenantId: T, spEntityId: 'sp', requestId: 'r1' };

describe('PostgresTransientStateStore validation (mutation hardening)', () => {
  it('rejects invalid tenant IDs with the exact message across entry points', async () => {
    const { store, query } = make();
    const bad = 'Bad_Tenant';
    await expect(store.getSession({ tenantId: bad, sessionId: 's' })).rejects.toThrow(
      'Invalid tenant ID'
    );
    await expect(store.getConsumedChallenge({ tenantId: bad, id: 'i' })).rejects.toThrow(
      'Invalid tenant ID'
    );
    await expect(
      store.isChallengeClaimHeld({ tenantId: bad, id: 'i', challenge: 'c', minRemainingMs: 1 })
    ).rejects.toThrow('Invalid tenant ID');
    await expect(store.deleteChallenge({ tenantId: bad, id: 'i' })).rejects.toThrow(
      'Invalid tenant ID'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('assertIdentifier: empty, too long (default 1024 inclusive) and control characters', async () => {
    const { store, query } = make();
    await expect(store.getSession({ tenantId: T, sessionId: '' })).rejects.toThrow(
      'Invalid session ID'
    );
    await expect(store.getSession({ tenantId: T, sessionId: 'a'.repeat(1025) })).rejects.toThrow(
      'Invalid session ID'
    );
    await expect(store.getSession({ tenantId: T, sessionId: 'a\u001fb' })).rejects.toThrow(
      'Invalid session ID'
    );
    await expect(store.getSession({ tenantId: T, sessionId: 'a\u007fb' })).rejects.toThrow(
      'Invalid session ID'
    );
    await expect(store.getSession({ tenantId: T, sessionId: '\u0000' })).rejects.toThrow(
      'Invalid session ID'
    );
    expect(query).not.toHaveBeenCalled();
    // Boundaries that must be accepted: 1024 chars, space (0x20) and 0x7e.
    await store.getSession({ tenantId: T, sessionId: 'a'.repeat(1024) });
    await store.getSession({ tenantId: T, sessionId: 'a b' });
    await store.getSession({ tenantId: T, sessionId: 'a~b' });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('assertTtlMs: bounds and message', async () => {
    const { store, query } = make([{ id: 'x' }]);
    const base = { tenantId: T, key: 'k', value: 'v' };
    for (const ttlMs of [0, -1, 1.5, Number.NaN, 30 * 24 * 60 * 60 * 1000 + 1]) {
      await expect(store.putKey({ ...base, ttlMs })).rejects.toThrow('Invalid transient state TTL');
    }
    expect(query).not.toHaveBeenCalled();
    await store.putKey({ ...base, ttlMs: 1 });
    await store.putKey({ ...base, ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('assertTimestamp: challenge deadline must be a positive safe integer', async () => {
    const { store, query } = make([{ id: 'x' }]);
    const base = {
      tenantId: T,
      id: 'i',
      type: 'passkey',
      userId: 'u',
      challenge: 'c',
      ttlMs: 1000,
    };
    for (const notAfterMs of [0, -1, 1.5]) {
      await expect(store.storeChallenge({ ...base, notAfterMs })).rejects.toThrow(
        'Invalid challenge deadline'
      );
    }
    expect(query).not.toHaveBeenCalled();
    expect(await store.storeChallenge({ ...base, notAfterMs: 1 })).toBe(true);
  });

  it('jsonObject: rejects oversized payloads and unserializable SAML context', async () => {
    const { store, query } = make([{ id: 'x' }]);
    await expect(
      store.putKey({ tenantId: T, key: 'k', value: 'a'.repeat(64 * 1024), ttlMs: 1000 })
    ).rejects.toThrow('Transient state payload is too large');
    await expect(
      store.updateSamlRequest({
        ...samlKey,
        expectedRevision: 1,
        context: undefined as never,
      })
    ).rejects.toThrow('Transient state payload is too large');
    expect(query).not.toHaveBeenCalled();
  });

  it('asObject: rejects null, array and scalar payloads', async () => {
    for (const payload of [null, [], 'x', 5]) {
      const { store } = make([sessionRow({ payload })]);
      await expect(store.getSession({ tenantId: T, sessionId: 's' })).rejects.toThrow(
        'Invalid transient state payload'
      );
    }
  });

  it('asMs: rejects zero, negative, fractional and non-numeric timestamps', async () => {
    for (const bad of [0, '0', -4, 1.5, 'abc']) {
      const { store } = make([sessionRow({ created_at_ms: bad })]);
      await expect(store.getSession({ tenantId: T, sessionId: 's' })).rejects.toThrow(
        'Invalid transient state timestamp'
      );
    }
    const { store } = make([sessionRow({ created_at_ms: '1', expires_at_ms: 2 })]);
    const session = await store.getSession({ tenantId: T, sessionId: 's' });
    expect(session).toMatchObject({ createdAt: 1, expiresAt: 2, revocationBoundAtMs: 5 });
  });

  it('readSession: rejects a missing or empty userId binding', async () => {
    for (const payload of [{}, { userId: '' }, { userId: 5 }]) {
      const { store } = make([sessionRow({ payload })]);
      await expect(store.getSession({ tenantId: T, sessionId: 's' })).rejects.toThrow(
        'Session storage binding invalid'
      );
    }
  });

  it('consumeChallenge: validates challenge and operation id', async () => {
    const { store, query } = make([]);
    const base = { tenantId: T, id: 'i', type: 'passkey' };
    await expect(store.consumeChallenge({ ...base, operationId: '' })).rejects.toThrow(
      'Invalid challenge operation ID'
    );
    await expect(store.consumeChallenge({ ...base, operationId: 'o'.repeat(257) })).rejects.toThrow(
      'Invalid challenge operation ID'
    );
    await expect(store.consumeChallenge({ ...base, challenge: '' })).rejects.toThrow(
      'Invalid challenge value'
    );
    expect(query).not.toHaveBeenCalled();
    await store.consumeChallenge({ ...base, operationId: 'o'.repeat(256) });
    const values = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(values).toEqual([T, 'i', 'passkey', null, 'o'.repeat(256)]);
  });

  it('getChallenge: rejects a stored row without a string type', async () => {
    const { store } = make([challengeRow({ type: 5 })]);
    await expect(store.getChallenge({ tenantId: T, id: 'i' })).rejects.toThrow(
      'Challenge storage binding invalid'
    );
  });

  it('getConsumedChallenge: validates the id and the stored binding', async () => {
    await expect(make().store.getConsumedChallenge({ tenantId: T, id: '' })).rejects.toThrow(
      'Invalid challenge ID'
    );
    for (const payload of [{ type: 5, consumedBy: 'op' }, { consumedBy: 5 }, {}]) {
      const { store } = make([challengeRow(payload)]);
      await expect(store.getConsumedChallenge({ tenantId: T, id: 'i' })).rejects.toThrow(
        'Challenge storage binding invalid'
      );
    }
    const { store } = make([challengeRow({ consumedBy: 'op' })]);
    expect(await store.getConsumedChallenge({ tenantId: T, id: 'i' })).toMatchObject({
      consumedBy: 'op',
      type: 'passkey',
    });
  });

  it('isChallengeClaimHeld: validates arguments and passes them through', async () => {
    const { store, query } = make([{ id: 'i' }]);
    const base = { tenantId: T, id: 'i', challenge: 'c', minRemainingMs: 0 };
    await expect(store.isChallengeClaimHeld({ ...base, id: '' })).rejects.toThrow(
      'Invalid challenge ID'
    );
    await expect(store.isChallengeClaimHeld({ ...base, challenge: '' })).rejects.toThrow(
      'Invalid challenge value'
    );
    await expect(
      store.isChallengeClaimHeld({ ...base, challenge: 'c'.repeat(4097) })
    ).rejects.toThrow('Invalid challenge value');
    for (const minRemainingMs of [-1, 1.5, Number.NaN]) {
      await expect(store.isChallengeClaimHeld({ ...base, minRemainingMs })).rejects.toThrow(
        'Invalid minimum remaining lifetime'
      );
    }
    expect(query).not.toHaveBeenCalled();
    expect(await store.isChallengeClaimHeld(base)).toBe(true);
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([T, 'i', 'c', 0]);
    expect(await make([]).store.isChallengeClaimHeld(base)).toBe(false);
  });

  it('deleteChallenge: validates the id and reports whether exactly one row changed', async () => {
    await expect(make().store.deleteChallenge({ tenantId: T, id: '' })).rejects.toThrow(
      'Invalid challenge ID'
    );
    expect(await make([{ id: 'i' }]).store.deleteChallenge({ tenantId: T, id: 'i' })).toBe(true);
    expect(await make([]).store.deleteChallenge({ tenantId: T, id: 'i' })).toBe(false);
  });

  it('readChallenge: rejects type mismatch and non-string userId/challenge', async () => {
    const base = { tenantId: T, id: 'i', type: 'passkey' };
    for (const payload of [{ type: 'other' }, { userId: 5 }, { challenge: 5 }]) {
      const { store } = make([challengeRow(payload)]);
      await expect(store.consumeChallenge(base)).rejects.toThrow(
        'Challenge storage binding invalid'
      );
    }
  });

  it('SAML rows: any binding mismatch yields the exact storage binding error', async () => {
    const cases = [
      samlPayload({ spEntityId: 'other' }),
      samlPayload({}, { requestId: 'other' }),
      samlPayload({}, { issuer: 'other' }),
      samlPayload({}, { type: 'logout_request' }),
    ];
    for (const payload of cases) {
      const { store } = make([samlRow(payload)]);
      await expect(store.readSamlRequest(samlKey)).rejects.toThrow(
        'SAML request storage binding invalid'
      );
    }
    const { store } = make([samlRow()]);
    expect(await store.readSamlRequest(samlKey)).toMatchObject({
      requestId: 'r1',
      createdAt: 10,
      expiresAt: 30,
      used: false,
    });
  });

  it('completeSamlRequest: validates login nonce hash and revision, marks result used', async () => {
    const { store, query } = make([samlRow()]);
    await expect(store.completeSamlRequest({ ...samlKey, loginNonceHash: '' })).rejects.toThrow(
      'Invalid SAML login nonce hash'
    );
    await expect(
      store.completeSamlRequest({ ...samlKey, loginNonceHash: 'h'.repeat(257) })
    ).rejects.toThrow('Invalid SAML login nonce hash');
    await expect(store.completeSamlRequest({ ...samlKey, expectedRevision: 0 })).rejects.toThrow(
      'Invalid SAML request revision'
    );
    expect(query).not.toHaveBeenCalled();
    const result = await store.completeSamlRequest({
      ...samlKey,
      loginNonceHash: 'h'.repeat(256),
      expectedRevision: 2,
    });
    expect(result?.used).toBe(true);
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([
      T,
      'r1',
      'sp',
      'h'.repeat(256),
      2,
    ]);
  });

  it('getKey: rejects a payload without a string value', async () => {
    for (const payload of [{ value: 5 }, {}]) {
      const { store } = make([{ payload }]);
      await expect(store.getKey({ tenantId: T, key: 'k' })).rejects.toThrow(
        'Transient key payload invalid'
      );
    }
    expect(await make([{ payload: { value: 'v' } }]).store.getKey({ tenantId: T, key: 'k' })).toBe(
      'v'
    );
  });

  it('pruneExpired: limit bounds, default and row count fallback', async () => {
    const { store, query } = make([{ id: 'a' }], 7);
    for (const limit of [0, -1, 10_001, 1.5, Number.NaN]) {
      await expect(store.pruneExpired(limit)).rejects.toThrow('Invalid prune limit');
    }
    expect(query).not.toHaveBeenCalled();
    await store.pruneExpired(1);
    await store.pruneExpired(10_000);
    expect(await store.pruneExpired()).toBe(7);
    expect((query.mock.calls[2] as unknown as [string, unknown[]])[1]).toEqual([1000]);
    expect(await make([{ id: 'a' }], null).store.pruneExpired()).toBe(1);
  });
});
