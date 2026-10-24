/**
 * zod 3 -> 4 migration pins for admin-stats.ts (StatsQuerySchema).
 *
 * `createErrorResponse` is mocked: the real one masks `variables` out of the HTTP body, so the
 * mock serialises `{ error: code, ...options }` (keeps the zod-derived `reason` string pinned)
 * and takes the HTTP status from the real implementation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  audit: { queryOne: vi.fn(), query: vi.fn() },
  hotSupport: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: { queryOne: vi.fn(), query: vi.fn() },
    })),
    createErrorResponse: vi.fn(async (c, code, options) => {
      const real = await actual.createErrorResponse(c, code, options);
      return Response.json({ error: code, ...options }, { status: real.status });
    }),
    getLogger: vi.fn(() => ({ module: vi.fn(() => ({ error: vi.fn() })) })),
  };
});

vi.mock('../../audit-hot-query', () => ({
  getAuditHotQuerySupport: mocks.hotSupport,
  createAuditHotQueryUnsupportedResponse: vi.fn((c) => c.json({ error: 'unsupported' }, 503)),
  getAuditHotQuerySqlSpec: vi.fn(() => ({
    tableName: 'audit_events',
    actionColumn: 'action',
    detailsColumn: 'details',
  })),
  getAuditTimeRange: vi.fn((from: number, to: number) => [from, to]),
}));

vi.mock('../../audit-sql-dialect', () => ({
  getAuditJsonTextExpr: vi.fn((_column, key) => `json_${key}`),
  getAuditTimelineGrouping: vi.fn((interval) => `group_${interval}`),
}));

import {
  adminStatsAuthHandler,
  adminStatsClientHandler,
  adminStatsTimelineHandler,
  adminStatsTokensHandler,
} from '../../admin-stats';

const from = '2026-07-01T00:00:00.000Z';
const to = '2026-07-02T00:00:00.000Z';
const clientId = '11111111-1111-4111-8111-111111111111';

function context(query: Record<string, string | undefined>, id = clientId) {
  return {
    req: {
      path: '/api/admin/stats/tokens',
      header: vi.fn(() => undefined),
      query: vi.fn((name: string) => query[name]),
      param: vi.fn((name: string) => (name === 'id' ? id : undefined)),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function call(handler: (c: never) => Promise<Response>, query: Record<string, string>) {
  const response = await handler(context(query));
  return { status: response.status, body: await response.json() };
}

const invalid = (reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field: 'query', reason } },
});

const RANGE_MSG = 'Date range exceeds limit. hour: max 7 days, day/week: max 90 days';
const ORDER_MSG = 'to must be greater than or equal to from';

describe('zod pins: admin-stats StatsQuerySchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.queryOne.mockResolvedValue({ count: 0 });
    mocks.audit.query.mockResolvedValue([]);
    mocks.hotSupport.mockResolvedValue({
      supported: true,
      context: {
        adapter: mocks.audit,
        mode: 'events',
        dialect: 'sqlite',
        createdAtUnit: 'seconds',
      },
    });
  });

  it('missing from/to is handled before zod (hand-written message)', async () => {
    expect(await call(adminStatsTokensHandler, {})).toEqual(
      invalid('from and to are required query parameters')
    );
    expect(await call(adminStatsTokensHandler, { from })).toEqual(
      invalid('from and to are required query parameters')
    );
  });

  it.each([
    // datetime message override; refinements still run on a "dirty" object in zod 3
    [
      'bad from',
      { from: 'bad', to },
      `from must be ISO 8601 datetime, to must be greater than or equal to from, ${RANGE_MSG}`,
    ],
    [
      'bad to',
      { from, to: 'bad' },
      `to must be ISO 8601 datetime, to must be greater than or equal to from, ${RANGE_MSG}`,
    ],
    [
      'both bad',
      { from: 'x', to: 'y' },
      `from must be ISO 8601 datetime, to must be ISO 8601 datetime, to must be greater than or equal to from, ${RANGE_MSG}`,
    ],
    [
      'bad interval enum',
      { from, to, interval: 'minute' },
      `Invalid enum value. Expected 'hour' | 'day' | 'week', received 'minute'`,
    ],
    ['bad client_id uuid', { from, to, client_id: 'not-a-uuid' }, `Invalid uuid`],
    ['to before from', { from: to, to: from }, ORDER_MSG],
    [
      'range > 90 days (day)',
      { from: '2026-01-01T00:00:00.000Z', to: '2026-04-02T00:00:00.000Z' },
      RANGE_MSG,
    ],
    [
      'range > 7 days (hour)',
      { from: '2026-07-01T00:00:00.000Z', to: '2026-07-09T00:00:00.000Z', interval: 'hour' },
      RANGE_MSG,
    ],
    [
      'bad from + bad interval + bad uuid',
      { from: 'z', to, interval: 'q', client_id: 'u' },
      `from must be ISO 8601 datetime, Invalid enum value. Expected 'hour' | 'day' | 'week', received 'q', Invalid uuid`,
    ],
    [
      'invalid interval + range exceeded',
      { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z', interval: 'month' },
      `Invalid enum value. Expected 'hour' | 'day' | 'week', received 'month'`,
    ],
  ])('rejects: %s', async (_name, query, reason) => {
    expect(await call(adminStatsTokensHandler, query as Record<string, string>)).toEqual(
      invalid(reason as string)
    );
  });

  it('shares the same validation across handlers', async () => {
    const q = { from: 'bad', to };
    const expected = invalid(`from must be ISO 8601 datetime, ${ORDER_MSG}, ${RANGE_MSG}`);
    expect(await call(adminStatsTokensHandler, q)).toEqual(expected);
    expect(await call(adminStatsAuthHandler, q)).toEqual(expected);
    expect(await call(adminStatsTimelineHandler, q)).toEqual(expected);
    expect(await call(adminStatsClientHandler, q)).toEqual(expected);
  });

  it('datetime() without `offset` option: which shapes are accepted (status per `from` value)', async () => {
    const values = [
      '2026-07-01T10:00Z',
      '2026-07-01T10:00:00Z',
      '2026-07-01T10:00:00+09:00',
      '2026-07-01T10:00:00+0900',
      '2026-07-01',
      '2026-07-01T00:00:00.123Z',
      '2026-07-01T00:00:00.1Z',
      '2026-07-01T00:00:00',
      '2026-07-01t00:00:00z',
      '2026-02-31T00:00:00Z',
      ' 2026-07-01T00:00:00Z',
      '2026-07-01T24:00:00Z',
    ];
    const statuses: Record<string, number> = {};
    for (const value of values) {
      statuses[value] = (
        await call(adminStatsTokensHandler, { from: value, to: '2026-07-02T00:00:00Z' })
      ).status;
    }
    expect(statuses).toEqual({
      '2026-07-01T10:00Z': 200,
      '2026-07-01T10:00:00Z': 200,
      '2026-07-01T10:00:00+09:00': 400,
      '2026-07-01T10:00:00+0900': 400,
      '2026-07-01': 400,
      '2026-07-01T00:00:00.123Z': 200,
      '2026-07-01T00:00:00.1Z': 200,
      '2026-07-01T00:00:00': 400,
      '2026-07-01t00:00:00z': 400,
      '2026-02-31T00:00:00Z': 400,
      ' 2026-07-01T00:00:00Z': 400,
      '2026-07-01T24:00:00Z': 400,
    });
  });

  it('applies defaults (interval=day, tz=UTC) observable via timeline response', async () => {
    const result = await call(adminStatsTimelineHandler, { from, to });
    expect(result).toEqual({
      status: 200,
      body: { data: [], interval: 'day', tz: 'UTC', period: { from, to } },
    });
  });

  it('passes through explicit interval/tz and accepts an empty-string tz', async () => {
    expect(
      await call(adminStatsTimelineHandler, { from, to, interval: 'week', tz: 'Asia/Tokyo' })
    ).toEqual({
      status: 200,
      body: { data: [], interval: 'week', tz: 'Asia/Tokyo', period: { from, to } },
    });
    expect(await call(adminStatsTimelineHandler, { from, to, tz: '' })).toEqual({
      status: 200,
      body: { data: [], interval: 'day', tz: '', period: { from, to } },
    });
  });

  it('accepts exactly 90 days (day) and exactly 7 days (hour), equal from/to', async () => {
    expect(
      (
        await call(adminStatsTokensHandler, {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-04-01T00:00:00.000Z',
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call(adminStatsTokensHandler, {
          from,
          to: '2026-07-08T00:00:00.000Z',
          interval: 'hour',
        })
      ).status
    ).toBe(200);
    expect((await call(adminStatsTokensHandler, { from, to: from })).status).toBe(200);
  });
});
