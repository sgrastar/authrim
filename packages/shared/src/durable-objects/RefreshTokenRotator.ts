/**
 * RefreshTokenRotator Durable Object
 *
 * Manages atomic refresh token rotation with token family tracking
 * and theft detection.
 *
 * Security Features:
 * - Atomic rotation (prevents race conditions)
 * - Token family tracking (detect token theft via rotation chain)
 * - Theft detection (revoke all tokens if replay detected)
 * - Audit logging (all rotations logged to D1)
 *
 * OAuth 2.0 Security Best Current Practice (BCP) Compliance:
 * - Token Rotation: Refresh tokens are rotated on every use
 * - Theft Detection: Old token reuse triggers family revocation
 * - Audit Trail: All token operations logged for security analysis
 *
 * Reference:
 * - OAuth 2.0 Security BCP: Draft 16, Section 4.13.2
 * - RFC 6749: Section 10.4 (Refresh Token Protection)
 */

import type { Env } from '../types/env';
import { retryD1Operation } from '../utils/d1-retry';

/**
 * Token family (tracks rotation chain)
 */
export interface TokenFamily {
  id: string; // Family ID
  currentToken: string; // Current valid token
  previousTokens: string[]; // History of rotated tokens
  userId: string;
  clientId: string;
  scope: string;
  rotationCount: number;
  createdAt: number;
  lastRotation: number;
  expiresAt: number;
}

/**
 * Rotate token request
 */
export interface RotateTokenRequest {
  currentToken: string;
  userId: string;
  clientId: string;
}

/**
 * Rotate token response
 */
export interface RotateTokenResponse {
  newToken: string;
  familyId: string;
  expiresIn: number; // Seconds
  rotationCount: number;
}

/**
 * Create family request
 */
export interface CreateFamilyRequest {
  token: string;
  userId: string;
  clientId: string;
  scope: string;
  ttl: number; // Time to live in seconds
}

/**
 * Revoke family request
 */
export interface RevokeFamilyRequest {
  familyId: string;
  reason?: string;
}

/**
 * Audit log entry
 */
interface AuditLogEntry {
  action: 'created' | 'rotated' | 'theft_detected' | 'family_revoked' | 'expired';
  familyId: string;
  userId?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Persistent state stored in Durable Storage (legacy format for migration)
 */
interface RefreshTokenRotatorState {
  families: Record<string, TokenFamily>; // Serializable format (Map cannot be serialized directly)
  tokenToFamily: Record<string, string>; // Reverse index
  lastCleanup: number;
}

/**
 * Storage key prefixes for granular storage
 * Using prefix-based keys allows for efficient incremental updates
 */
const STORAGE_PREFIX = {
  FAMILY: 'f:', // f:{familyId} → TokenFamily
  TOKEN: 't:', // t:{token} → familyId
  META: 'm:', // m:migrated → boolean (migration flag)
} as const;

/**
 * RefreshTokenRotator Durable Object
 *
 * Provides distributed refresh token rotation with theft detection.
 */
export class RefreshTokenRotator {
  private state: DurableObjectState;
  private env: Env;
  private families: Map<string, TokenFamily> = new Map();
  private tokenToFamily: Map<string, string> = new Map(); // Reverse index: token → familyId
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;
  private initializePromise: Promise<void> | null = null; // Promise-based lock for initialization
  private usesGranularStorage: boolean = false; // Flag for new storage format

  // Async audit log buffering
  private pendingAuditLogs: AuditLogEntry[] = [];
  private flushScheduled: boolean = false;
  private readonly AUDIT_FLUSH_DELAY = 100; // ms - batch logs within this window

  // Configuration
  private readonly DEFAULT_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private readonly MAX_PREVIOUS_TOKENS = 5; // Keep last 5 tokens for theft detection

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // State will be initialized on first request
  }

  /**
   * Initialize state from Durable Storage
   * Uses Promise-based lock to prevent race conditions when multiple
   * concurrent requests arrive before initialization completes.
   */
  private async initializeState(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // If initialization is in progress, wait for it to complete (race condition prevention)
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    // Start initialization
    this.initializePromise = this.doInitialize();

    try {
      await this.initializePromise;
    } catch (error) {
      // Clear promise on error to allow retry
      this.initializePromise = null;
      throw error;
    }
  }

