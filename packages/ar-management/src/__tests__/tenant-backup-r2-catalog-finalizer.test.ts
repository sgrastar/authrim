// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { PortableR2ObjectChunk } from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import type { RestoredTenantR2Object } from '../tenant-backup-r2-object-restore-port';
import { createTenantBackupR2CatalogFinalizer } from '../tenant-backup-r2-catalog-finalizer';

type SqlInputValue = string | number | bigint | null | Uint8Array;
const planDigest = 'a'.repeat(64);
let database: DatabaseSync;
let query: Pick<DatabaseAdapter, 'query'>;

function context(): TenantBackupStepContext {
  return {
    lease: {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker-a',
      fencingToken: 1,
    },
    signal: new AbortController().signal,
  } as TenantBackupStepContext;
}

function source(input: Partial<PortableR2ObjectChunk> = {}): PortableR2ObjectChunk {
  return {
    tenantId: 'tenant-a',
    objectId: 'core:physical-a',
    bucketBinding: 'SENSITIVE_DETAILS',
    objectKey: 'source/object-a',
    sourceEncoding: 'object_artifact_v1',
    objectSha256: 'b'.repeat(64),
    totalBytes: 12,
    chunkIndex: 0,
    chunkCount: 1,
    chunkSha256: 'b'.repeat(64),
    bytes: new Uint8Array(12),
    context: {
      tenantId: 'tenant-a',
      catalogKind: 'object_catalog_object',
      objectClass: 'admin_audit_detail',
    },
    httpMetadata: null,
    customMetadata: null,
    ...input,
  };
}

function restored(input: Partial<RestoredTenantR2Object> = {}): RestoredTenantR2Object {
  return {
    bucketBinding: 'SENSITIVE_DETAILS',
    objectKey: 'tenant-restores/tenant-a/operation-a/artifacts/core:physical-a',
    version: 'version-a',
    etag: 'etag-a',
    storedSha256: 'c'.repeat(64),
    storedBytes: 144,
    keyVersion: 8,
    encryptionScope: null,
    ...input,
  };
}

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE object_catalog(
      id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,deleted_at INTEGER
    );
    CREATE TABLE object_catalog_objects(
      id TEXT PRIMARY KEY NOT NULL,catalog_id TEXT NOT NULL,bucket_binding TEXT NOT NULL,
      object_key TEXT NOT NULL,key_version INTEGER NOT NULL,checksum_sha256 TEXT,
      total_bytes INTEGER,deleted_at INTEGER
    );
    CREATE TABLE log_object_catalog(
      id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL,object_key TEXT NOT NULL,
      byte_count INTEGER NOT NULL,checksum_sha256 TEXT,encryption_scope TEXT,
      key_version INTEGER,deleted_at INTEGER
    );
    CREATE TABLE log_chunk_manifests(
      id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL,manifest_object_key TEXT NOT NULL,
      checksum_sha256 TEXT
    );
    INSERT INTO object_catalog VALUES ('catalog-a','tenant-a',NULL);
    INSERT INTO object_catalog_objects VALUES (
      'physical-a','catalog-a','SENSITIVE_DETAILS','source/object-a',2,NULL,12,NULL
    );
    INSERT INTO log_object_catalog VALUES (
      'log-a','tenant-key-a','source/log-a',12,NULL,'source-scope',2,NULL
    );
    INSERT INTO log_chunk_manifests VALUES (
      'manifest-a','tenant-key-a','source/manifest-a',NULL
    );
  `);
  query = {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SqlInputValue[])) as T[];
    },
  };
});

afterEach(() => database.close());

describe('tenant backup R2 catalog finalizer', () => {
  it('retargets and verifies an object catalog physical row', async () => {
    const resolveCore = vi.fn(async () => query);
    const finalizer = createTenantBackupR2CatalogFinalizer({
      resolveCore,
      resolveAdmin: vi.fn(async () => query),
    });
    const sourceObject = source();
    const targetObject = restored();

    await finalizer.finalize(
      context(),
      planDigest,
      'artifacts.object_catalog_bodies',
      sourceObject,
      targetObject
    );
    await expect(
      finalizer.verify(
        context(),
        planDigest,
        'artifacts.object_catalog_bodies',
        sourceObject,
        targetObject
      )
    ).resolves.toBe(true);
    expect(resolveCore).toHaveBeenCalledWith(expect.anything(), planDigest);
    expect(
      database.prepare('SELECT * FROM object_catalog_objects WHERE id=?').get('physical-a')
    ).toMatchObject({
      object_key: targetObject.objectKey,
      key_version: 8,
      checksum_sha256: targetObject.storedSha256,
      total_bytes: 144,
    });
  });

  it('retargets encrypted log objects and plaintext manifests in Admin D1', async () => {
    const finalizer = createTenantBackupR2CatalogFinalizer({
      resolveCore: vi.fn(async () => query),
      resolveAdmin: vi.fn(async () => query),
    });
    const logSource = source({
      objectId: 'admin:log-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'source/log-a',
      sourceEncoding: 'log_chunk_v1',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'log_object',
        tenantKey: 'tenant-key-a',
      },
    });
    const logTarget = restored({
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'tenant-restores/tenant-a/operation-a/logs/admin:log-a',
      encryptionScope: 'target-scope',
    });
    await finalizer.finalize(
      context(),
      planDigest,
      'logs.archive_object_bodies',
      logSource,
      logTarget
    );
    await expect(
      finalizer.verify(context(), planDigest, 'logs.archive_object_bodies', logSource, logTarget)
    ).resolves.toBe(true);

    const manifestSource = source({
      objectId: 'admin:manifest-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'source/manifest-a',
      sourceEncoding: 'plaintext',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'log_manifest',
        tenantKey: 'tenant-key-a',
      },
    });
    const manifestTarget = restored({
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'tenant-restores/tenant-a/operation-a/logs/admin:manifest-a',
      storedBytes: 88,
      keyVersion: null,
    });
    await finalizer.finalize(
      context(),
      planDigest,
      'logs.archive_object_bodies',
      manifestSource,
      manifestTarget
    );
    await expect(
      finalizer.verify(
        context(),
        planDigest,
        'logs.archive_object_bodies',
        manifestSource,
        manifestTarget
      )
    ).resolves.toBe(true);
  });

  it('rejects a catalog row owned by another tenant', async () => {
    database.prepare("UPDATE object_catalog SET tenant_id='tenant-b'").run();
    const finalizer = createTenantBackupR2CatalogFinalizer({
      resolveCore: vi.fn(async () => query),
      resolveAdmin: vi.fn(async () => query),
    });
    await expect(
      finalizer.finalize(
        context(),
        planDigest,
        'artifacts.object_catalog_bodies',
        source(),
        restored()
      )
    ).rejects.toThrow('backup_r2_catalog_finalize_invalid');
  });
});
