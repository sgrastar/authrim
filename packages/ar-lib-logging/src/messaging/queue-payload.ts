import {
  parseLoggingDeliveryQueuePayload,
  type LoggingDeliveryQueuePayload,
} from '../delivery/queue-payload';
import type { LoggingDeliveryLane } from '../delivery/types';

export type LoggingMessageQueuePayloadType = 'retry_delivery' | 'export_build';

export interface LoggingMessageQueueEnvelope {
  payload_type: LoggingMessageQueuePayloadType;
  schema_version: number;
  payload_id: string;
  message_job_id: string;
  tenant_key?: string | null;
  lane: LoggingDeliveryLane;
  created_at: number;
}

export interface RetryDeliveryMessagePayload extends LoggingMessageQueueEnvelope {
  payload_type: 'retry_delivery';
  schema_version: 1;
  source_type: 'dlq_item' | 'delivery_event' | 'payload_object';
  source_id: string;
  retry_id: string;
  idempotency_key: string;
  target_payload_hash: string;
  requested_by: string;
  reason?: string;
  replay_payload: LoggingDeliveryQueuePayload;
}

export interface ExportBuildMessagePayload extends LoggingMessageQueueEnvelope {
  payload_type: 'export_build';
  schema_version: 1;
  export_job_id: string;
  phase: 'plan' | 'build_partition' | 'finalize' | 'verify_manifest' | 'cleanup';
  partition_strategy?: 'time_bucket_shard' | 'query_page' | 'chunk_index' | 'manifest_shard';
  partition_key?: string | null;
  partition_index?: number;
  partition_count?: number;
  part_size?: number;
  cleanup_reason?: 'cancelled' | 'expired' | 'failed' | 'dangerous_repair' | 'manual';
  cleanup_object_refs?: string[];
  snapshot_cutoff_at: number;
  requested_by: string;
}

export type LoggingMessageQueuePayload = RetryDeliveryMessagePayload | ExportBuildMessagePayload;

export type LoggingMessageQueuePayloadParseResult =
  | { ok: true; payload: LoggingMessageQueuePayload }
  | {
      ok: false;
      reason: 'malformed' | 'unsupported_schema';
      payloadType?: string;
      schemaVersion?: number;
      payloadId?: string;
      messageJobId?: string;
    };

const SUPPORTED_LOGGING_MESSAGE_PAYLOAD_SCHEMAS: Record<
  LoggingMessageQueuePayloadType,
  readonly number[]
> = {
  retry_delivery: [1],
  export_build: [1],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasBaseEnvelope(value: Record<string, unknown>): boolean {
  return (
    typeof value.payload_type === 'string' &&
    Number.isInteger(value.schema_version) &&
    typeof value.payload_id === 'string' &&
    typeof value.message_job_id === 'string' &&
    (value.tenant_key === undefined || value.tenant_key === null || typeof value.tenant_key === 'string') &&
    (value.lane === 'critical' || value.lane === 'default' || value.lane === 'bulk') &&
    typeof value.created_at === 'number' &&
    Number.isFinite(value.created_at)
  );
}

function payloadSchemaIsSupported(payloadType: string, schemaVersion: number): boolean {
  return (
    payloadType in SUPPORTED_LOGGING_MESSAGE_PAYLOAD_SCHEMAS &&
    SUPPORTED_LOGGING_MESSAGE_PAYLOAD_SCHEMAS[
      payloadType as LoggingMessageQueuePayloadType
    ].includes(schemaVersion)
  );
}

function isOptionalIntegerAtLeast(value: unknown, minimum: number): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= minimum);
}

function isOptionalCleanupReason(value: unknown): boolean {
  return (
    value === undefined ||
    value === 'cancelled' ||
    value === 'expired' ||
    value === 'failed' ||
    value === 'dangerous_repair' ||
    value === 'manual'
  );
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function hasPayloadSpecificFields(value: Record<string, unknown>): boolean {
  if (value.payload_type === 'retry_delivery') {
    return (
      (value.source_type === 'dlq_item' ||
        value.source_type === 'delivery_event' ||
        value.source_type === 'payload_object') &&
      typeof value.source_id === 'string' &&
      typeof value.retry_id === 'string' &&
      typeof value.idempotency_key === 'string' &&
      typeof value.target_payload_hash === 'string' &&
      typeof value.requested_by === 'string' &&
      (value.reason === undefined || typeof value.reason === 'string') &&
      parseLoggingDeliveryQueuePayload(value.replay_payload).ok
    );
  }
  if (value.payload_type === 'export_build') {
    return (
      typeof value.export_job_id === 'string' &&
      (value.phase === 'plan' ||
        value.phase === 'build_partition' ||
        value.phase === 'finalize' ||
        value.phase === 'verify_manifest' ||
        value.phase === 'cleanup') &&
      (value.partition_strategy === undefined ||
        value.partition_strategy === 'time_bucket_shard' ||
        value.partition_strategy === 'query_page' ||
        value.partition_strategy === 'chunk_index' ||
        value.partition_strategy === 'manifest_shard') &&
      (value.partition_key === undefined ||
        value.partition_key === null ||
        typeof value.partition_key === 'string') &&
      isOptionalIntegerAtLeast(value.partition_index, 0) &&
      isOptionalIntegerAtLeast(value.partition_count, 1) &&
      isOptionalIntegerAtLeast(value.part_size, 1) &&
      isOptionalCleanupReason(value.cleanup_reason) &&
      isOptionalStringArray(value.cleanup_object_refs) &&
      typeof value.snapshot_cutoff_at === 'number' &&
      Number.isFinite(value.snapshot_cutoff_at) &&
      typeof value.requested_by === 'string'
    );
  }
  return false;
}

export function parseLoggingMessageQueuePayload(
  value: unknown
): LoggingMessageQueuePayloadParseResult {
  if (!isObject(value) || !hasBaseEnvelope(value)) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadType = value.payload_type as string;
  const schemaVersion = value.schema_version as number;
  const base = {
    payloadType,
    schemaVersion,
    payloadId: value.payload_id as string,
    messageJobId: value.message_job_id as string,
  };
  if (!payloadSchemaIsSupported(payloadType, schemaVersion)) {
    return { ok: false, reason: 'unsupported_schema', ...base };
  }
  if (!hasPayloadSpecificFields(value)) {
    return { ok: false, reason: 'malformed', ...base };
  }
  return { ok: true, payload: value as unknown as LoggingMessageQueuePayload };
}
