/**
 * Audit Service Implementation
 *
 * Provides unified audit logging with:
 * - Event logging via Queue (with D1 fallback)
 * - PII change logging with AES-256-GCM encryption
 * - 2-stage purge workflow for GDPR compliance
 * - Automatic detail evacuation to R2
 */

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
  EventCategory,
} from './types';
import { DEFAULT_PII_CONFIG } from './types';
import type { AuditProfile, AuditTarget } from '../../types/runtime-profile';
import type { IAuditStorageAdapter } from './storage';
import { BUILTIN_RUNTIME_PROFILES, DEFAULT_AUDIT_PROFILE_ID } from '../../types/runtime-profile';
import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../../db';
import {
  sanitizeEventDetails,
  sanitizeErrorMessage,
  writeEventDetails,
  writePIIValues,
  generateAAD,
  calculateRetentionUntil,
  arrayBufferToBase64,
} from './utils';
import type { TenantKeyResolver } from './tenant-key';
import { AnonymizationService } from './anonymization';
import { createLogger, type Logger } from '../../utils/logger';

export interface AuditDeliveryPlan {
  auditProfileId: string;
  primary: AuditTarget | null;
  archives: AuditTarget[];
  sinks: AuditTarget[];
  retentionDays?: number | null;
  archiveFailureMode?: AuditProfile['archiveFailureMode'];
  sinkFailureMode?: AuditProfile['sinkFailureMode'];
  matchedRuleNames?: string[];
}

/**
 * Dependencies for audit service.
 */
export interface AuditServiceDependencies {
  /** Core database source (non-PII) */
  coreSource: DatabaseSource;

  /** PII database source */
  piiSource: DatabaseSource;

  /** R2 bucket for large details */
  r2Bucket: R2Bucket;

  /** R2 bucket for chunked sensitive detail payloads */
  sensitiveDetailBucket?: R2Bucket;

  /** Root key for object-plane sensitive detail encryption */
  objectEncryptionRootKey?: string;

  /** Object-plane encryption key version */
  objectEncryptionKeyVersion?: number;

  /** Hex-encoded AES-256 key for PII audit value encryption */
  piiEncryptionKey?: string;

  /** PII audit encryption key version */
  piiEncryptionKeyVersion?: number;

  /** Audit queue for async processing (optional) */
  auditQueue?: Queue<AuditQueueMessage>;

  /** KV for PII config cache (optional) */
  configKv?: KVNamespace;

  /** Logger instance (optional) */
  logger?: Logger;

  /** Runtime resolver for tenant audit profiles (optional) */
  resolveAuditProfile?: (tenantId: string) => Promise<AuditProfile>;

  /** Runtime resolver for per-event delivery plans (optional) */
  resolveDeliveryPlan?: (input: {
    tenantId: string;
    logType: 'event' | 'pii';
    eventCategory?: EventCategory;
    clientId?: string;
    auditProfile: AuditProfile;
  }) => Promise<AuditDeliveryPlan | null>;

  /** Runtime resolver for synchronous primary adapters (optional) */
  resolvePrimaryAdapter?: (
    target: AuditTarget,
    logType: 'event' | 'pii'
  ) => Promise<IAuditStorageAdapter | null>;

  /** Optional tenant registry backed tenant_key resolver for direct R2 detail evacuation */
  tenantKeyResolver?: TenantKeyResolver;
}

/**
 * Audit service implementation.
 */
export class AuditService implements IAuditService {
  private readonly coreAdapter: DatabaseAdapter;
  private readonly piiAdapter: DatabaseAdapter;
  private readonly r2Bucket: R2Bucket;
  private readonly sensitiveDetailBucket?: R2Bucket;
  private readonly objectEncryptionRootKey?: string;
  private readonly objectEncryptionKeyVersion?: number;
  private readonly piiEncryptionKey?: string;
  private readonly piiEncryptionKeyVersion: number;
  private readonly auditQueue?: Queue<AuditQueueMessage>;
  private readonly configKv?: KVNamespace;
  private readonly logger: Logger;
  private readonly anonymizationService: AnonymizationService;
  private readonly resolveAuditProfile?: (tenantId: string) => Promise<AuditProfile>;
  private readonly resolveDeliveryPlan?: AuditServiceDependencies['resolveDeliveryPlan'];
  private readonly resolvePrimaryAdapter?: AuditServiceDependencies['resolvePrimaryAdapter'];
  private readonly tenantKeyResolver?: TenantKeyResolver;

