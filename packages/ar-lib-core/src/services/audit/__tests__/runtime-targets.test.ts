import { describe, expect, it } from 'vitest';
import {
  auditTargetFromBackendConfig,
  buildAuditStorageBackendsFromProfile,
  buildAuditStorageConfigFromProfile,
  buildPrimaryBackendMap,
  targetToBackendId,
} from '../runtime-targets';

describe('audit runtime target resolution', () => {
  it.each([
    [null, null],
    [{ type: 'd1', bindingRef: 'DB' }, 'd1-core'],
    [{ type: 'd1', bindingRef: 'DB_PII' }, 'd1-pii'],
    [{ type: 'd1', bindingRef: 'DB_ADMIN' }, 'd1-admin'],
    [{ type: 'd1', bindingRef: 'CUSTOM' }, 'd1'],
    [{ type: 'postgres', connectionRef: 'PG' }, 'PG'],
    [{ type: 'postgres' }, 'postgres-primary'],
    [{ type: 'mysql' }, 'mysql-primary'],
    [{ type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS' }, 'r2:DIAGNOSTIC_LOGS'],
    [{ type: 'r2', bucketRef: 'AUDIT' }, 'r2:AUDIT'],
    [{ type: 'logpush', destinationRef: 'logs' }, 'logpush:logs'],
    [{ type: 'firehose', streamRef: 'stream' }, 'firehose:stream'],
    [{ type: 'http', urlRef: 'AUDIT_URL' }, 'http:AUDIT_URL'],
    [{ type: 'http', url: 'https://audit.example' }, 'http:https://audit.example'],
    [{ type: 'http' }, 'http:sink'],
    [{ type: 'unknown' }, null],
  ])('maps target %# to stable backend id %s', (target, id) => {
    expect(targetToBackendId(target as never)).toBe(id);
  });

  it.each([
    [{ id: 'off', type: 'D1', enabled: false }, null],
    [{ id: 'missing', type: 'D1', enabled: true }, null],
    [
      { id: 'core', type: 'D1', enabled: true, d1Config: { binding: 'DB' } },
      { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
    ],
    [
      { id: 'pii', type: 'D1', enabled: true, d1Config: { binding: 'DB_PII' } },
      { type: 'd1', bindingRef: 'DB_PII', dataset: 'pii_log' },
    ],
    [
      { id: 'admin', type: 'D1', enabled: true, d1Config: { binding: 'DB_ADMIN' } },
      { type: 'd1', bindingRef: 'DB_ADMIN', dataset: 'admin_audit_log' },
    ],
    [
      { id: 'pg', type: 'HYPERDRIVE', enabled: true, hyperdriveConfig: { binding: 'PG' } },
      { type: 'postgres', connectionRef: 'PG', dataset: 'event_log' },
    ],
    [
      {
        id: 'mysql',
        type: 'HYPERDRIVE',
        enabled: true,
        hyperdriveConfig: { binding: '', driver: 'mysql' },
      },
      { type: 'mysql', connectionRef: 'mysql', dataset: 'event_log' },
    ],
    [{ id: 'r2', type: 'R2', enabled: true }, null],
    [
      { id: 'r2', type: 'R2', enabled: true, r2Config: { binding: 'AUDIT', pathPrefix: 'logs/' } },
      { type: 'r2', bucketRef: 'AUDIT', prefix: 'logs/' },
    ],
    [{ id: 'lp', type: 'LOGPUSH', enabled: true }, null],
    [
      {
        id: 'lp',
        type: 'LOGPUSH',
        enabled: true,
        logpushConfig: { destinationRef: 'dest', dataset: 'events' },
      },
      { type: 'logpush', destinationRef: 'dest', dataset: 'events' },
    ],
    [{ id: 'fh', type: 'FIREHOSE', enabled: true }, null],
    [
      { id: 'fh', type: 'FIREHOSE', enabled: true, firehoseConfig: { streamRef: 'stream' } },
      { type: 'firehose', streamRef: 'stream' },
    ],
    [{ id: 'http', type: 'HTTP', enabled: true }, null],
    [
      {
        id: 'http',
        type: 'HTTP',
        enabled: true,
        httpConfig: {
          url: 'https://audit.example',
          urlRef: 'URL',
          authTokenRef: 'TOKEN',
          headers: { 'X-Source': 'authrim' },
          method: 'POST',
          format: 'jsonl',
        },
      },
      {
        type: 'http',
        url: 'https://audit.example',
        urlRef: 'URL',
        authTokenRef: 'TOKEN',
        headers: { 'X-Source': 'authrim' },
        method: 'POST',
        format: 'jsonl',
      },
    ],
    [{ id: 'unknown', type: 'UNKNOWN', enabled: true }, null],
  ])('converts backend config %# into runtime target', (backend, target) => {
    expect(auditTargetFromBackendConfig(backend as never)).toEqual(target);
  });

  it('adds profile destinations once while retaining base backends', () => {
    const profile = {
      primary: { type: 'postgres', connectionRef: 'PG' },
      archive: { type: 'r2', bucketRef: 'AUDIT', prefix: 'tenant/' },
      sinks: [
        { type: 'logpush', destinationRef: 'logs', dataset: 'events' },
        { type: 'firehose', streamRef: 'stream' },
        {
          type: 'http',
          urlRef: 'AUDIT_URL',
          authTokenRef: 'TOKEN',
          headers: { 'X-Tenant': 'tenant-a' },
          method: 'POST',
          format: 'json',
        },
      ],
    };
    const base = [
      { id: 'existing', type: 'D1', enabled: true, priority: 1, d1Config: { binding: 'DB' } },
      { id: 'PG', type: 'HYPERDRIVE', enabled: true, priority: 1 },
    ];
    const backends = buildAuditStorageBackendsFromProfile(profile as never, base as never);
    expect(backends.map((backend) => backend.id)).toEqual([
      'existing',
      'PG',
      'r2:AUDIT',
      'logpush:logs',
      'firehose:stream',
      'http:AUDIT_URL',
    ]);
    expect(backends.find((backend) => backend.id === 'r2:AUDIT')).toMatchObject({
      r2Config: { binding: 'AUDIT', pathPrefix: 'tenant/', format: 'jsonl' },
    });
  });

  it('builds logical D1 primary aliases and merges requested primary backends', () => {
    const profile = { primary: { type: 'd1', bindingRef: 'DB' }, sinks: [] };
    const mapping = buildPrimaryBackendMap(
      profile as never,
      [
        {
          id: 'requested-pg',
          type: 'HYPERDRIVE',
          enabled: true,
          hyperdriveConfig: { binding: 'PG', driver: 'postgres' },
        },
        { id: 'ignored-r2', type: 'R2', enabled: true, r2Config: { binding: 'AUDIT' } },
      ] as never
    );
    expect(mapping.get('archive-only')).toBeNull();
    expect(mapping.get('d1-core')).toEqual({ type: 'd1', bindingRef: 'DB', dataset: 'event_log' });
    expect(mapping.get('d1-pii')).toEqual({
      type: 'd1',
      bindingRef: 'DB_PII',
      dataset: 'pii_log',
    });
    expect(mapping.get('requested-pg')).toEqual({
      type: 'postgres',
      connectionRef: 'PG',
      dataset: 'event_log',
    });
    expect(mapping.has('ignored-r2')).toBe(false);
  });

  it('builds storage config from profile retention and caller overrides', () => {
    const profile = {
      primary: { type: 'mysql', connectionRef: 'MYSQL' },
      sinks: [],
      retention: {
        primaryDays: 30,
        piiLogRetentionDays: 10,
        archiveBeforeDelete: false,
        minimumRetentionDays: 7,
      },
    };
    const config = buildAuditStorageConfigFromProfile(profile as never, {
      routingRules: [{ eventType: 'security', backendId: 'MYSQL' }] as never,
      batchConfig: { maxBatchSize: 10, flushIntervalMs: 100 } as never,
    });
    expect(config).toMatchObject({
      defaultEventBackend: 'MYSQL',
      defaultPiiBackend: 'MYSQL',
      defaultRetention: {
        eventLogRetentionDays: 30,
        piiLogRetentionDays: 10,
        archiveBeforeDelete: false,
        minimumRetentionDays: 7,
      },
      routingRules: [{ eventType: 'security', backendId: 'MYSQL' }],
      batchConfig: { maxBatchSize: 10, flushIntervalMs: 100 },
    });
  });

  it('uses archive-only when no primary and accepts explicit retention', () => {
    const retention = {
      eventLogRetentionDays: 1,
      piiLogRetentionDays: 2,
      archiveBeforeDelete: true,
    };
    const config = buildAuditStorageConfigFromProfile(
      { sinks: [], retention: { primaryDays: 99 } } as never,
      { retentionConfig: retention }
    );
    expect(config.defaultEventBackend).toBe('archive-only');
    expect(config.defaultPiiBackend).toBe('archive-only');
    expect(config.defaultRetention).toBe(retention);
  });
});
