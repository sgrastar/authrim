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

import type { Env } from '../types/env';
import { retryD1Operation } from '../utils/d1-retry';

/**
 * Token Family V2 - Minimal state for high-performance rotation
 */
export interface TokenFamilyV2 {
  version: number; // Rotation version (monotonically increasing)
  last_jti: string; // Last issued JWT ID
  last_used_at: number; // Timestamp of last use (ms)
  expires_at: number; // Absolute expiration (ms)
  user_id: string; // For tenant boundary enforcement
  client_id: string; // For scope validation
  allowed_scope: string; // Prevent scope amplification
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
  requestedScope?: string; // Requested scope (must be subset of allowed_scope)
}

/**
 * Rotate token response (V2)
 */
export interface RotateTokenResponseV2 {
  newVersion: number; // New version for the rotated token
  newJti: string; // New JWT ID for the rotated token
  expiresIn: number; // Seconds until expiration
  allowedScope: string; // Scope to include in new token
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

/**
 * RefreshTokenRotator Durable Object (V2)
 *
 * Sharded by client_id for horizontal scaling.
 * Each DO instance manages all token families for a single client.
 */
export class RefreshTokenRotator {
  private state: DurableObjectState;
  private env: Env;
  private families: Map<string, TokenFamilyV2> = new Map(); // userId → family
  private initialized: boolean = false;
  private initializePromise: Promise<void> | null = null;

  // Sharding metadata (set on first createFamily call with V3 request)
  private generation: number | null = null;
  private shardIndex: number | null = null;

  // Async audit log buffering (non-critical events)
  private pendingAuditLogs: AuditLogEntry[] = [];
  private flushScheduled: boolean = false;
  private readonly AUDIT_FLUSH_DELAY = 100; // ms

  // Configuration
  private readonly DEFAULT_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize state from Durable Storage
   */
  private async initializeState(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = this.doInitialize();

    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = null;
      throw error;
    }
  }

  /**
   * Actual initialization logic
   */
  private async doInitialize(): Promise<void> {
    try {
      // Load all families from granular storage
      const familyEntries = await this.state.storage.list<TokenFamilyV2>({
        prefix: STORAGE_PREFIX.FAMILY,
      });

      for (const [key, family] of familyEntries) {
        const userId = key.substring(STORAGE_PREFIX.FAMILY.length);
        this.families.set(userId, family);
      }

      // Load sharding metadata
      const storedGeneration = await this.state.storage.get<number>(
        `${STORAGE_PREFIX.META}generation`
      );
      const storedShardIndex = await this.state.storage.get<number>(
        `${STORAGE_PREFIX.META}shardIndex`
      );
      if (storedGeneration !== undefined) {
        this.generation = storedGeneration;
      }
      if (storedShardIndex !== undefined) {
        this.shardIndex = storedShardIndex;
      }

      console.log(
        `RefreshTokenRotator: Loaded ${this.families.size} families, gen=${this.generation}, shard=${this.shardIndex}`
      );
    } catch (error) {
      console.error('RefreshTokenRotator: Failed to initialize:', error);
    }

    this.initialized = true;
  }

  /**
   * Build family key from userId
   */
  private buildFamilyKey(userId: string): string {
    return `${STORAGE_PREFIX.FAMILY}${userId}`;
  }

  /**
   * Save family to storage
   */
  private async saveFamily(userId: string, family: TokenFamilyV2): Promise<void> {
    const key = this.buildFamilyKey(userId);
    await this.state.storage.put(key, family);
  }

