import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { cleanupExpiredTenantBackupUpload } from '../cleanup-upload';
import { TenantBackupUploadStore } from '../upload-store';

let sql: DatabaseSync;
let store: TenantBackupUploadStore;
const expiry = 86_400_200;

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/022_tenant_backup_uploads.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  sql.exec(`CREATE TABLE tenant_backup_operations (
    id TEXT NOT NULL, tenant_id TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(id,tenant_id)
  );
  CREATE TABLE tenant_backup_operation_inputs (
    operation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE
  );`);
  const database: Pick<DatabaseAdapter, 'queryOne'> = {
    async queryOne<T>(statement: string, params: unknown[] = []) {
      return (sql.prepare(statement).get(...(params as SQLInputValue[])) as T) ?? null;
    },
  };
  store = new TenantBackupUploadStore(database);
});

afterEach(() => sql.close());

async function create(state: 'allocating' | 'uploading' | 'uploaded', expiresAt = expiry) {
  await store.create({
    uploadId: 'upload',
    tenantId: 'tenant',
    actorId: 'admin',
    idempotencyKey: 'request',
    bytes: 174,
    sha256: 'ab'.repeat(32),
    now: expiresAt - 86400000,
  });
  if (state !== 'allocating')
    await store.attachMultipart(
      { uploadId: 'upload', tenantId: 'tenant', actorId: 'admin' },
      'multipart',
      expiresAt - 1
    );
  if (state === 'uploaded') {
    sql.exec(`UPDATE tenant_backup_uploads SET state='completing';
      UPDATE tenant_backup_uploads SET state='uploaded',object_version='v1',object_etag='etag',
      verified_sha256='${'ab'.repeat(32)}',completed_at=${expiresAt - 1};`);
  }
}

it('aborts and tombstones an expired multipart upload with bounded retry', async () => {
  await create('uploading');
  let missing = false;
  const abort = vi.fn(async () => {
    if (!missing) {
      missing = true;
      throw new Error('response lost');
    }
    throw new Error('abort: multipart upload does not exist (10024)');
  });
  const bucket = {
    head: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    resumeMultipartUpload: vi.fn(() => ({ abort })),
  };
  await expect(
    cleanupExpiredTenantBackupUpload({ store, bucket, workerId: 'worker-a', now: () => expiry })
  ).rejects.toThrow('backup_upload_cleanup_failed');
  expect(sql.prepare('SELECT state FROM tenant_backup_uploads').get()?.state).toBe('cancelling');
  expect(
    await cleanupExpiredTenantBackupUpload({
      store,
      bucket,
      workerId: 'worker-b',
      now: () => expiry + 29999,
    })
  ).toEqual({ cleaned: false });
  expect(
    await cleanupExpiredTenantBackupUpload({
      store,
      bucket,
      workerId: 'worker-b',
      now: () => expiry + 30000,
    })
  ).toEqual({ cleaned: true });
  expect(sql.prepare('SELECT state FROM tenant_backup_uploads').get()?.state).toBe('deleted');
  expect(abort).toHaveBeenCalledTimes(2);
});

it('deletes only the exact completed object and retains active operation inputs', async () => {
  await create('uploaded');
  sql.exec(`INSERT INTO tenant_backup_operations VALUES ('operation','tenant','running');
    INSERT INTO tenant_backup_operation_inputs VALUES ('operation','tenant','upload');`);
  let object: { version: string; etag: string; size: number } | null = {
    version: 'v1',
    etag: 'etag',
    size: 174,
  };
  const bucket = {
    head: vi.fn(async () => object),
    delete: vi.fn(async () => {
      object = null;
    }),
    resumeMultipartUpload: vi.fn(() => ({ abort: vi.fn(async () => {}) })),
  };
  expect(
    await cleanupExpiredTenantBackupUpload({ store, bucket, workerId: 'worker', now: () => expiry })
  ).toEqual({ cleaned: false });
  expect(bucket.delete).not.toHaveBeenCalled();
  sql.exec("UPDATE tenant_backup_operations SET state='completed'");
  expect(
    await cleanupExpiredTenantBackupUpload({ store, bucket, workerId: 'worker', now: () => expiry })
  ).toEqual({ cleaned: true });
  expect(bucket.delete).toHaveBeenCalledWith('tenant-backup-inputs/tenant/upload');
  expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  expect(sql.prepare('SELECT state FROM tenant_backup_uploads').get()?.state).toBe('deleted');
});

it('does not delete a completed key whose immutable R2 identity changed', async () => {
  await create('uploaded');
  const bucket = {
    head: vi.fn(async () => ({ version: 'changed', etag: 'etag', size: 174 })),
    delete: vi.fn(async () => {}),
    resumeMultipartUpload: vi.fn(() => ({ abort: vi.fn(async () => {}) })),
  };
  await expect(
    cleanupExpiredTenantBackupUpload({ store, bucket, workerId: 'worker', now: () => expiry })
  ).rejects.toThrow('backup_upload_cleanup_identity');
  expect(bucket.delete).not.toHaveBeenCalled();
  expect(sql.prepare('SELECT state FROM tenant_backup_uploads').get()?.state).toBe('cancelling');
});

it('cleans an explicitly cancelled upload before its retention deadline', async () => {
  await create('uploading', expiry + 10000);
  await expect(
    store.requestCancel({ uploadId: 'upload', tenantId: 'tenant', actorId: 'other' }, expiry)
  ).rejects.toThrow('backup_upload_cancel_conflict');
  await store.requestCancel({ uploadId: 'upload', tenantId: 'tenant', actorId: 'admin' }, expiry);
  const abort = vi.fn(async () => {});
  const bucket = {
    head: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    resumeMultipartUpload: vi.fn(() => ({ abort })),
  };
  expect(
    await cleanupExpiredTenantBackupUpload({ store, bucket, workerId: 'worker', now: () => expiry })
  ).toEqual({ cleaned: true });
  expect(abort).toHaveBeenCalledTimes(1);
  expect(sql.prepare('SELECT state FROM tenant_backup_uploads').get()?.state).toBe('deleted');
});

it('does not cancel an upload after an import operation has pinned it', async () => {
  await create('uploaded', expiry + 10000);
  sql.exec(`INSERT INTO tenant_backup_operations VALUES ('operation','tenant','waiting');
    INSERT INTO tenant_backup_operation_inputs VALUES ('operation','tenant','upload');`);
  await expect(
    store.requestCancel({ uploadId: 'upload', tenantId: 'tenant', actorId: 'admin' }, expiry)
  ).rejects.toThrow('backup_upload_cancel_conflict');
  expect(sql.prepare('SELECT state FROM tenant_backup_uploads').get()?.state).toBe('uploaded');
});
