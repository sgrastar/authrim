/**
 * Operational Logs Service
 *
 * Handles storage and retrieval of sensitive operational data like reason_detail.
 * These logs are stored separately from audit logs for privacy compliance:
 *
 * - Audit logs: Contain only reason_code (permanent, immutable, no PII)
 * - Operational logs: Contain reason_detail (encrypted, short retention, access-controlled)
 *
 * Storage: D1 operational_logs table with AES-256-GCM encryption
 * Access: system_admin only
 * Retention: Configurable per tenant (default: 90 days)
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { encryptValue, decryptValue } from '../../utils/pii-encryption';
import { createLogger } from '../../utils/logger';
import type { ObjectClass } from '../object-catalog';
import {
  loadChunkedSensitiveDetailJson,
  storeChunkedSensitiveDetailJson,
} from '../sensitive-detail-chunk-store';
import { emitRuntimeLogRecords, type RuntimeLogEmitterEnv } from '../logging-runtime-emitter';
import type { TenantKeyResolver } from './tenant-key';

const log = createLogger().module('OPERATIONAL_LOGS');
const OPERATIONAL_LOG_CONTENT_TYPE = 'application/json';
const DEFAULT_OBJECT_KEY_VERSION = 1;

/**
 * Operational log entry
 */
export interface OperationalLogEntry {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  actor_id: string;
  action: string;
  reason_detail_encrypted: string;
  encryption_key_version: number;
  detail_object_catalog_id?: string | null;
  request_id?: string;
  created_at: number;
  expires_at: number;
}

/**
 * Parameters for storing an operational log
 */
export interface StoreOperationalLogParams {
  tenantId: string;
  subjectType: 'user' | 'client' | 'session';
  subjectId: string;
  actorId: string;
  action: string;
  reasonDetail: string;
  requestId?: string;
  retentionDays?: number;
}

export interface OperationalLogObjectStorageOptions {
  bucket: R2Bucket;
  rootKeyHex: string;
  keyVersion?: number;
  tenantKeySalt?: string;
  tenantKeyResolver?: TenantKeyResolver;
  queueBindings?: Record<string, unknown>;
  indexDbBinding?: 'DB' | 'DB_ADMIN' | 'LOGGING_INDEX_DB';
}

export interface OperationalLogStorageOptions {
  inlineEncryptionKey?: string;
  objectStorage?: OperationalLogObjectStorageOptions;
  runtimeLogging?: {
    env: RuntimeLogEmitterEnv;
    tenantKeyResolver?: TenantKeyResolver;
    failOpen?: boolean;
  };
}

function resolveStorageOptions(
  encryptionKeyOrOptions: string | OperationalLogStorageOptions
): OperationalLogStorageOptions {
  return typeof encryptionKeyOrOptions === 'string'
    ? { inlineEncryptionKey: encryptionKeyOrOptions }
    : encryptionKeyOrOptions;
}

/**
 * Store an operational log with encrypted reason_detail
 *
 * @param adapter - Database adapter for D1
 * @param encryptionKey - Hex-encoded AES-256 key
 * @param params - Log parameters
 * @returns The created log entry ID
 */
