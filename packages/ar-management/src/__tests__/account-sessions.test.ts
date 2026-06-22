import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCoreAdapter,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
    invalidateSessionRpc: vi.fn(),
  };
  const coreAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
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
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
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
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
    mockSessionStore.invalidateSessionRpc.mockResolvedValue(true);
    mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists only active sessions owned by the authenticated account', async () => {
    mockCoreAdapter.query.mockResolvedValue([
      {
        id: 'g1:apac:3:session_other',
        tenant_id: 'default',
        user_id: 'user-001',
        created_at: 1_777_100_000,
        expires_at: 1_777_200_000,
      },
      {
        id: 'g1:apac:3:session_current',
        tenant_id: 'default',
        user_id: 'user-001',
        created_at: 1_777_000_000,
        expires_at: 1_777_300_000,
      },
    ]);

    const response = await listAccountSessionsHandler(
      createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
    );
    const body = (await response.json()) as { sessions: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(expect.stringContaining('user_id = ?'), [
      'default',
      'user-001',
      Math.floor(Date.now() / 1000),
    ]);
    expect(body.sessions).toEqual([
      {
        id: 'g1:apac:3:session_other',
        current: false,
        created_at: 1_777_100_000_000,
        expires_at: 1_777_200_000_000,
      },
      {
        id: 'g1:apac:3:session_current',
        current: true,
        created_at: 1_777_000_000_000,
        expires_at: 1_777_300_000_000,
      },
    ]);
  });

  it('revokes an owned non-current session through SessionStore before deleting persistence', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue({
      id: 'g1:apac:3:session_other',
      tenant_id: 'default',
      user_id: 'user-001',
      created_at: 1_777_100_000,
      expires_at: 1_777_200_000,
    });

    const response = await deleteAccountSessionHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'g1:apac:3:session_other' },
      })
    );
    const body = (await response.json()) as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mockSessionStore.invalidateSessionRpc).toHaveBeenCalledWith(
      'g1:apac:3:session_other'
    );
    expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM sessions WHERE id = ? AND tenant_id = ?',
      ['g1:apac:3:session_other', 'default']
    );
    expect(body.session).toEqual({
      id: 'g1:apac:3:session_other',
      current: false,
      store_status: 'revoked',
    });
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('includes the current session even when D1 persistence has not caught up yet', async () => {
    mockCoreAdapter.query.mockResolvedValue([]);

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
      },
    ]);
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
    expect(mockSessionStore.invalidateSessionRpc).toHaveBeenCalledWith(
      'g1:apac:3:session_current'
    );
    expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM sessions WHERE id = ? AND tenant_id = ?',
      ['g1:apac:3:session_current', 'default']
    );
  });

  it('does not revoke a session owned by another user', async () => {
    mockCoreAdapter.queryOne.mockResolvedValue(null);

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

  it('keeps persistence intact when SessionStore invalidation fails', async () => {
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
