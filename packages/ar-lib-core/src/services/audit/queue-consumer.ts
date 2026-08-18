/**
 * Audit Queue Consumer
 *
 * Cloudflare Queue consumer for processing audit log messages.
 * Features:
 * - Idempotent writes using portable insert-if-not-exists semantics
 * - Per-message ack/retry (not batch ack)
 * - DLQ fallback for max_retries exceeded
 */

import type { MessageBatch, Message, Queue } from '@cloudflare/workers-types';
import {
  createLoggingId,
  createUuidV7,
  deriveTenantKeyFromTenantId,
  formatUtcPartition,
  type LogChunkCompression,
  type LogPlane,
  type LogType,
} from '@authrim/ar-lib-logging/contract';
import {
  computeHttpSinkRetryDelayMs,
  deliverHttpSinkBatch,
  parseLoggingDeliveryQueuePayload,
  shouldDlqUnsupportedQueuePayload,
  SqlLoggingDeliveryEventStore,
  SqlLoggingDlqItemStore,
  type ChunkWritePayload,
  type DeliveryFanoutPayload,
  type HttpSinkAuthConfig,
  type HttpSinkBatchPayload,
  type HttpSinkDeliveryResult,
  type HttpSinkSignatureProfile,
  type HttpSinkSignatureProfileName,
  type HttpSinkSignatureValueFormat,
  type HttpSinkTimestampFormat,
  type DlqReplayPayload,
  type LogChunkDeliveryPayload,
  type LoggingDeliveryEventStore,
  type LoggingDeliveryLane,
  type LoggingDeliveryQueuePayload,
  type LoggingDeliveryQueuePayloadParseResult,
  type LoggingDeliveryStatus,
  type LoggingDlqItemStore,
  type RewrapChunkPayload,
} from '@authrim/ar-lib-logging/delivery';
import {
  buildLogChunkObjectKey,
  defaultLogStorageShard,
  rewrapLogChunkObject,
  writeLogChunkToR2,
  type LogChunkEncryptionOptions,
  type LogChunkRecord,
  type WriteLogChunkResult,
} from '@authrim/ar-lib-logging/chunks';
import {
  D1EncryptedCredentialSecretBackend,
  R2EncryptedCredentialSecretBackend,
  parseCredentialSecretRef,
} from '@authrim/ar-lib-logging/keys';
import { laneForLogPolicy } from '@authrim/ar-lib-logging/policies';
import { ensureDatabaseAdapter, type DatabaseSource } from '../../db';
import type { AuditTarget } from '../../types/runtime-profile';
import type { AuditQueueFanoutPlan, AuditQueueMessage, EventLogEntry, PIILogEntry } from './types';
import { sanitizeErrorMessage } from './utils';
import { createLogger, type Logger } from '../../utils/logger';
import { readR2ObjectTextWithLimit } from '../../utils/body-limits';
import { createAuditPrimaryStorageAdapter } from './external-primary';
import { resolveTenantRuntimeProfilesFromEnv } from '../runtime-profile-resolver';
import { PLATFORM_DEFAULT_R2_ARCHIVE_DESTINATION_ID } from '../logging-runtime-policy';
import {
  buildCanonicalAuditArchiveRecordFromEntry,
  buildCanonicalAuditBatch,
  buildCanonicalAuditRecord,
} from './canonical-format';
import { safeFetch } from '../../utils/url-security';
import { SqlLogChunkCatalogStore } from './logging-catalog-store';
import { decryptObjectArtifact, encryptObjectArtifact } from '../object-artifact-crypto';
import {
  InternalNotificationEventRepository,
  resolveLoggingNotificationRoutingPolicy,
} from '../../repositories/admin/internal-notification-event';

function fetchInputToUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

type QueueStableIdPrefix = 'chk' | 'obj' | 'dlq' | 'lde';

function queueMessageTimestamp(message: { timestamp?: Date }): number {
  const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : 0;
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
}

