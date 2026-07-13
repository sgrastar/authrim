import { describe, expect, it } from 'vitest';
import {
  buildR2BucketProvisioningStatus,
  deriveSetupCapabilityEstimate,
  deriveSetupCapabilityStatuses,
  filterKnownD1NamesForEnvironment,
  filterKnownQueueNamesForEnvironment,
  getObjectCatalogR2BucketName,
  getR2BucketName,
  isZoneReadPermissionError,
  parseObjectCatalogR2RowsFromWranglerJson,
  shouldMirrorPiiMigrationsToCore,
  toResourceIds,
} from '../core/cloudflare.js';

describe('Cloudflare pure resource contracts', () => {
  it('distinguishes configured, stale, and unrecorded required R2 buckets', () => {
    const status = buildR2BucketProvisioningStatus(
      'prod',
      {
        PUBLIC_ASSETS: { name: 'prod-public-assets' },
        AVATARS: { name: 'legacy-avatars' },
      },
      ['prod-public-assets']
    );
    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(1);
    expect(status.buckets.find((bucket) => bucket.binding === 'PUBLIC_ASSETS')?.state).toBe(
      'configured'
    );
    expect(status.buckets.find((bucket) => bucket.binding === 'AVATARS')?.state).toBe(
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
        r2: [{ binding: 'AUDIT_ARCHIVE', name: 'archive-name' }],
      })
    ).toEqual({
      d1: { DB: { id: 'db-id', name: 'db-name' } },
      kv: { SETTINGS: { id: 'kv-id', name: 'kv-name' } },
      queues: { AUDIT_QUEUE: { id: 'queue-id', name: 'queue-name' } },
      r2: { AUDIT_ARCHIVE: { name: 'archive-name' } },
    });
  });

  it('filters environment-owned names without duplicates or cross-environment deletion', () => {
    expect(
      filterKnownD1NamesForEnvironment('prod', [
        'prod-authrim-core-db',
        'authrim-prod-tdb-slot-0001-core',
        'prod-authrim-core-db',
        'production-authrim-core-db',
      ])
    ).toEqual(['prod-authrim-core-db', 'authrim-prod-tdb-slot-0001-core']);
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

  it('mirrors PII migrations only for the explicit single-database profile', () => {
    expect(shouldMirrorPiiMigrationsToCore()).toBe(false);
    expect(shouldMirrorPiiMigrationsToCore({ profiles: { defaults: { storage: 'other' } } })).toBe(
      false
    );
    expect(
      shouldMirrorPiiMigrationsToCore({
        profiles: { defaults: { storage: 'builtin:storage:single-db' } },
      })
    ).toBe(true);
  });
});
