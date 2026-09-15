import { readFileSync } from 'node:fs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import { decryptObjectArtifact } from '@authrim/ar-lib-core/services/object-artifact-crypto';
import { decryptLogChunkBody, deriveLogChunkEncryptionKey } from '@authrim/ar-lib-logging/chunks';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { PortableR2ObjectChunk } from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import {
  createTenantBackupR2ObjectRestorePorts,
  type TenantBackupR2ObjectFinalizer,
} from '../tenant-backup-r2-object-restore-port';

type SqlInputValue = string | number | bigint | null | Uint8Array;

interface SavedObject {
  bytes: Uint8Array;
  etag: string;
  version: string;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
}

interface SavedOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

class MemoryR2Bucket {
  readonly objects = new Map<string, SavedObject>();
  readonly deleted: string[] = [];
  private readonly uploads = new Map<
    string,
    { key: string; options: SavedOptions; parts: Map<number, Uint8Array> }
  >();
  private revision = 0;

  private object(key: string, saved: SavedObject): R2ObjectBody {
    const bytes = new Uint8Array(saved.bytes);
    return {
      key,
      version: saved.version,
      size: bytes.length,
      etag: saved.etag,
      httpEtag: `"${saved.etag}"`,
      uploaded: new Date(0),
      checksums: {},
      httpMetadata: saved.httpMetadata,
      customMetadata: saved.customMetadata,
      range: undefined,
      storageClass: 'Standard',
      ssecKeyMd5: undefined,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      bodyUsed: false,
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
      blob: async () => new Blob([bytes]),
      writeHttpMetadata(headers: Headers) {
        if (saved.httpMetadata.contentType)
          headers.set('content-type', saved.httpMetadata.contentType);
      },
    } as unknown as R2ObjectBody;
  }

  async put(key: string, value: Uint8Array | string, options: SavedOptions = {}) {
    const bytes =
      typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.revision += 1;
    const saved = {
      bytes,
      etag: `etag-${this.revision}`,
      version: `version-${this.revision}`,
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    };
    this.objects.set(key, saved);
    return this.object(key, saved);
  }

  async head(key: string) {
    const saved = this.objects.get(key);
    return saved ? this.object(key, saved) : null;
  }

  async get(key: string) {
    return this.head(key);
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
      this.deleted.push(key);
    }
  }

  async createMultipartUpload(key: string, options: SavedOptions = {}) {
    const uploadId = `upload-${this.uploads.size + 1}`;
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return {
      uploadId,
      abort: async () => {
        this.uploads.delete(uploadId);
      },
    };
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error('missing_upload');
    return {
      uploadPart: async (partNumber: number, bytes: Uint8Array) => {
        upload.parts.set(partNumber, new Uint8Array(bytes));
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const length = parts.reduce(
          (sum, part) => sum + (upload.parts.get(part.partNumber)?.length ?? 0),
          0
        );
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
          if (part.etag !== `part-${part.partNumber}`) throw new Error('bad_part');
          const value = upload.parts.get(part.partNumber);
          if (!value) throw new Error('missing_part');
          bytes.set(value, offset);
          offset += value.length;
        }
        this.uploads.delete(uploadId);
        return this.put(key, bytes, upload.options);
      },
    };
  }
}

let database: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
let target: MemoryR2Bucket;
let finalizer: TenantBackupR2ObjectFinalizer;
let now: number;
const planDigest = 'f'.repeat(64);

function migration(name: string): string {
  return readFileSync(new URL(`../../../../migrations/admin/d1/${name}`, import.meta.url), 'utf8');
}

function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', bytes)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    );
}

function context(): TenantBackupStepContext {
  return {
    operation: {
      id: 'operation-a',
      tenant_id: 'tenant-a',
      kind: 'import',
      idempotency_key: 'request-a',
      request_digest: 'a'.repeat(64),
      state: 'running',
      phase: 'restore_other_stores',
      cursor_json: null,
      created_by: 'admin-a',
      created_at: 100,
      updated_at: 100,
      revision: 0,
      fencing_token: 1,
      lease_owner: 'worker-a',
      lease_expires_at: 1000,
      next_attempt_at: 0,
      failure_count: 0,
      last_error_code: null,
    },
    lease: {
      operationId: 'operation-a',
      tenantId: 'tenant-a',
      owner: 'worker-a',
      fencingToken: 1,
    },
    signal: new AbortController().signal,
  };
}

