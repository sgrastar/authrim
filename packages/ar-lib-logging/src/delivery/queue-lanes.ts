import type { LoggingDeliveryLane } from './types';
import type { LoggingDeliveryQueuePayload } from './queue-payload';

export type LoggingDeliveryQueueBindingName =
  | 'LOGGING_DELIVERY_CRITICAL_QUEUE'
  | 'LOGGING_DELIVERY_QUEUE'
  | 'LOGGING_DELIVERY_BULK_QUEUE';

export interface LoggingDeliveryQueueLike<TPayload = unknown> {
  send(message: TPayload): Promise<unknown>;
  sendBatch?(messages: Array<{ body: TPayload }>): Promise<unknown>;
}

export interface LoggingDeliveryLaneProfile {
  lane: LoggingDeliveryLane;
  bindingName: LoggingDeliveryQueueBindingName;
  fallbackBindingNames: readonly LoggingDeliveryQueueBindingName[];
  priorityRank: number;
  maxBatchRecords: number;
  maxBatchBytes: number;
}

export interface LoggingDeliveryQueueResolution<TPayload = unknown> {
  lane: LoggingDeliveryLane;
  bindingName: LoggingDeliveryQueueBindingName;
  queue: LoggingDeliveryQueueLike<TPayload>;
  fallbackUsed: boolean;
  attemptedBindingNames: readonly LoggingDeliveryQueueBindingName[];
}

export interface LoggingDeliveryEnqueueResult {
  queued: boolean;
  lane: LoggingDeliveryLane;
  bindingName: LoggingDeliveryQueueBindingName | null;
  fallbackUsed: boolean;
  attemptedBindingNames: readonly LoggingDeliveryQueueBindingName[];
  payloadId: string;
  byteCount: number;
}

export const LOGGING_DELIVERY_LANE_PROFILES: Record<
  LoggingDeliveryLane,
  LoggingDeliveryLaneProfile
> = {
  critical: {
    lane: 'critical',
    bindingName: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
    fallbackBindingNames: ['LOGGING_DELIVERY_QUEUE'],
    priorityRank: 0,
    maxBatchRecords: 100,
    maxBatchBytes: 256 * 1024,
  },
  default: {
    lane: 'default',
    bindingName: 'LOGGING_DELIVERY_QUEUE',
    fallbackBindingNames: [],
    priorityRank: 1,
    maxBatchRecords: 500,
    maxBatchBytes: 512 * 1024,
  },
  bulk: {
    lane: 'bulk',
    bindingName: 'LOGGING_DELIVERY_BULK_QUEUE',
    fallbackBindingNames: ['LOGGING_DELIVERY_QUEUE'],
    priorityRank: 2,
    maxBatchRecords: 1000,
    maxBatchBytes: 1024 * 1024,
  },
};

export function getLoggingDeliveryLaneProfile(
  lane: LoggingDeliveryLane
): LoggingDeliveryLaneProfile {
  return LOGGING_DELIVERY_LANE_PROFILES[lane];
}

function isQueueLike<TPayload>(value: unknown): value is LoggingDeliveryQueueLike<TPayload> {
  return !!value && typeof value === 'object' && typeof (value as { send?: unknown }).send === 'function';
}

export function resolveLoggingDeliveryQueue<TPayload>(
  lane: LoggingDeliveryLane,
  bindings: Record<string, unknown>
): LoggingDeliveryQueueResolution<TPayload> | null {
  const profile = getLoggingDeliveryLaneProfile(lane);
  const attemptedBindingNames = [profile.bindingName, ...profile.fallbackBindingNames];

  for (const bindingName of attemptedBindingNames) {
    const queue = bindings[bindingName];
    if (isQueueLike<TPayload>(queue)) {
      return {
        lane,
        bindingName,
        queue,
        fallbackUsed: bindingName !== profile.bindingName,
        attemptedBindingNames,
      };
    }
  }

  return null;
}

export function orderLoggingDeliveryLanesByPriority(
  lanes: readonly LoggingDeliveryLane[]
): LoggingDeliveryLane[] {
  return [...lanes].sort(
    (left, right) =>
      getLoggingDeliveryLaneProfile(left).priorityRank -
      getLoggingDeliveryLaneProfile(right).priorityRank
  );
}

function estimatePayloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

export async function enqueueLoggingDeliveryPayload(
  payload: LoggingDeliveryQueuePayload,
  bindings: Record<string, unknown>
): Promise<LoggingDeliveryEnqueueResult> {
  const profile = getLoggingDeliveryLaneProfile(payload.lane);
  const byteCount = estimatePayloadBytes(payload);
  if (byteCount > profile.maxBatchBytes) {
    throw new Error(`logging_delivery_payload_too_large:${payload.lane}`);
  }

  const resolution = resolveLoggingDeliveryQueue<LoggingDeliveryQueuePayload>(
    payload.lane,
    bindings
  );
  if (!resolution) {
    return {
      queued: false,
      lane: payload.lane,
      bindingName: null,
      fallbackUsed: false,
      attemptedBindingNames: [profile.bindingName, ...profile.fallbackBindingNames],
      payloadId: payload.payload_id,
      byteCount,
    };
  }

  await resolution.queue.send(payload);
  return {
    queued: true,
    lane: payload.lane,
    bindingName: resolution.bindingName,
    fallbackUsed: resolution.fallbackUsed,
    attemptedBindingNames: resolution.attemptedBindingNames,
    payloadId: payload.payload_id,
    byteCount,
  };
}

export async function enqueueLoggingDeliveryPayloadBatch(
  payloads: readonly LoggingDeliveryQueuePayload[],
  bindings: Record<string, unknown>
): Promise<LoggingDeliveryEnqueueResult[]> {
  const ordered = [...payloads].sort(
    (left, right) =>
      getLoggingDeliveryLaneProfile(left.lane).priorityRank -
      getLoggingDeliveryLaneProfile(right.lane).priorityRank
  );
  const results: LoggingDeliveryEnqueueResult[] = [];
  for (const payload of ordered) {
    results.push(await enqueueLoggingDeliveryPayload(payload, bindings));
  }
  return results;
}
