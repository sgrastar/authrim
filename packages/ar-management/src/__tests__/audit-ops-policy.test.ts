import { describe, expect, it } from 'vitest';
import {
  buildAuditOperationalPolicy,
  validateAuditOperationalConstraints,
} from '../audit-ops-policy';

describe('audit ops policy', () => {
  it('rejects non-R2 archive targets when archiveBeforeDelete is enabled', () => {
    const errors = validateAuditOperationalConstraints(
      {
        id: 'audit-profile',
        kind: 'audit',
        label: 'Audit Profile',
        primary: {
          type: 'd1',
          bindingRef: 'DB',
          dataset: 'event_log',
        },
        archive: {
          type: 'postgres',
          connectionRef: 'audit-archive',
        },
        sinks: [],
        retention: {
          archiveBeforeDelete: true,
        },
      },
      {
        queueConfigured: true,
      }
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        'Only R2 archive targets are currently supported.',
        'archiveBeforeDelete currently requires an R2 archive target.',
      ])
    );
  });

  it('reports archiveBeforeDelete as enforced once an R2 archive target is configured', () => {
    const policy = buildAuditOperationalPolicy({
      profile: {
        id: 'audit-profile',
        kind: 'audit',
        label: 'Audit Profile',
        primary: {
          type: 'd1',
          bindingRef: 'DB',
          dataset: 'event_log',
        },
        archive: {
          type: 'r2',
          bucketRef: 'DIAGNOSTIC_LOGS',
          prefix: 'audit/',
        },
        sinks: [],
        retention: {
          archiveBeforeDelete: true,
          eventLogRetentionDays: 90,
          piiLogRetentionDays: 365,
        },
      },
      resolvedRetention: {
        eventLogRetentionDays: 90,
        piiLogRetentionDays: 365,
        archiveBeforeDelete: true,
      },
      batchConfig: {
        maxBufferSize: 100,
        maxBatchSize: 100,
        flushIntervalMs: 5000,
      },
      queueConfigured: true,
      queueArchiveConfigured: true,
      hotQuery: {
        supported: true,
        status: 'supported',
        auditProfileId: 'audit-profile',
      },
    });

    expect(policy.retention.archiveBeforeDeleteStatus).toBe('enforced');
    expect(policy.cleanup.mode).toBe('archive_copy_before_delete');
    expect(policy.queue.retryLimit).toBe(5);
    expect(policy.queue.archiveBackupStatus).toBe('configured');
    expect(policy.warnings).toEqual([]);
  });
});