async function chunk(
  bytes: Uint8Array,
  input: Partial<PortableR2ObjectChunk> = {}
): Promise<PortableR2ObjectChunk> {
  const digest = await sha256(bytes);
  return {
    tenantId: 'tenant-a',
    objectId: 'core:object-a',
    bucketBinding: 'IMPORT_ARTIFACTS',
    objectKey: 'source/object-a',
    sourceEncoding: 'plaintext',
    objectSha256: digest,
    totalBytes: bytes.length,
    chunkIndex: 0,
    chunkCount: 1,
    chunkSha256: digest,
    bytes,
    context: { tenantId: 'tenant-a', catalogKind: 'object_catalog_object' },
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: null,
    ...input,
  };
}

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  for (const name of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '031_tenant_backup_r2_restores.sql',
  ])
    database.exec(migration(name));
  database
    .prepare(
      `INSERT INTO tenant_backup_operations(
        id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,
        created_at,updated_at,fencing_token,lease_owner,lease_expires_at
      ) VALUES (?,?,?,?,?,'running','restore_other_stores','admin-a',100,100,1,'worker-a',1000)`
    )
    .run('operation-a', 'tenant-a', 'import', 'request-a', 'b'.repeat(64));
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SqlInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (database.prepare(sql).get(...(params as SqlInputValue[])) as T | undefined) ?? null;
    },
  };
  target = new MemoryR2Bucket();
  finalizer = {
    finalize: vi.fn(async () => {}),
    verify: vi.fn(async () => true),
  };
  now = 101;
});

afterEach(() => database.close());

