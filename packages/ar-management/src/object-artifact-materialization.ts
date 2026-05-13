import {
  createObjectCatalogEntry,
  encryptObjectArtifact,
  generatePublicArtifactId,
  type DatabaseAdapter,
  type ObjectClass,
  type ObjectRepresentation,
} from '@authrim/ar-lib-core';

const ENCRYPTED_OBJECT_CONTENT_TYPE = 'application/vnd.authrim.object-envelope+json';
export const DEFAULT_OBJECT_ARTIFACT_CHUNK_BYTES = 32 * 1024 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function splitTextByUtf8Budget(value: string, maxBytes: number): string[] {
  if (utf8ByteLength(value) <= maxBytes) {
    return [value];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < value.length) {
    let low = start + 1;
    let high = value.length;
    let best = start + 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const segment = value.slice(start, mid);
      const size = utf8ByteLength(segment);
      if (size <= maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (best > start && /[\uD800-\uDBFF]/.test(value.charAt(best - 1))) {
      best -= 1;
    }
    if (best <= start) {
      best = Math.min(start + 1, value.length);
    }

    chunks.push(value.slice(start, best));
    start = best;
  }

  return chunks;
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface MaterializedObjectArtifactResult {
  catalogId: string;
  publicArtifactId: string;
  primaryObjectKey: string;
  chunked: boolean;
  chunkCount: number;
}

export async function materializeEncryptedObjectArtifact(
  adapter: DatabaseAdapter,
  bucket: R2Bucket,
  options: {
    tenantId: string;
    objectClass: ObjectClass;
    representation: ObjectRepresentation;
    objectKeyBase: string;
    content: string;
    contentType: string;
    rootKeyHex: string;
    keyVersion: number;
    publicArtifactId?: string;
    maxChunkBytes?: number;
  }
): Promise<MaterializedObjectArtifactResult> {
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_OBJECT_ARTIFACT_CHUNK_BYTES;
  const plaintextChunks = splitTextByUtf8Budget(options.content, maxChunkBytes);
  const chunked = plaintextChunks.length > 1;
  const now = Date.now();

  const objects: Parameters<typeof createObjectCatalogEntry>[1]['objects'] = [];

  if (chunked) {
    const manifest = JSON.stringify(
      {
        version: 1,
        object_class: options.objectClass,
        representation: options.representation,
        content_type: options.contentType,
        chunk_count: plaintextChunks.length,
        total_plaintext_bytes: utf8ByteLength(options.content),
      },
      null,
      2
    );
    const manifestKey = `${options.objectKeyBase}.manifest.json`;
    const manifestEnvelope = await encryptObjectArtifact(manifest, {
      rootKeyHex: options.rootKeyHex,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: options.keyVersion,
      contentType: 'application/json',
      context: {
        tenantId: options.tenantId,
        objectKey: manifestKey,
        objectClass: options.objectClass,
      },
    });
    const manifestEnvelopeJson = JSON.stringify(manifestEnvelope);
    await bucket.put(manifestKey, manifestEnvelopeJson, {
      httpMetadata: { contentType: ENCRYPTED_OBJECT_CONTENT_TYPE },
    });
    objects.push({
      representation: options.representation,
      objectKind: 'manifest',
      bucketBinding: 'EXPORT_ARTIFACTS',
      objectKey: manifestKey,
      objectIndex: -1,
      keyVersion: options.keyVersion,
      checksumSha256: await sha256Hex(manifestEnvelopeJson),
      totalBytes: utf8ByteLength(manifestEnvelopeJson),
    });
  }

  for (const [index, chunk] of plaintextChunks.entries()) {
    const objectKey = chunked
      ? `${options.objectKeyBase}.part-${String(index).padStart(6, '0')}`
      : options.objectKeyBase;
    const envelope = await encryptObjectArtifact(chunk, {
      rootKeyHex: options.rootKeyHex,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: options.keyVersion,
      contentType: options.contentType,
      context: {
        tenantId: options.tenantId,
        objectKey,
        objectClass: options.objectClass,
      },
    });
    const envelopeJson = JSON.stringify(envelope);
    await bucket.put(objectKey, envelopeJson, {
      httpMetadata: { contentType: ENCRYPTED_OBJECT_CONTENT_TYPE },
    });
    objects.push({
      representation: options.representation,
      objectKind: chunked ? 'chunk' : 'single',
      bucketBinding: 'EXPORT_ARTIFACTS',
      objectKey,
      objectIndex: index,
      keyVersion: options.keyVersion,
      checksumSha256: await sha256Hex(envelopeJson),
      totalBytes: utf8ByteLength(envelopeJson),
    });
  }

  const created = await createObjectCatalogEntry(adapter, {
    tenantId: options.tenantId,
    objectClass: options.objectClass,
    createdAt: now,
    publicArtifactId: options.publicArtifactId ?? generatePublicArtifactId(),
    objects,
  });

  return {
    catalogId: created.catalogId,
    publicArtifactId: created.publicArtifactId,
    primaryObjectKey: chunked ? `${options.objectKeyBase}.manifest.json` : options.objectKeyBase,
    chunked,
    chunkCount: plaintextChunks.length,
  };
}
