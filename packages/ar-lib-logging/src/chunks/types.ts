import type { LogChunkCompression, LogPlane, LogType } from '../registry';

export interface LogChunkRecord {
  id: string;
  eventAt: number;
  payload: unknown;
  indexedFields?: Record<string, unknown>;
}

export interface LogObjectCatalogRow {
  id: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface?: string;
  objectKey: string;
  objectKind: 'chunk';
  status: 'pending' | 'committed' | 'orphan_candidate' | 'deleted';
  recordCount: number;
  byteCount: number;
  checksumSha256?: string;
  compression: LogChunkCompression;
  encryptionScope?: string;
  keyVersion?: number;
  createdAt: number;
  committedAt?: number;
}

export interface LogChunkRecordIndexRow {
  recordId: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface?: string;
  objectCatalogId: string;
  chunkId: string;
  lineNumber: number;
  blockOffset?: number | null;
  blockLength?: number | null;
  recordOffset: number;
  recordLength: number;
  eventAt: number;
  indexProfile: string;
  indexedFields?: Record<string, unknown>;
  status: 'pending' | 'committed' | 'deleted';
  createdAt: number;
}

export interface LogChunkCatalogStore {
  createPendingObject(row: LogObjectCatalogRow): Promise<void>;
  createPendingRecordIndexes(rows: LogChunkRecordIndexRow[]): Promise<void>;
  upsertManifest?(row: LogChunkManifestRow): Promise<void>;
  commitObject(
    id: string,
    update: { byteCount: number; checksumSha256: string; committedAt: number }
  ): Promise<void>;
  commitRecordIndexes(objectCatalogId: string, committedAt: number): Promise<void>;
  markObjectOrphanCandidate(id: string, failedAt: number): Promise<void>;
}

export interface LogChunkManifestRow {
  id: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  bucketStartAt: number;
  bucketEndAt: number;
  shard: string;
  manifestObjectKey: string;
  chunkCount: number;
  recordCount: number;
  checksumSha256: string;
  status: 'pending' | 'committed' | 'repair_needed';
  createdAt: number;
  updatedAt: number;
}

export interface LogChunkManifestChunkRef {
  objectCatalogId: string;
  objectKey: string;
  chunkId: string;
  recordCount: number;
  byteCount: number;
  checksumSha256: string;
  minEventAt?: number | null;
  maxEventAt?: number | null;
}

export interface WriteLogChunkManifestInput {
  bucket: R2Bucket;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  bucketStartAt: number;
  bucketEndAt: number;
  shard: string;
  chunks: LogChunkManifestChunkRef[];
  prefix?: string;
  now?: number;
  catalogStore?: LogChunkCatalogStore;
}

export interface WriteLogChunkManifestResult {
  manifestId: string;
  manifestObjectKey: string;
  bucketStartAt: number;
  bucketEndAt: number;
  shard: string;
  chunkCount: number;
  recordCount: number;
  byteCount: number;
  checksumSha256: string;
  createdAt: number;
}

export interface WriteLogChunkInput {
  bucket: R2Bucket;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  records: LogChunkRecord[];
  prefix?: string;
  surface?: string;
  indexProfile?: string;
  compression?: LogChunkCompression;
  shard?: string;
  now?: number;
  /** Stable identifiers supplied by idempotent queue consumers on redelivery. */
  chunkId?: string;
  objectCatalogId?: string;
  catalogStore?: LogChunkCatalogStore;
  encryption?: LogChunkEncryptionOptions;
  /**
   * Emergency/test-only escape hatch for non-sensitive chunks.
   * Production log chunks should always provide encryption.
   */
  allowPlaintext?: boolean;
}

export interface WriteLogChunkResult {
  chunkId: string;
  objectCatalogId: string;
  objectKey: string;
  shard: string;
  recordCount: number;
  byteCount: number;
  checksumSha256: string;
  compression: LogChunkCompression;
  encryptionScope?: string;
  keyVersion?: number;
  createdAt: number;
}

export interface LogChunkEncryptionOptions {
  keyBytes: Uint8Array;
  encryptionScope: string;
  keyVersion: number;
}
