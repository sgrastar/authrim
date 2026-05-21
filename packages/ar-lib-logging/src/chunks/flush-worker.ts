import { createLoggingId } from '../ids';
import type { LogChunkCompression, LogPlane, LogType } from '../registry';
import { enqueueLoggingDeliveryPayloadBatch, type LoggingDeliveryEnqueueResult } from '../delivery';
import type { LoggingDeliveryLane } from '../delivery/types';
import {
  resolveLogChunkFlushProfile,
  shouldFlushLogChunk,
  type LogChunkFlushProfile,
} from './flush-profiles';
import { writeLogChunkToR2 } from './r2-chunk-writer';
import type { LogChunkCatalogStore, LogChunkRecord, WriteLogChunkResult } from './types';

export interface FlushLogChunkDestination {
  destinationId: string;
  lane: LoggingDeliveryLane;
}

export interface FlushLogChunkAndEnqueueInput {
  bucket: R2Bucket;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  records: LogChunkRecord[];
  destinations: readonly FlushLogChunkDestination[];
  queueBindings: Record<string, unknown>;
  prefix?: string;
  surface?: string;
  indexProfile?: string;
  compression?: LogChunkCompression;
  now?: number;
  catalogStore?: LogChunkCatalogStore;
}

export interface FlushLogChunkAndEnqueueResult {
  chunk: WriteLogChunkResult;
  delivery: LoggingDeliveryEnqueueResult[];
}

export interface BufferedLogChunkFlushGroup {
  bucket: R2Bucket;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  destinations: readonly FlushLogChunkDestination[];
  queueBindings: Record<string, unknown>;
  prefix?: string;
  surface?: string;
  indexProfile?: string;
  compression?: LogChunkCompression;
  profile?: LogChunkFlushProfile;
  estimatedRecordsPerMinute?: number;
  catalogStore?: LogChunkCatalogStore;
}

export interface BufferedLogChunkRecordInput {
  group: BufferedLogChunkFlushGroup;
  record: LogChunkRecord;
  estimatedBytes?: number;
  now?: number;
}

export interface BufferedLogChunkFlushWorkerOptions {
  now?: () => number;
  estimateRecordBytes?: (record: LogChunkRecord) => number;
}

interface BufferedLogChunkGroupState {
  group: BufferedLogChunkFlushGroup;
  records: LogChunkRecord[];
  pendingBytes: number;
  oldestPendingAt: number | null;
}