describe('tenant backup R2 object restore port', () => {
  it('uploads plaintext with multipart, verifies the target and finalizes its new key', async () => {
    const source = await chunk(new TextEncoder().encode('portable body'));
    const ports = createTenantBackupR2ObjectRestorePorts({
      env: {
        IMPORT_ARTIFACTS: target as unknown as R2Bucket,
        EXPORT_ARTIFACTS: target as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '11'.repeat(32),
        OBJECT_ENCRYPTION_KEY_VERSION: '7',
      },
      database: adapter,
      finalizer,
      now: () => now++,
    });

    await ports.importR2Chunk(context(), planDigest, 'artifacts.object_catalog_bodies', source);
    const expectedKey = 'tenant-restores/tenant-a/operation-a/artifacts/core:object-a';
    expect(target.objects.get(expectedKey)?.bytes).toEqual(source.bytes);
    expect(finalizer.finalize).toHaveBeenCalledWith(
      expect.anything(),
      planDigest,
      'artifacts.object_catalog_bodies',
      source,
      expect.objectContaining({
        objectKey: expectedKey,
        storedSha256: source.objectSha256,
        keyVersion: null,
      })
    );
    await expect(
      ports.verifyR2Chunk(context(), planDigest, 'artifacts.object_catalog_bodies', source)
    ).resolves.toBe(true);
  });

  it('stages encrypted artifacts, re-encrypts for the target key and removes staging', async () => {
    const plaintext = new TextEncoder().encode('{"portable":true}');
    const source = await chunk(plaintext, {
      bucketBinding: 'EXPORT_ARTIFACTS',
      sourceEncoding: 'object_artifact_v1',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'object_catalog_object',
        objectClass: 'user_export',
        contentType: 'application/json',
      },
      customMetadata: { checksumSha256: 'source-sha', keyVersion: '1' },
    });
    const ports = createTenantBackupR2ObjectRestorePorts({
      env: {
        EXPORT_ARTIFACTS: target as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
        OBJECT_ENCRYPTION_KEY_VERSION: '9',
      },
      database: adapter,
      finalizer,
      now: () => now++,
    });

    await ports.importR2Chunk(context(), planDigest, 'artifacts.object_catalog_bodies', source);
    const expectedKey = 'tenant-restores/tenant-a/operation-a/artifacts/core:object-a';
    const saved = target.objects.get(expectedKey);
    expect(saved).toBeDefined();
    expect(saved?.customMetadata.keyVersion).toBe('9');
    expect(saved?.customMetadata.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    const envelope = JSON.parse(new TextDecoder().decode(saved?.bytes)) as Parameters<
      typeof decryptObjectArtifact
    >[0];
    await expect(
      decryptObjectArtifact(envelope, {
        rootKeyHex: '22'.repeat(32),
        context: {
          tenantId: 'tenant-a',
          objectKey: expectedKey,
          objectClass: 'user_export',
        },
      })
    ).resolves.toBe('{"portable":true}');
    expect(target.deleted).toEqual([
      'tenant-restore-staging/tenant-a/operation-a/artifacts/core:object-a/0',
    ]);
    expect(finalizer.finalize).toHaveBeenCalledWith(
      expect.anything(),
      planDigest,
      'artifacts.object_catalog_bodies',
      source,
      expect.objectContaining({ objectKey: expectedKey, keyVersion: 9 })
    );
  });

  it('fails closed after the operation lease is fenced', async () => {
    const source = await chunk(new TextEncoder().encode('portable body'));
    const ports = createTenantBackupR2ObjectRestorePorts({
      env: {
        IMPORT_ARTIFACTS: target as unknown as R2Bucket,
        EXPORT_ARTIFACTS: target as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '33'.repeat(32),
      },
      database: adapter,
      finalizer,
      now: () => now++,
    });
    database
      .prepare(
        "UPDATE tenant_backup_operations SET fencing_token=2,lease_owner='worker-b',updated_at=101"
      )
      .run();

    await expect(
      ports.importR2Chunk(context(), planDigest, 'artifacts.object_catalog_bodies', source)
    ).rejects.toThrow('backup_r2_restore_store_invalid');
    expect(target.objects.size).toBe(0);
    expect(finalizer.finalize).not.toHaveBeenCalled();
  });

  it('re-encrypts selected audit log chunks with the target key version and object key', async () => {
    const plaintext = new TextEncoder().encode('{"audit":true}\n');
    const source = await chunk(plaintext, {
      objectId: 'admin:log-object-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      sourceEncoding: 'log_chunk_v1',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'log_object',
        tenantKey: 'tenant-a',
        logType: 'admin_audit',
        plane: 'archive',
        chunkId: 'chunk-a',
        compression: 'none',
        encryptionScope: 'tenant-log-archive',
        keyVersion: 2,
      },
      customMetadata: { checksumSha256: 'source-sha', keyVersion: '2' },
    });
    const ports = createTenantBackupR2ObjectRestorePorts({
      env: {
        AUDIT_ARCHIVE: target as unknown as R2Bucket,
        EXPORT_ARTIFACTS: target as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '44'.repeat(32),
        OBJECT_ENCRYPTION_KEY_VERSION: '5',
      },
      database: adapter,
      finalizer,
      now: () => now++,
    });

    await ports.importR2Chunk(context(), planDigest, 'logs.archive_object_bodies', source);
    const expectedKey = 'tenant-restores/tenant-a/operation-a/logs/admin:log-object-a';
    const saved = target.objects.get(expectedKey);
    const keyBytes = await deriveLogChunkEncryptionKey({
      rootKeyHex: '44'.repeat(32),
      tenantKey: 'tenant-a',
      logType: 'admin_audit',
      plane: 'archive',
      keyVersion: 5,
    });
    const decoded = await decryptLogChunkBody({
      storedBody: saved?.bytes ?? new Uint8Array(),
      keyBytes,
      tenantKey: 'tenant-a',
      logType: 'admin_audit',
      plane: 'archive',
      objectKey: expectedKey,
      chunkId: 'chunk-a',
      expectedEncryptionScope: 'tenant-log-archive',
      expectedKeyVersion: 5,
    });
    expect(decoded.body).toEqual(plaintext);
    expect(saved?.httpMetadata.contentType).toBe('application/authrim.log-chunk+encrypted');
    expect(saved?.customMetadata).toMatchObject({
      keyVersion: '5',
      encryptionScope: 'tenant-log-archive',
    });
    expect(finalizer.finalize).toHaveBeenCalledWith(
      expect.anything(),
      planDigest,
      'logs.archive_object_bodies',
      source,
      expect.objectContaining({ keyVersion: 5, encryptionScope: 'tenant-log-archive' })
    );
  });
});