async function createQueueStableLoggingId(
  prefix: QueueStableIdPrefix,
  message: Pick<Message<unknown>, 'id' | 'timestamp'>,
  purpose: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${purpose}\u0000${message.id}`)
  );
  return `${prefix}_${createUuidV7(queueMessageTimestamp(message), new Uint8Array(digest).slice(0, 10))}`;
}

function getDefaultLoggingDeliveryPayloadBucket(env: AuditQueueConsumerEnv): R2Bucket | null {
  return env.AUDIT_ARCHIVE ?? null;
}

const LOGGING_DELIVERY_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;

async function readLoggingDeliveryPayloadObjectText(
  object: R2ObjectBody,
  errorPrefix: string
): Promise<{ text: string; byteCount: number }> {
  let text: string;
  try {
    text = await readR2ObjectTextWithLimit(object, LOGGING_DELIVERY_PAYLOAD_MAX_BYTES);
  } catch {
    throw new Error(`${errorPrefix}_too_large`);
  }
  const byteCount = new TextEncoder().encode(text).byteLength;
  return { text, byteCount };
}

function getChunkWriteBucket(env: AuditQueueConsumerEnv, plane: LogPlane): R2Bucket | null {
  if (plane === 'diagnostic_detail') {
    return env.DIAGNOSTIC_LOGS ?? null;
  }
  if (plane === 'sensitive_detail') {
    return env.SENSITIVE_DETAILS ?? null;
  }
  return env.AUDIT_ARCHIVE ?? null;
}

function normalizeR2ObjectRef(ref: string): string {
  if (!ref.startsWith('r2://')) {
    return ref;
  }
  return ref.slice('r2://'.length);
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function configString(config: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function configObject(
  config: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = config[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function cleanR2ObjectKeySegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._=-]/g, '_').slice(0, 128) || 'unknown';
}

function credentialBackendKindFromRef(ref: string): 'r2' | 'd1' | 'cf' | null {
  const parsed = parseCredentialSecretRef(ref);
  if (parsed.scheme === 'r2secret') {
    return 'r2';
  }
  if (parsed.scheme === 'd1secret') {
    return 'd1';
  }
  if (parsed.scheme === 'cfsecret') {
    return 'cf';
  }
  return null;
}

async function resolveRuntimeCredentialSecret(input: {
  env: AuditQueueConsumerEnv;
  credentialRef: string | null | undefined;
  credentialVersion: number | null | undefined;
}): Promise<string | null> {
  if (!input.credentialRef) {
    return null;
  }

  const cacheKey = `${input.credentialRef}:${input.credentialVersion ?? 'any'}`;
  const cached = runtimeCredentialCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.plaintext;
  }

  const backendKind = credentialBackendKindFromRef(input.credentialRef);
  let plaintext: string;
  if (backendKind === 'cf') {
    const parsed = parseCredentialSecretRef(input.credentialRef);
    const bindingName =
      parsed.authority === 'env'
        ? parsed.path.replace(/^\/+/, '')
        : parsed.authority || parsed.path.replace(/^\/+/, '');
    const value = (input.env as unknown as Record<string, unknown>)[bindingName];
    if (typeof value !== 'string' || !value) {
      throw new Error('runtime_credential_cfsecret_unavailable');
    }
    plaintext = value;
  } else {
    const rootKey = input.env.OBJECT_ENCRYPTION_ROOT_KEY;
    if (!rootKey) {
      throw new Error('runtime_credential_root_key_unavailable');
    }
    if (!input.env.DB_ADMIN) {
      throw new Error('runtime_credential_admin_db_unavailable');
    }
    const adapter = ensureDatabaseAdapter(input.env.DB_ADMIN, 'logging-runtime-credentials');
    if (backendKind === 'r2') {
      const bucket = input.env.SENSITIVE_DETAILS;
      if (!bucket) {
        throw new Error('runtime_credential_r2_bucket_unavailable');
      }
      const backend = new R2EncryptedCredentialSecretBackend({
        bucket,
        metadataStore: adapter,
        rootKeyHex: rootKey,
        bucketName: 'admin-secrets',
      });
      plaintext = (
        await backend.getSecret(input.credentialRef, input.credentialVersion ?? undefined)
      ).plaintext as string;
    } else if (backendKind === 'd1') {
      const backend = new D1EncryptedCredentialSecretBackend({
        store: adapter,
        rootKeyHex: rootKey,
      });
      plaintext = (
        await backend.getSecret(input.credentialRef, input.credentialVersion ?? undefined)
      ).plaintext as string;
    } else {
      throw new Error('runtime_credential_ref_unsupported');
    }
  }

  runtimeCredentialCache.set(cacheKey, {
    plaintext,
    expiresAt: Date.now() + RUNTIME_CREDENTIAL_CACHE_TTL_MS,
  });
  return plaintext;
}

function parseCredentialPlaintextJson(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function credentialString(
  credential: Record<string, unknown> | null,
  keys: string[],
  fallback: string | null
): string | null {
  for (const key of keys) {
    const value = credential?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function configSignatureProfileName(value: unknown): HttpSinkSignatureProfileName | undefined {
  if (value === 'authrim' || value === 'webhook_legacy' || value === 'custom') {
    return value;
  }
  return undefined;
}

function configTimestampFormat(value: unknown): HttpSinkTimestampFormat | undefined {
  if (value === 'unix_seconds' || value === 'iso8601') {
    return value;
  }
  return undefined;
}

function configSignatureValueFormat(value: unknown): HttpSinkSignatureValueFormat | undefined {
  if (value === 'sha256_hex' || value === 'hex') {
    return value;
  }
  return undefined;
}

function buildRuntimeHttpSinkSignatureProfile(
  providerConfig: Record<string, unknown>
): Partial<HttpSinkSignatureProfile> | undefined {
  const profileConfig = configObject(providerConfig, ['hmacProfile', 'hmac_profile']);
  const source = profileConfig ?? providerConfig;
  const name =
    configSignatureProfileName(providerConfig.headerProfile) ??
    configSignatureProfileName(providerConfig.header_profile) ??
    configSignatureProfileName(source.name);
  const profile: Partial<HttpSinkSignatureProfile> = {};
  if (name) {
    profile.name = name;
  }
  const signatureHeader = configString(source, ['signatureHeader', 'signature_header']);
  if (signatureHeader) {
    profile.signatureHeader = signatureHeader;
  }
  const timestampHeader = configString(source, ['timestampHeader', 'timestamp_header']);
  if (timestampHeader) {
    profile.timestampHeader = timestampHeader;
  }
  const deliveryIdHeader = configString(source, ['deliveryIdHeader', 'delivery_id_header']);
  if (deliveryIdHeader) {
    profile.deliveryIdHeader = deliveryIdHeader;
  }
  const signatureVersionHeader = configString(source, [
    'signatureVersionHeader',
    'signature_version_header',
  ]);
  if (signatureVersionHeader) {
    profile.signatureVersionHeader = signatureVersionHeader;
  }
  const signatureVersion = configString(source, ['signatureVersion', 'signature_version']);
  if (signatureVersion) {
    profile.signatureVersion = signatureVersion;
  }
  const timestampFormat = configTimestampFormat(source.timestampFormat ?? source.timestamp_format);
  if (timestampFormat) {
    profile.timestampFormat = timestampFormat;
  }
  const signatureValueFormat = configSignatureValueFormat(
    source.signatureValueFormat ?? source.signature_value_format
  );
  if (signatureValueFormat) {
    profile.signatureValueFormat = signatureValueFormat;
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

function buildRuntimeHttpSinkAuth(input: {
  providerConfig: Record<string, unknown>;
  credentialPlaintext: string | null;
}): HttpSinkAuthConfig {
  const credential = parseCredentialPlaintextJson(input.credentialPlaintext);
  const profile =
    configString(input.providerConfig, ['authProfile', 'auth_profile', 'authMode', 'auth_mode']) ??
    credentialString(credential, ['mode', 'authProfile', 'auth_profile'], null) ??
    (input.credentialPlaintext ? 'bearer' : 'none');

  if (profile === 'none' || !input.credentialPlaintext) {
    return { mode: 'none' };
  }
  if (profile === 'api_key') {
    return {
      mode: 'api_key',
      apiKey: {
        headerName:
          configString(input.providerConfig, ['apiKeyHeader', 'api_key_header', 'headerName']) ??
          credentialString(credential, ['headerName', 'header_name'], null) ??
          'X-Api-Key',
        value:
          credentialString(
            credential,
            ['value', 'apiKey', 'api_key', 'token'],
            input.credentialPlaintext
          ) ?? '',
        prefix:
          configString(input.providerConfig, ['apiKeyPrefix', 'api_key_prefix']) ??
          credentialString(credential, ['prefix'], null) ??
          undefined,
      },
    };
  }
  if (profile === 'custom_headers') {
    const headerConfig = configObject(input.providerConfig, ['headers']);
    const credentialHeaders = credential?.headers;
    const headers: Array<{ name: string; value: string; secret?: boolean }> = [];
    if (Array.isArray(credentialHeaders)) {
      for (const header of credentialHeaders) {
        if (header && typeof header === 'object') {
          const value = header as Record<string, unknown>;
          if (typeof value.name === 'string' && typeof value.value === 'string') {
            headers.push({
              name: value.name,
              value: value.value,
              secret: value.secret !== false,
            });
          }
        }
      }
    } else if (credential && Object.keys(credential).length > 0) {
      for (const [name, value] of Object.entries(credential)) {
        if (typeof value === 'string') {
          headers.push({ name, value, secret: true });
        }
      }
    }
    if (headerConfig) {
      for (const [name, value] of Object.entries(headerConfig)) {
        if (typeof value === 'string') {
          headers.push({ name, value, secret: false });
        }
      }
    }
    return { mode: 'custom_headers', customHeaders: headers };
  }
  if (profile === 'hmac') {
    return {
      mode: 'hmac',
      hmac: {
        secret:
          credentialString(credential, ['secret', 'value', 'token'], input.credentialPlaintext) ??
          '',
        method: 'POST',
        path: '/',
        body: '',
        profile: buildRuntimeHttpSinkSignatureProfile(input.providerConfig),
      },
    };
  }
  return {
    mode: 'bearer',
    bearerToken:
      credentialString(
        credential,
        ['token', 'bearerToken', 'bearer_token', 'value'],
        input.credentialPlaintext
      ) ?? '',
  };
}

function serializeQueueBody(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export interface AuditQueueConsumerEnv {
  /** Core database (non-PII) for event_log */
  DB: DatabaseSource;

  /** PII database for pii_log */
  DB_PII: DatabaseSource;

  /** Admin/control database for logging object catalog and delivery metadata */
  DB_ADMIN?: DatabaseSource;

  /** Tenant-local hot index database for chunk record lookup */
  LOGGING_INDEX_DB?: DatabaseSource | null;

  /** Legacy archive binding for older queue consumers (optional) */
  AUDIT_ARCHIVE?: R2Bucket;

  /** Common archive binding used by built-in audit profiles (optional) */
  DIAGNOSTIC_LOGS?: R2Bucket;

  /** Credential secret object bucket used by logging destinations */
  SENSITIVE_DETAILS?: R2Bucket;

  /** Primary audit queue used by logging DLQ replay payloads */
  AUDIT_QUEUE?: Queue<unknown>;

  /** Lane-specific logging delivery queues */
  LOGGING_DELIVERY_CRITICAL_QUEUE?: Queue<unknown>;
  LOGGING_DELIVERY_QUEUE?: Queue<unknown>;
  LOGGING_DELIVERY_BULK_QUEUE?: Queue<unknown>;

  /** Optional salt used while tenant_key is derived before registry-backed tenant keys exist */
  LOGGING_TENANT_KEY_SALT?: string;

  /** Root key used to decrypt runtime credential refs */
  OBJECT_ENCRYPTION_ROOT_KEY?: string;

  /** Object encryption key version for archive chunk encryption */
  OBJECT_ENCRYPTION_KEY_VERSION?: string;
}

interface RuntimeDeliveryDestination {
  id: string;
  provider: string;
  lifecycle_status: string;
  provider_config: string | null;
  credential_ref: string | null;
  credential_version: number | null;
}

interface RuntimeCredentialCacheEntry {
  plaintext: string;
  expiresAt: number;
}

const RUNTIME_CREDENTIAL_CACHE_TTL_MS = 60_000;
const runtimeCredentialCache = new Map<string, RuntimeCredentialCacheEntry>();
const tenantKeyCache = new Map<string, string>();

type RuntimeLoggingDeliveryQueueBindingName =
  | 'LOGGING_DELIVERY_CRITICAL_QUEUE'
  | 'LOGGING_DELIVERY_QUEUE'
  | 'LOGGING_DELIVERY_BULK_QUEUE';

const RUNTIME_LOGGING_DELIVERY_QUEUE_BINDINGS: Record<
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

interface RuntimeLoggingDeliveryEnqueueResult {
  queued: boolean;
  lane: LoggingDeliveryLane;
  bindingName: RuntimeLoggingDeliveryQueueBindingName | null;
  fallbackUsed: boolean;
  attemptedBindingNames: RuntimeLoggingDeliveryQueueBindingName[];
  payloadId: string;
  byteCount: number;
}

/**
 * Process a batch of audit queue messages.
 *
 * IMPORTANT: Uses per-message ack/retry pattern.
 * - On success: message.ack()
 * - On failure: message.retry()
 * - After max_retries: Goes to DLQ
 *
 * @param batch - Message batch from Queue
 * @param env - Environment bindings
 * @param logger - Logger instance (optional)
 */
export async function processAuditQueue(
  batch: MessageBatch<AuditQueueMessage>,
  env: AuditQueueConsumerEnv,
  logger?: Logger
): Promise<void> {
  const log = logger ?? createLogger().module('AuditQueueConsumer');

  for (const message of batch.messages) {
    try {
      await processMessage(message, env, log);

      // IMPORTANT: Queues uses "first call wins" behavior.
      // ack() after retry() is ignored.
      // Exception after ack() still succeeds.
      message.ack();
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(String(error));
      log.error('audit_queue_message_failed', {
        messageId: message.id,
        type: message.body.type,
        entryCount: message.body.entries.length,
        tenantId: message.body.tenantId,
        attempts: message.attempts,
        error: errorMessage,
      });

      // Retry the message (goes to DLQ after max_retries)
      message.retry();
    }
  }
}

/**
 * Process a single audit message.
 */
async function processMessage(
  message: Message<AuditQueueMessage>,
  env: AuditQueueConsumerEnv,
  logger: Logger
): Promise<void> {
  const { type, entries, tenantId } = message.body;

  logger.debug('processing_audit_message', {
    messageId: message.id,
    type,
    entryCount: entries.length,
    tenantId,
  });

  if (message.body.fanout) {
    await processFanoutMessage(message, env, logger);
    return;
  }

  if (type === 'event_log') {
    const resolved = await resolveTenantRuntimeProfilesFromEnv(
      env as unknown as Parameters<typeof resolveTenantRuntimeProfilesFromEnv>[0],
      tenantId
    );
    if (!resolved.auditProfile.primary) {
      logger.warn('audit_queue_primary_missing_for_legacy_message', {
        tenantId,
        auditProfileId: resolved.auditProfile.id,
        type,
      });
      return;
    }

    const adapter = createAuditPrimaryStorageAdapter(
      env as unknown as Record<string, unknown>,
      resolved.auditProfile.primary,
      'event',
      { id: `queue-event:${resolved.auditProfile.id}` }
    );
    if (!adapter) {
      throw new Error(`audit_queue_primary_unresolved:${resolved.auditProfile.id}:event`);
    }

    try {
      const result = await adapter.writeEventLogBatch(entries as EventLogEntry[]);
      if (!result.success) {
        throw new Error(result.errorMessage ?? 'audit_queue_event_write_failed');
      }
    } finally {
      await adapter.close();
    }
    return;
  }
  if (type === 'pii_log') {
    const resolved = await resolveTenantRuntimeProfilesFromEnv(
      env as unknown as Parameters<typeof resolveTenantRuntimeProfilesFromEnv>[0],
      tenantId
    );
    if (!resolved.auditProfile.primary) {
      logger.warn('audit_queue_primary_missing_for_legacy_message', {
        tenantId,
        auditProfileId: resolved.auditProfile.id,
        type,
      });
      return;
    }

    const adapter = createAuditPrimaryStorageAdapter(
      env as unknown as Record<string, unknown>,
      resolved.auditProfile.primary,
      'pii',
      { id: `queue-pii:${resolved.auditProfile.id}` }
    );
    if (!adapter) {
      throw new Error(`audit_queue_primary_unresolved:${resolved.auditProfile.id}:pii`);
    }

    try {
      const result = await adapter.writePIILogBatch(entries as PIILogEntry[]);
      if (!result.success) {
        throw new Error(result.errorMessage ?? 'audit_queue_pii_write_failed');
      }
    } finally {
      await adapter.close();
    }
    return;
  }

  {
    throw new Error(`Unknown audit message type: ${type}`);
  }
}

function getR2BucketBinding(env: AuditQueueConsumerEnv, bucketRef: string): R2Bucket | null {
  const binding = (env as unknown as Record<string, unknown>)[bucketRef];
  return binding && typeof binding === 'object' ? (binding as R2Bucket) : null;
}

function explicitDeliveryDestinationId(target: AuditTarget): string | null {
  const value = (target as { destinationId?: unknown }).destinationId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function canQueryTenantKeyRegistry(source: DatabaseSource): boolean {
  const candidate = source as unknown as {
    queryOne?: unknown;
    prepare?: unknown;
  };
  return typeof candidate.queryOne === 'function' || typeof candidate.prepare === 'function';
}

async function resolveTenantKeyForAuditFanout(
  tenantId: string,
  env: AuditQueueConsumerEnv
): Promise<string> {
  const cached = tenantKeyCache.get(tenantId);
  if (cached) {
    return cached;
  }

  if (canQueryTenantKeyRegistry(env.DB)) {
    try {
      const adapter = ensureDatabaseAdapter(env.DB, 'audit-tenant-key-registry');
      const row = await adapter.queryOne<{ tenant_key: string | null }>(
        'SELECT tenant_key FROM tenants WHERE id = ?',
        [tenantId]
      );
      if (row?.tenant_key) {
        tenantKeyCache.set(tenantId, row.tenant_key);
        return row.tenant_key;
      }
    } catch {
      // Older schemas/tests may not have tenant_key yet; keep the previous safe derived fallback.
    }
  }

  const derived = await deriveTenantKeyFromTenantId(tenantId, env.LOGGING_TENANT_KEY_SALT);
  tenantKeyCache.set(tenantId, derived);
  return derived;
}

function isRuntimeQueueLike(value: unknown): value is Queue<unknown> {
  return (
    !!value && typeof value === 'object' && typeof (value as Queue<unknown>).send === 'function'
  );
}

async function enqueueRuntimeLoggingDeliveryPayload(
  payload: LoggingDeliveryQueuePayload,
  env: AuditQueueConsumerEnv
): Promise<RuntimeLoggingDeliveryEnqueueResult> {
  return enqueueRuntimeLoggingDeliveryRawPayload({
    payload,
    lane: payload.lane,
    payloadId: payload.payload_id,
    env,
  });
}

async function enqueueRuntimeLoggingDeliveryRawPayload(input: {
  payload: unknown;
  lane: LoggingDeliveryLane;
  payloadId: string;
  env: AuditQueueConsumerEnv;
}): Promise<RuntimeLoggingDeliveryEnqueueResult> {
  const { payload, lane, payloadId, env } = input;
  const profile = RUNTIME_LOGGING_DELIVERY_QUEUE_BINDINGS[lane];
  const attemptedBindingNames = [profile.primary, ...profile.fallback];
  for (const bindingName of attemptedBindingNames) {
    const queue = (env as unknown as Record<string, unknown>)[bindingName];
    if (!isRuntimeQueueLike(queue)) {
      continue;
    }
    await queue.send(payload);
    return {
      queued: true,
      lane,
      bindingName,
      fallbackUsed: bindingName !== profile.primary,
      attemptedBindingNames,
      payloadId,
      byteCount: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    };
  }

  return {
    queued: false,
    lane,
    bindingName: null,
    fallbackUsed: false,
    attemptedBindingNames,
    payloadId,
    byteCount: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
  };
}

function queuedStatusForEnqueueResult(
  result: RuntimeLoggingDeliveryEnqueueResult | null
): LoggingDeliveryStatus {
  if (!result) {
    return 'delivered';
  }
  return result.queued ? 'queued' : 'retrying';
}

async function enqueueWrittenChunkForDelivery(input: {
  target: AuditTarget;
  result: WriteLogChunkResult;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  lane: LoggingDeliveryLane;
  env: AuditQueueConsumerEnv;
}): Promise<RuntimeLoggingDeliveryEnqueueResult | null> {
  const destinationId = explicitDeliveryDestinationId(input.target);
  if (!destinationId) {
    return null;
  }

  return enqueueRuntimeLoggingDeliveryPayload(
    {
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: `qpl_${crypto.randomUUID()}`,
      tenant_key: input.tenantKey,
      lane: input.lane,
      created_at: input.result.createdAt,
      catalog_id: input.result.objectCatalogId,
      object_key: input.result.objectKey,
      destination_id: destinationId,
      log_type: input.logType,
      plane: input.plane,
      record_count: input.result.recordCount,
    },
    input.env
  );
}

async function enqueueHttpSinkBatchForDelivery(input: {
  target: Extract<AuditTarget, { type: 'http' }>;
  body: AuditQueueMessage;
  tenantKey: string;
  logType: LogType;
  lane: LoggingDeliveryLane;
  env: AuditQueueConsumerEnv;
}): Promise<RuntimeLoggingDeliveryEnqueueResult | null> {
  const destinationId = explicitDeliveryDestinationId(input.target);
  if (!destinationId) {
    return null;
  }
  const endpointUrl =
    input.target.url ??
    ((input.target.urlRef
      ? (input.env as unknown as Record<string, unknown>)[input.target.urlRef]
      : undefined) as string | undefined);
  if (!endpointUrl) {
    throw new Error(`HTTP sink URL not resolved: ${input.target.urlRef ?? 'missing_url'}`);
  }

  const now = Date.now();
  const payloadId = `qpl_${crypto.randomUUID()}`;
  const batchId = `batch_${crypto.randomUUID()}`;
  const bucket = getDefaultLoggingDeliveryPayloadBucket(input.env);
  if (!bucket) {
    throw new Error('logging_delivery_payload_bucket_unavailable');
  }
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
  const canonicalBatch = JSON.stringify(buildCanonicalAuditBatch(input.target, input.body, 'http'));
  await bucket.put(objectKey, canonicalBatch, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: 'external_sink',
      recordCount: String(input.body.entries.length),
      payloadId,
      batchId,
      createdAt: String(now),
    },
  });

  return enqueueRuntimeLoggingDeliveryPayload(
    {
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: payloadId,
      tenant_key: input.tenantKey,
      lane: input.lane,
      created_at: now,
      destination_id: destinationId,
      endpoint_url: endpointUrl,
      log_type: input.logType,
      plane: 'external_sink',
      batch_id: batchId,
      record_count: input.body.entries.length,
      body_object_ref: `r2://${objectKey}`,
    },
    input.env
  );
}

