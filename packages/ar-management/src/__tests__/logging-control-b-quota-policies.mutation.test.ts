/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: (await import('./logging-control-b-harness')).auditWrite,
}));
vi.mock('../admin-step-up-gate', async () => {
  const { stepUpFakes } = await import('./logging-control-b-harness');
  return {
    requireAdminStepUp: stepUpFakes.requireAdminStepUp,
    refuseAdminFreshAuth: stepUpFakes.refuseAdminFreshAuth,
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { auditWrite, mockAdapter, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const READ = [ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ];
const PLATFORM_UPDATE = ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
const TENANT_UPDATE = ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE;
const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const DAY_START = Date.UTC(2026, 2, 5);
const HOUR_START = Date.UTC(2026, 2, 5, 10);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function withFixedNow() {
  beforeEach(() => {
    resetFakes();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
}

describe('usage-aggregates (GET)', () => {
  withFixedNow();
  const path = `${POLICIES}/usage-aggregates`;

  it('requires overview read', async () => {
    const res = await call(
      createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]),
      'GET',
      path
    );
    expect(res.status).toBe(403);
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('refuses a foreign tenant key or tenant id for a tenant admin', async () => {
    const byKey = await call(createApp(READ), 'GET', `${path}?tenant_key=other`);
    expect(byKey.status).toBe(403);
    expect(byKey.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
    const byId = await call(createApp(READ), 'GET', `${path}?tenant_id=tenant-b`);
    expect(byId.body.details.permission.reason).toBe('tenant_id_scope_mismatch');
  });

  it('defaults to day windows over the last 24 hours, scoped to the caller tenant key', async () => {
    mockAdapter.query.mockResolvedValueOnce([{ id: 'u1' }]);
    const res = await call(createApp(READ), 'GET', path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ id: 'u1' }], total: 1 });
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE window_kind = ? AND window_start_at >= ? AND tenant_key = ?');
    expect(sql).toContain('ORDER BY window_start_at DESC, metric_name ASC');
    expect(params).toEqual([
      'day',
      NOW - DAY,
      await deriveTenantKeyFromTenantId('tenant-a', undefined),
      100,
    ]);
  });

  it('applies window kind, bounds, tenant key and metric filters', async () => {
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?filter[window_kind]=hour&time_start=10&time_end=20&filter[tenant_key]=tk_1&filter[metric_name]=delivery_bytes&limit=600`
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'WHERE window_kind = ? AND window_start_at >= ? AND window_start_at <= ? AND tenant_key = ? AND metric_name = ?'
    );
    expect(params).toEqual(['hour', 10, 20, 'tk_1', 'delivery_bytes', 500]);
  });

  it('ignores unsupported metric names and window kinds', async () => {
    await call(createPlatformApp(READ), 'GET', `${path}?metric_name=bogus&window_kind=week`);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('metric_name = ?');
    expect(sql).not.toContain('tenant_key = ?');
    expect(params).toEqual(['day', NOW - DAY, 100]);
  });

  it('resolves tenant_id to a tenant key for platform callers and answers 500 on failure', async () => {
    await call(createPlatformApp(READ), 'GET', `${path}?tenant_id=tenant-z`);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([
      'day',
      NOW - DAY,
      await deriveTenantKeyFromTenantId('tenant-z', undefined),
      100,
    ]);
    mockAdapter.query.mockRejectedValueOnce(new Error('x'));
    expect((await call(createPlatformApp(READ), 'GET', path)).status).toBe(500);
  });
});

describe('usage-aggregates/refresh (POST)', () => {
  withFixedNow();
  const path = `${POLICIES}/usage-aggregates/refresh`;

  it('requires the platform defaults permission and global platform authority', async () => {
    const denied = await call(createApp(READ), 'POST', path, {});
    expect(denied.status).toBe(403);
    const notGlobal = await call(
      createApp([PLATFORM_UPDATE], ['ar_super_admin'], false),
      'POST',
      path,
      {}
    );
    expect(notGlobal.status).toBe(403);
    expect(notGlobal.body.details.permission).toEqual({
      required_scope: 'platform',
      reason: 'platform_authority_required',
    });
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('defaults to the previous full hour', async () => {
    const res = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', path);
    expect(res.status).toBe(200);
    // now - 1h = 09:20:30 -> floored to 09:00
    expect(res.body.result).toEqual({
      refreshed: 0,
      window_start_at: HOUR_START - HOUR,
      window_end_at: HOUR_START,
    });
    expect(res.body.audit_id).toBe('audit-id-1');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.usage_aggregates.refresh',
        resourceType: 'logging_usage_aggregate',
        resourceId: `hour:${HOUR_START - HOUR}`,
        result: 'success',
        severity: 'info',
        metadata: expect.objectContaining({ tenant_key: null, tenant_id: null }),
      })
    );
  });

  it('defaults a day window to the previous UTC day', async () => {
    const res = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', path, {
      window_kind: 'day',
    });
    expect(res.body.result.window_start_at).toBe(DAY_START - DAY);
    expect(res.body.result.window_end_at).toBe(DAY_START);
  });

  it('honours an explicit window start and tenant filters', async () => {
    const res = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', path, {
      window_kind: 'day',
      window_start_at: 5000,
      tenant_key: ' tk_9 ',
      tenant_id: 'tenant-9',
    });
    expect(res.body.result).toEqual({
      refreshed: 0,
      window_start_at: 5000,
      window_end_at: 5000 + DAY,
    });
    const queries = mockAdapter.query.mock.calls as Array<[string, unknown[]]>;
    expect(queries[0][1]).toEqual([5000, 5000 + DAY, 'tk_9']);
    expect(queries[3][0]).toContain('sensitive_detail_chunk_index');
    expect(queries[3][1]).toEqual([5000, 5000 + DAY, 'tenant-9']);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'day:5000',
        metadata: expect.objectContaining({ tenant_key: 'tk_9', tenant_id: 'tenant-9' }),
      })
    );
  });

  it('falls back to the default window for a non-positive start and answers 500 on failure', async () => {
    const res = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', path, {
      window_start_at: -5,
      window_kind: 'bogus',
    });
    expect(res.body.result.window_start_at).toBe(HOUR_START - HOUR);
    mockAdapter.query.mockRejectedValueOnce(new Error('x'));
    expect((await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', path, {})).status).toBe(500);
  });
});

describe('quota-policies (GET)', () => {
  withFixedNow();
  const path = `${POLICIES}/quota-policies`;

  it('requires overview read', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
  });

  it('limits a tenant admin without a scope id to its own tenant policies', async () => {
    mockAdapter.query.mockResolvedValue([{ id: 'lqp_1' }]);
    const res = await call(createApp(READ), 'GET', path);
    expect(res.body).toEqual({ items: [{ id: 'lqp_1' }], total: 1 });
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE status <> 'deleted' AND (scope_type = ? AND scope_id = ?)");
    expect(params).toEqual(['tenant', 'tenant-a', 100]);
  });

  it('lets platform callers list everything or filter by scope', async () => {
    await call(createPlatformApp(READ), 'GET', path);
    let [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE status <> 'deleted'\n");
    expect(params).toEqual([100]);

    mockAdapter.query.mockClear();
    await call(
      createPlatformApp(READ),
      'GET',
      `${path}?filter[scope_type]=platform&filter[scope_id]=global&limit=700`
    );
    [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status <> 'deleted' AND scope_type = ? AND scope_id = ?");
    expect(params).toEqual(['platform', 'global', 500]);
  });

  it('enforces tenancy for an explicit scope id', async () => {
    const own = await call(createApp(READ), 'GET', `${path}?scope_type=tenant&scope_id=tenant-a`);
    expect(own.status).toBe(200);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual(['tenant', 'tenant-a', 100]);

    const foreign = await call(
      createApp(READ),
      'GET',
      `${path}?scope_type=tenant&scope_id=tenant-b`
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body.details.permission.reason).toBe('tenant_scope_mismatch');

    const platformScope = await call(
      createApp(READ),
      'GET',
      `${path}?scope_type=platform&scope_id=global`
    );
    expect(platformScope.status).toBe(403);
    expect(platformScope.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    const noType = await call(createApp(READ), 'GET', `${path}?scope_id=global`);
    expect(noType.status).toBe(403);
  });

  it('answers 500 when the query fails', async () => {
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createApp(READ), 'GET', path)).status).toBe(500);
  });
});

describe('quota-policies (POST)', () => {
  withFixedNow();
  const path = `${POLICIES}/quota-policies`;
  const platformApp = () => createPlatformApp([PLATFORM_UPDATE, TENANT_UPDATE]);

  it('requires one of the update permissions', async () => {
    expect(
      (await call(createApp(READ), 'POST', path, { metric_name: 'delivery_bytes' })).status
    ).toBe(403);
  });

  it('reports every invalid field of the body', async () => {
    const res = await call(platformApp(), 'POST', path, {
      metric_name: 'bogus',
      soft_limit: 'abc',
      hard_limit: -1,
      warning_ratio: 0,
      expected_version: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'metric_name', code: 'invalid_value', message: 'Quota metric is not supported.' },
      {
        path: 'soft_limit',
        code: 'invalid_value',
        message: 'Soft limit must be a positive integer.',
      },
      {
        path: 'hard_limit',
        code: 'invalid_value',
        message: 'Hard limit must be a positive integer.',
      },
      {
        path: 'warning_ratio',
        code: 'invalid_value',
        message: 'Warning ratio must be greater than 0 and <= 1.',
      },
      {
        path: 'expected_version',
        code: 'invalid_value',
        message: 'Expected version must be a positive integer.',
      },
    ]);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects a soft limit above the hard limit, a ratio above 1 and a null expected version', async () => {
    const soft = await call(platformApp(), 'POST', path, {
      metric_name: 'delivery_bytes',
      soft_limit: 11,
      hard_limit: 10,
    });
    expect(soft.body.details.fields).toEqual([
      {
        path: 'soft_limit',
        code: 'invalid_value',
        message: 'Soft limit must not exceed hard limit.',
      },
    ]);
    const equal = await call(platformApp(), 'POST', path, {
      metric_name: 'delivery_bytes',
      soft_limit: 10,
      hard_limit: 10,
    });
    expect(equal.status).toBe(201);
    const ratio = await call(platformApp(), 'POST', path, {
      metric_name: 'delivery_bytes',
      warning_ratio: 1.5,
    });
    expect(ratio.body.details.fields.map((f: { path: string }) => f.path)).toEqual([
      'warning_ratio',
    ]);
    const nullVersion = await call(platformApp(), 'POST', path, {
      metric_name: 'delivery_bytes',
      expected_version: null,
    });
    expect(nullVersion.body.details.fields.map((f: { path: string }) => f.path)).toEqual([
      'expected_version',
    ]);
  });

  it('accepts a ratio of exactly 1 and string numbers', async () => {
    const res = await call(platformApp(), 'POST', path, {
      metric_name: 'dlq_items',
      warning_ratio: '1',
      soft_limit: '5',
      hard_limit: '',
    });
    expect(res.status).toBe(201);
    const params = mockAdapter.execute.mock.calls[0][1] as unknown[];
    expect(params.slice(8, 11)).toEqual([5, null, 1]);
  });

  it('keeps the platform scope behind platform authority and per-scope permissions', async () => {
    const notGlobal = await call(
      createApp([PLATFORM_UPDATE], ['ar_super_admin'], false),
      'POST',
      path,
      { scope_type: 'platform', metric_name: 'delivery_bytes' }
    );
    expect(notGlobal.status).toBe(403);
    expect(notGlobal.body.details.permission.reason).toBe('platform_authority_required');

    const onlyTenantPerm = await call(createPlatformApp([TENANT_UPDATE]), 'POST', path, {
      scope_type: 'platform',
      metric_name: 'delivery_bytes',
    });
    expect(onlyTenantPerm.status).toBe(403);
    expect(onlyTenantPerm.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

    const onlyPlatformPerm = await call(createPlatformApp([PLATFORM_UPDATE]), 'POST', path, {
      scope_type: 'tenant',
      scope_id: 'tenant-a',
      metric_name: 'delivery_bytes',
    });
    expect(onlyPlatformPerm.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('refuses to create a quota in another tenant for a tenant admin', async () => {
    const res = await call(createApp([TENANT_UPDATE]), 'POST', path, {
      scope_id: 'tenant-b',
      metric_name: 'delivery_bytes',
    });
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('inserts a tenant policy with defaults and audits it as info', async () => {
    const res = await call(createApp([TENANT_UPDATE]), 'POST', path, {
      metric_name: 'delivery_records',
      log_type: 'normal',
      plane: 'primary',
      lane: 'bulk',
      status: 'disabled',
    });
    expect(res.status).toBe(201);
    expect(res.body.item).toEqual({
      id: expect.stringMatching(/^lqp_/),
      version: 1,
      created_at: NOW,
    });
    expect(res.body.audit_id).toBe('audit-id-1');
    const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO logging_quota_policies');
    expect(params).toEqual([
      res.body.item.id,
      'tenant',
      'tenant-a',
      'normal',
      'primary',
      'bulk',
      'delivery_records',
      'day',
      null,
      null,
      0.8,
      'warn_only',
      'disabled',
      'admin-1',
      'admin-1',
      NOW,
      NOW,
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.quota_policy.create',
        resourceType: 'logging_quota_policy',
        resourceId: res.body.item.id,
        result: 'success',
        severity: 'info',
      })
    );
  });

  it('audits hard_non_critical enforcement as a warning and defaults the platform scope id', async () => {
    const res = await call(platformApp(), 'POST', path, {
      scope_type: 'platform',
      metric_name: 'delivery_bytes',
      window_kind: 'hour',
      enforcement_mode: 'hard_non_critical',
      hard_limit: 2000,
      soft_limit: 1000,
      warning_ratio: 0.5,
    });
    expect(res.status).toBe(201);
    const params = mockAdapter.execute.mock.calls[0][1] as unknown[];
    expect(params.slice(1, 3)).toEqual(['platform', 'global']);
    expect(params.slice(7, 13)).toEqual(['hour', 1000, 2000, 0.5, 'hard_non_critical', 'active']);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
  });

  it('answers 500 when the insert fails', async () => {
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    const res = await call(platformApp(), 'POST', path, {
      metric_name: 'delivery_bytes',
      scope_type: 'platform',
    });
    expect(res.status).toBe(500);
  });
});
