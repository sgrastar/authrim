import { describe, expect, it, vi } from 'vitest';
import { materializeEncryptedObjectArtifact } from '../object-artifact-materialization';

const OBJECT_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('object artifact materialization', () => {
  it('creates manifest and chunk objects when payload exceeds the chunk budget', async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const result = await materializeEncryptedObjectArtifact({ execute } as any, bucket, {
      tenantId: 'default',
      objectClass: 'user_export',
      representation: 'canonical_json',
      objectKeyBase: 'exports/default/data-export/export-1/artifact.json',
      content: 'hello world',
      contentType: 'application/json',
      rootKeyHex: OBJECT_ROOT_KEY,
      keyVersion: 1,
      maxChunkBytes: 5,
    });

    expect(result.chunked).toBe(true);
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.primaryObjectKey).toBe(
      'exports/default/data-export/export-1/artifact.json.manifest.json'
    );
    expect((bucket.put as any).mock.calls.map((call: unknown[]) => call[0])).toContain(
      'exports/default/data-export/export-1/artifact.json.manifest.json'
    );
    expect(
      (bucket.put as any).mock.calls.some((call: unknown[]) =>
        String(call[0]).includes('.part-000000')
      )
    ).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO object_catalog'),
      expect.arrayContaining(['default', 'user_export'])
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO object_catalog_objects'),
      expect.arrayContaining(['canonical_json', 'manifest'])
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO object_catalog_objects'),
      expect.arrayContaining(['canonical_json', 'chunk'])
    );
  });
});
