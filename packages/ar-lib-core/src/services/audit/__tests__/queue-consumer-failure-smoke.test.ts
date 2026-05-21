import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAuditQueue, processDLQQueue, processLoggingDeliveryQueue } from '../queue-consumer';
import type { AuditQueueMessage } from '../types';

function createMessage<T>(body: T, attempts = 1) {
  return {
    id: crypto.randomUUID(),
    attempts,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createFailingBucket() {
  return {
    put: vi.fn().mockRejectedValue(new Error('r2 unavailable')),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn(),
    list: vi.fn(),
    head: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

function createMemoryBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn().mockImplementation(async (key: string, value: unknown) => {
      if (typeof value === 'string') {
        objects.set(key, value);
        return;
      }
      if (value instanceof Uint8Array) {
        objects.set(key, new TextDecoder().decode(value));
        return;
      }
      objects.set(key, String(value));
    }),
    get: vi.fn().mockImplementation(async (key: string) => {
      const value = objects.get(key);
      if (value == null) {
        return null;
      }
      return {
        text: vi.fn().mockResolvedValue(value),
      };
    }),
    delete: vi.fn(),
    list: vi.fn(),
    head: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    objects,
  };
  return bucket as unknown as R2Bucket & { objects: Map<string, string> };
}

function createAdminDbAdapter(
  options: { dlqItemId?: string; tenantKey?: string; objectRef?: string } = {}
) {
  let notificationLookupCount = 0;
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM logging_dlq_items')) {
        return Promise.resolve({
          id: options.dlqItemId ?? params[0] ?? 'dlq_1',
          tenant_key: options.tenantKey ?? 'tk_failure',
          payload_type: 'audit_queue_message',
          schema_version: 1,
          lane: 'critical',
          destination_id: 'queue:AUDIT_DLQ',
          payload_object_ref: options.objectRef ?? 'dlq/tenant_key=tk_failure/item.json',
          status: 'open',
        });
      }
      if (sql.includes('internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: 'notification-1',
          tenant_id: options.tenantKey ?? 'tk_failure',
          category: 'logging_dlq_backlog',
          event_type: 'logging.delivery.dlq',
          severity: 'critical',
          status: 'pending',
          deduplication_key: params[0] ?? null,
          payload_json: '{}',
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          delivered_at: null,
        });
      }
      return Promise.resolve(null);
    }),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createAuditBody(): AuditQueueMessage {
  return {
    type: 'event_log',
    tenantId: 'tenant-failure',
    timestamp: 1779148800000,
    entries: [
      {
        id: 'evt-r2-failure',
        tenantId: 'tenant-failure',
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'failure',
        severity: 'critical',
        createdAt: 1779148800000,
      },
    ],
    fanout: {
      auditProfileId: 'audit-profile-r2-required',
      archives: [{ type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' }],
      sinks: [],
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'best_effort',
    },
  };
}

describe('logging failure smoke', () => {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    consoleErrorSpy.mockClear();
  });

  it('retries R2 archive failures, persists DLQ payloads, and replays them', async () => {
    const auditBody = createAuditBody();
    const failedAuditMessage = createMessage(auditBody);

    await processAuditQueue(
      {
        messages: [failedAuditMessage],
        queue: 'AUDIT_QUEUE',
      } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DIAGNOSTIC_LOGS: createFailingBucket(),
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(failedAuditMessage.retry).toHaveBeenCalledOnce();
    expect(failedAuditMessage.ack).not.toHaveBeenCalled();

    const replayBucket = createMemoryBucket();
    const dlqAdminDb = createAdminDbAdapter();
    const dlqMessage = createMessage(auditBody, 5);

    await processDLQQueue(
      { messages: [dlqMessage], queue: 'AUDIT_DLQ' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: dlqAdminDb,
        AUDIT_ARCHIVE: replayBucket,
      } as unknown as Parameters<typeof processDLQQueue>[1]
    );

    const payloadObjectRef = [...replayBucket.objects.keys()][0];
    expect(payloadObjectRef).toContain('dlq/tenant_key=');
    expect(payloadObjectRef).not.toContain('tenant-failure');
    expect(dlqAdminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_dlq_items'),
      expect.arrayContaining(['audit_queue_message', 1, 'critical'])
    );
    expect(dlqAdminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['audit', 'delivery_event', 'critical', 'dlq'])
    );
    expect(dlqMessage.ack).toHaveBeenCalledOnce();
    expect(dlqMessage.retry).not.toHaveBeenCalled();

    const tenantKey = payloadObjectRef.match(/tenant_key=([^/]+)/)?.[1];
    expect(tenantKey).toBeTruthy();

    const send = vi.fn().mockResolvedValue(undefined);
    const replayAdminDb = createAdminDbAdapter({
      dlqItemId: 'dlq_failure_smoke',
      objectRef: payloadObjectRef,
      tenantKey,
    });
    const replayMessage = createMessage({
      payload_type: 'dlq_replay',
      schema_version: 1,
      payload_id: 'qpl_failure_smoke_replay',
      tenant_key: tenantKey,
      lane: 'critical',
      created_at: 1779148800000,
      dlq_item_id: 'dlq_failure_smoke',
      requested_by: 'admin-1',
    });

    await processLoggingDeliveryQueue(
      {
        messages: [replayMessage],
        queue: 'LOGGING_DELIVERY_QUEUE',
      } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: replayAdminDb,
        AUDIT_ARCHIVE: replayBucket,
        AUDIT_QUEUE: { send } as never,
      } as unknown as Parameters<typeof processLoggingDeliveryQueue>[1]
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_log',
        tenantId: 'tenant-failure',
      })
    );
    expect(replayAdminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'replayed'"),
      expect.arrayContaining(['dlq_failure_smoke'])
    );
    expect(replayMessage.ack).toHaveBeenCalledOnce();
    expect(replayMessage.retry).not.toHaveBeenCalled();
  });
});