  /**
   * Actual initialization logic (internal method)
   * Supports both legacy (single 'state' key) and granular (prefix-based) storage formats.
   * Migrates from legacy to granular format on first access.
   */
  private async doInitialize(): Promise<void> {
    try {
      // Check if already migrated to granular storage
      const migrated = await this.state.storage.get<boolean>(`${STORAGE_PREFIX.META}migrated`);

      if (migrated) {
        // Load from granular storage (new format)
        await this.loadFromGranularStorage();
        this.usesGranularStorage = true;
      } else {
        // Try legacy format first
        const stored = await this.state.storage.get<RefreshTokenRotatorState>('state');

        if (stored) {
          // Restore from legacy format
          this.families = new Map(Object.entries(stored.families));
          this.tokenToFamily = new Map(Object.entries(stored.tokenToFamily));
          console.log(
            `RefreshTokenRotator: Restored ${this.families.size} token families from legacy storage`
          );

          // Migrate to granular storage in background (non-blocking)
          void this.migrateToGranularStorage();
        } else {
          // Fresh instance - use granular storage from start
          this.usesGranularStorage = true;
          await this.state.storage.put(`${STORAGE_PREFIX.META}migrated`, true);
        }
      }
    } catch (error) {
      console.error('RefreshTokenRotator: Failed to initialize from Durable Storage:', error);
      // Continue with empty state
    }

    this.initialized = true;

    // Start periodic cleanup after initialization
    this.startCleanup();
  }

  /**
   * Load state from granular storage (prefix-based keys)
   */
  private async loadFromGranularStorage(): Promise<void> {
    // Load all families
    const familyEntries = await this.state.storage.list<TokenFamily>({
      prefix: STORAGE_PREFIX.FAMILY,
    });
    for (const [key, family] of familyEntries) {
      const familyId = key.substring(STORAGE_PREFIX.FAMILY.length);
      this.families.set(familyId, family);
    }

    // Load token→family index
    const tokenEntries = await this.state.storage.list<string>({
      prefix: STORAGE_PREFIX.TOKEN,
    });
    for (const [key, familyId] of tokenEntries) {
      const token = key.substring(STORAGE_PREFIX.TOKEN.length);
      this.tokenToFamily.set(token, familyId);
    }

    console.log(`RefreshTokenRotator: Loaded ${this.families.size} families from granular storage`);
  }

  /**
   * Migrate from legacy storage to granular storage
   * Runs in background to avoid blocking the current request
   */
  private async migrateToGranularStorage(): Promise<void> {
    try {
      console.log('RefreshTokenRotator: Starting migration to granular storage...');

      // Write each family and token index as separate keys
      const writes: Map<string, TokenFamily | string | boolean> = new Map();

      for (const [familyId, family] of this.families) {
        writes.set(`${STORAGE_PREFIX.FAMILY}${familyId}`, family);
      }

      for (const [token, familyId] of this.tokenToFamily) {
        writes.set(`${STORAGE_PREFIX.TOKEN}${token}`, familyId);
      }

      // Mark as migrated
      writes.set(`${STORAGE_PREFIX.META}migrated`, true);

      // Batch write all entries
      await this.state.storage.put(Object.fromEntries(writes));

      // Delete legacy state key
      await this.state.storage.delete('state');

      this.usesGranularStorage = true;
      console.log(
        `RefreshTokenRotator: Migration complete. ${this.families.size} families migrated.`
      );
    } catch (error) {
      console.error('RefreshTokenRotator: Migration failed:', error);
      // Continue using legacy format - will retry on next DO restart
    }
  }

  /**
   * Save current state to Durable Storage
   * Uses granular storage if migrated, otherwise falls back to legacy format.
   * @deprecated Use saveFamily() for incremental updates
   */
  private async saveState(): Promise<void> {
    if (this.usesGranularStorage) {
      // Already using granular storage - no need to save entire state
      // Individual operations use saveFamily() instead
      return;
    }

    try {
      const stateToSave: RefreshTokenRotatorState = {
        families: Object.fromEntries(this.families),
        tokenToFamily: Object.fromEntries(this.tokenToFamily),
        lastCleanup: Date.now(),
      };

      await this.state.storage.put('state', stateToSave);
    } catch (error) {
      console.error('RefreshTokenRotator: Failed to save to Durable Storage:', error);
      // Don't throw - we don't want to break the token operation
      // But this should be monitored/alerted in production
    }
  }

