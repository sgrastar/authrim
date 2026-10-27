import { createLogIcebergWritePort } from '../log-iceberg-runtime';
import { resolveLogIcebergConfig } from '../log-iceberg-config';
/**
 * Audit Service Implementation
 *
 * Provides unified audit logging with:
 * - Canonical event storage using the configured Iceberg mode
 * - Nested encrypted PII change values
 * - 2-stage purge workflow for GDPR compliance
 * - Independent HTTP external delivery
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
  AuditQueueMessage,
  EventCategory,
  EncryptedValue,
} from './types';
import { DEFAULT_PII_CONFIG } from './types';
import type { AuditProfile, AuditTarget } from '../../types/runtime-profile';
import { BUILTIN_RUNTIME_PROFILES, DEFAULT_AUDIT_PROFILE_ID } from '../../types/runtime-profile';
import type { DatabaseSource } from '../../db';
import {
  sanitizeEventDetails,
  sanitizeErrorMessage,
  calculateRetentionUntil,
  generateAAD,
  arrayBufferToBase64,
} from './utils';
import type { Env } from '../../types/env';
import { logIcebergCanonicalJson } from '../log-iceberg-record';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import { resolveAccountPiiSourceForAudit } from '../runtime-data-context';
import { eraseLogIcebergSubject } from '../log-iceberg-subject-erasure';
import { runTenantBackupCoveredEffect } from '../tenant-portability/covered-mutation';
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
  /** Explicit archive bindings; a missing mode never falls back to old log tables. */
  env: Env;
  /** Explicit PII mapping source when an account-scoped caller already resolved it. */
  piiSource?: DatabaseSource;
  configKv?: KVNamespace;
  logger?: Logger;
  resolveAuditProfile?: (tenantId: string) => Promise<AuditProfile>;
  resolveDeliveryPlan?: (input: {
    tenantId: string;
    logType: 'event' | 'pii';
    eventCategory?: EventCategory;
    clientId?: string;
    auditProfile: AuditProfile;
  }) => Promise<AuditDeliveryPlan | null>;
}

/**
 * Audit service implementation.
 */
/**
 * Where an audit log's retention comes from, in the order a write looks: the delivery plan
 * (a logging destination or routing rule), the audit profile, then the tenant's PII config
 * (which is the built-in default when the tenant has none).
 */
export type AuditRetentionSource = 'delivery_plan' | 'audit_profile' | 'pii_config';

/** The retention a log written now gets (`retention_until` = written + days). */
export function resolveAuditRetention(
  profile: AuditProfile,
  defaults: TenantPIIConfig,
  logType: 'event' | 'pii',
  overrideDays?: number | null
): { days: number; source: AuditRetentionSource } {
  if (overrideDays != null) {
    return { days: overrideDays, source: 'delivery_plan' };
  }
  if (logType === 'event' && profile.retention?.eventLogRetentionDays != null) {
    return { days: profile.retention.eventLogRetentionDays, source: 'audit_profile' };
  }
  if (logType === 'pii' && profile.retention?.piiLogRetentionDays != null) {
    return { days: profile.retention.piiLogRetentionDays, source: 'audit_profile' };
  }
  if (profile.primary && profile.retention?.primaryDays != null) {
    return { days: profile.retention.primaryDays, source: 'audit_profile' };
  }
  if (!profile.primary && profile.retention?.archiveDays != null) {
    return { days: profile.retention.archiveDays, source: 'audit_profile' };
  }
  return {
    days: logType === 'event' ? defaults.eventLogRetentionDays : defaults.piiLogRetentionDays,
    source: 'pii_config',
  };
}

export class AuditService implements IAuditService {
  private readonly env: Env;
  private readonly piiSource?: DatabaseSource;
  private readonly auditQueue?: Queue<AuditQueueMessage>;
  private readonly configKv?: KVNamespace;
  private readonly logger: Logger;
  private readonly resolveAuditProfile?: AuditServiceDependencies['resolveAuditProfile'];
  private readonly resolveDeliveryPlan?: AuditServiceDependencies['resolveDeliveryPlan'];

