import { describe, expect, it } from 'vitest';
import {
  filterControlManagedD1ForEnvironment,
  filterControlManagedKVForEnvironment,
  filterControlManagedR2ForEnvironment,
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

  it('selects only exact Control-managed resources for the requested environment', () => {
    expect(
      filterControlManagedD1ForEnvironment('test', [
        { name: 'authrim-test-core-default-default-a1b2c3d4', uuid: 'shared' },
        { name: 'authrim-test-core-users-default-tenant-a-a1b2c3d4', uuid: 'exclusive' },
        { name: `authrim-test-${'a'.repeat(32)}-d1`, uuid: 'plugin' },
        { name: 'authrim-test-unrelated-a1b2c3d4', uuid: 'unrelated' },
        { name: 'authrim-other-core-default-default-a1b2c3d4', uuid: 'other' },
      ])
    ).toEqual([
      { name: 'authrim-test-core-default-default-a1b2c3d4', uuid: 'shared' },
      { name: 'authrim-test-core-users-default-tenant-a-a1b2c3d4', uuid: 'exclusive' },
      { name: `authrim-test-${'a'.repeat(32)}-d1`, uuid: 'plugin' },
    ]);

    expect(
      filterControlManagedKVForEnvironment('test', [
        { title: `authrim-test-${'b'.repeat(32)}-kv`, id: 'plugin-kv' },
        { title: `authrim-other-${'b'.repeat(32)}-kv`, id: 'other-kv' },
        { title: 'authrim-test-not-owned-kv', id: 'unrelated-kv' },
      ])
    ).toEqual([{ title: `authrim-test-${'b'.repeat(32)}-kv`, id: 'plugin-kv' }]);

    expect(
      filterControlManagedR2ForEnvironment('test', [
        { name: `authrim-test-${'c'.repeat(32)}-r2` },
        { name: `authrim-other-${'c'.repeat(32)}-r2` },
        { name: 'authrim-test-not-owned-r2' },
      ])
    ).toEqual([{ name: `authrim-test-${'c'.repeat(32)}-r2` }]);
  });
});
