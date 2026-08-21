import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import {
  InternalNotificationEventRepository,
  normalizeInternalNotificationRoutingPolicy,
  resolveLoggingNotificationRoutingPolicy,
} from '../admin/internal-notification-event';

function createAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  const transaction: DatabaseAdapter['transaction'] = async <T>(
    fn: (tx: TransactionContext) => Promise<T>
  ): Promise<T> =>
    fn({
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    });
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue({
      id: 'event-1',
      tenant_id: 'tenant-a',
      category: 'storage_registry_security',
      event_type: 'tenant_runtime_registry_snapshot.verification_failed',
      severity: 'critical',
      status: 'pending',
      deduplication_key: 'dedup-key',
      payload_json: '{}',
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: '2026-05-16T00:00:00.000Z',
      updated_at: '2026-05-16T00:00:00.000Z',
      delivered_at: null,
    }),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction,
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
    ...overrides,
  };
}

describe('InternalNotificationEventRepository', () => {
  it('enqueues deduplicated internal notification events', async () => {
    const row = {
      id: 'event-1',
      tenant_id: 'tenant-a',
      category: 'storage_registry_security',
      event_type: 'tenant_runtime_registry_snapshot.verification_failed',
      severity: 'critical',
      status: 'pending',
      deduplication_key: 'dedup-key',
      payload_json: '{}',
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: '2026-05-16T00:00:00.000Z',
      updated_at: '2026-05-16T00:00:00.000Z',
      delivered_at: null,
    };
    const adapter = createAdapter({
      queryOne: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(row),
    });
    const repository = new InternalNotificationEventRepository(adapter);

    const enqueued = await repository.enqueue({
      tenantId: 'tenant-a',
      category: 'storage_registry_security',
      eventType: 'tenant_runtime_registry_snapshot.verification_failed',
      severity: 'critical',
      deduplicationKey: 'dedup-key',
      payload: { tenant_id: 'tenant-a' },
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    expect(enqueued.id).toBe('event-1');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        'tenant-a',
        'storage_registry_security',
        'tenant_runtime_registry_snapshot.verification_failed',
        'critical',
        'dedup-key',
      ])
    );
    expect(adapter.queryOne).toHaveBeenCalledWith(
      'SELECT * FROM internal_notification_events WHERE deduplication_key = ?',
      ['dedup-key']
    );
  });

  it('lists pending and retry-due failed events by severity', async () => {
    const adapter = createAdapter();
    const repository = new InternalNotificationEventRepository(adapter);

    await repository.listPending(25, new Date('2026-05-16T00:00:00.000Z'));

    expect(adapter.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), [
      '2026-05-16T00:00:00.000Z',
      25,
    ]);
  });

  it('suppresses only open condition notifications by deduplication key', async () => {
    const adapter = createAdapter({
      execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 2 }),
    });
    const repository = new InternalNotificationEventRepository(adapter);

    await expect(
      repository.suppressResolvedByDeduplicationKeys(
        ['condition-a', 'condition-a', 'condition-b'],
        new Date('2026-05-16T01:00:00.000Z')
      )
    ).resolves.toBe(2);

    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('pending', 'failed', 'dead_letter')"),
      ['2026-05-16T01:00:00.000Z', 'condition-a', 'condition-b']
    );
  });

  it('reopens a suppressed condition when the same condition recurs', async () => {
    const suppressedRow = {
      id: 'event-1',
      tenant_id: 'tenant-a',
      category: 'storage_registry_health',
      event_type: 'tenant_database.reconciliation.missing_binding',
      severity: 'critical',
      status: 'suppressed',
      deduplication_key: 'condition-a',
      payload_json: '{}',
      attempts: 1,
      last_error: null,
      next_attempt_at: null,
      created_at: '2026-05-16T00:00:00.000Z',
      updated_at: '2026-05-16T00:00:00.000Z',
      delivered_at: null,
    } as const;
    const reopenedRow = { ...suppressedRow, status: 'pending' as const, attempts: 0 };
    const adapter = createAdapter({
      queryOne: vi.fn().mockResolvedValueOnce(suppressedRow).mockResolvedValueOnce(reopenedRow),
    });
    const repository = new InternalNotificationEventRepository(adapter);

    const event = await repository.enqueue({
      tenantId: 'tenant-a',
      category: 'storage_registry_health',
      eventType: 'tenant_database.reconciliation.missing_binding',
      severity: 'critical',
      deduplicationKey: 'condition-a',
      payload: { tenant_id: 'tenant-a', checked_at: '2026-05-16T02:00:00.000Z' },
      reopenSuppressed: true,
      now: new Date('2026-05-16T02:00:00.000Z'),
    });

    expect(event.status).toBe('pending');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'pending'"),
      [
        'critical',
        '{"tenant_id":"tenant-a","checked_at":"2026-05-16T02:00:00.000Z"}',
        '2026-05-16T02:00:00.000Z',
        'event-1',
      ]
    );
  });

  it('stores future notification routing policy metadata in the event payload', async () => {
    const adapter = createAdapter();
    const repository = new InternalNotificationEventRepository(adapter);

    await repository.enqueue({
      tenantId: 'tenant-a',
      category: 'tenant_database_health',
      eventType: 'tenant_database.health.failed',
      severity: 'high',
      payload: { tenant_id: 'tenant-a' },
      routingPolicy: {
        providers: ['internal_event', 'webhook', 'email'],
        failurePolicy: 'retry_until_dead_letter',
        policyScope: 'tenant',
        allowProviderSuppression: true,
      },
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    const insertParams = (adapter.execute as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as unknown[];
    expect(JSON.parse(insertParams[6] as string)).toEqual({
      tenant_id: 'tenant-a',
      notification_routing_policy: {
        providers: ['internal_event', 'webhook', 'email'],
        failurePolicy: 'retry_until_dead_letter',
        policyScope: 'tenant',
        allowProviderSuppression: true,
      },
    });
  });

  it('defaults notification routing to fail-open internal events', () => {
    expect(normalizeInternalNotificationRoutingPolicy(null)).toEqual({
      providers: ['internal_event'],
      failurePolicy: 'best_effort',
      policyScope: 'deployment',
      allowProviderSuppression: false,
    });
  });

  it('routes critical logging notifications to internal and external providers', () => {
    expect(
      resolveLoggingNotificationRoutingPolicy({
        severity: 'critical',
        externalNotificationEligible: true,
      })
    ).toEqual({
      providers: ['internal_event', 'webhook', 'email'],
      failurePolicy: 'retry_until_dead_letter',
      policyScope: 'deployment',
      allowProviderSuppression: true,
    });
    expect(
      resolveLoggingNotificationRoutingPolicy({
        severity: 'critical',
      })
    ).toEqual({
      providers: ['internal_event'],
      failurePolicy: 'best_effort',
      policyScope: 'deployment',
      allowProviderSuppression: false,
    });
  });

  it('marks delivered and moves exhausted failures to dead letter', async () => {
    const adapter = createAdapter({
      queryOne: vi.fn().mockResolvedValue({ attempts: 2 }),
    });
    const repository = new InternalNotificationEventRepository(adapter);

    await repository.markDelivered('event-1', new Date('2026-05-16T00:00:00.000Z'));
    const status = await repository.markDeliveryFailure('event-1', 'webhook_unavailable', {
      maxAttempts: 3,
      retryAfterSeconds: 60,
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    expect(status).toBe('dead_letter');
    expect(adapter.execute).toHaveBeenCalledWith(expect.stringContaining("status = 'delivered'"), [
      '2026-05-16T00:00:00.000Z',
      '2026-05-16T00:00:00.000Z',
      'event-1',
    ]);
    expect(adapter.execute).toHaveBeenCalledWith(expect.stringContaining('SET status = ?'), [
      'dead_letter',
      3,
      'webhook_unavailable',
      null,
      '2026-05-16T00:00:00.000Z',
      'event-1',
    ]);
  });
});
