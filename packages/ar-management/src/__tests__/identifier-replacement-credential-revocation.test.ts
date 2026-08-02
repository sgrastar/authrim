import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFamilies: vi.fn(),
  revokeFamilies: vi.fn(),
  resolveRotator: vi.fn(),
  resolveSession: vi.fn(),
  isShardedSessionId: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    listRefreshTokenFamiliesByUser: mocks.listFamilies,
    revokeRefreshTokenFamiliesByUser: mocks.revokeFamilies,
    getRefreshTokenRotatorStubByJti: mocks.resolveRotator,
    getSessionStoreBySessionId: mocks.resolveSession,
    isShardedSessionId: mocks.isShardedSessionId,
  };
});

import { revokeIdentifierReplacementCredentials } from '../identifier-replacement-credential-revocation';

describe('identifier replacement credential revocation', () => {
  const revokeFamilyRpc = vi.fn();
  const invalidateSessionRpc = vi.fn();
  const core = {
    query: vi.fn(),
    execute: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    revokeFamilyRpc.mockResolvedValue(undefined);
    invalidateSessionRpc.mockResolvedValue(undefined);
    mocks.revokeFamilies.mockResolvedValue(undefined);
    mocks.resolveSession.mockReturnValue({ stub: { invalidateSessionRpc } });
    mocks.isShardedSessionId.mockImplementation((id: string) => id.startsWith('g1:'));
    core.execute.mockResolvedValue({ success: true, rowsAffected: 2 });
  });

  it('revokes each rotator once, preserves the initiating session, and removes other indexes', async () => {
    mocks.listFamilies.mockResolvedValue([
      { client_id: 'client-a', jti: 'family-a' },
      { client_id: 'client-a', jti: 'family-a-duplicate' },
      { client_id: 'client-b', jti: 'family-b' },
    ]);
    mocks.resolveRotator.mockImplementation((_env, clientId: string) => ({
      resolution: { instanceName: clientId },
      stub: { revokeFamilyRpc },
    }));
    core.query.mockResolvedValue([{ id: 'g1:other-session' }, { id: 'legacy-session' }]);

    await revokeIdentifierReplacementCredentials({
      env: {} as never,
      core: core as never,
      tenantId: 'tenant-a',
      accountId: 'account-a',
      initiatingSessionRef: 'g1:current-session',
    });

    expect(revokeFamilyRpc).toHaveBeenCalledTimes(2);
    expect(mocks.revokeFamilies).toHaveBeenCalledWith(core, {
      tenantId: 'tenant-a',
      userId: 'account-a',
    });
    expect(core.query).toHaveBeenCalledWith(
      expect.stringContaining('id <> ?'),
      ['tenant-a', 'account-a', 'g1:current-session', 1001],
      { consistencyClass: 'primary_required' }
    );
    expect(invalidateSessionRpc).toHaveBeenCalledWith('g1:other-session');
    expect(core.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM sessions'), [
      'tenant-a',
      'account-a',
      'g1:other-session',
      'legacy-session',
    ]);
  });

  it('fails closed before invalidating sessions when the bounded index query overflows', async () => {
    mocks.listFamilies.mockResolvedValue([]);
    core.query.mockResolvedValue(
      Array.from({ length: 1001 }, (_, index) => ({ id: `g1:session-${index}` }))
    );

    await expect(
      revokeIdentifierReplacementCredentials({
        env: {} as never,
        core: core as never,
        tenantId: 'tenant-a',
        accountId: 'account-a',
        initiatingSessionRef: 'g1:current-session',
      })
    ).rejects.toThrow('identifier_replacement_session_limit_exceeded');

    expect(invalidateSessionRpc).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
  });
});
