/**
 * RefreshTokenRotator Durable Object (V2)
 *
 * Manages atomic refresh token rotation with version-based theft detection.
 * Each Token Family tracks a single refresh token chain per user.
 *
 * V2 Architecture:
 * - Version-based theft detection (not token string comparison)
 * - Minimal state: version, last_jti, last_used_at, expires_at, user_id, client_id, allowed_scope
 * - JWT contains rtv (Refresh Token Version) claim for validation
 * - Granular storage with prefix-based keys
 *
 * Security Features:
 * - Atomic rotation (DO guarantees single-threaded execution)
 * - Version mismatch → theft detection → family revocation
 * - Scope amplification prevention (allowed_scope check)
 * - Tenant boundary enforcement (user_id validation)
 *
 * OAuth 2.0 Security Best Current Practice (BCP) Compliance:
 * - Token Rotation: Refresh tokens are rotated on every use
 * - Theft Detection: Old version reuse triggers family revocation
 * - Audit Trail: Critical events logged synchronously
 *
 * Reference:
 * - OAuth 2.0 Security BCP: Draft 16, Section 4.13.2
 * - RFC 6749: Section 10.4 (Refresh Token Protection)
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { createAuditLog } from '../utils/audit-log';
import { readRequestJsonWithLimit } from '../utils/body-limits';
import { createLogger, type Logger } from '../utils/logger';
import { isValidTenantIdentifier } from '../utils/tenant-request-policy';

const MAX_ROTATOR_JSON_BODY_BYTES = 512 * 1024;
const MAX_FAMILY_CACHE_ENTRIES = 1024;

/**
 * How the user authenticated for the grant that began a token family, so a refresh issues tokens
 * that say the same as the first ones (OIDC Core 12.2) and keeps to the assurance the grant met.
 */
export interface RefreshTokenAuthContext {
  /** The original authentication time (seconds). */
  auth_time?: number;
  /** The acr and amr the grant's ID token carried. */
  acr?: string;
  amr?: string[];
  /**
   * With assurance on when the grant was made, for access tokens: the authentication time, the AAL
   * reached, its acr and the methods proven (apart from the ID token's, which a claims request may
   * have left out).
   */
  assurance_auth_time?: number;
  aal?: string;
  assurance_acr?: string;
  assurance_amr?: string[];
  /** The grant's authorization request was pushed with a signed request object (FAL3). */
  pushed_signed_request?: true;
}

const AUTH_CONTEXT_STRING_MAX = 512;
const AUTH_CONTEXT_LIST_MAX = 16;

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= AUTH_CONTEXT_STRING_MAX
    ? value
    : undefined;
}

function boundedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > AUTH_CONTEXT_LIST_MAX) return undefined;
  const list = value.filter((item): item is string => boundedString(item) !== undefined);
  return list.length === value.length ? list : undefined;
}

