import type { LogPlane, LogType } from '../registry';
import { formatUtcPartition } from '../time';

function cleanSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._=-]/g, '_').slice(0, 128);
}

export function normalizeR2Prefix(prefix?: string): string {
  const raw = (prefix ?? 'logs').replace(/^\/+|\/+$/g, '');
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
  const path = [
    normalizeR2Prefix(input.prefix),
    cleanSegment(input.tenantKey),
    cleanSegment(input.plane),
    cleanSegment(input.logType),
  ];
  if (input.surface) {
    path.push(cleanSegment(input.surface));
  }
  path.push(
    partition.year,
    partition.month,
    partition.day,
    partition.hour,
    `${cleanSegment(input.chunkId)}.${extension}`
  );
  return path.join('/');
}

export function buildLogChunkManifestObjectKey(input: BuildLogChunkManifestObjectKeyInput): string {
  const partition = formatUtcPartition(input.bucketStartAt);
  return [
    normalizeR2Prefix(input.prefix),
    cleanSegment(input.tenantKey),
    cleanSegment(input.plane),
    cleanSegment(input.logType),
    'manifests',
    partition.year,
    partition.month,
    partition.day,
    partition.hour,
    `${cleanSegment(input.shard)}.manifest.json`
  ].join('/');
}
