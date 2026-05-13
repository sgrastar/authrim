import { describe, expect, it } from 'vitest';
import {
  AUDIT_CANONICAL_LOG_FORMAT_V1,
  buildCanonicalAuditBatch,
  buildCanonicalAuditRecord,
  extractAuditEntryFromCanonicalPayload,
} from '../canonical-format';
import type { AuditQueueMessage } from '../types';

const baseMessage: AuditQueueMessage = {
  type: 'event_log',
  tenantId: 'tenant-a',
  timestamp: 1_700_000_000_000,
  entries: [
    {
      id: 'evt-1',
      tenantId: 'tenant-a',
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
      severity: 'info',
      createdAt: 1_700_000_000_000,
    },
  ],
  fanout: {
    auditProfileId: 'audit-standard',
    archives: [],
    sinks: [],
    matchedRuleNames: ['default-route'],
  },
};

describe('canonical audit format', () => {
  it('builds per-record canonical payloads', () => {
    const record = buildCanonicalAuditRecord(
      { type: 'logpush', destinationRef: 'workers-logpush' },
      baseMessage,
      baseMessage.entries[0],
      'logpush'
    );

    expect(record).toEqual(
      expect.objectContaining({
        schema: AUDIT_CANONICAL_LOG_FORMAT_V1,
        recordType: 'audit_record',
        tenantId: 'tenant-a',
        logType: 'event_log',
        auditProfileId: 'audit-standard',
        matchedRuleNames: ['default-route'],
        delivery: {
          channel: 'logpush',
          targetType: 'logpush',
          targetRef: 'workers-logpush',
        },
        entry: expect.objectContaining({ id: 'evt-1' }),
      })
    );
  });

  it('builds batch payloads for HTTP sinks and can recover the entry', () => {
    const batch = buildCanonicalAuditBatch(
      { type: 'http', urlRef: 'AUDIT_HTTP_URL' },
      baseMessage,
      'http'
    );

    expect(batch).toEqual(
      expect.objectContaining({
        schema: AUDIT_CANONICAL_LOG_FORMAT_V1,
        recordType: 'audit_batch',
        delivery: {
          channel: 'http',
          targetType: 'http',
          targetRef: 'AUDIT_HTTP_URL',
        },
      })
    );

    expect(extractAuditEntryFromCanonicalPayload(batch)).toEqual(
      expect.objectContaining({ id: 'evt-1' })
    );
  });
});
