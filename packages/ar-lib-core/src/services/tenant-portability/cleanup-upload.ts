import { TenantBackupUploadStore, type TenantBackupUpload } from './upload-store';

interface CleanupBucket {
  head(key: string): Promise<{ version: string; etag: string; size: number } | null>;
  delete(key: string): Promise<void>;
  resumeMultipartUpload(key: string, uploadId: string): { abort(): Promise<void> };
}

function noSuchUpload(error: unknown): boolean {
  return error instanceof Error && /\(10024\)\s*$/.test(error.message);
}

function expectedKey(upload: TenantBackupUpload): string {
  const key = `tenant-backup-inputs/${encodeURIComponent(upload.tenant_id)}/${encodeURIComponent(upload.id)}`;
  if (upload.object_key !== key) throw new Error('backup_upload_cleanup_identity');
  return key;
}

/**
 * Remove one durably claimed expired upload. NoSuchUpload proves an earlier abort already won;
 * transient abort/delete errors leave the D1 tombstone pending for lease-based retry.
 */
export async function cleanupExpiredTenantBackupUpload(input: {
  store: TenantBackupUploadStore;
  bucket: CleanupBucket;
  workerId: string;
  now(): number;
}): Promise<{ cleaned: boolean }> {
  const timestamp = input.now();
  const upload = await input.store.claimCleanup(input.workerId, timestamp);
  if (!upload) return { cleaned: false };
  const key = expectedKey(upload);
  if (upload.multipart_id && upload.object_version === null) {
    try {
      await input.bucket.resumeMultipartUpload(key, upload.multipart_id).abort();
    } catch (error) {
      if (!noSuchUpload(error)) throw new Error('backup_upload_cleanup_failed');
    }
  }
  const object = await input.bucket.head(key);
  if (object) {
    if (
      upload.object_version !== null &&
      (object.version !== upload.object_version ||
        object.etag !== upload.object_etag ||
        object.size !== upload.expected_bytes)
    )
      throw new Error('backup_upload_cleanup_identity');
    await input.bucket.delete(key);
    if (await input.bucket.head(key)) throw new Error('backup_upload_cleanup_failed');
  }
  await input.store.markDeleted(upload.id, input.workerId, input.now());
  return { cleaned: true };
}
