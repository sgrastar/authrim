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

const log = createLogger().module('OPERATIONAL_LOGS');

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
  encryptionKey: string,
  params: StoreOperationalLogParams
): Promise<string> {
  if (!params.reasonDetail) {
    // No reason_detail to store
    return '';
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const retentionDays = params.retentionDays ?? 90;
  const expiresAt = now + retentionDays * 24 * 60 * 60;

  // Encrypt reason_detail using AES-256-GCM
  const encrypted = await encryptValue(params.reasonDetail, encryptionKey, 'AES-256-GCM', 1);

  await adapter.execute(
    `INSERT INTO operational_logs
     (id, tenant_id, subject_type, subject_id, actor_id, action, reason_detail_encrypted, encryption_key_version, request_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.tenantId,
      params.subjectType,
      params.subjectId,
      params.actorId,
      params.action,
      encrypted.encrypted,
      encrypted.keyVersion,
      params.requestId ?? null,
      now,
      expiresAt,
    ]
  );

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
  encryptionKey: string,
  tenantId: string,
  logId: string
): Promise<
  (Omit<OperationalLogEntry, 'reason_detail_encrypted'> & { reason_detail: string }) | null
> {
  const entry = await adapter.queryOne<OperationalLogEntry>(
    `SELECT * FROM operational_logs WHERE id = ? AND tenant_id = ? AND expires_at > ?`,
    [logId, tenantId, Math.floor(Date.now() / 1000)]
  );

  if (!entry) {
    return null;
  }

  // Decrypt reason_detail
  const decrypted = await decryptValue(entry.reason_detail_encrypted, encryptionKey);

  return {
    id: entry.id,
    tenant_id: entry.tenant_id,
    subject_type: entry.subject_type,
    subject_id: entry.subject_id,
    actor_id: entry.actor_id,
    action: entry.action,
    reason_detail: decrypted.decrypted,
    encryption_key_version: entry.encryption_key_version,
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
