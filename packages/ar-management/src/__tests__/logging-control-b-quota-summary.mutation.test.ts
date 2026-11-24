/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- admin API response bodies are untyped JSON in these route tests */
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

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { auditWrite, mockAdapter, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';
import { must } from './helpers/must';

const READ = [ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ];
const PLATFORM_UPDATE = ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
const TENANT_UPDATE = ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE;
const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
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

describe('quota-policies/:id (PATCH)', () => {
  withFixedNow();
  const path = `${POLICIES}/quota-policies/lqp_1`;
  const body = { scope_type: 'tenant', scope_id: 'tenant-a', metric_name: 'delivery_bytes' };

  it('requires an update permission and a valid body', async () => {
    expect((await call(createApp(READ), 'PATCH', path, body)).status).toBe(403);
    const invalid = await call(createApp([TENANT_UPDATE]), 'PATCH', path, {
      metric_name: 'delivery_bytes',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.details.fields).toEqual([
      {
        path: 'scope_type',
        code: 'invalid_value',
        message: 'Scope type must be platform or tenant.',
      },
    ]);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown policy', async () => {
    const res = await call(createApp([TENANT_UPDATE]), 'PATCH', path, body);
    expect(res.status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['lqp_1']);
  });

  it('checks the permission matching the stored policy scope', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'lqp_1',
      scope_type: 'platform',
      scope_id: 'global',
      version: 2,
    });
    const platformStored = await call(createApp([TENANT_UPDATE]), 'PATCH', path, body);
    expect(platformStored.status).toBe(403);
    mockAdapter.queryOne.mockResolvedValue({
      id: 'lqp_1',
      scope_type: 'tenant',
      scope_id: 'tenant-a',
      version: 2,
    });
    const tenantStored = await call(createPlatformApp([PLATFORM_UPDATE]), 'PATCH', path, body);
    expect(tenantStored.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('answers 409 with both versions when expected_version is stale', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'lqp_1',
      scope_type: 'tenant',
      scope_id: 'tenant-a',
      version: '4',
    });
    const res = await call(createApp([TENANT_UPDATE]), 'PATCH', path, {
      ...body,
      expected_version: 3,
    });
    expect(res.status).toBe(409);
    expect(res.body.details.conflict).toEqual({ expected_version: 3, actual_version: 4 });
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    const match = await call(createApp([TENANT_UPDATE]), 'PATCH', path, {
      ...body,
      expected_version: 4,
    });
    expect(match.status).toBe(200);
  });

  it('updates the policy, bumps the version and audits by enforcement mode', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'lqp_1',
      scope_type: 'tenant',
      scope_id: 'tenant-a',
      version: 4,
    });
    const res = await call(createApp([TENANT_UPDATE]), 'PATCH', path, {
      ...body,
      soft_limit: 10,
      hard_limit: 20,
      warning_ratio: 0.6,
      enforcement_mode: 'hard_non_critical',
      status: 'disabled',
      window_kind: 'hour',
      log_type: 'security',
      plane: 'archive',
      lane: 'critical',
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({ id: 'lqp_1', version: 5, updated_at: NOW });
    expect(res.body.audit_id).toBe('audit-id-1');
    const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE logging_quota_policies');
    expect(params).toEqual([
      'tenant',
      'tenant-a',
      'security',
      'archive',
      'critical',
      'delivery_bytes',
      'hour',
      10,
      20,
      0.6,
      'hard_non_critical',
      'disabled',
      'admin-1',
      NOW,
      'lqp_1',
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.quota_policy.update',
        resourceId: 'lqp_1',
        severity: 'warn',
      })
    );
    mockAdapter.execute.mockClear();
    auditWrite.mockClear();
    await call(createApp([TENANT_UPDATE]), 'PATCH', path, body);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info' })
    );
  });

  it('answers 500 when the update fails', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'lqp_1',
      scope_type: 'tenant',
      scope_id: 'tenant-a',
      version: 1,
    });
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect((await call(createApp([TENANT_UPDATE]), 'PATCH', path, body)).status).toBe(500);
  });
});

