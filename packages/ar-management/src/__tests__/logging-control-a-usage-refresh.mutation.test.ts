/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditWrite = vi.hoisted(() => vi.fn(async () => 'audit_1'));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const stepUp = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const mockAdapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { createApp, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const PERM = ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
type Body = Record<string, any>;

async function refresh(body: unknown = {}, opts: { platform?: boolean; perms?: string[] } = {}) {
  const res = await createApp(opts.perms ?? [PERM], { platform: opts.platform ?? true }).request(
    '/api/admin/logging-policies/usage-aggregates/refresh',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DB_ADMIN: {} }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const HOUR = 60 * 60 * 1000;
const START = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);

function rows(existing: string[] = []) {
  routeSql(mockAdapter, {
    one: [
      {
        match: /FROM logging_usage_aggregates/,
        result: (_s: string, p: unknown[]) =>
          existing.includes(String(p[0])) ? { id: p[0] } : null,
      },
    ],
    many: [
      {
        match: /FROM logging_delivery_event_aggregates/,
        result: [
          {
            tenant_key: 'tk1',
            log_type: 'audit',
            plane: 'archive',
            lane: 'critical',
            record_count: '10',
            byte_count: 2048,
            batch_count: '3',
          },
        ],
      },
      {
        match: /FROM log_object_catalog/,
        result: [
          {
            tenant_key: 'tk1',
            log_type: 'audit',
            plane: 'archive',
            object_count: 4,
            byte_count: '999',
          },
        ],
      },
      {
        match: /FROM logging_dlq_items/,
        result: [{ tenant_key: 'tk1', lane: 'bulk', item_count: '2' }],
      },
      {
        match: /FROM sensitive_detail_chunk_index/,
        result: [{ tenant_id: 'tenant-a', object_class: 'pii_detail', byte_count: 77 }],
      },
      {
        match: /FROM logging_message_jobs/,
        result: [
          { tenant_key: 'tk1', lane: 'default', kind: 'retry_delivery', job_count: 5 },
          { tenant_key: null, lane: null, kind: 'export_build', job_count: 1 },
        ],
      },
    ],
  });
}

const inserts = () =>
  mockAdapter.execute.mock.calls.filter(([s]) =>
    String(s).includes('INSERT INTO logging_usage_aggregates')
  );
const updates = () =>
  mockAdapter.execute.mock.calls.filter(([s]) =>
    String(s).includes('UPDATE logging_usage_aggregates')
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  rows();
});

