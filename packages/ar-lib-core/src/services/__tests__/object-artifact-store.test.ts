import { describe, expect, it, vi } from 'vitest';
import { encryptObjectArtifact } from '../object-artifact-crypto';
import {
  loadCatalogObjectArtifact,
  loadCatalogObjectRepresentation,
  loadCatalogObjectJson,
  loadPublicCatalogObjectArtifact,
} from '../object-artifact-store';

const OBJECT_ROOT_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createMockBucket(
  initial: Record<string, { body: Uint8Array; contentType?: string }> = {}
): R2Bucket {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => {
      const object = store.get(key);
      if (!object) {
        return null;
      }
      return {
        text: async () => new TextDecoder().decode(object.body),
        body: new Blob([object.body]).stream(),
        writeHttpMetadata(headers: Headers) {
          if (object.contentType) {
            headers.set('Content-Type', object.contentType);
          }
        },
      };
    }),
  } as unknown as R2Bucket;
}

describe('object-artifact-store helpers', () => {
  it('loads encrypted catalog-backed objects from EXPORT_ARTIFACTS', async () => {
    const payload = JSON.stringify({ ok: true });
    const objectKey = 'exports/default/test/object.json';
    const envelope = await encryptObjectArtifact(payload, {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'default',
        objectKey,
        objectClass: 'user_export',
      },
    });

    const bucket = createMockBucket({
      [objectKey]: {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });

    const adapter = {
      queryOne: vi.fn().mockResolvedValue({
        catalog_id: 'catalog-1',
        public_artifact_id: 'oa_test',
        tenant_id: 'default',
        object_class: 'user_export',
        catalog_created_at: 1,
        catalog_updated_at: 1,
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: objectKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: 128,
        physical_created_at: 1,
        physical_deleted_at: null,
      }),
    } as any;

    const loaded = await loadCatalogObjectArtifact(adapter, {
      EXPORT_ARTIFACTS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    } as any, {
      tenantId: 'default',
      objectCatalogId: 'catalog-1',
      expectedClass: 'user_export',
      expectedBucketBinding: 'EXPORT_ARTIFACTS',
    });

    expect(loaded?.encrypted).toBe(true);
    expect(loaded?.content).toBe(payload);
    expect(loaded?.contentType).toBe('application/json');
  });

  it('falls back to plaintext objects when allowed', async () => {
    const payload = JSON.stringify({ summary: { total: 1 } });
    const objectKey = 'exports/default/plain.json';
    const bucket = createMockBucket({
      [objectKey]: {
        body: new TextEncoder().encode(payload),
        contentType: 'application/json',
      },
    });

    const adapter = {
      queryOne: vi.fn().mockResolvedValue({
        catalog_id: 'catalog-2',
        public_artifact_id: 'oa_plain',
        tenant_id: 'default',
        object_class: 'user_import_result',
        catalog_created_at: 1,
        catalog_updated_at: 1,
        catalog_deleted_at: null,
        physical_id: 'physical-2',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: objectKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: 64,
        physical_created_at: 1,
        physical_deleted_at: null,
      }),
    } as any;

    const loaded = await loadCatalogObjectJson<{ summary: { total: number } }>(
      adapter,
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
      } as any,
      {
        tenantId: 'default',
        objectCatalogId: 'catalog-2',
        expectedClass: 'user_import_result',
      }
    );

    expect(loaded?.encrypted).toBe(false);
    expect(loaded?.value.summary.total).toBe(1);
  });

  it('loads encrypted objects by public artifact id', async () => {
    const payload = JSON.stringify({ rows: 5 });
    const objectKey = 'exports/default/public/object.json';
    const envelope = await encryptObjectArtifact(payload, {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'default',
        objectKey,
        objectClass: 'user_export',
      },
    });

    const bucket = createMockBucket({
      [objectKey]: {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });

    const adapter = {
      queryOne: vi.fn().mockResolvedValue({
        catalog_id: 'catalog-3',
        public_artifact_id: 'oa_public123',
        tenant_id: 'default',
        object_class: 'user_export',
        catalog_created_at: 1,
        catalog_updated_at: 1,
        catalog_deleted_at: null,
        physical_id: 'physical-3',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: objectKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: 64,
        physical_created_at: 1,
        physical_deleted_at: null,
      }),
    } as any;

    const loaded = await loadPublicCatalogObjectArtifact(
      adapter,
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
      } as any,
      {
        tenantId: 'default',
        publicArtifactId: 'oa_public123',
        expectedClass: 'user_export',
        expectedBucketBinding: 'EXPORT_ARTIFACTS',
      }
    );

    expect(loaded?.content).toBe(payload);
    expect(loaded?.logical.publicArtifactId).toBe('oa_public123');
  });

  it('assembles chunked representations into a single content payload', async () => {
    const partA = await encryptObjectArtifact('hello ', {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'default',
        objectKey: 'exports/default/chunked/artifact.json.part-000000',
        objectClass: 'user_export',
      },
    });
    const partB = await encryptObjectArtifact('world', {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'default',
        objectKey: 'exports/default/chunked/artifact.json.part-000001',
        objectClass: 'user_export',
      },
    });

    const bucket = createMockBucket({
      'exports/default/chunked/artifact.json.part-000000': {
        body: new TextEncoder().encode(JSON.stringify(partA)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
      'exports/default/chunked/artifact.json.part-000001': {
        body: new TextEncoder().encode(JSON.stringify(partB)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });

    const adapter = {
      queryOne: vi.fn().mockImplementation(async (_sql: string, params: unknown[]) => {
        const index = params[2];
        if (index === 0) {
          return {
            catalog_id: 'catalog-chunked',
            public_artifact_id: 'oa_chunked',
            tenant_id: 'default',
            object_class: 'user_export',
            catalog_created_at: 1,
            catalog_updated_at: 1,
            catalog_deleted_at: null,
            physical_id: 'physical-0',
            representation: 'canonical_json',
            object_kind: 'chunk',
            object_index: 0,
            bucket_binding: 'EXPORT_ARTIFACTS',
            object_key: 'exports/default/chunked/artifact.json.part-000000',
            key_version: 1,
            checksum_sha256: null,
            total_bytes: 6,
            physical_created_at: 1,
            physical_deleted_at: null,
          };
        }
        if (index === 1) {
          return {
            catalog_id: 'catalog-chunked',
            public_artifact_id: 'oa_chunked',
            tenant_id: 'default',
            object_class: 'user_export',
            catalog_created_at: 1,
            catalog_updated_at: 1,
            catalog_deleted_at: null,
            physical_id: 'physical-1',
            representation: 'canonical_json',
            object_kind: 'chunk',
            object_index: 1,
            bucket_binding: 'EXPORT_ARTIFACTS',
            object_key: 'exports/default/chunked/artifact.json.part-000001',
            key_version: 1,
            checksum_sha256: null,
            total_bytes: 5,
            physical_created_at: 1,
            physical_deleted_at: null,
          };
        }
        return null;
      }),
      query: vi.fn().mockResolvedValue([
        {
          catalog_id: 'catalog-chunked',
          public_artifact_id: 'oa_chunked',
          tenant_id: 'default',
          object_class: 'user_export',
          catalog_created_at: 1,
          catalog_updated_at: 1,
          catalog_deleted_at: null,
          physical_id: 'physical-manifest',
          representation: 'canonical_json',
          object_kind: 'manifest',
          object_index: -1,
          bucket_binding: 'EXPORT_ARTIFACTS',
          object_key: 'exports/default/chunked/artifact.json.manifest.json',
          key_version: 1,
          checksum_sha256: null,
          total_bytes: 64,
          physical_created_at: 1,
          physical_deleted_at: null,
        },
        {
          catalog_id: 'catalog-chunked',
          public_artifact_id: 'oa_chunked',
          tenant_id: 'default',
          object_class: 'user_export',
          catalog_created_at: 1,
          catalog_updated_at: 1,
          catalog_deleted_at: null,
          physical_id: 'physical-0',
          representation: 'canonical_json',
          object_kind: 'chunk',
          object_index: 0,
          bucket_binding: 'EXPORT_ARTIFACTS',
          object_key: 'exports/default/chunked/artifact.json.part-000000',
          key_version: 1,
          checksum_sha256: null,
          total_bytes: 6,
          physical_created_at: 1,
          physical_deleted_at: null,
        },
        {
          catalog_id: 'catalog-chunked',
          public_artifact_id: 'oa_chunked',
          tenant_id: 'default',
          object_class: 'user_export',
          catalog_created_at: 1,
          catalog_updated_at: 1,
          catalog_deleted_at: null,
          physical_id: 'physical-1',
          representation: 'canonical_json',
          object_kind: 'chunk',
          object_index: 1,
          bucket_binding: 'EXPORT_ARTIFACTS',
          object_key: 'exports/default/chunked/artifact.json.part-000001',
          key_version: 1,
          checksum_sha256: null,
          total_bytes: 5,
          physical_created_at: 1,
          physical_deleted_at: null,
        },
      ]),
    } as any;

    const loaded = await loadCatalogObjectRepresentation(
      adapter,
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
      } as any,
      {
        tenantId: 'default',
        objectCatalogId: 'catalog-chunked',
        expectedClass: 'user_export',
        expectedBucketBinding: 'EXPORT_ARTIFACTS',
      }
    );

    expect(loaded?.content).toBe('hello world');
    expect(loaded?.physical.filter((entry) => entry.objectKind === 'chunk')).toHaveLength(2);
  });

  it('rejects objects when the stored checksum does not match the payload', async () => {
    const payload = JSON.stringify({ ok: true });
    const objectKey = 'exports/default/test/object-bad-checksum.json';
    const envelope = await encryptObjectArtifact(payload, {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'default',
        objectKey,
        objectClass: 'user_export',
      },
    });

    const bucket = createMockBucket({
      [objectKey]: {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });

    const adapter = {
      queryOne: vi.fn().mockResolvedValue({
        catalog_id: 'catalog-4',
        public_artifact_id: 'oa_badchecksum',
        tenant_id: 'default',
        object_class: 'user_export',
        catalog_created_at: 1,
        catalog_updated_at: 1,
        catalog_deleted_at: null,
        physical_id: 'physical-4',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: objectKey,
        key_version: 1,
        checksum_sha256: 'deadbeef',
        total_bytes: 128,
        physical_created_at: 1,
        physical_deleted_at: null,
      }),
    } as any;

    const loaded = await loadCatalogObjectArtifact(adapter, {
      EXPORT_ARTIFACTS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    } as any, {
      tenantId: 'default',
      objectCatalogId: 'catalog-4',
      expectedClass: 'user_export',
      expectedBucketBinding: 'EXPORT_ARTIFACTS',
    });

    expect(loaded).toBeNull();
  });
});
