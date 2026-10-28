/**
 * Check Audit Service
 *
 * Phase 3: Permission check audit logging service
 *
 * Provides flexible audit logging for permission checks with three modes:
 * - waitUntil: Non-blocking (recommended for most cases)
 * - sync: Synchronous logging (guaranteed logging before response)
 * - queue: Await acceptance by the common durable storage writer
 */

import type { ExecutionContext } from '@cloudflare/workers-types';
import type { ParsedPermission, ResolvedVia, FinalDecision } from '../types/check-api';
import type { LogIcebergRuntimeEnv } from './log-iceberg-runtime';
import { emitLogIcebergRow } from './log-iceberg-emitter';
import { createLogger } from '../utils/logger';

const log = createLogger().module('CHECK-AUDIT-SERVICE');

// =============================================================================
// Types
// =============================================================================

/**
 * Audit logging mode
 */
export type AuditMode = 'waitUntil' | 'sync' | 'queue';

/**
 * Configuration for CheckAuditService
 */
export interface CheckAuditServiceConfig {
  /** Audit logging mode */
  mode: AuditMode;
  /** How to log deny events (always log denies) */
  logDeny: 'always';
  /** How to log allow events */
  logAllow: 'always' | 'sample' | 'never';
  /** Sample rate for allow events (0.01 = 1%) */
  sampleRate: number;
  /** Retention days for audit logs (optional, for cleanup reference) */
  retentionDays?: number;
}

/**
 * Permission check audit entry
 */
export interface PermissionCheckAuditEntry {
  /** Unique ID */
  id: string;
  /** Tenant ID */
  tenantId: string;
  /** Subject ID */
  subjectId: string;
  /** Permission string */
  permission: string;
  /** Parsed permission (for detailed logging) */
  permissionParsed?: ParsedPermission;
  /** Whether access was allowed */
  allowed: boolean;
  /** How the permission was resolved */
  resolvedVia: ResolvedVia[];
  /** Final decision */
  finalDecision: FinalDecision;
  /** Reason for denial (if denied) */
  reason?: string;
  /** API key ID (if authenticated via API key) */
  apiKeyId?: string;
  /** Client ID */
  clientId?: string;
  /** Request ID for correlation */
  requestId?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default audit configuration for Check API audit logging
 * Named DEFAULT_CHECK_AUDIT_CONFIG to avoid conflict with types/contracts/audit.ts DEFAULT_AUDIT_CONFIG
 * Secure defaults: always log denies, sample 1% of allows
 */
export const DEFAULT_CHECK_AUDIT_CONFIG: CheckAuditServiceConfig = {
  mode: 'waitUntil',
  logDeny: 'always',
  logAllow: 'sample',
  sampleRate: 0.01, // 1%
  retentionDays: 90,
};

// =============================================================================
// CheckAuditService
// =============================================================================

/**
 * Check Audit Service
 *
 * Provides permission check audit logging with configurable modes.
 */
export class CheckAuditService {
  private config: CheckAuditServiceConfig;

  constructor(
    private readonly env: LogIcebergRuntimeEnv,
    config?: Partial<CheckAuditServiceConfig>
  ) {
    this.config = { ...DEFAULT_CHECK_AUDIT_CONFIG, ...config };
  }

  /**
   * Determine if an audit entry should be logged
   */
  shouldLog(allowed: boolean): boolean {
    // Always log denies
    if (!allowed && this.config.logDeny === 'always') {
      return true;
    }

    // Check allow logging policy
    if (allowed) {
      switch (this.config.logAllow) {
        case 'never':
          return false;
        case 'always':
          return true;
        case 'sample':
          return Math.random() < this.config.sampleRate;
      }
    }

    return false;
  }

  /**
   * Log a permission check audit entry
   *
   * Uses the configured mode to write the log:
   * - waitUntil: Non-blocking via ExecutionContext.waitUntil()
   * - sync: Synchronous write (blocks until complete)
   * - queue: Await acceptance by the configured durable storage writer
   *
   * @param entry - Audit entry to log
   * @param ctx - ExecutionContext for waitUntil mode
   */
  async log(entry: PermissionCheckAuditEntry, ctx?: ExecutionContext): Promise<void> {
    // Check if we should log this entry
    if (!this.shouldLog(entry.allowed)) {
      return;
    }

    let frozen: PermissionCheckAuditEntry;
    try {
      frozen = structuredClone(entry);
    } catch (error) {
      log.error(
        'Failed to prepare audit entry',
        {},
        error instanceof Error ? error : new Error('check_audit_prepare_failed')
      );
      return;
    }
    const checkedAt = Math.floor(Date.now() / 1000);
    const retentionDays = this.config.retentionDays ?? 90;
    const write = async () => {
      try {
        if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
          throw new Error('check_audit_retention_invalid');
        await emitLogIcebergRow(this.env, {
          tenantId: frozen.tenantId,
          sourceDataset: 'core.permission_check_audit',
          logType: 'audit',
          eventAt: checkedAt * 1000,
          expiresAt: (checkedAt + retentionDays * 86400) * 1000,
          overview: {
            action: frozen.permission,
            result: frozen.allowed ? 'allow' : 'deny',
            subject_id: frozen.subjectId,
            client_id: frozen.clientId ?? null,
            request_id: frozen.requestId ?? null,
          },
          row: {
            id: frozen.id,
            tenant_id: frozen.tenantId,
            subject_id: frozen.subjectId,
            permission: frozen.permission,
            permission_json: frozen.permissionParsed
              ? JSON.stringify(frozen.permissionParsed)
              : null,
            allowed: frozen.allowed ? 1 : 0,
            resolved_via_json: JSON.stringify(frozen.resolvedVia),
            final_decision: frozen.finalDecision,
            reason: frozen.reason ?? null,
            api_key_id: frozen.apiKeyId ?? null,
            client_id: frozen.clientId ?? null,
            checked_at: checkedAt,
          },
        });
      } catch (error) {
        // A failed audit must never change the authorization decision, including
        // an asynchronously rejected waitUntil write.
        log.error(
          'Failed to log audit entry',
          { entryId: frozen.id },
          error instanceof Error ? error : new Error('check_audit_write_failed')
        );
      }
    };
    // The setup storage mode owns transport. The queue timing option waits for
    // the common durable writer; scheduled mode never invokes a Pipeline.
    try {
      if (this.config.mode === 'waitUntil' && ctx) ctx.waitUntil(write());
      else await write();
    } catch (error) {
      log.error(
        'Failed to schedule audit entry',
        { entryId: frozen.id },
        error instanceof Error ? error : new Error('check_audit_schedule_failed')
      );
    }
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<CheckAuditServiceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): CheckAuditServiceConfig {
    return { ...this.config };
  }
}

/**
 * Create CheckAuditService instance
 */
export function createCheckAuditService(
  env: LogIcebergRuntimeEnv,
  config?: Partial<CheckAuditServiceConfig>
): CheckAuditService {
  return new CheckAuditService(env, config);
}

/**
 * Generate unique audit entry ID
 */
export function generateAuditId(): string {
  const timestamp = Date.now().toString(36);
  const randomBytes = new Uint8Array(5);
  crypto.getRandomValues(randomBytes);
  const random = Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `aud_${timestamp}${random}`;
}
