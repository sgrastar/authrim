import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types/env';
import type { AuditProfile } from '../../../types/runtime-profile';
import { AuditService, SYSTEM_EVENTS_DATASET, type SystemEventLogParams } from '../audit-service';
import { emitLogIcebergRow } from '../../log-iceberg-emitter';

vi.mock('../anonymization', () => ({ AnonymizationService: class {} }));
vi.mock('../../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn() }));
vi.mock('../../log-iceberg-subject-erasure', () => ({ eraseLogIcebergSubject: vi.fn() }));

const baseProfile = {
  kind: 'audit',
  id: 'profile',
  primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
  archive: { type: 'r2', bucketBinding: 'AUDIT_ARCHIVE', prefix: 'old' },
  sinks: [],
} as AuditProfile;
const AT = 1_800_000_000_000;
const event: SystemEventLogParams = {
  id: 'sys-1',
  createdAt: AT,
  source: 'authrim/account_webhook_outbox',
  eventType: 'webhook.outbox.dropped',
  eventCategory: 'audit',
  result: 'success',
  severity: 'warn',
  targetType: 'account_webhook_outbox',
  targetId: 'tenant-1',
  requestId: 'req-1',
  details: { dropped: 3, event_types: { 'account.created': 3 }, reason: 'capability_disabled' },
};

function fixture(profile = baseProfile) {
  const forbidden = vi.fn(() => {
    throw new Error('old log storage must not be called');
  });
  const queue = { send: vi.fn().mockResolvedValue(undefined) };
  const env = {
    AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline',
    AUDIT_QUEUE: queue,
    DB: { prepare: forbidden },
    DB_PII: { prepare: forbidden },
  } as unknown as Env;
  const service = new AuditService({
    env,
    piiSource: {} as never,
    resolveAuditProfile: async () => profile,
  });
  return { service, env, queue, forbidden };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(emitLogIcebergRow).mockResolvedValue(undefined as never);
});

