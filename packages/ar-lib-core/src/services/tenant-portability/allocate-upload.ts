import { TenantBackupUploadStore, type TenantBackupUpload } from './upload-store';

interface MultipartBucket {
  createMultipartUpload(key: string): Promise<{
    uploadId: string;
    abort(): Promise<void>;
  }>;
}

/** Allocate one R2 multipart session and compensate a losing concurrent allocation. */
export async function initializeTenantBackupMultipart(input: {
  store: TenantBackupUploadStore;
  bucket: MultipartBucket;
  owner: Parameters<TenantBackupUploadStore['get']>[0];
  now(): number;
}): Promise<TenantBackupUpload> {
  const owner = { ...input.owner };
  const upload = await input.store.get(owner, input.now());
  if (upload.state !== 'allocating') {
    if (['uploading', 'completing', 'uploaded'].includes(upload.state)) return upload;
    throw new Error('backup_upload_unavailable');
  }
  const multipart = await input.bucket.createMultipartUpload(upload.object_key);
  try {
    return await input.store.attachMultipart(owner, multipart.uploadId, input.now());
  } catch {
    await multipart.abort().catch(() => undefined);
    throw new Error('backup_upload_allocation_failed');
  }
}
