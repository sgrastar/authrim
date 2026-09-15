import { describe, expect, it, vi } from 'vitest';
import { encryptObjectArtifact } from '@authrim/ar-lib-core/services/object-artifact-crypto';
import {
  decodePortableR2ObjectChunk,
  TENANT_BACKUP_R2_CHUNK_BYTES,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { createTenantBackupR2ObjectSnapshotPorts } from '../tenant-backup-r2-object-snapshot-port';

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  version: string;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

function objectBody(key: string, value: StoredObject) {
  return {
    key,
    size: value.bytes.length,
    etag: value.etag,
    httpEtag: `"${value.etag}"`,
    version: value.version,
    uploaded: new Date(0),
    checksums: {},
    httpMetadata: value.httpMetadata ?? {},
    customMetadata: value.customMetadata ?? {},
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(value.bytes);
        controller.close();
      },
    }),
    bodyUsed: false,
    arrayBuffer: async () => value.bytes.slice().buffer,
    text: async () => new TextDecoder().decode(value.bytes),
    json: async () => JSON.parse(new TextDecoder().decode(value.bytes)) as unknown,
    blob: async () => new Blob([value.bytes]),
    writeHttpMetadata(headers: Headers) {
      if (value.httpMetadata?.contentType)
        headers.set('content-type', value.httpMetadata.contentType);
    },
  };
}

function bucket(initial: Record<string, StoredObject> = {}) {
  const values = new Map<string, StoredObject>(Object.entries(initial));
  return {
    values,
    head: vi.fn(async (key: string) => {
      const value = values.get(key);
      return value ? objectBody(key, value) : null;
    }),
    get: vi.fn(async (key: string, options?: R2GetOptions) => {
      const value = values.get(key);
      if (!value) return null;
      const range = options?.range;
      if (!range || !('offset' in range)) return objectBody(key, value);
      const offset = range.offset ?? 0;
      const length = range.length ?? value.bytes.length - offset;
      return objectBody(key, { ...value, bytes: value.bytes.slice(offset, offset + length) });
    }),
    put: vi.fn(async (key: string, body: string | Uint8Array) => {
      const bytes =
        typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
      values.set(key, {
        bytes,
        etag: `etag-${values.size + 1}`,
        version: `version-${values.size + 1}`,
        httpMetadata: { contentType: 'application/json' },
      });
      return objectBody(key, values.get(key)!);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      truncated: false,
    })),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    }),
  };
}

