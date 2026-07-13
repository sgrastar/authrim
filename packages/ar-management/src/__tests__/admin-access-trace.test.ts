import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn() },
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));

import {
  adminAccessTraceGetHandler,
  adminAccessTraceListHandler,
  adminAccessTraceStatsHandler,
  adminAccessTraceTimelineHandler,
} from '../admin-access-trace';

function context(options: { query?: Record<string, string>; id?: string } = {}) {
  return {
    req: {
      query: vi.fn((name?: string) => (name ? options.query?.[name] : (options.query ?? {}))),
      param: vi.fn(() => options.id ?? 'trace-1'),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function trace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trace-1',
    tenant_id: 'tenant-a',
    subject_id: 'user-1',
    permission: 'document:read',
    permission_json: '{"resource":"doc-1"}',
    allowed: 1,
    resolved_via_json: '["role","organization"]',
    final_decision: 'allow',
    reason: null,
    api_key_id: null,
    client_id: 'client-1',
    checked_at: 100,
    ...overrides,
  };
}

describe('admin access trace APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
  });

  it.each([
    [{}, [50, 0]],
    [
      {
        subject_id: 'user-1',
        permission: 'document',
        allowed: 'true',
        final_decision: 'allow',
        start_time: '10',
        end_time: '20',
        page: '2',
        limit: '999',
      },
      [200, 200],
    ],
    [{ allowed: 'false', page: '0', limit: '0' }, [1, 0]],
  ])('lists access traces with filters and bounded pagination %#', async (query, pageTail) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 201 });
    mocks.adapter.query.mockResolvedValueOnce([
      trace(),
      trace({ id: 'trace-2', allowed: 0, permission_json: '{', resolved_via_json: null }),
    ]);
    const body = (await (await adminAccessTraceListHandler(context({ query }))).json()) as {
      entries: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };
    expect(body.entries).toEqual([
      expect.objectContaining({
        allowed: true,
        permission_parsed: { resource: 'doc-1' },
        resolved_via: ['role', 'organization'],
      }),
      expect.objectContaining({ allowed: false, permission_parsed: null, resolved_via: [] }),
    ]);
    expect(mocks.adapter.query.mock.calls[0][1]).toEqual(expect.arrayContaining(pageTail));
  });

  it('defaults absent trace totals and handles list failure', async () => {
    await expect((await adminAccessTraceListHandler(context())).json()).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAccessTraceListHandler(context())).status).toBe(500);
  });

  it.each([null, trace()])('gets tenant-scoped trace result %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    const response = await adminAccessTraceGetHandler(context());
    expect(response.status).toBe(row ? 200 : 404);
  });

  it('handles trace get failure', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAccessTraceGetHandler(context())).status).toBe(500);
  });

  it.each(['1h', '6h', '24h', '7d', '30d', 'unknown'])(
    'computes stats for period %s',
    async (period) => {
      mocks.adapter.queryOne.mockResolvedValueOnce({ total: 10, allowed: 7, denied: 3 });
      mocks.adapter.query
        .mockResolvedValueOnce([{ permission: 'admin:write', count: 3 }])
        .mockResolvedValueOnce([{ subject_id: 'user-1', count: 3 }])
        .mockResolvedValueOnce([
          { resolved_via_json: '["role","role"]' },
          { resolved_via_json: '"direct"' },
          { resolved_via_json: '{"policy":"allow"}' },
          { resolved_via_json: '{' },
          { resolved_via_json: null },
        ]);
      const body = (await (
        await adminAccessTraceStatsHandler(context({ query: { period } }))
      ).json()) as {
        allow_rate: number;
        resolution_distribution: Array<{ resolved_via: string; count: number }>;
      };
      expect(body.allow_rate).toBe(70);
      expect(body.resolution_distribution[0]).toEqual({ resolved_via: 'role', count: 2 });
      expect(body.resolution_distribution).toEqual(
        expect.arrayContaining([
          { resolved_via: 'direct', count: 1 },
          { resolved_via: '{"policy":"allow"}', count: 1 },
        ])
      );
    }
  );

  it('returns zero rates for missing stats and handles stats failure', async () => {
    const body = (await (await adminAccessTraceStatsHandler(context())).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ total: 0, allowed: 0, denied: 0, allow_rate: 0 });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAccessTraceStatsHandler(context())).status).toBe(500);
  });

  it.each([
    ['1h', undefined, 300],
    ['6h', undefined, 1800],
    ['24h', 'minute', 60],
    ['24h', 'hour', 3600],
    ['7d', undefined, 21600],
    ['30d', undefined, 86400],
    ['unknown', undefined, 3600],
  ])('builds timeline period=%s granularity=%s', async (period, granularity, bucketSize) => {
    mocks.adapter.query.mockResolvedValueOnce([{ bucket: 100, total: 4, allowed: 3, denied: 1 }]);
    const body = (await (
      await adminAccessTraceTimelineHandler(
        context({ query: { period, ...(granularity ? { granularity } : {}) } })
      )
    ).json()) as { granularity: number; data: unknown[] };
    expect(body).toEqual({
      period,
      granularity: bucketSize,
      data: [{ timestamp: 100, total: 4, allowed: 3, denied: 1 }],
    });
    expect(mocks.adapter.query.mock.calls[0][1][0]).toBe(bucketSize);
  });

  it('handles timeline query failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAccessTraceTimelineHandler(context())).status).toBe(500);
  });
});
