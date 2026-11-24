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
import { must } from './helpers/must';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface DestinationOverrides {
  id?: string;
  scope_id?: string;
  provider?: string;
  destination_kind?: string;
  lifecycle_status?: string;
  health_status?: string;
  provider_config?: unknown;
  last_health_check_at?: number | string | null;
  name?: string;
}

function destination(overrides: DestinationOverrides = {}) {
  const { provider_config, ...rest } = overrides;
  return {
    id: 'dest_1',
    scope_type: 'platform',
    scope_id: 'global',
    destination_kind: 'object_storage',
    provider: 'r2',
    name: 'archive',
    lifecycle_status: 'active',
    health_status: 'healthy',
    provider_config: JSON.stringify(provider_config ?? { bindingRef: 'AUDIT_ARCHIVE' }),
    last_health_check_at: null,
    ...rest,
  };
}

describe('scheduled destination health checks', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  function serve(rows: unknown[]) {
    mockAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM admin_destinations') ? rows : []
    );
  }

  /** The health event recorded for the destination: [check_type, prev, next, result, error_class, metadata]. */
  function healthEvent() {
    const call = mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO admin_destination_health_events')
    );
    expect(call).toBeDefined();
    const params = must(call)[1] as unknown[];
    return {
      id: params[0] as string,
      destinationId: params[1],
      checkType: params[2],
      previous: params[3],
      next: params[4],
      result: params[5],
      errorClass: params[6],
      latency: params[7],
      checkedAt: params[8],
      metadata: JSON.parse(params[9] as string) as Record<string, unknown>,
    };
  }

  function notification() {
    const call = mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO internal_notification_events')
    );
    return call ? (call[1] as unknown[]) : null;
  }

  it('selects only stale active destinations, oldest first, bounded to 50', async () => {
    await processLoggingStorageMaintenanceJobs({} as Env, log);
    const call = mockAdapter.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM admin_destinations')
    );
    expect(must(call)[1]).toEqual([NOW - 6 * 60 * 60 * 1000, 50]);
    expect(String(must(call)[0])).toContain("lifecycle_status = 'active'");
    expect(String(must(call)[0])).toContain(
      'ORDER BY COALESCE(last_health_check_at, 0) ASC, id ASC'
    );
  });

  it('marks an inactive destination as failing without probing it', async () => {
    serve([destination({ lifecycle_status: 'paused', health_status: 'healthy' })]);
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(result.healthChecks).toEqual({ checked: 1, failed: 1 });
    expect(healthEvent()).toMatchObject({
      destinationId: 'dest_1',
      checkType: 'quick',
      previous: 'healthy',
      next: 'failing',
      result: 'failure',
      errorClass: 'destination_not_active',
      latency: 0,
      checkedAt: NOW,
      metadata: { provider: 'r2', destination_kind: 'object_storage', scheduled: true },
    });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_destinations'),
      ['failing', NOW, NOW, 'dest_1']
    );
    const params = notification();
    expect(params).toContain('logging.destination.health.failing');
    expect(params).toContain('high');
    expect(params).toContain(
      'logging_destination_health:dest_1:quick:failing:destination_not_active'
    );
  });

  it('treats a never-checked unknown status as the previous status "unknown"', async () => {
    serve([destination({ lifecycle_status: 'paused', health_status: undefined })]);
    await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(healthEvent().previous).toBe('unknown');
  });

  it('reports invalid provider config with the validation errors', async () => {
    serve([destination({ provider_config: {} })]);
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(result.healthChecks).toEqual({ checked: 1, failed: 1 });
    const event = healthEvent();
    expect(event).toMatchObject({
      next: 'failing',
      result: 'failure',
      errorClass: 'provider_config_invalid',
    });
    expect(Array.isArray(event.metadata.validation_errors)).toBe(true);
    expect((event.metadata.validation_errors as unknown[]).length).toBeGreaterThan(0);
  });

  it('treats malformed or non-object provider config as an empty config', async () => {
    serve([
      { ...destination(), provider_config: '{broken' },
      { ...destination({ id: 'dest_2' }), provider_config: '[1,2]' },
    ]);
    await processLoggingStorageMaintenanceJobs({} as Env, log);
    const events = mockAdapter.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO admin_destination_health_events')
    );
    expect(events).toHaveLength(2);
    for (const [, params] of events) {
      expect((params as unknown[])[6]).toBe('provider_config_invalid');
    }
  });

  it('records a healthy R2 destination without a notification and keeps the quick probe cheap', async () => {
    const bucket = { put: vi.fn(), head: vi.fn(), delete: vi.fn() };
    serve([destination({ last_health_check_at: NOW - 7 * 60 * 60 * 1000 })]);
    const result = await processLoggingStorageMaintenanceJobs(
      { AUDIT_ARCHIVE: bucket } as unknown as Env,
      log
    );
    expect(result.healthChecks).toEqual({ checked: 1, failed: 0 });
    expect(healthEvent()).toMatchObject({
      checkType: 'quick',
      previous: 'healthy',
      next: 'healthy',
      result: 'success',
      errorClass: null,
      metadata: { binding_ref: 'AUDIT_ARCHIVE' },
    });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(notification()).toBeNull();
  });

  it('runs a deep probe after 24 hours and cleans the probe object up', async () => {
    const bucket = {
      put: vi.fn(),
      head: vi.fn(async () => ({ key: 'x' })),
      delete: vi.fn(),
    };
    serve([
      destination({
        last_health_check_at: NOW - DAY,
        provider_config: { bindingRef: 'AUDIT_ARCHIVE', prefix: '/custom/prefix/' },
      }),
    ]);
    await processLoggingStorageMaintenanceJobs({ AUDIT_ARCHIVE: bucket } as unknown as Env, log);
    const key = `custom/prefix/health/dest_1-${NOW}.txt`;
    expect(bucket.put).toHaveBeenCalledWith(key, 'authrim destination health check');
    expect(bucket.head).toHaveBeenCalledWith(key);
    expect(bucket.delete).toHaveBeenCalledWith(key);
    expect(healthEvent()).toMatchObject({
      checkType: 'deep',
      next: 'healthy',
      result: 'success',
      metadata: { probe_key: key },
    });
  });

  it('accepts the last-check time as a numeric string and stays quick just under 24 hours', async () => {
    const bucket = { put: vi.fn(), head: vi.fn(), delete: vi.fn() };
    serve([destination({ last_health_check_at: String(NOW - DAY + 1) })]);
    await processLoggingStorageMaintenanceJobs({ AUDIT_ARCHIVE: bucket } as unknown as Env, log);
    expect(healthEvent().checkType).toBe('quick');
    vi.clearAllMocks();
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    serve([destination({ last_health_check_at: String(NOW - DAY) })]);
    mockAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM admin_destinations')
        ? [destination({ last_health_check_at: String(NOW - DAY) })]
        : []
    );
    await processLoggingStorageMaintenanceJobs(
      {
        AUDIT_ARCHIVE: { put: vi.fn(), head: vi.fn(async () => ({})), delete: vi.fn() },
      } as unknown as Env,
      log
    );
    expect(healthEvent().checkType).toBe('deep');
  });

  it.each(['degraded', 'failing', 'unreachable'])(
    'probes a %s destination adaptively regardless of its last check',
    async (status) => {
      const bucket = { put: vi.fn(), head: vi.fn(async () => ({})), delete: vi.fn() };
      serve([destination({ health_status: status, last_health_check_at: NOW - 1000 })]);
      await processLoggingStorageMaintenanceJobs({ AUDIT_ARCHIVE: bucket } as unknown as Env, log);
      expect(healthEvent()).toMatchObject({
        checkType: 'adaptive',
        previous: status,
        next: 'healthy',
      });
      expect(bucket.put).toHaveBeenCalledTimes(1);
    }
  );

  it('degrades when the probe object is missing after the write and still deletes it', async () => {
    const bucket = { put: vi.fn(), head: vi.fn(async () => null), delete: vi.fn() };
    serve([destination({ health_status: 'degraded' })]);
    const result = await processLoggingStorageMaintenanceJobs(
      { AUDIT_ARCHIVE: bucket } as unknown as Env,
      log
    );
    expect(result.healthChecks).toEqual({ checked: 1, failed: 1 });
    expect(healthEvent()).toMatchObject({
      checkType: 'adaptive',
      next: 'degraded',
      result: 'partial',
      errorClass: 'r2_head_missing_after_write',
    });
    expect(bucket.delete).toHaveBeenCalledTimes(1);
    const params = notification();
    expect(params).toContain('logging.destination.health.degraded');
    expect(params).toContain('medium');
    expect(params).not.toContain('high');
  });

  it('uses the default prefix and tolerates a bucket without head/delete', async () => {
    const bucket = { put: vi.fn() };
    serve([
      destination({
        health_status: 'failing',
        provider_config: { bindingRef: 'AUDIT_ARCHIVE', prefix: '///' },
      }),
    ]);
    await processLoggingStorageMaintenanceJobs({ AUDIT_ARCHIVE: bucket } as unknown as Env, log);
    expect(bucket.put).toHaveBeenCalledWith(
      `authrim/health/dest_1-${NOW}.txt`,
      'authrim destination health check'
    );
    // No head() means the object cannot be confirmed.
    expect(healthEvent()).toMatchObject({
      next: 'degraded',
      errorClass: 'r2_head_missing_after_write',
    });
  });

  it('reports an R2 binding that is not bound or not a bucket as unreachable', async () => {
    for (const env of [{}, { AUDIT_ARCHIVE: {} }]) {
      vi.clearAllMocks();
      mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
      serve([destination()]);
      await processLoggingStorageMaintenanceJobs(env as unknown as Env, log);
      expect(healthEvent()).toMatchObject({
        next: 'unreachable',
        result: 'failure',
        errorClass: 'r2_binding_unavailable',
        metadata: { binding_ref: 'AUDIT_ARCHIVE' },
      });
      const params = notification();
      expect(params).toContain('logging.destination.health.unreachable');
      expect(params).toContain('high');
    }
  });

  it('scopes the notification to the destination scope id, falling back to global', async () => {
    serve([destination({ scope_id: 'tenant-a', lifecycle_status: 'paused' })]);
    await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(notification()).toContain('tenant-a');

    vi.clearAllMocks();
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    serve([destination({ scope_id: '', lifecycle_status: 'paused' })]);
    await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(notification()).toContain('global');
  });

  it('keeps going and warns when the notification cannot be enqueued', async () => {
    serve([destination({ lifecycle_status: 'paused' })]);
    mockAdapter.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO internal_notification_events')) {
        throw new Error('notify down');
      }
      return { rowsAffected: 1 };
    });
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(result.healthChecks).toEqual({ checked: 1, failed: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      'Logging destination health notification enqueue failed',
      {
        destinationId: 'dest_1',
        error: 'notify down',
      }
    );
  });

  describe('http sinks', () => {
    const http = (url: unknown) =>
      destination({
        provider: 'http',
        destination_kind: 'webhook',
        provider_config: url === undefined ? {} : { url },
      });

    it('accepts a public https url', async () => {
      serve([http('https://logs.example.com/ingest')]);
      const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
      expect(result.healthChecks).toEqual({ checked: 1, failed: 0 });
      expect(healthEvent()).toMatchObject({
        next: 'healthy',
        result: 'success',
        errorClass: null,
        metadata: { url_configured: true, provider: 'http', destination_kind: 'webhook' },
      });
    });

    it('rejects a plain http url with an https_required error', async () => {
      serve([http('http://logs.example.com/ingest')]);
      const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
      expect(result.healthChecks).toEqual({ checked: 1, failed: 1 });
      expect(healthEvent()).toMatchObject({
        next: 'failing',
        result: 'failure',
        errorClass: 'http_sink_url_invalid',
        metadata: { url_configured: true, error: 'https_required' },
      });
      const params = notification();
      expect(params).toContain('logging.destination.health.failing');
      expect(params).toContain('high');
    });

    it('rejects a private address as an invalid sink url', async () => {
      serve([http('https://127.0.0.1/ingest')]);
      await processLoggingStorageMaintenanceJobs({} as Env, log);
      const event = healthEvent();
      expect(event).toMatchObject({
        next: 'failing',
        result: 'failure',
        errorClass: 'http_sink_url_invalid',
      });
      expect(typeof event.metadata.error).toBe('string');
      expect(event.metadata.error).not.toBe('https_required');
    });

    it('rejects a sink config without a url as invalid provider config', async () => {
      serve([http(undefined)]);
      await processLoggingStorageMaintenanceJobs({} as Env, log);
      expect(healthEvent().errorClass).toBe('provider_config_invalid');
    });
  });

  it('reports providers without a health probe as degraded and unsupported', async () => {
    serve([
      destination({
        provider: 'analytics_engine',
        destination_kind: 'external_collector',
        provider_config: { dataset: 'logs' },
      }),
    ]);
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(healthEvent()).toMatchObject({
      next: 'degraded',
      result: 'partial',
      errorClass: 'provider_health_check_not_supported',
    });
    expect(result.healthChecks).toEqual({ checked: 1, failed: 1 });
    expect(notification()).toContain('medium');
  });

  it('logs and continues when the destination query fails', async () => {
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) throw new Error('db down');
      return [];
    });
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(result.healthChecks).toEqual({ checked: 0, failed: 0 });
    expect(log.error).toHaveBeenCalledWith(
      'Logging destination scheduled health checks failed',
      {},
      expect.any(Error)
    );
  });
});
