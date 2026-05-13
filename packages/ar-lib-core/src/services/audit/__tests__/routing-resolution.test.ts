import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIT_STORAGE_CONFIG,
  resolveAuditRoutingTargets,
  type AuditStorageConfig,
} from '../storage';

describe('audit routing resolution', () => {
  it('falls back to the default backend when no rules match', () => {
    const resolved = resolveAuditRoutingTargets(DEFAULT_AUDIT_STORAGE_CONFIG, {
      tenantId: 'tenant-1',
      logType: 'event',
    });

    expect(resolved).toEqual({
      primaryStore: 'd1-core',
      archiveStores: [],
      forwardingSinks: [],
      retention: {},
      matchedRuleNames: [],
    });
  });

  it('uses first matching primaryStore and unions archive/sink fan-out', () => {
    const config: AuditStorageConfig = {
      ...DEFAULT_AUDIT_STORAGE_CONFIG,
      routingRules: [
        {
          name: 'tenant-hot-path',
          priority: 5,
          enabled: true,
          conditions: { tenantId: 'tenant-1', logType: 'event' },
          targets: {
            primaryStore: 'hyperdrive-eu',
            archiveStores: ['r2-primary-archive'],
          },
          retention: {
            eventLogRetentionDays: 30,
          },
        },
        {
          name: 'tenant-forwarding',
          priority: 10,
          enabled: true,
          conditions: { tenantId: 'tenant-1', logType: 'event' },
          targets: {
            primaryStore: 'ignored-lower-priority-primary',
            archiveStores: ['r2-secondary-archive'],
            forwardingSinks: ['logpush-eu', 'firehose-secops'],
          },
          retention: {
            eventLogRetentionDays: 7,
            archiveBeforeDelete: true,
          },
        },
      ],
    };

    const resolved = resolveAuditRoutingTargets(config, {
      tenantId: 'tenant-1',
      logType: 'event',
    });

    expect(resolved).toEqual({
      primaryStore: 'hyperdrive-eu',
      archiveStores: ['r2-primary-archive', 'r2-secondary-archive'],
      forwardingSinks: ['logpush-eu', 'firehose-secops'],
      retention: {
        eventLogRetentionDays: 30,
        archiveBeforeDelete: true,
      },
      matchedRuleNames: ['tenant-hot-path', 'tenant-forwarding'],
    });
  });

  it('matches pii routes separately from event routes', () => {
    const config: AuditStorageConfig = {
      ...DEFAULT_AUDIT_STORAGE_CONFIG,
      routingRules: [
        {
          name: 'pii-special',
          priority: 1,
          enabled: true,
          conditions: { tenantId: 'tenant-1', logType: 'pii' },
          targets: {
            primaryStore: 'pii-postgres',
          },
        },
      ],
    };

    const eventResolved = resolveAuditRoutingTargets(config, {
      tenantId: 'tenant-1',
      logType: 'event',
    });
    const piiResolved = resolveAuditRoutingTargets(config, {
      tenantId: 'tenant-1',
      logType: 'pii',
    });

    expect(eventResolved.primaryStore).toBe('d1-core');
    expect(piiResolved.primaryStore).toBe('pii-postgres');
  });
});