  /**
   * Save a single family and update token indexes (granular storage)
   * Much more efficient than saveState() for incremental updates.
   *
   * @param family - The token family to save
   * @param newToken - New token to add to index (optional)
   * @param removedTokens - Tokens to remove from index (optional)
   */
  private async saveFamily(
    family: TokenFamily,
    newToken?: string,
    removedTokens?: string[]
  ): Promise<void> {
    if (!this.usesGranularStorage) {
      // Fall back to legacy full save
      await this.saveState();
      return;
    }

    try {
      // Batch all writes for atomicity
      const writes: Record<string, TokenFamily | string> = {
        [`${STORAGE_PREFIX.FAMILY}${family.id}`]: family,
      };

      if (newToken) {
        writes[`${STORAGE_PREFIX.TOKEN}${newToken}`] = family.id;
      }

      await this.state.storage.put(writes);

      // Delete removed tokens
      if (removedTokens && removedTokens.length > 0) {
        const keysToDelete = removedTokens.map((t) => `${STORAGE_PREFIX.TOKEN}${t}`);
        await this.state.storage.delete(keysToDelete);
      }
    } catch (error) {
      console.error('RefreshTokenRotator: Failed to save family:', error);
      throw error; // Propagate error for token operations
    }
  }

  /**
   * Delete a family and all its token indexes (granular storage)
   */
  private async deleteFamily(family: TokenFamily): Promise<void> {
    if (!this.usesGranularStorage) {
      // Fall back to legacy full save
      await this.saveState();
      return;
    }

    try {
      // Collect all keys to delete
      const keysToDelete = [
        `${STORAGE_PREFIX.FAMILY}${family.id}`,
        `${STORAGE_PREFIX.TOKEN}${family.currentToken}`,
        ...family.previousTokens.map((t) => `${STORAGE_PREFIX.TOKEN}${t}`),
      ];

      await this.state.storage.delete(keysToDelete);
    } catch (error) {
      console.error('RefreshTokenRotator: Failed to delete family:', error);
      throw error;
    }
  }

  /**
   * Start periodic cleanup of expired token families
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        void this.cleanupExpiredFamilies();
      }, this.CLEANUP_INTERVAL) as unknown as number;
    }
  }

  /**
   * Cleanup expired token families
   * Uses granular storage for efficient deletion without full state serialization.
   */
  private async cleanupExpiredFamilies(): Promise<void> {
    const now = Date.now();
    const expiredFamilies: TokenFamily[] = [];

    for (const [familyId, family] of this.families.entries()) {
      if (family.expiresAt <= now) {
        expiredFamilies.push(family);

        // Remove from in-memory maps
        this.families.delete(familyId);
        this.tokenToFamily.delete(family.currentToken);
        for (const token of family.previousTokens) {
          this.tokenToFamily.delete(token);
        }
      }
    }

    if (expiredFamilies.length === 0) {
      return;
    }

    console.log(
      `RefreshTokenRotator: Cleaning up ${expiredFamilies.length} expired token families`
    );

    // Delete from storage (granular or legacy)
    for (const family of expiredFamilies) {
      await this.deleteFamily(family);

      // Log cleanup (non-critical, async)
      await this.logToD1({
        action: 'expired',
        familyId: family.id,
        userId: family.userId,
        timestamp: now,
      });
    }
  }

  /**
   * Generate unique token family ID
   */
  private generateFamilyId(): string {
    return `family_${crypto.randomUUID()}`;
  }

  /**
   * Generate unique refresh token
   */
  private generateToken(): string {
    return `rt_${crypto.randomUUID()}`;
  }

  /**
   * Find token family by token (current or previous)
   */
  private findFamilyByToken(token: string): TokenFamily | null {
    const familyId = this.tokenToFamily.get(token);
    if (!familyId) {
      return null;
    }

    return this.families.get(familyId) || null;
  }