/** The authentication context as stored: only well-formed, bounded fields are kept. */
export function normalizeRefreshTokenAuthContext(
  value: unknown
): RefreshTokenAuthContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const positiveTime = (time: unknown): number | undefined =>
    typeof time === 'number' && Number.isSafeInteger(time) && time > 0 ? time : undefined;
  const authTime = positiveTime(input.auth_time);
  const assuranceAuthTime = positiveTime(input.assurance_auth_time);
  const context: RefreshTokenAuthContext = {
    ...(authTime !== undefined ? { auth_time: authTime } : {}),
    ...(boundedString(input.acr) ? { acr: input.acr as string } : {}),
    ...(boundedStringList(input.amr) ? { amr: boundedStringList(input.amr) } : {}),
    ...(assuranceAuthTime !== undefined ? { assurance_auth_time: assuranceAuthTime } : {}),
    ...(boundedString(input.aal) ? { aal: input.aal as string } : {}),
    ...(boundedString(input.assurance_acr) ? { assurance_acr: input.assurance_acr as string } : {}),
    ...(boundedStringList(input.assurance_amr)
      ? { assurance_amr: boundedStringList(input.assurance_amr) }
      : {}),
    ...(input.pushed_signed_request === true ? { pushed_signed_request: true as const } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * Token Family V2 - Minimal state for high-performance rotation
 */
export interface TokenFamilyV2 {
  tenant_id: string; // Tenant boundary for runtime validation
  version: number; // Rotation version (monotonically increasing)
  last_jti: string; // Last issued JWT ID
  last_used_at: number; // Timestamp of last use (ms)
  expires_at: number; // When the family expires (ms): moved on by a sliding rotation
  created_at?: number; // When the family was first issued (ms): the start of the absolute lifetime
  first_jti?: string; // The JWT ID the family was issued with: its row in the relational family index
  user_id: string; // For tenant boundary enforcement
  client_id: string; // For scope validation
  allowed_scope: string; // Prevent scope amplification
  resource_aud?: string | string[]; // Original access token resource audience
  auth_context?: RefreshTokenAuthContext; // How the user authenticated for the first grant
}

/**
 * Create family request (V2)
 */
export interface CreateFamilyRequestV2 {
  jti: string; // Initial JWT ID
  userId: string;
  clientId: string;
  scope: string;
  ttl: number; // Time to live in seconds
  tenantId: string;
  resourceAudience?: string | string[];
  authContext?: RefreshTokenAuthContext;
}

/**
 * Create family request (V3) - Sharding support
 * Extends V2 with generation and shard information for distributed routing.
 */
export interface CreateFamilyRequestV3 extends CreateFamilyRequestV2 {
  generation: number; // Shard generation (1+)
  shardIndex: number; // Shard index (0 to shardCount-1)
}

/**
 * Rotate token request (V2)
 */
export interface RotateTokenRequestV2 {
  incomingVersion: number; // Version from incoming JWT's rtv claim
  incomingJti: string; // JTI from incoming JWT
  userId: string; // From JWT sub claim
  clientId: string; // From JWT aud/client_id claim
  tenantId: string;
  requestedScope?: string; // Requested scope (must be subset of allowed_scope)
  lifetime?: RefreshTokenLifetimePolicy; // The tenant's lifetime model at this rotation
}

/**
 * How long a refresh token family lives, as the tenant (or app) sets it at a rotation:
 * - `ttl`: seconds a refresh token lasts once issued;
 * - `sliding`: each rotation moves the expiry on by `ttl` (an unused family still expires);
 * - `absoluteTtl`: seconds from the first issuance after which the family ends whatever its
 *   use, or null for no absolute limit.
 * A family recorded before created_at existed keeps its expiry (it never slides).
 */
export interface RefreshTokenLifetimePolicy {
  ttl: number;
  sliding: boolean;
  absoluteTtl: number | null;
}

/**
 * Rotate token response (V2)
 */
export interface RotateTokenResponseV2 {
  newVersion: number; // New version for the rotated token
  newJti: string; // New JWT ID for the rotated token
  expiresIn: number; // Seconds until expiration
  expiresAt: number; // When the family now expires (ms)
  familyJti?: string; // The family's first JWT ID (its index row), when the family recorded it
  allowedScope: string; // Scope to include in new token
  resourceAudience?: string | string[]; // Original access token resource audience
}

/**
 * Audit log entry
 */
interface AuditLogEntry {
  action: 'created' | 'rotated' | 'theft_detected' | 'family_revoked' | 'expired';
  familyKey: string;
  userId?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Storage key prefixes
 */
const STORAGE_PREFIX = {
  FAMILY: 'f:', // f:{userId} → TokenFamilyV2
  META: 'm:', // m:migrated → boolean, m:generation → number, m:shardIndex → number
} as const;

function normalizeResourceAudience(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
  ) {
    const normalized = value.map((item) => item.trim());
    return normalized.length === 1 ? normalized[0] : normalized;
  }

  return undefined;
}

/**
 * A family's expiry after a rotation under a lifetime policy: moved on by `ttl` when sliding,
 * never past the absolute limit (from created_at). A family without created_at (recorded before
 * the lifetime model) keeps its expiry.
 */
/** A lifetime policy sent over HTTP, or undefined when it is missing or not well formed. */
function refreshTokenLifetimePolicy(value: unknown): RefreshTokenLifetimePolicy | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { ttl, sliding, absoluteTtl } = value as Record<string, unknown>;
  const positive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!positive(ttl) || typeof sliding !== 'boolean') return undefined;
  if (absoluteTtl !== null && !positive(absoluteTtl)) return undefined;
  return { ttl, sliding, absoluteTtl };
}

export function rotatedExpiry(
  family: Pick<TokenFamilyV2, 'expires_at' | 'created_at'>,
  lifetime: RefreshTokenLifetimePolicy | undefined,
  now: number
): number {
  if (!lifetime || family.created_at === undefined) return family.expires_at;
  const cap =
    lifetime.absoluteTtl === null ? Infinity : family.created_at + lifetime.absoluteTtl * 1000;
  const next = lifetime.sliding ? now + lifetime.ttl * 1000 : family.expires_at;
  return Math.min(next, cap);
}

/**
 * RefreshTokenRotator Durable Object (V2)
 *
 * Sharded by client_id for horizontal scaling.
 * Each DO instance manages all token families for a single client.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., createFamilyRpc, rotateRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 */
export class RefreshTokenRotator extends DurableObject<Env> {
  private families: Map<string, TokenFamilyV2> = new Map(); // Bounded hot cache: userId -> family
  private initialized: boolean = false;
  private readonly log: Logger = createLogger().module('RefreshTokenRotator');

  // Sharding metadata (set on first createFamily call with V3 request)
  private generation: number | null = null;
  private shardIndex: number | null = null;
  private tenantId: string | null = null;

  // Async audit log buffering (non-critical events)
  private pendingAuditLogs: AuditLogEntry[] = [];
  private flushScheduled: boolean = false;
  private readonly AUDIT_FLUSH_DELAY = 100; // ms