  /**
   * Delete family from storage
   */
  private async deleteFamily(userId: string): Promise<void> {
    const key = this.buildFamilyKey(userId);
    await this.state.storage.delete(key);
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

    // V3: Store sharding metadata if provided (first call sets it)
    const v3Request = request as CreateFamilyRequestV3;
    if (v3Request.generation !== undefined && v3Request.shardIndex !== undefined) {
      if (this.generation === null && this.shardIndex === null) {
        this.generation = v3Request.generation;
        this.shardIndex = v3Request.shardIndex;
        // Persist sharding metadata
        await this.state.storage.put(`${STORAGE_PREFIX.META}generation`, this.generation);
        await this.state.storage.put(`${STORAGE_PREFIX.META}shardIndex`, this.shardIndex);
      }
    }

    const now = Date.now();
    const expiresAt = now + request.ttl * 1000;
    const family: TokenFamilyV2 = {
      version: 1,
      last_jti: request.jti,
      last_used_at: now,
      expires_at: expiresAt,
      user_id: request.userId,
      client_id: request.clientId,
      allowed_scope: request.scope,
    };

    // Store in memory and persistent storage
    this.families.set(request.userId, family);
    await this.saveFamily(request.userId, family);

    // Audit log (non-critical, fire-and-forget - no await needed)
    void this.logToD1({
      action: 'created',
      familyKey: request.userId,
      userId: request.userId,
      clientId: request.clientId,
      metadata: { scope: request.scope, generation: this.generation, shardIndex: this.shardIndex },
      timestamp: now,
    });

    // Response format consistent with rotate endpoint
    return {
      version: family.version,
      newJti: family.last_jti,
      expiresIn: request.ttl,
      allowedScope: family.allowed_scope,
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

    const family = this.families.get(request.userId);

    // Family not found
    if (!family) {
      throw new Error('invalid_grant: Token family not found');
    }

    // Validate client_id matches
    if (family.client_id !== request.clientId) {
      throw new Error('invalid_grant: Client ID mismatch');
    }

    // Check expiration
    const now = Date.now();
    if (family.expires_at <= now) {
      // Cleanup expired family
      this.families.delete(request.userId);
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
      console.error('SECURITY: Token theft detected!', {
        userId: request.userId,
        clientId: request.clientId,
        incomingVersion: request.incomingVersion,
        currentVersion: family.version,
      });

      // Revoke entire family
      this.families.delete(request.userId);
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
      console.error('SECURITY: JTI mismatch detected!', {
        userId: request.userId,
        clientId: request.clientId,
        incomingJti: request.incomingJti,
        expectedJti: family.last_jti,
      });

      // Revoke entire family as precaution
      this.families.delete(request.userId);
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
          throw new Error(`invalid_scope: Scope '${scope}' not allowed`);
        }
      }
    }

    // Rotate: increment version and generate new JTI
    const newVersion = family.version + 1;
    const newJti = this.generateJti();

    // Update family
    family.version = newVersion;
    family.last_jti = newJti;
    family.last_used_at = now;