  // In-memory config cache (3 minute TTL)
  private configCache: Map<string, { config: TenantPIIConfig; expiresAt: number }> = new Map();
  private readonly CONFIG_CACHE_TTL_MS = 180_000; // 3 minutes
  private readonly auditProfileCache: Map<string, { profile: AuditProfile; expiresAt: number }> =
    new Map();
  private readonly AUDIT_PROFILE_CACHE_TTL_MS = 60_000; // 1 minute

  constructor(deps: AuditServiceDependencies) {
    this.coreAdapter = ensureDatabaseAdapter(deps.coreSource, 'audit-core');
    this.piiAdapter = ensureDatabaseAdapter(deps.piiSource, 'audit-pii');
    this.r2Bucket = deps.r2Bucket;
    this.sensitiveDetailBucket = deps.sensitiveDetailBucket;
    this.objectEncryptionRootKey = deps.objectEncryptionRootKey;
    this.objectEncryptionKeyVersion = deps.objectEncryptionKeyVersion;
    this.piiEncryptionKey = deps.piiEncryptionKey;
    this.piiEncryptionKeyVersion =
      Number.isInteger(deps.piiEncryptionKeyVersion) && (deps.piiEncryptionKeyVersion ?? 0) > 0
        ? deps.piiEncryptionKeyVersion!
        : 1;
    this.auditQueue = deps.auditQueue;
    this.configKv = deps.configKv;
    this.logger = deps.logger ?? createLogger().module('AuditService');
    this.anonymizationService = new AnonymizationService(deps.piiSource);
    this.resolveAuditProfile = deps.resolveAuditProfile;
    this.resolveDeliveryPlan = deps.resolveDeliveryPlan;
    this.resolvePrimaryAdapter = deps.resolvePrimaryAdapter;
    this.tenantKeyResolver = deps.tenantKeyResolver;
  }

  private getDefaultAuditProfile(): AuditProfile {
    return BUILTIN_RUNTIME_PROFILES.find(
      (profile): profile is AuditProfile =>
        profile.kind === 'audit' && profile.id === DEFAULT_AUDIT_PROFILE_ID
    )!;
  }

  private async getTenantAuditProfile(tenantId: string): Promise<AuditProfile> {
    const cached = this.auditProfileCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.profile;
    }

    let profile = this.getDefaultAuditProfile();

    if (this.resolveAuditProfile) {
      try {
        profile = await this.resolveAuditProfile(tenantId);
      } catch (error) {
        this.logger.warn('audit_profile_resolve_failed', {
          tenantId,
          error: sanitizeErrorMessage(String(error)),
        });
      }
    }

