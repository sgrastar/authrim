import { describe, expect, it, vi } from 'vitest';
import { createAuthRuntimePorts } from '../auth-runtime';
import type { PostgresAccountAuthStateStore } from '../storage/postgres-account-auth-state';
import type { PostgresAuthorizationCodeStore } from '../storage/postgres-authorization-code';
import type { PostgresRateLimitStore } from '../storage/postgres-rate-limit';
import type {
  PostgresTransientStateStore,
  TransientChallenge,
  TransientSession,
} from '../storage/postgres-transient-state';

const now = Date.now();
const sessionId = 'g1:apac:0:session_abcdefghijklmnopqrstuv';

function stores() {
  const state = {
    storeChallenge: vi.fn().mockResolvedValue(true),
    claimChallenge: vi.fn().mockResolvedValue(true),
    consumeChallenge: vi.fn(),
    getChallenge: vi.fn(),
    deleteChallenge: vi.fn().mockResolvedValue(true),
    isChallengeClaimHeld: vi.fn().mockResolvedValue(true),
    createSession: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(true),
  };
  const accountAuthentication = {
    getAccountStateRpc: vi.fn().mockResolvedValue({ lifecycle: 'active', revokedAfterMs: null }),
    initializeAccountStateRpc: vi.fn(),
    advancePasskeyCounterRpc: vi.fn(),
  };
  const authorizationCodes = {
    store: vi.fn().mockResolvedValue({ success: true, expiresAt: now + 60_000 }),
  };
  const ports = createAuthRuntimePorts({
    state: state as unknown as PostgresTransientStateStore,
    accountAuthentication: accountAuthentication as unknown as PostgresAccountAuthStateStore,
    authorizationCodes: authorizationCodes as unknown as PostgresAuthorizationCodeStore,
    rateLimit: { check: vi.fn() } as unknown as PostgresRateLimitStore,
  });
  return { state, accountAuthentication, authorizationCodes, ports };
}

function challenge(): TransientChallenge {
  return {
    tenantId: 'tenant-a',
    id: 'direct_passkey_login:challenge-a',
    type: 'direct_passkey_login',
    userId: 'unknown',
    challenge: 'secret',
    createdAt: now,
    expiresAt: now + 60_000,
    metadata: { client_id: 'browser' },
  };
}

function session(): TransientSession {
  return {
    tenantId: 'tenant-a',
    sessionId,
    userId: 'user-a',
    createdAt: now,
    expiresAt: now + 60_000,
    revocationBoundAtMs: now,
    data: { amr: ['passkey'], proven_at: now },
  };
}

