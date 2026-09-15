import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_OBJECT_BODIES_DATASET,
  createPortableR2ObjectDatasetPolicies,
  decodePortableR2ObjectChunk,
  encodePortableR2ObjectChunk,
  LOG_ARCHIVE_OBJECT_BODIES_DATASET,
  TENANT_BACKUP_R2_CHUNK_BYTES,
  TENANT_BACKUP_R2_MAX_CHUNKS,
} from '../portable-r2-object';

async function digest(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fixture() {
  const bytes = new TextEncoder().encode('portable-object-body');
  return {
    tenantId: 'tenant-a',
    objectId: 'object-a',
    bucketBinding: 'SENSITIVE_DETAILS' as const,
    objectKey: 'objects/tenant-a/object-a.json',
    sourceEncoding: 'object_artifact_v1' as const,
    objectSha256: await digest(bytes),
    totalBytes: bytes.length,
    chunkIndex: 0,
    chunkCount: 1,
    chunkSha256: await digest(bytes),
    bytes,
    context: { objectClass: 'admin_audit_detail' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { tenant: 'tenant-a' },
  };
}

describe('portable R2 object chunks', () => {
  it('roundtrips plaintext bytes and target-independent metadata', async () => {
    const value = await fixture();
    const encoded = await encodePortableR2ObjectChunk(value);
    const decoded = await decodePortableR2ObjectChunk(
      new TextDecoder().decode(encoded).trimEnd(),
      'tenant-a'
    );

    expect(decoded).toEqual(value);
    expect(decoded.sourceEncoding).toBe('object_artifact_v1');
    expect(decoded.bytes).toEqual(new TextEncoder().encode('portable-object-body'));
  });

  it('defines artifact and log body datasets without adding UI selections', () => {
    expect(createPortableR2ObjectDatasetPolicies().map(({ dataset }) => dataset)).toEqual([
      ARTIFACT_OBJECT_BODIES_DATASET,
      LOG_ARCHIVE_OBJECT_BODIES_DATASET,
    ]);
    expect(ARTIFACT_OBJECT_BODIES_DATASET.kind).toBe('artifacts');
    expect(LOG_ARCHIVE_OBJECT_BODIES_DATASET.kind).toBe('log_dependencies');
  });

  it('rejects cross-tenant, corrupt and noncanonical chunks', async () => {
    const value = await fixture();
    const encoded = new TextDecoder().decode(await encodePortableR2ObjectChunk(value)).trimEnd();
    await expect(decodePortableR2ObjectChunk(encoded, 'tenant-b')).rejects.toThrow(
      'backup_portable_r2_object_invalid'
    );

    const corrupt = JSON.parse(encoded) as Record<string, [string, string | null]>;
    corrupt.bytes_base64 = ['text', 'Y29ycnVwdA=='];
    await expect(decodePortableR2ObjectChunk(JSON.stringify(corrupt), 'tenant-a')).rejects.toThrow(
      'backup_portable_r2_object_invalid'
    );

    corrupt.bytes_base64 = ['text', 'Y29ycnVwdA'];
    await expect(decodePortableR2ObjectChunk(JSON.stringify(corrupt), 'tenant-a')).rejects.toThrow(
      'backup_portable_r2_object_invalid'
    );
  });

  it('bounds every bundle row while allowing a multi-row object', async () => {
    const value = await fixture();
    await expect(
      encodePortableR2ObjectChunk({
        ...value,
        bytes: new Uint8Array(TENANT_BACKUP_R2_CHUNK_BYTES + 1),
      })
    ).rejects.toThrow('backup_portable_r2_object_invalid');

    await expect(
      encodePortableR2ObjectChunk({ ...value, chunkIndex: 1, chunkCount: 1 })
    ).rejects.toThrow('backup_portable_r2_object_invalid');

    await expect(
      encodePortableR2ObjectChunk({
        ...value,
        chunkCount: TENANT_BACKUP_R2_MAX_CHUNKS + 1,
      })
    ).rejects.toThrow('backup_portable_r2_object_invalid');

    await expect(
      encodePortableR2ObjectChunk({ ...value, totalBytes: value.bytes.length + 1 })
    ).rejects.toThrow('backup_portable_r2_object_invalid');
  });
});