  // Configuration
  private readonly DEFAULT_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Block all requests until initialization completes
    // This ensures the DO is in a consistent state before processing any requests
    // Critical for token theft detection and version validation
    ctx.blockConcurrencyWhile(async () => {
      await this.initializeStateBlocking();
    });
  }

  /**
   * Initialize state from Durable Storage
   * Called by blockConcurrencyWhile() in constructor
   */
  private async initializeStateBlocking(): Promise<void> {
    try {
      // Family state is loaded lazily by user. Cold start cost must not grow with the shard size.
      const [storedGeneration, storedShardIndex, storedTenantId] = await Promise.all([
        this.ctx.storage.get<number>(`${STORAGE_PREFIX.META}generation`),
        this.ctx.storage.get<number>(`${STORAGE_PREFIX.META}shardIndex`),
        this.ctx.storage.get<string>(`${STORAGE_PREFIX.META}tenantId`),
      ]);
      if ((storedGeneration === undefined) !== (storedShardIndex === undefined)) {
        throw new Error('refresh_token_rotator_metadata_incomplete');
      }
      if (
        (storedGeneration !== undefined &&
          (!Number.isSafeInteger(storedGeneration) || storedGeneration < 1)) ||
        (storedShardIndex !== undefined &&
          (!Number.isSafeInteger(storedShardIndex) || storedShardIndex < 0))
      ) {
        throw new Error('refresh_token_rotator_metadata_invalid');
      }
      if (storedGeneration !== undefined) {
        this.generation = storedGeneration;
      }
      if (storedShardIndex !== undefined) {
        this.shardIndex = storedShardIndex;
      }
      if (storedTenantId !== undefined && !isValidTenantIdentifier(storedTenantId)) {
        throw new Error('refresh_token_rotator_tenant_metadata_invalid');
      }
      if (storedTenantId) {
        this.tenantId = storedTenantId;
      }

      this.log.info('Loaded rotator metadata from Durable Storage', {
        generation: this.generation,
        shardIndex: this.shardIndex,
        tenantId: this.tenantId ?? undefined,
      });
    } catch (error) {
      this.log.error('Failed to initialize', {}, error as Error);
      throw error;
    }

    this.initialized = true;
  }

  // ==========================================
  // RPC Methods (public, with 'Rpc' suffix)
  // ==========================================

  /**
   * RPC: Create new token family
   */
  async createFamilyRpc(request: CreateFamilyRequestV2 | CreateFamilyRequestV3): Promise<{
    version: number;
    newJti: string;
    expiresIn: number;
    allowedScope: string;
  }> {
    return this.createFamily(request);
  }

  /**
   * RPC: Rotate refresh token
   * SECURITY CRITICAL: Handles token theft detection
   */
  async rotateRpc(request: RotateTokenRequestV2): Promise<RotateTokenResponseV2> {
    return this.rotate(request);
  }

  /**
   * RPC: Revoke token family
   */
  async revokeFamilyRpc(userId: string, reason?: string): Promise<void> {
    return this.revokeFamily(userId, reason);
  }

  /**
   * RPC: Get family info
   */
  async getFamilyRpc(userId: string): Promise<TokenFamilyV2 | null> {
    return this.getFamily(userId);
  }

  /**
   * RPC: Revoke by JTI (RFC 7009)
   */
  async revokeByJtiRpc(jti: string, reason?: string): Promise<boolean> {
    return this.revokeByJti(jti, reason);
  }

  /**
   * RPC: Batch revoke multiple tokens
   */
  async batchRevokeRpc(
    jtis: string[],
    reason?: string
  ): Promise<{ revoked: number; notFound: number }> {
    return this.batchRevoke(jtis, reason);
  }

  /**
   * RPC: Validate token without rotation
   */
  async validateRpc(
    userId: string,
    version: number,
    clientId: string,
    jti?: string
  ): Promise<{ valid: boolean; family?: TokenFamilyV2 }> {
    return this.validate(userId, version, clientId, jti);
  }

  /**
   * RPC: Get status/health check
   */
  async getStatusRpc(): Promise<{
    status: string;
    version: string;
    families: { total: number; active: number };
    timestamp: number;
  }> {
    await this.initializeState();
    const now = Date.now();
    const storedFamilies = await this.listStoredFamilies();
    let activeFamilies = 0;

    for (const [key, family] of storedFamilies.entries()) {
      this.validateStoredFamily(key.substring(STORAGE_PREFIX.FAMILY.length), family);
      if (family.expires_at > now) {
        activeFamilies++;
      }
    }

    return {
      status: 'ok',
      version: 'v2',
      families: {
        total: storedFamilies.size,
        active: activeFamilies,
      },
      timestamp: now,
    };
  }

  // ==========================================
  // Internal Methods
  // ==========================================

  /**
   * Ensure state is initialized
   * Called by public methods for backward compatibility
   *
   * Note: With blockConcurrencyWhile() in constructor, this is now a no-op guard.
   * The actual initialization happens in initializeStateBlocking() during construction.
   */
  private async initializeState(): Promise<void> {
    // Guard - initialization already completed by blockConcurrencyWhile()
    if (this.initialized) {
      return;
    }

    // This should not happen with blockConcurrencyWhile(), but as a safety fallback:
    this.log.warn('initializeState called but not initialized - this should not happen');
    await this.initializeStateBlocking();
  }

  /**
   * Build family key from userId
   */
  private buildFamilyKey(userId: string): string {
    return `${STORAGE_PREFIX.FAMILY}${userId}`;
  }

  private cacheFamily(userId: string, family: TokenFamilyV2): void {
    this.families.delete(userId);
    this.families.set(userId, family);
    while (this.families.size > MAX_FAMILY_CACHE_ENTRIES) {
      const oldestUserId = this.families.keys().next().value as string | undefined;
      if (!oldestUserId) break;
      this.families.delete(oldestUserId);
    }
  }

  private validateStoredFamily(userId: string, family: TokenFamilyV2): void {
    if (
      !family ||
      this.tenantId === null ||
      family.user_id !== userId ||
      !family.tenant_id ||
      family.tenant_id !== this.tenantId ||
      !family.client_id ||
      !Number.isSafeInteger(family.version) ||
      family.version < 1 ||
      !family.last_jti ||
      !Number.isFinite(family.expires_at) ||
      (family.created_at !== undefined && !Number.isFinite(family.created_at)) ||
      (family.first_jti !== undefined &&
        (typeof family.first_jti !== 'string' || !family.first_jti))
    ) {
      throw new Error('refresh_token_family_storage_invalid');
    }
  }

  private async loadFamily(userId: string): Promise<TokenFamilyV2 | null> {
    const cached = this.families.get(userId);
    if (cached) {
      this.validateStoredFamily(userId, cached);
      this.cacheFamily(userId, cached);
      return cached;
    }
    const stored = await this.ctx.storage.get<TokenFamilyV2>(this.buildFamilyKey(userId));
    if (!stored) return null;
    this.validateStoredFamily(userId, stored);
    this.cacheFamily(userId, stored);
    return stored;
  }

  private async listStoredFamilies(): Promise<Map<string, TokenFamilyV2>> {
    return this.ctx.storage.list<TokenFamilyV2>({ prefix: STORAGE_PREFIX.FAMILY });
  }

  /**
   * Save family to storage
   */
  private async saveFamily(userId: string, family: TokenFamilyV2): Promise<void> {
    const key = this.buildFamilyKey(userId);
    await this.ctx.storage.put(key, family);
    this.cacheFamily(userId, family);
  }

  /**
   * Delete family from storage
   */
  private async deleteFamily(userId: string): Promise<void> {
    const key = this.buildFamilyKey(userId);
    await this.ctx.storage.delete(key);
    this.families.delete(userId);
  }

  /**
   * Generate unique JWT ID
   *
   * If generation and shardIndex are set, generates full JTI format:
   * v{generation}_{shardIndex}_{randomPart}
   *
   * Otherwise, generates legacy format: rt_{uuid}
   */
  private generateJti(): string {
    const randomPart = `rt_${crypto.randomUUID()}`;

    // Use full JTI format if sharding metadata is available
    if (this.generation !== null && this.shardIndex !== null) {
      return `v${this.generation}_${this.shardIndex}_${randomPart}`;
    }

    // Legacy format for backward compatibility
    return randomPart;
  }

  private async setTenantId(tenantId: string): Promise<void> {
    const normalized = tenantId.trim();
    if (!isValidTenantIdentifier(normalized)) {
      throw new Error('invalid_request: tenantId is required');
    }

    if (this.tenantId && this.tenantId !== normalized) {
      throw new Error('invalid_request: Tenant mismatch');
    }

    if (!this.tenantId) {
      await this.ctx.storage.put(`${STORAGE_PREFIX.META}tenantId`, normalized);
      this.tenantId = normalized;
    }
  }

  private getTenantIdForAudit(action: string): string | null {
    if (!this.tenantId) {
      this.log.error('Cannot create refresh token audit log: tenant context is missing', {
        action,
      });
      return null;
    }
    return this.tenantId;
  }

  /**
   * Create new token family (V2/V3)
   *
   * Called when issuing the first refresh token for a user-client pair.
   * Returns response consistent with rotate for easier client implementation.
   *
   * V3 extension: If generation and shardIndex are provided, stores them
   * for use in generateJti() to create properly formatted JTIs.
   */
  async createFamily(request: CreateFamilyRequestV2 | CreateFamilyRequestV3): Promise<{
    version: number;
    newJti: string;
    expiresIn: number;
    allowedScope: string;
  }> {
    await this.initializeState();
    if (
      !request.jti.trim() ||
      !request.userId.trim() ||
      !request.clientId.trim() ||
      !Number.isSafeInteger(request.ttl) ||
      request.ttl < 1
    ) {
      throw new Error('invalid_request: Invalid refresh token family input');
    }
    const normalizedTenantId = request.tenantId.trim();
    if (!isValidTenantIdentifier(normalizedTenantId)) {
      throw new Error('invalid_request: tenantId is required');
    }
    if (this.tenantId && this.tenantId !== normalizedTenantId) {
      throw new Error('invalid_request: Tenant mismatch');
    }

    // Validate sharding metadata before composing the first atomic write.
    const v3Request = request as CreateFamilyRequestV3;
    if ((v3Request.generation === undefined) !== (v3Request.shardIndex === undefined)) {
      throw new Error('invalid_request: Incomplete refresh token shard metadata');
    }
    if (v3Request.generation !== undefined && v3Request.shardIndex !== undefined) {
      if (
        !Number.isSafeInteger(v3Request.generation) ||
        v3Request.generation < 1 ||
        !Number.isSafeInteger(v3Request.shardIndex) ||
        v3Request.shardIndex < 0
      ) {
        throw new Error('invalid_request: Invalid refresh token shard metadata');
      }
      if (
        this.generation !== null &&
        this.shardIndex !== null &&
        (this.generation !== v3Request.generation || this.shardIndex !== v3Request.shardIndex)
      ) {
        throw new Error('invalid_request: Refresh token shard metadata mismatch');
      }
    }

    const now = Date.now();
    const expiresAt = now + request.ttl * 1000;
    const resourceAudience = normalizeResourceAudience(request.resourceAudience);
    const authContext = normalizeRefreshTokenAuthContext(request.authContext);
    const family: TokenFamilyV2 = {
      tenant_id: normalizedTenantId,
      version: 1,
      last_jti: request.jti,
      last_used_at: now,
      expires_at: expiresAt,
      created_at: now,
      first_jti: request.jti,
      user_id: request.userId,
      client_id: request.clientId,
      allowed_scope: request.scope,
      ...(resourceAudience && { resource_aud: resourceAudience }),
      ...(authContext && { auth_context: authContext }),
    };

    const writes: Record<string, unknown> = {
      [this.buildFamilyKey(request.userId)]: family,
    };
    if (!this.tenantId) {
      writes[`${STORAGE_PREFIX.META}tenantId`] = normalizedTenantId;
    }
    if (
      this.generation === null &&
      this.shardIndex === null &&
      v3Request.generation !== undefined &&
      v3Request.shardIndex !== undefined
    ) {
      writes[`${STORAGE_PREFIX.META}generation`] = v3Request.generation;
      writes[`${STORAGE_PREFIX.META}shardIndex`] = v3Request.shardIndex;
    }

    // The first family and its routing metadata become durable together.
    await this.ctx.storage.put(writes);
    this.tenantId = normalizedTenantId;
    if (v3Request.generation !== undefined && v3Request.shardIndex !== undefined) {
      this.generation = v3Request.generation;
      this.shardIndex = v3Request.shardIndex;
    }
    this.cacheFamily(request.userId, family);

    // Audit log (non-critical, fire-and-forget - no await needed)
    void this.logToD1({
      action: 'created',
      familyKey: request.userId,
      userId: request.userId,
      clientId: request.clientId,
      metadata: {
        scope: request.scope,
        resourceAudience: family.resource_aud,
        generation: this.generation,
        shardIndex: this.shardIndex,
      },
      timestamp: now,
    });

    // Response format consistent with rotate endpoint
    return {
      version: family.version,
      newJti: family.last_jti,
      expiresIn: request.ttl,
      allowedScope: family.allowed_scope,
      ...(family.resource_aud && { resourceAudience: family.resource_aud }),
    };
  }

  /**
   * Rotate refresh token (V2)
   *
   * Validates incoming token version and issues new token with incremented version.
   * Detects theft if incoming version < current version.
   */
  async rotate(request: RotateTokenRequestV2): Promise<RotateTokenResponseV2> {
    await this.initializeState();
    await this.setTenantId(request.tenantId);

    const family = await this.loadFamily(request.userId);

    // Family not found
    if (!family) {
      throw new Error('invalid_grant: Token family not found');
    }

    if (family.tenant_id !== request.tenantId) {
      throw new Error('invalid_request: Tenant mismatch');
    }

    // Validate client_id matches
    if (family.client_id !== request.clientId) {
      throw new Error('invalid_grant: Client ID mismatch');
    }

    // Check expiration
    const now = Date.now();
    if (family.expires_at <= now) {
      // Cleanup expired family
      await this.deleteFamily(request.userId);

      await this.logToD1({
        action: 'expired',
        familyKey: request.userId,
        userId: request.userId,
        timestamp: now,
      });

      throw new Error('invalid_grant: Refresh token expired');
    }

    // CRITICAL: Version mismatch detection (theft detection)
    if (request.incomingVersion < family.version) {
      // Token replay detected - incoming token has old version
      this.log.error('SECURITY: Token theft detected', {
        userId: request.userId,
        clientId: request.clientId,
        incomingVersion: request.incomingVersion,
        currentVersion: family.version,
      });

      // Revoke entire family
      await this.deleteFamily(request.userId);

      // CRITICAL: Log synchronously for audit trail
      await this.logCritical({
        action: 'theft_detected',
        familyKey: request.userId,
        userId: request.userId,
        clientId: request.clientId,
        metadata: {
          incomingVersion: request.incomingVersion,
          currentVersion: family.version,
          incomingJti: request.incomingJti,
        },
        timestamp: now,
      });

      throw new Error('invalid_grant: Token theft detected. Family revoked.');
    }

    // Version must match exactly (not just >=)
    if (request.incomingVersion !== family.version) {
      throw new Error('invalid_grant: Version mismatch');
    }

    // JTI must match (additional security check)
    if (request.incomingJti !== family.last_jti) {
      // JTI mismatch could indicate token tampering or theft
      this.log.error('SECURITY: JTI mismatch detected', {
        userId: request.userId,
        clientId: request.clientId,
        incomingJti: request.incomingJti,
        expectedJti: family.last_jti,
      });

      // Revoke entire family as precaution
      await this.deleteFamily(request.userId);

      // CRITICAL: Log synchronously for audit trail
      await this.logCritical({
        action: 'theft_detected',
        familyKey: request.userId,
        userId: request.userId,
        clientId: request.clientId,
        metadata: {
          reason: 'jti_mismatch',
          incomingJti: request.incomingJti,
          expectedJti: family.last_jti,
        },
        timestamp: now,
      });

      throw new Error('invalid_grant: Token theft detected (JTI mismatch). Family revoked.');
    }

    // Scope amplification check
    if (request.requestedScope) {
      const allowedScopes = new Set(family.allowed_scope.split(' '));
      const requestedScopes = request.requestedScope.split(' ');
      for (const scope of requestedScopes) {
        if (!allowedScopes.has(scope)) {
          // SECURITY: Do not expose scope name in error to prevent scope enumeration
          throw new Error('invalid_scope: Requested scope is not allowed');
        }
      }
    }

    // Rotate: increment version and generate new JTI
    const newVersion = family.version + 1;
    const newJti = this.generateJti();

    const updatedFamily: TokenFamilyV2 = {
      ...family,
      version: newVersion,
      last_jti: newJti,
      last_used_at: now,
      expires_at: rotatedExpiry(family, request.lifetime, now),
    };
    // An absolute limit enabled since the family was issued may already have passed.
    if (updatedFamily.expires_at <= now) {
      await this.deleteFamily(request.userId);
      throw new Error('invalid_grant: Refresh token expired');
    }

    // Keep the prior cached family authoritative if the durable write fails.
    await this.saveFamily(request.userId, updatedFamily);

    // Audit log (non-critical, fire-and-forget - no await needed)
    void this.logToD1({
      action: 'rotated',
      familyKey: request.userId,
      userId: request.userId,
      clientId: request.clientId,
      metadata: { version: newVersion },
      timestamp: now,
    });

    return {
      newVersion,
      newJti,
      expiresIn: Math.floor((updatedFamily.expires_at - now) / 1000),
      expiresAt: updatedFamily.expires_at,
      ...(updatedFamily.first_jti && { familyJti: updatedFamily.first_jti }),
      allowedScope: request.requestedScope || updatedFamily.allowed_scope,
      ...(updatedFamily.resource_aud && { resourceAudience: updatedFamily.resource_aud }),
    };
  }

  /**
   * Revoke token family
   */
  async revokeFamily(userId: string, reason?: string): Promise<void> {
    await this.initializeState();

    const family = await this.loadFamily(userId);
    if (!family) {
      return; // Already revoked or doesn't exist
    }

    await this.deleteFamily(userId);

    // CRITICAL: Log synchronously
    await this.logCritical({
      action: 'family_revoked',
      familyKey: userId,
      userId,
      clientId: family.client_id,
      metadata: { reason: reason || 'manual_revocation' },
      timestamp: Date.now(),
    });
  }

  /**
   * Get family info (for validation/debugging)
   */
  async getFamily(userId: string): Promise<TokenFamilyV2 | null> {
    await this.initializeState();
    return this.loadFamily(userId);
  }

  /**
   * Revoke a single token by JTI
   * Used for RFC 7009 Token Revocation
   */
  async revokeByJti(jti: string, reason?: string): Promise<boolean> {
    await this.initializeState();

    // JTI-only revocation is uncommon and cannot derive the user key from legacy state.
    const storedFamilies = await this.listStoredFamilies();
    for (const [key, family] of storedFamilies.entries()) {
      if (family.last_jti === jti) {
        const userId = key.substring(STORAGE_PREFIX.FAMILY.length);
        this.validateStoredFamily(userId, family);
        // Revoke the entire family (as per OAuth best practice)
        await this.deleteFamily(userId);

        await this.logCritical({
          action: 'family_revoked',
          familyKey: userId,
          userId,
          clientId: family.client_id,
          metadata: { reason: reason || 'token_revocation', jti },
          timestamp: Date.now(),
        });

        return true;
      }
    }

    return false; // JTI not found (may already be revoked or expired)
  }

  /**
   * Batch revoke multiple token families
   * Used for user-wide token revocation
   *
   * @param jtis - List of JTIs to revoke
   * @param reason - Revocation reason
   * @returns Number of families revoked
   */
  async batchRevoke(
    jtis: string[],
    reason?: string
  ): Promise<{ revoked: number; notFound: number }> {
    await this.initializeState();

    const now = Date.now();
    let revoked = 0;
    let notFound = 0;

    // Build JTI to userId mapping for efficient lookup
    const storedFamilies = await this.listStoredFamilies();
    const jtiToUserMap = new Map<string, string>();
    for (const [key, family] of storedFamilies.entries()) {
      const userId = key.substring(STORAGE_PREFIX.FAMILY.length);
      this.validateStoredFamily(userId, family);
      jtiToUserMap.set(family.last_jti, userId);
      // The family index names a family by the JWT ID it was issued with.
      if (family.first_jti) jtiToUserMap.set(family.first_jti, userId);
    }

    // Revoke each JTI
    for (const jti of jtis) {
      const userId = jtiToUserMap.get(jti);
      if (userId) {
        const family = storedFamilies.get(this.buildFamilyKey(userId));
        if (family) {
          await this.deleteFamily(userId);

          // Audit log (non-blocking for batch operations)
          void this.logToD1({
            action: 'family_revoked',
            familyKey: userId,
            userId,
            clientId: family.client_id,
            metadata: { reason: reason || 'batch_revocation', jti },
            timestamp: now,
          });

          revoked++;
        }
      } else {
        notFound++;
      }
    }

    return { revoked, notFound };
  }

  /**
   * Validate token without rotation (for introspection)
   */
  async validate(
    userId: string,
    version: number,
    clientId: string,
    /**
     * The presented token's JWT ID: when given, only the family's latest token is valid. A family
     * made again for the same user and client starts at version 1 too, so the version alone does
     * not tell an older family's token from the current one's.
     */
    jti?: string
  ): Promise<{ valid: boolean; family?: TokenFamilyV2 }> {
    await this.initializeState();

    const family = await this.loadFamily(userId);
    if (!family) {
      return { valid: false };
    }

    // Check expiration
    if (family.expires_at <= Date.now()) {
      return { valid: false };
    }

    // Check version and client
    if (family.version !== version || family.client_id !== clientId) {
      return { valid: false };
    }
    if (jti !== undefined && family.last_jti !== jti) {
      return { valid: false };
    }

    return { valid: true, family };
  }

  /**
   * Log non-critical events (batched, async)
   */
  private async logToD1(entry: AuditLogEntry): Promise<void> {
    this.pendingAuditLogs.push(entry);
    this.scheduleAuditFlush();
  }

  /**
   * Log critical events synchronously (theft_detected, family_revoked)
   */
  private async logCritical(entry: AuditLogEntry): Promise<void> {
    const tenantId = this.getTenantIdForAudit(`refresh_token.${entry.action}`);
    if (!tenantId) {
      return;
    }
    await createAuditLog(this.env, {
      tenantId,
      userId: entry.userId ?? 'system',
      action: `refresh_token.${entry.action}`,
      resource: 'refresh_token_family',
      resourceId: entry.familyKey,
      ipAddress: 'system',
      userAgent: 'RefreshTokenRotator',
      metadata: JSON.stringify(entry.metadata ?? {}),
      severity: 'warning',
    });
  }

  /**
   * Schedule batch flush of audit logs
   */
  private scheduleAuditFlush(): void {
    if (this.flushScheduled) {
      return;
    }

    this.flushScheduled = true;
    this.ctx.waitUntil(
      new Promise<void>((resolve) => {
        setTimeout(resolve, this.AUDIT_FLUSH_DELAY);
      }).then(() => this.flushAuditLogs())
    );
  }

  /**
   * Flush pending audit logs to D1
   */
  private async flushAuditLogs(): Promise<void> {
    this.flushScheduled = false;

    if (this.pendingAuditLogs.length === 0) {
      return;
    }

    const logsToFlush = [...this.pendingAuditLogs];
    this.pendingAuditLogs = [];

    try {
      await Promise.all(
        logsToFlush.map((entry) => {
          const action = `refresh_token.${entry.action}`;
          const tenantId = this.getTenantIdForAudit(action);
          if (!tenantId) {
            return Promise.resolve();
          }
          return createAuditLog(this.env, {
            tenantId,
            userId: entry.userId ?? 'system',
            action,
            resource: 'refresh_token_family',
            resourceId: entry.familyKey,
            ipAddress: 'system',
            userAgent: 'RefreshTokenRotator',
            metadata: JSON.stringify(entry.metadata ?? {}),
            severity: 'info',
          });
        })
      );
    } catch (error) {
      this.log.error('Failed to flush audit logs', {}, error as Error);
      // Re-queue (limited to prevent memory leak)
      if (this.pendingAuditLogs.length < 100) {
        this.pendingAuditLogs.push(...logsToFlush);
        this.scheduleAuditFlush();
      }
    }
  }

  /**
   * Handle HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    await this.initializeState();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /family - Create new token family (V2/V3)
      if (path === '/family' && request.method === 'POST') {
        let body: Partial<CreateFamilyRequestV3>;
        try {
          body = await readRequestJsonWithLimit<Partial<CreateFamilyRequestV3>>(
            request,
            MAX_ROTATOR_JSON_BODY_BYTES
          );
        } catch {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Invalid JSON body',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (!body.jti || !body.userId || !body.clientId || !body.scope || !body.tenantId) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields: jti, userId, clientId, scope, tenantId',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Build request (V3 fields are optional)
        const createRequest: CreateFamilyRequestV2 | CreateFamilyRequestV3 = {
          jti: body.jti,
          userId: body.userId,
          clientId: body.clientId,
          scope: body.scope,
          ttl: body.ttl || this.DEFAULT_TTL,
          tenantId: body.tenantId,
          ...(body.resourceAudience !== undefined && {
            resourceAudience: body.resourceAudience,
          }),
          ...(body.authContext !== undefined && { authContext: body.authContext }),
          ...(body.generation !== undefined &&
            body.shardIndex !== undefined && {
              generation: body.generation,
              shardIndex: body.shardIndex,
            }),
        };

        const result = await this.createFamily(createRequest);

        return new Response(JSON.stringify(result), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /rotate - Rotate refresh token (V2)
      if (path === '/rotate' && request.method === 'POST') {
        const body = await readRequestJsonWithLimit<Partial<RotateTokenRequestV2>>(
          request,
          MAX_ROTATOR_JSON_BODY_BYTES
        );

        if (
          body.incomingVersion === undefined ||
          !body.incomingJti ||
          !body.userId ||
          !body.clientId ||
          !body.tenantId
        ) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description:
                'Missing required fields: incomingVersion, incomingJti, userId, clientId, tenantId',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        try {
          const result = await this.rotate({
            incomingVersion: body.incomingVersion,
            incomingJti: body.incomingJti,
            userId: body.userId,
            clientId: body.clientId,
            tenantId: body.tenantId,
            requestedScope: body.requestedScope,
            lifetime: refreshTokenLifetimePolicy(body.lifetime),
          });

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          this.log.error('rotateToken error', {}, error as Error);
          const message = error instanceof Error ? error.message : '';
          const isTheft = message.includes('theft detected') || message.includes('theft');

          // SECURITY: Use generic error descriptions
          let errorDescription = 'Refresh token is invalid or expired';

          if (isTheft || message.includes('revoked')) {
            errorDescription = 'Refresh token has been revoked';
          } else if (message.includes('version mismatch')) {
            errorDescription = 'Refresh token version mismatch';
          } else if (message.includes('expired')) {
            errorDescription = 'Refresh token has expired';
          }

          return new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: errorDescription,
              ...(isTheft && { action: 'family_revoked' }),
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      // POST /revoke-family - Revoke token family
      if (path === '/revoke-family' && request.method === 'POST') {
        const body = await readRequestJsonWithLimit<{ userId: string; reason?: string }>(
          request,
          MAX_ROTATOR_JSON_BODY_BYTES
        );

        if (!body.userId) {
          return new Response(
            JSON.stringify({ error: 'invalid_request', error_description: 'Missing userId' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        await this.revokeFamily(body.userId, body.reason);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /revoke - Revoke single token by JTI (RFC 7009)
      if (path === '/revoke' && request.method === 'POST') {
        const body = await readRequestJsonWithLimit<{ jti: string; reason?: string }>(
          request,
          MAX_ROTATOR_JSON_BODY_BYTES
        );

        if (!body.jti) {
          return new Response(
            JSON.stringify({ error: 'invalid_request', error_description: 'Missing jti' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const revoked = await this.revokeByJti(body.jti, body.reason);

        return new Response(JSON.stringify({ success: true, revoked }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /batch-revoke - Batch revoke multiple tokens
      if (path === '/batch-revoke' && request.method === 'POST') {
        const body = await readRequestJsonWithLimit<{ jtis: string[]; reason?: string }>(
          request,
          MAX_ROTATOR_JSON_BODY_BYTES
        );

        if (!body.jtis || !Array.isArray(body.jtis)) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing or invalid jtis array',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const result = await this.batchRevoke(body.jtis, body.reason);

        return new Response(JSON.stringify({ success: true, ...result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /validate - Validate token
      if (path === '/validate' && request.method === 'GET') {
        const userId = url.searchParams.get('userId');
        const versionStr = url.searchParams.get('version');
        const clientId = url.searchParams.get('clientId');

        if (!userId || !versionStr || !clientId) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required params: userId, version, clientId',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const version = parseInt(versionStr, 10);
        const jti = url.searchParams.get('jti') ?? undefined;
        const result = await this.validate(userId, version, clientId, jti);

        return new Response(
          JSON.stringify({
            valid: result.valid,
            ...(result.family && {
              version: result.family.version,
              allowedScope: result.family.allowed_scope,
              expiresAt: result.family.expires_at,
            }),
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // GET /family/:userId - Get family info
      if (path.startsWith('/family/') && request.method === 'GET') {
        const userId = path.substring(8);
        const family = await this.getFamily(userId);

        if (!family) {
          return new Response(JSON.stringify({ error: 'Family not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            version: family.version,
            lastUsedAt: family.last_used_at,
            expiresAt: family.expires_at,
            userId: family.user_id,
            clientId: family.client_id,
            allowedScope: family.allowed_scope,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // GET /status - Health check
      if (path === '/status' && request.method === 'GET') {
        return new Response(JSON.stringify(await this.getStatusRpc()), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      // Log full error for debugging but don't expose to client
      this.log.error('Request handling error', {}, error as Error);
      // SECURITY: Do not expose internal error details in response
      return new Response(
        JSON.stringify({
          error: 'server_error',
          error_description: 'Internal server error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