async function writeArchiveTarget(
  target: AuditTarget,
  body: AuditQueueMessage,
  env: AuditQueueConsumerEnv,
  tenantKey: string,
  identity?: { chunkId: string; objectCatalogId: string; createdAt: number }
): Promise<WriteLogChunkResult> {
  if (target.type !== 'r2') {
    throw new Error(`Unsupported archive target type: ${target.type}`);
  }

  const bucket = getR2BucketBinding(env, target.bucketRef);
  if (!bucket) {
    throw new Error(`Archive bucket binding not found: ${target.bucketRef}`);
  }

  const logType: LogType = body.type === 'pii_log' ? 'pii' : 'audit';
  const catalogStore = env.DB_ADMIN ? new SqlLogChunkCatalogStore(env.DB_ADMIN) : undefined;
  const encryption = await resolveArchiveChunkEncryption({
    env,
    tenantKey,
    logType,
    plane: 'archive',
  });

  return writeLogChunkToR2({
    bucket,
    tenantKey,
    logType,
    plane: 'archive',
    prefix: target.prefix ?? 'audit',
    indexProfile: logType,
    catalogStore,
    encryption,
    now: identity?.createdAt,
    chunkId: identity?.chunkId,
    objectCatalogId: identity?.objectCatalogId,
    records: body.entries.map((entry) => ({
      id: entry.id,
      eventAt: entry.createdAt,
      payload: buildCanonicalAuditArchiveRecordFromEntry(target, body.type, entry, tenantKey, {
        emittedAt: body.timestamp,
        auditProfileId: body.fanout?.auditProfileId,
        matchedRuleNames: body.fanout?.matchedRuleNames,
      }),
      indexedFields:
        body.type === 'event_log'
          ? {
              eventType: (entry as EventLogEntry).eventType,
              eventCategory: (entry as EventLogEntry).eventCategory,
              result: (entry as EventLogEntry).result,
              severity: (entry as EventLogEntry).severity,
            }
          : {
              changeType: (entry as PIILogEntry).changeType,
              actorType: (entry as PIILogEntry).actorType,
            },
    })),
  } as Parameters<typeof writeLogChunkToR2>[0] & {
    chunkId?: string;
    objectCatalogId?: string;
  });
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('object_encryption_root_key_invalid');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function deriveArchiveChunkEncryptionKey(input: {
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

async function resolveArchiveChunkEncryption(input: {
  env: AuditQueueConsumerEnv;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
}): Promise<LogChunkEncryptionOptions> {
  if (!input.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    throw new Error('log_chunk_encryption_root_key_unavailable');
  }
  const keyVersion = Number.parseInt(input.env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1', 10);
  const normalizedKeyVersion = Number.isFinite(keyVersion) && keyVersion > 0 ? keyVersion : 1;
  const encryptionScope = `tenant:${input.tenantKey}:${input.logType}:${input.plane}`;
  return {
    keyBytes: await deriveArchiveChunkEncryptionKey({
      rootKeyHex: input.env.OBJECT_ENCRYPTION_ROOT_KEY,
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      keyVersion: normalizedKeyVersion,
    }),
    encryptionScope,
    keyVersion: normalizedKeyVersion,
  };
}

function emitLogpushSink(
  target: Extract<AuditTarget, { type: 'logpush' }>,
  body: AuditQueueMessage
) {
  for (const entry of body.entries) {
    console.log(JSON.stringify(buildCanonicalAuditRecord(target, body, entry, 'logpush')));
  }
}

async function deliverHttpSink(
  target: Extract<AuditTarget, { type: 'http' }>,
  body: AuditQueueMessage,
  env: AuditQueueConsumerEnv
): Promise<HttpSinkDeliveryResult> {
  const resolvedUrl =
    target.url ??
    ((target.urlRef ? (env as unknown as Record<string, unknown>)[target.urlRef] : undefined) as
      | string
      | undefined);

  if (!resolvedUrl) {
    throw new Error(`HTTP sink URL not resolved: ${target.urlRef ?? 'missing_url'}`);
  }

  const authToken =
    target.authTokenRef != null
      ? ((env as unknown as Record<string, unknown>)[target.authTokenRef] as string | undefined)
      : undefined;

  if (target.authTokenRef && !authToken) {
    throw new Error(`HTTP sink auth token not resolved: ${target.authTokenRef}`);
  }

  const customHeaders = Object.entries(target.headers ?? {}).map(([name, value]) => ({
    name,
    value,
    secret: false,
  }));
  const auth: HttpSinkAuthConfig =
    customHeaders.length > 0 || authToken
      ? {
          mode: 'custom_headers',
          customHeaders: [
            ...customHeaders,
            ...(authToken
              ? [
                  {
                    name: 'Authorization',
                    value: `Bearer ${authToken}`,
                    secret: true,
                  },
                ]
              : []),
          ],
        }
      : { mode: 'none' };
  const deliveryId = `${body.tenantId}:${body.timestamp}:${body.entries[0]?.id ?? 'batch'}`;
  return deliverHttpSinkBatch({
    endpointUrl: resolvedUrl,
    method: target.method ?? 'POST',
    body: JSON.stringify(buildCanonicalAuditBatch(target, body, 'http')),
    auth,
    deliveryId,
    fetcher: (input, init) =>
      safeFetch(fetchInputToUrl(input), {
        ...init,
        timeoutMs: 10000,
        maxResponseSize: 64 * 1024,
      }),
  });
}

async function deliverSinkTarget(
  target: AuditTarget,
  body: AuditQueueMessage,
  env: AuditQueueConsumerEnv
): Promise<void> {
  if (target.type === 'logpush') {
    emitLogpushSink(target, body);
    return;
  }

  if (target.type === 'http') {
    await deliverHttpSink(target, body, env);
    return;
  }

  throw new Error(`Unsupported sink target type: ${target.type}`);
}

function logTypeForAuditMessage(body: AuditQueueMessage): LogType {
  return body.type === 'pii_log' ? 'pii' : 'audit';
}

function createDeliveryEventStore(
  env: AuditQueueConsumerEnv
): LoggingDeliveryEventStore | undefined {
  if (!env.DB_ADMIN) {
    return undefined;
  }
  return new SqlLoggingDeliveryEventStore(
    ensureDatabaseAdapter(env.DB_ADMIN, 'audit-delivery-events')
  );
}

function createDlqItemStore(env: AuditQueueConsumerEnv): LoggingDlqItemStore | undefined {
  if (!env.DB_ADMIN) {
    return undefined;
  }
  return new SqlLoggingDlqItemStore(ensureDatabaseAdapter(env.DB_ADMIN, 'audit-dlq-items'));
}

function deliveryErrorClass(error: unknown, fallback: string): string {
  const message = String(error);
  if (message.includes('http_sink_url_must_use_https')) {
    return 'http_sink_url_must_use_https';
  }
  if (message.includes('HTTP sink auth token not resolved')) {
    return 'http_sink_auth_unresolved';
  }
  if (message.includes('HTTP sink URL not resolved')) {
    return 'http_sink_url_unresolved';
  }
  if (message.includes('HTTP sink delivery retrying')) {
    return 'http_sink_retryable_status';
  }
  if (message.includes('HTTP sink delivery failed')) {
    return 'http_sink_failed_status';
  }
  return fallback;
}

function deliveryStatusForFailure(
  failureMode: 'best_effort' | 'gate_cleanup' | 'retry_until_ttl'
): LoggingDeliveryStatus {
  return failureMode === 'best_effort' ? 'failed' : 'retrying';
}

function targetMetadata(
  target: AuditTarget,
  fanout: AuditQueueFanoutPlan,
  body: AuditQueueMessage
) {
  const destinationId = deliveryDestinationId(target);
  const loggingPolicy = (
    target as {
      loggingPolicy?: {
        selectedDestinationId?: string | null;
        effectiveDestinationId?: string | null;
        fallbackDestinationId?: string | null;
        fallbackUsed?: boolean;
        fallbackReason?: string | null;
        failureMode?: string | null;
        policySource?: string | null;
        policyWarnings?: string[];
      };
    }
  ).loggingPolicy;
  return {
    audit_profile_id: fanout.auditProfileId,
    target_type: target.type,
    destination_id: destinationId,
    record_count: body.entries.length,
    ...(loggingPolicy
      ? {
          selected_destination_id: loggingPolicy.selectedDestinationId ?? null,
          effective_destination_id: loggingPolicy.effectiveDestinationId ?? destinationId,
          fallback_destination_id: loggingPolicy.fallbackDestinationId ?? null,
          fallback_used: loggingPolicy.fallbackUsed ?? false,
          fallback_reason: loggingPolicy.fallbackReason ?? null,
          failure_mode: loggingPolicy.failureMode ?? null,
          policy_source: loggingPolicy.policySource ?? null,
          policy_warnings: loggingPolicy.policyWarnings ?? [],
        }
      : {}),
    ...(target.type === 'r2'
      ? {
          bucket_ref: target.bucketRef,
          prefix: target.prefix ?? null,
        }
      : {}),
    ...(target.type === 'logpush'
      ? {
          destination_ref: target.destinationRef,
          dataset: target.dataset ?? null,
        }
      : {}),
    ...(target.type === 'http'
      ? {
          url_ref: target.urlRef ?? null,
          inline_url: Boolean(target.url && !target.urlRef),
          auth_token_ref_set: Boolean(target.authTokenRef),
          header_count: Object.keys(target.headers ?? {}).length,
        }
      : {}),
  };
}

function deliveryDestinationId(target: AuditTarget): string {
  const explicitDestinationId = explicitDeliveryDestinationId(target);
  if (explicitDestinationId) {
    return explicitDestinationId;
  }
  if (target.type === 'r2') {
    return `r2:${target.bucketRef}`;
  }
  if (target.type === 'logpush') {
    return `logpush:${target.destinationRef}`;
  }
  if (target.type === 'firehose') {
    return `firehose:${target.streamRef}`;
  }
  if (target.type === 'http') {
    return `http:${target.urlRef ?? 'direct_url'}`;
  }
  if (target.type === 'postgres' || target.type === 'mysql') {
    return `${target.type}:${target.connectionRef ?? 'primary'}`;
  }
  return `d1:${target.bindingRef ?? 'primary'}`;
}

async function recordDeliveryEvent(
  store: LoggingDeliveryEventStore | undefined,
  logger: Logger,
  input: {
    id?: string;
    tenantKey: string;
    destinationId?: string | null;
    logType: LogType;
    plane: LogPlane;
    lane: LoggingDeliveryLane;
    status: LoggingDeliveryStatus;
    attemptCount: number;
    errorClass?: string | null;
    objectCatalogId?: string | null;
    nextRetryAt?: number | null;
    metadata?: Record<string, unknown>;
    now?: number;
  }
): Promise<void> {
  if (!store) {
    return;
  }

  try {
    await store.insertEvent(input);
  } catch (error) {
    logger.warn('logging_delivery_event_record_failed', {
      logType: input.logType,
      plane: input.plane,
      lane: input.lane,
      status: input.status,
      error: sanitizeErrorMessage(String(error)),
    });
  }
}

function createInternalNotificationRepository(
  env: AuditQueueConsumerEnv
): InternalNotificationEventRepository | undefined {
  if (!env.DB_ADMIN) {
    return undefined;
  }
  return new InternalNotificationEventRepository(
    ensureDatabaseAdapter(env.DB_ADMIN, 'audit-delivery-notifications')
  );
}

function shouldNotifyDeliveryCondition(input: {
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
}): boolean {
  if (input.status === 'dlq') {
    return true;
  }
  if (input.status === 'retrying') {
    return input.lane === 'critical';
  }
  if (input.status === 'failed') {
    return true;
  }
  return false;
}

function deliveryNotificationSeverity(input: {
  lane: LoggingDeliveryLane;
  status: LoggingDeliveryStatus;
}): 'critical' | 'high' | 'medium' {
  if (input.status === 'dlq' || input.lane === 'critical') {
    return 'critical';
  }
  return input.lane === 'default' ? 'high' : 'medium';
}

function deliveryNotificationCategory(
  status: LoggingDeliveryStatus
): 'logging_delivery_failure' | 'logging_dlq_backlog' {
  return status === 'dlq' ? 'logging_dlq_backlog' : 'logging_delivery_failure';
}

async function recordDeliveryNotification(
  repository: InternalNotificationEventRepository | undefined,
  logger: Logger,
  input: {
    id?: string;
    tenantId: string;
    tenantKey: string;
    destinationId?: string | null;
    logType: LogType;
    plane: LogPlane;
    lane: LoggingDeliveryLane;
    status: LoggingDeliveryStatus;
    attemptCount: number;
    errorClass?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  if (!repository || !shouldNotifyDeliveryCondition(input)) {
    return;
  }

  const destinationId = input.destinationId ?? 'unknown_destination';
  const errorClass = input.errorClass ?? 'none';
  try {
    const severity = deliveryNotificationSeverity(input);
    const externalNotificationEligible =
      input.lane === 'critical' && (input.status === 'dlq' || input.status === 'failed');
    await repository.enqueue({
      id: input.id,
      tenantId: input.tenantId,
      category: deliveryNotificationCategory(input.status),
      eventType: `logging.delivery.${input.status}`,
      severity,
      deduplicationKey: [
        'logging_delivery',
        input.status,
        input.tenantKey,
        destinationId,
        input.logType,
        input.plane,
        input.lane,
        errorClass,
      ].join(':'),
      payload: {
        tenant_key: input.tenantKey,
        destination_id: destinationId,
        log_type: input.logType,
        plane: input.plane,
        lane: input.lane,
        status: input.status,
        attempt_count: input.attemptCount,
        error_class: input.errorClass ?? null,
        external_notification_eligible: externalNotificationEligible,
        metadata: input.metadata ?? {},
      },
      routingPolicy: resolveLoggingNotificationRoutingPolicy({
        severity,
        externalNotificationEligible,
      }),
    });
  } catch (error) {
    logger.warn('logging_delivery_notification_enqueue_failed', {
      logType: input.logType,
      plane: input.plane,
      lane: input.lane,
      status: input.status,
      error: sanitizeErrorMessage(String(error)),
    });
  }
}

async function processFanoutMessage(
  message: Message<AuditQueueMessage>,
  env: AuditQueueConsumerEnv,
  logger: Logger
): Promise<void> {
  const body = message.body;
  const attemptCount = message.attempts;
  const fanout = body.fanout as AuditQueueFanoutPlan;
  const archives =
    fanout.archives.length > 0 ? fanout.archives : fanout.archive ? [fanout.archive] : [];
  const tenantKey = await resolveTenantKeyForAuditFanout(body.tenantId, env);
  const logType = logTypeForAuditMessage(body);
  const deliveryEventStore = createDeliveryEventStore(env);
  const notificationRepository = createInternalNotificationRepository(env);
  const archiveFailureMode = fanout.archiveFailureMode ?? 'best_effort';
  const sinkFailureMode = fanout.sinkFailureMode ?? 'best_effort';

  for (const archive of archives) {
    const lane = laneForLogPolicy(logType, 'archive');
    const destinationId = deliveryDestinationId(archive);
    const stablePurpose = `audit-fanout:${destinationId}`;
    const stableCreatedAt = queueMessageTimestamp(message);
    const chunkId = await createQueueStableLoggingId('chk', message, stablePurpose);
    const objectCatalogId = await createQueueStableLoggingId('obj', message, stablePurpose);
    const deliveryEventId = await createQueueStableLoggingId('lde', message, stablePurpose);
    try {
      const result = await writeArchiveTarget(archive, body, env, tenantKey, {
        chunkId,
        objectCatalogId,
        createdAt: stableCreatedAt,
      });
      const enqueueResult = await enqueueWrittenChunkForDelivery({
        target: archive,
        result,
        tenantKey,
        logType,
        plane: 'archive',
        lane,
        env,
      });
      await recordDeliveryEvent(deliveryEventStore, logger, {
        id: deliveryEventId,
        tenantKey,
        destinationId,
        logType,
        plane: 'archive',
        lane,
        status: queuedStatusForEnqueueResult(enqueueResult),
        attemptCount,
        objectCatalogId: result.objectCatalogId,
        metadata: {
          ...targetMetadata(archive, fanout, body),
          chunk_id: result.chunkId,
          byte_count: result.byteCount,
          delivery_queue_binding: enqueueResult?.bindingName ?? null,
          delivery_queue_fallback_used: enqueueResult?.fallbackUsed ?? false,
          delivery_queue_attempted_bindings: enqueueResult?.attemptedBindingNames ?? null,
        },
      });
      if (enqueueResult && !enqueueResult.queued) {
        await recordDeliveryNotification(notificationRepository, logger, {
          id: await createQueueStableLoggingId('lde', message, `${stablePurpose}:notification`),
          tenantId: body.tenantId,
          tenantKey,
          destinationId,
          logType,
          plane: 'archive',
          lane,
          status: 'retrying',
          attemptCount,
          errorClass: 'logging_delivery_queue_unavailable',
          metadata: {
            ...targetMetadata(archive, fanout, body),
            chunk_id: result.chunkId,
            delivery_queue_attempted_bindings: enqueueResult.attemptedBindingNames,
          },
        });
        if (archiveFailureMode === 'gate_cleanup') {
          throw new Error('logging_delivery_queue_unavailable');
        }
      }
    } catch (error) {
      const status = deliveryStatusForFailure(archiveFailureMode);
      const errorClass = deliveryErrorClass(error, 'archive_delivery_failed');
      const metadata = targetMetadata(archive, fanout, body);
      await recordDeliveryEvent(deliveryEventStore, logger, {
        id: await createQueueStableLoggingId('lde', message, `${stablePurpose}:failure`),
        tenantKey,
        destinationId,
        logType,
        plane: 'archive',
        lane,
        status,
        attemptCount,
        errorClass,
        metadata,
      });
      await recordDeliveryNotification(notificationRepository, logger, {
        id: await createQueueStableLoggingId(
          'lde',
          message,
          `${stablePurpose}:failure-notification`
        ),
        tenantId: body.tenantId,
        tenantKey,
        destinationId,
        logType,
        plane: 'archive',
        lane,
        status,
        attemptCount,
        errorClass,
        metadata,
      });
      if (archiveFailureMode === 'gate_cleanup') {
        throw error;
      }
      logger.warn('audit_archive_delivery_failed', {
        tenantId: body.tenantId,
        auditProfileId: fanout.auditProfileId,
        archiveType: archive.type,
        error: sanitizeErrorMessage(String(error)),
      });
    }
  }

  for (const sink of fanout.sinks) {
    const lane = laneForLogPolicy(logType, 'external_sink');
    const destinationId = deliveryDestinationId(sink);
    if (sink.type === 'http') {
      const queuedSink = await enqueueHttpSinkBatchForDelivery({
        target: sink,
        body,
        tenantKey,
        logType,
        lane,
        env,
      });
      if (queuedSink) {
        const status = queuedStatusForEnqueueResult(queuedSink);
        const metadata = {
          ...targetMetadata(sink, fanout, body),
          payload_id: queuedSink.payloadId,
          byte_count: queuedSink.byteCount,
          delivery_queue_binding: queuedSink.bindingName,
          delivery_queue_fallback_used: queuedSink.fallbackUsed,
          delivery_queue_attempted_bindings: queuedSink.attemptedBindingNames,
        };
        await recordDeliveryEvent(deliveryEventStore, logger, {
          tenantKey,
          destinationId,
          logType,
          plane: 'external_sink',
          lane,
          status,
          attemptCount,
          errorClass: status === 'retrying' ? 'logging_delivery_queue_unavailable' : null,
          metadata,
        });
        if (status === 'retrying') {
          await recordDeliveryNotification(notificationRepository, logger, {
            tenantId: body.tenantId,
            tenantKey,
            destinationId,
            logType,
            plane: 'external_sink',
            lane,
            status,
            attemptCount,
            errorClass: 'logging_delivery_queue_unavailable',
            metadata,
          });
          if (sinkFailureMode === 'retry_until_ttl') {
            throw new Error('logging_delivery_queue_unavailable');
          }
        }
        continue;
      }
      let recordedFailure = false;
      try {
        const result = await deliverHttpSink(sink, body, env);
        const status: LoggingDeliveryStatus =
          result.status === 'delivered' ? 'delivered' : deliveryStatusForFailure(sinkFailureMode);
        const errorClass =
          result.status === 'delivered' ? null : `http_status_${String(result.httpStatus)}`;
        const metadata = {
          ...targetMetadata(sink, fanout, body),
          http_status: result.httpStatus,
        };
        await recordDeliveryEvent(deliveryEventStore, logger, {
          tenantKey,
          destinationId,
          logType,
          plane: 'external_sink',
          lane,
          status,
          attemptCount,
          errorClass,
          nextRetryAt:
            result.status === 'retrying' && result.retryDelayMs
              ? Date.now() + result.retryDelayMs
              : null,
          metadata,
        });
        if (result.status !== 'delivered') {
          recordedFailure = true;
          await recordDeliveryNotification(notificationRepository, logger, {
            tenantId: body.tenantId,
            tenantKey,
            destinationId,
            logType,
            plane: 'external_sink',
            lane,
            status,
            attemptCount,
            errorClass,
            metadata,
          });
          throw new Error(`HTTP sink delivery ${result.status}: ${result.httpStatus}`);
        }
      } catch (error) {
        if (!recordedFailure) {
          const status = deliveryStatusForFailure(sinkFailureMode);
          const errorClass = deliveryErrorClass(error, 'http_sink_delivery_failed');
          const metadata = targetMetadata(sink, fanout, body);
          await recordDeliveryEvent(deliveryEventStore, logger, {
            tenantKey,
            destinationId,
            logType,
            plane: 'external_sink',
            lane,
            status,
            attemptCount,
            errorClass,
            metadata,
          });
          await recordDeliveryNotification(notificationRepository, logger, {
            tenantId: body.tenantId,
            tenantKey,
            destinationId,
            logType,
            plane: 'external_sink',
            lane,
            status,
            attemptCount,
            errorClass,
            metadata,
          });
        }
        if (sinkFailureMode === 'retry_until_ttl') {
          throw error;
        }
        logger.warn('audit_sink_delivery_failed', {
          tenantId: body.tenantId,
          auditProfileId: fanout.auditProfileId,
          sinkType: sink.type,
          error: sanitizeErrorMessage(String(error)),
        });
      }
      continue;
    }

    try {
      await deliverSinkTarget(sink, body, env);
      await recordDeliveryEvent(deliveryEventStore, logger, {
        tenantKey,
        destinationId,
        logType,
        plane: 'external_sink',
        lane,
        status: 'delivered',
        attemptCount,
        metadata: targetMetadata(sink, fanout, body),
      });
    } catch (error) {
      const status = deliveryStatusForFailure(sinkFailureMode);
      const errorClass = deliveryErrorClass(error, 'sink_delivery_failed');
      const metadata = targetMetadata(sink, fanout, body);
      await recordDeliveryEvent(deliveryEventStore, logger, {
        tenantKey,
        destinationId,
        logType,
        plane: 'external_sink',
        lane,
        status,
        attemptCount,
        errorClass,
        metadata,
      });
      await recordDeliveryNotification(notificationRepository, logger, {
        tenantId: body.tenantId,
        tenantKey,
        destinationId,
        logType,
        plane: 'external_sink',
        lane,
        status,
        attemptCount,
        errorClass,
        metadata,
      });
      if (sinkFailureMode === 'retry_until_ttl') {
        throw error;
      }
      logger.warn('audit_sink_delivery_failed', {
        tenantId: body.tenantId,
        auditProfileId: fanout.auditProfileId,
        sinkType: sink.type,
        error: sanitizeErrorMessage(String(error)),
      });
    }
  }
}

/**
 * Batch insert event log entries with idempotent semantics.
 */
async function batchUpsertEventLog(db: DatabaseSource, entries: EventLogEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const adapter = ensureDatabaseAdapter(db, 'audit-queue-event');
  await adapter.batch(
    entries.map((e) => ({
      sql: `INSERT INTO event_log (
              id, tenant_id, event_type, event_category, result, severity,
              error_code, error_message, anonymized_user_id, client_id,
              session_id, request_id, duration_ms, details_r2_key, details_json,
              retention_until, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM event_log WHERE id = ?
            )`,
      params: [
        e.id,
        e.tenantId,
        e.eventType,
        e.eventCategory,
        e.result,
        e.severity,
        e.errorCode ?? null,
        e.errorMessage ?? null,
        e.anonymizedUserId ?? null,
        e.clientId ?? null,
        e.sessionId ?? null,
        e.requestId ?? null,
        e.durationMs ?? null,
        e.detailsR2Key ?? null,
        e.detailsJson ?? null,
        e.retentionUntil ?? null,
        e.createdAt,
        e.id,
      ],
    }))
  );
}

/**
 * Batch insert PII log entries with idempotent semantics.
 */
async function batchUpsertPIILog(db: DatabaseSource, entries: PIILogEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const adapter = ensureDatabaseAdapter(db, 'audit-queue-pii');
  await adapter.batch(
    entries.map((e) => ({
      sql: `INSERT INTO pii_log (
              id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
              values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
              actor_user_id, actor_type, request_id, legal_basis, consent_reference,
              retention_until, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM pii_log WHERE id = ?
            )`,
      params: [
        e.id,
        e.tenantId,
        e.userId,
        e.anonymizedUserId,
        e.changeType,
        e.affectedFields,
        e.valuesR2Key ?? null,
        e.valuesEncrypted ?? null,
        e.encryptionKeyId,
        e.encryptionIv,
        e.actorUserId ?? null,
        e.actorType,
        e.requestId ?? null,
        e.legalBasis ?? null,
        e.consentReference ?? null,
        e.retentionUntil,
        e.createdAt,
        e.id,
      ],
    }))
  );
}

// =============================================================================
// DLQ Consumer (Recovery Backup)
// =============================================================================

/**
 * Process DLQ messages by saving to R2 for recovery.
 *
 * @param batch - Message batch from DLQ
 * @param env - Environment bindings
 * @param logger - Logger instance (optional)
 */
export async function processDLQQueue(
  batch: MessageBatch<AuditQueueMessage>,
  env: AuditQueueConsumerEnv,
  logger?: Logger
): Promise<void> {
  const log = logger ?? createLogger().module('AuditDLQConsumer');
  const dlqStore = createDlqItemStore(env);
  const deliveryEventStore = createDeliveryEventStore(env);
  const notificationRepository = createInternalNotificationRepository(env);

  for (const message of batch.messages) {
    try {
      const now = queueMessageTimestamp(message);
      const timestamp = new Date(now).toISOString();
      const tenantKey = await deriveTenantKeyFromTenantId(
        message.body.tenantId,
        env.LOGGING_TENANT_KEY_SALT
      );
      const logType = logTypeForAuditMessage(message.body);
      const lane = laneForLogPolicy(logType, 'delivery_event');
      const destinationId = 'queue:AUDIT_DLQ';
      const dlqItemId = await createQueueStableLoggingId('dlq', message, 'audit-dlq');
      const partition = formatUtcPartition(now);
      const payloadObjectRef =
        `dlq/tenant_key=${tenantKey}/yyyy=${partition.year}/mm=${partition.month}` +
        `/dd=${partition.day}/${dlqItemId}.json`;

      // Save to R2 for recovery
      const archiveBucket = env.AUDIT_ARCHIVE ?? null;
      if (archiveBucket) {
        await archiveBucket.put(
          payloadObjectRef,
          JSON.stringify({
            messageId: message.id,
            receivedAt: timestamp,
            retryCount: message.attempts,
            body: message.body,
          }),
          {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: {
              tenantKey,
              payloadType: 'audit_queue_message',
              schemaVersion: '1',
              dlqItemId,
              logType,
            },
          }
        );

        await dlqStore?.insertItem({
          id: dlqItemId,
          tenantKey,
          payloadType: 'audit_queue_message',
          schemaVersion: 1,
          lane,
          payloadObjectRef,
          destinationId,
          errorClass: 'audit_message_failed_permanently',
          attemptCount: message.attempts,
          now,
        });
      }

      await recordDeliveryEvent(deliveryEventStore, log, {
        id: await createQueueStableLoggingId('lde', message, 'audit-dlq'),
        tenantKey,
        destinationId,
        logType,
        plane: 'delivery_event',
        lane,
        status: 'dlq',
        attemptCount: message.attempts,
        errorClass: 'audit_message_failed_permanently',
        metadata: {
          dlq_item_id: archiveBucket ? dlqItemId : null,
          payload_object_ref: archiveBucket ? payloadObjectRef : null,
          payload_type: 'audit_queue_message',
          schema_version: 1,
          record_count: message.body.entries.length,
        },
      });
      await recordDeliveryNotification(notificationRepository, log, {
        id: await createQueueStableLoggingId('lde', message, 'audit-dlq:notification'),
        tenantId: message.body.tenantId,
        tenantKey,
        destinationId,
        logType,
        plane: 'delivery_event',
        lane,
        status: 'dlq',
        attemptCount: message.attempts,
        errorClass: 'audit_message_failed_permanently',
        metadata: {
          dlq_item_id: archiveBucket ? dlqItemId : null,
          payload_object_ref: archiveBucket ? payloadObjectRef : null,
          payload_type: 'audit_queue_message',
          schema_version: 1,
          record_count: message.body.entries.length,
        },
      });

      // Log for alerting
      log.error('audit_message_failed_permanently', {
        messageId: message.id,
        tenantId: message.body.tenantId,
        type: message.body.type,
        entryCount: message.body.entries.length,
        attempts: message.attempts,
      });

      message.ack();
    } catch (error) {
      // R2 save failed, retry
      log.error('dlq_save_failed', {
        messageId: message.id,
        error: sanitizeErrorMessage(String(error)),
      });
      message.retry();
    }
  }
}

async function writeUnsupportedLoggingDeliveryPayloadToDlq(input: {
  message: Message<unknown>;
  parseResult: Extract<LoggingDeliveryQueuePayloadParseResult, { ok: false }>;
  env: AuditQueueConsumerEnv;
  logger: Logger;
}): Promise<void> {
  const { message, parseResult, env, logger } = input;
  const archiveBucket = env.AUDIT_ARCHIVE ?? null;
  const now = queueMessageTimestamp(message);
  const tenantKey = parseResult.tenantKey ?? 'unknown_tenant_key';
  const lane = parseResult.lane ?? 'default';
  const payloadType = parseResult.payloadType ?? 'unknown_payload';
  const schemaVersion = parseResult.schemaVersion ?? 0;
  const dlqItemId = await createQueueStableLoggingId(
    'dlq',
    message,
    'logging-delivery-unsupported'
  );
  const partition = formatUtcPartition(now);
  const payloadObjectRef =
    `dlq/tenant_key=${cleanR2ObjectKeySegment(tenantKey)}/yyyy=${partition.year}/mm=${partition.month}` +
    `/dd=${partition.day}/unsupported/${dlqItemId}.json`;
  const destinationId = 'queue:LOGGING_DELIVERY';
  const errorClass = `logging_delivery_payload_${parseResult.reason}`;

  if (!archiveBucket) {
    throw new Error('logging_delivery_unsupported_payload_dlq_bucket_unavailable');
  }

  await archiveBucket.put(
    payloadObjectRef,
    JSON.stringify({
      messageId: message.id,
      receivedAt: new Date(now).toISOString(),
      retryCount: message.attempts,
      parseResult,
      body: message.body,
      bodyJson: serializeQueueBody(message.body),
    }),
    {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        tenantKey,
        payloadType,
        schemaVersion: String(schemaVersion),
        dlqItemId,
      },
    }
  );

  const dlqStore = createDlqItemStore(env);
  await dlqStore?.insertItem({
    id: dlqItemId,
    tenantKey,
    payloadType,
    schemaVersion,
    lane,
    payloadObjectRef,
    destinationId,
    errorClass,
    attemptCount: message.attempts,
    now,
  });

  const deliveryEventStore = createDeliveryEventStore(env);
  const metadata = {
    dlq_item_id: dlqItemId,
    payload_object_ref: payloadObjectRef,
    payload_type: payloadType,
    schema_version: schemaVersion,
    payload_id: parseResult.payloadId ?? null,
    parser_reason: parseResult.reason,
  };
  await recordDeliveryEvent(deliveryEventStore, logger, {
    id: await createQueueStableLoggingId('lde', message, 'logging-delivery-unsupported'),
    tenantKey,
    destinationId,
    logType: 'operational',
    plane: 'delivery_event',
    lane,
    status: 'dlq',
    attemptCount: message.attempts,
    errorClass,
    metadata,
  });
  await recordDeliveryNotification(createInternalNotificationRepository(env), logger, {
    id: await createQueueStableLoggingId(
      'lde',
      message,
      'logging-delivery-unsupported:notification'
    ),
    tenantId: tenantKey,
    tenantKey,
    destinationId,
    logType: 'operational',
    plane: 'delivery_event',
    lane,
    status: 'dlq',
    attemptCount: message.attempts,
    errorClass,
    metadata,
  });
}

async function readHttpSinkBatchBody(
  payload: HttpSinkBatchPayload,
  env: AuditQueueConsumerEnv
): Promise<{ body: string; contentType: string; byteCount: number; objectRef: string | null }> {
  if (!payload.body_object_ref) {
    const body = JSON.stringify({
      payload_type: payload.payload_type,
      payload_id: payload.payload_id,
      batch_id: payload.batch_id,
      tenant_key: payload.tenant_key,
      record_count: payload.record_count,
      created_at: payload.created_at,
    });
    return {
      body,
      contentType: 'application/json',
      byteCount: new TextEncoder().encode(body).byteLength,
      objectRef: null,
    };
  }

  const bucket = getDefaultLoggingDeliveryPayloadBucket(env);
  if (!bucket) {
    throw new Error('logging_delivery_payload_bucket_unavailable');
  }
  const objectKey = normalizeR2ObjectRef(payload.body_object_ref);
  const object = await bucket.get(objectKey);
  if (!object) {
    throw new Error('logging_delivery_payload_object_not_found');
  }
  const bodyRead = await readLoggingDeliveryPayloadObjectText(
    object,
    'logging_delivery_payload_object'
  );
  const metadata = object as R2ObjectBody & {
    httpMetadata?: { contentType?: string };
    size?: number;
  };
  return {
    body: bodyRead.text,
    contentType: metadata.httpMetadata?.contentType ?? 'application/json',
    byteCount: bodyRead.byteCount,
    objectRef: payload.body_object_ref,
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberField(value: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = value[key];
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function recordPayload(value: Record<string, unknown>): unknown {
  return Object.hasOwn(value, 'payload') ? value.payload : value;
}

function recordIndexedFields(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const indexedFields = value.indexed_fields ?? value.indexedFields;
  return isRecordObject(indexedFields) ? indexedFields : undefined;
}

function normalizeChunkWriteRecord(
  value: unknown,
  index: number,
  createdAt: number
): LogChunkRecord {
  if (!isRecordObject(value)) {
    return {
      id: createLoggingId('rec', createdAt + index),
      eventAt: createdAt,
      payload: value,
    };
  }
  return {
    id:
      typeof value.id === 'string'
        ? value.id
        : typeof value.record_id === 'string'
          ? value.record_id
          : createLoggingId('rec', createdAt + index),
    eventAt: numberField(value, ['eventAt', 'event_at', 'created_at', 'createdAt']) ?? createdAt,
    payload: recordPayload(value),
    indexedFields: recordIndexedFields(value),
  };
}

async function loadChunkWriteRecords(
  payload: ChunkWritePayload,
  env: AuditQueueConsumerEnv
): Promise<LogChunkRecord[]> {
  let records: unknown[] = payload.records;
  if (payload.records_object_ref) {
    const bucket = getDefaultLoggingDeliveryPayloadBucket(env);
    if (!bucket) {
      throw new Error('chunk_write_records_payload_bucket_unavailable');
    }
    const object = await bucket.get(normalizeR2ObjectRef(payload.records_object_ref));
    if (!object) {
      throw new Error('chunk_write_records_payload_object_not_found');
    }
    const objectRead = await readLoggingDeliveryPayloadObjectText(
      object,
      'chunk_write_records_payload_object'
    );
    const parsed = JSON.parse(objectRead.text) as unknown;
    if (Array.isArray(parsed)) {
      records = parsed;
    } else if (isRecordObject(parsed) && Array.isArray(parsed.records)) {
      records = parsed.records;
    } else {
      throw new Error('chunk_write_records_payload_malformed');
    }
  }
  if (records.length === 0) {
    throw new Error('chunk_write_records_required');
  }
  return records.map((record, index) =>
    normalizeChunkWriteRecord(record, index, payload.created_at)
  );
}

interface SensitiveDetailChunkWriteRecord {
  catalog_id: string;
  public_artifact_id: string | null;
  tenant_id: string;
  object_class: string;
  surface: string;
  content_type: string;
  payload_envelope_json: string;
  pending_object_key: string;
  key_version: number;
  event_at: number;
  index_db_binding: 'DB' | 'DB_ADMIN' | 'LOGGING_INDEX_DB';
}

interface SensitiveDetailChunkWriteItem {
  payload: ChunkWritePayload;
  message: Message<unknown>;
  record: SensitiveDetailChunkWriteRecord;
}

function isSensitiveDetailChunkWritePayload(payload: ChunkWritePayload): boolean {
  return payload.plane === 'sensitive_detail';
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) {
    throw new Error(`sensitive_detail_chunk_record_${key}_required`);
  }
  return field;
}

function parseSensitiveDetailChunkWriteRecords(
  payload: ChunkWritePayload
): SensitiveDetailChunkWriteRecord[] {
  return payload.records.map((value) => {
    if (!isRecordObject(value)) {
      throw new Error('sensitive_detail_chunk_record_malformed');
    }
    const keyVersion = numberField(value, ['key_version', 'keyVersion']) ?? 1;
    const eventAt = numberField(value, ['event_at', 'eventAt', 'created_at', 'createdAt']);
    const indexDbBinding =
      value.index_db_binding === 'DB_ADMIN'
        ? 'DB_ADMIN'
        : value.index_db_binding === 'LOGGING_INDEX_DB'
          ? 'LOGGING_INDEX_DB'
          : 'DB';
    return {
      catalog_id: stringField(value, 'catalog_id'),
      public_artifact_id:
        typeof value.public_artifact_id === 'string' ? value.public_artifact_id : null,
      tenant_id: stringField(value, 'tenant_id'),
      object_class: stringField(value, 'object_class'),
      surface:
        typeof value.surface === 'string' && value.surface
          ? value.surface
          : typeof (payload as { surface?: unknown }).surface === 'string'
            ? String((payload as { surface?: unknown }).surface)
            : 'sensitive_detail',
      content_type: stringField(value, 'content_type'),
      payload_envelope_json: stringField(value, 'payload_envelope_json'),
      pending_object_key: stringField(value, 'pending_object_key'),
      key_version: Number.isFinite(keyVersion) && keyVersion > 0 ? keyVersion : 1,
      event_at: eventAt ?? payload.created_at,
      index_db_binding: indexDbBinding,
    };
  });
}

function buildSensitiveDetailChunkObjectKey(input: {
  tenantKey: string;
  logType: LogType;
  surface: string;
  chunkId: string;
  createdAt: number;
}): string {
  return buildLogChunkObjectKey({
    prefix: 'sensitive-details/v1',
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: 'sensitive_detail',
    surface: input.surface,
    createdAt: input.createdAt,
    chunkId: input.chunkId,
    shard: defaultLogStorageShard({ tenantKey: input.tenantKey }),
    compression: 'gzip_block',
  });
}

async function gzipSensitiveDetailJsonl(
  value: string
): Promise<{ body: Uint8Array; encoding: 'gzip' | 'none' }> {
  if (typeof CompressionStream === 'undefined') {
    return { body: new TextEncoder().encode(value), encoding: 'none' };
  }
  const stream = new Blob([new TextEncoder().encode(value)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return {
    body: new Uint8Array(await new Response(stream).arrayBuffer()),
    encoding: 'gzip',
  };
}

async function sensitiveDetailSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sensitiveDetailIndexAdapter(
  env: AuditQueueConsumerEnv,
  binding: 'DB' | 'DB_ADMIN' | 'LOGGING_INDEX_DB'
): DatabaseSource {
  if (binding === 'DB_ADMIN') {
    if (!env.DB_ADMIN) {
      throw new Error('sensitive_detail_admin_db_unavailable');
    }
    return env.DB_ADMIN;
  }
  if (binding === 'LOGGING_INDEX_DB') {
    if (!env.LOGGING_INDEX_DB) {
      throw new Error('sensitive_detail_logging_index_db_unavailable');
    }
    return env.LOGGING_INDEX_DB;
  }
  return env.DB;
}

interface SensitiveDetailFlushProfile {
  maxIntervalMs: number;
  maxRecords: number;
  maxBytes: number;
}

const SENSITIVE_DETAIL_FLUSH_PROFILES: Record<LoggingDeliveryLane, SensitiveDetailFlushProfile> = {
  critical: {
    maxIntervalMs: 60_000,
    maxRecords: 1_000,
    maxBytes: 4 * 1024 * 1024,
  },
  default: {
    maxIntervalMs: 5 * 60_000,
    maxRecords: 1_000,
    maxBytes: 8 * 1024 * 1024,
  },
  bulk: {
    maxIntervalMs: 15 * 60_000,
    maxRecords: 5_000,
    maxBytes: 16 * 1024 * 1024,
  },
};

function sensitiveDetailFlushProfile(lane: LoggingDeliveryLane): SensitiveDetailFlushProfile {
  return SENSITIVE_DETAIL_FLUSH_PROFILES[lane] ?? SENSITIVE_DETAIL_FLUSH_PROFILES.default;
}

function sensitiveDetailEstimatedRecordBytes(record: SensitiveDetailChunkWriteRecord): number {
  return (
    record.payload_envelope_json.length +
    record.catalog_id.length +
    record.tenant_id.length +
    record.object_class.length +
    record.surface.length +
    256
  );
}

function sensitiveDetailTimeBucket(eventAt: number, maxIntervalMs: number): number {
  return Math.floor(eventAt / maxIntervalMs);
}

function splitSensitiveDetailFlushChunks(
  group: SensitiveDetailChunkWriteItem[]
): SensitiveDetailChunkWriteItem[][] {
  const first = group[0];
  if (!first) {
    return [];
  }
  const profile = sensitiveDetailFlushProfile(first.payload.lane);
  const chunks: SensitiveDetailChunkWriteItem[][] = [];
  const sorted = [...group].sort((a, b) => a.record.event_at - b.record.event_at);
  let current: SensitiveDetailChunkWriteItem[] = [];
  let currentBytes = 0;
  let currentBucket: number | null = null;

  for (const item of sorted) {
    const itemBytes = sensitiveDetailEstimatedRecordBytes(item.record);
    const itemBucket = sensitiveDetailTimeBucket(item.record.event_at, profile.maxIntervalMs);
    const wouldExceedRecords = current.length >= profile.maxRecords;
    const wouldExceedBytes = current.length > 0 && currentBytes + itemBytes > profile.maxBytes;
    const wouldCrossTimeBucket = currentBucket !== null && itemBucket !== currentBucket;
    if (current.length > 0 && (wouldExceedRecords || wouldExceedBytes || wouldCrossTimeBucket)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
      currentBucket = null;
    }
    current.push(item);
    currentBytes += itemBytes;
    currentBucket = itemBucket;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function writeSensitiveDetailChunk(input: {
  env: AuditQueueConsumerEnv;
  adapter: ReturnType<typeof ensureDatabaseAdapter>;
  tenantKey: string;
  logType: LogType;
  surface: string;
  records: SensitiveDetailChunkWriteRecord[];
  now: number;
  chunkCreatedAt: number;
}): Promise<{
  objectKey: string;
  checksumSha256: string;
  byteCount: number;
  recordBytes: number[];
}> {
  if (!input.env.SENSITIVE_DETAILS) {
    throw new Error('sensitive_detail_bucket_unavailable');
  }
  if (!input.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    throw new Error('sensitive_detail_root_key_unavailable');
  }
  const chunkId = createLoggingId('chk', input.now);
  const objectKey = buildSensitiveDetailChunkObjectKey({
    tenantKey: input.tenantKey,
    logType: input.logType,
    surface: input.surface,
    chunkId,
    createdAt: input.chunkCreatedAt,
  });
  const lines: string[] = [];
  const recordBytes: number[] = [];
  for (const record of input.records) {
    const plaintext = await decryptObjectArtifact(JSON.parse(record.payload_envelope_json), {
      rootKeyHex: input.env.OBJECT_ENCRYPTION_ROOT_KEY,
      context: {
        tenantId: record.tenant_id,
        objectKey: record.pending_object_key,
        objectClass: record.object_class as never,
      },
    });
    const encrypted = await encryptObjectArtifact(plaintext, {
      rootKeyHex: input.env.OBJECT_ENCRYPTION_ROOT_KEY,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: record.key_version,
      contentType: record.content_type,
      context: {
        tenantId: record.tenant_id,
        objectKey,
        objectClass: record.object_class as never,
      },
    });
    const line = JSON.stringify(encrypted);
    lines.push(line);
    recordBytes.push(new TextEncoder().encode(line).byteLength);
  }
  const encoded = await gzipSensitiveDetailJsonl(`${lines.join('\n')}\n`);
  const checksumSha256 = await sensitiveDetailSha256Hex(encoded.body);
  await input.env.SENSITIVE_DETAILS.put(objectKey, encoded.body, {
    httpMetadata: {
      contentType: 'application/x-ndjson',
      contentEncoding: encoded.encoding === 'gzip' ? 'gzip' : undefined,
    },
    customMetadata: {
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: 'sensitive_detail',
      surface: input.surface,
      shard: defaultLogStorageShard({ tenantKey: input.tenantKey }),
      recordCount: String(input.records.length),
      checksumSha256,
      createdAt: String(input.now),
      chunkStartAt: String(Math.min(...input.records.map((record) => record.event_at))),
      chunkEndAt: String(Math.max(...input.records.map((record) => record.event_at))),
    },
  });

  await input.adapter.batch(
    input.records.flatMap((record, lineNumber) => [
      {
        sql: `INSERT INTO object_catalog_objects (
          id, catalog_id, representation, object_kind, object_index, bucket_binding, object_key,
          key_version, checksum_sha256, total_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          crypto.randomUUID(),
          record.catalog_id,
          'canonical_json',
          'chunk',
          0,
          'SENSITIVE_DETAILS',
          objectKey,
          record.key_version,
          checksumSha256,
          encoded.body.byteLength,
          input.now,
        ],
      },
      {
        sql: `UPDATE object_catalog
          SET updated_at = ?
          WHERE id = ?
            AND tenant_id = ?
            AND deleted_at IS NULL`,
        params: [input.now, record.catalog_id, record.tenant_id],
      },
      {
        sql: `INSERT INTO sensitive_detail_chunk_index (
          catalog_id, tenant_id, object_class, bucket_binding, object_key,
          content_encoding, line_number, byte_offset, byte_length, key_version, checksum_sha256,
          created_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          record.catalog_id,
          record.tenant_id,
          record.object_class,
          'SENSITIVE_DETAILS',
          objectKey,
          encoded.encoding,
          lineNumber,
          recordBytes.slice(0, lineNumber).reduce((sum, byteCount) => sum + byteCount + 1, 0),
          recordBytes[lineNumber] ?? null,
          record.key_version,
          checksumSha256,
          record.event_at,
          null,
        ],
      },
    ])
  );

  return { objectKey, checksumSha256, byteCount: encoded.body.byteLength, recordBytes };
}

async function processSensitiveDetailChunkWritePayloadBatch(input: {
  items: SensitiveDetailChunkWriteItem[];
  env: AuditQueueConsumerEnv;
  logger: Logger;
}): Promise<void> {
  const deliveryEventStore = createDeliveryEventStore(input.env);
  const groups = new Map<string, SensitiveDetailChunkWriteItem[]>();
  for (const item of input.items) {
    const key = [
      item.record.index_db_binding,
      item.payload.tenant_key,
      item.payload.log_type,
      item.record.surface,
    ].join('\u001f');
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const adapter = ensureDatabaseAdapter(
      sensitiveDetailIndexAdapter(input.env, first.record.index_db_binding),
      'sensitive-detail-chunk-writer'
    );
    const failedMessages = new Set<Message<unknown>>();
    const successfulMessages = new Set<Message<unknown>>();
    for (const chunkGroup of splitSensitiveDetailFlushChunks(group)) {
      const now = Date.now();
      const records = chunkGroup.map((item) => item.record);
      const chunkCreatedAt = Math.min(...records.map((record) => record.event_at));
      try {
        const written = await writeSensitiveDetailChunk({
          env: input.env,
          adapter,
          tenantKey: first.payload.tenant_key,
          logType: first.payload.log_type,
          surface: first.record.surface,
          records,
          now,
          chunkCreatedAt,
        });
        await recordDeliveryEvent(deliveryEventStore, input.logger, {
          tenantKey: first.payload.tenant_key,
          destinationId: 'sensitive_detail_chunk_writer',
          logType: first.payload.log_type,
          plane: 'sensitive_detail',
          lane: first.payload.lane,
          status: 'delivered',
          attemptCount: Math.max(...group.map((item) => item.message.attempts), 1),
          metadata: {
            object_key: written.objectKey,
            record_count: records.length,
            byte_count: written.byteCount,
            checksum_sha256: written.checksumSha256,
            flush_profile: first.payload.lane,
          },
        });
        for (const message of new Set(chunkGroup.map((item) => item.message))) {
          successfulMessages.add(message);
        }
      } catch (error) {
        await recordDeliveryEvent(deliveryEventStore, input.logger, {
          tenantKey: first.payload.tenant_key,
          destinationId: 'sensitive_detail_chunk_writer',
          logType: first.payload.log_type,
          plane: 'sensitive_detail',
          lane: first.payload.lane,
          status: 'retrying',
          attemptCount: Math.max(...group.map((item) => item.message.attempts), 1),
          errorClass: deliveryErrorClass(error, 'sensitive_detail_chunk_write_failed'),
          metadata: {
            record_count: records.length,
            error: sanitizeErrorMessage(String(error)),
          },
        });
        for (const message of new Set(chunkGroup.map((item) => item.message))) {
          failedMessages.add(message);
        }
      }
    }
    for (const message of new Set(group.map((item) => item.message))) {
      if (failedMessages.has(message)) {
        message.retry();
      } else if (successfulMessages.has(message)) {
        message.ack();
      }
    }
  }
}

async function processChunkWritePayload(input: {
  payload: ChunkWritePayload;
  message: Message<unknown>;
  env: AuditQueueConsumerEnv;
  logger: Logger;
}): Promise<'ack' | 'retry'> {
  const { payload, message, env, logger } = input;
  if (!env.DB_ADMIN) {
    throw new Error('chunk_write_admin_db_unavailable');
  }
  const bucket = getChunkWriteBucket(env, payload.plane);
  if (!bucket) {
    throw new Error('chunk_write_bucket_unavailable');
  }

  const attemptCount = Math.max(1, message.attempts);
  const deliveryEventStore = createDeliveryEventStore(env);
  const notificationRepository = createInternalNotificationRepository(env);
  const catalogStore = new SqlLogChunkCatalogStore(env.DB_ADMIN);
  const metadataBase = {
    payload_id: payload.payload_id,
    records_object_ref: payload.records_object_ref ?? null,
  };

  try {
    const records = await loadChunkWriteRecords(payload, env);
    const stablePurpose = `chunk-write:${payload.payload_id}`;
    const result = await writeLogChunkToR2({
      bucket,
      tenantKey: payload.tenant_key,
      logType: payload.log_type,
      plane: payload.plane,
      records,
      prefix: 'logs/v1',
      indexProfile: payload.log_type,
      catalogStore,
      now: queueMessageTimestamp(message),
      chunkId: await createQueueStableLoggingId('chk', message, stablePurpose),
      objectCatalogId: await createQueueStableLoggingId('obj', message, stablePurpose),
      encryption: await resolveArchiveChunkEncryption({
        env,
        tenantKey: payload.tenant_key,
        logType: payload.log_type,
        plane: payload.plane,
      }),
    } as Parameters<typeof writeLogChunkToR2>[0] & {
      chunkId: string;
      objectCatalogId: string;
    });
    await recordDeliveryEvent(deliveryEventStore, logger, {
      id: await createQueueStableLoggingId('lde', message, stablePurpose),
      tenantKey: payload.tenant_key,
      destinationId: 'chunk_writer',
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status: 'delivered',
      attemptCount,
      objectCatalogId: result.objectCatalogId,
      metadata: {
        ...metadataBase,
        object_key: result.objectKey,
        record_count: result.recordCount,
        byte_count: result.byteCount,
        checksum_sha256: result.checksumSha256,
      },
    });
    return 'ack';
  } catch (error) {
    const errorClass = deliveryErrorClass(error, 'chunk_write_failed');
    const retryDelayMs = computeHttpSinkRetryDelayMs({ attempt: attemptCount });
    const metadata = {
      ...metadataBase,
      error: sanitizeErrorMessage(String(error)),
    };
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: payload.tenant_key,
      destinationId: 'chunk_writer',
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      nextRetryAt: Date.now() + retryDelayMs,
      metadata,
    });
    await recordDeliveryNotification(notificationRepository, logger, {
      tenantId: payload.tenant_key,
      tenantKey: payload.tenant_key,
      destinationId: 'chunk_writer',
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      metadata,
    });
    throw error;
  }
}

async function processHttpSinkBatchDeliveryPayload(input: {
  payload: HttpSinkBatchPayload;
  message: Message<unknown>;
  env: AuditQueueConsumerEnv;
  logger: Logger;
}): Promise<'ack' | 'retry'> {
  const { payload, message, env, logger } = input;
  const deliveryEventStore = createDeliveryEventStore(env);
  const notificationRepository = createInternalNotificationRepository(env);
  const attemptCount = Math.max(1, message.attempts);
  const body = await readHttpSinkBatchBody(payload, env);
  const destination = await loadLoggingDestinationForDelivery(env, payload.destination_id).catch(
    () => null
  );
  const providerConfig = parseJsonObject(destination?.provider_config);
  const credentialPlaintext = await resolveRuntimeCredentialSecret({
    env,
    credentialRef: destination?.credential_ref,
    credentialVersion: destination?.credential_version,
  });
  const auth = buildRuntimeHttpSinkAuth({ providerConfig, credentialPlaintext });
  const metadataBase = {
    payload_id: payload.payload_id,
    batch_id: payload.batch_id,
    record_count: payload.record_count,
    byte_count: body.byteCount,
    body_object_ref: body.objectRef,
  };

  try {
    const result = await deliverHttpSinkBatch({
      endpointUrl: payload.endpoint_url,
      body: body.body,
      contentType: body.contentType,
      deliveryId: payload.payload_id,
      attempt: attemptCount,
      auth,
      fetcher: (fetchInput, init) =>
        safeFetch(fetchInputToUrl(fetchInput), {
          ...init,
          timeoutMs: 10000,
          maxResponseSize: 64 * 1024,
        }),
    });
    const status: LoggingDeliveryStatus =
      result.status === 'delivered'
        ? 'delivered'
        : result.status === 'retrying'
          ? 'retrying'
          : 'failed';
    const errorClass = status === 'delivered' ? null : `http_status_${String(result.httpStatus)}`;
    const metadata = {
      ...metadataBase,
      http_status: result.httpStatus,
      redacted_headers: result.redactedHeaders,
    };
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: payload.tenant_key,
      destinationId: payload.destination_id,
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status,
      attemptCount,
      errorClass,
      nextRetryAt:
        status === 'retrying' && result.retryDelayMs ? Date.now() + result.retryDelayMs : null,
      metadata,
    });
    if (status !== 'delivered') {
      await recordDeliveryNotification(notificationRepository, logger, {
        tenantId: payload.tenant_key,
        tenantKey: payload.tenant_key,
        destinationId: payload.destination_id,
        logType: payload.log_type,
        plane: payload.plane,
        lane: payload.lane,
        status,
        attemptCount,
        errorClass,
        metadata,
      });
    }
    return status === 'retrying' ? 'retry' : 'ack';
  } catch (error) {
    const errorClass = deliveryErrorClass(error, 'http_sink_delivery_failed');
    const retryDelayMs = computeHttpSinkRetryDelayMs({ attempt: attemptCount });
    const metadata = {
      ...metadataBase,
      error: sanitizeErrorMessage(String(error)),
    };
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: payload.tenant_key,
      destinationId: payload.destination_id,
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      nextRetryAt: Date.now() + retryDelayMs,
      metadata,
    });
    await recordDeliveryNotification(notificationRepository, logger, {
      tenantId: payload.tenant_key,
      tenantKey: payload.tenant_key,
      destinationId: payload.destination_id,
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      metadata,
    });
    throw error;
  }
}

async function loadLoggingDestinationForDelivery(
  env: AuditQueueConsumerEnv,
  destinationId: string
): Promise<RuntimeDeliveryDestination | null> {
  if (!env.DB_ADMIN) {
    throw new Error('logging_delivery_admin_db_unavailable');
  }
  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'logging-delivery-destinations');
  return adapter.queryOne<RuntimeDeliveryDestination>(
    `SELECT id, provider, lifecycle_status, provider_config,
            credential_ref, credential_version
     FROM admin_destinations
     WHERE id = ?
       AND deleted_at IS NULL`,
    [destinationId]
  );
}

async function processDeliveryFanoutPayload(input: {
  payload: DeliveryFanoutPayload | LogChunkDeliveryPayload;
  message: Message<unknown>;
  env: AuditQueueConsumerEnv;
  logger: Logger;
}): Promise<'ack' | 'retry'> {
  const { payload, message, env, logger } = input;
  const deliveryEventStore = createDeliveryEventStore(env);
  const notificationRepository = createInternalNotificationRepository(env);
  const attemptCount = Math.max(1, message.attempts);
  const metadataBase = {
    payload_id: payload.payload_id,
    catalog_id: payload.catalog_id,
    object_key: payload.object_key,
    record_count: payload.record_count,
  };

  try {
    const isLegacyPlatformDefaultArchive =
      payload.destination_id === PLATFORM_DEFAULT_R2_ARCHIVE_DESTINATION_ID &&
      payload.plane === 'archive';
    const destination: RuntimeDeliveryDestination | null = isLegacyPlatformDefaultArchive
      ? {
          id: PLATFORM_DEFAULT_R2_ARCHIVE_DESTINATION_ID,
          provider: 'r2',
          lifecycle_status: 'active',
          provider_config: null,
          credential_ref: null,
          credential_version: null,
        }
      : await loadLoggingDestinationForDelivery(env, payload.destination_id);
    if (!destination) {
      throw new Error('logging_delivery_destination_not_found');
    }
    if (destination.lifecycle_status !== 'active') {
      throw new Error('logging_delivery_destination_not_active');
    }
    const providerConfig = parseJsonObject(destination.provider_config);
    const credentialPlaintext = await resolveRuntimeCredentialSecret({
      env,
      credentialRef: destination.credential_ref,
      credentialVersion: destination.credential_version,
    });
    const auth = buildRuntimeHttpSinkAuth({ providerConfig, credentialPlaintext });

    if (destination.provider === 'http') {
      const endpointUrl = configString(providerConfig, ['url', 'endpointUrl']);
      if (!endpointUrl) {
        throw new Error('logging_delivery_http_url_missing');
      }
      const body = JSON.stringify({
        payload_type: 'log_chunk_reference',
        payload_id: payload.payload_id,
        tenant_key: payload.tenant_key,
        catalog_id: payload.catalog_id,
        object_key: payload.object_key,
        log_type: payload.log_type,
        plane: payload.plane,
        record_count: payload.record_count,
        created_at: payload.created_at,
      });
      const result = await deliverHttpSinkBatch({
        endpointUrl,
        body,
        contentType: 'application/json',
        deliveryId: payload.payload_id,
        attempt: attemptCount,
        auth,
        fetcher: (fetchInput, init) =>
          safeFetch(fetchInputToUrl(fetchInput), {
            ...init,
            timeoutMs: 10000,
            maxResponseSize: 64 * 1024,
          }),
      });
      const status: LoggingDeliveryStatus =
        result.status === 'delivered'
          ? 'delivered'
          : result.status === 'retrying'
            ? 'retrying'
            : 'failed';
      const errorClass = status === 'delivered' ? null : `http_status_${String(result.httpStatus)}`;
      const metadata = {
        ...metadataBase,
        provider: destination.provider,
        http_status: result.httpStatus,
        redacted_headers: result.redactedHeaders,
      };
      await recordDeliveryEvent(deliveryEventStore, logger, {
        tenantKey: payload.tenant_key,
        destinationId: payload.destination_id,
        logType: payload.log_type,
        plane: payload.plane,
        lane: payload.lane,
        status,
        attemptCount,
        errorClass,
        objectCatalogId: payload.catalog_id,
        nextRetryAt:
          status === 'retrying' && result.retryDelayMs ? Date.now() + result.retryDelayMs : null,
        metadata,
      });
      if (status !== 'delivered') {
        await recordDeliveryNotification(notificationRepository, logger, {
          tenantId: payload.tenant_key,
          tenantKey: payload.tenant_key,
          destinationId: payload.destination_id,
          logType: payload.log_type,
          plane: payload.plane,
          lane: payload.lane,
          status,
          attemptCount,
          errorClass,
          metadata,
        });
      }
      return status === 'retrying' ? 'retry' : 'ack';
    }

    if (destination.provider === 'r2') {
      await recordDeliveryEvent(deliveryEventStore, logger, {
        tenantKey: payload.tenant_key,
        destinationId: payload.destination_id,
        logType: payload.log_type,
        plane: payload.plane,
        lane: payload.lane,
        status: 'delivered',
        attemptCount,
        objectCatalogId: payload.catalog_id,
        metadata: {
          ...metadataBase,
          provider: destination.provider,
          mode: 'chunk_already_written',
        },
      });
      return 'ack';
    }

    throw new Error(`logging_delivery_destination_provider_unsupported:${destination.provider}`);
  } catch (error) {
    const errorClass = deliveryErrorClass(error, 'delivery_fanout_failed');
    const retryDelayMs = computeHttpSinkRetryDelayMs({ attempt: attemptCount });
    const metadata = {
      ...metadataBase,
      error: sanitizeErrorMessage(String(error)),
    };
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: payload.tenant_key,
      destinationId: payload.destination_id,
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      objectCatalogId: payload.catalog_id,
      nextRetryAt: Date.now() + retryDelayMs,
      metadata,
    });
    await recordDeliveryNotification(notificationRepository, logger, {
      tenantId: payload.tenant_key,
      tenantKey: payload.tenant_key,
      destinationId: payload.destination_id,
      logType: payload.log_type,
      plane: payload.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      metadata,
    });
    throw error;
  }
}

interface LoggingRewrapJobQueueRow {
  id: string;
  key_registry_id: string;
  from_version: number;
  to_version: number;
  status: string;
  metadata: string | null;
}

interface LoggingRewrapCatalogRow {
  id: string;
  tenant_key: string;
  log_type: LogType;
  plane: LogPlane;
  object_key: string;
  chunk_id: string | null;
  object_kind: string;
  status: string;
  record_count: number;
  byte_count: number;
  checksum_sha256: string | null;
  compression: LogChunkCompression | null;
  encryption_scope: string | null;
  key_version: number | null;
}

function parseRewrapMetadata(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function serializeRewrapMetadata(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

async function completeLoggingRewrapJob(input: {
  adapter: ReturnType<typeof ensureDatabaseAdapter>;
  job: LoggingRewrapJobQueueRow;
  status: 'succeeded' | 'failed' | 'skipped';
  metadata: Record<string, unknown>;
  completedAt: number;
}): Promise<void> {
  await input.adapter.execute(
    `UPDATE logging_rewrap_jobs
     SET status = ?, completed_at = ?, metadata = ?
     WHERE id = ?`,
    [
      input.status,
      input.completedAt,
      serializeRewrapMetadata({
        ...parseRewrapMetadata(input.job.metadata),
        ...input.metadata,
      }),
      input.job.id,
    ]
  );
}

async function processRewrapChunkDeliveryPayload(input: {
  payload: RewrapChunkPayload;
  message: Message<unknown>;
  env: AuditQueueConsumerEnv;
  logger: Logger;
}): Promise<'ack' | 'retry'> {
  const { payload, message, env, logger } = input;
  if (!env.DB_ADMIN) {
    throw new Error('logging_rewrap_admin_db_unavailable');
  }
  if (!env.AUDIT_ARCHIVE) {
    throw new Error('logging_rewrap_archive_bucket_unavailable');
  }
  if (!env.OBJECT_ENCRYPTION_ROOT_KEY) {
    throw new Error('logging_rewrap_object_encryption_root_key_unavailable');
  }

  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'logging-rewrap');
  const deliveryEventStore = createDeliveryEventStore(env);
  const notificationRepository = createInternalNotificationRepository(env);
  const attemptCount = Math.max(1, message.attempts);
  const metadataBase = {
    payload_id: payload.payload_id,
    rewrap_job_id: payload.rewrap_job_id,
    object_catalog_id: payload.object_catalog_id,
  };
  const job = await adapter.queryOne<LoggingRewrapJobQueueRow>(
    `SELECT id, key_registry_id, from_version, to_version, status, metadata
     FROM logging_rewrap_jobs
     WHERE id = ?`,
    [payload.rewrap_job_id]
  );
  if (!job) {
    throw new Error('logging_rewrap_job_not_found');
  }
  if (job.status === 'succeeded' || job.status === 'skipped') {
    return 'ack';
  }
  if (job.status !== 'queued' && job.status !== 'running') {
    throw new Error(`logging_rewrap_job_not_runnable:${job.status}`);
  }

  const object = await adapter.queryOne<LoggingRewrapCatalogRow>(
    `SELECT id, tenant_key, log_type, plane, object_key,
            (SELECT chunk_id FROM log_chunk_record_index WHERE object_catalog_id = log_object_catalog.id LIMIT 1) AS chunk_id,
            object_kind, status,
            record_count, byte_count, checksum_sha256, compression, encryption_scope, key_version
     FROM log_object_catalog
     WHERE id = ?`,
    [payload.object_catalog_id]
  );
  if (!object) {
    throw new Error('logging_rewrap_object_catalog_not_found');
  }

  const completeSkipped = async (reason: string) => {
    const now = Date.now();
    await completeLoggingRewrapJob({
      adapter,
      job,
      status: 'skipped',
      completedAt: now,
      metadata: {
        ...metadataBase,
        skip_reason: reason,
        object_key: object.object_key,
      },
    });
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: object.tenant_key,
      destinationId: `rewrap:${job.id}`,
      logType: object.log_type,
      plane: object.plane,
      lane: payload.lane,
      status: 'delivered',
      attemptCount,
      objectCatalogId: object.id,
      metadata: {
        ...metadataBase,
        skip_reason: reason,
      },
    });
  };

  if (
    object.object_kind !== 'chunk' ||
    object.status !== 'committed' ||
    !object.chunk_id ||
    !object.compression ||
    !object.encryption_scope ||
    !object.key_version
  ) {
    await completeSkipped('object_not_rewrappable');
    return 'ack';
  }
  if (object.key_version !== job.from_version) {
    await completeSkipped('object_key_version_mismatch');
    return 'ack';
  }

  try {
    if (job.status === 'queued') {
      await adapter.execute(
        `UPDATE logging_rewrap_jobs
         SET status = ?, started_at = ?
         WHERE id = ? AND status = ?`,
        ['running', Date.now(), job.id, 'queued']
      );
    }

    const encryptionScope = `tenant:${object.tenant_key}:${object.log_type}:${object.plane}`;
    const result = await rewrapLogChunkObject({
      bucket: env.AUDIT_ARCHIVE,
      objectCatalogId: object.id,
      objectKey: object.object_key,
      chunkId: object.chunk_id,
      tenantKey: object.tenant_key,
      logType: object.log_type,
      plane: object.plane,
      compression: object.compression,
      from: {
        keyBytes: await deriveArchiveChunkEncryptionKey({
          rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
          tenantKey: object.tenant_key,
          logType: object.log_type,
          plane: object.plane,
          keyVersion: job.from_version,
        }),
        encryptionScope: object.encryption_scope,
        keyVersion: job.from_version,
      },
      to: {
        keyBytes: await deriveArchiveChunkEncryptionKey({
          rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
          tenantKey: object.tenant_key,
          logType: object.log_type,
          plane: object.plane,
          keyVersion: job.to_version,
        }),
        encryptionScope,
        keyVersion: job.to_version,
      },
      maxBytes: object.byte_count,
      catalogUpdater: {
        updateRewrappedObject: async (update) => {
          await adapter.execute(
            `UPDATE log_object_catalog
             SET byte_count = ?, checksum_sha256 = ?, encryption_scope = ?,
                 key_version = ?, committed_at = ?
             WHERE id = ? AND status = ?`,
            [
              update.byteCount,
              update.checksumSha256,
              update.encryptionScope,
              update.keyVersion,
              update.updatedAt,
              update.objectCatalogId,
              'committed',
            ]
          );
        },
      },
    });

    await adapter.execute(
      `UPDATE logging_key_versions
       SET stale_count = CASE WHEN stale_count > 0 THEN stale_count - 1 ELSE 0 END
       WHERE key_registry_id = ? AND version = ?`,
      [job.key_registry_id, job.from_version]
    );
    await adapter.execute(
      `UPDATE logging_key_versions
       SET usage_count = usage_count + ?
       WHERE key_registry_id = ? AND version = ?`,
      [object.record_count, job.key_registry_id, job.to_version]
    );
    await completeLoggingRewrapJob({
      adapter,
      job,
      status: 'succeeded',
      completedAt: result.updatedAt,
      metadata: {
        ...metadataBase,
        object_key: object.object_key,
        from_version: job.from_version,
        to_version: job.to_version,
        byte_count: result.byteCount,
        checksum_sha256: result.checksumSha256,
      },
    });
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: object.tenant_key,
      destinationId: `rewrap:${job.id}`,
      logType: object.log_type,
      plane: object.plane,
      lane: payload.lane,
      status: 'delivered',
      attemptCount,
      objectCatalogId: object.id,
      metadata: {
        ...metadataBase,
        from_version: job.from_version,
        to_version: job.to_version,
        byte_count: result.byteCount,
      },
    });
    return 'ack';
  } catch (error) {
    const errorClass = deliveryErrorClass(error, 'logging_rewrap_failed');
    const metadata = {
      ...metadataBase,
      object_key: object.object_key,
      error: sanitizeErrorMessage(String(error)),
    };
    if (attemptCount >= 5) {
      await completeLoggingRewrapJob({
        adapter,
        job,
        status: 'failed',
        completedAt: Date.now(),
        metadata,
      });
      await recordDeliveryEvent(deliveryEventStore, logger, {
        tenantKey: object.tenant_key,
        destinationId: `rewrap:${job.id}`,
        logType: object.log_type,
        plane: object.plane,
        lane: payload.lane,
        status: 'failed',
        attemptCount,
        errorClass,
        objectCatalogId: object.id,
        metadata,
      });
      await recordDeliveryNotification(notificationRepository, logger, {
        tenantId: object.tenant_key,
        tenantKey: object.tenant_key,
        destinationId: `rewrap:${job.id}`,
        logType: object.log_type,
        plane: object.plane,
        lane: payload.lane,
        status: 'failed',
        attemptCount,
        errorClass,
        metadata,
      });
      return 'ack';
    }

    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: object.tenant_key,
      destinationId: `rewrap:${job.id}`,
      logType: object.log_type,
      plane: object.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      objectCatalogId: object.id,
      nextRetryAt: Date.now() + computeHttpSinkRetryDelayMs({ attempt: attemptCount }),
      metadata,
    });
    await recordDeliveryNotification(notificationRepository, logger, {
      tenantId: object.tenant_key,
      tenantKey: object.tenant_key,
      destinationId: `rewrap:${job.id}`,
      logType: object.log_type,
      plane: object.plane,
      lane: payload.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      metadata,
    });
    throw error;
  }
}

