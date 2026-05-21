import { describe, expect, it, vi } from 'vitest';
import { buildCanonicalAuditRecord } from '../../canonical-format';
import { createR2AuditAdapter } from '../r2-adapter';
import type { EventLogEntry } from '../../types';

function createEventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    eventType: 'auth.login',
    eventCategory: 'auth',
    result: 'success',
    severity: 'info',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('R2AuditAdapter', () => {
  it('writes immutable tenant_key JSONL batches without read-modify-write appends', async () => {
    const bucket = {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;

    const adapter = createR2AuditAdapter(bucket, {
      id: 'archive:test',
      pathPrefix: 'audit',
      format: 'jsonl',
    });
    const result = await adapter.writeEventLogBatch([createEventEntry()]);

    expect(result.success).toBe(true);
    expect(bucket.get).not.toHaveBeenCalled();
    const objectKey = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const metadata = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]
      ?.customMetadata;
    expect(objectKey).toContain('audit/event/t_');
    expect(objectKey).not.toContain('tenant-1');
    expect(metadata).toEqual(
      expect.objectContaining({
        tenantKey: expect.stringMatching(/^t_/),
        entryCount: '1',
      })
    );
    expect(metadata).not.toHaveProperty('tenantId');
  });

  it('uses a tenant registry backed key resolver for archive paths', async () => {
    const bucket = {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;

    const adapter = createR2AuditAdapter(bucket, {
      id: 'archive:test',
      pathPrefix: 'audit',
      format: 'jsonl',
      tenantKeyResolver: async () => 't_registry_archive',
    });
    const result = await adapter.writeEventLogBatch([createEventEntry()]);

    expect(result.success).toBe(true);
    const objectKey = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const metadata = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]
      ?.customMetadata;
    expect(objectKey).toContain('audit/event/t_registry_archive/');
    expect(objectKey).not.toContain('tenant-1');
    expect(metadata).toEqual(expect.objectContaining({ tenantKey: 't_registry_archive' }));
  });

  it('reads canonical archive records back as raw audit entries', async () => {
    const entry = createEventEntry();
    const body = JSON.stringify(
      buildCanonicalAuditRecord(
        { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
        {
          type: 'event_log',
          tenantId: 'tenant-1',
          timestamp: entry.createdAt,
          entries: [entry],
          fanout: {
            auditProfileId: 'audit-archive',
            archives: [],
            sinks: [],
          },
        },
        entry,
        'archive'
      )
    );

    const bucket = {
      get: vi.fn().mockResolvedValue({
        text: async () => body,
      }),
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'audit/event/tenant-1/2023-11-14/evt-1.json' }],
        truncated: false,
      }),
      put: vi.fn(),
      delete: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;

    const adapter = createR2AuditAdapter(bucket, {
      id: 'archive:test',
      pathPrefix: 'audit',
      format: 'json',
    });

    const result = await adapter.query({
      tenantId: 'tenant-1',
      logType: 'event',
      limit: 10,
    });

    expect(result.eventEntries).toEqual([expect.objectContaining({ id: 'evt-1' })]);
  });
});
