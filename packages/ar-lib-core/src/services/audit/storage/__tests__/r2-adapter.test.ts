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
