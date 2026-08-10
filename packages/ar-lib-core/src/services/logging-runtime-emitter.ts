import type { Queue } from '@cloudflare/workers-types';
import {
  createLoggingId,
  formatUtcPartition,
  type LogPlane,
  type LogType,
} from '@authrim/ar-lib-logging/contract';
import { buildArchiveLogRecordV1 } from '@authrim/ar-lib-logging/archive';
import {
  writeLogChunkToR2,
  type LogChunkEncryptionOptions,
  type WriteLogChunkResult,
} from '@authrim/ar-lib-logging/chunks';
import {
  SqlLoggingDeliveryEventStore,
  type LoggingDeliveryLane,
  type LoggingDeliveryQueuePayload,
  type LoggingDeliveryStatus,
} from '@authrim/ar-lib-logging/delivery';
import { laneForLogPolicy } from '@authrim/ar-lib-logging/policies';
import { ensureDatabaseAdapter, type DatabaseSource } from '../db';
import { SqlLogChunkCatalogStore } from './audit/logging-catalog-store';
import { resolveAuditTenantKey, type TenantKeyResolver } from './audit/tenant-key';
import {
  resolveRuntimeLoggingPolicyTargetFromEnv,
  type RuntimeLoggingDestinationTarget,
  type RuntimeLoggingPolicyResolution,
} from './logging-runtime-policy';

export interface RuntimeLogEmitterEnv {
  DB_ADMIN?: DatabaseSource | null;
  LOGGING_INDEX_DB?: DatabaseSource | null;
  AUTHRIM_CONFIG?: KVNamespace;
  DIAGNOSTIC_LOGS?: R2Bucket;
  SENSITIVE_DETAILS?: R2Bucket;
  AUDIT_ARCHIVE?: R2Bucket;
  LOGGING_DELIVERY_CRITICAL_QUEUE?: Queue<unknown>;
  LOGGING_DELIVERY_QUEUE?: Queue<unknown>;
  LOGGING_DELIVERY_BULK_QUEUE?: Queue<unknown>;
  LOGGING_TENANT_KEY_SALT?: string;
  OBJECT_ENCRYPTION_ROOT_KEY?: string;
  OBJECT_ENCRYPTION_KEY_VERSION?: string;
}

export interface RuntimeLogRecord {
  id: string;
  eventAt: number;
  type?: string;
  source?: string;
  severity?: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  schemaVersion?: string;
  subject?: string | null;
  correlationId?: string | null;
  payload: Record<string, unknown>;
  indexedFields?: Record<string, unknown>;
}

