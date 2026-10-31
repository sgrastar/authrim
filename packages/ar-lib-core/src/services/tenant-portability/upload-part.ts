import { TenantBackupUploadStore, TENANT_BACKUP_UPLOAD_PART_BYTES } from './upload-store';

/** Upload one bounded ciphertext part after its content has been durably reserved. */
export async function uploadTenantBackupPart(input: {
  store: TenantBackupUploadStore;
  bucket: {
    resumeMultipartUpload(
      key: string,
      uploadId: string
    ): {
      uploadPart(
        partNumber: number,
        bytes: Uint8Array
      ): Promise<{ partNumber: number; etag: string }>;
    };
  };
  owner: Parameters<TenantBackupUploadStore['get']>[0];
  number: number;
  bytes: Uint8Array;
  signal: AbortSignal;
  now(): number;
}): Promise<{ partNumber: number; etag: string }> {
  input.signal.throwIfAborted();
  if (!input.bytes.length || input.bytes.length > TENANT_BACKUP_UPLOAD_PART_BYTES)
    throw new Error('backup_upload_part_input');
  const owner = { ...input.owner };
  const number = input.number;
  const bytes = new Uint8Array(input.bytes);
  await input.store.get(owner, input.now());
  const sha = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(sha), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  const part = { number, bytes: bytes.byteLength, sha256 };
  const existing = await input.store.reservePart(owner, part, input.now());
  input.signal.throwIfAborted();
  if (existing.etag) return { partNumber: number, etag: existing.etag };
  const upload = await input.store.get(owner, input.now());
  if (!upload.multipart_id || upload.state !== 'uploading')
    throw new Error('backup_upload_unavailable');
  const result = await input.bucket
    .resumeMultipartUpload(upload.object_key, upload.multipart_id)
    .uploadPart(number, bytes);
  input.signal.throwIfAborted();
  if (result.partNumber !== number) throw new Error('backup_upload_part_response');
  await input.store.acknowledgePart(owner, { ...part, etag: result.etag }, input.now());
  return { partNumber: number, etag: result.etag };
}
