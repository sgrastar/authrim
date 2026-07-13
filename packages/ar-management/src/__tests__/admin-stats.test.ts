import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  core: { queryOne: vi.fn(), query: vi.fn() },
  audit: { queryOne: vi.fn(), query: vi.fn() },
  hotSupport: vi.fn(),
  unsupported: vi.fn(),
  getClient: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    getClient: mocks.getClient,
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
            ? 500
            : 400;
      return c.json({ error: code, ...options }, status);
    }),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

vi.mock('../audit-hot-query', () => ({
  getAuditHotQuerySupport: mocks.hotSupport,
  createAuditHotQueryUnsupportedResponse: mocks.unsupported,
  getAuditHotQuerySqlSpec: vi.fn((context) => ({
    tableName: context.mode === 'legacy' ? 'audit_logs' : 'audit_events',
    actionColumn: 'action',
    detailsColumn: 'details',
  })),
  getAuditTimeRange: vi.fn((from: number, to: number, context) =>
    context.createdAtUnit === 'milliseconds' ? [from * 1000, to * 1000] : [from, to]
  ),
}));

vi.mock('../audit-sql-dialect', () => ({
  getAuditJsonTextExpr: vi.fn((_column, key) => `json_${key}`),
  getAuditTimelineGrouping: vi.fn((interval) => `group_${interval}`),
}));

import {
  adminStatsAuthHandler,
  adminStatsClientHandler,
  adminStatsGeographyHandler,
  adminStatsTimelineHandler,
  adminStatsTokensHandler,
} from '../admin-stats';

const from = '2026-07-01T00:00:00.000Z';
const to = '2026-07-02T00:00:00.000Z';
const clientId = '11111111-1111-4111-8111-111111111111';

function auditContext(
  mode: 'legacy' | 'events' = 'events',
  createdAtUnit: 'seconds' | 'milliseconds' = 'seconds'
) {
  return { adapter: mocks.audit, mode, dialect: 'sqlite', createdAtUnit };
}