  // In-memory config cache (3 minute TTL)
  private configCache: Map<string, { config: TenantPIIConfig; expiresAt: number }> = new Map();
  private readonly CONFIG_CACHE_TTL_MS = 180_000; // 3 minutes
  private readonly auditProfileCache: Map<string, { profile: AuditProfile; expiresAt: number }> =
    new Map();
  private readonly AUDIT_PROFILE_CACHE_TTL_MS = 60_000; // 1 minute

  constructor(deps: AuditServiceDependencies) {
    this.env = deps.env;
    this.piiSource = deps.piiSource;
    this.auditQueue = deps.env.AUDIT_QUEUE;
    this.configKv = deps.configKv ?? deps.env.AUTHRIM_CONFIG;
    this.logger = deps.logger ?? createLogger().module('AuditService');
    this.resolveAuditProfile = deps.resolveAuditProfile;
    this.resolveDeliveryPlan = deps.resolveDeliveryPlan;
  }

  private async anonymizationFor(tenantId: string, userId: string): Promise<AnonymizationService> {
    const source =
      this.piiSource ??
      (await resolveAccountPiiSourceForAudit(this.env, { tenantId, accountId: userId }));
    return new AnonymizationService(source);
  }

  private getDefaultAuditProfile(): AuditProfile {
    const profile = BUILTIN_RUNTIME_PROFILES.find(
      (profile): profile is AuditProfile =>
        profile.kind === 'audit' && profile.id === DEFAULT_AUDIT_PROFILE_ID
    );
    if (!profile) throw new Error('builtin_audit_profile_missing');
    return profile;
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
    return resolveAuditRetention(profile, defaults, logType, overrideDays).days;
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
    const sinks = plan.sinks.filter((target) => target.type === 'http');
    if (sinks.length === 0) return undefined;
    return {
      auditProfileId: plan.auditProfileId,
      archives: [],
      sinks,
      sinkFailureMode: plan.sinkFailureMode,
      matchedRuleNames: plan.matchedRuleNames,
    };
  }

  private async deliverExternalSinks(
    plan: AuditDeliveryPlan,
    body: Omit<AuditQueueMessage, 'fanout'>,
    requireDurable = false
  ): Promise<void> {
    const fanout = this.buildFanoutPlan(plan);
    if (!fanout) return;
    try {
      if (!this.auditQueue) throw new Error('audit_external_sink_queue_unavailable');
      await this.auditQueue.send({ ...body, fanout });
    } catch (error) {
      this.logger.warn('audit_external_sink_queue_failed', {
        tenantId: body.tenantId,
        error: sanitizeErrorMessage(String(error)),
      });
      if (requireDurable && plan.sinkFailureMode === 'retry_until_ttl')
        throw new Error('audit_fanout_queue_failed');
    }
  }

