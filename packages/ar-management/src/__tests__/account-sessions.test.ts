import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockSessionRevocationStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCoreAdapter,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
    invalidateSessionRpc: vi.fn(),
  };
  const sessionRevocationStore = { listActiveSessionsRpc: vi.fn() };
  const coreAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockSessionRevocationStore: sessionRevocationStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({ coreAdapter }),
    mockCoreAdapter: coreAdapter,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getSessionRevocationStore: vi.fn(() => mockSessionRevocationStore),
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

import { listAccountSessionsHandler, deleteAccountSessionHandler } from '../account-sessions';

function createMockContext(options: { cookie?: string; params?: Record<string, string> } = {}) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/sessions', {
    headers: options.cookie ? { Cookie: options.cookie } : {},
  });
  return {
    env: {} as Env,
    req: {
      method: 'GET',
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
      param: (name: string) => options.params?.[name] ?? '',
    },
    header: (name: string, value: string) => {
      headers.append(name, value);
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...Object.fromEntries(headers.entries()),
        },
      }),
  } as any;
}

describe('Account Page session management API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    mockSessionStore.getSessionRpc.mockReset();
    mockSessionStore.invalidateSessionRpc.mockReset();
    mockSessionRevocationStore.listActiveSessionsRpc.mockReset();
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    mockSessionStore.invalidateSessionRpc.mockResolvedValue(true);
    mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValue([
      { sessionId: 'g1:apac:3:session_current' },
    ]);
    mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists only active sessions owned by the authenticated account', async () => {
    mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValueOnce([
      { sessionId: 'g1:apac:3:session_other' },
      { sessionId: 'g1:apac:3:session_current' },
    ]);
    mockSessionStore.getSessionRpc.mockImplementation((sessionId: string) => {
      if (sessionId === 'g1:apac:3:session_other') {
        return Promise.resolve({
          id: 'g1:apac:3:session_other',
          tenantId: 'default',
          userId: 'user-001',
          createdAt: 1_777_100_000_000,
          expiresAt: 1_777_200_000_000,
          data: {
            userAgent:
              'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 ' +
              '(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
            countryCode: 'JP',
          },
        });
      }
      return Promise.resolve({
        id: 'g1:apac:3:session_current',
        tenantId: 'default',
        userId: 'user-001',
        createdAt: 1_777_000_000_000,
        expiresAt: Date.now() + 60_000,
      });
    });

    const response = await listAccountSessionsHandler(
      createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
    );
    const body = (await response.json()) as { sessions: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
    expect(body.sessions).toEqual([
      {
        id: 'g1:apac:3:session_other',
        current: false,
        created_at: 1_777_100_000_000,
        expires_at: 1_777_200_000_000,
        browser: 'Safari',
        os: 'iOS',
        device_type: 'mobile',
        country_code: 'JP',
      },
      {
        id: 'g1:apac:3:session_current',
        current: true,
        created_at: 1_777_000_000_000,
        expires_at: Date.now() + 60_000,
        browser: null,
        os: null,
        device_type: null,
        country_code: null,
      },
    ]);
  });

  it('revokes an owned non-current session through SessionStore only', async () => {
    mockSessionStore.getSessionRpc.mockImplementation((sessionId: string) => {
      if (sessionId === 'g1:apac:3:session_other') {
        return Promise.resolve({
          id: sessionId,
          tenantId: 'default',
          userId: 'user-001',
        });
      }
      return Promise.resolve({
        id: 'g1:apac:3:session_current',
        tenantId: 'default',
        userId: 'user-001',
        createdAt: 1_777_000_000_000,
        expiresAt: Date.now() + 60_000,
      });
    });

    const response = await deleteAccountSessionHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'g1:apac:3:session_other' },
      })
    );
    const body = (await response.json()) as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mockSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('g1:apac:3:session_other');
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
    expect(body.session).toEqual({
      id: 'g1:apac:3:session_other',
      current: false,
      store_status: 'revoked',
    });
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('includes the current session when the user-session index has not caught up yet', async () => {
    mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValueOnce([]);

    const response = await listAccountSessionsHandler(
      createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
    );
    const body = (await response.json()) as { sessions: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.sessions).toEqual([
      {
        id: 'g1:apac:3:session_current',
        current: true,
        created_at: 1_777_000_000_000,
        expires_at: Date.now() + 60_000,
        browser: null,
        os: null,
        device_type: null,
        country_code: null,
      },
    ]);
  });

  it('preserves client metadata for the current session while the index catches up', async () => {
    mockSessionRevocationStore.listActiveSessionsRpc.mockResolvedValueOnce([]);
    mockSessionStore.getSessionRpc.mockResolvedValueOnce({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        countryCode: 'DE',
      },
    });

    const response = await listAccountSessionsHandler(
      createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
    );
    const body = (await response.json()) as { sessions: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.sessions[0]).toMatchObject({
      current: true,
      browser: 'Google Chrome',
      os: 'Windows',
      device_type: 'desktop',
      country_code: 'DE',
    });
  });

  it('clears authrim_session cookie when revoking the current session', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenant_id: 'default',
      user_id: 'user-001',
      created_at: 1_777_000_000,
      expires_at: 1_777_300_000,
    });

    const response = await deleteAccountSessionHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'g1:apac:3:session_current' },
      })
    );
    const body = (await response.json()) as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.session.current).toBe(true);
    expect(response.headers.get('Set-Cookie')).toContain('authrim_session=');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('allows revoking the current session before D1 persistence has caught up', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue(null);

    const response = await deleteAccountSessionHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'g1:apac:3:session_current' },
      })
    );
    const body = (await response.json()) as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.session.current).toBe(true);
    expect(mockSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('g1:apac:3:session_current');
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
  });

  it('does not revoke a session owned by another user', async () => {
    mockSessionStore.getSessionRpc.mockImplementation((sessionId: string) => {
      if (sessionId === 'g1:apac:3:session_foreign') {
        return Promise.resolve({
          id: sessionId,
          tenantId: 'default',
          userId: 'user-foreign',
        });
      }
      return Promise.resolve({
        id: 'g1:apac:3:session_current',
        tenantId: 'default',
        userId: 'user-001',
        createdAt: 1_777_000_000_000,
        expiresAt: Date.now() + 60_000,
      });
    });

    const response = await deleteAccountSessionHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'g1:apac:3:session_foreign' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(mockSessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
  });

  it('returns a typed failure when SessionStore invalidation fails', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'g1:apac:3:session_other',
      tenant_id: 'default',
      user_id: 'user-001',
      created_at: 1_777_100_000,
      expires_at: 1_777_200_000,
    });
    mockSessionStore.invalidateSessionRpc.mockRejectedValue(new Error('do unavailable'));

    const response = await deleteAccountSessionHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'g1:apac:3:session_other' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body.error).toBe('server_error');
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
  });
});
