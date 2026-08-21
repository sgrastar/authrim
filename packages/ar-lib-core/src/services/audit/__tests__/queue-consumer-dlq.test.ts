import { afterEach, describe, expect, it, vi } from 'vitest';
import { processDLQQueue } from '../queue-consumer';
import type { AuditQueueMessage } from '../types';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createMessage(body: AuditQueueMessage) {
  return {
    id: crypto.randomUUID(),
    attempts: 5,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createAdminDbAdapter() {
  let notificationLookupCount = 0;
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: 'notification-1',
          tenant_id: 'tenant-a',
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

describe('audit DLQ consumer', () => {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    consoleErrorSpy.mockClear();
  });

  it('writes replay payloads under tenant_key paths and records DLQ metadata', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'failure',
          severity: 'critical',
          createdAt: Date.now(),
        },
      ],
    });

    await processDLQQueue(
      { messages: [message], queue: 'AUDIT_DLQ' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      } as unknown as Parameters<typeof processDLQQueue>[1]
    );

    const objectKey = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(objectKey).toContain('dlq/tenant_key=');
    expect(objectKey).not.toContain('tenant-a');
    const objectBody = String(
      (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
    );
    expect(objectBody).not.toContain('auth.login');
    expect((bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        httpMetadata: { contentType: 'application/vnd.authrim.object-envelope+json' },
        customMetadata: expect.objectContaining({ encryption: 'authrim-object-envelope-v1' }),
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_dlq_items'),
      expect.arrayContaining(['audit_queue_message', 1, 'critical'])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['audit', 'delivery_event', 'critical', 'dlq'])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining(['tenant-a', 'logging_dlq_backlog', 'logging.delivery.dlq'])
    );
    const notificationInsert = adminDb.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO internal_notification_events')
    );
    const notificationPayload = JSON.parse(String((notificationInsert?.[1] as unknown[])[6]));
    expect(notificationPayload.notification_routing_policy).toEqual({
      providers: ['internal_event', 'webhook', 'email'],
      failurePolicy: 'retry_until_dead_letter',
      policyScope: 'deployment',
      allowProviderSuppression: true,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('fails closed instead of writing a plaintext DLQ payload without an encryption key', async () => {
    const bucket = { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'failure',
          severity: 'critical',
          createdAt: Date.now(),
        },
      ],
    });

    await processDLQQueue(
      { messages: [message], queue: 'AUDIT_DLQ' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: createAdminDbAdapter(),
        AUDIT_ARCHIVE: bucket,
      } as unknown as Parameters<typeof processDLQQueue>[1]
    );

    expect(bucket.put).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });
});
