import { readFileSync } from 'node:fs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { PortableR2ObjectChunk } from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import { PORTABLE_TENANT_KEY } from '@authrim/ar-lib-core/services/tenant-portability/portable-tenant-key';
import type { RestoredTenantR2Object } from '../tenant-backup-r2-object-restore-port';
import { createTenantBackupR2CatalogFinalizer } from '../tenant-backup-r2-catalog-finalizer';

type SqlInputValue = string | number | bigint | null | Uint8Array;
const planDigest = 'a'.repeat(64);
let database: DatabaseSync;
let query: Pick<DatabaseAdapter, 'query' | 'batch' | 'getType'>;

function migration(name: string): string {
  return readFileSync(new URL(`../../../../migrations/admin/d1/${name}`, import.meta.url), 'utf8');
}

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
    objectId: 'core:core-source:physical-a',
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

async function metadataDigest(input: {
  recordId: string;
  eventAt: number;
  surface: string | null;
  indexProfile: string;
  indexedFields: string | null;
  createdAt: number;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(input))
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  database.exec(`
    CREATE TABLE object_catalog(
      id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,deleted_at INTEGER
    );
    CREATE TABLE object_catalog_objects(
      id TEXT PRIMARY KEY NOT NULL,catalog_id TEXT NOT NULL,bucket_binding TEXT NOT NULL,
      object_key TEXT NOT NULL,key_version INTEGER NOT NULL,checksum_sha256 TEXT,
      total_bytes INTEGER,deleted_at INTEGER
    );
    CREATE TABLE sensitive_detail_chunk_index(
      catalog_id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,object_class TEXT NOT NULL,
      object_key TEXT NOT NULL,content_encoding TEXT NOT NULL,line_number INTEGER NOT NULL,
      byte_offset INTEGER,byte_length INTEGER,key_version INTEGER NOT NULL,
      checksum_sha256 TEXT,deleted_at INTEGER
    );
    CREATE TABLE log_object_catalog(
      id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL,log_type TEXT NOT NULL,
      plane TEXT NOT NULL,object_key TEXT NOT NULL,record_count INTEGER NOT NULL,
      byte_count INTEGER NOT NULL,checksum_sha256 TEXT,encryption_scope TEXT,
      key_version INTEGER,deleted_at INTEGER
    );
    CREATE TABLE log_chunk_record_index(
      record_id TEXT NOT NULL,tenant_key TEXT NOT NULL,log_type TEXT NOT NULL,plane TEXT NOT NULL,
      object_catalog_id TEXT NOT NULL,chunk_id TEXT NOT NULL,line_number INTEGER,
      block_offset INTEGER,block_length INTEGER,record_offset INTEGER,record_length INTEGER,
      event_at INTEGER NOT NULL,surface TEXT,index_profile TEXT NOT NULL,indexed_fields TEXT,
      created_at INTEGER NOT NULL,status TEXT NOT NULL,
      PRIMARY KEY(tenant_key,log_type,plane,record_id)
    );
    CREATE TABLE log_chunk_manifests(
      id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL,log_type TEXT NOT NULL,
      plane TEXT NOT NULL,manifest_object_key TEXT NOT NULL,checksum_sha256 TEXT,
      status TEXT NOT NULL,updated_at INTEGER NOT NULL
    );
    INSERT INTO object_catalog VALUES ('catalog-a','tenant-a',NULL);
    INSERT INTO object_catalog_objects VALUES (
      'physical-a','catalog-a','SENSITIVE_DETAILS','source/object-a',2,NULL,12,NULL
    );
    INSERT INTO sensitive_detail_chunk_index VALUES(
      'catalog-a','tenant-a','admin_audit_detail','source/object-a','gzip',4,NULL,NULL,2,NULL,NULL
    );
    INSERT INTO log_object_catalog VALUES (
      'log-a','tenant-key-a','admin_audit','archive','source/log-a',2,12,NULL,'source-scope',2,NULL
    );
    INSERT INTO log_chunk_manifests VALUES (
      'manifest-a','tenant-key-a','admin_audit','archive','source/manifest-a',NULL,'committed',100
    );
  `);
  database.exec(migration('003_tenant_backup_operations.sql'));
  database.exec(migration('034_tenant_backup_restored_hold_objects.sql'));
  database
    .prepare(
      `INSERT INTO tenant_backup_operations(
      id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,
      created_at,updated_at,fencing_token,lease_owner,lease_expires_at
    ) VALUES('operation-a','tenant-a','import','request-a',?,'running','restore_other_stores',
      'admin-a',100,100,1,'worker-a',1000)`
    )
    .run('a'.repeat(64));
  query = {
    getType: () => 'd1',
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SqlInputValue[])) as T[];
    },
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => {
          const result = database.prepare(sql).run(...(params as SqlInputValue[]));
          return {
            success: true,
            rowsAffected: Number(result.changes),
          };
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
});

