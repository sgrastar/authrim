import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  revokeGuestResumeForSession,
  sessionStore,
  revokeDeviceSecretsForLogoutScope,
  listRefreshTokenFamiliesByUser,
  expireRefreshTokenFamiliesByUser,
  getRefreshTokenRotatorStubByJti,
  revokeFamilyRpc,
  createAuditLog,
  tenantMetadataCore,
  accountCore,
  resolveAccountDataContextFromHono,
} = vi.hoisted(() => {
  const rotatorStub = {
    revokeFamilyRpc: vi.fn(),
  };

  return {
    revokeGuestResumeForSession: vi.fn(),
    sessionStore: {
      getSessionRpc: vi.fn(),
      invalidateSessionRpc: vi.fn(),
    },
    revokeDeviceSecretsForLogoutScope: vi.fn(),
    listRefreshTokenFamiliesByUser: vi.fn(),
    expireRefreshTokenFamiliesByUser: vi.fn(),
    getRefreshTokenRotatorStubByJti: vi.fn((_env: unknown, _clientId: string, jti: string) => ({
      stub: rotatorStub,
      resolution: { instanceName: `rotator:${jti}` },
    })),
    revokeFamilyRpc: rotatorStub.revokeFamilyRpc,
    createAuditLog: vi.fn(),
    // ar-token indexes refresh-token families in the user's account database.
    tenantMetadataCore: { database: 'tenant-metadata' },
    accountCore: { database: 'account' },
    resolveAccountDataContextFromHono: vi.fn(async (_c: unknown, userId: string) => ({
      tenantId: 'tenant_test',
      accountId: `account:${userId}`,
      legacyUserId: userId,
    })),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    revokeGuestResumeForSession,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: sessionStore })),
    isShardedSessionId: vi.fn(() => true),
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: tenantMetadataCore })),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: accountCore })),
    resolveAccountDataContextFromHono,
    isNativeSSOEnabled: vi.fn(async () => true),
    revokeDeviceSecretsForLogoutScope,
    listRefreshTokenFamiliesByUser,
    expireRefreshTokenFamiliesByUser,
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getLogger: vi.fn(() => ({
      module: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
    createAuditLog,
  };
});

vi.mock('@authrim/ar-lib-core/services/refresh-token-family-store', () => ({
  getRefreshTokenRotatorStubByJti,
}));

function createContext(body: Record<string, unknown>) {
  const responseHeaders = new Headers();
  const request = new Request('https://auth.example.com/api/v1/auth/direct/logout', {
    headers: {
      Cookie: 'authrim_session=g1:global:0:session_test; authrim_guest_resume=resume-secret',
    },
  });

  return {
    req: {
      raw: request,
      json: vi.fn(async () => body),
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    env: {
      REFRESH_TOKEN_ROTATOR: {},
    },
    header: (name: string, value: string) => {
      responseHeaders.append(name, value);
    },
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: responseHeaders,
      }),
  };
}

