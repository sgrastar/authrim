import { describe, expect, it } from 'vitest';
import {
  filterKnownD1NamesForEnvironment,
  getObjectCatalogR2BucketName,
  parseR2BucketRows,
  parseD1RowsFromWranglerJson,
  parseObjectCatalogR2RowsFromWranglerJson,
} from '../core/cloudflare.js';

describe('Cloudflare environment deletion helpers', () => {
  it('maps object catalog R2 bindings to environment bucket names', () => {
    expect(getObjectCatalogR2BucketName('single', 'SENSITIVE_DETAILS')).toBe(
      'single-sensitive-details'
    );
    expect(getObjectCatalogR2BucketName('single', 'DIAGNOSTIC_LOGS')).toBe(
      'single-diagnostic-logs'
    );
    expect(getObjectCatalogR2BucketName('single', 'UNKNOWN')).toBeNull();
  });

  it('parses object catalog rows from wrangler D1 JSON output', () => {
    const rows = parseObjectCatalogR2RowsFromWranglerJson(
      JSON.stringify([
        {
          results: [
            { bucket_binding: 'SENSITIVE_DETAILS', object_key: 'approval/a.json' },
            { bucket_binding: 'EXPORT_ARTIFACTS', object_key: 'exports/b.zip' },
            { bucket_binding: null, object_key: 'ignored' },
            { bucket_binding: 'IMPORT_ARTIFACTS', object_key: 123 },
          ],
        },
      ])
    );

    expect(rows).toEqual([
      { bucketBinding: 'SENSITIVE_DETAILS', objectKey: 'approval/a.json' },
      { bucketBinding: 'EXPORT_ARTIFACTS', objectKey: 'exports/b.zip' },
    ]);
  });

  it('parses R2 bucket rows from JSON and legacy wrangler output', () => {
    expect(parseR2BucketRows(JSON.stringify([{ name: 'prod-authrim-avatars' }]))).toEqual([
      { name: 'prod-authrim-avatars' },
    ]);
    expect(parseR2BucketRows('name: prod-diagnostic-logs\nprod-import-artifacts\n')).toEqual([
      { name: 'prod-diagnostic-logs' },
      { name: 'prod-import-artifacts' },
    ]);
  });

  it('parses generic D1 rows from wrangler JSON output', () => {
    const rows = parseD1RowsFromWranglerJson<{ state: string; count: number }>(
      JSON.stringify([
        { results: [{ state: 'available', count: 2 }] },
        { results: [{ state: 'assigned', count: 1 }] },
      ])
    );

    expect(rows).toEqual([
      { state: 'available', count: 2 },
      { state: 'assigned', count: 1 },
    ]);
  });

  it('keeps preallocated and legacy tenant D1 names for environment deletion', () => {
    expect(
      filterKnownD1NamesForEnvironment('phase9-tenant-d1', [
        'phase9-tenant-d1-authrim-core-db',
        'phase9-tenant-d1-authrim-admin-db',
        'authrim-phase9-tenant-d1-tdb-slot-0001-core',
        'authrim-phase9-tenant-d1-tdb-slot-0001-pii',
        'authrim-phase9-tenant-d1-first-core',
        'authrim-phase9-tenant-d1-first-pii',
        'authrim-other-tdb-slot-0001-core',
      ])
    ).toEqual([
      'phase9-tenant-d1-authrim-core-db',
      'phase9-tenant-d1-authrim-admin-db',
      'authrim-phase9-tenant-d1-tdb-slot-0001-core',
      'authrim-phase9-tenant-d1-tdb-slot-0001-pii',
      'authrim-phase9-tenant-d1-first-core',
      'authrim-phase9-tenant-d1-first-pii',
    ]);
  });
});
