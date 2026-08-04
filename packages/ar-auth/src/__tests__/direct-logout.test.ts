import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sessionStore,
  revokeDeviceSecretsForLogoutScope,
  listRefreshTokenFamiliesByUser,
  expireRefreshTokenFamiliesByUser,
  getRefreshTokenRotatorStubByJti,
  revokeByJtiRpc,
} = vi.hoisted(() => {
  const rotatorStub = {
    revokeByJtiRpc: vi.fn(),
  };

  return {
    sessionStore: {
      getSessionRpc: vi.fn(),
      invalidateSessionRpc: vi.fn(),
    },
    revokeDeviceSecretsForLogoutScope: vi.fn(),
    listRefreshTokenFamiliesByUser: vi.fn(),
    expireRefreshTokenFamiliesByUser: vi.fn(),
    getRefreshTokenRotatorStubByJti: vi.fn(() => ({ stub: rotatorStub })),
    revokeByJtiRpc: rotatorStub.revokeByJtiRpc,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: sessionStore })),
    isShardedSessionId: vi.fn(() => true),
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    resolveAccountDataContextFromHono: vi.fn(async (_c, userId: string) => ({
      tenantId: 'tenant_test',
      accountId: `account:${userId}`,
      legacyUserId: userId,
    })),
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
  };
});

vi.mock('@authrim/ar-lib-core/services/refresh-token-family-store', () => ({
  getRefreshTokenRotatorStubByJti,
}));

function createContext(body: Record<string, unknown>) {
  const responseHeaders = new Headers();
  const request = new Request('https://auth.example.com/api/v1/auth/direct/logout', {
    headers: {
      Authorization: 'Bearer g1:global:0:session_test',
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
    revokeByJtiRpc.mockResolvedValue(undefined);
    expireRefreshTokenFamiliesByUser.mockResolvedValue(undefined);
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
    expect(listRefreshTokenFamiliesByUser).toHaveBeenCalledWith(
      {},
      {
        tenantId: 'tenant_test',
        userId: 'user_123',
        activeOnly: true,
        nowMs: expect.any(Number),
      }
    );
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
    expect(revokeByJtiRpc).toHaveBeenNthCalledWith(
      1,
      'refresh-family-1',
      'direct_auth_revoke_tokens'
    );
    expect(revokeByJtiRpc).toHaveBeenNthCalledWith(
      2,
      'refresh-family-2',
      'direct_auth_revoke_tokens'
    );
    expect(expireRefreshTokenFamiliesByUser).toHaveBeenCalledWith(
      {},
      {
        tenantId: 'tenant_test',
        userId: 'user_123',
      }
    );
  });
});
