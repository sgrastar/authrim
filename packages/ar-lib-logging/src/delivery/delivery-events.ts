import { createLoggingId } from '../ids';
import type { LogPlane, LogType } from '../registry';
import { floorTimeBucket } from '../time';
import type { LoggingDeliveryLane, LoggingDeliveryStatus } from './types';

export interface LoggingSqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface LoggingDeliveryEventInput {
  id?: string;
  tenantKey: string;
  destinationId?: string | null;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
  attemptCount?: number;
  errorClass?: string | null;
  objectCatalogId?: string | null;
  nextRetryAt?: number | null;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface LoggingDeliveryEventRecord {
  id: string;
  tenantKey: string;
  destinationId: string | null;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
  attemptCount: number;
  errorClass: string | null;
  objectCatalogId: string | null;
  createdAt: number;
  updatedAt: number;
  nextRetryAt: number | null;
  metadata: Record<string, unknown> | null;
}

export interface LoggingDeliveryEventStore {
  insertEvent(input: LoggingDeliveryEventInput): Promise<LoggingDeliveryEventRecord>;
}

export interface LoggingDeliveryEventAggregateInput {
  tenantKey: string;
  destinationId?: string | null;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
  attemptCount?: number;
  recordCount?: number;
  byteCount?: number;
  eventAt: number;
  bucketIntervalMs?: number;
  bucketProfile?: LoggingDeliveryAggregateBucketProfileName;
  bucketShard?: string;
}

export type LoggingDeliveryAggregateBucketProfileName = 'low' | 'medium' | 'high' | 'very_high';

export interface ResolveLoggingDeliveryAggregateBucketInput {
  profile?: LoggingDeliveryAggregateBucketProfileName;
  recordCount?: number;
  byteCount?: number;
}

export const LOGGING_DELIVERY_AGGREGATE_BUCKET_INTERVALS_MS: Record<
  LoggingDeliveryAggregateBucketProfileName,
  number
> = {
  low: 60 * 60 * 1000,
  medium: 15 * 60 * 1000,
  high: 5 * 60 * 1000,
  very_high: 60 * 1000,
};

export const LOGGING_DELIVERY_AGGREGATE_SHARD_COUNTS: Record<
  LoggingDeliveryAggregateBucketProfileName,
  number
> = {
  low: 1,
  medium: 4,
  high: 16,
  very_high: 64,
};

export function resolveLoggingDeliveryAggregateBucketProfile(
  input: ResolveLoggingDeliveryAggregateBucketInput
): LoggingDeliveryAggregateBucketProfileName {
  if (input.profile) {
    return input.profile;
  }

  const recordCount = input.recordCount ?? 0;
  const byteCount = input.byteCount ?? 0;
  if (recordCount >= 100_000 || byteCount >= 128 * 1024 * 1024) {
    return 'very_high';
  }
  if (recordCount >= 10_000 || byteCount >= 16 * 1024 * 1024) {
    return 'high';
  }
  if (recordCount >= 1_000 || byteCount >= 1024 * 1024) {
    return 'medium';
  }
  return 'low';
}

export function resolveLoggingDeliveryAggregateBucketIntervalMs(
  input: ResolveLoggingDeliveryAggregateBucketInput
): number {
  return LOGGING_DELIVERY_AGGREGATE_BUCKET_INTERVALS_MS[
    resolveLoggingDeliveryAggregateBucketProfile(input)
  ];
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function resolveLoggingDeliveryAggregateBucketShard(input: {
  profile?: LoggingDeliveryAggregateBucketProfileName;
  tenantKey: string;
  destinationId?: string | null;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
  recordCount?: number;
  byteCount?: number;
}): string {
  const profile = resolveLoggingDeliveryAggregateBucketProfile(input);
  const shardCount = LOGGING_DELIVERY_AGGREGATE_SHARD_COUNTS[profile];
  if (shardCount <= 1) {
    return 's0';
  }
  const hash = stableHash(
    [
      input.tenantKey,
      input.destinationId ?? '',
      input.logType,
      input.plane,
      input.lane,
      input.status,
    ].join('\u001f')
  );
  return `s${String(hash % shardCount).padStart(2, '0')}`;
}

function metadataToJson(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null;
  }
  return JSON.stringify(metadata);
}

function shouldPersistIndividualDeliveryEvent(input: {
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
}): boolean {
  if (input.status !== 'delivered') {
    return true;
  }
  return input.lane === 'critical';
}

function readRowsAffected(result: unknown): number | null {
  if (!result || typeof result !== 'object' || !('rowsAffected' in result)) {
    return null;
  }
  const rowsAffected = Number((result as { rowsAffected?: unknown }).rowsAffected);
  return Number.isFinite(rowsAffected) ? rowsAffected : null;
}

export class SqlLoggingDeliveryEventStore implements LoggingDeliveryEventStore {
  constructor(private readonly executor: LoggingSqlExecutor) {}