    // Persist
    this.families.set(request.userId, family);
    await this.saveFamily(request.userId, family);

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
      expiresIn: Math.floor((family.expires_at - now) / 1000),
      allowedScope: request.requestedScope || family.allowed_scope,
    };
  }

  /**
   * Revoke token family
   */
  async revokeFamily(userId: string, reason?: string): Promise<void> {
    await this.initializeState();

    const family = this.families.get(userId);
    if (!family) {
      return; // Already revoked or doesn't exist
    }

    // Remove from memory and storage
    this.families.delete(userId);
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
    return this.families.get(userId) || null;
  }

  /**
   * Revoke a single token by JTI
   * Used for RFC 7009 Token Revocation
   */
  async revokeByJti(jti: string, reason?: string): Promise<boolean> {
    await this.initializeState();

    // Find family with matching last_jti
    for (const [userId, family] of this.families.entries()) {
      if (family.last_jti === jti) {
        // Revoke the entire family (as per OAuth best practice)
        this.families.delete(userId);
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
    const jtiToUserMap = new Map<string, string>();
    for (const [userId, family] of this.families.entries()) {
      jtiToUserMap.set(family.last_jti, userId);
    }

    // Revoke each JTI
    for (const jti of jtis) {
      const userId = jtiToUserMap.get(jti);
      if (userId) {
        const family = this.families.get(userId);
        if (family) {
          this.families.delete(userId);
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
    clientId: string
  ): Promise<{ valid: boolean; family?: TokenFamilyV2 }> {
    await this.initializeState();

    const family = this.families.get(userId);
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

    return { valid: true, family };
  }

  /**
   * Log non-critical events (batched, async)
   */
  private async logToD1(entry: AuditLogEntry): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    this.pendingAuditLogs.push(entry);
    this.scheduleAuditFlush();
  }

  /**
   * Log critical events synchronously (theft_detected, family_revoked)
   */
  private async logCritical(entry: AuditLogEntry): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    await retryD1Operation(
      async () => {
        await this.env.DB.prepare(
          `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            `audit_${crypto.randomUUID()}`,
            entry.userId || null,
            `refresh_token.${entry.action}`,
            'refresh_token_family',
            entry.familyKey,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
            Math.floor(entry.timestamp / 1000)
          )
          .run();
      },
      'RefreshTokenRotator.logCritical',
      { maxRetries: 3 }
    );
  }

  /**
   * Schedule batch flush of audit logs
   */
  private scheduleAuditFlush(): void {
    if (this.flushScheduled) {
      return;
    }

    this.flushScheduled = true;
    setTimeout(() => {
      void this.flushAuditLogs();
    }, this.AUDIT_FLUSH_DELAY);
  }

  /**
   * Flush pending audit logs to D1
   */
  private async flushAuditLogs(): Promise<void> {
    this.flushScheduled = false;

    if (this.pendingAuditLogs.length === 0 || !this.env.DB) {
      return;
    }

    const logsToFlush = [...this.pendingAuditLogs];
    this.pendingAuditLogs = [];

    try {
      const statements = logsToFlush.map((entry) =>
        this.env.DB.prepare(
          `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          `audit_${crypto.randomUUID()}`,
          entry.userId || null,
          `refresh_token.${entry.action}`,
          'refresh_token_family',
          entry.familyKey,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          Math.floor(entry.timestamp / 1000)
        )
      );

      await this.env.DB.batch(statements);
    } catch (error) {
      console.error('RefreshTokenRotator: Failed to flush audit logs:', error);
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
          body = (await request.json()) as Partial<CreateFamilyRequestV3>;
        } catch {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Invalid JSON body',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (!body.jti || !body.userId || !body.clientId || !body.scope) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields: jti, userId, clientId, scope',
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
        const body = (await request.json()) as Partial<RotateTokenRequestV2>;

        if (
          body.incomingVersion === undefined ||
          !body.incomingJti ||
          !body.userId ||
          !body.clientId
        ) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description:
                'Missing required fields: incomingVersion, incomingJti, userId, clientId',
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
            requestedScope: body.requestedScope,
          });

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          const isTheft = message.includes('theft detected');

          return new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: message.replace('invalid_grant: ', ''),
              ...(isTheft && { action: 'family_revoked' }),
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      // POST /revoke-family - Revoke token family
      if (path === '/revoke-family' && request.method === 'POST') {
        const body = (await request.json()) as { userId: string; reason?: string };

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
        const body = (await request.json()) as { jti: string; reason?: string };

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
        const body = (await request.json()) as { jtis: string[]; reason?: string };

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
        const result = await this.validate(userId, version, clientId);

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
        const now = Date.now();
        let activeFamilies = 0;

        for (const family of this.families.values()) {
          if (family.expires_at > now) {
            activeFamilies++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            version: 'v2',
            families: {
              total: this.families.size,
              active: activeFamilies,
            },
            timestamp: now,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('RefreshTokenRotator error:', error);
      return new Response(
        JSON.stringify({
          error: 'server_error',
          error_description: error instanceof Error ? error.message : 'Internal Server Error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