describe('AuditService.logSystemEvent', () => {
  it('stores the event in runtime.system_events with its own columns and the event retention', async () => {
    const { service, env, forbidden, queue } = fixture();
    await service.logSystemEvent('tenant-1', event);
    expect(emitLogIcebergRow).toHaveBeenCalledExactlyOnceWith(
      env,
      expect.objectContaining({
        tenantId: 'tenant-1',
        sourceDataset: SYSTEM_EVENTS_DATASET,
        logType: 'audit',
        eventAt: event.createdAt,
        expiresAt: AT + 90 * 86_400_000,
        row: {
          id: 'sys-1',
          tenant_id: 'tenant-1',
          source: 'authrim/account_webhook_outbox',
          event_type: 'webhook.outbox.dropped',
          event_category: 'audit',
          result: 'success',
          severity: 'warn',
          error_code: null,
          target_type: 'account_webhook_outbox',
          target_id: 'tenant-1',
          request_id: 'req-1',
          details_json:
            '{"dropped":3,"event_types":{"account.created":3},"reason":"capability_disabled"}',
          created_at: event.createdAt,
          retention_until: AT + 90 * 86_400_000,
        },
        overview: {
          action: 'webhook.outbox.dropped',
          result: 'success',
          severity: 'warn',
          reason_code: null,
          request_id: 'req-1',
          subject_id: null,
          resource_id: 'tenant-1',
        },
      })
    );
    expect(forbidden).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('delivers to the HTTP sinks as an event_log entry that names the dataset in its details', async () => {
    const http = { type: 'http', destinationId: 'https-sink' };
    const { service, queue } = fixture({ ...baseProfile, sinks: [http] } as AuditProfile);
    await service.logSystemEvent('tenant-1', event);
    expect(queue.send).toHaveBeenCalledOnce();
    const [[message]] = queue.send.mock.calls as unknown as [
      [{ type: string; entries: Array<Record<string, unknown>>; fanout: { sinks: unknown[] } }],
    ];
    expect(message.type).toBe('event_log');
    expect(message.fanout.sinks).toEqual([http]);
    const entry = message.entries[0];
    expect(entry).toMatchObject({
      id: 'sys-1',
      tenantId: 'tenant-1',
      eventType: 'webhook.outbox.dropped',
      eventCategory: 'audit',
      result: 'success',
      severity: 'warn',
      requestId: 'req-1',
      createdAt: event.createdAt,
    });
    expect(entry).not.toHaveProperty('anonymizedUserId');
    expect(JSON.parse(entry.detailsJson as string)).toEqual({
      source: SYSTEM_EVENTS_DATASET,
      source_dataset: SYSTEM_EVENTS_DATASET,
      origin: 'authrim/account_webhook_outbox',
      resourceType: 'account_webhook_outbox',
      resourceId: 'tenant-1',
      dropped: 3,
      event_types: { 'account.created': 3 },
      reason: 'capability_disabled',
    });
  });

  it('never lets a detail rename the dataset or the target the sink is told about', async () => {
    const { service, queue } = fixture({
      ...baseProfile,
      sinks: [{ type: 'http', destinationId: 'https-sink' }],
    });
    await service.logSystemEvent('tenant-1', {
      ...event,
      details: { source_dataset: 'core.event_log', resourceId: 'someone-else', dropped: 1 },
    });
    const [[message]] = queue.send.mock.calls as unknown as [
      [{ entries: Array<{ detailsJson: string }> }],
    ];
    expect(JSON.parse(message.entries[0].detailsJson)).toMatchObject({
      source_dataset: SYSTEM_EVENTS_DATASET,
      resourceId: 'tenant-1',
      dropped: 1,
    });
  });

  it('uses the delivery plan retention and category, as the event log does', async () => {
    const { env } = fixture();
    const resolveDeliveryPlan = vi.fn(async () => ({
      auditProfileId: 'profile',
      primary: null,
      archives: [],
      sinks: [],
      retentionDays: 7,
    }));
    const service = new AuditService({
      env,
      resolveAuditProfile: async () => baseProfile,
      resolveDeliveryPlan,
    });
    await service.logSystemEvent('tenant-1', { ...event, eventCategory: 'security' });
    expect(resolveDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', logType: 'event', eventCategory: 'security' })
    );
    expect(emitLogIcebergRow).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ expiresAt: AT + 7 * 86_400_000 })
    );
  });

  it('does not deliver to sinks when the archive write fails', async () => {
    const { service, queue } = fixture({
      ...baseProfile,
      sinks: [{ type: 'http', destinationId: 'https-sink' }],
    });
    vi.mocked(emitLogIcebergRow).mockRejectedValue(new Error('archive_unavailable'));
    await expect(service.logSystemEvent('tenant-1', event)).rejects.toThrow('archive_unavailable');
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('fails a required durable fanout only under retry_until_ttl, as the event log does', async () => {
    const sinks = [{ type: 'http', destinationId: 'https-sink' }];
    const strict = fixture({
      ...baseProfile,
      sinks,
      sinkFailureMode: 'retry_until_ttl',
    } as AuditProfile);
    strict.queue.send.mockRejectedValue(new Error('queue_down'));
    await expect(
      strict.service.logSystemEvent('tenant-1', { ...event, requireDurableFanout: true })
    ).rejects.toThrow('audit_fanout_queue_failed');

    const lenient = fixture({ ...baseProfile, sinks });
    lenient.queue.send.mockRejectedValue(new Error('queue_down'));
    await expect(lenient.service.logSystemEvent('tenant-1', event)).resolves.toBeUndefined();
  });

  it('refuses an invalid time', async () => {
    const { service } = fixture();
    await expect(service.logSystemEvent('tenant-1', { ...event, createdAt: -1 })).rejects.toThrow(
      'audit_event_created_at_invalid'
    );
    expect(emitLogIcebergRow).not.toHaveBeenCalled();
  });
});