export async function storeOperationalLog(
  adapter: DatabaseAdapter,
  encryptionKeyOrOptions: string | OperationalLogStorageOptions,
  params: StoreOperationalLogParams
): Promise<string> {
  if (!params.reasonDetail) {
    // No reason_detail to store
    return '';
  }

  const options = resolveStorageOptions(encryptionKeyOrOptions);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const retentionDays = params.retentionDays ?? 90;
  const expiresAt = now + retentionDays * 24 * 60 * 60;
  let reasonDetailEncrypted: string | null = null;
  let encryptionKeyVersion = 1;
  let detailObjectCatalogId: string | null = null;

  if (options.objectStorage) {
    const objectClass: ObjectClass = 'operational_log_detail';
    const keyVersion = options.objectStorage.keyVersion ?? DEFAULT_OBJECT_KEY_VERSION;
    const chunk = await storeChunkedSensitiveDetailJson({
      adapter,
      bucket: options.objectStorage.bucket,
      rootKeyHex: options.objectStorage.rootKeyHex,
      tenantId: params.tenantId,
      objectClass,
      payload: {
        reason_detail: params.reasonDetail,
      },
      contentType: OPERATIONAL_LOG_CONTENT_TYPE,
      createdAt: now * 1000,
      keyVersion,
      tenantKeySalt: options.objectStorage.tenantKeySalt,
      tenantKeyResolver: options.objectStorage.tenantKeyResolver,
      surface: 'operational',
      queueBindings: options.objectStorage.queueBindings,
      indexDbBinding: options.objectStorage.indexDbBinding ?? 'LOGGING_INDEX_DB',
    });
    detailObjectCatalogId = chunk.catalogId;
    encryptionKeyVersion = 0;
  } else if (options.inlineEncryptionKey) {
    const encrypted = await encryptValue(
      params.reasonDetail,
      options.inlineEncryptionKey,
      'AES-256-GCM',
      1
    );
    reasonDetailEncrypted = encrypted.encrypted;
    encryptionKeyVersion = encrypted.keyVersion;
  } else {
    throw new Error('Operational log storage requires inlineEncryptionKey or objectStorage');
  }

  await adapter.execute(
    `INSERT INTO operational_logs
     (id, tenant_id, subject_type, subject_id, actor_id, action, reason_detail_encrypted, encryption_key_version, detail_object_catalog_id, request_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.tenantId,
      params.subjectType,
      params.subjectId,
      params.actorId,
      params.action,
      reasonDetailEncrypted,
      encryptionKeyVersion,
      detailObjectCatalogId,
      params.requestId ?? null,
      now,
      expiresAt,
    ]
  );

  if (options.runtimeLogging) {
    try {
      await emitRuntimeLogRecords({
        env: {
          ...options.runtimeLogging.env,
          DB_ADMIN: options.runtimeLogging.env.DB_ADMIN ?? adapter,
          LOGGING_INDEX_DB: adapter,
        },
        tenantId: params.tenantId,
        logType: 'operational',
        surface: 'operational_log',
        tenantKeyResolver: options.runtimeLogging.tenantKeyResolver,
        records: [
          {
            id,
            eventAt: now * 1000,
            payload: {
              id,
              tenant_id: params.tenantId,
              subject_type: params.subjectType,
              subject_id: params.subjectId,
              actor_id: params.actorId,
              action: params.action,
              request_id: params.requestId ?? null,
              detail_object_catalog_id: detailObjectCatalogId,
              created_at: now,
              expires_at: expiresAt,
            },
            indexedFields: {
              surface: 'operational_log',
              eventType: params.action,
              severity: 'info',
              status: 'stored',
            },
          },
        ],
      });
    } catch (error) {
      if (options.runtimeLogging.failOpen === false) {
        throw error;
      }
      log.warn('Failed to emit operational log runtime record', {
        id,
        action: params.action,
        subjectType: params.subjectType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.debug('Stored operational log', {
    id,
    action: params.action,
    subjectType: params.subjectType,
    subjectId: params.subjectId,
    retentionDays,
  });

  return id;
}

/**
 * Retrieve an operational log by ID (system_admin only)
 *
 * @param adapter - Database adapter
 * @param encryptionKey - Hex-encoded AES-256 key
 * @param tenantId - Tenant ID for isolation
 * @param logId - Operational log ID
 * @returns Decrypted log entry or null
 */
export async function getOperationalLog(
  adapter: DatabaseAdapter,
  encryptionKeyOrOptions: string | OperationalLogStorageOptions,
  tenantId: string,
  logId: string
): Promise<
  | (Omit<OperationalLogEntry, 'reason_detail_encrypted'> & {
      reason_detail: string;
      detail_object_catalog_id?: string | null;
    })
  | null
> {
  const options = resolveStorageOptions(encryptionKeyOrOptions);
  const entry = await adapter.queryOne<OperationalLogEntry>(
    'SELECT * FROM operational_logs WHERE id = ? AND tenant_id = ? AND expires_at > ?',
    [logId, tenantId, Math.floor(Date.now() / 1000)]
  );

  if (!entry) {
    return null;
  }

  let reasonDetail = '';
  if (entry.detail_object_catalog_id && options.objectStorage) {
    const parsed = await loadChunkedSensitiveDetailJson<{ reason_detail?: string }>(
      adapter,
      {
        SENSITIVE_DETAILS: options.objectStorage.bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: options.objectStorage.rootKeyHex,
      },
      {
        tenantId,
        objectCatalogId: entry.detail_object_catalog_id,
        expectedClass: 'operational_log_detail',
      }
    );
    if (!parsed) {
      return null;
    }
    reasonDetail = parsed.reason_detail ?? '';
  } else {
    if (!entry.reason_detail_encrypted || !options.inlineEncryptionKey) {
      return null;
    }
    const decrypted = await decryptValue(
      entry.reason_detail_encrypted,
      options.inlineEncryptionKey
    );
    reasonDetail = decrypted.decrypted;
  }

  return {
    id: entry.id,
    tenant_id: entry.tenant_id,
    subject_type: entry.subject_type,
    subject_id: entry.subject_id,
    actor_id: entry.actor_id,
    action: entry.action,
    reason_detail: reasonDetail,
    encryption_key_version: entry.encryption_key_version,
    detail_object_catalog_id: entry.detail_object_catalog_id,
    request_id: entry.request_id,
    created_at: entry.created_at,
    expires_at: entry.expires_at,
  };
}

/**
 * List operational logs for a subject (system_admin only)
 *
 * @param adapter - Database adapter
 * @param tenantId - Tenant ID
 * @param subjectType - Subject type filter
 * @param subjectId - Subject ID filter
 * @param limit - Maximum entries to return
 * @returns List of log entries (without decrypted content for performance)
 */
export async function listOperationalLogs(
  adapter: DatabaseAdapter,
  tenantId: string,
  subjectType: string,
  subjectId: string,
  limit: number = 50
): Promise<
  Array<{
    id: string;
    action: string;
    actor_id: string;
    request_id?: string;
    created_at: number;
    expires_at: number;
  }>
> {
  const entries = await adapter.query<OperationalLogEntry>(
    `SELECT id, action, actor_id, request_id, created_at, expires_at
     FROM operational_logs
     WHERE tenant_id = ? AND subject_type = ? AND subject_id = ? AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [tenantId, subjectType, subjectId, Math.floor(Date.now() / 1000), limit]
  );

  return entries;
}

/**
 * Delete operational logs for a user (for GDPR "right to be forgotten")
 *
 * @param adapter - Database adapter
 * @param tenantId - Tenant ID
 * @param userId - User ID whose logs should be deleted
 * @returns Number of deleted entries
 */
export async function deleteUserOperationalLogs(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<number> {
  const result = await adapter.execute(
    `DELETE FROM operational_logs
     WHERE tenant_id = ? AND subject_type = 'user' AND subject_id = ?`,
    [tenantId, userId]
  );

  log.info('Deleted user operational logs', {
    tenantId,
    userId,
    deletedCount: result.rowsAffected,
  });

  return result.rowsAffected;
}
