/**
 * Check Audit Service
 *
 * Phase 3: Permission check audit logging service
 *
 * Provides flexible audit logging for permission checks with three modes:
 * - waitUntil: Non-blocking (recommended for most cases)
 * - sync: Synchronous logging (guaranteed logging before response)
 * - queue: Queue-based async processing (high-scale scenarios)
 */

import type { Queue, ExecutionContext } from '@cloudflare/workers-types';
import type { ParsedPermission, ResolvedVia, FinalDecision } from '../types/check-api';
import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../db';
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

/**
 * Queue message for async audit logging
 * Named CheckAuditQueueMessage to avoid conflict with the unified audit system's AuditQueueMessage
 */
export interface CheckAuditQueueMessage {
  type: 'permission_check_audit';
  entry: PermissionCheckAuditEntry;
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
  private db: DatabaseAdapter;
  private config: CheckAuditServiceConfig;
  private queue?: Queue<CheckAuditQueueMessage>;

  constructor(db: DatabaseSource, config?: Partial<CheckAuditServiceConfig>, queue?: Queue) {
    this.db = ensureDatabaseAdapter(db, 'policy-check-audit');
    this.config = { ...DEFAULT_CHECK_AUDIT_CONFIG, ...config };
    this.queue = queue as Queue<CheckAuditQueueMessage> | undefined;
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
   * - queue: Queue-based async processing
   *
   * @param entry - Audit entry to log
   * @param ctx - ExecutionContext for waitUntil mode
   */
  async log(entry: PermissionCheckAuditEntry, ctx?: ExecutionContext): Promise<void> {
    // Check if we should log this entry
    if (!this.shouldLog(entry.allowed)) {
      return;
    }

    try {
      switch (this.config.mode) {
        case 'waitUntil':
          if (ctx) {
            ctx.waitUntil(this.writeLog(entry));
          } else {
            // Fallback to sync if no context provided
            await this.writeLog(entry);
          }
          break;

        case 'sync':
          await this.writeLog(entry);
          break;

        case 'queue':
          if (this.queue) {
            await this.queue.send({
              type: 'permission_check_audit',
              entry,
            });
          } else {
            // Fallback to sync if queue not configured
            log.warn('Queue not configured, falling back to sync mode');
            await this.writeLog(entry);
          }
          break;
      }
    } catch (error) {
      // Log errors but don't fail the request
      log.error('Failed to log audit entry', { entryId: entry.id }, error as Error);
    }
  }

  /**
   * Write audit entry to database
   */
  private async writeLog(entry: PermissionCheckAuditEntry): Promise<void> {
    const checkedAt = Math.floor(Date.now() / 1000);

    await this.db.execute(
      `INSERT INTO permission_check_audit (
        id, tenant_id, subject_id, permission, permission_json,
        allowed, resolved_via_json, final_decision, reason,
        api_key_id, client_id, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.tenantId,
        entry.subjectId,
        entry.permission,
        entry.permissionParsed ? JSON.stringify(entry.permissionParsed) : null,
        entry.allowed ? 1 : 0,
        JSON.stringify(entry.resolvedVia),
        entry.finalDecision,
        entry.reason ?? null,
        entry.apiKeyId ?? null,
        entry.clientId ?? null,
        checkedAt,
      ]
    );
  }

  /**
   * Process audit queue message (for queue consumer)
   */
  async processQueueMessage(message: CheckAuditQueueMessage): Promise<void> {
    if (message.type === 'permission_check_audit') {
      await this.writeLog(message.entry);
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

  /**
   * Clean up old audit entries (scheduled job)
   *
   * @returns Number of deleted entries
   */
  async cleanupOldEntries(): Promise<number> {
    if (!this.config.retentionDays) {
      return 0;
    }

    const cutoffTime = Math.floor(Date.now() / 1000) - this.config.retentionDays * 24 * 60 * 60;

    const result = await this.db.execute(
      'DELETE FROM permission_check_audit WHERE checked_at < ?',
      [cutoffTime]
    );

    const deleted = result.rowsAffected;
    log.info('Cleaned up old audit entries', { deleted, cutoffTime });

    return deleted;
  }
}

/**
 * Create CheckAuditService instance
 */
export function createCheckAuditService(
  db: DatabaseSource,
  config?: Partial<CheckAuditServiceConfig>,
  queue?: Queue
): CheckAuditService {
  return new CheckAuditService(db, config, queue);
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