async function processDlqReplayDeliveryPayload(input: {
  payload: DlqReplayPayload;
  message: Message<unknown>;
  env: AuditQueueConsumerEnv;
  logger: Logger;
}): Promise<'ack' | 'retry'> {
  const { payload, message, env, logger } = input;
  if (!env.DB_ADMIN) {
    throw new Error('logging_dlq_replay_admin_db_unavailable');
  }
  const bucket = getDefaultLoggingDeliveryPayloadBucket(env);
  if (!bucket) {
    throw new Error('logging_dlq_replay_payload_bucket_unavailable');
  }

  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'logging-dlq-replay');
  const deliveryEventStore = createDeliveryEventStore(env);
  const notificationRepository = createInternalNotificationRepository(env);
  const attemptCount = Math.max(1, message.attempts);
  const item = await adapter.queryOne<{
    id: string;
    tenant_key: string;
    payload_type: string;
    schema_version: number;
    lane: LoggingDeliveryLane;
    destination_id: string | null;
    payload_object_ref: string;
    status: string;
  }>(
    `SELECT id, tenant_key, payload_type, schema_version, lane, destination_id,
            payload_object_ref, status
     FROM logging_dlq_items
     WHERE id = ?`,
    [payload.dlq_item_id]
  );
  if (!item) {
    throw new Error('logging_dlq_replay_item_not_found');
  }
  if (item.status !== 'open') {
    throw new Error('logging_dlq_replay_item_not_open');
  }

  const metadataBase = {
    payload_id: payload.payload_id,
    dlq_item_id: item.id,
    requested_by: payload.requested_by,
    replay_payload_type: item.payload_type,
    replay_schema_version: item.schema_version,
    payload_object_ref: item.payload_object_ref,
  };

  try {
    const object = await bucket.get(item.payload_object_ref);
    if (!object) {
      throw new Error('logging_dlq_replay_payload_object_not_found');
    }
    const objectRead = await readLoggingDeliveryPayloadObjectText(
      object,
      'logging_dlq_replay_payload_object'
    );
    const parsed = JSON.parse(objectRead.text) as { body?: unknown };
    if (!parsed || typeof parsed !== 'object' || !parsed.body) {
      throw new Error('logging_dlq_replay_payload_body_missing');
    }
    let replayQueueBinding: string | null = null;
    let replayQueueFallbackUsed = false;
    if (item.payload_type === 'audit_queue_message') {
      if (!env.AUDIT_QUEUE) {
        throw new Error('logging_dlq_replay_audit_queue_unavailable');
      }
      await env.AUDIT_QUEUE.send(parsed.body);
      replayQueueBinding = 'AUDIT_QUEUE';
    } else {
      const replayResult = await enqueueRuntimeLoggingDeliveryRawPayload({
        payload: parsed.body,
        lane: item.lane,
        payloadId: payload.payload_id,
        env,
      });
      if (!replayResult.queued) {
        throw new Error('logging_dlq_replay_delivery_queue_unavailable');
      }
      replayQueueBinding = replayResult.bindingName;
      replayQueueFallbackUsed = replayResult.fallbackUsed;
    }
    const now = Date.now();
    await adapter.execute(
      `UPDATE logging_dlq_items
       SET status = 'replayed', updated_at = ?
       WHERE id = ? AND status = 'open'`,
      [now, item.id]
    );
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: item.tenant_key,
      destinationId: item.destination_id ?? 'queue:AUDIT_QUEUE',
      logType: 'operational',
      plane: 'delivery_event',
      lane: item.lane,
      status: 'delivered',
      attemptCount,
      metadata: {
        ...metadataBase,
        replay_queue_binding: replayQueueBinding,
        replay_queue_fallback_used: replayQueueFallbackUsed,
      },
    });
    return 'ack';
  } catch (error) {
    const errorClass = deliveryErrorClass(error, 'logging_dlq_replay_failed');
    const metadata = {
      ...metadataBase,
      error: sanitizeErrorMessage(String(error)),
    };
    await recordDeliveryEvent(deliveryEventStore, logger, {
      tenantKey: item.tenant_key,
      destinationId: item.destination_id ?? 'queue:AUDIT_QUEUE',
      logType: 'operational',
      plane: 'delivery_event',
      lane: item.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      metadata,
    });
    await recordDeliveryNotification(notificationRepository, logger, {
      tenantId: item.tenant_key,
      tenantKey: item.tenant_key,
      destinationId: item.destination_id ?? 'queue:AUDIT_QUEUE',
      logType: 'operational',
      plane: 'delivery_event',
      lane: item.lane,
      status: 'retrying',
      attemptCount,
      errorClass,
      metadata,
    });
    throw error;
  }
}