describe('AWS authentication runtime ports', () => {
  it('stores the normal SAML Direct Auth code through the PostgreSQL port', async () => {
    const { ports, authorizationCodes } = stores();
    const request = {
      code: 'c78f3e2a-44f9-499b-8fd4-07105e6e9b60',
      tenantId: 'tenant-a',
      clientId: 'login-ui',
      userId: 'user-a',
      ttlSeconds: 60,
      redirectUri: 'https://authrim.local/direct-auth/callback',
      codeChallenge: 'challenge-a',
      codeChallengeMethod: 'S256' as const,
      scope: 'openid',
      authTime: 1700000000,
    };
    await expect(ports.authorizationCodes?.store(request)).resolves.toEqual({
      success: true,
      expiresAt: now + 60_000,
    });
    expect(authorizationCodes.store).toHaveBeenCalledWith(request);
  });

  it('keeps challenge RPCs tenant-bound and converts their one-use result', async () => {
    const { state, ports } = stores();
    const rpc = ports.challenges.forIdentity({
      tenantId: 'tenant-a',
      kind: 'challenge',
      key: 'challenge-a',
    });

    await expect(
      rpc.storeChallengeRpc({
        id: 'direct_passkey_login:challenge-a',
        tenantId: 'tenant-b',
        type: 'direct_passkey_login',
        userId: 'unknown',
        challenge: 'secret',
        ttl: 60,
      })
    ).rejects.toThrow('auth_runtime_challenge_tenant_mismatch');
    expect(state.storeChallenge).not.toHaveBeenCalled();

    await rpc.storeChallengeRpc({
      id: 'direct_passkey_login:challenge-a',
      tenantId: 'tenant-a',
      type: 'direct_passkey_login',
      userId: 'unknown',
      challenge: 'secret',
      ttl: 60,
    });
    expect(state.storeChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', ttlMs: 60_000 })
    );

    state.consumeChallenge.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(null);
    const request = {
      id: 'direct_passkey_login:challenge-a',
      tenantId: 'tenant-a',
      type: 'direct_passkey_login' as const,
    };
    await expect(rpc.consumeChallengeRpc(request)).resolves.toMatchObject({
      challenge: 'secret',
      metadata: { client_id: 'browser' },
    });
    await expect(rpc.consumeChallengeRpc(request)).rejects.toThrow(
      'Challenge not found or already consumed'
    );
  });

  it('fails closed if a live challenge ID was already stored', async () => {
    const { state, ports } = stores();
    state.storeChallenge.mockResolvedValue(false);
    const rpc = ports.challenges.forIdentity({
      tenantId: 'tenant-a',
      kind: 'challenge',
      key: 'challenge-a',
    });

    await expect(
      rpc.storeChallengeRpc({
        id: 'direct_passkey_login:challenge-a',
        tenantId: 'tenant-a',
        type: 'direct_passkey_login',
        userId: 'unknown',
        challenge: 'secret',
        ttl: 60,
      })
    ).rejects.toThrow('Challenge already exists');
  });

  it('binds counter advancement to the selected tenant and account', async () => {
    const { ports, accountAuthentication } = stores();
    const rpc = ports.sessionRevocation.forAccount({ tenantId: 'tenant-a', userId: 'user-a' });
    await expect(
      rpc.advancePasskeyCounterRpc(
        'tenant-b',
        'user-a',
        'account:user-a',
        'credential-a',
        1,
        2,
        now
      )
    ).rejects.toThrow('auth_runtime_account_identity_mismatch');
    expect(accountAuthentication.advancePasskeyCounterRpc).not.toHaveBeenCalled();
  });

  it('creates unguessable session IDs and rejects a suspended account after insert', async () => {
    const { state, accountAuthentication, ports } = stores();
    expect(ports.sessions.newSessionId({ tenantId: 'tenant-a' })).toMatch(
      /^g1:apac:0:session_[A-Za-z0-9_-]{22}$/u
    );
    state.createSession.mockResolvedValue(session());
    accountAuthentication.getAccountStateRpc
      .mockResolvedValueOnce({ lifecycle: 'active', revokedAfterMs: null })
      .mockResolvedValueOnce({ lifecycle: 'suspended', revokedAfterMs: null });
    const rpc = ports.sessions.forSession({ tenantId: 'tenant-a', sessionId });

    await expect(
      rpc.createSessionRpc(sessionId, 'user-a', 60, { amr: ['passkey'] }, 'tenant-a')
    ).rejects.toThrow('account_authentication_not_allowed');
    expect(state.deleteSession).toHaveBeenCalledWith({ tenantId: 'tenant-a', sessionId });
  });

  it('returns only sessions whose owning account is still active and unrevoked', async () => {
    const { state, accountAuthentication, ports } = stores();
    state.getSession.mockResolvedValue(session());
    const rpc = ports.sessions.forSession({ tenantId: 'tenant-a', sessionId });

    await expect(rpc.getSessionRpc(sessionId)).resolves.toMatchObject({
      id: sessionId,
      userId: 'user-a',
      revocationAuthority: 'user-session-do-v1',
      data: { amr: ['passkey'], proven_at: now },
    });
    accountAuthentication.getAccountStateRpc.mockResolvedValue({
      lifecycle: 'active',
      revokedAfterMs: now,
    });
    await expect(rpc.getSessionRpc(sessionId)).resolves.toBeNull();
    await expect(rpc.getSessionRpc('other-session')).rejects.toThrow(
      'auth_runtime_session_identity_mismatch'
    );
  });
});
