/* eslint-disable @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { describe, expect, it, vi } from 'vitest';
import { createAuthRuntimePorts } from '../auth-runtime';
import type { TransientChallenge, TransientSession } from '../storage/state-ports';

const now = 1_700_000_000_000;
const SESSION_ID = 'g1:apac:0:session_abcdefghijklmnopqrstuv';

function stores(sessionRegion?: never) {
  const state = {
    storeChallenge: vi.fn().mockResolvedValue(true),
    claimChallenge: vi.fn().mockResolvedValue(true),
    consumeChallenge: vi.fn(),
    getChallenge: vi.fn().mockResolvedValue(null),
    getConsumedChallenge: vi.fn().mockResolvedValue(null),
    deleteChallenge: vi.fn().mockResolvedValue(true),
    isChallengeClaimHeld: vi.fn().mockResolvedValue(true),
    createSession: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(true),
  };
  const accountAuthentication = {
    getAccountStateRpc: vi.fn().mockResolvedValue({ lifecycle: 'active', revokedAfterMs: null }),
    initializeAccountStateRpc: vi.fn().mockResolvedValue('initialized'),
    advancePasskeyCounterRpc: vi.fn().mockResolvedValue('advanced'),
  };
  const authorizationCodes = { store: vi.fn().mockResolvedValue({ success: true }) };
  const rateLimit = { check: vi.fn().mockResolvedValue({ allowed: true }) };
  const replayGuard = {
    record: vi.fn().mockResolvedValue(true),
    isRecorded: vi.fn().mockResolvedValue(false),
  };
  const ports = createAuthRuntimePorts({
    state,
    accountAuthentication,
    authorizationCodes,
    rateLimit,
    replayGuard,
    sessionRegion,
  } as never);
  return { state, accountAuthentication, authorizationCodes, rateLimit, replayGuard, ports };
}

const sessionRow = (over: Partial<TransientSession> = {}): TransientSession => ({
  tenantId: 'tenant-a',
  sessionId: SESSION_ID,
  userId: 'user-a',
  createdAt: now,
  expiresAt: now + 60_000,
  revocationBoundAtMs: now,
  ...over,
});
const challengeRow = (over: Partial<TransientChallenge> = {}): TransientChallenge => ({
  tenantId: 'tenant-a',
  id: 'c-1',
  type: 'direct_passkey_login',
  userId: 'unknown',
  challenge: 'secret',
  createdAt: now,
  expiresAt: now + 1000,
  ...over,
});
const forSession = (s: ReturnType<typeof stores>, tenantId = 'tenant-a', sessionId = SESSION_ID) =>
  s.ports.sessions.forSession({ tenantId, sessionId });
const forChallenges = (s: ReturnType<typeof stores>) =>
  s.ports.challenges.forIdentity({ tenantId: 'tenant-a', kind: 'challenge', key: 'identity-key' });
const forAccount = (s: ReturnType<typeof stores>) =>
  s.ports.sessionRevocation.forAccount({ tenantId: 'tenant-a', userId: 'user-a' });
const rejection = (message: string) => new Error(message);

describe('auth runtime identity validation (mutation hardening)', () => {
  it('validates tenant ids at every entry point', () => {
    const s = stores();
    const entries: Array<(tenantId: string) => unknown> = [
      (tenantId) => s.ports.replayGuard!.record({ tenantId } as never),
      (tenantId) => s.ports.replayGuard!.isRecorded({ tenantId } as never),
      (tenantId) => s.ports.challenges.forIdentity({ tenantId, kind: 'challenge', key: 'k' }),
      (tenantId) => s.ports.sessionRevocation.forAccount({ tenantId, userId: 'u' }),
      (tenantId) => s.ports.sessions.newSessionId({ tenantId }),
      (tenantId) => s.ports.sessions.forSession({ tenantId, sessionId: 's' }),
    ];
    for (const entry of entries) {
      for (const tenantId of ['', 'Tenant', '-a', 'a-', 'a_b', 'a b', 'a.b', 'ä'])
        expect(() => entry(tenantId), tenantId).toThrow(rejection('auth_runtime_tenant_invalid'));
      for (const tenantId of ['a', 'a1', '1a', 'a-b', 'a--b'])
        expect(() => entry(tenantId), tenantId).not.toThrow();
    }
    expect(s.replayGuard.record).toHaveBeenCalledTimes(5);
  });

  it('requires non-blank identity components with named errors', () => {
    const s = stores();
    for (const blank of ['', ' ', '\t\n'])
      expect(() =>
        s.ports.challenges.forIdentity({ tenantId: 'a', kind: 'challenge', key: blank })
      ).toThrow(rejection('auth_runtime_challenge_identity_missing'));
    for (const blank of ['', '  '])
      expect(() => s.ports.sessionRevocation.forAccount({ tenantId: 'a', userId: blank })).toThrow(
        rejection('auth_runtime_user_id_missing')
      );
    for (const blank of ['', '  '])
      expect(() => s.ports.sessions.forSession({ tenantId: 'a', sessionId: blank })).toThrow(
        rejection('auth_runtime_session_id_missing')
      );
  });

  it('delegates rate limiting, replay and authorization codes unchanged', async () => {
    const s = stores();
    const request = { tenantId: 'tenant-a', jti: 'j' } as never;
    expect(await s.ports.rateLimit!.check(request)).toEqual({ allowed: true });
    expect(s.rateLimit.check).toHaveBeenCalledWith(request);
    expect(await s.ports.replayGuard!.record(request)).toBe(true);
    expect(s.replayGuard.record).toHaveBeenCalledWith(request);
    expect(await s.ports.replayGuard!.isRecorded(request)).toBe(false);
    expect(s.replayGuard.isRecorded).toHaveBeenCalledWith(request);
    expect(await s.ports.authorizationCodes!.store({ code: 'c' } as never)).toEqual({
      success: true,
    });
  });

  it('builds opaque session ids with the configured region only', async () => {
    const s = stores();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const id = await s.ports.sessions.newSessionId({ tenantId: 'tenant-a' });
      expect(id).toMatch(/^g1:apac:0:session_[A-Za-z0-9_-]{22}$/u);
      ids.add(id);
    }
    expect(ids.size).toBe(20);
    for (const region of ['apac', 'weur', 'eeur', 'enam', 'wnam', 'oc', 'afr', 'me'] as const) {
      const regional = stores(region as never);
      expect(await regional.ports.sessions.newSessionId({ tenantId: 'a' })).toMatch(
        new RegExp(`^g1:${region}:0:session_[A-Za-z0-9_-]{22}$`, 'u')
      );
    }
    for (const bad of ['us', 'APAC', '', 'apac '])
      expect(() => stores(bad as never)).toThrow(rejection('auth_runtime_session_region_invalid'));
  });
});

describe('auth runtime challenges (mutation hardening)', () => {
  it('stores challenges with only the supplied optional fields and a millisecond TTL', async () => {
    const s = stores();
    const rpc = forChallenges(s);
    const base = {
      id: 'c-1',
      tenantId: 'tenant-a',
      type: 'direct_passkey_login',
      userId: 'u',
      challenge: 'secret',
      ttl: 30,
    } as never;
    await expect(rpc.storeChallengeRpc(base)).resolves.toEqual({ success: true });
    expect(s.state.storeChallenge.mock.calls[0][0]).toStrictEqual({
      id: 'c-1',
      tenantId: 'tenant-a',
      type: 'direct_passkey_login',
      userId: 'u',
      challenge: 'secret',
      ttlMs: 30_000,
    });
    const full = {
      ...(base as object),
      notAfterMs: 5,
      email: 'a@example.test',
      redirectUri: 'https://rp.example.test/cb',
      metadata: { k: 'v' },
    } as never;
    await rpc.storeChallengeRpc(full);
    expect(s.state.storeChallenge.mock.calls[1][0]).toStrictEqual({
      id: 'c-1',
      tenantId: 'tenant-a',
      type: 'direct_passkey_login',
      userId: 'u',
      challenge: 'secret',
      ttlMs: 30_000,
      notAfterMs: 5,
      email: 'a@example.test',
      redirectUri: 'https://rp.example.test/cb',
      metadata: { k: 'v' },
    });
    // zero is a real value, not absence
    await rpc.storeChallengeRpc({ ...(base as object), notAfterMs: 0 } as never);
    expect(s.state.storeChallenge.mock.calls[2][0]).toHaveProperty('notAfterMs', 0);
    s.state.storeChallenge.mockResolvedValueOnce(false);
    await expect(rpc.storeChallengeRpc(base)).rejects.toThrow(
      rejection('Challenge already exists')
    );
  });

  it('rejects requests for another tenant on every challenge RPC', async () => {
    const s = stores();
    const rpc = forChallenges(s);
    const foreign = { id: 'c', tenantId: 'tenant-b', ttl: 1 } as never;
    for (const call of [
      () => rpc.storeChallengeRpc(foreign),
      () => rpc.consumeChallengeRpc(foreign),
      () => rpc.claimChallengeRpc(foreign),
      () => rpc.isClaimHeldRpc(foreign),
    ])
      await expect(call()).rejects.toThrow(rejection('auth_runtime_challenge_tenant_mismatch'));
    for (const method of [
      'storeChallenge',
      'consumeChallenge',
      'claimChallenge',
      'isChallengeClaimHeld',
    ] as const)
      expect(s.state[method]).not.toHaveBeenCalled();
  });

  it('claims and checks claims through the store', async () => {
    const s = stores();
    const rpc = forChallenges(s);
    const request = {
      id: 'c',
      tenantId: 'tenant-a',
      type: 't',
      userId: 'u',
      challenge: 'x',
      ttl: 2,
    } as never;
    expect(await rpc.claimChallengeRpc(request)).toEqual({ claimed: true });
    expect(s.state.claimChallenge.mock.calls[0][0]).toStrictEqual({
      id: 'c',
      tenantId: 'tenant-a',
      type: 't',
      userId: 'u',
      challenge: 'x',
      ttlMs: 2000,
    });
    s.state.claimChallenge.mockResolvedValueOnce(false);
    expect(await rpc.claimChallengeRpc(request)).toEqual({ claimed: false });
    const check = { id: 'c', tenantId: 'tenant-a' } as never;
    expect(await rpc.isClaimHeldRpc(check)).toEqual({ held: true });
    expect(s.state.isChallengeClaimHeld).toHaveBeenCalledWith(check);
    s.state.isChallengeClaimHeld.mockResolvedValueOnce(false);
    expect(await rpc.isClaimHeldRpc(check)).toEqual({ held: false });
  });

  it('converts a one-use consume to the exact legacy shape', async () => {
    const s = stores();
    const rpc = forChallenges(s);
    const request = { id: 'c-1', tenantId: 'tenant-a', type: 't', challenge: 'x' } as never;
    s.state.consumeChallenge.mockResolvedValueOnce(challengeRow());
    expect(await rpc.consumeChallengeRpc(request)).toStrictEqual({
      challenge: 'secret',
      userId: 'unknown',
      createdAt: now,
    });
    expect(s.state.consumeChallenge).toHaveBeenCalledWith(request);
    s.state.consumeChallenge.mockResolvedValueOnce(
      challengeRow({
        email: 'a@example.test',
        redirectUri: 'https://rp.test/cb',
        metadata: { a: 1 },
      })
    );
    expect(await rpc.consumeChallengeRpc(request)).toStrictEqual({
      challenge: 'secret',
      userId: 'unknown',
      email: 'a@example.test',
      redirectUri: 'https://rp.test/cb',
      metadata: { a: 1 },
      createdAt: now,
    });
    s.state.consumeChallenge.mockResolvedValueOnce(null);
    await expect(rpc.consumeChallengeRpc(request)).rejects.toThrow(
      rejection('Challenge not found or already consumed')
    );
  });

  it('reads challenges back with only their defined optional fields', async () => {
    const s = stores();
    const rpc = forChallenges(s);
    s.state.getChallenge.mockResolvedValueOnce(challengeRow());
    expect(await rpc.getChallengeRpc('c-1')).toStrictEqual({
      id: 'c-1',
      tenantId: 'tenant-a',
      type: 'direct_passkey_login',
      userId: 'unknown',
      challenge: 'secret',
      createdAt: now,
      expiresAt: now + 1000,
      consumed: false,
    });
    expect(s.state.getChallenge).toHaveBeenCalledWith({ tenantId: 'tenant-a', id: 'c-1' });
    s.state.getChallenge.mockResolvedValueOnce(
      challengeRow({ email: 'e', redirectUri: 'r', metadata: { m: 1 }, consumedBy: 'op' })
    );
    expect(await rpc.getChallengeRpc('c-1')).toStrictEqual({
      id: 'c-1',
      tenantId: 'tenant-a',
      type: 'direct_passkey_login',
      userId: 'unknown',
      challenge: 'secret',
      createdAt: now,
      expiresAt: now + 1000,
      consumed: false,
      email: 'e',
      redirectUri: 'r',
      metadata: { m: 1 },
      consumedBy: 'op',
    });
    // a consumed challenge is exposed only through getConsumedChallenge, marked consumed
    s.state.getConsumedChallenge.mockResolvedValueOnce(challengeRow({ consumedBy: 'op' }));
    expect(await rpc.getChallengeRpc('c-1')).toMatchObject({
      consumed: true,
      consumedBy: 'op',
      id: 'c-1',
    });
    expect(s.state.getConsumedChallenge).toHaveBeenCalledWith({ tenantId: 'tenant-a', id: 'c-1' });
    expect(await rpc.getChallengeRpc('missing')).toBeNull();
    expect(await rpc.deleteChallengeRpc('c-1')).toEqual({ deleted: true });
    expect(s.state.deleteChallenge).toHaveBeenCalledWith({ tenantId: 'tenant-a', id: 'c-1' });
    s.state.deleteChallenge.mockResolvedValueOnce(false);
    expect(await rpc.deleteChallengeRpc('c-1')).toEqual({ deleted: false });
  });
});

describe('auth runtime account state (mutation hardening)', () => {
  it('binds every account RPC to the selected tenant, user and canonical account id', async () => {
    const s = stores();
    const rpc = forAccount(s);
    const good = ['tenant-a', 'user-a', 'account:user-a'] as const;
    const bad = [
      ['tenant-b', 'user-a', 'account:user-a'],
      ['tenant-a', 'user-b', 'account:user-a'],
      ['tenant-a', 'user-a', 'account:user-b'],
      ['tenant-a', 'user-a', 'user-a'],
      ['tenant-a', 'user-a', 'account:'],
    ] as const;
    const calls: Array<(a: readonly [string, string, string]) => Promise<unknown>> = [
      (a) => rpc.getAccountStateRpc(...a),
      (a) => rpc.initializeAccountStateRpc(...a, 'active', 5),
      (a) => rpc.advancePasskeyCounterRpc(...a, 'cred', 1, 2, 3),
    ];
    for (const call of calls) {
      for (const args of bad)
        await expect(call(args), args.join()).rejects.toThrow(
          rejection('auth_runtime_account_identity_mismatch')
        );
      await expect(call(good)).resolves.toBeDefined();
    }
    expect(s.accountAuthentication.getAccountStateRpc).toHaveBeenCalledTimes(1);
    expect(s.accountAuthentication.getAccountStateRpc).toHaveBeenCalledWith(...good);
    expect(s.accountAuthentication.initializeAccountStateRpc).toHaveBeenCalledWith(
      ...good,
      'active',
      5
    );
    expect(s.accountAuthentication.advancePasskeyCounterRpc).toHaveBeenCalledWith(
      ...good,
      'cred',
      1,
      2,
      3
    );
  });
});

describe('auth runtime sessions (mutation hardening)', () => {
  const active = { lifecycle: 'active', revokedAfterMs: null };

  it('binds createSessionRpc to the selector identity and the active account', async () => {
    const s = stores();
    const rpc = forSession(s);
    s.state.createSession.mockResolvedValue(sessionRow());
    await expect(
      rpc.createSessionRpc('other', 'user-a', 60, undefined, 'tenant-a')
    ).rejects.toThrow(rejection('auth_runtime_session_identity_mismatch'));
    await expect(
      rpc.createSessionRpc(SESSION_ID, 'user-a', 60, undefined, 'tenant-b')
    ).rejects.toThrow(rejection('auth_runtime_session_identity_mismatch'));
    await expect(rpc.createSessionRpc(SESSION_ID, '  ', 60, undefined, 'tenant-a')).rejects.toThrow(
      rejection('auth_runtime_user_id_missing')
    );
    expect(s.accountAuthentication.getAccountStateRpc).not.toHaveBeenCalled();
    for (const lifecycle of ['suspended', 'deleted'])
      s.accountAuthentication.getAccountStateRpc.mockResolvedValueOnce({
        lifecycle,
        revokedAfterMs: null,
      });
    for (let i = 0; i < 2; i += 1)
      await expect(
        rpc.createSessionRpc(SESSION_ID, 'user-a', 60, undefined, 'tenant-a')
      ).rejects.toThrow(rejection('account_authentication_not_allowed'));
    expect(s.state.createSession).not.toHaveBeenCalled();
  });

  it('creates the session with a millisecond TTL, optional data, and returns the canonical record', async () => {
    const s = stores();
    const rpc = forSession(s);
    s.state.createSession.mockResolvedValue(sessionRow());
    const plain = await rpc.createSessionRpc(SESSION_ID, 'user-a', 60, undefined, 'tenant-a');
    expect(s.accountAuthentication.getAccountStateRpc).toHaveBeenNthCalledWith(
      1,
      'tenant-a',
      'user-a',
      'account:user-a'
    );
    expect(s.state.createSession.mock.calls[0][0]).toStrictEqual({
      tenantId: 'tenant-a',
      sessionId: SESSION_ID,
      userId: 'user-a',
      ttlMs: 60_000,
    });
    expect(plain).toStrictEqual({
      id: SESSION_ID,
      tenantId: 'tenant-a',
      userId: 'user-a',
      accountId: 'account:user-a',
      createdAt: now,
      expiresAt: now + 60_000,
      revocationAuthority: 'user-session-do-v1',
      revocationBoundAtMs: now,
      sessionClientNamespaceVersion: 2,
    });
    s.state.createSession.mockResolvedValue(sessionRow({ data: { amr: ['passkey'] } }));
    const withData = await rpc.createSessionRpc(
      SESSION_ID,
      'user-a',
      5,
      { amr: ['passkey'] },
      'tenant-a'
    );
    expect(s.state.createSession.mock.calls[1][0]).toStrictEqual({
      tenantId: 'tenant-a',
      sessionId: SESSION_ID,
      userId: 'user-a',
      ttlMs: 5000,
      data: { amr: ['passkey'] },
    });
    expect(withData).toMatchObject({ data: { amr: ['passkey'] } });
    s.state.createSession.mockResolvedValue(sessionRow({ data: {} }));
    expect(await rpc.createSessionRpc(SESSION_ID, 'user-a', 5, {}, 'tenant-a')).toHaveProperty(
      'data',
      {}
    );
  });

  it('removes a session created for an account revoked concurrently', async () => {
    const s = stores();
    const rpc = forSession(s);
    s.state.createSession.mockResolvedValue(sessionRow({ revocationBoundAtMs: 100 }));
    s.accountAuthentication.getAccountStateRpc
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ lifecycle: 'active', revokedAfterMs: 100 });
    await expect(
      rpc.createSessionRpc(SESSION_ID, 'user-a', 60, undefined, 'tenant-a')
    ).rejects.toThrow(rejection('account_authentication_not_allowed'));
    expect(s.state.deleteSession).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      sessionId: SESSION_ID,
    });
  });

  it('applies the revocation boundary precisely when reading sessions', async () => {
    const s = stores();
    const rpc = forSession(s);
    const read = async (bound: number, state: unknown) => {
      s.state.getSession.mockResolvedValueOnce(sessionRow({ revocationBoundAtMs: bound }));
      s.accountAuthentication.getAccountStateRpc.mockResolvedValueOnce(state);
      return rpc.getSessionRpc(SESSION_ID);
    };
    expect(await read(100, { lifecycle: 'active', revokedAfterMs: 99 })).toMatchObject({
      id: SESSION_ID,
    });
    expect(await read(100, { lifecycle: 'active', revokedAfterMs: 100 })).toBeNull();
    expect(await read(100, { lifecycle: 'active', revokedAfterMs: 101 })).toBeNull();
    expect(await read(0, { lifecycle: 'active', revokedAfterMs: null })).toMatchObject({
      revocationBoundAtMs: 0,
    });
    expect(await read(100, { lifecycle: 'suspended', revokedAfterMs: null })).toBeNull();
    expect(await read(100, { lifecycle: 'suspended', revokedAfterMs: 1 })).toBeNull();
    expect(s.state.getSession).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      sessionId: SESSION_ID,
    });
    expect(s.accountAuthentication.getAccountStateRpc).toHaveBeenCalledWith(
      'tenant-a',
      'user-a',
      'account:user-a'
    );
    s.state.getSession.mockResolvedValueOnce(null);
    expect(await rpc.getSessionRpc(SESSION_ID)).toBeNull();
    await expect(rpc.getSessionRpc('other')).rejects.toThrow(
      rejection('auth_runtime_session_identity_mismatch')
    );
  });

  it('hides only the account-not-allowed failure and surfaces every other error', async () => {
    const s = stores();
    const rpc = forSession(s);
    s.state.getSession.mockResolvedValue(sessionRow());
    const failures: Array<[unknown, boolean]> = [
      [new Error('account_authentication_not_allowed'), true],
      [new Error('database_unreachable'), false],
      [new Error(''), false],
      [{ message: 'account_authentication_not_allowed' }, false],
      ['account_authentication_not_allowed', false],
      [null, false],
    ];
    for (const [failure, hidden] of failures) {
      s.accountAuthentication.getAccountStateRpc.mockRejectedValueOnce(failure);
      if (hidden) expect(await rpc.getSessionRpc(SESSION_ID)).toBeNull();
      else await expect(rpc.getSessionRpc(SESSION_ID)).rejects.toBe(failure);
    }
  });

  it('invalidates only the selected session', async () => {
    const s = stores();
    const rpc = forSession(s);
    expect(await rpc.invalidateSessionRpc(SESSION_ID)).toBe(true);
    expect(s.state.deleteSession).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      sessionId: SESSION_ID,
    });
    await expect(rpc.invalidateSessionRpc('other')).rejects.toThrow(
      rejection('auth_runtime_session_identity_mismatch')
    );
    s.state.deleteSession.mockResolvedValueOnce(false);
    expect(await rpc.invalidateSessionRpc(SESSION_ID)).toBe(false);
    expect(s.state.deleteSession).toHaveBeenCalledTimes(2);
  });
});