/**
 * Process future logging delivery queue payloads.
 *
 * Unsupported schema versions are durable DLQ records and are acknowledged instead of retried.
 * Supported payload handlers acknowledge permanent outcomes and retry transient producer/delivery
 * failures through Cloudflare Queue semantics.
 */
export async function processLoggingDeliveryQueue(
  batch: MessageBatch<unknown>,
  env: AuditQueueConsumerEnv,
  logger?: Logger
): Promise<void> {
  const log = logger ?? createLogger().module('LoggingDeliveryQueueConsumer');
  const parsedMessages: Array<{ message: Message<unknown>; payload: LoggingDeliveryQueuePayload }> =
    [];
  const sensitiveDetailChunkWrites: SensitiveDetailChunkWriteItem[] = [];

  for (const message of batch.messages) {
    try {
      const parseResult = parseLoggingDeliveryQueuePayload(message.body);
      if (!parseResult.ok && shouldDlqUnsupportedQueuePayload(parseResult)) {
        await writeUnsupportedLoggingDeliveryPayloadToDlq({
          message,
          parseResult,
          env,
          logger: log,
        });
        log.warn('logging_delivery_payload_unsupported_schema_dlq', {
          messageId: message.id,
          payloadType: parseResult.payloadType,
          schemaVersion: parseResult.schemaVersion,
        });
        message.ack();
        continue;
      }

      if (!parseResult.ok) {
        throw new Error(`logging_delivery_payload_${parseResult.reason}`);
      }

      if (
        parseResult.payload.payload_type === 'chunk_write' &&
        isSensitiveDetailChunkWritePayload(parseResult.payload)
      ) {
        for (const record of parseSensitiveDetailChunkWriteRecords(parseResult.payload)) {
          sensitiveDetailChunkWrites.push({ payload: parseResult.payload, message, record });
        }
        continue;
      }

      parsedMessages.push({ message, payload: parseResult.payload });
    } catch (error) {
      log.error('logging_delivery_queue_message_failed', {
        messageId: message.id,
        attempts: message.attempts,
        error: sanitizeErrorMessage(String(error)),
      });
      message.retry();
    }
  }

  if (sensitiveDetailChunkWrites.length > 0) {
    await processSensitiveDetailChunkWritePayloadBatch({
      items: sensitiveDetailChunkWrites,
      env,
      logger: log,
    });
  }

  for (const { message, payload } of parsedMessages) {
    try {
      if (payload.payload_type === 'chunk_write') {
        const result = await processChunkWritePayload({
          payload,
          message,
          env,
          logger: log,
        });
        if (result === 'retry') {
          message.retry();
        } else {
          message.ack();
        }
        continue;
      }

      if (payload.payload_type === 'http_sink_batch') {
        const result = await processHttpSinkBatchDeliveryPayload({
          payload,
          message,
          env,
          logger: log,
        });
        if (result === 'retry') {
          message.retry();
        } else {
          message.ack();
        }
        continue;
      }

      if (
        payload.payload_type === 'delivery_fanout' ||
        payload.payload_type === 'log_chunk_delivery'
      ) {
        const result = await processDeliveryFanoutPayload({
          payload,
          message,
          env,
          logger: log,
        });
        if (result === 'retry') {
          message.retry();
        } else {
          message.ack();
        }
        continue;
      }

      if (payload.payload_type === 'dlq_replay') {
        const result = await processDlqReplayDeliveryPayload({
          payload,
          message,
          env,
          logger: log,
        });
        if (result === 'retry') {
          message.retry();
        } else {
          message.ack();
        }
        continue;
      }

      if (payload.payload_type === 'rewrap_chunk') {
        const result = await processRewrapChunkDeliveryPayload({
          payload,
          message,
          env,
          logger: log,
        });
        if (result === 'retry') {
          message.retry();
        } else {
          message.ack();
        }
        continue;
      }

      throw new Error('logging_delivery_payload_handler_not_implemented');
    } catch (error) {
      log.error('logging_delivery_queue_message_failed', {
        messageId: message.id,
        attempts: message.attempts,
        error: sanitizeErrorMessage(String(error)),
      });
      message.retry();
    }
  }
}

