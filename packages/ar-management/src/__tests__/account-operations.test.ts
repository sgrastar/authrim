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
  };
  const coreAdapter = {
    query: vi.fn(),
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

import { listAccountOperationsHandler } from '../account-operations';

function createMockContext(options: { cookie?: string; query?: Record<string, string> } = {}) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/operations', {
    headers: options.cookie ? { Cookie: options.cookie } : {},
  });
  return {
    env: {} as Env,
    req: {
      method: 'GET',
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
      query: (name: string) => options.query?.[name],
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

describe('Account Page operation history API', () => {
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
    mockCoreAdapter.query.mockResolvedValue([
      {
        id: 'audit-1',
        action: 'account.profile.name_updated',
        resource_type: 'account_profile',
        resource_id: 'user-001',
        metadata_json: JSON.stringify({ fields: ['name'] }),
        created_at: 1_777_200_000,
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists only the authenticated user account operations with bounded limit', async () => {
    const response = await listAccountOperationsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        query: { limit: '500' },
      })
    );
    const body = (await response.json()) as { operations: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining("action LIKE 'account.%'"),
      ['default', 'user-001', 100]
    );
    expect(body.operations).toEqual([
      {
        id: 'audit-1',
        action: 'account.profile.name_updated',
        resource_type: 'account_profile',
        resource_id: 'user-001',
        created_at: 1_777_200_000,
        metadata: { fields: ['name'] },
      },
    ]);
  });
});