afterEach(() => database.close());

describe('tenant backup R2 catalog finalizer', () => {
  it('retargets and verifies an object catalog physical row', async () => {
    const resolveCore = vi.fn(async () => query);
    const finalizer = createTenantBackupR2CatalogFinalizer({
      targetTenantKey: 'tenant-key-a',
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
    expect(resolveCore).toHaveBeenCalledWith(expect.anything(), planDigest, 'core-source');
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
      targetTenantKey: 'tenant-key-a',
      resolveCore: vi.fn(async () => query),
      resolveAdmin: vi.fn(async () => query),
    });
    const logSource = source({
      objectId: 'admin:admin-source:log-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'source/log-a',
      sourceEncoding: 'log_chunk_v1',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'log_object',
        tenantKey: PORTABLE_TENANT_KEY,
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
      objectId: 'admin:admin-source:manifest-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'source/manifest-a',
      sourceEncoding: 'plaintext',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'log_manifest',
        tenantKey: PORTABLE_TENANT_KEY,
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

  it('atomically retargets a repacked log chunk, rewrites offsets and invalidates manifests', async () => {
    database.exec(`
      INSERT INTO log_chunk_record_index VALUES(
        'record-a','tenant-key-a','admin_audit','archive','log-a','chunk-a',0,0,100,0,20,
        400,'admin','audit','{"result":"allowed"}',401,'committed'
      );
      INSERT INTO log_chunk_record_index VALUES(
        'record-b','tenant-key-a','admin_audit','archive','log-a','chunk-a',1,0,100,21,20,
        402,NULL,'audit',NULL,403,'committed'
      );
    `);
    const finalizer = createTenantBackupR2CatalogFinalizer({
      targetTenantKey: 'tenant-key-a',
      resolveCore: vi.fn(async () => query),
      resolveAdmin: vi.fn(async () => query),
    });
    const logSource = source({
      objectId: 'admin:admin-source:log-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'source/log-a',
      sourceEncoding: 'log_chunk_records_v1',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'log_object',
        tenantKey: PORTABLE_TENANT_KEY,
        logType: 'admin_audit',
        plane: 'archive',
        chunkId: 'chunk-a',
      },
    });
    const target = restored({
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'tenant-restores/tenant-a/operation-a/logs/admin:log-a',
      encryptionScope: 'target-scope',
      logRecords: [
        {
          recordId: 'record-a',
          sourceMetadataSha256: await metadataDigest({
            recordId: 'record-a',
            eventAt: 400,
            surface: 'admin',
            indexProfile: 'audit',
            indexedFields: '{"result":"allowed"}',
            createdAt: 401,
          }),
          lineNumber: 0,
          blockOffset: 0,
          blockLength: 55,
          recordOffset: 0,
          recordLength: 17,
        },
        {
          recordId: 'record-b',
          sourceMetadataSha256: await metadataDigest({
            recordId: 'record-b',
            eventAt: 402,
            surface: null,
            indexProfile: 'audit',
            indexedFields: null,
            createdAt: 403,
          }),
          lineNumber: 1,
          blockOffset: 0,
          blockLength: 55,
          recordOffset: 18,
          recordLength: 19,
        },
      ],
    });

    await finalizer.finalize(
      context(),
      planDigest,
      'logs.archive_object_bodies',
      logSource,
      target
    );

    await expect(
      finalizer.verify(context(), planDigest, 'logs.archive_object_bodies', logSource, target)
    ).resolves.toBe(true);
    expect(database.prepare('SELECT record_count FROM log_object_catalog').get()).toEqual({
      record_count: 2,
    });
    expect(
      database
        .prepare(
          'SELECT record_id,block_length,record_offset,record_length FROM log_chunk_record_index ORDER BY record_id'
        )
        .all()
    ).toEqual([
      { record_id: 'record-a', block_length: 55, record_offset: 0, record_length: 17 },
      { record_id: 'record-b', block_length: 55, record_offset: 18, record_length: 19 },
    ]);
    expect(database.prepare('SELECT status FROM log_chunk_manifests').get()).toEqual({
      status: 'repair_needed',
    });
  });

  it('retargets one shared sensitive-detail index to an independent record', async () => {
    const finalizer = createTenantBackupR2CatalogFinalizer({
      targetTenantKey: 'tenant-key-a',
      resolveCore: vi.fn(async () => query),
      resolveAdmin: vi.fn(async () => query),
    });
    const sensitiveSource = source({
      sourceEncoding: 'sensitive_detail_record_v1',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'object_catalog_object',
        catalogId: 'catalog-a',
        objectClass: 'admin_audit_detail',
      },
    });
    const sensitiveTarget = restored({ storedBytes: 144, keyVersion: 8 });

    await finalizer.finalize(
      context(),
      planDigest,
      'artifacts.object_catalog_bodies',
      sensitiveSource,
      sensitiveTarget
    );

    await expect(
      finalizer.verify(
        context(),
        planDigest,
        'artifacts.object_catalog_bodies',
        sensitiveSource,
        sensitiveTarget
      )
    ).resolves.toBe(true);
    expect(database.prepare('SELECT * FROM sensitive_detail_chunk_index').get()).toMatchObject({
      object_key: sensitiveTarget.objectKey,
      content_encoding: 'none',
      line_number: 0,
      byte_offset: 0,
      byte_length: 143,
      key_version: 8,
      checksum_sha256: sensitiveTarget.storedSha256,
    });
  });

  it('records restored workflow payloads in an immutable quarantine without live references', async () => {
    const finalizer = createTenantBackupR2CatalogFinalizer({
      targetTenantKey: 'tenant-key-a',
      resolveCore: vi.fn(async () => query),
      resolveAdmin: vi.fn(async () => query),
    });
    const holdSource = source({
      objectId: 'admin:admin-source:held-message.job-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'source/job-a',
      context: {
        tenantId: 'tenant-a',
        catalogKind: 'restore_hold_payload',
        sourceFamily: 'admin',
        sourceDatabaseId: 'admin-source',
        sourceRowId: 'held-message.job-a',
        objectClass: 'operational_log_detail',
        encryptionTenantContext: PORTABLE_TENANT_KEY,
        holdDatasetId: 'admin.logging_message_jobs',
        holdRecordId: '[["text","job-a"]]',
        sourceField: 'payload_object_ref',
      },
    });
    const holdTarget = restored({
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: 'tenant-restores/tenant-a/operation-a/logs/admin:held-message.job-a',
    });

    await finalizer.finalize(
      context(),
      planDigest,
      'logs.archive_object_bodies',
      holdSource,
      holdTarget
    );

    await expect(
      finalizer.verify(context(), planDigest, 'logs.archive_object_bodies', holdSource, holdTarget)
    ).resolves.toBe(true);
    expect(
      database.prepare('SELECT * FROM tenant_backup_restored_hold_objects').get()
    ).toMatchObject({
      operation_id: 'operation-a',
      tenant_id: 'tenant-a',
      dataset_id: 'admin.logging_message_jobs',
      source_object_ref: 'source/job-a',
      target_object_ref: holdTarget.objectKey,
      target_stored_byte_count: 144,
    });
    expect(() =>
      database.prepare('UPDATE tenant_backup_restored_hold_objects SET created_at=0').run()
    ).toThrow('tenant_backup_restored_hold_object_immutable');
    database.prepare('DELETE FROM tenant_backup_operations WHERE id=?').run('operation-a');
    expect(
      database.prepare('SELECT count(*) AS count FROM tenant_backup_restored_hold_objects').get()
    ).toEqual({ count: 0 });
  });

  it('rejects a catalog row owned by another tenant', async () => {
    database.prepare("UPDATE object_catalog SET tenant_id='tenant-b'").run();
    const finalizer = createTenantBackupR2CatalogFinalizer({
      targetTenantKey: 'tenant-key-a',
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