describe('POST /usage-aggregates/refresh', () => {
  it('requires the platform default update permission and platform authority', async () => {
    expect((await refresh({}, { perms: [] })).status).toBe(403);
    const tenant = await refresh({}, { platform: false });
    expect(tenant.status).toBe(403);
    expect(tenant.body.details.permission.reason).toBe('platform_authority_required');
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('writes one aggregate per metric and source with the right values', async () => {
    const res = await refresh({ window_start_at: START, window_kind: 'hour' });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      refreshed: 9,
      window_start_at: START,
      window_end_at: START + HOUR,
    });
    expect(res.body.audit_id).toBe('audit_1');
    const byMetric = Object.fromEntries(inserts().map(([, p]) => [`${p[6]}`, p]));
    expect(Object.keys(byMetric).sort()).toEqual(
      [
        'catalog_bytes',
        'catalog_objects',
        'delivery_batches',
        'delivery_bytes',
        'delivery_records',
        'dlq_items',
        'message_jobs',
        'sensitive_detail_bytes',
      ].sort()
    );
    // [id, tenant_id, tenant_key, log_type, plane, lane, metric, window_kind, start, end, value, source, metadata, ...]
    const check = (metric: string, expected: Record<number, unknown>) => {
      const row = must(inserts().find(([, p]) => p[6] === metric))[1];
      for (const [index, value] of Object.entries(expected))
        expect(row[Number(index)]).toEqual(value);
    };
    check('delivery_records', {
      1: null,
      2: 'tk1',
      3: 'audit',
      4: 'archive',
      5: 'critical',
      7: 'hour',
      8: START,
      9: START + HOUR,
      10: 10,
      11: 'logging_delivery_event_aggregates',
    });
    check('delivery_bytes', { 10: 2048 });
    check('delivery_batches', { 10: 3 });
    check('catalog_objects', {
      2: 'tk1',
      3: 'audit',
      4: 'archive',
      5: null,
      10: 4,
      11: 'log_object_catalog',
    });
    check('catalog_bytes', { 10: 999 });
    check('dlq_items', { 2: 'tk1', 3: null, 4: null, 5: 'bulk', 10: 2, 11: 'logging_dlq_items' });
    check('sensitive_detail_bytes', {
      1: 'tenant-a',
      2: null,
      4: 'sensitive_detail',
      10: 77,
      11: 'sensitive_detail_chunk_index',
    });
    const sensitive = must(inserts().find(([, p]) => p[6] === 'sensitive_detail_bytes'))[1];
    expect(JSON.parse(sensitive[12])).toEqual({ object_class: 'pii_detail' });
    const jobs = inserts()
      .filter(([, p]) => p[6] === 'message_jobs')
      .map(([, p]) => p);
    expect(jobs.map((p) => [p[2], p[5], p[10], JSON.parse(p[12]).kind])).toEqual([
      ['tk1', 'default', 5, 'retry_delivery'],
      [null, null, 1, 'export_build'],
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.usage_aggregates.refresh',
        resourceType: 'logging_usage_aggregate',
        resourceId: `hour:${START}`,
        severity: 'info',
        metadata: {
          refreshed: 9,
          window_start_at: START,
          window_end_at: START + HOUR,
          tenant_key: null,
          tenant_id: null,
        },
      })
    );
  });

  it('builds ids that encode the window, metric and dimensions', async () => {
    await refresh({ window_start_at: START });
    const ids = inserts().map(([, p]) => p[0]);
    expect(ids).toContain(`uga:hour:${START}:delivery_records:all:tk1:audit:archive:critical`);
    expect(ids).toContain(`uga:hour:${START}:dlq_items:all:tk1:all:all:bulk`);
    expect(ids).toContain(
      `uga:hour:${START}:sensitive_detail_bytes:tenant-a:all:all:sensitive_detail:all`
    );
    expect(ids).toContain(`uga:hour:${START}:message_jobs:all:all:all:all:all`);
  });

  it('uses a day window of 24 hours', async () => {
    const res = await refresh({ window_start_at: START, window_kind: 'day' });
    expect(res.body.result.window_end_at).toBe(START + 24 * HOUR);
    expect(inserts()[0][1][7]).toBe('day');
    expect(String(inserts()[0][1][0])).toContain(`uga:day:${START}:`);
  });

  it('falls back to hour for unknown kinds and to the previous window for invalid starts', async () => {
    const before = Date.now();
    const floorTo = (t: number, unit: number) => t - (t % unit);
    for (const body of [
      { window_kind: 'week' },
      { window_start_at: -5 },
      { window_start_at: 'x' },
      {},
    ]) {
      mockAdapter.execute.mockClear();
      const res = await refresh(body);
      expect(res.status).toBe(200);
      expect(res.body.result.window_end_at - res.body.result.window_start_at).toBe(HOUR);
      expect(res.body.result.window_start_at % HOUR).toBe(0);
      // the previous completed hour: strictly before the current hour
      const after = Date.now();
      expect([floorTo(before, HOUR), floorTo(after, HOUR)]).toContain(
        res.body.result.window_end_at
      );
    }
    const day = await refresh({ window_kind: 'day' });
    expect(day.body.result.window_start_at % (24 * HOUR)).toBe(0);
    expect([floorTo(before, 24 * HOUR), floorTo(Date.now(), 24 * HOUR)]).toContain(
      day.body.result.window_end_at
    );
  });

  it('updates existing aggregates instead of inserting duplicates', async () => {
    rows([`uga:hour:${START}:dlq_items:all:tk1:all:all:bulk`]);
    const res = await refresh({ window_start_at: START });
    expect(res.body.result.refreshed).toBe(9);
    expect(updates()).toHaveLength(1);
    const [sql, params] = updates()[0];
    expect(sql).toContain('SET value = ?');
    expect(params.slice(0, 2)).toEqual([2, 'logging_dlq_items']);
    expect(params[2]).toBe('{}');
    expect(params[5]).toBe(`uga:hour:${START}:dlq_items:all:tk1:all:all:bulk`);
    expect(inserts()).toHaveLength(8);
  });

  it('scopes queries by tenant key and tenant id when requested', async () => {
    await refresh({ window_start_at: START, tenant_key: ' tk1 ', tenant_id: 'tenant-a' });
    const q = (needle: string) =>
      must(mockAdapter.query.mock.calls.find(([s]) => String(s).includes(needle)));
    for (const table of [
      'logging_delivery_event_aggregates',
      'FROM log_object_catalog',
      'FROM logging_dlq_items',
      'FROM logging_message_jobs',
    ]) {
      expect(q(table)[0]).toContain('AND tenant_key = ?');
      expect(q(table)[1]).toEqual([START, START + HOUR, 'tk1']);
    }
    expect(q('sensitive_detail_chunk_index')[0]).toContain('AND tenant_id = ?');
    expect(q('sensitive_detail_chunk_index')[1]).toEqual([START, START + HOUR, 'tenant-a']);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ tenant_key: 'tk1', tenant_id: 'tenant-a' }),
      })
    );
    mockAdapter.query.mockClear();
    await refresh({ window_start_at: START });
    for (const [sql, params] of mockAdapter.query.mock.calls) {
      expect(String(sql)).not.toContain('AND tenant_');
      expect(params).toEqual([START, START + HOUR]);
    }
  });

  it('coerces non-numeric sums to zero and reports 500 on failures', async () => {
    routeSql(mockAdapter, {
      many: [
        {
          match: /FROM logging_dlq_items/,
          result: [{ tenant_key: 'tk1', lane: 'bulk', item_count: 'many' }],
        },
      ],
    });
    await refresh({ window_start_at: START });
    expect(inserts()[0][1][10]).toBe(0);
    mockAdapter.query.mockRejectedValue(new Error('db'));
    expect((await refresh({ window_start_at: START })).status).toBe(500);
  });
});