function context(): AdapterContext {
  return {
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
  } as AdapterContext;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('tenant backup R2 object snapshot port', () => {
  it('pins and decrypts an object artifact before adding chunks to the portable bundle', async () => {
    const rootKey = '12'.repeat(32);
    const objectKey = 'details/tenant-a/a.json';
    const envelope = await encryptObjectArtifact('{"secret":"portable"}', {
      rootKeyHex: rootKey,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 4,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey,
        objectClass: 'admin_audit_detail',
      },
    });
    const stored = new TextEncoder().encode(JSON.stringify(envelope));
    const source = bucket({
      [objectKey]: {
        bytes: stored,
        etag: 'source-etag',
        version: 'source-version',
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { owner: 'tenant-a' },
      },
    });
    const staging = bucket();
    const assertSource = vi.fn(async () => {});
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        SENSITIVE_DETAILS: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: staging as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: rootKey,
        OBJECT_ENCRYPTION_KEY_VERSION: '8',
      },
      assertSource,
      list: async (_context, datasetId) =>
        datasetId === 'artifacts.object_catalog_bodies'
          ? [
              {
                datasetId,
                objectId: 'core:physical-a',
                bucketBinding: 'SENSITIVE_DETAILS',
                objectKey,
                expectedStoredSha256: await digest(stored),
                sourceEncoding: 'object_artifact_v1',
                context: {
                  tenantId: 'tenant-a',
                  objectClass: 'admin_audit_detail',
                  catalogId: 'catalog-a',
                },
              } as const,
            ]
          : [],
    });
    const input = context();

    await ports.artifactObjects.start(input, 'snapshot-a', async () => {});
    const record = await ports.artifactObjects.readNext(
      input,
      'snapshot-a',
      null,
      input.context.signal
    );
    const decoded = await decodePortableR2ObjectChunk(
      new TextDecoder().decode(record?.bytes).trimEnd(),
      'tenant-a'
    );

    expect(new TextDecoder().decode(decoded.bytes)).toBe('{"secret":"portable"}');
    expect(decoded.objectSha256).toBe(await digest(decoded.bytes));
    expect(decoded.httpMetadata).toEqual({ contentType: 'application/json' });
    expect(decoded.customMetadata).toEqual({ owner: 'tenant-a' });
    expect(source.get).toHaveBeenCalledWith(objectKey, {
      onlyIf: { etagMatches: 'source-etag' },
    });
    expect(assertSource).toHaveBeenCalledTimes(2);
  });

  it('stops when a source object changes while it is captured', async () => {
    const bytes = new TextEncoder().encode('body');
    const source = bucket({
      'imports/tenant-a/a.csv': {
        bytes,
        etag: 'source-etag',
        version: 'source-version',
      },
    });
    source.head
      .mockResolvedValueOnce(
        objectBody('imports/tenant-a/a.csv', source.values.values().next().value!)
      )
      .mockResolvedValueOnce(
        objectBody('imports/tenant-a/a.csv', {
          ...source.values.values().next().value!,
          etag: 'changed-etag',
        })
      );
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        IMPORT_ARTIFACTS: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '34'.repeat(32),
      },
      assertSource: async () => {},
      list: async (_context, datasetId) => [
        {
          datasetId,
          objectId: 'admin:physical-a',
          bucketBinding: 'IMPORT_ARTIFACTS',
          objectKey: 'imports/tenant-a/a.csv',
          sourceEncoding: 'plaintext',
          context: { tenantId: 'tenant-a', catalogId: 'catalog-a' },
        },
      ],
    });

    await expect(
      ports.artifactObjects.start(context(), 'snapshot-b', async () => {})
    ).rejects.toThrow('backup_r2_object_snapshot_invalid');
  });

  it('reads a large plaintext artifact as fixed-size ranges', async () => {
    const bytes = new Uint8Array(TENANT_BACKUP_R2_CHUNK_BYTES + 3);
    bytes.fill(7);
    const objectKey = 'imports/tenant-a/large.csv';
    const source = bucket({
      [objectKey]: {
        bytes,
        etag: 'large-etag',
        version: 'large-version',
      },
    });
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        IMPORT_ARTIFACTS: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '56'.repeat(32),
      },
      assertSource: async () => {},
      list: async (_context, datasetId) => [
        {
          datasetId,
          objectId: 'core:large',
          bucketBinding: 'IMPORT_ARTIFACTS',
          objectKey,
          sourceEncoding: 'plaintext',
          context: { tenantId: 'tenant-a', catalogId: 'catalog-large' },
        },
      ],
    });
    const input = context();

    await ports.artifactObjects.start(input, 'snapshot-large', async () => {});
    const first = await ports.artifactObjects.readNext(
      input,
      'snapshot-large',
      null,
      input.context.signal
    );
    const second = await ports.artifactObjects.readNext(
      input,
      'snapshot-large',
      first?.nextCursor ?? null,
      input.context.signal
    );
    const firstChunk = await decodePortableR2ObjectChunk(
      new TextDecoder().decode(first?.bytes).trimEnd(),
      'tenant-a'
    );
    const secondChunk = await decodePortableR2ObjectChunk(
      new TextDecoder().decode(second?.bytes).trimEnd(),
      'tenant-a'
    );

    expect(firstChunk.bytes).toHaveLength(TENANT_BACKUP_R2_CHUNK_BYTES);
    expect(secondChunk.bytes).toHaveLength(3);
    expect(firstChunk.objectSha256).toBe(secondChunk.objectSha256);
    expect(source.get).toHaveBeenCalledWith(objectKey, {
      range: { offset: TENANT_BACKUP_R2_CHUNK_BYTES, length: 3 },
      onlyIf: { etagMatches: 'large-etag' },
    });
  });
});
