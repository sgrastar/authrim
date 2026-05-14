import { describe, expect, it } from 'vitest';
import {
  getObjectCatalogR2BucketName,
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
});