describe('Direct Auth logout scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeGuestResumeForSession.mockResolvedValue(undefined);
    sessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:global:0:session_test',
      userId: 'user_123',
    });
    sessionStore.invalidateSessionRpc.mockResolvedValue(undefined);
    revokeDeviceSecretsForLogoutScope.mockResolvedValue({
      scope: 'local',
      revokedDeviceSecrets: 0,
      revokedInstallations: 0,
    });
    listRefreshTokenFamiliesByUser.mockResolvedValue([
      {
        client_id: 'client-a',
        jti: 'refresh-family-1',
      },
      {
        client_id: 'client-a',
        jti: 'refresh-family-2',
      },
    ]);
    revokeFamilyRpc.mockResolvedValue(undefined);
    expireRefreshTokenFamiliesByUser.mockResolvedValue(undefined);
    createAuditLog.mockResolvedValue(undefined);
  });

  it('defaults Direct Auth logout propagation to the current client', async () => {
    const { directLogoutHandler } = await import('../direct-auth');

    const response = await directLogoutHandler(
      createContext({
        client_id: 'client-a',
      }) as never
    );

    expect(response.status).toBe(200);
    expect(revokeDeviceSecretsForLogoutScope).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-a',
        scope: 'local',
      })
    );
  });

  it('allows explicit application group logout propagation', async () => {
    const { directLogoutHandler } = await import('../direct-auth');

    const response = await directLogoutHandler(
      createContext({
        client_id: 'client-a',
        logout_scope: 'group',
      }) as never
    );

    expect(response.status).toBe(200);
    expect(revokeDeviceSecretsForLogoutScope).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-a',
        scope: 'group',
      })
    );
  });

  it('revokes active refresh token families when requested without changing logout response shape', async () => {
    const { directLogoutHandler } = await import('../direct-auth');

    const response = await directLogoutHandler(
      createContext({
        client_id: 'client-a',
        revoke_tokens: true,
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      message: 'Logged out successfully',
    });
    expect(resolveAccountDataContextFromHono).toHaveBeenCalledWith(expect.anything(), 'user_123');
    expect(listRefreshTokenFamiliesByUser).toHaveBeenCalledWith(accountCore, {
      tenantId: 'tenant_test',
      userId: 'user_123',
      activeOnly: true,
      nowMs: expect.any(Number),
    });
    expect(getRefreshTokenRotatorStubByJti).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        REFRESH_TOKEN_ROTATOR: {},
      }),
      'client-a',
      'refresh-family-1',
      'tenant_test'
    );
    expect(getRefreshTokenRotatorStubByJti).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        REFRESH_TOKEN_ROTATOR: {},
      }),
      'client-a',
      'refresh-family-2',
      'tenant_test'
    );
    // By user in each rotator: the indexed JWT ID is the family's first, gone once rotated.
    expect(revokeFamilyRpc).toHaveBeenCalledTimes(2);
    expect(revokeFamilyRpc).toHaveBeenNthCalledWith(1, 'user_123', 'direct_auth_revoke_tokens');
    expect(revokeFamilyRpc).toHaveBeenNthCalledWith(2, 'user_123', 'direct_auth_revoke_tokens');
    expect(expireRefreshTokenFamiliesByUser).toHaveBeenCalledWith(accountCore, {
      tenantId: 'tenant_test',
      userId: 'user_123',
    });
  });

  it('keeps the index when a rotator could not revoke, so a retry can find the family', async () => {
    getRefreshTokenRotatorStubByJti.mockImplementation(
      () =>
        ({
          stub: { revokeFamilyRpc },
          resolution: { instanceName: 'rotator:shared' },
        }) as never
    );
    revokeFamilyRpc.mockReset().mockRejectedValueOnce(new Error('unavailable'));
    expireRefreshTokenFamiliesByUser.mockClear();
    const { directLogoutHandler } = await import('../direct-auth');

    const response = await directLogoutHandler(
      createContext({ client_id: 'client-a', revoke_tokens: true }) as never
    );

    expect(response.status).toBe(200);
    expect(revokeFamilyRpc).toHaveBeenCalledWith('user_123', 'direct_auth_revoke_tokens');
    expect(expireRefreshTokenFamiliesByUser).not.toHaveBeenCalled();
    revokeFamilyRpc.mockReset().mockResolvedValue(undefined);
  });

  it('revokes the user’s family once in a rotator the index names twice', async () => {
    getRefreshTokenRotatorStubByJti.mockImplementation(
      () =>
        ({
          stub: { revokeFamilyRpc },
          resolution: { instanceName: 'rotator:shared' },
        }) as never
    );
    revokeFamilyRpc.mockClear();
    const { directLogoutHandler } = await import('../direct-auth');

    await directLogoutHandler(
      createContext({ client_id: 'client-a', revoke_tokens: true }) as never
    );

    expect(revokeFamilyRpc).toHaveBeenCalledTimes(1);
    expect(revokeFamilyRpc).toHaveBeenCalledWith('user_123', 'direct_auth_revoke_tokens');
  });
});

describe('Direct Auth guest logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.getSessionRpc.mockResolvedValue({
      id: 'session',
      userId: 'guest',
      tenantId: 'tenant_test',
      data: { guest_resume_credential: true },
    });
    revokeGuestResumeForSession.mockResolvedValue(undefined);
    sessionStore.invalidateSessionRpc.mockResolvedValue(undefined);
  });
  it('revokes the resume credential before invalidation and clears both browser cookies', async () => {
    const { directLogoutHandler } = await import('../direct-auth');
    const c = createContext({});
    const response = await directLogoutHandler(c as never);
    expect(response.status).toBe(200);
    expect(revokeGuestResumeForSession).toHaveBeenCalledWith(
      c,
      expect.objectContaining({ userId: 'guest' })
    );
    expect(revokeGuestResumeForSession.mock.invocationCallOrder[0]).toBeLessThan(
      sessionStore.invalidateSessionRpc.mock.invocationCallOrder[0]
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_guest_resume=;');
    expect(response.headers.get('set-cookie')).toContain('authrim_session=;');
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant_test',
        userId: 'guest',
        action: 'user.logout',
        resourceId: 'session',
        metadata: expect.stringContaining('guest'),
      })
    );
  });
  it.each(['read', 'revoke', 'invalidate'])(
    'preserves cookies and reports failure on %s failure',
    async (stage) => {
      const { directLogoutHandler } = await import('../direct-auth');
      const failing =
        stage === 'read'
          ? sessionStore.getSessionRpc
          : stage === 'revoke'
            ? revokeGuestResumeForSession
            : sessionStore.invalidateSessionRpc;
      failing.mockRejectedValueOnce(new Error('unavailable'));
      const response = await directLogoutHandler(createContext({}) as never);
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
      if (stage !== 'invalidate') expect(sessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
      expect(revokeDeviceSecretsForLogoutScope).not.toHaveBeenCalled();
    }
  );
});
