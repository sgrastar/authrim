/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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
import { auditWrite, coreFakes, mockAdapter, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const READ = [ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ];
const PLATFORM_UPDATE = ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
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

describe('quota/evaluate (POST)', () => {
  withFixedNow();
  const path = `${POLICIES}/quota/evaluate`;
  const app = () => createPlatformApp([PLATFORM_UPDATE]);

  function arrange(policies: Array<Record<string, unknown>>, usage: Record<string, number | null>) {
    mockAdapter.query.mockResolvedValue(policies);
    mockAdapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!String(sql).includes('SUM(value)')) return null;
      const metric = String((params as unknown[])[0]);
      return { value: usage[metric] ?? null };
    });
    coreFakes.notificationEnqueue.mockImplementation(async () => ({ id: 'ine_1' }));
  }
  const policy = (overrides: Record<string, unknown>) => ({
    id: 'lqp_1',
    scope_type: 'platform',
    scope_id: 'global',
    log_type: null,
    plane: null,
    lane: null,
    metric_name: 'delivery_bytes',
    window_kind: 'day',
    soft_limit: 100,
    hard_limit: 200,
    warning_ratio: 0.5,
    enforcement_mode: 'warn_only',
    ...overrides,
  });
  const insertParams = (index = 0) =>
    (
      mockAdapter.execute.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO logging_quota_evaluations')
      )[index] as [string, unknown[]]
    )[1];

  it('requires the platform defaults permission and platform authority', async () => {
    expect((await call(createApp(READ), 'POST', path)).status).toBe(403);
    const notGlobal = await call(
      createApp([PLATFORM_UPDATE], ['ar_super_admin'], false),
      'POST',
      path
    );
    expect(notGlobal.status).toBe(403);
    expect(notGlobal.body.details.permission.reason).toBe('platform_authority_required');
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('answers an empty evaluation when there are no active policies', async () => {
    const res = await call(app(), 'POST', path);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ evaluated_count: 0, evaluations: [] });
    expect(mockAdapter.query.mock.calls[0][0]).toContain(
      "WHERE status = 'active' AND deleted_at IS NULL"
    );
    expect(mockAdapter.query.mock.calls[0][0]).toContain('LIMIT 500');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.quota.evaluate',
        resourceType: 'logging_quota_policy',
        resourceId: 'bulk-evaluate',
        result: 'success',
        severity: 'info',
        metadata: { evaluated_count: 0 },
      })
    );
  });

  it('evaluates an ok policy without a notification', async () => {
    arrange([policy({ id: 'lqp_ok' })], { delivery_bytes: 10 });
    const res = await call(app(), 'POST', path);
    expect(res.body.result.evaluations).toEqual([
      {
        id: expect.stringMatching(/^lqe_/),
        quota_policy_id: 'lqp_ok',
        tenant_id: null,
        tenant_key: null,
        log_type: null,
        plane: null,
        lane: null,
        metric_name: 'delivery_bytes',
        window_kind: 'day',
        window_start_at: DAY_START,
        window_end_at: DAY_START + DAY,
        value: 10,
        soft_limit: 100,
        hard_limit: 200,
        state: 'ok',
        enforcement_action: 'none',
        evaluated_at: NOW,
        notification_event_id: null,
      },
    ]);
    expect(coreFakes.notificationEnqueue).not.toHaveBeenCalled();
    const usageCall = mockAdapter.queryOne.mock.calls[0] as [string, unknown[]];
    expect(usageCall[0]).toContain(
      'WHERE metric_name = ? AND window_kind = ? AND window_start_at = ?'
    );
    expect(usageCall[1]).toEqual(['delivery_bytes', 'day', DAY_START]);
    expect(insertParams()).toEqual([
      res.body.result.evaluations[0].id,
      'lqp_ok',
      null,
      null,
      null,
      null,
      null,
      'delivery_bytes',
      'day',
      DAY_START,
      DAY_START + DAY,
      10,
      100,
      200,
      'ok',
      'none',
      NOW,
      null,
      JSON.stringify({ critical_scope: false, enforcement_mode: 'warn_only' }),
    ]);
  });

  it('turns a hard breach of a non-critical scope into a blocking notification', async () => {
    arrange(
      [
        policy({
          id: 'lqp_hard',
          scope_type: 'tenant',
          scope_id: 'tenant-q',
          log_type: 'normal',
          plane: 'primary',
          lane: 'bulk',
          window_kind: 'hour',
          enforcement_mode: 'hard_non_critical',
          warning_ratio: '0.5',
        }),
      ],
      { delivery_bytes: 250 }
    );
    const res = await call(app(), 'POST', path);
    const key = await deriveTenantKeyFromTenantId('tenant-q', undefined);
    const usageCall = mockAdapter.queryOne.mock.calls.find(([sql]) =>
      String(sql).includes('SUM(value)')
    ) as [string, unknown[]];
    expect(usageCall[0]).toContain(
      'metric_name = ? AND window_kind = ? AND window_start_at = ? AND (tenant_id = ? OR tenant_key = ?) AND log_type = ? AND plane = ? AND lane = ?'
    );
    expect(usageCall[1]).toEqual([
      'delivery_bytes',
      'hour',
      HOUR_START,
      'tenant-q',
      key,
      'normal',
      'primary',
      'bulk',
    ]);
    expect(coreFakes.notificationEnqueue).toHaveBeenCalledWith({
      tenantId: 'tenant-q',
      category: 'logging_quota_warning',
      eventType: 'logging.quota.hard_exceeded',
      severity: 'high',
      deduplicationKey: `logging_quota:lqp_hard:hour:${HOUR_START}:hard_exceeded`,
      payload: {
        quota_policy_id: 'lqp_hard',
        scope_type: 'tenant',
        scope_id: 'tenant-q',
        metric_name: 'delivery_bytes',
        window_kind: 'hour',
        window_start_at: HOUR_START,
        value: 250,
        soft_limit: 100,
        hard_limit: 200,
        state: 'hard_exceeded',
        enforcement_action: 'block_non_critical',
      },
      routingPolicy: {
        providers: ['internal_event', 'webhook', 'email'],
        failurePolicy: 'retry_until_dead_letter',
        policyScope: 'deployment',
        allowProviderSuppression: true,
      },
    });
    expect(res.body.result.evaluations[0]).toMatchObject({
      tenant_id: 'tenant-q',
      log_type: 'normal',
      plane: 'primary',
      lane: 'bulk',
      state: 'hard_exceeded',
      enforcement_action: 'block_non_critical',
      notification_event_id: 'ine_1',
      window_end_at: HOUR_START + HOUR,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn', metadata: { evaluated_count: 1 } })
    );
    expect(insertParams()[2]).toBe('tenant-q');
    expect(insertParams()[17]).toBe('ine_1');
  });

  it('maps every state and enforcement mode to the right action and severity', async () => {
    const cases: Array<{
      overrides: Record<string, unknown>;
      value: number;
      state: string;
      action: string;
      severity: string | null;
    }> = [
      {
        overrides: { enforcement_mode: 'soft_limit' },
        value: 150,
        state: 'soft_exceeded',
        action: 'throttle_non_critical',
        severity: 'medium',
      },
      {
        overrides: { enforcement_mode: 'soft_limit' },
        value: 60,
        state: 'warning',
        action: 'notify',
        severity: 'low',
      },
      {
        overrides: { enforcement_mode: 'soft_limit' },
        value: 300,
        state: 'hard_exceeded',
        action: 'throttle_non_critical',
        severity: 'high',
      },
      {
        overrides: { enforcement_mode: 'hard_non_critical' },
        value: 150,
        state: 'soft_exceeded',
        action: 'notify',
        severity: 'medium',
      },
      {
        overrides: { enforcement_mode: 'hard_non_critical', log_type: 'audit' },
        value: 300,
        state: 'hard_exceeded',
        action: 'notify',
        severity: 'high',
      },
      {
        overrides: { enforcement_mode: 'hard_non_critical', lane: 'critical' },
        value: 300,
        state: 'hard_exceeded',
        action: 'notify',
        severity: 'high',
      },
      {
        overrides: { enforcement_mode: 'soft_limit', plane: 'sensitive_detail' },
        value: 150,
        state: 'soft_exceeded',
        action: 'notify',
        severity: 'medium',
      },
      {
        overrides: { enforcement_mode: 'observe' },
        value: 300,
        state: 'hard_exceeded',
        action: 'none',
        severity: 'high',
      },
      {
        overrides: { enforcement_mode: 'disabled' },
        value: 300,
        state: 'hard_exceeded',
        action: 'none',
        severity: 'high',
      },
      {
        overrides: { enforcement_mode: 'nonsense' },
        value: 300,
        state: 'hard_exceeded',
        action: 'notify',
        severity: 'high',
      },
      {
        overrides: { enforcement_mode: 'warn_only' },
        value: 150,
        state: 'soft_exceeded',
        action: 'notify',
        severity: 'medium',
      },
      {
        overrides: { enforcement_mode: 'warn_only' },
        value: 49,
        state: 'ok',
        action: 'none',
        severity: null,
      },
    ];
    for (const entry of cases) {
      resetFakes();
      arrange([policy(entry.overrides)], { delivery_bytes: entry.value });
      const res = await call(app(), 'POST', path);
      const evaluation = res.body.result.evaluations[0];
      expect({ state: evaluation.state, action: evaluation.enforcement_action }).toEqual({
        state: entry.state,
        action: entry.action,
      });
      if (entry.severity) {
        expect(coreFakes.notificationEnqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            severity: entry.severity,
            eventType: `logging.quota.${entry.state}`,
            tenantId: 'global',
          })
        );
      } else {
        expect(coreFakes.notificationEnqueue).not.toHaveBeenCalled();
      }
    }
  });

  it('records critical scope in the metadata and tolerates sparse policy rows', async () => {
    arrange(
      [
        policy({
          id: 'lqp_a',
          lane: 'critical',
          warning_ratio: undefined,
          soft_limit: null,
          hard_limit: null,
          window_kind: 'bogus',
          metric_name: 'dlq_items',
        }),
        policy({ id: 'lqp_b', soft_limit: '40', hard_limit: undefined, warning_ratio: 0.25 }),
      ],
      { dlq_items: 5, delivery_bytes: 10 }
    );
    const res = await call(app(), 'POST', path);
    const [first, second] = res.body.result.evaluations;
    expect(first).toMatchObject({
      window_kind: 'day',
      soft_limit: null,
      hard_limit: null,
      state: 'ok',
      lane: 'critical',
    });
    expect(JSON.parse(insertParams(0)[18] as string)).toEqual({
      critical_scope: true,
      enforcement_mode: 'warn_only',
    });
    // soft 40 * 0.25 = 10 -> 10 >= 10 is a warning
    expect(second).toMatchObject({
      soft_limit: 40,
      hard_limit: null,
      state: 'warning',
      enforcement_action: 'notify',
    });
    expect(JSON.parse(insertParams(1)[18] as string)).toEqual({
      critical_scope: false,
      enforcement_mode: 'warn_only',
    });
    expect(res.body.result.evaluated_count).toBe(2);
  });

  it('answers 500 when evaluation fails', async () => {
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(app(), 'POST', path)).status).toBe(500);
  });
});
