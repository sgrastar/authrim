/**
 * Audit Service Implementation
 *
 * Provides unified audit logging with:
 * - Event logging via Queue (with D1 fallback)
 * - PII change logging with AES-256-GCM encryption
 * - 2-stage purge workflow for GDPR compliance
 * - Automatic detail evacuation to R2
 */

import type { D1Database } from '@cloudflare/workers-types';
import type {
  IAuditService,
  EventLogParams,
  PIILogParams,
  CombinedLogParams,
  PurgeContext,
  PurgeResult,
  EventLogEntry,
  PIILogEntry,
  TenantPIIConfig,
  EncryptedValue,
  AuditQueueMessage,
} from './types';
import { DEFAULT_PII_CONFIG } from './types';
import {
  sanitizeEventDetails,
  sanitizeErrorMessage,
  writeEventDetails,
  writePIIValues,
  generateAAD,
  calculateRetentionUntil,
  arrayBufferToBase64,
} from './utils';
import { AnonymizationService } from './anonymization';
import { createLogger, type Logger } from '../../utils/logger';

/**
 * Dependencies for audit service.
 */
export interface AuditServiceDependencies {
  /** Core database (non-PII) */
  coreDb: D1Database;

  /** PII database */
  piiDb: D1Database;

  /** R2 bucket for large details */
  r2Bucket: R2Bucket;

  /** Audit queue for async processing (optional) */
  auditQueue?: Queue<AuditQueueMessage>;

  /** KV for PII config cache (optional) */
  configKv?: KVNamespace;

  /** Logger instance (optional) */
  logger?: Logger;
}

/**
 * Audit service implementation.
 */
export class AuditService implements IAuditService {
  private readonly coreDb: D1Database;
  private readonly piiDb: D1Database;
  private readonly r2Bucket: R2Bucket;
  private readonly auditQueue?: Queue<AuditQueueMessage>;
  private readonly configKv?: KVNamespace;
  private readonly logger: Logger;
  private readonly anonymizationService: AnonymizationService;

  // In-memory config cache (3 minute TTL)
  private configCache: Map<string, { config: TenantPIIConfig; expiresAt: number }> = new Map();
  private readonly CONFIG_CACHE_TTL_MS = 180_000; // 3 minutes

  constructor(deps: AuditServiceDependencies) {
    this.coreDb = deps.coreDb;
    this.piiDb = deps.piiDb;
    this.r2Bucket = deps.r2Bucket;
    this.auditQueue = deps.auditQueue;
    this.configKv = deps.configKv;
    this.logger = deps.logger ?? createLogger().module('AuditService');
    this.anonymizationService = new AnonymizationService(this.piiDb);
  }

  /**
   * Get tenant PII configuration (cached).
   */
  private async getTenantPIIConfig(tenantId: string): Promise<TenantPIIConfig> {
    // Check in-memory cache
    const cached = this.configCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.config;
    }

    // Try KV cache
    if (this.configKv) {
      try {
        const kvValue = await this.configKv.get(`pii_config:${tenantId}`);
        if (kvValue) {
          const config = JSON.parse(kvValue) as TenantPIIConfig;
          this.configCache.set(tenantId, {
            config,
            expiresAt: Date.now() + this.CONFIG_CACHE_TTL_MS,
          });
          return config;
        }
      } catch {
        // Ignore KV errors, use default
      }
    }