  async insertEvent(input: LoggingDeliveryEventInput): Promise<LoggingDeliveryEventRecord> {
    const now = input.now ?? Date.now();
    const id = input.id ?? createLoggingId('lde', now);
    const record: LoggingDeliveryEventRecord = {
      id,
      tenantKey: input.tenantKey,
      destinationId: input.destinationId ?? null,
      logType: input.logType,
      plane: input.plane,
      lane: input.lane,
      status: input.status,
      attemptCount: input.attemptCount ?? 0,
      errorClass: input.errorClass ?? null,
      objectCatalogId: input.objectCatalogId ?? null,
      createdAt: now,
      updatedAt: now,
      nextRetryAt: input.nextRetryAt ?? null,
      metadata: input.metadata ?? null,
    };

    if (shouldPersistIndividualDeliveryEvent(record)) {
      await this.executor.execute(
        `INSERT INTO logging_delivery_events (
          id, tenant_key, destination_id, log_type, plane, lane, status, attempt_count,
          error_class, object_catalog_id, created_at, updated_at, next_retry_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.tenantKey,
          record.destinationId,
          record.logType,
          record.plane,
          record.lane,
          record.status,
          record.attemptCount,
          record.errorClass,
          record.objectCatalogId,
          record.createdAt,
          record.updatedAt,
          record.nextRetryAt,
          metadataToJson(record.metadata ?? undefined),
        ]
      );
    }
    await this.upsertAggregate({
      tenantKey: record.tenantKey,
      destinationId: record.destinationId,
      logType: record.logType,
      plane: record.plane,
      lane: record.lane,
      status: record.status,
      attemptCount: record.attemptCount,
      recordCount:
        typeof record.metadata?.record_count === 'number' ? record.metadata.record_count : 0,
      byteCount: typeof record.metadata?.byte_count === 'number' ? record.metadata.byte_count : 0,
      eventAt: record.createdAt,
    });

    return record;
  }

  async upsertAggregate(input: LoggingDeliveryEventAggregateInput): Promise<void> {
    const destinationId = input.destinationId ?? '';
    const attemptCount = input.attemptCount ?? 0;
    const recordCount = input.recordCount ?? 0;
    const byteCount = input.byteCount ?? 0;
    const intervalMs =
      input.bucketIntervalMs ??
      resolveLoggingDeliveryAggregateBucketIntervalMs({
        profile: input.bucketProfile,
        recordCount,
        byteCount,
      });
    const bucketShard =
      input.bucketShard ??
      resolveLoggingDeliveryAggregateBucketShard({
        profile: input.bucketProfile,
        tenantKey: input.tenantKey,
        destinationId,
        logType: input.logType,
        plane: input.plane,
        lane: input.lane,
        status: input.status,
        recordCount,
        byteCount,
      });
    const bucketStartAt = floorTimeBucket(input.eventAt, intervalMs);
    const bucketEndAt = bucketStartAt + intervalMs;

    const update = await this.executor.execute(
      `UPDATE logging_delivery_event_aggregates
       SET bucket_end_at = ?,
           batch_count = batch_count + ?,
           record_count = record_count + ?,
           byte_count = byte_count + ?,
           attempt_count_sum = attempt_count_sum + ?,
           first_seen_at = CASE WHEN first_seen_at < ? THEN first_seen_at ELSE ? END,
           last_seen_at = CASE WHEN last_seen_at > ? THEN last_seen_at ELSE ? END,
           updated_at = ?
       WHERE bucket_start_at = ?
         AND bucket_shard = ?
         AND tenant_key = ?
         AND destination_id = ?
         AND log_type = ?
         AND plane = ?
         AND lane = ?
         AND status = ?`,
      [
        bucketEndAt,
        1,
        recordCount,
        byteCount,
        attemptCount,
        input.eventAt,
        input.eventAt,
        input.eventAt,
        input.eventAt,
        input.eventAt,
        bucketStartAt,
        bucketShard,
        input.tenantKey,
        destinationId,
        input.logType,
        input.plane,
        input.lane,
        input.status,
      ]
    );
    if ((readRowsAffected(update) ?? 0) > 0) {
      return;
    }

    await this.executor.execute(
      `INSERT INTO logging_delivery_event_aggregates (
        bucket_start_at, bucket_end_at, bucket_shard, tenant_key, destination_id, log_type, plane,
        lane, status, batch_count, record_count, byte_count, attempt_count_sum,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bucketStartAt,
        bucketEndAt,
        bucketShard,
        input.tenantKey,
        destinationId,
        input.logType,
        input.plane,
        input.lane,
        input.status,
        1,
        recordCount,
        byteCount,
        attemptCount,
        input.eventAt,
        input.eventAt,
        input.eventAt,
      ]
    );
  }
}
