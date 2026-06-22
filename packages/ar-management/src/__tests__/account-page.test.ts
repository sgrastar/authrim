import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCreatePIIContextFromHono,
  mockFindById,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({ coreAdapter: {} }),
    mockCreatePIIContextFromHono: vi.fn().mockReturnValue({ defaultPiiAdapter: {} }),
    mockFindById: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createPIIContextFromHono: mockCreatePIIContextFromHono,
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        return mockFindById(userId);
      }
    },
  };
});

import { getAccountProfileHandler, getAccountReauthStatusHandler } from '../account-page';

function createMockContext(cookie?: string) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/profile', {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return {
    env: {} as Env,
    req: {
      method: 'GET',
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    header: (name: string, value: string) => {
      headers.set(name, value);
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

describe('Account Page API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_123',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: Math.floor(Date.now() / 1000) - 120,
        acr: 'urn:example:acr',
        amr: ['pwd'],
      },
    });
    mockFindById.mockResolvedValue({
      id: 'user-001',
      tenant_id: 'default',
      subject_id: 'sub-001',
      account_id: 'acct-001',
      account_type: 'end_user',
      lifecycle_state: 'active',
      email: 'person@example.test',
      email_verified: 1,
      name: 'Example Person',
      given_name: 'Example',
      family_name: 'Person',
      locale: 'ja',
      picture: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects profile requests without authrim_session', async () => {
    const response = await getAccountProfileHandler(createMockContext());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(mockGetSessionStoreBySessionId).not.toHaveBeenCalled();
  });

  it('returns a minimal account profile for a valid cookie session', async () => {
    const response = await getAccountProfileHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_123')
    );
    const body = (await response.json()) as {
      profile: Record<string, unknown>;
      session: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockGetSessionStoreBySessionId).toHaveBeenCalledWith(
      expect.anything(),
      'g1:apac:3:session_123',
      'default'
    );
    expect(body.profile).toEqual({
      user_id: 'user-001',
      email: 'person@example.test',
      email_verified: true,
      name: 'Example Person',
      given_name: 'Example',
      family_name: 'Person',
      locale: 'ja',
      picture: null,
    });
    expect(body.profile).not.toHaveProperty('password_hash');
    expect(body.session).toMatchObject({
      id: 'g1:apac:3:session_123',
      auth_time: Math.floor(Date.now() / 1000) - 120,
      acr: 'urn:example:acr',
      amr: ['pwd'],
    });
  });

  it('marks reauth as required after the five-minute window', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValueOnce({
      id: 'g1:apac:3:session_123',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: Math.floor(Date.now() / 1000) - 301,
        amr: ['pwd'],
      },
    });

    const response = await getAccountReauthStatusHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_123')
    );
    const body = (await response.json()) as {
      reauth: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.reauth).toMatchObject({
      required: true,
      ttl_seconds: 300,
      methods: ['pwd'],
    });
  });

  it('rejects expired sessions', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValueOnce({
      id: 'g1:apac:3:session_123',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() - 1,
      data: {},
    });

    const response = await getAccountProfileHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_123')
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('rejects sessions bound to another tenant', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValueOnce({
      id: 'g1:apac:3:session_123',
      tenantId: 'other-tenant',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });

    const response = await getAccountProfileHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_123')
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(mockFindById).not.toHaveBeenCalled();
  });
});
