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

// 2026-05-21T13:45:30Z
const NOW = Date.UTC(2026, 4, 21, 13, 45, 30);
const HOUR_START = Date.UTC(2026, 4, 21, 13);
const DAY_START = Date.UTC(2026, 4, 21);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('scheduled usage aggregation and quota evaluation', () => {
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

  const executed = (fragment: string) =>
    mockAdapter.execute.mock.calls
      .filter(([sql]) => String(sql).includes(fragment))
      .map(([, params]) => params as unknown[]);

  describe('aggregates', () => {
    it('writes one aggregate per metric for every source and window', async () => {
      rowsBySource.delivery = [
        {
          tenant_key: 't_a',
          log_type: 'diagnostic',
          plane: 'external_sink',
          lane: 'bulk',
          record_count: '12',
          byte_count: 240,
          batch_count: 3,
        },
      ];
      rowsBySource.catalog = [
        {
          tenant_key: 't_a',
          log_type: 'audit',
          plane: 'archive',
          object_count: 4,
          byte_count: 800,
        },
      ];
      rowsBySource.dlq = [{ tenant_key: 't_a', lane: 'critical', item_count: 2 }];
      rowsBySource.sensitive = [
        { tenant_id: 'tenant-1', object_class: 'admin_audit_detail', byte_count: 77 },
      ];
      rowsBySource.messageJobs = [
        { tenant_key: 't_a', lane: 'bulk', kind: 'export_build', job_count: 5 },
      ];

      const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
      expect(result.usage).toMatchObject({ windowsRefreshed: 2, aggregatesRefreshed: 16 });

      const inserts = executed('INSERT INTO logging_usage_aggregates');
      expect(inserts).toHaveLength(16);
      const byId = new Map(inserts.map((p) => [p[0] as string, p]));

      const rec = byId.get(
        `uga:hour:${HOUR_START}:delivery_records:all:t_a:diagnostic:external_sink:bulk`
      );
      expect(rec).toEqual([
        `uga:hour:${HOUR_START}:delivery_records:all:t_a:diagnostic:external_sink:bulk`,
        null,
        't_a',
        'diagnostic',
        'external_sink',
        'bulk',
        'delivery_records',
        'hour',
        HOUR_START,
        HOUR_START + HOUR,
        12,
        'logging_delivery_event_aggregates',
        '{}',
        NOW,
        NOW,
        NOW,
      ]);
      expect(
        byId
          .get(`uga:day:${DAY_START}:delivery_bytes:all:t_a:diagnostic:external_sink:bulk`)
          ?.slice(9, 12)
      ).toEqual([DAY_START + DAY, 240, 'logging_delivery_event_aggregates']);
      expect(
        byId.get(
          `uga:hour:${HOUR_START}:delivery_batches:all:t_a:diagnostic:external_sink:bulk`
        )?.[10]
      ).toBe(3);

      expect(byId.get(`uga:hour:${HOUR_START}:catalog_objects:all:t_a:audit:archive:all`)).toEqual([
        `uga:hour:${HOUR_START}:catalog_objects:all:t_a:audit:archive:all`,
        null,
        't_a',
        'audit',
        'archive',
        null,
        'catalog_objects',
        'hour',
        HOUR_START,
        HOUR_START + HOUR,
        4,
        'log_object_catalog',
        '{}',
        NOW,
        NOW,
        NOW,
      ]);
      expect(byId.get(`uga:hour:${HOUR_START}:catalog_bytes:all:t_a:audit:archive:all`)?.[10]).toBe(
        800
      );

      expect(byId.get(`uga:hour:${HOUR_START}:dlq_items:all:t_a:all:all:critical`)).toEqual([
        `uga:hour:${HOUR_START}:dlq_items:all:t_a:all:all:critical`,
        null,
        't_a',
        null,
        null,
        'critical',
        'dlq_items',
        'hour',
        HOUR_START,
        HOUR_START + HOUR,
        2,
        'logging_dlq_items',
        '{}',
        NOW,
        NOW,
        NOW,
      ]);

      expect(
        byId.get(
          `uga:day:${DAY_START}:sensitive_detail_bytes:tenant-1:all:all:sensitive_detail:all`
        )
      ).toEqual([
        `uga:day:${DAY_START}:sensitive_detail_bytes:tenant-1:all:all:sensitive_detail:all`,
        'tenant-1',
        null,
        null,
        'sensitive_detail',
        null,
        'sensitive_detail_bytes',
        'day',
        DAY_START,
        DAY_START + DAY,
        77,
        'sensitive_detail_chunk_index',
        JSON.stringify({ object_class: 'admin_audit_detail' }),
        NOW,
        NOW,
        NOW,
      ]);

      expect(byId.get(`uga:hour:${HOUR_START}:message_jobs:all:t_a:all:all:bulk`)).toEqual([
        `uga:hour:${HOUR_START}:message_jobs:all:t_a:all:all:bulk`,
        null,
        't_a',
        null,
        null,
        'bulk',
        'message_jobs',
        'hour',
        HOUR_START,
        HOUR_START + HOUR,
        5,
        'logging_message_jobs',
        JSON.stringify({ kind: 'export_build' }),
        NOW,
        NOW,
        NOW,
      ]);
    });

    it('queries each source with the window bounds', async () => {
      await processLoggingStorageMaintenanceJobs({} as Env, log);
      for (const fragment of [
        'FROM logging_delivery_event_aggregates',
        'FROM log_object_catalog',
        'FROM sensitive_detail_chunk_index',
      ]) {
        const calls = mockAdapter.query.mock.calls.filter(
          ([sql]) => String(sql).includes(fragment) && String(sql).includes('GROUP BY')
        );
        expect(calls.map(([, params]) => params)).toEqual([
          [HOUR_START, HOUR_START + HOUR],
          [DAY_START, DAY_START + DAY],
        ]);
      }
    });

    it('updates an aggregate that already exists instead of inserting it', async () => {
      rowsBySource.dlq = [{ tenant_key: 't_a', lane: 'bulk', item_count: '9' }];
      const id = `uga:hour:${HOUR_START}:dlq_items:all:t_a:all:all:bulk`;
      existingAggregateIds.add(id);
      await processLoggingStorageMaintenanceJobs({} as Env, log);
      expect(executed('UPDATE logging_usage_aggregates')).toEqual([
        [9, 'logging_dlq_items', '{}', NOW, NOW, id],
      ]);
      const inserted = executed('INSERT INTO logging_usage_aggregates').map((p) => p[0]);
      expect(inserted).toEqual([`uga:day:${DAY_START}:dlq_items:all:t_a:all:all:bulk`]);
    });

    it('treats unreadable counts as zero and non-string lane/tenant of message jobs as absent', async () => {
      rowsBySource.delivery = [
        {
          tenant_key: 't_a',
          log_type: 'l',
          plane: 'p',
          lane: 'x',
          record_count: {},
          byte_count: null,
          batch_count: 'abc',
        },
      ];
      rowsBySource.messageJobs = [{ tenant_key: null, lane: 7, kind: 'k', job_count: 1 }];
      await processLoggingStorageMaintenanceJobs({} as Env, log);
      const inserts = executed('INSERT INTO logging_usage_aggregates').filter((p) =>
        String(p[0]).startsWith('uga:hour')
      );
      const delivery = inserts.filter((p) => p[11] === 'logging_delivery_event_aggregates');
      expect(delivery.map((p) => p[10])).toEqual([0, 0, 0]);
      const jobs = inserts.find((p) => p[11] === 'logging_message_jobs');
      expect(jobs?.[2]).toBeNull();
      expect(jobs?.[5]).toBeNull();
      expect(jobs?.[0]).toBe(`uga:hour:${HOUR_START}:message_jobs:all:all:all:all:all`);
    });

    it('shortens and sanitizes identifier segments', async () => {
      rowsBySource.dlq = [{ tenant_key: 'a b/c', lane: 'x'.repeat(200), item_count: 1 }];
      await processLoggingStorageMaintenanceJobs({} as Env, log);
      const id = executed('INSERT INTO logging_usage_aggregates')[0][0] as string;
      expect(id).toBe(`uga:hour:${HOUR_START}:dlq_items:all:a_b_c:all:all:${'x'.repeat(96)}`);
    });
  });
});
