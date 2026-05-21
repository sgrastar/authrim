import { LOG_PLANES, LOG_TYPES, type LogPlane, type LogType } from '../registry';
import type { LoggingDeliveryLane } from './types';

export type LoggingDeliveryPayloadType =
  | 'chunk_write'
  | 'delivery_fanout'
  | 'log_chunk_delivery'
  | 'http_sink_batch'
  | 'dlq_replay'
  | 'rewrap_chunk';

export interface LoggingDeliveryQueueEnvelope {
  payload_type: LoggingDeliveryPayloadType;
  schema_version: number;
  payload_id: string;
  tenant_key: string;
  lane: LoggingDeliveryLane;
  created_at: number;
}

export interface ChunkWritePayload extends LoggingDeliveryQueueEnvelope {
  payload_type: 'chunk_write';
  schema_version: 1;
  log_type: LogType;
  plane: LogPlane;
  records: unknown[];
  records_object_ref?: string;
}

export interface LogChunkDeliveryPayload extends LoggingDeliveryQueueEnvelope {
  payload_type: 'log_chunk_delivery';
  schema_version: 1;
  catalog_id: string;
  object_key: string;
  destination_id: string;
  log_type: LogType;
  plane: LogPlane;
  record_count: number;
}

export interface DeliveryFanoutPayload extends LoggingDeliveryQueueEnvelope {
  payload_type: 'delivery_fanout';
  schema_version: 1;
  catalog_id: string;
  object_key: string;
  destination_id: string;
  log_type: LogType;
  plane: LogPlane;
  record_count: number;
}

export interface HttpSinkBatchPayload extends LoggingDeliveryQueueEnvelope {
  payload_type: 'http_sink_batch';
  schema_version: 1;
  destination_id: string;
  endpoint_url: string;
  log_type: LogType;
  plane: LogPlane;
  batch_id: string;
  record_count: number;
  body_object_ref?: string;
}

export interface DlqReplayPayload extends LoggingDeliveryQueueEnvelope {
  payload_type: 'dlq_replay';
  schema_version: 1;
  dlq_item_id: string;
  requested_by: string;
}

export interface RewrapChunkPayload extends LoggingDeliveryQueueEnvelope {
  payload_type: 'rewrap_chunk';
  schema_version: 1;
  rewrap_job_id: string;
  object_catalog_id: string;
}

export type LoggingDeliveryQueuePayload =
  | ChunkWritePayload
  | DeliveryFanoutPayload
  | LogChunkDeliveryPayload
  | HttpSinkBatchPayload
  | DlqReplayPayload
  | RewrapChunkPayload;

export type LoggingDeliveryQueuePayloadParseResult =
  | { ok: true; payload: LoggingDeliveryQueuePayload }
  | {
      ok: false;
      reason: 'malformed' | 'unsupported_schema';
      payloadType?: string;
      schemaVersion?: number;
      payloadId?: string;
      tenantKey?: string;
      lane?: LoggingDeliveryLane;
      createdAt?: number;
    };

export const SUPPORTED_LOGGING_DELIVERY_PAYLOAD_SCHEMAS: Record<
  LoggingDeliveryPayloadType,
  readonly number[]
> = {
  chunk_write: [1],
  delivery_fanout: [1],
  log_chunk_delivery: [1],
  http_sink_batch: [1],
  dlq_replay: [1],
  rewrap_chunk: [1],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasBaseEnvelope(value: Record<string, unknown>): boolean {
  return (
    typeof value.payload_type === 'string' &&
    Number.isInteger(value.schema_version) &&
    typeof value.payload_id === 'string' &&
    typeof value.tenant_key === 'string' &&
    (value.lane === 'critical' || value.lane === 'default' || value.lane === 'bulk') &&
    typeof value.created_at === 'number' &&
    Number.isFinite(value.created_at)
  );
}

function payloadSchemaIsSupported(payloadType: string, schemaVersion: number): boolean {
  return (
    payloadType in SUPPORTED_LOGGING_DELIVERY_PAYLOAD_SCHEMAS &&
    SUPPORTED_LOGGING_DELIVERY_PAYLOAD_SCHEMAS[payloadType as LoggingDeliveryPayloadType].includes(
      schemaVersion
    )
  );
}

function hasPayloadSpecificFields(value: Record<string, unknown>): boolean {
  if (value.payload_type === 'chunk_write') {
    return (
      typeof value.log_type === 'string' &&
      (LOG_TYPES as readonly string[]).includes(value.log_type) &&
      typeof value.plane === 'string' &&
      (LOG_PLANES as readonly string[]).includes(value.plane) &&
      Array.isArray(value.records) &&
      (value.records_object_ref === undefined || typeof value.records_object_ref === 'string')
    );
  }
  if (value.payload_type === 'delivery_fanout' || value.payload_type === 'log_chunk_delivery') {
    return (
      typeof value.catalog_id === 'string' &&
      typeof value.object_key === 'string' &&
      typeof value.destination_id === 'string' &&
      typeof value.log_type === 'string' &&
      (LOG_TYPES as readonly string[]).includes(value.log_type) &&
      typeof value.plane === 'string' &&
      (LOG_PLANES as readonly string[]).includes(value.plane) &&
      typeof value.record_count === 'number'
    );
  }
  if (value.payload_type === 'http_sink_batch') {
    return (
      typeof value.destination_id === 'string' &&
      typeof value.endpoint_url === 'string' &&
      typeof value.log_type === 'string' &&
      (LOG_TYPES as readonly string[]).includes(value.log_type) &&
      typeof value.plane === 'string' &&
      (LOG_PLANES as readonly string[]).includes(value.plane) &&
      typeof value.batch_id === 'string' &&
      typeof value.record_count === 'number' &&
      (value.body_object_ref === undefined || typeof value.body_object_ref === 'string')
    );
  }
  if (value.payload_type === 'dlq_replay') {
    return typeof value.dlq_item_id === 'string' && typeof value.requested_by === 'string';
  }
  if (value.payload_type === 'rewrap_chunk') {
    return typeof value.rewrap_job_id === 'string' && typeof value.object_catalog_id === 'string';
  }
  return false;
}

export function parseLoggingDeliveryQueuePayload(
  value: unknown
): LoggingDeliveryQueuePayloadParseResult {
  if (!isObject(value) || !hasBaseEnvelope(value)) {
    return { ok: false, reason: 'malformed' };
  }

  const payloadType = value.payload_type as string;
  const schemaVersion = value.schema_version as number;
  const base = {
    payloadType,
    schemaVersion,
    payloadId: value.payload_id as string,
    tenantKey: value.tenant_key as string,
    lane: value.lane as LoggingDeliveryLane,
    createdAt: value.created_at as number,
  };
  if (!payloadSchemaIsSupported(payloadType, schemaVersion)) {
    return {
      ok: false,
      reason: 'unsupported_schema',
      ...base,
    };
  }

  if (!hasPayloadSpecificFields(value)) {
    return { ok: false, reason: 'malformed', ...base };
  }

  return { ok: true, payload: value as unknown as LoggingDeliveryQueuePayload };
}

export function shouldDlqUnsupportedQueuePayload(
  result: LoggingDeliveryQueuePayloadParseResult
): boolean {
  return !result.ok && result.reason === 'unsupported_schema';
}
