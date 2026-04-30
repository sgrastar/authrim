import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAuditQueue } from '../queue-consumer';
import type { AuditQueueMessage } from '../types';

function createMessage(body: AuditQueueMessage) {
  return {
    id: crypto.randomUUID(),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe('audit queue consumer fanout', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    consoleLogSpy.mockClear();
    vi.unstubAllGlobals();
  });

  it('writes archive fanout to R2 and emits logpush structured logs', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
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
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-1',
        archives: [{ type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' }],
        sinks: [{ type: 'logpush', destinationRef: 'workers-logpush', dataset: 'authrim_audit' }],
        archiveFailureMode: 'gate_cleanup',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DIAGNOSTIC_LOGS: bucket,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(bucket.put).toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
    expect((bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain('.json');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('"schema":"authrim.audit.v1"')
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries when archive delivery is required and the target binding is unavailable', async () => {
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
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-1',
        archives: [{ type: 'r2', bucketRef: 'MISSING_BUCKET', prefix: 'audit/' }],
        sinks: [],
        archiveFailureMode: 'gate_cleanup',
        sinkFailureMode: 'best_effort',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('delivers generic HTTP sinks through fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

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
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            url: 'https://example.com/audit',
            headers: { 'X-Authrim-Sink': 'enabled' },
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/audit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Authrim-Sink': 'enabled',
        }),
        body: expect.stringContaining('"recordType":"audit_batch"'),
      })
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries generic HTTP sinks with non-https URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

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
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            url: 'http://example.com/audit',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