type RuntimeLogSeverity = NonNullable<RuntimeLogRecord['severity']>;

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(normalized)) {
    throw new Error('object_encryption_root_key_must_be_32_bytes_hex');
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

async function deriveRuntimeLogChunkEncryptionKey(input: {
  rootKeyHex: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  keyVersion: number;
}): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    hexToBytes(input.rootKeyHex),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-log-chunk-archive-encryption'),
      info: new TextEncoder().encode(
        `${input.tenantKey}:${input.logType}:${input.plane}:v${input.keyVersion}`
      ),
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

async function resolveRuntimeLogChunkEncryption(input: {
  env: RuntimeLogEmitterEnv;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
}): Promise<LogChunkEncryptionOptions> {
  if (!input.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    throw new Error('runtime_log_chunk_encryption_root_key_unavailable');
  }
  const keyVersion = Number.parseInt(input.env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1', 10);
  const normalizedKeyVersion = Number.isFinite(keyVersion) && keyVersion > 0 ? keyVersion : 1;
  return {
    keyBytes: await deriveRuntimeLogChunkEncryptionKey({
      rootKeyHex: input.env.OBJECT_ENCRYPTION_ROOT_KEY,
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      keyVersion: normalizedKeyVersion,
    }),
    encryptionScope: `tenant:${input.tenantKey}:${input.logType}:${input.plane}`,
    keyVersion: normalizedKeyVersion,
  };
}

export interface RuntimeLogEmitInput {
  env: RuntimeLogEmitterEnv;
  tenantId: string;
  logType: LogType;
  surface: string;
  records: RuntimeLogRecord[];
  planes?: LogPlane[];
  region?: string | null;
  tenantKeyResolver?: TenantKeyResolver;
}

export interface RuntimeLogEmitTargetResult {
  plane: LogPlane;
  destinationId: string | null;
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus | 'skipped';
  objectCatalogId?: string | null;
  queued?: boolean;
  error?: string;
}

export interface RuntimeLogEmitResult {
  tenantKey: string;
  targetResults: RuntimeLogEmitTargetResult[];
}

type RuntimeLoggingDeliveryQueueBindingName =
  | 'LOGGING_DELIVERY_CRITICAL_QUEUE'
  | 'LOGGING_DELIVERY_QUEUE'
  | 'LOGGING_DELIVERY_BULK_QUEUE';

const DELIVERY_QUEUE_BINDINGS: Record<
  LoggingDeliveryLane,
  {
    primary: RuntimeLoggingDeliveryQueueBindingName;
    fallback: RuntimeLoggingDeliveryQueueBindingName[];
  }
> = {
  critical: {
    primary: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
    fallback: ['LOGGING_DELIVERY_QUEUE'],
  },
  default: {
    primary: 'LOGGING_DELIVERY_QUEUE',
    fallback: [],
  },
  bulk: {
    primary: 'LOGGING_DELIVERY_BULK_QUEUE',
    fallback: ['LOGGING_DELIVERY_QUEUE'],
  },
};

interface RuntimeDeliveryEnqueueResult {
  queued: boolean;
  bindingName: RuntimeLoggingDeliveryQueueBindingName | null;
  fallbackUsed: boolean;
  attemptedBindingNames: RuntimeLoggingDeliveryQueueBindingName[];
  payloadId: string;
  byteCount: number;
}

interface RuntimePolicyDeliveryMetadata {
  selectedDestinationId: string | null;
  effectiveDestinationId: string | null;
  fallbackDestinationId: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  failureMode: string | null;
  policySource: string | null;
  policyWarnings: string[];
}

function isQueueLike(value: unknown): value is Queue<unknown> {
  return (
    !!value && typeof value === 'object' && typeof (value as Queue<unknown>).send === 'function'
  );
}

function getBucketBinding(env: RuntimeLogEmitterEnv, bindingRef: string): R2Bucket | null {
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  return value && typeof value === 'object' && typeof (value as R2Bucket).put === 'function'
    ? (value as R2Bucket)
    : null;
}

function getDefaultDeliveryPayloadBucket(env: RuntimeLogEmitterEnv): R2Bucket | null {
  return env.AUDIT_ARCHIVE ?? null;
}

function cleanR2ObjectKeySegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._=-]/g, '_').slice(0, 128) || 'unknown';
}

async function enqueueDeliveryPayload(
  env: RuntimeLogEmitterEnv,
  payload: LoggingDeliveryQueuePayload
): Promise<RuntimeDeliveryEnqueueResult> {
  const profile = DELIVERY_QUEUE_BINDINGS[payload.lane];
  const attemptedBindingNames = [profile.primary, ...profile.fallback];
  for (const bindingName of attemptedBindingNames) {
    const queue = (env as unknown as Record<string, unknown>)[bindingName];
    if (!isQueueLike(queue)) {
      continue;
    }
    await queue.send(payload);
    return {
      queued: true,
      bindingName,
      fallbackUsed: bindingName !== profile.primary,
      attemptedBindingNames,
      payloadId: payload.payload_id,
      byteCount: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    };
  }

  return {
    queued: false,
    bindingName: null,
    fallbackUsed: false,
    attemptedBindingNames,
    payloadId: payload.payload_id,
    byteCount: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
  };
}

function statusForEnqueueResult(
  result: RuntimeDeliveryEnqueueResult | null
): LoggingDeliveryStatus {
  if (!result) {
    return 'delivered';
  }
  return result.queued ? 'queued' : 'retrying';
}