// =============================================================================
// Retention Cleanup
// =============================================================================

/**
 * Delete expired event log entries for one tenant.
 */
export async function cleanupExpiredTenantEventLogs(
  db: DatabaseSource,
  tenantId: string,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();
  const adapter = ensureDatabaseAdapter(db, 'audit-cleanup-event');
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error('cleanupExpiredTenantEventLogs requires tenantId');
  }

  const result = await adapter.execute(
    'DELETE FROM event_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?',
    [now, normalizedTenantId, batchSize]
  );
  return result.rowsAffected;
}

/**
 * Delete expired event log entries across all tenants.
 *
 * This is a system maintenance operation and must not be used from tenant request paths.
 */
export async function cleanupExpiredGlobalEventLogs(
  db: DatabaseSource,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();
  const adapter = ensureDatabaseAdapter(db, 'audit-cleanup-event-global');

  const result = await adapter.execute('DELETE FROM event_log WHERE retention_until < ? LIMIT ?', [
    now,
    batchSize,
  ]);
  return result.rowsAffected;
}

/**
 * Delete expired PII log entries for one tenant.
 */
export async function cleanupExpiredTenantPIILogs(
  db: DatabaseSource,
  tenantId: string,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();
  const adapter = ensureDatabaseAdapter(db, 'audit-cleanup-pii');
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error('cleanupExpiredTenantPIILogs requires tenantId');
  }

  const result = await adapter.execute(
    'DELETE FROM pii_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?',
    [now, normalizedTenantId, batchSize]
  );
  return result.rowsAffected;
}

/**
 * Delete expired PII log entries across all tenants.
 *
 * This is a system maintenance operation and must not be used from tenant request paths.
 */
export async function cleanupExpiredGlobalPIILogs(
  db: DatabaseSource,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();
  const adapter = ensureDatabaseAdapter(db, 'audit-cleanup-pii-global');

  const result = await adapter.execute('DELETE FROM pii_log WHERE retention_until < ? LIMIT ?', [
    now,
    batchSize,
  ]);
  return result.rowsAffected;
}
