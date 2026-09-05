/**
 * Device Secret Repository
 *
 * Repository for OIDC Native SSO 1.0 device secrets stored in D1_CORE database.
 * Handles device secret lifecycle: creation, validation, usage tracking, and revocation.
 *
 * Key features:
 * - Device secret creation with configurable TTL
 * - Validation with raw secret input (internal hashing)
 * - Usage tracking (use_count, last_used_at)
 * - Session-bound revocation (logout propagation)
 * - Rate limit support via validation result types
 *
 * Data Classification: Non-PII
 * - Only stores secret_hash (SHA-256 one-way hash)
 * - No personal information in this table
 * - Suitable for D1_CORE database
 *
 * Table: device_secrets
 * Schema: see migrations/001_0_4_0_core_baseline.sql
 */

import { BaseRepository, generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';
import type {
  DeviceSecret,
  DeviceSecretValidationResult,
  CreateDeviceSecretInput,
} from '../../types/oidc';
import { createLogger } from '../../utils/logger';

const log = createLogger().module('DeviceSecret');

/**
 * Database row type for device_secrets table
 */
interface DeviceSecretRow {
  id: string;
  installation_id?: string | null;
  tenant_id: string;
  client_id?: string | null;
  trust_group_id?: string | null;
  source_installation_id?: string | null;
  source_client_id?: string | null;
  user_id: string;
  session_id: string;
  secret_hash: string;
  device_name: string | null;
  device_platform: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked_at: number | null;
  revoke_reason: string | null;
  is_active: number;
}

/** Default device secret TTL: 30 days in milliseconds */
const DEFAULT_DEVICE_SECRET_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum allowed TTL: 1 hour in milliseconds */
const MIN_DEVICE_SECRET_TTL_MS = 60 * 60 * 1000;

/** Maximum allowed TTL: 90 days in milliseconds */
const MAX_DEVICE_SECRET_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Default max device secrets per user */
const DEFAULT_MAX_SECRETS_PER_USER = 10;

function isMissingInstallationMetadataColumnsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('installation_id') ||
    message.includes('client_id') ||
    message.includes('trust_group_id') ||
    message.includes('source_installation_id') ||
    message.includes('source_client_id')
  );
}

/**
 * Result of device secret creation
 * Raw secret is returned only once during initial issuance
 */
export interface CreateDeviceSecretResult {
  /** Raw device secret (return to client, do not store) */
  secret: string;
  /** Device secret entity (with hashed secret) */
  entity: DeviceSecret;
}

/**
 * Options for device secret creation
 */
export interface DeviceSecretCreateOptions {
  /** Maximum device secrets allowed per user (default: 10) */
  maxSecretsPerUser?: number;
  /**
   * Behavior when max secrets exceeded
   * - 'revoke_oldest': Automatically revoke oldest secret and create new one (recommended)
   * - 'reject': Reject the creation request
   */
  maxSecretsBehavior?: 'revoke_oldest' | 'reject';
}