  private async encryptValuesForExternal(
    values: Record<string, unknown>,
    tenantId: string,
    fields: string[]
  ): Promise<EncryptedValue> {
    const keyHex = this.env.PII_ENCRYPTION_KEY;
    if (!keyHex || !/^[a-f0-9]{64}$/iu.test(keyHex))
      throw new Error('audit_external_pii_key_unavailable');
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from({ length: 32 }, (_, index) =>
        Number.parseInt(keyHex.slice(index * 2, index * 2 + 2), 16)
      ),
      'AES-GCM',
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: generateAAD(tenantId, fields) },
      key,
      new TextEncoder().encode(JSON.stringify(values))
    );
    return {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv.buffer),
      keyId: `pii-key-v${this.env.PII_ENCRYPTION_KEY_VERSION ?? '1'}`,
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
    const entryId = params.id ?? crypto.randomUUID();
    const createdAt = params.createdAt ?? Date.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error('audit_event_created_at_invalid');
    }
    const createdAtDate = new Date(createdAt);
    if (!Number.isFinite(createdAtDate.getTime())) {
      throw new Error('audit_event_created_at_invalid');
    }
    const retentionUntil = calculateRetentionUntil(
      this.resolveRetentionDays(auditProfile, config, 'event', deliveryPlan.retentionDays),
      createdAtDate
    );

    const detailsJson = params.details
      ? logIcebergCanonicalJson(
          JSON.parse(
            JSON.stringify(sanitizeEventDetails(params.details as Record<string, unknown>, config))
          )
        )
      : null;

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
      detailsR2Key: undefined,
      detailsJson: detailsJson ?? undefined,
      retentionUntil,
      createdAt,
    };

    await emitLogIcebergRow(this.env, {
      tenantId,
      sourceDataset: 'core.event_log',
      logType: 'audit',
      eventAt: createdAt,
      expiresAt: retentionUntil,
      row: {
        id: entry.id,
        tenant_id: tenantId,
        event_type: entry.eventType,
        event_category: entry.eventCategory,
        result: entry.result,
        severity: entry.severity,
        error_code: entry.errorCode ?? null,
        error_message: entry.errorMessage ?? null,
        anonymized_user_id: entry.anonymizedUserId ?? null,
        client_id: entry.clientId ?? null,
        session_id: entry.sessionId ?? null,
        request_id: entry.requestId ?? null,
        duration_ms: entry.durationMs ?? null,
        details_r2_key: null,
        details_json: detailsJson,
        retention_until: retentionUntil,
        created_at: createdAt,
      },
      overview: {
        action: entry.eventType,
        result: entry.result,
        severity: entry.severity,
        reason_code: entry.errorCode ?? null,
        request_id: entry.requestId ?? null,
        subject_id: entry.anonymizedUserId ?? null,
        client_id: entry.clientId ?? null,
      },
    });
    await this.deliverExternalSinks(
      deliveryPlan,
      { type: 'event_log', entries: [entry], tenantId, timestamp: createdAt },
      params.requireDurableFanout === true
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

    // New PII records always resolve the live business mapping; only encrypted Queue retries
    // preserve an older subject after a purge has rotated the mapping.
    const anonymizedUserId = await this.getAnonymizedUserId(tenantId, params.userId);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        anonymizedUserId
      )
    )
      throw new Error('audit_pii_subject_invalid');
    const values: Record<string, unknown> = {};
    if (params.oldValues) values.old = params.oldValues;
    if (params.newValues) values.new = params.newValues;
    const entry: PIILogEntry = {
      id: entryId,
      tenantId,
      userId: params.userId,
      anonymizedUserId,
      changeType: params.changeType,
      affectedFields: JSON.stringify(params.affectedFields),
      encryptionKeyId: `object-key-v${this.env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1'}`,
      encryptionIv: '',
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      requestId: params.requestId,
      legalBasis: params.legalBasis,
      consentReference: params.consentReference,
      retentionUntil,
      createdAt,
    };
    await emitLogIcebergRow(this.env, {
      tenantId,
      sourceDataset: 'pii.pii_log',
      logType: 'pii',
      eventAt: createdAt,
      expiresAt: retentionUntil,
      row: {
        id: entryId,
        tenant_id: tenantId,
        user_id: params.userId,
        anonymized_user_id: anonymizedUserId,
        change_type: params.changeType,
        affected_fields: entry.affectedFields,
        values_r2_key: null,
        values_encrypted: null,
        encryption_key_id: entry.encryptionKeyId,
        encryption_iv: null,
        actor_user_id: params.actorUserId ?? null,
        actor_type: params.actorType,
        request_id: params.requestId ?? null,
        legal_basis: params.legalBasis ?? null,
        consent_reference: params.consentReference ?? null,
        retention_until: retentionUntil,
        created_at: createdAt,
      },
      overview: {
        action: params.changeType,
        result: 'success',
        subject_id: anonymizedUserId,
        request_id: params.requestId ?? null,
      },
      protectedDetail: { values: JSON.parse(JSON.stringify(values)) },
    });
    if (this.buildFanoutPlan(deliveryPlan)) {
      const encrypted = await this.encryptValuesForExternal(
        values,
        tenantId,
        params.affectedFields
      );
      entry.valuesEncrypted = JSON.stringify(encrypted);
      entry.encryptionKeyId = encrypted.keyId;
      entry.encryptionIv = encrypted.iv;
    }
    // The external protocol keeps its existing encrypted values; it never creates another stored log copy.
    await this.deliverExternalSinks(deliveryPlan, {
      type: 'pii_log',
      entries: [entry],
      tenantId,
      timestamp: createdAt,
    });
  }

  /**
   * Log an event with associated PII change.
   */
  async logEventWithPII(tenantId: string, params: CombinedLogParams): Promise<void> {
    // Get anonymized user ID first (shared between both logs)
    const anonymizedUserId = await this.getAnonymizedUserId(tenantId, params.pii.userId);

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
    const service = await this.anonymizationFor(tenantId, userId);
    const id = await service.getAnonymizedUserIdUnlessErased(tenantId, userId);
    if (!id) throw new Error('audit_subject_erased');
    return id;
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
    return this.executePIIPurge(tenantId, userId, { ...context });
  }

  /** Cron resumes the durable authorization only; it cannot create a fresh purge of B. */
  async resumePendingPIIPurge(
    tenantId: string,
    userId: string,
    expectedOperationId: string
  ): Promise<PurgeResult> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        expectedOperationId
      )
    )
      throw new Error('pii_purge_operation_id_invalid');
    return this.executePIIPurge(
      tenantId,
      userId,
      {
        actorUserId: 'system',
        actorType: 'system',
        deletionReason: 'durable_intent_resume',
        requestId: `pii-purge-resume:${expectedOperationId}`,
      },
      expectedOperationId
    );
  }

  private async executePIIPurge(
    tenantId: string,
    userId: string,
    context: Omit<PurgeContext, 'deletionReason'> & {
      deletionReason: PurgeContext['deletionReason'] | 'durable_intent_resume';
    },
    expectedOperationId?: string
  ): Promise<PurgeResult> {
    let purgeJobId = crypto.randomUUID();

    let anonymizedUserId: string;
    try {
      // Register the bounded maintenance scope before the PII intent: a crash can leave an
      // empty scope, but can never leave a newly authorized intent undiscoverable by cron.
      const writer =
        this.env.LOG_ARCHIVE_WRITER ??
        createLogIcebergWritePort(this.env, resolveLogIcebergConfig(this.env));
      if (this.env.LOG_ARCHIVE_WRITER) await writer.registerPiiPurgeScope(tenantId);
      else
        await runTenantBackupCoveredEffect(
          { CONTROL: this.env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
          { tenantId },
          () => writer.registerPiiPurgeScope(tenantId)
        );
      const operation = await runTenantBackupCoveredEffect(
        { CONTROL: this.env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
        { tenantId },
        async () =>
          expectedOperationId
            ? (await this.anonymizationFor(tenantId, userId)).loadPendingPIILogPurge(
                tenantId,
                userId,
                expectedOperationId
              )
            : (await this.anonymizationFor(tenantId, userId)).preparePIILogPurge(tenantId, userId)
      );
      if (!operation)
        return {
          success: true,
          skipped: true,
          piiLogsDeleted: 0,
          purgeJobId: expectedOperationId ?? purgeJobId,
        };
      anonymizedUserId = operation.old_anonymized_user_id;
      purgeJobId = operation.id;
    } catch (error) {
      return {
        success: false,
        piiLogsDeleted: 0,
        purgeJobId,
        errorMessage: sanitizeErrorMessage(String(error)),
      };
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
      const erased = await eraseLogIcebergSubject(this.env, {
        tenantId,
        sourceDataset: 'pii.pii_log',
        subjectId: anonymizedUserId,
      });
      if (!erased.complete) {
        return {
          success: false,
          pending: true,
          piiLogsDeleted: erased.removed,
          purgeJobId,
          errorMessage: 'pii_purge_pending',
        };
      }
      const piiLogsDeleted = erased.removed;
      // Step 4: Log purge completed
      await this.logEvent(tenantId, {
        eventType: 'user.pii_purge_completed',
        eventCategory: 'security',
        result: 'success',
        severity: 'critical',
        // Do not attach the erased generation to the completion event; the live mapping is retained.
        requestId: context.requestId,
        details: {
          purgeJobId,
          piiLogsDeleted,
          deletionReason: context.deletionReason,
        },
      });

      // Retain the restart pointer until completion logging is accepted. A failed log write
      // must retry the old subject instead of starting a new purge of the live generation.
      await runTenantBackupCoveredEffect(
        { CONTROL: this.env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
        { tenantId },
        async () =>
          (await this.anonymizationFor(tenantId, userId)).completePIILogPurge(
            tenantId,
            userId,
            purgeJobId
          )
      );

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
}

/**
 * Create audit service instance.
 */
export function createAuditService(deps: AuditServiceDependencies): IAuditService {
  return new AuditService(deps);
}