function canonicalRecord(input: {
  tenantId: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface: string;
  record: RuntimeLogRecord;
  target: RuntimeLoggingDestinationTarget;
}) {
  const severity = normalizeRuntimeLogSeverity(
    input.record.severity ??
      stringField(input.record.indexedFields, 'severity') ??
      input.record.payload.severity
  );
  return buildArchiveLogRecordV1({
    id: input.record.id,
    type: input.record.type ?? inferRuntimeLogType(input.logType, input.surface, input.record),
    source: input.record.source ?? `authrim/${input.surface}`,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane === 'external_sink' || input.plane === 'archive' ? input.plane : 'archive',
    surface: input.surface,
    eventAt: input.record.eventAt,
    severity,
    subject: input.record.subject ?? inferRuntimeLogSubject(input.record),
    correlationId: input.record.correlationId ?? inferRuntimeLogCorrelationId(input.record),
    summary: {
      ...input.record.payload,
      ...(input.record.schemaVersion
        ? { producer_schema_version: input.record.schemaVersion }
        : {}),
    },
    delivery: {
      targetType: input.target.type,
      destinationId: input.target.destinationId,
    },
  });
}

function canonicalBatch(input: {
  tenantId: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface: string;
  records: RuntimeLogRecord[];
  target: RuntimeLoggingDestinationTarget;
}) {
  return {
    id: createLoggingId('evt', Date.now()),
    type: `${input.logType}.batch`,
    source: `authrim/${input.surface}`,
    tenantId: input.tenantId,
    time: new Date().toISOString(),
    severity: highestRuntimeLogSeverity(input.records),
    schemaVersion: '2026-05-19',
    subject: input.surface,
    correlationId: firstRuntimeLogCorrelationId(input.records),
    data: {
      records: input.records.map((record) =>
        canonicalRecord({
          ...input,
          record,
        })
      ),
    },
    authrim: {
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      surface: input.surface,
      delivery: {
        targetType: input.target.type,
        destinationId: input.target.destinationId,
      },
    },
  };
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeRuntimeLogSeverity(value: unknown): RuntimeLogSeverity {
  return value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'critical'
    ? value
    : 'info';
}

function inferRuntimeLogType(logType: LogType, surface: string, record: RuntimeLogRecord): string {
  return (
    stringField(record.payload, 'type') ??
    stringField(record.payload, 'event_type') ??
    stringField(record.indexedFields, 'eventType') ??
    stringField(record.payload, 'action') ??
    `${logType}.${surface}`
  );
}

function inferRuntimeLogSubject(record: RuntimeLogRecord): string | null {
  return (
    stringField(record.indexedFields, 'subject') ??
    stringField(record.payload, 'subject') ??
    stringField(record.payload, 'resource_id') ??
    stringField(record.payload, 'resourceId')
  );
}

function inferRuntimeLogCorrelationId(record: RuntimeLogRecord): string | null {
  return (
    stringField(record.payload, 'correlation_id') ??
    stringField(record.payload, 'correlationId') ??
    stringField(record.payload, 'request_id') ??
    stringField(record.payload, 'requestId') ??
    stringField(record.indexedFields, 'correlationId')
  );
}

const SEVERITY_RANK: Record<RuntimeLogSeverity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

function highestRuntimeLogSeverity(records: RuntimeLogRecord[]): RuntimeLogSeverity {
  return records.reduce<RuntimeLogSeverity>((highest, record) => {
    const severity = normalizeRuntimeLogSeverity(
      record.severity ?? stringField(record.indexedFields, 'severity') ?? record.payload.severity
    );
    return SEVERITY_RANK[severity] > SEVERITY_RANK[highest] ? severity : highest;
  }, 'info');
}

function firstRuntimeLogCorrelationId(records: RuntimeLogRecord[]): string | null {
  for (const record of records) {
    const correlationId = record.correlationId ?? inferRuntimeLogCorrelationId(record);
    if (correlationId) {
      return correlationId;
    }
  }
  return null;
}

function deliveryMetadataFromPolicyResolution(
  resolved: RuntimeLoggingPolicyResolution | null | undefined
): RuntimePolicyDeliveryMetadata {
  const effectiveDestinationId = resolved?.destinationId ?? resolved?.fallbackDestinationId ?? null;
  const fallbackUsed =
    !!resolved?.fallbackDestinationId &&
    resolved.fallbackDestinationId === effectiveDestinationId &&
    resolved.selectedDestinationId !== resolved.fallbackDestinationId;
  return {
    selectedDestinationId: resolved?.selectedDestinationId ?? null,
    effectiveDestinationId,
    fallbackDestinationId: fallbackUsed ? (resolved?.fallbackDestinationId ?? null) : null,
    fallbackUsed,
    fallbackReason: fallbackUsed
      ? resolved?.warnings.includes('destination_unusable')
        ? 'destination_unusable'
        : 'no_primary_destination'
      : null,
    failureMode: resolved?.failureMode ?? null,
    policySource: resolved?.source ?? null,
    policyWarnings: resolved?.warnings ?? [],
  };
}

function policyDeliveryMetadataObject(
  metadata: RuntimePolicyDeliveryMetadata
): Record<string, unknown> {
  return {
    selected_destination_id: metadata.selectedDestinationId,
    effective_destination_id: metadata.effectiveDestinationId,
    fallback_destination_id: metadata.fallbackDestinationId,
    fallback_used: metadata.fallbackUsed,
    fallback_reason: metadata.fallbackReason,
    failure_mode: metadata.failureMode,
    policy_source: metadata.policySource,
    policy_warnings: metadata.policyWarnings,
  };
}

async function recordDeliveryEvent(input: {
  env: RuntimeLogEmitterEnv;
  tenantKey: string;
  destinationId: string | null;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
  objectCatalogId?: string | null;
  recordCount: number;
  byteCount?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!input.env.DB_ADMIN) {
    return;
  }
  const store = new SqlLoggingDeliveryEventStore(
    ensureDatabaseAdapter(input.env.DB_ADMIN, 'logging-runtime-emitter')
  );
  await store.insertEvent({
    tenantKey: input.tenantKey,
    destinationId: input.destinationId,
    logType: input.logType,
    plane: input.plane,
    lane: input.lane,
    status: input.status,
    objectCatalogId: input.objectCatalogId,
    metadata: {
      record_count: input.recordCount,
      ...(input.byteCount !== undefined ? { byte_count: input.byteCount } : {}),
      ...(input.metadata ?? {}),
    },
  });
}

async function emitArchiveChunk(input: {
  env: RuntimeLogEmitterEnv;
  tenantId: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface: string;
  lane: LoggingDeliveryLane;
  target: Extract<RuntimeLoggingDestinationTarget, { type: 'r2' }>;
  policyMetadata: RuntimePolicyDeliveryMetadata;
  records: RuntimeLogRecord[];
}): Promise<RuntimeLogEmitTargetResult> {
  const bucket = getBucketBinding(input.env, input.target.bucketRef);
  if (!bucket) {
    throw new Error(`runtime_log_archive_bucket_unavailable:${input.target.bucketRef}`);
  }
  const catalogStoreDb = input.env.LOGGING_INDEX_DB ?? input.env.DB_ADMIN;
  const catalogStore = catalogStoreDb ? new SqlLogChunkCatalogStore(catalogStoreDb) : undefined;
  const result: WriteLogChunkResult = await writeLogChunkToR2({
    bucket,
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    surface: input.surface,
    prefix: input.target.prefix ?? input.logType,
    indexProfile: input.logType,
    catalogStore,
    records: input.records.map((record) => ({
      id: record.id,
      eventAt: record.eventAt,
      payload: canonicalRecord({
        tenantId: input.tenantId,
        tenantKey: input.tenantKey,
        logType: input.logType,
        plane: input.plane,
        surface: input.surface,
        record,
        target: input.target,
      }),
      indexedFields: record.indexedFields,
    })),
    encryption: await resolveRuntimeLogChunkEncryption({
      env: input.env,
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
    }),
  });
  const enqueueResult = await enqueueDeliveryPayload(input.env, {
    payload_type: 'delivery_fanout',
    schema_version: 1,
    payload_id: `qpl_${crypto.randomUUID()}`,
    tenant_key: input.tenantKey,
    lane: input.lane,
    created_at: result.createdAt,
    catalog_id: result.objectCatalogId,
    object_key: result.objectKey,
    destination_id: input.target.destinationId,
    log_type: input.logType,
    plane: input.plane,
    record_count: result.recordCount,
  });
  const status = statusForEnqueueResult(enqueueResult);
  await recordDeliveryEvent({
    env: input.env,
    tenantKey: input.tenantKey,
    destinationId: input.target.destinationId,
    logType: input.logType,
    plane: input.plane,
    lane: input.lane,
    status,
    objectCatalogId: result.objectCatalogId,
    recordCount: result.recordCount,
    byteCount: result.byteCount,
    metadata: {
      chunk_id: result.chunkId,
      ...policyDeliveryMetadataObject(input.policyMetadata),
      delivery_queue_binding: enqueueResult.bindingName,
      delivery_queue_fallback_used: enqueueResult.fallbackUsed,
      delivery_queue_attempted_bindings: enqueueResult.attemptedBindingNames,
    },
  });
  return {
    plane: input.plane,
    destinationId: input.target.destinationId,
    lane: input.lane,
    status,
    objectCatalogId: result.objectCatalogId,
    queued: enqueueResult.queued,
  };
}

async function emitHttpBatch(input: {
  env: RuntimeLogEmitterEnv;
  tenantId: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  surface: string;
  lane: LoggingDeliveryLane;
  target: Extract<RuntimeLoggingDestinationTarget, { type: 'http' }>;
  policyMetadata: RuntimePolicyDeliveryMetadata;
  records: RuntimeLogRecord[];
}): Promise<RuntimeLogEmitTargetResult> {
  const endpointUrl =
    input.target.url ??
    ((input.target.urlRef
      ? (input.env as unknown as Record<string, unknown>)[input.target.urlRef]
      : undefined) as string | undefined);
  if (!endpointUrl) {
    throw new Error(`runtime_log_http_sink_url_unresolved:${input.target.urlRef ?? 'missing_url'}`);
  }
  const bucket = getDefaultDeliveryPayloadBucket(input.env);
  if (!bucket) {
    throw new Error('runtime_log_delivery_payload_bucket_unavailable');
  }
  const now = Date.now();
  const payloadId = `qpl_${crypto.randomUUID()}`;
  const batchId = `batch_${crypto.randomUUID()}`;
  const partition = formatUtcPartition(now);
  const objectKey = [
    'logging-delivery-payloads/v1',
    cleanR2ObjectKeySegment(input.tenantKey),
    partition.year,
    partition.month,
    partition.day,
    partition.hour,
    `${cleanR2ObjectKeySegment(payloadId)}.json`,
  ].join('/');
  const body = JSON.stringify(
    canonicalBatch({
      tenantId: input.tenantId,
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      surface: input.surface,
      records: input.records,
      target: input.target,
    })
  );
  await bucket.put(objectKey, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      recordCount: String(input.records.length),
      payloadId,
      batchId,
      createdAt: String(now),
    },
  });
  const enqueueResult = await enqueueDeliveryPayload(input.env, {
    payload_type: 'http_sink_batch',
    schema_version: 1,
    payload_id: payloadId,
    tenant_key: input.tenantKey,
    lane: input.lane,
    created_at: now,
    destination_id: input.target.destinationId,
    endpoint_url: endpointUrl,
    log_type: input.logType,
    plane: input.plane,
    batch_id: batchId,
    record_count: input.records.length,
    body_object_ref: `r2://${objectKey}`,
  });
  const status = statusForEnqueueResult(enqueueResult);
  await recordDeliveryEvent({
    env: input.env,
    tenantKey: input.tenantKey,
    destinationId: input.target.destinationId,
    logType: input.logType,
    plane: input.plane,
    lane: input.lane,
    status,
    recordCount: input.records.length,
    byteCount: enqueueResult.byteCount,
    metadata: {
      payload_id: payloadId,
      batch_id: batchId,
      body_object_ref: `r2://${objectKey}`,
      ...policyDeliveryMetadataObject(input.policyMetadata),
      delivery_queue_binding: enqueueResult.bindingName,
      delivery_queue_fallback_used: enqueueResult.fallbackUsed,
      delivery_queue_attempted_bindings: enqueueResult.attemptedBindingNames,
    },
  });
  return {
    plane: input.plane,
    destinationId: input.target.destinationId,
    lane: input.lane,
    status,
    queued: enqueueResult.queued,
  };
}

