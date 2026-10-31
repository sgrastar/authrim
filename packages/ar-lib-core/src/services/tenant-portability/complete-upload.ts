import { TenantBackupUploadStore } from './upload-store';

interface ObjectIdentity {
  version: string;
  etag: string;
  size: number;
  body?: ReadableStream<Uint8Array>;
}
export interface CompletionBucket {
  head(key: string): Promise<ObjectIdentity | null>;
  get(key: string, options: { onlyIf: { etagMatches: string } }): Promise<ObjectIdentity | null>;
  resumeMultipartUpload(
    key: string,
    uploadId: string
  ): {
    complete(parts: { partNumber: number; etag: string }[]): Promise<ObjectIdentity>;
  };
}

/** Complete, reread and hash the immutable ciphertext before exposing it to an import operation. */
export async function completeTenantBackupUpload(input: {
  store: TenantBackupUploadStore;
  bucket: CompletionBucket;
  owner: Parameters<TenantBackupUploadStore['get']>[0];
  signal: AbortSignal;
  now(): number;
}): Promise<ObjectIdentity> {
  input.signal.throwIfAborted();
  const owner = { ...input.owner };
  const prepared = await input.store.prepareCompletion(owner, input.now());
  if (
    prepared.upload.state === 'uploaded' &&
    prepared.upload.object_version &&
    prepared.upload.object_etag
  ) {
    const saved = await input.bucket.head(prepared.upload.object_key);
    if (
      !saved ||
      saved.version !== prepared.upload.object_version ||
      saved.etag !== prepared.upload.object_etag ||
      saved.size !== prepared.upload.expected_bytes
    )
      throw new Error('backup_upload_verification_failed');
    return {
      version: prepared.upload.object_version,
      etag: prepared.upload.object_etag,
      size: prepared.upload.expected_bytes,
    };
  }
  if (!prepared.upload.multipart_id) throw new Error('backup_upload_completion_state');
  let object = await input.bucket.head(prepared.upload.object_key);
  if (!object) {
    object = await input.bucket
      .resumeMultipartUpload(prepared.upload.object_key, prepared.upload.multipart_id)
      .complete(prepared.parts);
  }
  input.signal.throwIfAborted();
  if (object.size !== prepared.upload.expected_bytes)
    throw new Error('backup_upload_verification_failed');
  const readable = await input.bucket.get(prepared.upload.object_key, {
    onlyIf: { etagMatches: object.etag },
  });
  if (
    !readable?.body ||
    readable.version !== object.version ||
    readable.etag !== object.etag ||
    readable.size !== object.size
  )
    throw new Error('backup_upload_verification_failed');
  const workersCrypto = crypto as Crypto & {
    DigestStream: new (
      algorithm: string
    ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
  };
  const digestStream = new workersCrypto.DigestStream('SHA-256');
  await readable.body.pipeTo(digestStream, { signal: input.signal });
  const digest = Array.from(new Uint8Array(await digestStream.digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  await input.store.markUploaded(owner, object, digest, input.now());
  input.signal.throwIfAborted();
  return object;
}
