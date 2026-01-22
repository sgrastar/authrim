/**
 * Audit Queue Consumer
 *
 * Cloudflare Queue consumer for processing audit log messages.
 * Features:
 * - Idempotent writes using UPSERT (ON CONFLICT DO NOTHING)
 * - Per-message ack/retry (not batch ack)
 * - DLQ fallback for max_retries exceeded
 */

import type { D1Database, MessageBatch, Message } from '@cloudflare/workers-types';
import type { AuditQueueMessage, EventLogEntry, PIILogEntry } from './types';
import { sanitizeErrorMessage } from './utils';
import { createLogger, type Logger } from '../../utils/logger';

/**
 * Queue consumer environment bindings.
 */
export interface AuditQueueConsumerEnv {
  /** Core database (non-PII) for event_log */
  DB: D1Database;

  /** PII database for pii_log */
  DB_PII: D1Database;

  /** R2 bucket for DLQ message backup (optional) */
  AUDIT_ARCHIVE?: R2Bucket;
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

  if (type === 'event_log') {
    await batchUpsertEventLog(env.DB, entries as EventLogEntry[]);
  } else if (type === 'pii_log') {
    await batchUpsertPIILog(env.DB_PII, entries as PIILogEntry[]);
  } else {
    throw new Error(`Unknown audit message type: ${type}`);
  }
}

/**
 * Batch UPSERT event log entries.
 * Uses ON CONFLICT DO NOTHING for idempotency.
 */
async function batchUpsertEventLog(db: D1Database, entries: EventLogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO event_log (
      id, tenant_id, event_type, event_category, result, severity,
      error_code, error_message, anonymized_user_id, client_id,
      session_id, request_id, duration_ms, details_r2_key, details_json,
      retention_until, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const batch = entries.map((e) =>
    stmt.bind(
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
      e.createdAt
    )
  );

  await db.batch(batch);
}

/**
 * Batch UPSERT PII log entries.
 * Uses ON CONFLICT DO NOTHING for idempotency.
 */
async function batchUpsertPIILog(db: D1Database, entries: PIILogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO pii_log (
      id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
      values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
      actor_user_id, actor_type, request_id, legal_basis, consent_reference,
      retention_until, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const batch = entries.map((e) =>
    stmt.bind(
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
      e.createdAt
    )
  );

  await db.batch(batch);
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
  const timestamp = new Date().toISOString();

  for (const message of batch.messages) {
    try {
      // Save to R2 for recovery
      if (env.AUDIT_ARCHIVE) {
        const r2Key = `dlq/${message.body.tenantId}/${timestamp.slice(0, 10)}/${message.id}.json`;
        await env.AUDIT_ARCHIVE.put(
          r2Key,
          JSON.stringify({
            messageId: message.id,
            receivedAt: timestamp,
            retryCount: message.attempts,
            body: message.body,
          }),
          { httpMetadata: { contentType: 'application/json' } }
        );
      }

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

// =============================================================================
// Retention Cleanup
// =============================================================================

/**
 * Delete expired event log entries.
 *
 * @param db - Core database
 * @param tenantId - Tenant ID (optional, deletes all if not specified)
 * @param batchSize - Max entries to delete per call (default: 1000)
 * @returns Number of entries deleted
 */
export async function cleanupExpiredEventLogs(
  db: D1Database,
  tenantId?: string,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();

  const sql = tenantId
    ? 'DELETE FROM event_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?'
    : 'DELETE FROM event_log WHERE retention_until < ? LIMIT ?';

  const params = tenantId ? [now, tenantId, batchSize] : [now, batchSize];

  const result = await db
    .prepare(sql)
    .bind(...params)
    .run();

  return result.meta?.changes ?? 0;
}

/**
 * Delete expired PII log entries.
 *
 * @param db - PII database
 * @param tenantId - Tenant ID (optional, deletes all if not specified)
 * @param batchSize - Max entries to delete per call (default: 1000)
 * @returns Number of entries deleted
 */
export async function cleanupExpiredPIILogs(
  db: D1Database,
  tenantId?: string,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();

  const sql = tenantId
    ? 'DELETE FROM pii_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?'
    : 'DELETE FROM pii_log WHERE retention_until < ? LIMIT ?';

  const params = tenantId ? [now, tenantId, batchSize] : [now, batchSize];

  const result = await db
    .prepare(sql)
    .bind(...params)
    .run();

  return result.meta?.changes ?? 0;
}
