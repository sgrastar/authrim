import { describe, expect, it } from 'vitest';
import {
  buildR2BucketProvisioningStatus,
  deriveSetupCapabilityEstimate,
  deriveSetupCapabilityStatuses,
  filterKnownD1NamesForEnvironment,
  filterKnownQueueNamesForEnvironment,
  getObjectCatalogR2BucketName,
  getProvisioningResourceCount,
  getRequiredR2Buckets,
  getR2BucketName,
  isZoneReadPermissionError,
  normalizeWorkerCronTriggersResponse,
  parseObjectCatalogR2RowsFromWranglerJson,
  toResourceIds,
} from '../core/cloudflare.js';

describe('Cloudflare pure resource contracts', () => {
  it('normalizes a valid Cron Trigger API response and rejects ambiguous rows', () => {
    expect(
      normalizeWorkerCronTriggersResponse({
        success: true,
        result: { schedules: [{ cron: '*/5 * * * *' }, { cron: '* * * * *' }] },
      })
    ).toEqual(['* * * * *', '*/5 * * * *']);
    expect(() =>
      normalizeWorkerCronTriggersResponse({
        success: true,
        result: { schedules: [{ cron: '* * * * *' }, { cron: '* * * * *' }] },
      })
    ).toThrow('cloudflare_worker_cron_response_invalid');
    expect(() =>
      normalizeWorkerCronTriggersResponse({ success: true, result: { schedules: [{}] } })
    ).toThrow('cloudflare_worker_cron_response_invalid');
  });

  it('requires the complete eight-bucket R2 topology by default', () => {
    expect(getRequiredR2Buckets('prod')).toEqual([
      { binding: 'MIGRATION_RELEASES', name: 'prod-migration-releases' },
      { binding: 'PLUGIN_BUNDLES', name: 'prod-plugin-bundles' },
      { binding: 'PUBLIC_ASSETS', name: 'prod-public-assets' },
      { binding: 'DIAGNOSTIC_LOGS', name: 'prod-diagnostic-logs' },
      { binding: 'AUDIT_ARCHIVE', name: 'prod-audit-archive' },
      { binding: 'IMPORT_ARTIFACTS', name: 'prod-import-artifacts' },
      { binding: 'EXPORT_ARTIFACTS', name: 'prod-export-artifacts' },
      { binding: 'SENSITIVE_DETAILS', name: 'prod-sensitive-details' },
    ]);
  });

  it('counts every resource that provisioning will actually create', () => {
    expect(
      getProvisioningResourceCount({
        env: 'prod',
        createQueues: true,
        createR2: true,
      })
    ).toBe(27);
    expect(
      getProvisioningResourceCount({
        env: 'prod',
        createQueues: false,
        createR2: true,
      })
    ).toBe(23);
    expect(
      getProvisioningResourceCount({
        env: 'prod',
        createD1: false,
        createKV: false,
        createQueues: false,
        createR2: false,
      })
    ).toBe(1);
  });

  it('distinguishes configured, stale, and unrecorded required R2 buckets', () => {
    const ownershipId = '00000000-0000-4000-8000-000000000123';
    const creationDate = '2026-05-18T00:00:00.000Z';
    const status = buildR2BucketProvisioningStatus(
      'prod',
      {
        PUBLIC_ASSETS: {
          name: 'prod-public-assets',
          creationDate,
          ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
          ownershipId,
        },
        DIAGNOSTIC_LOGS: {
          name: 'legacy-diagnostic-logs',
        },
      },
      [{ name: 'prod-public-assets', creationDate }]
    );
    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(1);
    expect(status.buckets.find((bucket) => bucket.binding === 'PUBLIC_ASSETS')?.state).toBe(
      'configured'
    );
    expect(status.buckets.find((bucket) => bucket.binding === 'DIAGNOSTIC_LOGS')?.state).toBe(
      'recorded_but_missing'
    );
    expect(status.buckets.find((bucket) => bucket.binding === 'AUDIT_ARCHIVE')?.state).toBe(
      'missing'
    );
    expect(getR2BucketName('dev', 'SENSITIVE_DETAILS')).toBe('dev-sensitive-details');
    expect(() => getR2BucketName('dev', 'UNKNOWN' as never)).toThrow('Unknown R2 bucket binding');
  });

  it('derives capability estimates and nuanced review states', () => {
    const base = {
      wranglerInstalled: true,
      loggedIn: true,
      tokenAvailable: true,
      workersSubdomainAvailable: true,
      zoneReadAvailable: false,
      accessibleZoneCount: 0,
      dnsReadAvailable: false,
      uiWorkersApiAvailable: false,
    };
    expect(deriveSetupCapabilityEstimate(base)).toEqual({
      workersDeploy: true,
      customDomain: false,
      multiTenant: false,
      nakedDomain: false,
      pages: false,
    });
    expect(deriveSetupCapabilityStatuses(base)).toEqual({
      workersDeploy: 'ok',
      customDomain: 'review',
      multiTenant: 'review',
      nakedDomain: 'review',
      pages: 'review',
    });
    expect(
      deriveSetupCapabilityStatuses({
        ...base,
        zoneReadAvailable: true,
        accessibleZoneCount: 0,
      })
    ).toMatchObject({ customDomain: 'ng', multiTenant: 'ng', nakedDomain: 'ng' });
    expect(
      deriveSetupCapabilityStatuses({
        ...base,
        wranglerInstalled: false,
      })
    ).toMatchObject({ workersDeploy: 'ng', customDomain: 'ng', pages: 'ng' });
    expect(
      deriveSetupCapabilityStatuses({
        ...base,
        zoneReadAvailable: true,
        accessibleZoneCount: 1,
        dnsReadAvailable: true,
        uiWorkersApiAvailable: true,
      })
    ).toMatchObject({ customDomain: 'ok', multiTenant: 'ok', nakedDomain: 'ok', pages: 'ok' });
  });

  it('recognizes zone-read diagnostics in legacy and structured forms', () => {
    expect(isZoneReadPermissionError()).toBe(false);
    expect(isZoneReadPermissionError('missing zone:read permission')).toBe(true);
    expect(isZoneReadPermissionError('network error')).toBe(false);
    expect(
      isZoneReadPermissionError({
        found: false,
        error: 'requires zone:read',
        diagnostic: undefined,
      })
    ).toBe(true);
    expect(
      isZoneReadPermissionError({
        code: 'zone_read_forbidden',
        severity: 'warning',
        allowBinding: true,
        actions: [],
      })
    ).toBe(true);
    expect(
      isZoneReadPermissionError({
        code: 'api_error',
        severity: 'error',
        allowBinding: false,
        actions: [],
      })
    ).toBe(false);
  });

  it('converts only present provisioned resource classes to Wrangler IDs', () => {
    expect(toResourceIds({ d1: [], kv: [], queues: [], r2: [] })).toEqual({ d1: {}, kv: {} });
    expect(
      toResourceIds({
        d1: [{ binding: 'DB', id: 'db-id', name: 'db-name' }],
        kv: [{ binding: 'SETTINGS', id: 'kv-id', name: 'kv-name' }],
        queues: [{ binding: 'AUDIT_QUEUE', id: 'queue-id', name: 'queue-name' }],
        r2: [
          {
            binding: 'AUDIT_ARCHIVE',
            name: 'archive-name',
            creationDate: '2026-08-31T00:00:00.000Z',
            ownershipMarkerKey:
              '__authrim_setup__/ownership-v1-11111111-1111-4111-8111-111111111111.json',
            ownershipId: '11111111-1111-4111-8111-111111111111',
          },
        ],
      })
    ).toEqual({
      d1: { DB: { id: 'db-id', name: 'db-name' } },
      kv: { SETTINGS: { id: 'kv-id', name: 'kv-name' } },
      queues: { AUDIT_QUEUE: { id: 'queue-id', name: 'queue-name' } },
      r2: {
        AUDIT_ARCHIVE: {
          name: 'archive-name',
          creationDate: '2026-08-31T00:00:00.000Z',
          ownershipMarkerKey:
            '__authrim_setup__/ownership-v1-11111111-1111-4111-8111-111111111111.json',
          ownershipId: '11111111-1111-4111-8111-111111111111',
        },
      },
    });
  });

  it('filters environment-owned names without duplicates or cross-environment deletion', () => {
    expect(
      filterKnownD1NamesForEnvironment('prod', [
        'prod-authrim-core-db',
        'prod-authrim-tenant-core-default-default-db-a1b2c3d4',
        'authrim-prod-core-default-default-a1b2c3d4',
        'prod-authrim-core-db',
        'production-authrim-core-db',
        'prod-authrim-customer-backups',
      ])
    ).toEqual([
      'prod-authrim-core-db',
      'prod-authrim-tenant-core-default-default-db-a1b2c3d4',
      'authrim-prod-core-default-default-a1b2c3d4',
    ]);
    expect(
      filterKnownQueueNamesForEnvironment('prod', [
        'prod-audit-queue',
        'prod-audit-queue',
        'dev-audit-queue',
        'prod-unknown-queue',
      ])
    ).toEqual(['prod-audit-queue']);
  });

  it('maps valid object-catalog rows and ignores malformed records', () => {
    expect(getObjectCatalogR2BucketName('prod', 'AUDIT_ARCHIVE')).toBe('prod-audit-archive');
    expect(getObjectCatalogR2BucketName('prod', 'UNKNOWN')).toBeNull();
    expect(
      parseObjectCatalogR2RowsFromWranglerJson(
        JSON.stringify([
          {
            results: [
              { bucket_binding: 'AUDIT_ARCHIVE', object_key: 'audit/1.json' },
              { bucket_binding: 1, object_key: 'bad' },
              { bucket_binding: 'AUDIT_ARCHIVE' },
            ],
          },
        ])
      )
    ).toEqual([{ bucketBinding: 'AUDIT_ARCHIVE', objectKey: 'audit/1.json' }]);
    expect(parseObjectCatalogR2RowsFromWranglerJson(JSON.stringify([]))).toEqual([]);
  });
});