function context(
  options: {
    query?: Record<string, string | undefined>;
    id?: string;
  } = {}
) {
  const query = options.query ?? { from, to };
  return {
    req: {
      query: vi.fn((name: string) => query[name]),
      param: vi.fn((name: string) => (name === 'id' ? (options.id ?? clientId) : undefined)),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('admin statistics contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.core.queryOne.mockResolvedValue({ count: 0 });
    mocks.core.query.mockResolvedValue([]);
    mocks.audit.queryOne.mockResolvedValue({ count: 0 });
    mocks.audit.query.mockResolvedValue([]);
    mocks.hotSupport.mockResolvedValue({ supported: true, context: auditContext() });
    mocks.unsupported.mockImplementation((c) => c.json({ error: 'unsupported' }, 503));
    mocks.getClient.mockResolvedValue({
      client_id: clientId,
      tenant_id: 'tenant-a',
      client_name: 'Dashboard',
    });
  });

  describe('common query validation', () => {
    it.each([
      [{ to }, 'from and to are required'],
      [{ from }, 'from and to are required'],
      [{ from: 'bad', to }, 'from must be ISO'],
      [{ from: to, to: from }, 'to must be greater'],
      [{ from: '2026-01-01T00:00:00.000Z', to: '2026-04-02T00:00:00.000Z' }, 'Date range exceeds'],
      [
        { from: '2026-07-01T00:00:00.000Z', to: '2026-07-09T00:00:00.000Z', interval: 'hour' },
        'Date range exceeds',
      ],
      [{ from, to, interval: 'minute' }, 'Invalid enum value'],
      [{ from, to, client_id: 'not-a-uuid' }, 'Invalid uuid'],
    ])('rejects malformed stats query %#', async (query, message) => {
      const response = await adminStatsTokensHandler(context({ query }));
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(message);
      expect(mocks.hotSupport).not.toHaveBeenCalled();
    });

    it.each([[adminStatsAuthHandler], [adminStatsTimelineHandler], [adminStatsGeographyHandler]])(
      'applies common required-range validation to handler %#',
      async (handler) => {
        expect((await handler(context({ query: {} }))).status).toBe(400);
      }
    );

    it('requires client route ID before stats lookup', async () => {
      expect((await adminStatsClientHandler(context({ id: '' }))).status).toBe(400);
    });
  });

  describe('token statistics', () => {
    it.each([
      [{ supported: false }, 503],
      [{ supported: true, context: null }, 503],
    ])(
      'returns explicit unsupported response for hot audit topology %#',
      async (support, status) => {
        mocks.hotSupport.mockResolvedValueOnce(support);
        expect((await adminStatsTokensHandler(context())).status).toBe(status);
      }
    );

    it('combines core active counts and audit issuance counts with null fallbacks', async () => {
      mocks.core.queryOne.mockResolvedValueOnce({ count: 7 }).mockResolvedValueOnce(null);
      mocks.audit.queryOne
        .mockResolvedValueOnce({ count: 3 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ count: 2 });
      const response = await adminStatsTokensHandler(context());
      await expect(response.json()).resolves.toEqual({
        access_tokens: { active: 7, issued_today: 3, revoked_today: 1 },
        refresh_tokens: { active: 0, issued_today: 0, revoked_today: 2 },
        period: { from, to },
      });
    });

    it('returns internal_error for token query failures', async () => {
      mocks.hotSupport.mockRejectedValueOnce(new Error('audit unavailable'));
      expect((await adminStatsTokensHandler(context())).status).toBe(500);
    });
  });

  describe('authentication statistics', () => {
    it.each([
      ['events', undefined, 4],
      ['events', clientId, 4],
      ['legacy', undefined, 1],
      ['legacy', clientId, 1],
    ] as const)(
      'queries %s mode with client=%s using %i client bindings',
      async (mode, filter, expectedBindings) => {
        mocks.hotSupport.mockResolvedValueOnce({ supported: true, context: auditContext(mode) });
        mocks.audit.queryOne.mockResolvedValueOnce({
          total: 4,
          successful: 3,
          failed: 1,
          mfa_used: 2,
        });
        mocks.audit.query.mockResolvedValueOnce([
          { grant_type: 'authorization_code', successful: 2, failed: 1 },
        ]);
        const response = await adminStatsAuthHandler(
          context({ query: { from, to, client_id: filter } })
        );
        await expect(response.json()).resolves.toMatchObject({
          total_attempts: 4,
          successful: 3,
          failed: 1,
          success_rate: 75,
          mfa_used: 2,
          by_grant_type: { authorization_code: { successful: 2, failed: 1 } },
        });
        const bindings = mocks.audit.queryOne.mock.calls[0]?.[1] as unknown[];
        expect(bindings.length).toBe(filter ? 3 + expectedBindings : 3);
      }
    );

    it('returns zero-safe auth statistics when aggregate row is missing', async () => {
      mocks.audit.queryOne.mockResolvedValueOnce(null);
      const response = await adminStatsAuthHandler(context());
      await expect(response.json()).resolves.toMatchObject({
        total_attempts: 0,
        successful: 0,
        failed: 0,
        success_rate: 0,
        mfa_used: 0,
      });
    });

    it('returns unsupported and failure responses', async () => {
      mocks.hotSupport.mockResolvedValueOnce({ supported: false });
      expect((await adminStatsAuthHandler(context())).status).toBe(503);
      mocks.hotSupport.mockRejectedValueOnce(new Error('audit unavailable'));
      expect((await adminStatsAuthHandler(context())).status).toBe(500);
    });
  });

  describe('timeline statistics', () => {
    it.each([
      ['hour', 'Asia/Tokyo'],
      ['day', undefined],
      ['week', 'UTC'],
    ] as const)('returns ordered %s buckets with tz=%s', async (interval, tz) => {
      mocks.audit.query.mockResolvedValueOnce([
        { time_bucket: '2026-07-01T00:00:00Z', success: 2, failed: 1, mfa_used: 1 },
      ]);
      const response = await adminStatsTimelineHandler(
        context({ query: { from, to, interval, tz } })
      );
      await expect(response.json()).resolves.toMatchObject({
        data: [{ ts: '2026-07-01T00:00:00Z', success: 2, failed: 1, mfa_used: 1 }],
        interval,
        tz: tz ?? 'UTC',
      });
    });

    it.each([
      ['legacy', clientId, 1],
      ['events', clientId, 4],
      ['legacy', undefined, 0],
      ['events', undefined, 0],
    ] as const)('builds %s timeline client filter=%s', async (mode, filter, extra) => {
      mocks.hotSupport.mockResolvedValueOnce({ supported: true, context: auditContext(mode) });
      await adminStatsTimelineHandler(context({ query: { from, to, client_id: filter } }));
      const bindings = mocks.audit.query.mock.calls[0]?.[1] as unknown[];
      expect(bindings).toHaveLength(3 + extra);
    });

    it('returns unsupported and failure responses', async () => {
      mocks.hotSupport.mockResolvedValueOnce({ supported: true, context: null });
      expect((await adminStatsTimelineHandler(context())).status).toBe(503);
      mocks.audit.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminStatsTimelineHandler(context())).status).toBe(500);
    });
  });

  describe('client statistics', () => {
    it('rejects missing or cross-tenant clients before analytics queries', async () => {
      mocks.getClient.mockResolvedValueOnce(null);
      expect((await adminStatsClientHandler(context())).status).toBe(404);
      mocks.getClient.mockResolvedValueOnce({ client_id: clientId, tenant_id: 'tenant-b' });
      expect((await adminStatsClientHandler(context())).status).toBe(404);
    });

    it.each([
      ['events', 'seconds', 4],
      ['legacy', 'milliseconds', 3],
    ] as const)('returns complete %s/%s client statistics', async (mode, unit, _bindingCount) => {
      mocks.hotSupport.mockResolvedValueOnce({
        supported: true,
        context: auditContext(mode, unit),
      });
      mocks.audit.queryOne
        .mockResolvedValueOnce({ issued_today: 5, revoked_today: 1 })
        .mockResolvedValueOnce({ total: 10, successful: 8, failed: 2 })
        .mockResolvedValueOnce({
          api_calls_today: 20,
          api_calls_month: 100,
          unique_users: 7,
          last_activity: unit === 'milliseconds' ? 1_700_000_000_000 : 1_700_000_000,
        });
      mocks.core.queryOne.mockResolvedValueOnce({ active_access: 4, active_refresh: 3 });
      const response = await adminStatsClientHandler(context());
      await expect(response.json()).resolves.toMatchObject({
        client_id: clientId,
        client_name: 'Dashboard',
        tokens: {
          active_access_tokens: 4,
          active_refresh_tokens: 3,
          issued_today: 5,
          revoked_today: 1,
        },
        auth: { total_attempts: 10, successful: 8, failed: 2, success_rate: 80 },
        usage: { api_calls_today: 20, api_calls_this_month: 100, unique_users: 7 },
      });
    });

    it('uses null-safe client statistics and no last activity', async () => {
      mocks.getClient.mockResolvedValueOnce({ client_id: clientId, tenant_id: 'tenant-a' });
      mocks.audit.queryOne.mockResolvedValue(null);
      mocks.core.queryOne.mockResolvedValueOnce(null);
      const response = await adminStatsClientHandler(context());
      await expect(response.json()).resolves.toMatchObject({
        client_name: null,
        tokens: {
          active_access_tokens: 0,
          active_refresh_tokens: 0,
          issued_today: 0,
          revoked_today: 0,
        },
        auth: { total_attempts: 0, successful: 0, failed: 0, success_rate: 0 },
        usage: {
          api_calls_today: 0,
          api_calls_this_month: 0,
          unique_users: 0,
          last_activity: null,
        },
      });
    });

    it('returns unsupported and internal error responses', async () => {
      mocks.hotSupport.mockResolvedValueOnce({ supported: false });
      expect((await adminStatsClientHandler(context())).status).toBe(503);
      mocks.getClient.mockRejectedValueOnce(new Error('client store unavailable'));
      expect((await adminStatsClientHandler(context())).status).toBe(500);
    });
  });

  describe('geography statistics', () => {
    it.each([
      ['events', 'seconds'],
      ['legacy', 'milliseconds'],
    ] as const)('aggregates %s/%s countries into regions', async (mode, unit) => {
      mocks.hotSupport.mockResolvedValueOnce({
        supported: true,
        context: auditContext(mode, unit),
      });
      mocks.audit.query.mockResolvedValueOnce([
        {
          country_code: 'JP',
          total_requests: 10,
          successful: 8,
          failed: 2,
          unique_users: 5,
          last_activity: unit === 'milliseconds' ? 1_700_000_000_000 : 1_700_000_000,
        },
        {
          country_code: 'AU',
          total_requests: 12,
          successful: 10,
          failed: 2,
          unique_users: 7,
          last_activity: null,
        },
        {
          country_code: 'ZZ',
          total_requests: 3,
          successful: 1,
          failed: 2,
          unique_users: 2,
          last_activity: null,
        },
      ]);
      const response = await adminStatsGeographyHandler(context());
      const body = (await response.json()) as {
        by_country: Array<Record<string, unknown>>;
        by_region: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };
      expect(body.by_country[0]).toMatchObject({ country_name: 'Japan' });
      expect(body.by_country[2]).toMatchObject({ country_name: 'ZZ', last_activity: null });
      expect(body.by_region).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            region: 'Asia Pacific',
            total_requests: 22,
            countries: 2,
            top_country: 'AU',
          }),
          expect.objectContaining({ region: 'Other', total_requests: 3 }),
        ])
      );
      expect(body.summary).toEqual({ total_countries: 3, total_requests: 25, unique_users: 14 });
    });

    it('caps top countries at ten', async () => {
      mocks.audit.query.mockResolvedValueOnce(
        Array.from({ length: 12 }, (_, index) => ({
          country_code: `X${index}`,
          total_requests: 12 - index,
          successful: 1,
          failed: 0,
          unique_users: 1,
          last_activity: null,
        }))
      );
      const body = (await (await adminStatsGeographyHandler(context())).json()) as {
        top_countries: unknown[];
      };
      expect(body.top_countries).toHaveLength(10);
    });

    it('returns unsupported and internal errors', async () => {
      mocks.hotSupport.mockResolvedValueOnce({ supported: false });
      expect((await adminStatsGeographyHandler(context())).status).toBe(503);
      mocks.audit.query.mockRejectedValueOnce(new Error('query failed'));
      expect((await adminStatsGeographyHandler(context())).status).toBe(500);
    });
  });
});
