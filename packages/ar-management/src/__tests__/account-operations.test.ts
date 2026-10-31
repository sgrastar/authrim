import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCoreAdapter,
  mockPiiAdapter,
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
    mockPiiAdapter: { queryOne: vi.fn() },
  };
});

// Handler SQL/ACL unit tests inject their query port. The real storage boundary is exercised in log-iceberg-read-adapter.test.ts.
vi.mock('../log-read-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../log-read-adapter')>();
  return {
    ...actual,
    createLogReadAdapter: (input: {
      adapter: unknown;
      page?: { cursor?: string; scope: string };
    }) => {
      actual.decodeCursor(input.page?.cursor, input.page?.scope ?? '');
      return {
        adapter: input.adapter,
        hasArchive: () => false,
        pagination: () => undefined,
        coverage: () => undefined,
      };
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createPIIContextFromHono: () => ({ defaultPiiAdapter: mockPiiAdapter }),
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
  } as unknown as Parameters<typeof listAccountOperationsHandler>[0];
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
    mockPiiAdapter.queryOne.mockResolvedValue({ anonymized_user_id: 'anon-user-001' });
    mockCoreAdapter.query.mockResolvedValue([
      {
        id: 'audit-1',
        action: 'account.profile.name_updated',
        details_json: JSON.stringify({
          source: 'legacy_audit_log',
          resourceType: 'account_profile',
          resourceId: 'user-001',
          fields: ['name'],
        }),
        created_at: 1_777_200_000_000,
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
      expect.stringContaining("event_type LIKE 'account.%'"),
      ['default', 'anon-user-001', 100]
    );
    expect(mockPiiAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND user_id = ?'),
      ['default', 'user-001'],
      { consistencyClass: 'primary_required' }
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

  it('requires an authenticated account session before querying audit data', async () => {
    const response = await listAccountOperationsHandler(createMockContext());

    expect(response.status).toBe(401);
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
  });

  it('refuses a session belonging to another tenant before reading identity or log rows', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValueOnce({
      tenantId: 'tenant-b',
      userId: 'user-001',
      expiresAt: Date.now() + 60000,
    });
    const response = await listAccountOperationsHandler(
      createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
    );
    expect(response.status).toBe(401);
    expect(mockPiiAdapter.queryOne).not.toHaveBeenCalled();
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
  });

  it('queries with a null subject after mapping erasure and never recreates it', async () => {
    mockPiiAdapter.queryOne.mockResolvedValueOnce(null);
    mockCoreAdapter.query.mockResolvedValueOnce([]);
    const response = await listAccountOperationsHandler(
      createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
    );
    expect(response.status).toBe(200);
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('anonymized_user_id = ?'),
      ['default', null, 50]
    );
    expect(await response.json()).toMatchObject({ operations: [] });
    expect(mockPiiAdapter.queryOne).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid archived-history cursor before querying another user or returning an empty list', async () => {
    const context = createMockContext({
      cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
      query: { cursor: 'invalid' },
    });
    context.env.DB_ADMIN = {} as D1Database;
    const response = await listAccountOperationsHandler(context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 50],
    ['0', 50],
    ['not-a-number', 50],
    ['25', 25],
  ])('normalizes operation limit %s to %s', async (limit, expected) => {
    mockCoreAdapter.query.mockResolvedValue([]);
    const response = await listAccountOperationsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        query: limit === undefined ? {} : { limit },
      })
    );

    expect(response.status).toBe(200);
    expect(mockCoreAdapter.query).toHaveBeenCalledWith(expect.any(String), [
      'default',
      'anon-user-001',
      expected,
    ]);
  });

  it.each([[null], ['not-json'], ['[]'], ['null']])(
    'omits unsafe or malformed metadata %s',
    async (metadataJson) => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          id: 'audit-unsafe',
          action: 'account.session.revoked',
          resource_type: null,
          resource_id: null,
          details_json: metadataJson,
          created_at: 1,
        },
      ]);

      const response = await listAccountOperationsHandler(
        createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
      );
      const body = (await response.json()) as { operations: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.operations[0]).not.toHaveProperty('metadata');
    }
  );
});
