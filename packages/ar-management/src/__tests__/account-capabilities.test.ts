import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

import { getAccountCapabilitiesHandler } from '../account-capabilities';

function createMockContext(cookie?: string) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/capabilities', {
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

describe('Account Page capabilities API', () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires an Account Page cookie session', async () => {
    const response = await getAccountCapabilitiesHandler(createMockContext());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(mockGetSessionStoreBySessionId).not.toHaveBeenCalled();
  });

  it('returns available and planned capabilities without enabling Phase 4E high-risk features', async () => {
    const response = await getAccountCapabilitiesHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current')
    );
    const body = (await response.json()) as {
      capabilities: Array<Record<string, unknown>>;
      sections: Array<Record<string, unknown>>;
      theme: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'profile.name', status: 'available' }),
        expect.objectContaining({ id: 'passkeys.manage', status: 'available' }),
        expect.objectContaining({
          id: 'email.change',
          status: 'planned',
          requires_reauth: true,
          planned_phase: '4E-1',
        }),
        expect.objectContaining({
          id: 'account.deletion',
          status: 'planned',
          requires_reauth: true,
          planned_phase: '4E-2',
        }),
      ])
    );
    expect(body.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'profile', status: 'available' }),
        expect.objectContaining({ id: 'danger', status: 'planned' }),
      ])
    );
    expect(body.theme).toMatchObject({
      version: 1,
      scope: 'login-ui',
      source: 'default',
      account_page_overrides_supported: false,
    });
  });
});