    this.auditProfileCache.set(tenantId, {
      profile,
      expiresAt: Date.now() + this.AUDIT_PROFILE_CACHE_TTL_MS,
    });
    return profile;
  }

  private resolveRetentionDays(
    profile: AuditProfile,
    defaults: TenantPIIConfig,
    logType: 'event' | 'pii',
    overrideDays?: number | null
  ): number {
    if (overrideDays != null) {
      return overrideDays;
    }
    if (logType === 'event' && profile.retention?.eventLogRetentionDays != null) {
      return profile.retention.eventLogRetentionDays;
    }
    if (logType === 'pii' && profile.retention?.piiLogRetentionDays != null) {
      return profile.retention.piiLogRetentionDays;
    }
    if (profile.primary && profile.retention?.primaryDays != null) {
      return profile.retention.primaryDays;
    }
    if (!profile.primary && profile.retention?.archiveDays != null) {
      return profile.retention.archiveDays;
    }
    return logType === 'event' ? defaults.eventLogRetentionDays : defaults.piiLogRetentionDays;
  }

  private isD1PrimaryTarget(
    target: AuditTarget | null | undefined
  ): target is Extract<AuditTarget, { type: 'd1' }> {
    return Boolean(target && target.type === 'd1');
  }

  private async writePrimaryEventLog(
    tenantId: string,
    plan: AuditDeliveryPlan,
    entry: EventLogEntry
  ): Promise<void> {
    if (!plan.primary) {
      return;
    }

    if (this.isD1PrimaryTarget(plan.primary)) {
      await this.directInsertEventLog(entry);
      return;
    }

    const adapter = this.resolvePrimaryAdapter
      ? await this.resolvePrimaryAdapter(plan.primary, 'event')
      : null;
    if (!adapter) {
      this.logger.warn('unsupported_audit_primary_target', {
        tenantId,
        targetType: plan.primary.type,
        auditProfileId: plan.auditProfileId,
      });
      return;
    }

    const result = await adapter.writeEventLog(entry);
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'audit_primary_event_write_failed');
    }
  }

  private async writePrimaryPIILog(
    tenantId: string,
    plan: AuditDeliveryPlan,
    entry: PIILogEntry
  ): Promise<void> {
    if (!plan.primary) {
      return;
    }

    if (this.isD1PrimaryTarget(plan.primary)) {
      await this.directInsertPIILog(entry);
      return;
    }

    const adapter = this.resolvePrimaryAdapter
      ? await this.resolvePrimaryAdapter(plan.primary, 'pii')
      : null;
    if (!adapter) {
      this.logger.warn('unsupported_audit_primary_target', {
        tenantId,
        targetType: plan.primary.type,
        auditProfileId: plan.auditProfileId,
      });
      return;
    }

    const result = await adapter.writePIILog(entry);
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'audit_primary_pii_write_failed');
    }
  }

  private buildBaseDeliveryPlan(profile: AuditProfile): AuditDeliveryPlan {
    return {
      auditProfileId: profile.id,
      primary: profile.primary ?? null,
      archives: profile.archive ? [profile.archive] : [],
      sinks: profile.sinks,
      archiveFailureMode: profile.archiveFailureMode,
      sinkFailureMode: profile.sinkFailureMode,
    };
  }

  private async getAuditDeliveryPlan(input: {
    tenantId: string;
    logType: 'event' | 'pii';
    eventCategory?: EventCategory;
    clientId?: string;
    auditProfile: AuditProfile;
  }): Promise<AuditDeliveryPlan> {
    if (this.resolveDeliveryPlan) {
      try {
        const resolved = await this.resolveDeliveryPlan(input);
        if (resolved) {
          return resolved;
        }
      } catch (error) {
        this.logger.warn('audit_delivery_plan_resolve_failed', {
          tenantId: input.tenantId,
          logType: input.logType,
          error: sanitizeErrorMessage(String(error)),
        });
      }
    }

    return this.buildBaseDeliveryPlan(input.auditProfile);
  }

  private buildFanoutPlan(plan: AuditDeliveryPlan): AuditQueueMessage['fanout'] | undefined {
    if (plan.archives.length === 0 && plan.sinks.length === 0) {
      return undefined;
    }

    return {
      auditProfileId: plan.auditProfileId,
      archives: plan.archives,
      sinks: plan.sinks,
      archiveFailureMode: plan.archiveFailureMode,
      sinkFailureMode: plan.sinkFailureMode,
      matchedRuleNames: plan.matchedRuleNames,
    };
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
    const auditProfile = await this.getTenantAuditProfile(tenantId);
    const deliveryPlan = await this.getAuditDeliveryPlan({
      tenantId,
      logType: 'event',
      eventCategory: params.eventCategory,
      clientId: params.clientId,
      auditProfile,
    });
    const entryId = crypto.randomUUID();
    const createdAt = Date.now();
    const retentionUntil = calculateRetentionUntil(
      this.resolveRetentionDays(auditProfile, config, 'event', deliveryPlan.retentionDays)
    );

    // Sanitize details if provided
    let detailsJson: string | null = null;
    let detailsR2Key: string | null = null;

    if (params.details) {
      const sanitizedDetails = sanitizeEventDetails(
        params.details as Record<string, unknown>,
        config
      );
      const result = await writeEventDetails(
        sanitizedDetails,
        this.r2Bucket,
        tenantId,
        entryId,
        undefined,
        this.tenantKeyResolver,
        this.sensitiveDetailBucket && this.objectEncryptionRootKey
          ? {
              adapter: this.coreAdapter,
              bucket: this.sensitiveDetailBucket,
              rootKeyHex: this.objectEncryptionRootKey,
              keyVersion: this.objectEncryptionKeyVersion,
              createdAt,
              tenantKeyResolver: this.tenantKeyResolver,
            }
          : undefined
      );
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

    await this.writePrimaryEventLog(tenantId, deliveryPlan, entry);

    const fanout = this.buildFanoutPlan(deliveryPlan);

    if (fanout && this.auditQueue) {
      try {
        await this.auditQueue.send({
          type: 'event_log',
          entries: [entry],
          tenantId,
          timestamp: createdAt,
          fanout,
        });
      } catch (queueError) {
        this.logger.warn('audit_queue_failed', {
          error: sanitizeErrorMessage(String(queueError)),
          tenantId,
        });
      }
    } else if (fanout && !this.auditQueue) {
      this.logger.warn('audit_fanout_skipped_without_queue', {
        tenantId,
        auditProfileId: deliveryPlan.auditProfileId,
      });
    }
  }

  /**
   * Direct insert to event_log table.
   */
  private async directInsertEventLog(entry: EventLogEntry): Promise<void> {
    await this.coreAdapter.execute(
      `INSERT INTO event_log (
        id, tenant_id, event_type, event_category, result, severity,
        error_code, error_message, anonymized_user_id, client_id,
        session_id, request_id, duration_ms, details_r2_key, details_json,
        retention_until, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        entry.createdAt,
      ]
    );
  }

  /**
   * Log a PII change.
   */
  async logPIIChange(tenantId: string, params: PIILogParams): Promise<void> {
    const config = await this.getTenantPIIConfig(tenantId);
    const auditProfile = await this.getTenantAuditProfile(tenantId);
    const deliveryPlan = await this.getAuditDeliveryPlan({
      tenantId,
      logType: 'pii',
      auditProfile,
    });
    const entryId = crypto.randomUUID();
    const createdAt = Date.now();
    const retentionUntil = calculateRetentionUntil(
      this.resolveRetentionDays(auditProfile, config, 'pii', deliveryPlan.retentionDays)
    );

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
      entryId,
      undefined,
      this.tenantKeyResolver,
      this.sensitiveDetailBucket && this.objectEncryptionRootKey
        ? {
            adapter: this.coreAdapter,
            bucket: this.sensitiveDetailBucket,
            rootKeyHex: this.objectEncryptionRootKey,
            keyVersion: this.objectEncryptionKeyVersion,
            createdAt,
            tenantKeyResolver: this.tenantKeyResolver,
          }
        : undefined
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

    await this.writePrimaryPIILog(tenantId, deliveryPlan, entry);

    const fanout = this.buildFanoutPlan(deliveryPlan);

    if (fanout && this.auditQueue) {
      try {
        await this.auditQueue.send({
          type: 'pii_log',
          entries: [entry],
          tenantId,
          timestamp: createdAt,
          fanout,
        });
      } catch (queueError) {
        this.logger.warn('audit_queue_failed_pii', {
          error: sanitizeErrorMessage(String(queueError)),
          tenantId,
        });
      }
    } else if (fanout && !this.auditQueue) {
      this.logger.warn('audit_fanout_skipped_without_queue', {
        tenantId,
        auditProfileId: deliveryPlan.auditProfileId,
      });
    }
  }

  /**
   * Direct insert to pii_log table.
   */
  private async directInsertPIILog(entry: PIILogEntry): Promise<void> {
    await this.piiAdapter.execute(
      `INSERT INTO pii_log (
        id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
        values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
        actor_user_id, actor_type, request_id, legal_basis, consent_reference,
        retention_until, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        entry.createdAt,
      ]
    );
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
      const piiDeleteResult = await this.piiAdapter.execute(
        'DELETE FROM pii_log WHERE tenant_id = ? AND user_id = ?',
        [tenantId, userId]
      );

      const piiLogsDeleted = piiDeleteResult.rowsAffected;

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
   */
  private async encryptPIIValues(
    values: Record<string, unknown>,
    tenantId: string,
    affectedFields: string[]
  ): Promise<EncryptedValue> {
    const keyId = `pii-key-v${this.piiEncryptionKeyVersion}`;

    // Generate random IV (12 bytes for GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Generate AAD from tenant and fields
    const aad = generateAAD(tenantId, affectedFields);

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

  private async getEncryptionKey(): Promise<CryptoKey> {
    const keyHex = this.piiEncryptionKey?.trim();
    if (!keyHex) {
      throw new Error('PII_ENCRYPTION_KEY is required for audit PII encryption');
    }
    if (keyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(keyHex)) {
      throw new Error('PII_ENCRYPTION_KEY must be exactly 64 hex characters');
    }

    const keyBytes = new Uint8Array(
      keyHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))
    );
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }
}

/**
 * Create audit service instance.
 */
export function createAuditService(deps: AuditServiceDependencies): IAuditService {
  return new AuditService(deps);
}