  /**
   * Log audit entry to D1
   * Security-critical events (theft_detected, family_revoked) are logged synchronously.
   * Non-critical events are batched for performance.
   *
   * SECURITY: theft_detected and family_revoked MUST be logged synchronously
   * to ensure audit trail integrity for security incident response.
   */
  private async logToD1(entry: AuditLogEntry): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    // CRITICAL events: log synchronously to ensure audit trail
    const isCritical = entry.action === 'theft_detected' || entry.action === 'family_revoked';

    if (isCritical) {
      await this.syncLogToD1(entry);
    } else {
      // Non-critical events: batch for performance
      this.pendingAuditLogs.push(entry);
      this.scheduleAuditFlush();
    }
  }

  /**
   * Synchronously log a single entry to D1 (for critical events)
   */
  private async syncLogToD1(entry: AuditLogEntry): Promise<void> {
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
            entry.familyId,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
            Math.floor(entry.timestamp / 1000)
          )
          .run();
      },
      'RefreshTokenRotator.syncLogToD1',
      { maxRetries: 3 }
    );
  }

  /**
   * Schedule a flush of pending audit logs
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
   * Flush all pending audit logs to D1 in a batch
   */
  private async flushAuditLogs(): Promise<void> {
    this.flushScheduled = false;

    if (this.pendingAuditLogs.length === 0 || !this.env.DB) {
      return;
    }

    const logsToFlush = [...this.pendingAuditLogs];
    this.pendingAuditLogs = [];

    try {
      // Batch insert using D1's batch API
      const statements = logsToFlush.map((entry) =>
        this.env.DB.prepare(
          `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          `audit_${crypto.randomUUID()}`,
          entry.userId || null,
          `refresh_token.${entry.action}`,
          'refresh_token_family',
          entry.familyId,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          Math.floor(entry.timestamp / 1000)
        )
      );

      await this.env.DB.batch(statements);
    } catch (error) {
      console.error('RefreshTokenRotator: Failed to flush audit logs:', error);
      // Re-queue failed logs for retry (limited to prevent memory leak)
      if (this.pendingAuditLogs.length < 100) {
        this.pendingAuditLogs.push(...logsToFlush);
        this.scheduleAuditFlush();
      } else {
        console.error('RefreshTokenRotator: Audit log buffer overflow, dropping logs');
      }
    }
  }

  /**
   * Create new token family
   * Uses granular storage for efficient incremental writes.
   */
  async createFamily(request: CreateFamilyRequest): Promise<TokenFamily> {
    await this.initializeState();

    const familyId = this.generateFamilyId();
    const now = Date.now();

    const family: TokenFamily = {
      id: familyId,
      currentToken: request.token,
      previousTokens: [],
      userId: request.userId,
      clientId: request.clientId,
      scope: request.scope,
      rotationCount: 0,
      createdAt: now,
      lastRotation: now,
      expiresAt: now + request.ttl * 1000,
    };

    // Store family in memory
    this.families.set(familyId, family);

    // Update reverse index in memory
    this.tokenToFamily.set(request.token, familyId);

    // Persist to Durable Storage (granular: saves only this family + token index)
    await this.saveFamily(family, request.token);

    // Audit log (non-critical, async)
    await this.logToD1({
      action: 'created',
      familyId,
      userId: request.userId,
      clientId: request.clientId,
      metadata: { scope: request.scope },
      timestamp: now,
    });

    return family;
  }

  /**
   * Rotate refresh token (atomic operation)
   * Uses granular storage for efficient incremental updates.
   *
   * SECURITY: DO guarantees single-threaded execution, so rotation is atomic.
   * Old tokens are kept in previousTokens for theft detection (replay attack detection).
   */
  async rotate(request: RotateTokenRequest): Promise<RotateTokenResponse> {
    await this.initializeState();

    // Find token family
    const family = this.findFamilyByToken(request.currentToken);

    if (!family) {
      throw new Error('invalid_grant: Refresh token not found or expired');
    }

    // Validate user and client
    if (family.userId !== request.userId || family.clientId !== request.clientId) {
      throw new Error('invalid_grant: Token ownership mismatch');
    }

    // Check expiration
    if (family.expiresAt <= Date.now()) {
      // Cleanup expired family
      this.families.delete(family.id);
      this.tokenToFamily.delete(request.currentToken);
      await this.deleteFamily(family);
      throw new Error('invalid_grant: Refresh token expired');
    }

    // CRITICAL: Check if token is the current one
    if (family.currentToken !== request.currentToken) {
      // Token replay detected! This token was already rotated.
      // This indicates potential token theft.
      console.error('SECURITY: Token theft detected!', {
        userId: request.userId,
        clientId: request.clientId,
        familyId: family.id,
        attemptedToken: request.currentToken,
        currentToken: family.currentToken,
      });

      // SECURITY: Revoke ALL tokens in this family
      await this.revokeFamilyTokens({
        familyId: family.id,
        reason: 'theft_detected',
      });

      // Audit log (CRITICAL event - logged synchronously)
      await this.logToD1({
        action: 'theft_detected',
        familyId: family.id,
        userId: request.userId,
        clientId: request.clientId,
        metadata: {
          attemptedToken: request.currentToken,
          currentToken: family.currentToken,
        },
        timestamp: Date.now(),
      });

      throw new Error('invalid_grant: Token theft detected. All tokens in family revoked.');
    }

    // Generate new token
    const newToken = this.generateToken();

    // Atomic rotation (DO guarantees consistency)
    const oldToken = family.currentToken;
    family.previousTokens.push(oldToken);
    family.currentToken = newToken;
    family.rotationCount++;
    family.lastRotation = Date.now();

    // Track removed tokens for storage cleanup
    const removedTokens: string[] = [];

    // Trim previous tokens (keep only MAX_PREVIOUS_TOKENS)
    if (family.previousTokens.length > this.MAX_PREVIOUS_TOKENS) {
      const removed = family.previousTokens.shift();
      if (removed) {
        this.tokenToFamily.delete(removed);
        removedTokens.push(removed);
      }
    }

    // Update families map in memory
    this.families.set(family.id, family);

    // Update reverse index in memory (add new token, keep old token for theft detection)
    this.tokenToFamily.set(newToken, family.id);

    // Persist to Durable Storage (granular: saves only changed family + new token index + removes old)
    await this.saveFamily(family, newToken, removedTokens);

    // Audit log (non-critical, async)
    await this.logToD1({
      action: 'rotated',
      familyId: family.id,
      userId: request.userId,
      clientId: request.clientId,
      metadata: {
        rotationCount: family.rotationCount,
      },
      timestamp: Date.now(),
    });

    return {
      newToken,
      familyId: family.id,
      expiresIn: Math.floor((family.expiresAt - Date.now()) / 1000),
      rotationCount: family.rotationCount,
    };
  }

  /**
   * Revoke all tokens in a token family
   * Uses granular storage for efficient deletion.
   *
   * SECURITY: This operation is typically triggered by theft detection.
   * Audit logging is SYNCHRONOUS to ensure the security event is recorded.
   */
  async revokeFamilyTokens(request: RevokeFamilyRequest): Promise<void> {
    await this.initializeState();

    const family = this.families.get(request.familyId);

    if (!family) {
      // Already revoked or doesn't exist
      return;
    }

    // Remove from in-memory maps
    this.families.delete(request.familyId);
    this.tokenToFamily.delete(family.currentToken);
    for (const token of family.previousTokens) {
      this.tokenToFamily.delete(token);
    }

    // Persist deletion to Durable Storage (granular deletion)
    await this.deleteFamily(family);

    // Audit log (CRITICAL event - logged synchronously)
    await this.logToD1({
      action: 'family_revoked',
      familyId: request.familyId,
      userId: family.userId,
      clientId: family.clientId,
      metadata: {
        reason: request.reason || 'manual_revocation',
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Get token family info (for debugging/admin)
   */
  async getFamilyInfo(familyId: string): Promise<TokenFamily | null> {
    await this.initializeState();
    return this.families.get(familyId) || null;
  }

  /**
   * Handle HTTP requests to the RefreshTokenRotator Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    // CRITICAL: Initialize state before any operations
    // This ensures granular storage migration is complete
    await this.initializeState();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /family - Create new token family
      if (path === '/family' && request.method === 'POST') {
        const body = (await request.json()) as Partial<CreateFamilyRequest>;

        // Validate required fields
        if (!body.token || !body.userId || !body.clientId || !body.scope) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const family = await this.createFamily(body as CreateFamilyRequest);

        return new Response(
          JSON.stringify({
            familyId: family.id,
            expiresAt: family.expiresAt,
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // POST /rotate - Rotate refresh token
      if (path === '/rotate' && request.method === 'POST') {
        const body = (await request.json()) as Partial<RotateTokenRequest>;

        // Validate required fields
        if (!body.currentToken || !body.userId || !body.clientId) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        try {
          const result = await this.rotate(body as RotateTokenRequest);

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';

          // Extract OAuth 2.0 error code
          let errorCode = 'invalid_grant';
          let errorDescription = message;

          if (message.startsWith('invalid_grant:')) {
            errorDescription = message.substring(14).trim();
          }

          // Check if this is a theft detection error
          const isTheft = message.includes('theft detected');

          return new Response(
            JSON.stringify({
              error: errorCode,
              error_description: errorDescription,
              ...(isTheft && { action: 'all_tokens_revoked' }),
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      }

      // POST /revoke-family - Revoke all tokens in family
      if (path === '/revoke-family' && request.method === 'POST') {
        const body = (await request.json()) as Partial<RevokeFamilyRequest>;

        if (!body.familyId) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing familyId',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        await this.revokeFamilyTokens(body as RevokeFamilyRequest);

        return new Response(
          JSON.stringify({
            success: true,
            familyId: body.familyId,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /family/:familyId - Get family info (debugging)
      if (path.startsWith('/family/') && request.method === 'GET') {
        const familyId = path.substring(8); // Remove '/family/'
        const family = await this.getFamilyInfo(familyId);

        if (!family) {
          return new Response(JSON.stringify({ error: 'Family not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Sanitize: don't expose actual tokens
        return new Response(
          JSON.stringify({
            id: family.id,
            userId: family.userId,
            clientId: family.clientId,
            scope: family.scope,
            rotationCount: family.rotationCount,
            createdAt: family.createdAt,
            lastRotation: family.lastRotation,
            expiresAt: family.expiresAt,
            tokenCount: {
              current: 1,
              previous: family.previousTokens.length,
            },
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /status - Health check and stats
      if (path === '/status' && request.method === 'GET') {
        const now = Date.now();
        let activeFamilies = 0;

        for (const family of this.families.values()) {
          if (family.expiresAt > now) {
            activeFamilies++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            families: {
              total: this.families.size,
              active: activeFamilies,
              expired: this.families.size - activeFamilies,
            },
            tokens: this.tokenToFamily.size,
            config: {
              defaultTtl: this.DEFAULT_TTL,
              maxPreviousTokens: this.MAX_PREVIOUS_TOKENS,
            },
            timestamp: now,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /validate - Validate a token and return its metadata
      if (path === '/validate' && request.method === 'GET') {
        const token = url.searchParams.get('token');
        if (!token) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing token parameter',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const familyId = this.tokenToFamily.get(token);
        if (!familyId) {
          return new Response(
            JSON.stringify({
              valid: false,
              error: 'Token not found',
            }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const family = this.families.get(familyId);
        if (!family) {
          return new Response(
            JSON.stringify({
              valid: false,
              error: 'Family not found',
            }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // Check if token is expired
        const now = Date.now();
        if (family.expiresAt <= now) {
          return new Response(
            JSON.stringify({
              valid: false,
              error: 'Token expired',
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // Check if token is the current valid token
        if (family.currentToken !== token) {
          return new Response(
            JSON.stringify({
              valid: false,
              error: 'Token has been rotated',
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response(
          JSON.stringify({
            valid: true,
            familyId: family.id,
            userId: family.userId,
            clientId: family.clientId,
            scope: family.scope,
            createdAt: family.createdAt,
            expiresAt: family.expiresAt,
            rotationCount: family.rotationCount,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
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
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }
}
