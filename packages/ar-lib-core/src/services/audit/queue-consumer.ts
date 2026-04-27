/**
 * Audit Queue Consumer
 *
 * Cloudflare Queue consumer for processing audit log messages.
 * Features:
 * - Idempotent writes using portable insert-if-not-exists semantics
 * - Per-message ack/retry (not batch ack)
 * - DLQ fallback for max_retries exceeded
 */

import type { MessageBatch, Message } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter, type DatabaseSource } from '../../db';
import type { AuditTarget } from '../../types/runtime-profile';
import type {
  AuditQueueFanoutPlan,
  AuditQueueMessage,
  EventLogEntry,
  PIILogEntry,
} from './types';
import { sanitizeErrorMessage } from './utils';
import { createLogger, type Logger } from '../../utils/logger';
import { createR2AuditAdapter } from './storage';
import { createAuditPrimaryStorageAdapter } from './external-primary';
import { resolveTenantRuntimeProfilesFromEnv } from '../runtime-profile-resolver';
import {
  buildCanonicalAuditBatch,
  buildCanonicalAuditRecord,
} from './canonical-format';

export interface AuditQueueConsumerEnv {
  /** Core database (non-PII) for event_log */
  DB: DatabaseSource;

  /** PII database for pii_log */
  DB_PII: DatabaseSource;

  /** Legacy archive binding for older queue consumers (optional) */
  AUDIT_ARCHIVE?: R2Bucket;

  /** Common archive binding used by built-in audit profiles (optional) */
  DIAGNOSTIC_LOGS?: R2Bucket;
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
    await processFanoutMessage(message.body, env, logger);
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

async function writeArchiveTarget(
  target: AuditTarget,
  body: AuditQueueMessage,
  env: AuditQueueConsumerEnv
): Promise<void> {
  if (target.type !== 'r2') {
    throw new Error(`Unsupported archive target type: ${target.type}`);
  }

  const bucket = getR2BucketBinding(env, target.bucketRef);
  if (!bucket) {
    throw new Error(`Archive bucket binding not found: ${target.bucketRef}`);
  }

  const adapter = createR2AuditAdapter(bucket, {
    id: `archive:${target.bucketRef}`,
    pathPrefix: target.prefix ?? 'audit',
    format: 'jsonl',
    eventSerializer: (entry) => buildCanonicalAuditRecord(target, body, entry, 'archive'),
    piiSerializer: (entry) => buildCanonicalAuditRecord(target, body, entry, 'archive'),
  });

  if (body.type === 'event_log') {
    const result = await adapter.writeEventLogBatch(body.entries as EventLogEntry[]);
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'archive_write_failed');
    }
    return;
  }

  const result = await adapter.writePIILogBatch(body.entries as PIILogEntry[]);
  if (!result.success) {
    throw new Error(result.errorMessage ?? 'archive_write_failed');
  }
}

function emitLogpushSink(target: Extract<AuditTarget, { type: 'logpush' }>, body: AuditQueueMessage) {
  for (const entry of body.entries) {
    console.log(JSON.stringify(buildCanonicalAuditRecord(target, body, entry, 'logpush')));
  }
}

async function deliverHttpSink(
  target: Extract<AuditTarget, { type: 'http' }>,
  body: AuditQueueMessage,
  env: AuditQueueConsumerEnv
): Promise<void> {
  const resolvedUrl =
    target.url ??
    ((target.urlRef
      ? (env as unknown as Record<string, unknown>)[target.urlRef]
      : undefined) as string | undefined);

  if (!resolvedUrl) {
    throw new Error(`HTTP sink URL not resolved: ${target.urlRef ?? 'missing_url'}`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(resolvedUrl);
  } catch {
    throw new Error('HTTP sink URL is invalid');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('HTTP sink URL must use https');
  }

  const authToken =
    target.authTokenRef != null
      ? ((env as unknown as Record<string, unknown>)[target.authTokenRef] as string | undefined)
      : undefined;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(target.headers ?? {}),
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(parsedUrl.toString(), {
    method: target.method ?? 'POST',
    headers,
    body: JSON.stringify(buildCanonicalAuditBatch(target, body, 'http')),
  });

  if (!response.ok) {
    throw new Error(`HTTP sink delivery failed: ${response.status}`);
  }
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

async function processFanoutMessage(
  body: AuditQueueMessage,
  env: AuditQueueConsumerEnv,
  logger: Logger
): Promise<void> {
  const fanout = body.fanout as AuditQueueFanoutPlan;
  const archives = fanout.archives.length > 0 ? fanout.archives : fanout.archive ? [fanout.archive] : [];

  for (const archive of archives) {
    try {
      await writeArchiveTarget(archive, body, env);
    } catch (error) {
      if (fanout.archiveFailureMode === 'gate_cleanup') {
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
    try {
      await deliverSinkTarget(sink, body, env);
    } catch (error) {
      if (fanout.sinkFailureMode === 'retry_until_ttl') {
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
  db: DatabaseSource,
  tenantId?: string,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();
  const adapter = ensureDatabaseAdapter(db, 'audit-cleanup-event');

  const sql = tenantId
    ? 'DELETE FROM event_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?'
    : 'DELETE FROM event_log WHERE retention_until < ? LIMIT ?';

  const params = tenantId ? [now, tenantId, batchSize] : [now, batchSize];
  const result = await adapter.execute(sql, params);
  return result.rowsAffected;
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
  db: DatabaseSource,
  tenantId?: string,
  batchSize: number = 1000
): Promise<number> {
  const now = Date.now();
  const adapter = ensureDatabaseAdapter(db, 'audit-cleanup-pii');

  const sql = tenantId
    ? 'DELETE FROM pii_log WHERE retention_until < ? AND tenant_id = ? LIMIT ?'
    : 'DELETE FROM pii_log WHERE retention_until < ? LIMIT ?';

  const params = tenantId ? [now, tenantId, batchSize] : [now, batchSize];
  const result = await adapter.execute(sql, params);
  return result.rowsAffected;
}
