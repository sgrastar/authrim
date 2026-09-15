import { describe, expect, it, vi } from 'vitest';
import { encryptObjectArtifact } from '@authrim/ar-lib-core/services/object-artifact-crypto';
import { decodePortableLogChunkRecords } from '@authrim/ar-lib-core/services/tenant-portability/portable-log-chunk';
import { decodePortableSensitiveDetailRecord } from '@authrim/ar-lib-core/services/tenant-portability/portable-sensitive-detail';
import {
  decodePortableR2ObjectChunk,
  TENANT_BACKUP_R2_CHUNK_BYTES,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import { PORTABLE_TENANT_KEY } from '@authrim/ar-lib-core/services/tenant-portability/portable-tenant-key';
import {
  encodeLogRecordBlocks,
  encryptLogChunkBody,
  deriveLogChunkEncryptionKey,
} from '@authrim/ar-lib-logging/chunks';
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
    boundaryUnixMs: 100,
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
    snapshotResources: {
      loadCapture: vi.fn(async (_lease: unknown, resourceId: string) => ({
        resourceId,
        snapshotId: `sql-snapshot:${resourceId}`,
      })),
    },
    databases: {
      tenant: [
        {
          databaseId: 'core-a',
          database: {
            queryOne: vi.fn(async () => ({ id: 'sql-snapshot:core-a' })),
          },
        },
      ],
      fixed: [
        {
          family: 'admin',
          databaseId: 'admin-a',
          database: {
            queryOne: vi.fn(async () => ({ id: 'sql-snapshot:admin-a' })),
          },
        },
      ],
    },
  } as unknown as AdapterContext;
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
                  catalogKind: 'object_catalog_object',
                  sourceFamily: 'core',
                  sourceDatabaseId: 'core-a',
                  sourceRowId: 'physical-a',
                  objectClass: 'admin_audit_detail',
                  catalogId: 'catalog-a',
                  contentType: 'application/json',
                },
              } as const,
            ]
          : [],
    });
    const input = context();

    await ports.artifactObjects.start(input, 'snapshot-a', async () => {}, 100);
    expect(source.head).not.toHaveBeenCalled();
    expect(source.get).not.toHaveBeenCalled();
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
    await expect(ports.artifactObjects.readSummaries(input, 'snapshot-a', 100)).resolves.toEqual([
      {
        kind: 'object',
        family: 'core',
        databaseId: 'core-a',
        rowId: 'physical-a',
        catalogId: 'catalog-a',
      },
    ]);

    expect(new TextDecoder().decode(decoded.bytes)).toBe('{"secret":"portable"}');
    expect(decoded.objectSha256).toBe(await digest(decoded.bytes));
    expect(decoded.httpMetadata).toEqual({ contentType: 'application/json' });
    expect(decoded.customMetadata).toEqual({ owner: 'tenant-a' });
    expect(source.get).toHaveBeenCalledWith(objectKey, {
      onlyIf: { etagMatches: 'source-etag' },
    });
    expect(assertSource).toHaveBeenCalledTimes(4);
  });

  it('decrypts a held logging payload with its opaque tenant key and verifies plaintext', async () => {
    const rootKey = '23'.repeat(32);
    const tenantKey = 'tenant-key-a';
    const objectKey = 'message-jobs/tenant-key-a/job-a.json';
    const plaintext = '{"type":"retry_delivery"}';
    const envelope = await encryptObjectArtifact(plaintext, {
      rootKeyHex: rootKey,
      plane: 'AUDIT_ARCHIVE',
      keyVersion: 4,
      contentType: 'application/json',
      context: { tenantId: tenantKey, objectKey, objectClass: 'operational_log_detail' },
    });
    const stored = new TextEncoder().encode(JSON.stringify(envelope));
    const source = bucket({
      [objectKey]: {
        bytes: stored,
        etag: 'hold-etag',
        version: 'hold-version',
        customMetadata: {
          tenantKey,
          encryptionTenantContext: tenantKey,
        },
      },
    });
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        AUDIT_ARCHIVE: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: rootKey,
      },
      assertSource: async () => {},
      list: async (_context, datasetId) => [
        {
          datasetId,
          objectId: 'admin:admin-a:held-message.job-a',
          bucketBinding: 'AUDIT_ARCHIVE',
          objectKey,
          sourceEncoding: 'object_artifact_v1',
          context: {
            tenantId: 'tenant-a',
            catalogKind: 'restore_hold_payload',
            sourceFamily: 'admin',
            sourceDatabaseId: 'admin-a',
            sourceRowId: 'held-message.job-a',
            objectClass: 'operational_log_detail',
            encryptionTenantContext: tenantKey,
            holdDatasetId: 'admin.logging_message_jobs',
            holdRecordId: '[["text","job-a"]]',
            sourceField: 'payload_object_ref',
            expectedPlaintextSha256: await digest(new TextEncoder().encode(plaintext)),
          },
        },
      ],
    });
    const input = context();

    await ports.logArchiveObjects.start(input, 'snapshot-hold', async () => {}, 100);
    const record = await ports.logArchiveObjects.readNext(
      input,
      'snapshot-hold',
      null,
      input.context.signal
    );
    const decoded = await decodePortableR2ObjectChunk(
      new TextDecoder().decode(record?.bytes).trimEnd(),
      'tenant-a'
    );

    expect(new TextDecoder().decode(decoded.bytes)).toBe(plaintext);
    expect(decoded.context.encryptionTenantContext).toBe(PORTABLE_TENANT_KEY);
    expect(decoded.customMetadata).toMatchObject({
      tenantKey: PORTABLE_TENANT_KEY,
      encryptionTenantContext: PORTABLE_TENANT_KEY,
    });
    expect(JSON.stringify(decoded.context)).not.toContain(tenantKey);
    await expect(
      ports.logArchiveObjects.readSummaries(input, 'snapshot-hold', 100)
    ).resolves.toEqual([
      {
        kind: 'hold',
        family: 'admin',
        databaseId: 'admin-a',
        rowId: 'held-message.job-a',
        holdDatasetId: 'admin.logging_message_jobs',
      },
    ]);
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
          expectedStoredSha256: await digest(bytes),
          sourceEncoding: 'plaintext',
          context: {
            tenantId: 'tenant-a',
            catalogKind: 'object_catalog_object',
            sourceFamily: 'core',
            sourceDatabaseId: 'core-a',
            sourceRowId: 'physical-a',
            catalogId: 'catalog-a',
          },
        },
      ],
    });

    const input = context();
    await ports.artifactObjects.start(input, 'snapshot-b', async () => {}, 100);
    await expect(
      ports.artifactObjects.readNext(input, 'snapshot-b', null, input.context.signal)
    ).rejects.toThrow('backup_r2_object_snapshot_invalid');
  });

  it('refuses to materialize after its exact SQL snapshot is released', async () => {
    const bytes = new TextEncoder().encode('body');
    const source = bucket({
      'imports/tenant-a/a.csv': {
        bytes,
        etag: 'source-etag',
        version: 'source-version',
      },
    });
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        IMPORT_ARTIFACTS: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '45'.repeat(32),
      },
      assertSource: async () => {},
      list: async (_context, datasetId) => [
        {
          datasetId,
          objectId: 'core:physical-a',
          bucketBinding: 'IMPORT_ARTIFACTS',
          objectKey: 'imports/tenant-a/a.csv',
          expectedStoredSha256: await digest(bytes),
          sourceEncoding: 'plaintext',
          context: {
            tenantId: 'tenant-a',
            catalogKind: 'object_catalog_object',
            sourceFamily: 'core',
            sourceDatabaseId: 'core-a',
            sourceRowId: 'physical-a',
            catalogId: 'catalog-a',
          },
        },
      ],
    });
    const input = context();
    input.databases.tenant[0]!.database.queryOne = vi.fn(async () => null);

    await ports.artifactObjects.start(input, 'snapshot-released', async () => {}, 100);
    await expect(
      ports.artifactObjects.readNext(input, 'snapshot-released', null, input.context.signal)
    ).rejects.toThrow('backup_r2_object_snapshot_invalid');
    expect(source.head).not.toHaveBeenCalled();
    expect(source.get).not.toHaveBeenCalled();
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
          expectedStoredSha256: await digest(bytes),
          sourceEncoding: 'plaintext',
          context: {
            tenantId: 'tenant-a',
            catalogKind: 'object_catalog_object',
            sourceFamily: 'core',
            sourceDatabaseId: 'core-a',
            sourceRowId: 'physical-a',
            catalogId: 'catalog-large',
          },
        },
      ],
    });
    const input = context();

    await ports.artifactObjects.start(input, 'snapshot-large', async () => {}, 100);
    const first = await ports.artifactObjects.readNext(
      input,
      'snapshot-large',
      null,
      input.context.signal
    );
    const sourceReadsAfterMaterialization = source.get.mock.calls.length;
    source.values.delete(objectKey);
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
    expect(source.get).toHaveBeenCalledTimes(sourceReadsAfterMaterialization);
    expect(source.get).toHaveBeenCalledWith(objectKey, {
      range: { offset: TENANT_BACKUP_R2_CHUNK_BYTES, length: 3 },
      onlyIf: { etagMatches: 'large-etag' },
    });
  });

  it('repackages only selected records from a log chunk that crosses the time window', async () => {
    const rootKey = '78'.repeat(32);
    const objectKey = 'logs/tenant-a/crossing';
    const encoded = await encodeLogRecordBlocks(
      [
        { id: 'record-old', eventAt: 2, payload: { secret: 'outside' } },
        { id: 'record-kept', eventAt: 4, payload: { audit: 'inside' } },
      ],
      { compression: 'none' }
    );
    const keyBytes = await deriveLogChunkEncryptionKey({
      rootKeyHex: rootKey,
      tenantKey: 'tenant-key-a',
      logType: 'audit',
      plane: 'archive',
      keyVersion: 2,
    });
    const stored = await encryptLogChunkBody(encoded.body, {
      keyBytes,
      tenantKey: 'tenant-key-a',
      logType: 'audit',
      plane: 'archive',
      objectKey,
      chunkId: 'chunk-a',
      compression: 'none',
      encryptionScope: 'tenant-log-archive',
      keyVersion: 2,
    });
    const source = bucket({
      [objectKey]: {
        bytes: stored,
        etag: 'log-etag',
        version: 'log-version',
        customMetadata: { tenantKey: 'tenant-key-a' },
      },
    });
    const input = context();
    input.databases = {
      tenant: [
        {
          databaseId: 'core-a',
          database: {
            queryOne: vi.fn(async () => ({ id: 'sql-snapshot:core-a' })),
            query: vi.fn(async () => {
              const location = encoded.records[1]!;
              const block = encoded.blocks[location.blockIndex]!;
              return [
                {
                  record_id: 'record-kept',
                  surface: 'auth',
                  line_number: location.lineNumber,
                  block_offset: block.compressedOffset,
                  block_length: block.compressedLength,
                  record_offset: location.recordOffset,
                  record_length: location.recordLength,
                  event_at: 4,
                  index_profile: 'audit',
                  indexed_fields: '{"result":"allowed"}',
                  created_at: 4,
                },
              ];
            }),
          },
        },
      ],
      fixed: [],
    } as unknown as AdapterContext['databases'];
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        AUDIT_ARCHIVE: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: rootKey,
      },
      assertSource: async () => {},
      list: async (_context, datasetId) => [
        {
          datasetId,
          objectId: 'core:log-a',
          bucketBinding: 'AUDIT_ARCHIVE',
          objectKey,
          expectedStoredSha256: await digest(stored),
          sourceEncoding: 'log_chunk_records_v1',
          context: {
            tenantId: 'tenant-a',
            catalogKind: 'log_object',
            sourceRowId: 'log-a',
            sourceDatabaseId: 'core-a',
            sourceFamily: 'core',
            tenantKey: 'tenant-key-a',
            logType: 'audit',
            plane: 'archive',
            chunkId: 'chunk-a',
            compression: 'none',
            windowFromInclusiveUnixMs: 3,
            windowUntilInclusiveUnixMs: 10,
            sourceEncrypted: true,
            targetEncryptionScope: 'tenant-log-archive',
            encryptionScope: 'tenant-log-archive',
            keyVersion: 2,
          },
        },
      ],
    });

    await ports.logArchiveObjects.start(input, 'snapshot-log', async () => {}, 100);
    const record = await ports.logArchiveObjects.readNext(
      input,
      'snapshot-log',
      null,
      input.context.signal
    );
    const portableObject = await decodePortableR2ObjectChunk(
      new TextDecoder().decode(record?.bytes).trimEnd(),
      'tenant-a'
    );
    const portableLog = decodePortableLogChunkRecords(portableObject.bytes);

    expect(portableObject.context.tenantKey).toBe(PORTABLE_TENANT_KEY);
    expect(portableObject.customMetadata?.tenantKey).toBe(PORTABLE_TENANT_KEY);
    expect(JSON.stringify(portableObject.context)).not.toContain('tenant-key-a');
    expect(portableLog.records).toEqual([
      {
        recordId: 'record-kept',
        eventAt: 4,
        surface: 'auth',
        indexProfile: 'audit',
        indexedFields: '{"result":"allowed"}',
        createdAt: 4,
        payload: { audit: 'inside' },
      },
    ]);
    expect(new TextDecoder().decode(portableObject.bytes)).not.toContain('outside');
  });

  it('extracts and decrypts only one record from a shared gzip sensitive-detail body', async () => {
    const rootKey = '89'.repeat(32);
    const objectKey = 'details/tenant-a/shared';
    const first = await encryptObjectArtifact('{"outside":true}', {
      rootKeyHex: rootKey,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 3,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey,
        objectClass: 'pii_log_values',
      },
    });
    const second = await encryptObjectArtifact('{"selected":true}', {
      rootKeyHex: rootKey,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 3,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey,
        objectClass: 'pii_log_values',
      },
    });
    const plaintext = new TextEncoder().encode(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`
    );
    const compressed = new Uint8Array(
      await new Response(
        new Blob([plaintext]).stream().pipeThrough(new CompressionStream('gzip'))
      ).arrayBuffer()
    );
    const source = bucket({
      [objectKey]: {
        bytes: compressed,
        etag: 'detail-etag',
        version: 'detail-version',
      },
    });
    const staging = bucket();
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        SENSITIVE_DETAILS: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: staging as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: rootKey,
      },
      assertSource: async () => {},
      list: async (_context, datasetId) => [
        {
          datasetId,
          objectId: 'core:detail-a',
          bucketBinding: 'SENSITIVE_DETAILS',
          objectKey,
          expectedStoredSha256: await digest(compressed),
          sourceEncoding: 'sensitive_detail_record_v1',
          context: {
            tenantId: 'tenant-a',
            catalogKind: 'object_catalog_object',
            sourceFamily: 'core',
            sourceDatabaseId: 'core-a',
            sourceRowId: 'physical-detail',
            catalogId: 'catalog-a',
            objectClass: 'pii_log_values',
            contentEncoding: 'gzip',
            lineNumber: 1,
            byteOffset: null,
            byteLength: null,
            sourceKeyVersion: 3,
          },
        },
      ],
    });
    const input = context();

    await ports.artifactObjects.start(input, 'snapshot-detail', async () => {}, 100);
    const record = await ports.artifactObjects.readNext(
      input,
      'snapshot-detail',
      null,
      input.context.signal
    );
    const portableObject = await decodePortableR2ObjectChunk(
      new TextDecoder().decode(record?.bytes).trimEnd(),
      'tenant-a'
    );

    expect(decodePortableSensitiveDetailRecord(portableObject.bytes)).toEqual({
      version: 1,
      contentType: 'application/json',
      plaintext: '{"selected":true}',
    });
    expect(new TextDecoder().decode(portableObject.bytes)).not.toContain('outside');
  });

  it('rejects a sensitive-detail byte range that points at a different line', async () => {
    const rootKey = '90'.repeat(32);
    const objectKey = 'details/tenant-a/shared-none';
    const first = await encryptObjectArtifact('{"first":true}', {
      rootKeyHex: rootKey,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 3,
      contentType: 'application/json',
      context: { tenantId: 'tenant-a', objectKey, objectClass: 'pii_log_values' },
    });
    const second = await encryptObjectArtifact('{"second":true}', {
      rootKeyHex: rootKey,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 3,
      contentType: 'application/json',
      context: { tenantId: 'tenant-a', objectKey, objectClass: 'pii_log_values' },
    });
    const firstLine = JSON.stringify(first);
    const body = new TextEncoder().encode(`${firstLine}\n${JSON.stringify(second)}\n`);
    const source = bucket({
      [objectKey]: { bytes: body, etag: 'detail-etag', version: 'detail-version' },
    });
    const ports = createTenantBackupR2ObjectSnapshotPorts({
      env: {
        SENSITIVE_DETAILS: source as unknown as R2Bucket,
        EXPORT_ARTIFACTS: bucket() as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: rootKey,
      },
      assertSource: async () => {},
      list: async (_context, datasetId) => [
        {
          datasetId,
          objectId: 'core:detail-a',
          bucketBinding: 'SENSITIVE_DETAILS',
          objectKey,
          expectedStoredSha256: await digest(body),
          sourceEncoding: 'sensitive_detail_record_v1',
          context: {
            tenantId: 'tenant-a',
            catalogKind: 'object_catalog_object',
            sourceFamily: 'core',
            sourceDatabaseId: 'core-a',
            sourceRowId: 'physical-detail',
            catalogId: 'catalog-a',
            objectClass: 'pii_log_values',
            contentEncoding: 'none',
            lineNumber: 1,
            byteOffset: 0,
            byteLength: new TextEncoder().encode(firstLine).length,
            sourceKeyVersion: 3,
          },
        },
      ],
    });

    const input = context();
    await ports.artifactObjects.start(input, 'snapshot-detail-range', async () => {}, 100);
    await expect(
      ports.artifactObjects.readNext(input, 'snapshot-detail-range', null, input.context.signal)
    ).rejects.toThrow('backup_r2_object_snapshot_invalid');
  });
});
