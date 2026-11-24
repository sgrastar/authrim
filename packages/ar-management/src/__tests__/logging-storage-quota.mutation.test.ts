/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- SQL parameter arrays and vi fakes are untyped in these maintenance job tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mockAdapter = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
  };
  adapter.transaction.mockImplementation(async (callback) => callback(adapter));
  return adapter;
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter) };
});

import { processLoggingStorageMaintenanceJobs } from '../logging-storage-maintenance-jobs';
import { createNotificationEventsFake } from './helpers/notification-events-fake';
import { must } from './helpers/must';

// 2026-05-21T13:45:30Z
const NOW = Date.UTC(2026, 4, 21, 13, 45, 30);
const HOUR_START = Date.UTC(2026, 4, 21, 13);
const DAY_START = Date.UTC(2026, 4, 21);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('scheduled quota policy evaluation', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  let existingAggregateIds: Set<string>;
  let rowsBySource: Record<string, Record<string, unknown>[]>;
  let policies: Record<string, unknown>[];
  let usageValue: unknown;
  const notificationEvents = createNotificationEventsFake();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    existingAggregateIds = new Set();
    rowsBySource = {};
    policies = [];
    usageValue = null;
    notificationEvents.reset();
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_quota_policies')) return policies;
      if (
        sql.includes('FROM logging_delivery_event_aggregates') &&
        sql.includes('SUM(record_count)')
      )
        return rowsBySource.delivery ?? [];
      if (sql.includes('FROM log_object_catalog') && sql.includes('COUNT(*) AS object_count'))
        return rowsBySource.catalog ?? [];
      if (sql.includes('FROM logging_dlq_items') && sql.includes('COUNT(*) AS item_count'))
        return rowsBySource.dlq ?? [];
      if (sql.includes('FROM sensitive_detail_chunk_index')) return rowsBySource.sensitive ?? [];
      if (sql.includes('FROM logging_message_jobs') && sql.includes('COUNT(*) AS job_count'))
        return rowsBySource.messageJobs ?? [];
      return [];
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM logging_usage_aggregates')) {
        return existingAggregateIds.has(String(params?.[0])) ? { id: params?.[0] } : null;
      }
      if (sql.includes('SELECT tenant_key FROM tenants')) return { tenant_key: 't_resolved' };
      if (sql.includes('SELECT SUM(value) AS value')) return { value: usageValue };
      const notification = notificationEvents.queryOne(sql, params);
      if (notification !== undefined) return notification;
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params?: unknown[]) =>
      notificationEvents.executeAny(sql, params)
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const resetExecute = () => {
    vi.clearAllMocks();
    notificationEvents.reset();
    mockAdapter.execute.mockImplementation(async (sql: string, params?: unknown[]) =>
      notificationEvents.executeAny(sql, params)
    );
  };

  const executed = (fragment: string) =>
    mockAdapter.execute.mock.calls
      .filter(([sql]) => String(sql).includes(fragment))
      .map(([, params]) => params as unknown[]);

  describe('quota policies', () => {
    const policy = (over: Record<string, unknown> = {}) => ({
      id: 'lqp_1',
      scope_type: 'tenant',
      scope_id: 'tenant-1',
      log_type: null,
      plane: null,
      lane: null,
      metric_name: 'delivery_records',
      window_kind: 'hour',
      soft_limit: null,
      hard_limit: null,
      warning_ratio: null,
      enforcement_mode: 'observe',
      ...over,
    });

    async function evaluate(p: Record<string, unknown>, value: unknown) {
      policies = [p];
      usageValue = value;
      const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
      const evaluation = executed('INSERT INTO logging_quota_evaluations')[0];
      return { result, evaluation };
    }

    it('queries only active policies in a stable order, capped at 500', async () => {
      await processLoggingStorageMaintenanceJobs({} as Env, log);
      const sql = String(
        must(
          mockAdapter.query.mock.calls.find(([s]) =>
            String(s).includes('FROM logging_quota_policies')
          )
        )[0]
      );
      expect(sql).toContain("status = 'active' AND deleted_at IS NULL");
      expect(sql).toContain('ORDER BY scope_type ASC, scope_id ASC, metric_name ASC');
      expect(sql).toContain('LIMIT 500');
    });

    it('sums usage for the policy scope and every filter, resolving the tenant key', async () => {
      await evaluate(
        policy({ log_type: 'audit', plane: 'archive', lane: 'critical', window_kind: 'day' }),
        1
      );
      const call = must(
        mockAdapter.queryOne.mock.calls.find(([s]) =>
          String(s).includes('SELECT SUM(value) AS value')
        )
      );
      expect(String(call[0])).toContain(
        'metric_name = ? AND window_kind = ? AND window_start_at = ? AND (tenant_id = ? OR tenant_key = ?) AND log_type = ? AND plane = ? AND lane = ?'
      );
      expect(call[1]).toEqual([
        'delivery_records',
        'day',
        DAY_START,
        'tenant-1',
        't_resolved',
        'audit',
        'archive',
        'critical',
      ]);
    });

    it('does not scope a platform policy to a tenant and defaults to daily windows', async () => {
      const { evaluation } = await evaluate(
        policy({ scope_type: 'platform', scope_id: 'global', window_kind: null }),
        1
      );
      const call = must(
        mockAdapter.queryOne.mock.calls.find(([s]) =>
          String(s).includes('SELECT SUM(value) AS value')
        )
      );
      expect(call[1]).toEqual(['delivery_records', 'day', DAY_START]);
      expect(String(call[0])).not.toContain('tenant_id = ?');
      // tenant_id and tenant_key stay empty, the window is the daily one.
      expect(evaluation[2]).toBeNull();
      expect(evaluation[3]).toBeNull();
      expect(evaluation[8]).toBe('day');
      expect(evaluation[9]).toBe(DAY_START);
      expect(evaluation[10]).toBe(DAY_START + DAY);
    });

    it('records an ok evaluation without a notification', async () => {
      const { result, evaluation } = await evaluate(
        policy({ soft_limit: 100, hard_limit: 200 }),
        '10'
      );
      expect(result.usage).toMatchObject({
        quotaPoliciesEvaluated: 1,
        quotaWarnings: 0,
        quotaActions: 0,
      });
      expect(evaluation.slice(1, 3)).toEqual(['lqp_1', 'tenant-1']);
      expect(evaluation.slice(11, 17)).toEqual([10, 100, 200, 'ok', 'none', NOW]);
      expect(evaluation[17]).toBeNull();
      expect(JSON.parse(evaluation[18] as string)).toEqual({
        critical_scope: false,
        enforcement_mode: 'observe',
      });
      expect(executed('INSERT INTO internal_notification_events')).toHaveLength(0);
    });

    it.each([
      // [name, soft, hard, ratio, value, mode, scope, state, action, severity]
      [
        'hard limit reached',
        50,
        100,
        null,
        100,
        'hard_non_critical',
        {},
        'hard_exceeded',
        'block_non_critical',
        'high',
      ],
      [
        'hard limit on a critical lane',
        50,
        100,
        null,
        150,
        'hard_non_critical',
        { lane: 'critical' },
        'hard_exceeded',
        'notify',
        'high',
      ],
      [
        'hard limit on sensitive detail',
        null,
        100,
        null,
        100,
        'hard_non_critical',
        { plane: 'sensitive_detail' },
        'hard_exceeded',
        'notify',
        'high',
      ],
      [
        'hard limit on audit logs',
        null,
        100,
        null,
        100,
        'hard_non_critical',
        { log_type: 'audit' },
        'hard_exceeded',
        'notify',
        'high',
      ],
      [
        'hard limit on admin_audit logs',
        null,
        100,
        null,
        100,
        'hard_non_critical',
        { log_type: 'admin_audit' },
        'hard_exceeded',
        'notify',
        'high',
      ],
      [
        'hard limit on security logs',
        null,
        100,
        null,
        100,
        'hard_non_critical',
        { log_type: 'security' },
        'hard_exceeded',
        'notify',
        'high',
      ],
      [
        'hard limit while observing',
        null,
        100,
        null,
        100,
        'observe',
        {},
        'hard_exceeded',
        'none',
        'high',
      ],
      [
        'hard limit while disabled',
        null,
        100,
        null,
        100,
        'disabled',
        {},
        'hard_exceeded',
        'none',
        'high',
      ],
      [
        'hard limit in soft mode',
        null,
        100,
        null,
        100,
        'soft_limit',
        {},
        'hard_exceeded',
        'throttle_non_critical',
        'high',
      ],
      [
        'soft limit reached',
        50,
        100,
        null,
        50,
        'soft_limit',
        {},
        'soft_exceeded',
        'throttle_non_critical',
        'medium',
      ],
      [
        'soft limit on critical scope',
        50,
        100,
        null,
        50,
        'soft_limit',
        { lane: 'critical' },
        'soft_exceeded',
        'notify',
        'medium',
      ],
      [
        'soft limit in hard mode',
        50,
        100,
        null,
        50,
        'hard_non_critical',
        {},
        'soft_exceeded',
        'notify',
        'medium',
      ],
      ['warning in soft mode', 100, 200, null, 80, 'soft_limit', {}, 'warning', 'notify', 'low'],
      ['warning at a custom ratio', 100, null, 0.5, 50, 'observe', {}, 'warning', 'none', 'low'],
      [
        'warning against the hard limit only',
        null,
        100,
        null,
        80,
        'hard_non_critical',
        {},
        'warning',
        'notify',
        'low',
      ],
    ])('%s', async (_name, soft, hard, ratio, value, mode, scope, state, action, severity) => {
      const { result, evaluation } = await evaluate(
        policy({
          soft_limit: soft,
          hard_limit: hard,
          warning_ratio: ratio,
          enforcement_mode: mode,
          ...(scope as Record<string, unknown>),
        }),
        value
      );
      expect(evaluation.slice(11, 17)).toEqual([value, soft, hard, state, action, NOW]);
      expect(evaluation[17]).toBe(notificationEvents.rows[0].id);
      const notifications = executed('INSERT INTO internal_notification_events');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain(`logging.quota.${state}`);
      expect(notifications[0]).toContain(severity);
      expect(notifications[0]).toContain('logging_quota_warning');
      expect(notifications[0]).toContain(`logging_quota:lqp_1:hour:${HOUR_START}:${state}`);
      const payloadParam = notifications[0].find(
        (param) => typeof param === 'string' && param.includes('"quota_policy_id"')
      ) as string;
      expect(JSON.parse(payloadParam)).toMatchObject({
        quota_policy_id: 'lqp_1',
        scope_type: 'tenant',
        scope_id: 'tenant-1',
        tenant_key: 't_resolved',
        metric_name: 'delivery_records',
        window_kind: 'hour',
        window_start_at: HOUR_START,
        value,
        soft_limit: soft,
        hard_limit: hard,
        state,
        enforcement_action: action,
      });
      expect(result.usage.quotaWarnings).toBe(1);
      expect(result.usage.quotaActions).toBe(action === 'none' || action === 'notify' ? 0 : 1);
    });

    it('stays ok just below the warning threshold and below every limit', async () => {
      const { evaluation } = await evaluate(
        policy({ soft_limit: 100, hard_limit: 200, enforcement_mode: 'soft_limit' }),
        79
      );
      expect(evaluation.slice(14, 16)).toEqual(['ok', 'none']);
    });

    it('falls back to the default warning ratio for unusable values', async () => {
      for (const ratio of [0, -1, 2, 'abc', Number.NaN]) {
        resetExecute();
        const { evaluation } = await evaluate(
          policy({ soft_limit: 100, warning_ratio: ratio, enforcement_mode: 'observe' }),
          80
        );
        expect(evaluation[14]).toBe('warning');
        resetExecute();
        const below = await evaluate(
          policy({ soft_limit: 100, warning_ratio: ratio, enforcement_mode: 'observe' }),
          79
        );
        expect(below.evaluation[14]).toBe('ok');
      }
    });

    it('accepts a numeric-string ratio and string limits, and treats blank limits as absent', async () => {
      const { evaluation } = await evaluate(
        policy({ soft_limit: '100', hard_limit: '', warning_ratio: '0.5' }),
        50
      );
      expect(evaluation.slice(12, 15)).toEqual([100, null, 'warning']);
      resetExecute();
      const both = await evaluate(policy({ soft_limit: 'x', hard_limit: 'y' }), 5);
      expect(both.evaluation.slice(12, 15)).toEqual([null, null, 'ok']);
    });

    it('counts missing usage as zero', async () => {
      const { evaluation } = await evaluate(policy({ soft_limit: 10 }), null);
      expect(evaluation[11]).toBe(0);
      expect(evaluation[14]).toBe('ok');
    });

    it('routes quota notifications through every channel with retry-until-dead-letter', async () => {
      await evaluate(policy({ soft_limit: 10, hard_limit: 20 }), 15);
      const call = executed('INSERT INTO internal_notification_events')[0];
      const serialized = JSON.stringify(call);
      for (const provider of ['internal_event', 'webhook', 'email']) {
        expect(serialized).toContain(provider);
      }
      expect(serialized).toContain('retry_until_dead_letter');
      expect(serialized).toContain('deployment');
    });

    it('notifies globally for non-tenant scopes', async () => {
      await evaluate(policy({ scope_type: 'platform', scope_id: 'global', soft_limit: 10 }), 15);
      expect(executed('INSERT INTO internal_notification_events')[0]).toContain('global');
    });
  });
});
