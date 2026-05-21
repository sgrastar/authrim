import { createLoggingId } from '../ids';
import { assertLogPlane, assertLogType } from '../registry';
import { buildLogChunkManifestObjectKey } from './r2-keys';
import type {
  LogChunkManifestRow,
  WriteLogChunkManifestInput,
  WriteLogChunkManifestResult,
} from './types';

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

export function floorLogManifestBucket(timestamp: number, bucketSizeMs: number): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('manifest_timestamp_invalid');
  }
  if (!Number.isFinite(bucketSizeMs) || bucketSizeMs <= 0) {
    throw new Error('manifest_bucket_size_invalid');
  }
  return Math.floor(timestamp / bucketSizeMs) * bucketSizeMs;
}

export function defaultLogManifestShard(input: { tenantKey: string; shardCount?: number }): string {
  const shardCount = input.shardCount ?? 16;
  if (!Number.isInteger(shardCount) || shardCount <= 0 || shardCount > 256) {
    throw new Error('manifest_shard_count_invalid');
  }
  let hash = 0;
  for (const char of input.tenantKey) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `shard-${String(hash % shardCount).padStart(2, '0')}`;
}

export async function writeLogChunkManifestToR2(
  input: WriteLogChunkManifestInput
): Promise<WriteLogChunkManifestResult> {
  if (input.chunks.length === 0) {
    throw new Error('log_manifest_chunks_required');
  }

  assertLogType(input.logType);
  assertLogPlane(input.plane);

  const createdAt = input.now ?? Date.now();
  const manifestId = createLoggingId('man', createdAt);
  const manifestObjectKey = buildLogChunkManifestObjectKey({
    prefix: input.prefix,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    bucketStartAt: input.bucketStartAt,
    shard: input.shard,
  });
  const recordCount = input.chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0);
  const byteCount = input.chunks.reduce((sum, chunk) => sum + chunk.byteCount, 0);
  const manifest = {
    schema_version: 1,
    manifest_id: manifestId,
    tenant_key: input.tenantKey,
    log_type: input.logType,
    plane: input.plane,
    bucket_start_at: input.bucketStartAt,
    bucket_end_at: input.bucketEndAt,
    shard: input.shard,
    chunk_count: input.chunks.length,
    record_count: recordCount,
    byte_count: byteCount,
    chunks: input.chunks,
    created_at: createdAt,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const checksumSha256 = await sha256Hex(bytes);

  await input.bucket.put(manifestObjectKey, bytes, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      bucketStartAt: String(input.bucketStartAt),
      bucketEndAt: String(input.bucketEndAt),
      shard: input.shard,
      chunkCount: String(input.chunks.length),
      recordCount: String(recordCount),
      checksumSha256,
    },
  });

  const row: LogChunkManifestRow = {
    id: manifestId,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    bucketStartAt: input.bucketStartAt,
    bucketEndAt: input.bucketEndAt,
    shard: input.shard,
    manifestObjectKey,
    chunkCount: input.chunks.length,
    recordCount,
    checksumSha256,
    status: 'committed',
    createdAt,
    updatedAt: createdAt,
  };
  await input.catalogStore?.upsertManifest?.(row);

  return {
    manifestId,
    manifestObjectKey,
    bucketStartAt: input.bucketStartAt,
    bucketEndAt: input.bucketEndAt,
    shard: input.shard,
    chunkCount: input.chunks.length,
    recordCount,
    byteCount,
    checksumSha256,
    createdAt,
  };
}