    // Return default config
    return DEFAULT_PII_CONFIG;
  }

  /**
   * Log an event (non-PII).
   */
  async logEvent(tenantId: string, params: EventLogParams): Promise<void> {
    const config = await this.getTenantPIIConfig(tenantId);
    const entryId = crypto.randomUUID();
    const createdAt = Date.now();
    const retentionUntil = calculateRetentionUntil(config.eventLogRetentionDays);

    // Sanitize details if provided
    let detailsJson: string | null = null;
    let detailsR2Key: string | null = null;

    if (params.details) {
      const sanitizedDetails = sanitizeEventDetails(
        params.details as Record<string, unknown>,
        config
      );
      const result = await writeEventDetails(sanitizedDetails, this.r2Bucket, tenantId, entryId);
      detailsJson = result.detailsJson;
      detailsR2Key = result.detailsR2Key;
    }

    // Sanitize error message if present
    const errorMessage = params.errorMessage
      ? sanitizeErrorMessage(params.errorMessage)
      : undefined;

    const entry: EventLogEntry = {
      id: entryId,
      tenantId,
      eventType: params.eventType,
      eventCategory: params.eventCategory,
      result: params.result,
      severity: params.severity ?? 'info',
      errorCode: params.errorCode,
      errorMessage,
      anonymizedUserId: params.anonymizedUserId,
      clientId: params.clientId,
      sessionId: params.sessionId,
      requestId: params.requestId,
      durationMs: params.durationMs,
      detailsR2Key: detailsR2Key ?? undefined,
      detailsJson: detailsJson ?? undefined,
      retentionUntil,
      createdAt,
    };

    // Try to send via Queue first
    if (this.auditQueue) {
      try {
        await this.auditQueue.send({
          type: 'event_log',
          entries: [entry],
          tenantId,
          timestamp: createdAt,
        });
        return;
      } catch (queueError) {
        // Queue failed, fall back to direct write
        this.logger.warn('audit_queue_failed', {
          error: sanitizeErrorMessage(String(queueError)),
          tenantId,
        });
      }
    }

    // Direct D1 write (sync or fallback)
    await this.directInsertEventLog(entry);
  }

  /**
   * Direct insert to event_log table.
   */
  private async directInsertEventLog(entry: EventLogEntry): Promise<void> {
    await this.coreDb
      .prepare(
        `INSERT INTO event_log (
          id, tenant_id, event_type, event_category, result, severity,
          error_code, error_message, anonymized_user_id, client_id,
          session_id, request_id, duration_ms, details_r2_key, details_json,
          retention_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.id,
        entry.tenantId,
        entry.eventType,
        entry.eventCategory,
        entry.result,
        entry.severity,
        entry.errorCode ?? null,
        entry.errorMessage ?? null,
        entry.anonymizedUserId ?? null,
        entry.clientId ?? null,
        entry.sessionId ?? null,
        entry.requestId ?? null,
        entry.durationMs ?? null,
        entry.detailsR2Key ?? null,
        entry.detailsJson ?? null,
        entry.retentionUntil ?? null,
        entry.createdAt
      )
      .run();
  }

  /**
   * Log a PII change.
   */
  async logPIIChange(tenantId: string, params: PIILogParams): Promise<void> {
    const config = await this.getTenantPIIConfig(tenantId);
    const entryId = crypto.randomUUID();
    const createdAt = Date.now();
    const retentionUntil = calculateRetentionUntil(config.piiLogRetentionDays);

    // Get or create anonymized user ID
    const anonymizedUserId =
      params.anonymizedUserId ??
      (await this.anonymizationService.getAnonymizedUserId(tenantId, params.userId));

    // Prepare values to encrypt
    const valuesToEncrypt: Record<string, unknown> = {};
    if (params.oldValues) {
      valuesToEncrypt.old = params.oldValues;
    }
    if (params.newValues) {
      valuesToEncrypt.new = params.newValues;
    }

    // Encrypt values
    const encrypted = await this.encryptPIIValues(valuesToEncrypt, tenantId, params.affectedFields);

    // Write encrypted values (inline or R2)
    const { valuesEncrypted, valuesR2Key } = await writePIIValues(
      JSON.stringify(encrypted),
      this.r2Bucket,
      tenantId,
      entryId
    );

    const entry: PIILogEntry = {
      id: entryId,
      tenantId,
      userId: params.userId,
      anonymizedUserId,
      changeType: params.changeType,
      affectedFields: JSON.stringify(params.affectedFields),
      valuesR2Key: valuesR2Key ?? undefined,
      valuesEncrypted: valuesEncrypted ?? undefined,
      encryptionKeyId: encrypted.keyId,
      encryptionIv: encrypted.iv,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      requestId: params.requestId,
      legalBasis: params.legalBasis,
      consentReference: params.consentReference,
      retentionUntil,
      createdAt,
    };

    // Try to send via Queue first
    if (this.auditQueue) {
      try {
        await this.auditQueue.send({
          type: 'pii_log',
          entries: [entry],
          tenantId,
          timestamp: createdAt,
        });
        return;
      } catch (queueError) {
        this.logger.warn('audit_queue_failed_pii', {
          error: sanitizeErrorMessage(String(queueError)),
          tenantId,
        });
      }
    }

    // Direct D1 write
    await this.directInsertPIILog(entry);
  }

  /**
   * Direct insert to pii_log table.
   */
  private async directInsertPIILog(entry: PIILogEntry): Promise<void> {
    await this.piiDb
      .prepare(
        `INSERT INTO pii_log (
          id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
          values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
          actor_user_id, actor_type, request_id, legal_basis, consent_reference,
          retention_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.id,
        entry.tenantId,
        entry.userId,
        entry.anonymizedUserId,
        entry.changeType,
        entry.affectedFields,
        entry.valuesR2Key ?? null,
        entry.valuesEncrypted ?? null,
        entry.encryptionKeyId,
        entry.encryptionIv,
        entry.actorUserId ?? null,
        entry.actorType,
        entry.requestId ?? null,
        entry.legalBasis ?? null,
        entry.consentReference ?? null,
        entry.retentionUntil,
        entry.createdAt
      )
      .run();
  }

  /**
   * Log an event with associated PII change.
   */
  async logEventWithPII(tenantId: string, params: CombinedLogParams): Promise<void> {
    // Get anonymized user ID first (shared between both logs)
    const anonymizedUserId = await this.anonymizationService.getAnonymizedUserId(
      tenantId,
      params.pii.userId
    );

    // Log both in parallel
    await Promise.all([
      this.logEvent(tenantId, { ...params, anonymizedUserId }),
      this.logPIIChange(tenantId, {
        ...params.pii,
        anonymizedUserId,
        requestId: params.requestId,
      }),
    ]);
  }

  /**
   * Get or create anonymized user ID.
   */
  async getAnonymizedUserId(tenantId: string, userId: string): Promise<string> {
    return this.anonymizationService.getAnonymizedUserId(tenantId, userId);
  }

  /**
   * Purge all PII for a user (GDPR "right to be forgotten").
   * Uses 2-stage logging (started/completed/failed).
   */
  async purgeUserPII(
    tenantId: string,
    userId: string,
    context: PurgeContext
  ): Promise<PurgeResult> {
    const purgeJobId = crypto.randomUUID();

    // Get anonymized user ID before deletion
    let anonymizedUserId: string;
    try {
      anonymizedUserId = await this.anonymizationService.getAnonymizedUserId(tenantId, userId);
    } catch {
      // User might not have any events, create a temporary ID for logging
      anonymizedUserId = crypto.randomUUID();
    }

    // Step 1: Log purge started
    await this.logEvent(tenantId, {
      eventType: 'user.pii_purge_started',
      eventCategory: 'security',
      result: 'success',
      severity: 'critical',
      anonymizedUserId,
      requestId: context.requestId,
      details: {
        purgeJobId,
        deletionReason: context.deletionReason,
        legalBasis: context.legalBasis,
        actorType: context.actorType,
        // Note: Do NOT log user_id here (it's PII)
      },
    });

    try {
      // Step 2: Delete PII logs
      const piiDeleteResult = await this.piiDb
        .prepare('DELETE FROM pii_log WHERE tenant_id = ? AND user_id = ?')
        .bind(tenantId, userId)
        .run();

      const piiLogsDeleted = piiDeleteResult.meta?.changes ?? 0;

      // Step 3: Delete anonymization mapping
      await this.anonymizationService.deleteMapping(tenantId, userId);

      // Step 4: Log purge completed
      await this.logEvent(tenantId, {
        eventType: 'user.pii_purge_completed',
        eventCategory: 'security',
        result: 'success',
        severity: 'critical',
        // Don't use anonymizedUserId - mapping was just deleted
        requestId: context.requestId,
        details: {
          purgeJobId,
          piiLogsDeleted,
          deletionReason: context.deletionReason,
        },
      });

      return {
        success: true,
        piiLogsDeleted,
        purgeJobId,
      };
    } catch (error) {
      // Step 4 (failure): Log purge failed
      const errorMessage = sanitizeErrorMessage(String(error));

      await this.logEvent(tenantId, {
        eventType: 'user.pii_purge_failed',
        eventCategory: 'security',
        result: 'failure',
        severity: 'critical',
        errorCode: 'purge_failed',
        errorMessage,
        anonymizedUserId,
        requestId: context.requestId,
        details: {
          purgeJobId,
        },
      });

      return {
        success: false,
        piiLogsDeleted: 0,
        purgeJobId,
        errorMessage,
      };
    }
  }

  /**
   * Encrypt PII values using AES-256-GCM.
   * Key management is simplified here - in production, use KeyManager DO.
   */
  private async encryptPIIValues(
    values: Record<string, unknown>,
    tenantId: string,
    affectedFields: string[]
  ): Promise<EncryptedValue> {
    // For now, use a static key ID - in production, integrate with KeyManager
    const keyId = 'default-pii-key-v1';

    // Generate random IV (12 bytes for GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Generate AAD from tenant and fields
    const aad = generateAAD(tenantId, affectedFields);

    // Import key (in production, get from KeyManager or KV)
    // This is a placeholder - you should inject the key from environment or KeyManager
    const keyMaterial = await this.getEncryptionKey();

    // Encrypt
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(values));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aad,
      },
      keyMaterial,
      plaintextBytes
    );

    return {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv.buffer),
      keyId,
    };
  }

  /**
   * Get encryption key for PII.
   * Placeholder - in production, get from KeyManager or environment.
   */
  private async getEncryptionKey(): Promise<CryptoKey> {
    // Generate a deterministic key from a seed (placeholder)
    // In production, inject PII_ENCRYPTION_KEY from environment
    const seed = new TextEncoder().encode('placeholder-pii-encryption-key-32b');
    return crypto.subtle.importKey('raw', seed, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
}

/**
 * Create audit service instance.
 */
export function createAuditService(deps: AuditServiceDependencies): IAuditService {
  return new AuditService(deps);
}
