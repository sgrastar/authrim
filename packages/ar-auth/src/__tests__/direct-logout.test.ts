import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStore = {
  getSessionRpc: vi.fn(),
  invalidateSessionRpc: vi.fn(),
};

const revokeDeviceSecretsForLogoutScope = vi.fn();

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: sessionStore })),
    isShardedSessionId: vi.fn(() => true),
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    isNativeSSOEnabled: vi.fn(async () => true),
    revokeDeviceSecretsForLogoutScope,
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
    env: {},
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
});
