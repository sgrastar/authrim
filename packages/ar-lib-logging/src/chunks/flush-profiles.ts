import type { LogPlane, LogType } from '../registry';

export type LogChunkFlushProfileName =
  | 'critical'
  | 'default'
  | 'low_volume'
  | 'bulk'
  | 'high_volume';

export interface LogChunkFlushProfile {
  name: LogChunkFlushProfileName;
  maxRecords: number;
  maxBytes: number;
  maxIntervalMs: number;
  compression: 'gzip_block' | 'none';
}

export interface ResolveLogChunkFlushProfileInput {
  logType: LogType;
  plane: LogPlane;
  estimatedRecordsPerMinute?: number;
}

export interface ShouldFlushLogChunkInput {
  profile: LogChunkFlushProfile;
  pendingRecords: number;
  pendingBytes: number;
  oldestPendingAt: number | null;
  now?: number;
}

export const LOG_CHUNK_FLUSH_PROFILES: Record<LogChunkFlushProfileName, LogChunkFlushProfile> = {
  critical: {
    name: 'critical',
    maxRecords: 1000,
    maxBytes: 4 * 1024 * 1024,
    maxIntervalMs: 60 * 1000,
    compression: 'gzip_block',
  },
  default: {
    name: 'default',
    maxRecords: 5000,
    maxBytes: 16 * 1024 * 1024,
    maxIntervalMs: 5 * 60 * 1000,
    compression: 'gzip_block',
  },
  low_volume: {
    name: 'low_volume',
    maxRecords: 1000,
    maxBytes: 4 * 1024 * 1024,
    maxIntervalMs: 15 * 60 * 1000,
    compression: 'gzip_block',
  },
  bulk: {
    name: 'bulk',
    maxRecords: 10000,
    maxBytes: 32 * 1024 * 1024,
    maxIntervalMs: 15 * 60 * 1000,
    compression: 'gzip_block',
  },
  high_volume: {
    name: 'high_volume',
    maxRecords: 5000,
    maxBytes: 16 * 1024 * 1024,
    maxIntervalMs: 60 * 1000,
    compression: 'gzip_block',
  },
};

export function resolveLogChunkFlushProfile(
  input: ResolveLogChunkFlushProfileInput
): LogChunkFlushProfile {
  if ((input.estimatedRecordsPerMinute ?? 0) >= 5000) {
    return LOG_CHUNK_FLUSH_PROFILES.high_volume;
  }
  if (
    input.logType === 'audit' ||
    input.logType === 'admin_audit' ||
    input.logType === 'security' ||
    input.logType === 'pii' ||
    input.plane === 'sensitive_detail'
  ) {
    return LOG_CHUNK_FLUSH_PROFILES.critical;
  }
  if (input.logType === 'diagnostic' || input.plane === 'diagnostic_detail') {
    return LOG_CHUNK_FLUSH_PROFILES.bulk;
  }
  if ((input.estimatedRecordsPerMinute ?? Number.POSITIVE_INFINITY) <= 10) {
    return LOG_CHUNK_FLUSH_PROFILES.low_volume;
  }
  return LOG_CHUNK_FLUSH_PROFILES.default;
}

export function shouldFlushLogChunk(input: ShouldFlushLogChunkInput): boolean {
  if (input.pendingRecords <= 0) {
    return false;
  }
  if (input.pendingRecords >= input.profile.maxRecords) {
    return true;
  }
  if (input.pendingBytes >= input.profile.maxBytes) {
    return true;
  }
  if (input.oldestPendingAt === null) {
    return false;
  }
  return (input.now ?? Date.now()) - input.oldestPendingAt >= input.profile.maxIntervalMs;
}