function requireTenantId(tenantId: string | undefined, context: string): string {
  const normalized = tenantId?.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

/**
 * Device Secret Repository
 *
 * Provides CRUD operations for OIDC Native SSO device secrets with:
 * - Automatic expiration handling
 * - Session-bound lifecycle (revoked when session is deleted)
 * - Usage tracking for anomaly detection
 * - Soft delete via is_active flag
 */
export class DeviceSecretRepository extends BaseRepository<DeviceSecret> {
  private readonly tenantId: string;

  constructor(adapter: DatabaseAdapter, tenantId: string) {
    super(adapter, {
      tableName: 'device_secrets',
      softDelete: true,
      softDeleteField: 'is_active',
      allowedFields: [
        'tenant_id',
        'installation_id',
        'client_id',
        'trust_group_id',
        'source_installation_id',
        'source_client_id',
        'user_id',
        'session_id',
        'secret_hash',
        'device_name',
        'device_platform',
        'expires_at',
        'last_used_at',
        'use_count',
        'revoked_at',
        'revoke_reason',
        'is_active',
      ],
    });
    this.tenantId = requireTenantId(tenantId, 'DeviceSecretRepository');
  }

  /**
   * Generate a cryptographically secure device secret
   * Uses 32 bytes of random data, base64url encoded
   *
   * @returns Raw device secret string
   */
  private generateDeviceSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return this.base64UrlEncode(bytes);
  }

  /**
   * Hash device secret for storage
   * Uses SHA-256 for consistent, irreversible hashing
   *
   * @param deviceSecret - Raw device secret
   * @returns SHA-256 hash as hex string
   */
  private async hashDeviceSecret(deviceSecret: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(deviceSecret);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Base64URL encode bytes
   */
  private base64UrlEncode(bytes: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
  }

  /**
   * Validate and normalize TTL value
   *
   * @param ttl - TTL in milliseconds
   * @param defaultValue - Default value if TTL is invalid
   * @returns Validated TTL clamped to bounds
   */
  private validateTtl(ttl: number | undefined, defaultValue: number): number {
    if (ttl === undefined) {
      return defaultValue;
    }

    if (!Number.isFinite(ttl) || ttl <= 0) {
      return defaultValue;
    }

    return Math.min(Math.max(ttl, MIN_DEVICE_SECRET_TTL_MS), MAX_DEVICE_SECRET_TTL_MS);
  }

  /**
   * Create a new device secret
   *
   * @param input - Device secret creation input
   * @param options - Creation options (max secrets behavior, etc.)
   * @returns Raw secret (return once) and entity, or validation result if limit exceeded
   *
   * @remarks
   * - Raw secret is returned only once during initial issuance
   * - Only secret_hash is stored in database
   * - When max secrets per user is reached, behavior depends on options
   */
  async createSecret(
    input: CreateDeviceSecretInput,
    options?: DeviceSecretCreateOptions
  ): Promise<CreateDeviceSecretResult | DeviceSecretValidationResult> {
    const maxSecrets = options?.maxSecretsPerUser ?? DEFAULT_MAX_SECRETS_PER_USER;
    const maxBehavior = options?.maxSecretsBehavior ?? 'revoke_oldest';
    const tenantId = requireTenantId(
      input.tenant_id ?? this.tenantId,
      'DeviceSecretRepository.createSecret'
    );

    // Check existing secrets count for user
    const existingCount = await this.countByUserId(
      input.user_id,
      tenantId,
      true // valid only
    );

    if (existingCount >= maxSecrets) {
      if (maxBehavior === 'reject') {
        return { ok: false, reason: 'limit_exceeded' };
      }

      // revoke_oldest: find and revoke the oldest active secret
      const oldest = await this.findOldestByUserId(input.user_id, tenantId);
      if (oldest) {
        await this.revoke(oldest.id, 'auto_revoke_max_limit', oldest.tenant_id);
      }
    }

    // Generate raw secret and hash it
    const rawSecret = this.generateDeviceSecret();
    const secretHash = await this.hashDeviceSecret(rawSecret);

    const now = getCurrentTimestamp();
    const ttl = this.validateTtl(input.ttl_ms, DEFAULT_DEVICE_SECRET_TTL_MS);
    const expiresAt = now + ttl;

    const entity: DeviceSecret = {
      id: generateId(),
      installation_id: input.installation_id ?? `inst_${generateId()}`,
      tenant_id: tenantId,
      client_id: input.client_id,
      trust_group_id: input.trust_group_id,
      source_installation_id: input.source_installation_id,
      source_client_id: input.source_client_id,
      user_id: input.user_id,
      session_id: input.session_id,
      secret_hash: secretHash,
      device_name: input.device_name,
      device_platform: input.device_platform,
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
      last_used_at: undefined,
      use_count: 0,
      revoked_at: undefined,
      revoke_reason: undefined,
      is_active: 1,
    };

    // Insert into database
    const sql = `
      INSERT INTO device_secrets (
        id, installation_id, tenant_id, client_id, trust_group_id,
        source_installation_id, source_client_id, user_id, session_id, secret_hash,
        device_name, device_platform, created_at, updated_at,
        expires_at, last_used_at, use_count, revoked_at, revoke_reason, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      entity.id,
      entity.installation_id,
      entity.tenant_id,
      entity.client_id ?? null,
      entity.trust_group_id ?? null,
      entity.source_installation_id ?? null,
      entity.source_client_id ?? null,
      entity.user_id,
      entity.session_id,
      entity.secret_hash,
      entity.device_name ?? null,
      entity.device_platform ?? null,
      entity.created_at,
      entity.updated_at,
      entity.expires_at,
      entity.last_used_at ?? null,
      entity.use_count,
      entity.revoked_at ?? null,
      entity.revoke_reason ?? null,
      entity.is_active,
    ];

    try {
      await this.adapter.execute(sql, params);
    } catch (error) {
      if (!isMissingInstallationMetadataColumnsError(error)) {
        throw error;
      }

      entity.installation_id = entity.id;
      log.warn('device_secrets installation metadata columns missing; using legacy id fallback', {
        action: 'NativeSSO',
      });
      await this.adapter.execute(
        `
          INSERT INTO device_secrets (
            id, tenant_id, user_id, session_id, secret_hash,
            device_name, device_platform, created_at, updated_at,
            expires_at, last_used_at, use_count, revoked_at, revoke_reason, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          entity.id,
          entity.tenant_id,
          entity.user_id,
          entity.session_id,
          entity.secret_hash,
          entity.device_name ?? null,
          entity.device_platform ?? null,
          entity.created_at,
          entity.updated_at,
          entity.expires_at,
          entity.last_used_at ?? null,
          entity.use_count,
          entity.revoked_at ?? null,
          entity.revoke_reason ?? null,
          entity.is_active,
        ]
      );
    }

    return {
      secret: rawSecret,
      entity,
    };
  }

  /**
   * Validate device secret and record usage
   *
   * ⚠️ IMPORTANT: This method accepts RAW device secret (not hash)
   * - Internally computes hash and looks up in database
   * - Prevents caller mistakes of "hash vs raw" confusion
   * - Future-proofs against hash algorithm changes
   *
   * Security: Replay attack prevention
   * - maxUseCount limits how many times a device_secret can be used
   * - Default is 10 uses (allows legitimate app restarts while preventing abuse)
   * - When limit is exceeded, the device_secret is automatically revoked
   * - Set to 1 for one-time use (most secure)
   *
   * @param deviceSecret - Raw device secret from client
   * @param options - Validation options
   * @returns Validation result with entity or error reason
   */
  async validateAndUse(
    deviceSecret: string,
    options: { maxUseCount?: number; tenantId?: string } = {}
  ): Promise<DeviceSecretValidationResult> {
    const { maxUseCount = 10 } = options; // Default: 10 uses max
    const tenantId = requireTenantId(
      options.tenantId ?? this.tenantId,
      'DeviceSecretRepository.validateAndUse'
    );

    // Hash the raw secret for lookup
    const secretHash = await this.hashDeviceSecret(deviceSecret);

    // Look up by secret_hash
    const sql = `
      SELECT * FROM device_secrets
      WHERE secret_hash = ? AND tenant_id = ?
      LIMIT 1
    `;

    const row = await this.adapter.queryOne<DeviceSecretRow>(sql, [secretHash, tenantId]);

    if (!row) {
      // Add intentional delay to prevent timing attacks on not_found
      await this.addSecurityDelay();
      return { ok: false, reason: 'not_found' };
    }

    const entity = this.rowToEntity(row);
    const now = getCurrentTimestamp();

    // Check if revoked
    if (entity.revoked_at !== undefined || entity.is_active !== 1) {
      return { ok: false, reason: 'revoked' };
    }

    // Check if expired
    if (entity.expires_at <= now) {
      return { ok: false, reason: 'expired' };
    }

    // Check use count limit (replay attack prevention)
    // Note: We check BEFORE incrementing, so use_count >= maxUseCount means limit exceeded
    if (entity.use_count >= maxUseCount) {
      // Auto-revoke when limit exceeded
      await this.revoke(entity.id, 'use_count_exceeded', tenantId);
      log.warn('Auto-revoked device secret due to use count limit', {
        secretIdPrefix: entity.id.substring(0, 8),
        useCount: entity.use_count,
        maxUseCount,
      });
      return { ok: false, reason: 'limit_exceeded' };
    }

    // Update usage tracking
    const updateSql = `
      UPDATE device_secrets
      SET last_used_at = ?, use_count = use_count + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `;

    await this.adapter.execute(updateSql, [now, now, entity.id, tenantId]);

    // Return updated entity
    return {
      ok: true,
      entity: {
        ...entity,
        last_used_at: now,
        use_count: entity.use_count + 1,
        updated_at: now,
      },
    };
  }

  /**
   * Find a device secret by its raw secret without recording usage.
   *
   * Used by RFC 7662 introspection and RFC 7009 revocation. The raw secret is
   * hashed internally so callers do not need to know storage details.
   */
  async findByRawSecret(
    deviceSecret: string,
    tenantId: string = this.tenantId
  ): Promise<DeviceSecret | null> {
    const secretHash = await this.hashDeviceSecret(deviceSecret);
    const sql = `
      SELECT * FROM device_secrets
      WHERE secret_hash = ? AND tenant_id = ?
      LIMIT 1
    `;

    const row = await this.adapter.queryOne<DeviceSecretRow>(sql, [secretHash, tenantId]);
    return row ? this.rowToEntity(row) : null;
  }

  async findById(id: string, tenantId: string = this.tenantId): Promise<DeviceSecret | null> {
    const row = await this.adapter.queryOne<DeviceSecretRow>(
      'SELECT * FROM device_secrets WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    return row ? this.rowToEntity(row) : null;
  }

  async update(
    id: string,
    data: Partial<Omit<DeviceSecret, 'id' | 'created_at' | 'updated_at'>>,
    tenantId: string = this.tenantId
  ): Promise<DeviceSecret | null> {
    const existing = await this.findById(id, tenantId);
    if (!existing) {
      return null;
    }

    const now = getCurrentTimestamp();
    const updateData = {
      ...data,
      updated_at: now,
    };
    const fields = Object.keys(updateData).filter((field) => {
      const value = updateData[field as keyof typeof updateData];
      return value !== undefined && this.isAllowedField(field);
    });

    if (fields.length === 0) {
      return existing;
    }

    const setClause = fields.map((field) => `${field} = ?`).join(', ');
    const values = fields.map((field) => updateData[field as keyof typeof updateData]);
    await this.adapter.execute(
      `UPDATE device_secrets SET ${setClause} WHERE id = ? AND tenant_id = ?`,
      [...values, id, tenantId]
    );

    return this.findById(id, tenantId);
  }

  async delete(id: string, tenantId: string = this.tenantId): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE device_secrets SET is_active = 0, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [getCurrentTimestamp(), id, tenantId]
    );
    return result.rowsAffected > 0;
  }

  async hardDelete(id: string, tenantId: string = this.tenantId): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM device_secrets WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Find a device secret by canonical installation id, falling back to legacy row id.
   */
  async findByInstallationId(
    installationId: string,
    tenantId: string = this.tenantId
  ): Promise<DeviceSecret | null> {
    try {
      const row = await this.adapter.queryOne<DeviceSecretRow>(
        `
          SELECT * FROM device_secrets
          WHERE tenant_id = ? AND installation_id = ?
          LIMIT 1
        `,
        [tenantId, installationId]
      );
      if (row) {
        return this.rowToEntity(row);
      }
    } catch (error) {
      if (!isMissingInstallationMetadataColumnsError(error)) {
        throw error;
      }
    }
    return this.findById(installationId, tenantId);
  }

  /**
   * Revoke a device secret by its raw secret value.
   */
  async revokeByRawSecret(
    deviceSecret: string,
    reason?: string,
    tenantId: string = this.tenantId
  ): Promise<boolean> {
    const entity = await this.findByRawSecret(deviceSecret, tenantId);
    if (!entity) {
      await this.addSecurityDelay();
      return false;
    }

    return this.revoke(entity.id, reason ?? 'token_revocation', tenantId);
  }

  /**
   * Add intentional delay for security (timing attack mitigation)
   * Random delay between 50-150ms to mask timing differences
   */
  private async addSecurityDelay(): Promise<void> {
    const delayMs = 50 + Math.floor(Math.random() * 100);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * Find device secrets by user ID
   *
   * @param userId - User ID
   * @param tenantId - Tenant ID
   * @param validOnly - If true, return only non-expired, non-revoked secrets
   * @returns Array of device secrets
   */
  async findByUserId(
    userId: string,
    tenantId: string = this.tenantId,
    validOnly: boolean = false
  ): Promise<DeviceSecret[]> {
    let sql = `
      SELECT * FROM device_secrets
      WHERE tenant_id = ? AND user_id = ? AND is_active = 1
    `;
    const params: unknown[] = [tenantId, userId];

    if (validOnly) {
      const now = getCurrentTimestamp();
      sql += ' AND expires_at > ? AND revoked_at IS NULL';
      params.push(now);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = await this.adapter.query<DeviceSecretRow>(sql, params);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Find device secrets by session ID
   * Used for logout propagation
   *
   * @param sessionId - Session ID
   * @returns Array of device secrets
   */
  async findBySessionId(
    sessionId: string,
    tenantId: string = this.tenantId
  ): Promise<DeviceSecret[]> {
    const sql = `
      SELECT * FROM device_secrets
      WHERE session_id = ? AND tenant_id = ? AND is_active = 1
      ORDER BY created_at DESC
    `;

    const rows = await this.adapter.query<DeviceSecretRow>(sql, [sessionId, tenantId]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Find oldest active device secret for a user
   * Used for revoke_oldest behavior
   *
   * @param userId - User ID
   * @param tenantId - Tenant ID
   * @returns Oldest device secret or null
   */
  private async findOldestByUserId(userId: string, tenantId: string): Promise<DeviceSecret | null> {
    const now = getCurrentTimestamp();
    const sql = `
      SELECT * FROM device_secrets
      WHERE tenant_id = ? AND user_id = ? AND is_active = 1
        AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at ASC
      LIMIT 1
    `;

    const row = await this.adapter.queryOne<DeviceSecretRow>(sql, [tenantId, userId, now]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Count device secrets for a user
   *
   * @param userId - User ID
   * @param tenantId - Tenant ID
   * @param validOnly - If true, count only non-expired, non-revoked secrets
   * @returns Count
   */
  async countByUserId(
    userId: string,
    tenantId: string = this.tenantId,
    validOnly: boolean = false
  ): Promise<number> {
    let sql = `
      SELECT COUNT(*) as count FROM device_secrets
      WHERE tenant_id = ? AND user_id = ? AND is_active = 1
    `;
    const params: unknown[] = [tenantId, userId];

    if (validOnly) {
      const now = getCurrentTimestamp();
      sql += ' AND expires_at > ? AND revoked_at IS NULL';
      params.push(now);
    }

    const result = await this.adapter.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  /**
   * Revoke a device secret
   *
   * @param id - Device secret ID
   * @param reason - Revocation reason (for audit)
   * @returns True if revoked, false if not found
   */
  async revoke(id: string, reason?: string, tenantId: string = this.tenantId): Promise<boolean> {
    const now = getCurrentTimestamp();
    const sql = `
      UPDATE device_secrets
      SET revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND is_active = 1 AND revoked_at IS NULL
    `;

    const result = await this.adapter.execute(sql, [now, reason ?? null, now, id, tenantId]);
    return result.rowsAffected > 0;
  }

  /**
   * Revoke all device secrets for a session
   * Used for logout propagation
   *
   * @param sessionId - Session ID
   * @param reason - Revocation reason
   * @returns Number of revoked secrets
   */
  async revokeBySessionId(
    sessionId: string,
    reason?: string,
    tenantId: string = this.tenantId
  ): Promise<number> {
    const now = getCurrentTimestamp();
    const sql = `
      UPDATE device_secrets
      SET revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE session_id = ? AND tenant_id = ? AND is_active = 1 AND revoked_at IS NULL
    `;

    const result = await this.adapter.execute(sql, [
      now,
      reason ?? 'session_logout',
      now,
      sessionId,
      tenantId,
    ]);
    return result.rowsAffected;
  }

  /**
   * Revoke all device secrets for a user
   * Used for account security events
   *
   * @param userId - User ID
   * @param tenantId - Tenant ID
   * @param reason - Revocation reason
   * @returns Number of revoked secrets
   */
  async revokeByUserId(
    userId: string,
    tenantId: string = this.tenantId,
    reason?: string
  ): Promise<number> {
    const now = getCurrentTimestamp();
    const sql = `
      UPDATE device_secrets
      SET revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE tenant_id = ? AND user_id = ? AND is_active = 1 AND revoked_at IS NULL
    `;

    const result = await this.adapter.execute(sql, [
      now,
      reason ?? 'user_logout_all',
      now,
      tenantId,
      userId,
    ]);
    return result.rowsAffected;
  }

  /**
   * Cleanup expired device secrets
   * Intended for periodic cleanup job
   *
   * @returns Number of deleted secrets
   */
  async cleanupExpired(tenantId: string = this.tenantId): Promise<number> {
    const now = getCurrentTimestamp();
    const sql = `
      DELETE FROM device_secrets
      WHERE tenant_id = ? AND is_active = 1 AND expires_at <= ?
    `;

    const result = await this.adapter.execute(sql, [tenantId, now]);
    return result.rowsAffected;
  }

  /**
   * Cleanup revoked device secrets older than specified age
   *
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of deleted secrets
   */
  async cleanupRevokedOlderThan(
    maxAgeMs: number,
    tenantId: string = this.tenantId
  ): Promise<number> {
    const cutoff = getCurrentTimestamp() - maxAgeMs;
    const sql = `
      DELETE FROM device_secrets
      WHERE tenant_id = ? AND revoked_at IS NOT NULL AND revoked_at <= ?
    `;

    const result = await this.adapter.execute(sql, [tenantId, cutoff]);
    return result.rowsAffected;
  }

  /**
   * Get statistics for a user's device secrets
   *
   * @param userId - User ID
   * @param tenantId - Tenant ID
   * @returns Device secret statistics
   */
  async getStatsForUser(
    userId: string,
    tenantId: string = this.tenantId
  ): Promise<{
    total: number;
    active: number;
    expired: number;
    revoked: number;
    totalUseCount: number;
  }> {
    const now = getCurrentTimestamp();
    const sql = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN expires_at > ? AND revoked_at IS NULL AND is_active = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN expires_at <= ? AND is_active = 1 THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) as revoked,
        COALESCE(SUM(use_count), 0) as totalUseCount
      FROM device_secrets
      WHERE tenant_id = ? AND user_id = ?
    `;

    const result = await this.adapter.queryOne<{
      total: number;
      active: number;
      expired: number;
      revoked: number;
      totalUseCount: number;
    }>(sql, [now, now, tenantId, userId]);

    return {
      total: result?.total ?? 0,
      active: result?.active ?? 0,
      expired: result?.expired ?? 0,
      revoked: result?.revoked ?? 0,
      totalUseCount: result?.totalUseCount ?? 0,
    };
  }

  /**
   * Convert database row to DeviceSecret entity
   */
  private rowToEntity(row: DeviceSecretRow): DeviceSecret {
    return {
      id: row.id,
      installation_id: row.installation_id ?? row.id,
      tenant_id: row.tenant_id,
      client_id: row.client_id ?? undefined,
      trust_group_id: row.trust_group_id ?? undefined,
      source_installation_id: row.source_installation_id ?? undefined,
      source_client_id: row.source_client_id ?? undefined,
      user_id: row.user_id,
      session_id: row.session_id,
      secret_hash: row.secret_hash,
      device_name: row.device_name ?? undefined,
      device_platform: row.device_platform as DeviceSecret['device_platform'],
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at ?? undefined,
      use_count: row.use_count,
      revoked_at: row.revoked_at ?? undefined,
      revoke_reason: row.revoke_reason ?? undefined,
      is_active: row.is_active,
    };
  }
}