function unsupportedTargetResult(input: {
  plane: LogPlane;
  destinationId: string | null;
  lane: LoggingDeliveryLane;
  targetType?: string;
}): RuntimeLogEmitTargetResult {
  return {
    plane: input.plane,
    destinationId: input.destinationId,
    lane: input.lane,
    status: 'skipped',
    error: `unsupported_runtime_log_target:${input.targetType ?? 'missing'}`,
  };
}

async function handleMissingOrInvalidCriticalTarget(input: {
  env: RuntimeLogEmitterEnv;
  tenantKey: string;
  plane: LogPlane;
  destinationId: string | null;
  logType: LogType;
  lane: LoggingDeliveryLane;
  recordCount: number;
  error: string;
  policyMetadata: RuntimePolicyDeliveryMetadata;
}): Promise<never> {
  await recordDeliveryEvent({
    env: input.env,
    tenantKey: input.tenantKey,
    destinationId: input.destinationId,
    logType: input.logType,
    plane: input.plane,
    lane: input.lane,
    status: 'retrying',
    recordCount: input.recordCount,
    metadata: {
      error: input.error,
      ...policyDeliveryMetadataObject(input.policyMetadata),
    },
  });
  throw new Error(input.error);
}

export async function emitRuntimeLogRecords(
  input: RuntimeLogEmitInput
): Promise<RuntimeLogEmitResult> {
  if (input.records.length === 0) {
    return { tenantKey: '', targetResults: [] };
  }
  const tenantKey = await resolveAuditTenantKey(input.tenantId, {
    tenantKeySalt: input.env.LOGGING_TENANT_KEY_SALT,
    tenantKeyResolver: input.tenantKeyResolver,
  });
  const targetResults: RuntimeLogEmitTargetResult[] = [];
  const planes = input.planes ?? (['archive', 'external_sink'] as LogPlane[]);

  for (const plane of planes) {
    const resolved = await resolveRuntimeLoggingPolicyTargetFromEnv(input.env, {
      tenantId: input.tenantId,
      logType: input.logType,
      plane,
      region: input.region,
    });
    const lane = resolved?.lane ?? laneForLogPolicy(input.logType, plane);
    const policyMetadata = deliveryMetadataFromPolicyResolution(resolved);
    if (!resolved?.target) {
      if (lane === 'critical') {
        await handleMissingOrInvalidCriticalTarget({
          env: input.env,
          tenantKey,
          plane,
          destinationId: resolved?.destinationId ?? resolved?.fallbackDestinationId ?? null,
          logType: input.logType,
          lane,
          recordCount: input.records.length,
          error: 'runtime_log_critical_target_not_configured',
          policyMetadata,
        });
      }
      targetResults.push({
        plane,
        destinationId: resolved?.destinationId ?? resolved?.fallbackDestinationId ?? null,
        lane,
        status: 'skipped',
        error: 'runtime_log_target_not_configured',
      });
      continue;
    }

    if (resolved.target.type === 'r2') {
      targetResults.push(
        await emitArchiveChunk({
          env: input.env,
          tenantId: input.tenantId,
          tenantKey,
          logType: input.logType,
          plane,
          surface: input.surface,
          lane,
          target: resolved.target,
          policyMetadata,
          records: input.records,
        })
      );
      continue;
    }
    if (resolved.target.type === 'http') {
      targetResults.push(
        await emitHttpBatch({
          env: input.env,
          tenantId: input.tenantId,
          tenantKey,
          logType: input.logType,
          plane,
          surface: input.surface,
          lane,
          target: resolved.target,
          policyMetadata,
          records: input.records,
        })
      );
      continue;
    }
    if (lane === 'critical') {
      await handleMissingOrInvalidCriticalTarget({
        env: input.env,
        tenantKey,
        plane,
        destinationId: resolved.destinationId ?? resolved.fallbackDestinationId,
        logType: input.logType,
        lane,
        recordCount: input.records.length,
        error: `runtime_log_critical_target_unsupported:${resolved.target.type}`,
        policyMetadata,
      });
    }
    targetResults.push(
      unsupportedTargetResult({
        plane,
        destinationId: resolved.destinationId ?? resolved.fallbackDestinationId,
        lane,
        targetType: resolved.target.type,
      })
    );
  }

  return { tenantKey, targetResults };
}