function stableGroupPart(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function destinationGroupKey(destinations: readonly FlushLogChunkDestination[]): string {
  return [...destinations]
    .map((destination) => `${destination.destinationId}:${destination.lane}`)
    .sort()
    .join(',');
}

export function bufferedLogChunkGroupKey(group: BufferedLogChunkFlushGroup): string {
  return [
    group.tenantKey,
    group.logType,
    group.plane,
    stableGroupPart(group.surface),
    stableGroupPart(group.prefix),
    stableGroupPart(group.indexProfile),
    stableGroupPart(group.compression),
    destinationGroupKey(group.destinations),
  ].join('|');
}

function defaultEstimateRecordBytes(record: LogChunkRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

export async function flushLogChunkAndEnqueueDelivery(
  input: FlushLogChunkAndEnqueueInput
): Promise<FlushLogChunkAndEnqueueResult> {
  const chunk = await writeLogChunkToR2({
    bucket: input.bucket,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    records: input.records,
    prefix: input.prefix,
    surface: input.surface,
    indexProfile: input.indexProfile,
    compression: input.compression,
    now: input.now,
    catalogStore: input.catalogStore,
  });

  const createdAt = input.now ?? Date.now();
  const payloads = input.destinations.map((destination) => ({
    payload_type: 'delivery_fanout' as const,
    schema_version: 1 as const,
    payload_id: createLoggingId('qpl', createdAt),
    tenant_key: input.tenantKey,
    lane: destination.lane,
    created_at: createdAt,
    catalog_id: chunk.objectCatalogId,
    object_key: chunk.objectKey,
    destination_id: destination.destinationId,
    log_type: input.logType,
    plane: input.plane,
    record_count: chunk.recordCount,
  }));

  const delivery =
    payloads.length > 0
      ? await enqueueLoggingDeliveryPayloadBatch(payloads, input.queueBindings)
      : [];

  return { chunk, delivery };
}

export class BufferedLogChunkFlushWorker {
  private readonly groups = new Map<string, BufferedLogChunkGroupState>();
  private readonly now: () => number;
  private readonly estimateRecordBytes: (record: LogChunkRecord) => number;

  constructor(options: BufferedLogChunkFlushWorkerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.estimateRecordBytes = options.estimateRecordBytes ?? defaultEstimateRecordBytes;
  }

  async add(input: BufferedLogChunkRecordInput): Promise<FlushLogChunkAndEnqueueResult[]> {
    const now = input.now ?? this.now();
    const key = bufferedLogChunkGroupKey(input.group);
    const state =
      this.groups.get(key) ??
      ({
        group: input.group,
        records: [],
        pendingBytes: 0,
        oldestPendingAt: null,
      } satisfies BufferedLogChunkGroupState);

    state.group = input.group;
    state.records.push(input.record);
    state.pendingBytes += input.estimatedBytes ?? this.estimateRecordBytes(input.record);
    state.oldestPendingAt = state.oldestPendingAt ?? input.record.eventAt ?? now;
    this.groups.set(key, state);

    return this.flushGroupIfDue(key, now);
  }

  async addMany(
    group: BufferedLogChunkFlushGroup,
    records: readonly LogChunkRecord[],
    options: { now?: number } = {}
  ): Promise<FlushLogChunkAndEnqueueResult[]> {
    const results: FlushLogChunkAndEnqueueResult[] = [];
    for (const record of records) {
      results.push(...(await this.add({ group, record, now: options.now })));
    }
    return results;
  }

  async flushDue(now: number = this.now()): Promise<FlushLogChunkAndEnqueueResult[]> {
    const results: FlushLogChunkAndEnqueueResult[] = [];
    for (const key of [...this.groups.keys()]) {
      results.push(...(await this.flushGroupIfDue(key, now)));
    }
    return results;
  }

  async flushAll(now: number = this.now()): Promise<FlushLogChunkAndEnqueueResult[]> {
    const results: FlushLogChunkAndEnqueueResult[] = [];
    for (const key of [...this.groups.keys()]) {
      const flushed = await this.flushGroup(key, now);
      if (flushed) {
        results.push(flushed);
      }
    }
    return results;
  }

  pendingGroupCount(): number {
    return this.groups.size;
  }

  pendingRecordCount(): number {
    let count = 0;
    for (const state of this.groups.values()) {
      count += state.records.length;
    }
    return count;
  }

  private resolveProfile(state: BufferedLogChunkGroupState): LogChunkFlushProfile {
    return (
      state.group.profile ??
      resolveLogChunkFlushProfile({
        logType: state.group.logType,
        plane: state.group.plane,
        estimatedRecordsPerMinute: state.group.estimatedRecordsPerMinute,
      })
    );
  }

  private async flushGroupIfDue(
    key: string,
    now: number
  ): Promise<FlushLogChunkAndEnqueueResult[]> {
    const state = this.groups.get(key);
    if (!state) {
      return [];
    }
    const profile = this.resolveProfile(state);
    if (
      !shouldFlushLogChunk({
        profile,
        pendingRecords: state.records.length,
        pendingBytes: state.pendingBytes,
        oldestPendingAt: state.oldestPendingAt,
        now,
      })
    ) {
      return [];
    }
    const result = await this.flushGroup(key, now, profile);
    return result ? [result] : [];
  }

  private async flushGroup(
    key: string,
    now: number,
    profile?: LogChunkFlushProfile
  ): Promise<FlushLogChunkAndEnqueueResult | null> {
    const state = this.groups.get(key);
    if (!state || state.records.length === 0) {
      return null;
    }
    const flushProfile = profile ?? this.resolveProfile(state);
    this.groups.delete(key);
    try {
      return await flushLogChunkAndEnqueueDelivery({
        bucket: state.group.bucket,
        tenantKey: state.group.tenantKey,
        logType: state.group.logType,
        plane: state.group.plane,
        records: state.records,
        destinations: state.group.destinations,
        queueBindings: state.group.queueBindings,
        prefix: state.group.prefix,
        surface: state.group.surface,
        indexProfile: state.group.indexProfile,
        compression: state.group.compression ?? flushProfile.compression,
        now,
        catalogStore: state.group.catalogStore,
      });
    } catch (error) {
      this.groups.set(key, state);
      throw error;
    }
  }
}
