import type { LogPlane, LogType } from '../registry';
import { formatUtcPartition } from '../time';

function cleanSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._=-]/g, '_').slice(0, 128);
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function normalizeR2Prefix(prefix?: string): string {
  const raw = trimSlashes(prefix ?? 'logs');
  const cleaned = raw
    .split('/')
    .map((segment) => cleanSegment(segment))
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
  return cleaned || 'logs';
}

export interface BuildLogChunkObjectKeyInput {
  prefix?: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface?: string | null;
  createdAt: number;
  chunkId: string;
  shard?: string;
  compression?: 'none' | 'gzip_block';
}

export interface BuildLogChunkManifestObjectKeyInput {
  prefix?: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  bucketStartAt: number;
  shard: string;
}

export function buildLogChunkObjectKey(input: BuildLogChunkObjectKeyInput): string {
  const partition = formatUtcPartition(input.createdAt);
  const extension = input.compression === 'none' ? 'jsonl' : 'jsonl.gz';
  const shard = cleanSegment(input.shard ?? defaultLogStorageShard({ tenantKey: input.tenantKey }));
  const path = [normalizeR2Prefix(input.prefix), cleanSegment(input.tenantKey)];
  if (input.plane === 'sensitive_detail') {
    path.push(
      'sensitive_detail',
      cleanSegment(input.surface ?? 'general'),
      cleanSegment(input.logType)
    );
  } else {
    path.push(cleanSegment(input.plane), cleanSegment(input.logType));
  }
  path.push(
    partition.year,
    partition.month,
    partition.day,
    partition.hour,
    shard,
    `${cleanSegment(input.chunkId)}.${extension}`
  );
  return path.join('/');
}

export function buildLogChunkManifestObjectKey(input: BuildLogChunkManifestObjectKeyInput): string {
  const partition = formatUtcPartition(input.bucketStartAt);
  return [
    normalizeR2Prefix(input.prefix),
    cleanSegment(input.tenantKey),
    'manifests',
    cleanSegment(input.logType),
    partition.year,
    partition.month,
    partition.day,
    partition.hour,
    `${cleanSegment(input.shard)}.json`,
  ].join('/');
}

export function defaultLogStorageShard(input: { tenantKey: string; shardCount?: number }): string {
  const shardCount = input.shardCount ?? 16;
  if (!Number.isInteger(shardCount) || shardCount <= 0 || shardCount > 256) {
    throw new Error('log_storage_shard_count_invalid');
  }
  let hash = 0;
  for (const char of input.tenantKey) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `shard-${String(hash % shardCount).padStart(2, '0')}`;
}
