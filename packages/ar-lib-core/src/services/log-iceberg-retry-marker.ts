/** Zero-byte immutable-PUT denial at the deterministic logical retry key.
 * The marker contains no ciphertext, subject ID or real user identifiers. */
export function logIcebergRetryMarkerMetadata(recordId: string): Record<string, string> {
  if (!/^[a-f0-9]{64}$/.test(recordId))
    throw new Error('log_iceberg_retry_marker_identity_invalid');
  return { authrim_iceberg_erased: '1', authrim_record_id: recordId };
}
export function isLogIcebergRetryErasureMarker(
  head: Pick<R2Object, 'size' | 'customMetadata'> | null | undefined,
  recordId: string
): boolean {
  return Boolean(
    head &&
    /^[a-f0-9]{64}$/.test(recordId) &&
    head.size === 0 &&
    Object.keys(head.customMetadata ?? {}).length === 2 &&
    head.customMetadata?.authrim_iceberg_erased === '1' &&
    head.customMetadata?.authrim_record_id === recordId
  );
}

export interface LogIcebergRetryErasureIdentity {
  id: string;
  generation: string;
  key: string;
  hmac: string;
  digest: string | null;
  bytes: number | null;
}
/** Caller holds Control admission, table lease, and capture protection. */
export async function retireLogIcebergRetryObject(
  bucket: Pick<R2Bucket, 'head' | 'put'>,
  row: LogIcebergRetryErasureIdentity,
  assertLease: () => Promise<void>
): Promise<boolean> {
  if (
    !/^[a-f0-9]{64}$/.test(row.id) ||
    !/^[a-f0-9]{64}$/.test(row.hmac) ||
    (row.digest !== null && !/^[a-f0-9]{64}$/.test(row.digest)) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/.test(row.generation) ||
    row.key !== `_authrim_retry/iceberg/v1/${row.generation}/${row.id}.json` ||
    (row.bytes !== null &&
      (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 4194304)) ||
    (row.digest === null) !== (row.bytes === null)
  )
    throw new Error('log_iceberg_erasure_retry_identity_changed');
  for (let attempt = 0; attempt < 3; attempt++) {
    await assertLease();
    const head = await bucket.head(row.key);
    if (isLogIcebergRetryErasureMarker(head, row.id)) {
      await assertLease();
      return true;
    }
    if (
      head &&
      (head.customMetadata?.authrim_record_id !== row.id ||
        head.customMetadata?.authrim_storage_generation !== row.generation ||
        head.customMetadata?.authrim_payload_hmac !== row.hmac ||
        (row.bytes !== null && head.size !== row.bytes) ||
        (row.digest !== null && head.customMetadata?.authrim_payload_sha256 !== row.digest))
    )
      throw new Error('log_iceberg_erasure_retry_identity_changed');
    if (head && (typeof head.etag !== 'string' || !head.etag))
      throw new Error('log_iceberg_erasure_retry_etag_unavailable');
    await assertLease();
    await bucket.put(row.key, new Uint8Array(0), {
      onlyIf: head ? { etagMatches: head.etag } : { etagDoesNotMatch: '*' },
      customMetadata: logIcebergRetryMarkerMetadata(row.id),
      httpMetadata: { contentType: 'application/authrim.iceberg-retry-erased' },
    });
    await assertLease();
    if (isLogIcebergRetryErasureMarker(await bucket.head(row.key), row.id)) {
      await assertLease();
      return true;
    }
  }
  return false;
}