describe('quota-evaluations and usage-summary (GET)', () => {
  withFixedNow();

  it('lists evaluations with tenant and state filters', async () => {
    const path = `${POLICIES}/quota-evaluations`;
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    const mismatch = await call(createApp(READ), 'GET', `${path}?tenant_id=tenant-b`);
    expect(mismatch.status).toBe(403);

    mockAdapter.query.mockResolvedValue([{ id: 'lqe_1' }]);
    const res = await call(createApp(READ), 'GET', `${path}?filter[state]=hard_exceeded&limit=900`);
    expect(res.body).toEqual({ items: [{ id: 'lqe_1' }], total: 1 });
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE tenant_id = ? AND state = ?');
    expect(sql).toContain('ORDER BY evaluated_at DESC');
    expect(params).toEqual(['tenant-a', 'hard_exceeded', 200]);

    mockAdapter.query.mockClear();
    await call(createPlatformApp(READ), 'GET', path);
    const [sql2, params2] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql2).not.toContain('WHERE');
    expect(params2).toEqual([50]);

    mockAdapter.query.mockClear();
    await call(createPlatformApp(READ), 'GET', `${path}?state=warning&filter[tenant_id]=tenant-z`);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual(['tenant-z', 'warning', 50]);

    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createApp(READ), 'GET', path)).status).toBe(500);
  });

  it('summarises delivery, catalog, dlq and sensitive-detail usage', async () => {
    const path = `${POLICIES}/usage-summary`;
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    expect((await call(createApp(READ), 'GET', `${path}?tenant_key=x`)).status).toBe(403);
    expect((await call(createApp(READ), 'GET', `${path}?tenant_id=tenant-b`)).status).toBe(403);

    mockAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes('logging_delivery_event_aggregates')
        ? [{ k: 'delivery' }]
        : sql.includes('log_object_catalog')
          ? [{ k: 'catalog' }]
          : sql.includes('logging_dlq_items')
            ? [{ k: 'dlq' }]
            : [{ k: 'sensitive' }]
    );
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?time_start=10&time_end=20&tenant_id=tenant-z&limit=7`
    );
    const key = await deriveTenantKeyFromTenantId('tenant-z', undefined);
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({
      window_start_at: 10,
      window_end_at: 20,
      tenant_key: key,
      tenant_id: 'tenant-z',
      delivery: [{ k: 'delivery' }],
      catalog: [{ k: 'catalog' }],
      dlq: [{ k: 'dlq' }],
      sensitive_detail: [{ k: 'sensitive' }],
    });
    const byTable = (needle: string) =>
      must(mockAdapter.query.mock.calls.find(([sql]) => String(sql).includes(needle)));
    expect(byTable('FROM logging_delivery_event_aggregates')[0]).toContain(
      'WHERE bucket_start_at >= ? AND bucket_start_at <= ? AND tenant_key = ?'
    );
    expect(byTable('FROM logging_delivery_event_aggregates')[1]).toEqual([10, 20, key, 7]);
    expect(byTable('FROM log_object_catalog')[0]).toContain(
      'WHERE created_at >= ? AND created_at <= ? AND tenant_key = ?'
    );
    expect(byTable('FROM log_object_catalog')[1]).toEqual([10, 20, key, 7]);
    expect(byTable('FROM logging_dlq_items')[0]).toContain(
      'WHERE created_at >= ? AND created_at <= ? AND tenant_key = ?'
    );
    expect(byTable('FROM logging_dlq_items')[1]).toEqual([10, 20, key, 7]);
    expect(byTable('FROM sensitive_detail_chunk_index')[0]).toContain(
      'WHERE created_at >= ? AND created_at <= ? AND tenant_id = ?'
    );
    expect(byTable('FROM sensitive_detail_chunk_index')[1]).toEqual([10, 20, 'tenant-z', 7]);
  });

  it('defaults the usage window to 24 hours, with no tenant filters for platform callers', async () => {
    const res = await call(createPlatformApp(READ), 'GET', `${POLICIES}/usage-summary`);
    expect(res.body.item).toMatchObject({
      window_start_at: NOW - DAY,
      window_end_at: null,
      tenant_key: null,
      tenant_id: null,
    });
    for (const [sql, params] of mockAdapter.query.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).not.toContain('<=');
      expect(sql).not.toContain('tenant_key = ?');
      expect(sql).not.toContain('tenant_id = ?');
      expect(params).toEqual([NOW - DAY, 100]);
    }
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(READ), 'GET', `${POLICIES}/usage-summary`)).status).toBe(
      500
    );
  });
});
