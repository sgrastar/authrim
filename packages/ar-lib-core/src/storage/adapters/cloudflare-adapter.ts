/**
 * Cloudflare Storage Adapter
 *
 * Implements the unified storage adapter interface for Cloudflare Workers.
 * Integrates D1, KV, and Durable Objects with intelligent routing logic.
 *
 * Routing Strategy:
 * - session:* → SessionStore Durable Object (hot data) + D1 fallback (cold data)
 * - client:* → D1 database + KV cache (read-through cache pattern)
 * - user:* → D1 database
 * - authcode:* → AuthorizationCodeStore Durable Object (one-time use guarantee)
 * - refreshtoken:* → RefreshTokenRotator Durable Object (atomic rotation)
 * - Other keys → KV storage (fallback)
 */

import type {
  IStorageAdapter,
  IUserStore,
  IClientStore,
  ISessionStore,
  IPasskeyStore,
  IOrganizationStore,
  IRoleStore,
  IRoleAssignmentStore,
  IRelationshipStore,
  User,
  ClientData,
  Session,
  Passkey,
} from '../interfaces';
import {
  OrganizationStore,
  RoleStore,
  RoleAssignmentStore,
  RelationshipStore,
} from '../repositories';
import type { Env } from '../../types/env';
import type { D1Result } from '../../utils/d1-retry';
import { buildDOInstanceName } from '../../utils/tenant-context';
import type { SessionResponse } from '../../durable-objects/SessionStore';
import { createLogger } from '../../utils/logger';

const log = createLogger().module('CloudflareStorageAdapter');

/**
 * CloudflareStorageAdapter
 *
 * Unified storage adapter for Cloudflare Workers that routes operations
 * to the appropriate backend (D1, KV, or Durable Objects).
 */
export class CloudflareStorageAdapter implements IStorageAdapter {
  constructor(private env: Env) {}

  /**
   * Get value by key (routes to appropriate storage backend)
   */
  async get(key: string): Promise<string | null> {
    // Route based on key prefix
    if (key.startsWith('session:')) {
      return this.getFromSessionStore(key);
    } else if (key.startsWith('client:')) {
      return this.getFromD1WithKVCache(key);
    } else if (key.startsWith('user:')) {
      return this.getFromD1(key);
    } else if (key.startsWith('authcode:')) {
      return this.getFromAuthCodeStore(key);
    } else if (key.startsWith('refreshtoken:')) {
      return this.getFromRefreshTokenRotator(key);
    } else {
      // Fallback to KV for other keys
      return this.getFromKV(key);
    }
  }

  /**
   * Set value with optional TTL
   */
  async set(key: string, value: string, ttl?: number): Promise<void> {
    // Route based on key prefix
    if (key.startsWith('session:')) {
      await this.setToSessionStore(key, value, ttl);
    } else if (key.startsWith('client:')) {
      await this.setToD1WithKVCache(key, value);
    } else if (key.startsWith('user:')) {
      await this.setToD1(key, value);
    } else if (key.startsWith('authcode:')) {
      await this.setToAuthCodeStore(key, value, ttl);
    } else if (key.startsWith('refreshtoken:')) {
      await this.setToRefreshTokenRotator(key, value, ttl);
    } else {
      // Fallback to KV for other keys
      await this.setToKV(key, value, ttl);
    }
  }

  /**
   * Delete value by key
   */
  async delete(key: string): Promise<void> {
    // Route based on key prefix
    if (key.startsWith('session:')) {
      await this.deleteFromSessionStore(key);
    } else if (key.startsWith('client:')) {
      await this.deleteFromD1WithKVCache(key);
    } else if (key.startsWith('user:')) {
      await this.deleteFromD1(key);
    } else if (key.startsWith('authcode:')) {
      await this.deleteFromAuthCodeStore(key);
    } else if (key.startsWith('refreshtoken:')) {
      await this.deleteFromRefreshTokenRotator(key);
    } else {
      // Fallback to KV for other keys
      await this.deleteFromKV(key);
    }
  }

  /**
   * Execute SQL query (D1 only)
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this.env.DB.prepare(sql);
    const bound = params ? stmt.bind(...params) : stmt;
    const result = await bound.all();
    return (result.results as T[]) || [];
  }

  /**
   * Execute SQL statement (D1 only, returns execution result)
   */
  async execute(sql: string, params?: unknown[]): Promise<D1Result> {
    const stmt = this.env.DB.prepare(sql);
    const bound = params ? stmt.bind(...params) : stmt;
    return await bound.run();
  }

  // ========== Private helper methods ==========

  /**
   * Get from SessionStore Durable Object (RPC)
   */
  private async getFromSessionStore(key: string): Promise<string | null> {
    const sessionId = key.substring(8); // Remove 'session:' prefix
    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    const session = await doStub.getSessionRpc(sessionId);
    if (!session) {
      return null;
    }

    return JSON.stringify(session);
  }

  /**
   * Set to SessionStore Durable Object (RPC)
   */
  private async setToSessionStore(key: string, value: string, ttl?: number): Promise<void> {
    const sessionData = JSON.parse(value);
    const sessionId = key.substring(8); // Remove 'session:' prefix
    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    await doStub.createSessionRpc(
      sessionId,
      sessionData.user_id,
      ttl || 86400, // Default: 24 hours
      sessionData.data
    );
  }

  /**
   * Delete from SessionStore Durable Object (RPC)
   */
  private async deleteFromSessionStore(key: string): Promise<void> {
    const sessionId = key.substring(8); // Remove 'session:' prefix
    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    await doStub.invalidateSessionRpc(sessionId);
  }

  /**
   * Get from D1 with KV cache (read-through cache pattern)
   */
  private async getFromD1WithKVCache(key: string): Promise<string | null> {
    // 1. Try KV cache first (CLIENTS_CACHE is now required)
    if (!this.env.CLIENTS_CACHE) {
      throw new Error('CLIENTS_CACHE binding is required - CLIENTS KV has been deprecated');
    }
    const cached = await this.env.CLIENTS_CACHE.get(key);
    if (cached) {
      return cached;
    }

    // 2. Cache miss, query D1
    const value = await this.getFromD1(key);

    // 3. Update cache (1 hour TTL)
    if (value && this.env.CLIENTS_CACHE) {
      await this.env.CLIENTS_CACHE.put(key, value, { expirationTtl: 3600 });
    }

    return value;
  }

  /**
   * Set to D1 with KV cache invalidation
   *
   * Strategy: Delete-Then-Write
   * 1. Delete KV cache first to prevent stale cache reads
   * 2. Then update D1 (source of truth)
   *
   * This ensures that even if D1 write fails, the cache is invalidated,
   * so future reads will fetch fresh data from D1 instead of stale cache.
   */
  private async setToD1WithKVCache(key: string, value: string): Promise<void> {
    // Step 1: Invalidate KV cache BEFORE updating D1
    if (this.env.CLIENTS_CACHE) {
      try {
        await this.env.CLIENTS_CACHE.delete(key);
      } catch (error) {
        // Cache deletion failure should not block D1 write
        // D1 is the source of truth
        log.warn('KV cache delete failed, proceeding with D1 write', { key }, error as Error);
      }
    }

    // Step 2: Update D1 (source of truth)
    await this.setToD1(key, value);
  }

  /**
   * Delete from D1 with KV cache invalidation
   *
   * Strategy: Delete-Then-Write (same as setToD1WithKVCache)
   * 1. Delete KV cache first to prevent stale cache reads
   * 2. Then delete from D1 (source of truth)
   *
   * This ensures cache consistency even if D1 deletion fails.
   */
  private async deleteFromD1WithKVCache(key: string): Promise<void> {
    // Step 1: Invalidate KV cache BEFORE deleting from D1
    if (this.env.CLIENTS_CACHE) {
      try {
        await this.env.CLIENTS_CACHE.delete(key);
      } catch (error) {
        // Cache deletion failure should not block D1 delete
        // D1 is the source of truth
        log.warn('KV cache delete failed, proceeding with D1 delete', { key }, error as Error);
      }
    }

    // Step 2: Delete from D1 (source of truth)
    await this.deleteFromD1(key);
  }

  /**
   * Get from D1 database
   */
  private async getFromD1(key: string): Promise<string | null> {
    // Parse key to determine table and ID
    // Format: <table>:<id>
    const [table, id] = key.split(':', 2);

    if (!table || !id) {
      return null;
    }

    const result = await this.env.DB.prepare('SELECT data FROM kv_store WHERE key = ?')
      .bind(key)
      .first();

    if (!result) {
      return null;
    }

    return result.data as string;
  }

  /**
   * Set to D1 database
   */
  private async setToD1(key: string, value: string): Promise<void> {
    await this.env.DB.prepare('INSERT OR REPLACE INTO kv_store (key, data) VALUES (?, ?)')
      .bind(key, value)
      .run();
  }

  /**
   * Delete from D1 database
   */
  private async deleteFromD1(key: string): Promise<void> {
    await this.env.DB.prepare('DELETE FROM kv_store WHERE key = ?').bind(key).run();
  }

  /**
   * Get from AuthCodeStore Durable Object (RPC)
   */
  private async getFromAuthCodeStore(key: string): Promise<string | null> {
    const code = key.substring(9); // Remove 'authcode:' prefix
    const doId = this.env.AUTH_CODE_STORE.idFromName(buildDOInstanceName('auth-code'));
    const doStub = this.env.AUTH_CODE_STORE.get(doId);

    const exists = await doStub.hasCodeRpc(code);
    return exists ? JSON.stringify({ exists: true }) : null;
  }

  /**
   * Set to AuthCodeStore Durable Object (RPC)
   */
  private async setToAuthCodeStore(key: string, value: string, _ttl?: number): Promise<void> {
    const codeData = JSON.parse(value);
    const doId = this.env.AUTH_CODE_STORE.idFromName(buildDOInstanceName('auth-code'));
    const doStub = this.env.AUTH_CODE_STORE.get(doId);

    await doStub.storeCodeRpc(codeData);
  }

  /**
   * Delete from AuthCodeStore Durable Object (RPC)
   */
  private async deleteFromAuthCodeStore(key: string): Promise<void> {
    const code = key.substring(9); // Remove 'authcode:' prefix
    const doId = this.env.AUTH_CODE_STORE.idFromName(buildDOInstanceName('auth-code'));
    const doStub = this.env.AUTH_CODE_STORE.get(doId);

    await doStub.deleteCodeRpc(code);
  }

  /**
   * Get from RefreshTokenRotator Durable Object (RPC)
   *
   * @deprecated This method uses legacy (non-sharded) routing.
   * For V3 sharding support, use getRefreshToken() from @authrim/ar-lib-core/utils/kv instead.
   * Key format: refreshtoken:{familyId} - lacks JTI/clientId for sharding.
   */
  private async getFromRefreshTokenRotator(key: string): Promise<string | null> {
    log.warn('DEPRECATED: getFromRefreshTokenRotator uses legacy routing', {
      recommendation:
        'Use getRefreshToken() from @authrim/ar-lib-core/utils/kv for V3 sharding support.',
    });
    const familyId = key.substring(13); // Remove 'refreshtoken:' prefix (familyId = userId in legacy)
    const doId = this.env.REFRESH_TOKEN_ROTATOR.idFromName(buildDOInstanceName('refresh-token'));
    const doStub = this.env.REFRESH_TOKEN_ROTATOR.get(doId);

    const family = await doStub.getFamilyRpc(familyId);
    if (!family) {
      return null;
    }

    return JSON.stringify(family);
  }

  /**
   * Set to RefreshTokenRotator Durable Object (RPC)
   *
   * V3: Supports sharding if familyData contains jti and clientId.
   * Falls back to legacy routing if sharding info is not available.
   */
  private async setToRefreshTokenRotator(key: string, value: string, ttl?: number): Promise<void> {
    const familyData = JSON.parse(value);

    // V3: Try to extract sharding info from familyData
    let doId: DurableObjectId;
    const jti = familyData.jti;
    const clientId = familyData.clientId || familyData.client_id;

    if (jti && clientId) {
      // V3: Parse JTI and route to sharded DO
      const { parseRefreshTokenJti, buildRefreshTokenRotatorInstanceName } =
        await import('../../utils/refresh-token-sharding');
      const parsedJti = parseRefreshTokenJti(jti);
      const instanceName = buildRefreshTokenRotatorInstanceName(
        clientId,
        parsedJti.generation,
        parsedJti.shardIndex
      );
      doId = this.env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
    } else {
      // Legacy: Use non-sharded routing
      log.warn('DEPRECATED: setToRefreshTokenRotator using legacy routing', {
        recommendation: 'Include jti and clientId in familyData for V3 sharding support.',
      });
      doId = this.env.REFRESH_TOKEN_ROTATOR.idFromName(buildDOInstanceName('refresh-token'));
    }

    const doStub = this.env.REFRESH_TOKEN_ROTATOR.get(doId);

    await doStub.createFamilyRpc({
      ...familyData,
      ttl: ttl || 30 * 24 * 60 * 60, // Default: 30 days
    });
  }

  /**
   * Delete from RefreshTokenRotator Durable Object (RPC)
   *
   * @deprecated This method uses legacy (non-sharded) routing.
   * For V3 sharding support, use deleteRefreshToken() from @authrim/ar-lib-core/utils/kv instead.
   * Key format: refreshtoken:{familyId} - lacks JTI/clientId for sharding.
   */
  private async deleteFromRefreshTokenRotator(key: string): Promise<void> {
    log.warn('DEPRECATED: deleteFromRefreshTokenRotator uses legacy routing', {
      recommendation:
        'Use deleteRefreshToken() from @authrim/ar-lib-core/utils/kv for V3 sharding support.',
    });
    const familyId = key.substring(13); // Remove 'refreshtoken:' prefix (familyId = userId in legacy)
    const doId = this.env.REFRESH_TOKEN_ROTATOR.idFromName(buildDOInstanceName('refresh-token'));
    const doStub = this.env.REFRESH_TOKEN_ROTATOR.get(doId);

    await doStub.revokeFamilyRpc(familyId, 'deleteFromRefreshTokenRotator');
  }

  /**
   * Get from KV storage (fallback) - DEPRECATED
   * @deprecated CLIENTS KV has been removed. Use D1+CLIENTS_CACHE instead.
   */
  private async getFromKV(key: string): Promise<string | null> {
    throw new Error(
      `getFromKV called with ${key} - CLIENTS KV is deprecated, use D1+CLIENTS_CACHE. ` +
        'If you need general KV storage, use env.KV or create a specific namespace.'
    );
  }

  /**
   * Set to KV storage (fallback) - DEPRECATED
   * @deprecated CLIENTS KV has been removed. Use D1+CLIENTS_CACHE instead.
   */
  private async setToKV(key: string, value: string, ttl?: number): Promise<void> {
    throw new Error(
      `setToKV called with ${key} - CLIENTS KV is deprecated, use D1+CLIENTS_CACHE. ` +
        'If you need general KV storage, use env.KV or create a specific namespace.'
    );
  }

  /**
   * Delete from KV storage (fallback) - DEPRECATED
   * @deprecated CLIENTS KV has been removed. Use D1+CLIENTS_CACHE instead.
   */
  private async deleteFromKV(key: string): Promise<void> {
    throw new Error(
      `deleteFromKV called with ${key} - CLIENTS KV is deprecated, use D1+CLIENTS_CACHE. ` +
        'If you need general KV storage, use env.KV or create a specific namespace.'
    );
  }

  // =============================================================================
  // PII Database Access (DB_PII) - Phase 6 PII/Non-PII DB Separation
  // =============================================================================

  /**
   * Query from PII database (DB_PII)
   *
   * Used by UserStore for PII data (email, name, etc.)
   * DB_PII is required - no fallback to DB (per migration strategy: no backward compatibility).
   */
  async queryPII<T>(sql: string, params: unknown[]): Promise<T[]> {
    if (!this.env.DB_PII) {
      throw new Error(
        'DB_PII is required but not configured. PII/Non-PII DB separation requires DB_PII binding.'
      );
    }
    const stmt = this.env.DB_PII.prepare(sql);
    const results = await stmt.bind(...params).all<T>();
    return results.results;
  }

  /**
   * Execute on PII database (DB_PII)
   *
   * Used by UserStore for PII data operations.
   * DB_PII is required - no fallback to DB (per migration strategy: no backward compatibility).
   */
  async executePII(sql: string, params: unknown[]): Promise<D1Result> {
    if (!this.env.DB_PII) {
      throw new Error(
        'DB_PII is required but not configured. PII/Non-PII DB separation requires DB_PII binding.'
      );
    }
    const stmt = this.env.DB_PII.prepare(sql);
    const result = await stmt.bind(...params).run();
    return result as D1Result;
  }
}

/**
 * UserStore implementation (D1-based with PII/Non-PII DB separation)
 *
 * Users are stored in two separate databases:
 * - users_core (DB): Non-PII data (id, email_verified, is_active, etc.)
 * - users_pii (DB_PII): PII data (email, name, phone, address, etc.)
 *
 * This separation enables:
 * - GDPR/CCPA compliance (PII can be stored in regional DBs)
 * - Fine-grained access control (PII requires explicit access)
 * - Audit-friendly data classification
 */
export class UserStore implements IUserStore {
  constructor(private adapter: CloudflareStorageAdapter) {}

  /**
   * Get user by ID
   *
   * Queries both users_core (DB) and users_pii (DB_PII) and merges the results.
   */
  async get(userId: string): Promise<User | null> {
    // Query both databases in parallel
    const [coreResults, piiResults] = await Promise.all([
      this.adapter.query<UserCoreRow>(
        'SELECT id, tenant_id, email_verified, phone_number_verified, password_hash, is_active, created_at, updated_at, last_login_at FROM users_core WHERE id = ?',
        [userId]
      ),
      this.adapter.queryPII<UserPIIRow>(
        `SELECT id, email, name, given_name, family_name, middle_name, nickname, preferred_username,
                profile, picture, website, gender, birthdate, zoneinfo, locale, phone_number,
                address_formatted, address_street_address, address_locality, address_region,
                address_postal_code, address_country
         FROM users_pii WHERE id = ?`,
        [userId]
      ),
    ]);

    const core = coreResults[0];
    const pii = piiResults[0];

    if (!core) return null;

    return this.mergeUserData(core, pii);
  }

  /**
   * Get user by email
   *
   * Queries users_pii first (since email is stored there), then fetches users_core.
   */
  async getByEmail(email: string): Promise<User | null> {
    // Use tenant_id + email for idx_users_pii_email composite index
    // Default to 'default' tenant until multi-tenant support is added to interface
    const tenantId = 'default';

    // First find user in PII DB by email
    const piiResults = await this.adapter.queryPII<UserPIIRow>(
      `SELECT id, email, name, given_name, family_name, middle_name, nickname, preferred_username,
              profile, picture, website, gender, birthdate, zoneinfo, locale, phone_number,
              address_formatted, address_street_address, address_locality, address_region,
              address_postal_code, address_country
       FROM users_pii WHERE tenant_id = ? AND email = ?`,
      [tenantId, email]
    );

    const pii = piiResults[0];
    if (!pii) return null;

    // Then fetch core data by ID
    const coreResults = await this.adapter.query<UserCoreRow>(
      'SELECT id, tenant_id, email_verified, phone_number_verified, password_hash, is_active, created_at, updated_at, last_login_at FROM users_core WHERE id = ?',
      [pii.id]
    );

    const core = coreResults[0];
    if (!core) return null;

    return this.mergeUserData(core, pii);
  }

  /**
   * Create a new user
   *
   * Inserts into both users_core (DB) and users_pii (DB_PII).
   */
  async create(user: Partial<User>): Promise<User> {
    const id = crypto.randomUUID();
    const now = Date.now(); // Store in milliseconds
    const tenantId = 'default';

    const newUser: User = {
      id,
      email: user.email!,
      email_verified: user.email_verified || false,
      name: user.name,
      family_name: user.family_name,
      given_name: user.given_name,
      middle_name: user.middle_name,
      nickname: user.nickname,
      preferred_username: user.preferred_username,
      profile: user.profile,
      picture: user.picture,
      website: user.website,
      gender: user.gender,
      birthdate: user.birthdate,
      zoneinfo: user.zoneinfo,
      locale: user.locale,
      phone_number: user.phone_number,
      phone_number_verified: user.phone_number_verified,
      address: user.address,
      created_at: now,
      updated_at: now,
      last_login_at: user.last_login_at,
      mfa_enabled: user.mfa_enabled,
      mfa_secret: user.mfa_secret,
      is_active: user.is_active !== undefined ? user.is_active : true,
      is_locked: user.is_locked,
      failed_login_attempts: user.failed_login_attempts,
    };

    // Insert into users_core (DB) - non-PII data
    await this.adapter.execute(
      `INSERT INTO users_core (
        id, tenant_id, email_verified, phone_number_verified, password_hash,
        is_active, pii_partition, pii_status, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newUser.id,
        tenantId,
        newUser.email_verified ? 1 : 0,
        newUser.phone_number_verified ? 1 : 0,
        user.password_hash || null,
        newUser.is_active ? 1 : 0,
        'default', // pii_partition
        'active', // pii_status
        newUser.created_at,
        newUser.updated_at,
        newUser.last_login_at || null,
      ]
    );

    // Insert into users_pii (DB_PII) - PII data
    await this.adapter.executePII(
      `INSERT INTO users_pii (
        id, tenant_id, email, name, given_name, family_name, middle_name, nickname,
        preferred_username, profile, picture, website, gender, birthdate, zoneinfo, locale,
        phone_number, address_formatted, address_street_address, address_locality,
        address_region, address_postal_code, address_country, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newUser.id,
        tenantId,
        newUser.email,
        newUser.name || null,
        newUser.given_name || null,
        newUser.family_name || null,
        newUser.middle_name || null,
        newUser.nickname || null,
        newUser.preferred_username || null,
        newUser.profile || null,
        newUser.picture || null,
        newUser.website || null,
        newUser.gender || null,
        newUser.birthdate || null,
        newUser.zoneinfo || null,
        newUser.locale || null,
        newUser.phone_number || null,
        newUser.address?.formatted || null,
        newUser.address?.street_address || null,
        newUser.address?.locality || null,
        newUser.address?.region || null,
        newUser.address?.postal_code || null,
        newUser.address?.country || null,
        newUser.created_at,
        newUser.updated_at,
      ]
    );

    return newUser;
  }

  /**
   * Update an existing user
   *
   * Updates both users_core (DB) and users_pii (DB_PII).
   */
  async update(userId: string, updates: Partial<User>): Promise<User> {
    const existing = await this.get(userId);
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    const updated: User = {
      ...existing,
      ...updates,
      id: userId, // Prevent changing ID
      updated_at: Date.now(), // Store in milliseconds
    };

    // Update users_core (DB) - non-PII data
    await this.adapter.execute(
      `UPDATE users_core SET
        email_verified = ?, phone_number_verified = ?, password_hash = ?,
        is_active = ?, updated_at = ?, last_login_at = ?
      WHERE id = ?`,
      [
        updated.email_verified ? 1 : 0,
        updated.phone_number_verified ? 1 : 0,
        updates.password_hash ?? existing.password_hash ?? null,
        updated.is_active ? 1 : 0,
        updated.updated_at,
        updated.last_login_at || null,
        userId,
      ]
    );

    // Update users_pii (DB_PII) - PII data
    await this.adapter.executePII(
      `UPDATE users_pii SET
        email = ?, name = ?, given_name = ?, family_name = ?, middle_name = ?,
        nickname = ?, preferred_username = ?, profile = ?, picture = ?, website = ?,
        gender = ?, birthdate = ?, zoneinfo = ?, locale = ?, phone_number = ?,
        address_formatted = ?, address_street_address = ?, address_locality = ?,
        address_region = ?, address_postal_code = ?, address_country = ?, updated_at = ?
      WHERE id = ?`,
      [
        updated.email,
        updated.name || null,
        updated.given_name || null,
        updated.family_name || null,
        updated.middle_name || null,
        updated.nickname || null,
        updated.preferred_username || null,
        updated.profile || null,
        updated.picture || null,
        updated.website || null,
        updated.gender || null,
        updated.birthdate || null,
        updated.zoneinfo || null,
        updated.locale || null,
        updated.phone_number || null,
        updated.address?.formatted || null,
        updated.address?.street_address || null,
        updated.address?.locality || null,
        updated.address?.region || null,
        updated.address?.postal_code || null,
        updated.address?.country || null,
        updated.updated_at,
        userId,
      ]
    );

    return updated;
  }

  /**
   * Delete a user (soft delete)
   *
   * Sets is_active = 0 in users_core instead of physically deleting.
   * For GDPR Art.17 compliance, use the Admin API's PII deletion endpoint.
   */
  async delete(userId: string): Promise<void> {
    // Soft delete: set is_active = 0
    await this.adapter.execute('UPDATE users_core SET is_active = 0, updated_at = ? WHERE id = ?', [
      Date.now(),
      userId,
    ]);
  }

  // =============================================================================
  // Helper Methods
  // =============================================================================

  /**
   * Merge users_core and users_pii data into a single User object
   */
  private mergeUserData(core: UserCoreRow, pii?: UserPIIRow): User {
    const address =
      pii?.address_formatted ||
      pii?.address_street_address ||
      pii?.address_locality ||
      pii?.address_region ||
      pii?.address_postal_code ||
      pii?.address_country
        ? {
            formatted: pii.address_formatted || undefined,
            street_address: pii.address_street_address || undefined,
            locality: pii.address_locality || undefined,
            region: pii.address_region || undefined,
            postal_code: pii.address_postal_code || undefined,
            country: pii.address_country || undefined,
          }
        : undefined;

    return {
      id: core.id,
      email: pii?.email || '', // Fallback if PII not found
      email_verified: core.email_verified === 1,
      password_hash: core.password_hash || undefined,
      name: pii?.name || undefined,
      family_name: pii?.family_name || undefined,
      given_name: pii?.given_name || undefined,
      middle_name: pii?.middle_name || undefined,
      nickname: pii?.nickname || undefined,
      preferred_username: pii?.preferred_username || undefined,
      profile: pii?.profile || undefined,
      picture: pii?.picture || undefined,
      website: pii?.website || undefined,
      gender: pii?.gender || undefined,
      birthdate: pii?.birthdate || undefined,
      zoneinfo: pii?.zoneinfo || undefined,
      locale: pii?.locale || undefined,
      phone_number: pii?.phone_number || undefined,
      phone_number_verified: core.phone_number_verified === 1,
      address,
      created_at: core.created_at,
      updated_at: core.updated_at,
      last_login_at: core.last_login_at || undefined,
      is_active: core.is_active === 1,
    };
  }
}

// =============================================================================
// Internal Types for DB Rows
// =============================================================================

/** Row type for users_core table */
interface UserCoreRow {
  id: string;
  tenant_id: string;
  email_verified: number; // 0 or 1
  phone_number_verified: number; // 0 or 1
  password_hash: string | null;
  is_active: number; // 0 or 1
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/** Row type for users_pii table */
interface UserPIIRow {
  id: string;
  email: string;
  name: string | null;
  given_name: string | null;
  family_name: string | null;
  middle_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  profile: string | null;
  picture: string | null;
  website: string | null;
  gender: string | null;
  birthdate: string | null;
  zoneinfo: string | null;
  locale: string | null;
  phone_number: string | null;
  address_formatted: string | null;
  address_street_address: string | null;
  address_locality: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country: string | null;
}

/**
 * ClientStore implementation (D1 + KV cache)
 */
export class ClientStore implements IClientStore {
  constructor(private adapter: CloudflareStorageAdapter) {}

  async get(clientId: string): Promise<ClientData | null> {
    const results = await this.adapter.query<ClientData>(
      'SELECT * FROM oauth_clients WHERE client_id = ?',
      [clientId]
    );
    return results[0] || null;
  }

  async create(client: Partial<ClientData>): Promise<ClientData> {
    const now = Date.now(); // Store in milliseconds

    const newClient: ClientData = {
      client_id: client.client_id!,
      client_secret_hash: client.client_secret_hash,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris || [],
      grant_types: client.grant_types || [],
      response_types: client.response_types || [],
      scope: client.scope,
      subject_type: client.subject_type || 'public',
      sector_identifier_uri: client.sector_identifier_uri,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO oauth_clients (
        client_id, client_secret_hash, client_name, redirect_uris, grant_types,
        response_types, scope, subject_type, sector_identifier_uri,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newClient.client_id,
        newClient.client_secret_hash,
        newClient.client_name,
        JSON.stringify(newClient.redirect_uris),
        JSON.stringify(newClient.grant_types),
        JSON.stringify(newClient.response_types),
        newClient.scope,
        newClient.subject_type,
        newClient.sector_identifier_uri,
        newClient.created_at,
        newClient.updated_at,
      ]
    );

    return newClient;
  }

  async update(clientId: string, updates: Partial<ClientData>): Promise<ClientData> {
    const existing = await this.get(clientId);
    if (!existing) {
      throw new Error(`Client not found: ${clientId}`);
    }

    const updated: ClientData = {
      ...existing,
      ...updates,
      client_id: clientId, // Prevent changing client_id
      updated_at: Date.now(), // Store in milliseconds
    };

    await this.adapter.execute(
      `UPDATE oauth_clients SET
        client_secret_hash = ?, client_name = ?, redirect_uris = ?, grant_types = ?,
        response_types = ?, scope = ?, subject_type = ?, sector_identifier_uri = ?,
        updated_at = ?
      WHERE client_id = ?`,
      [
        updated.client_secret_hash,
        updated.client_name,
        JSON.stringify(updated.redirect_uris),
        JSON.stringify(updated.grant_types),
        JSON.stringify(updated.response_types),
        updated.scope,
        updated.subject_type,
        updated.sector_identifier_uri,
        updated.updated_at,
        clientId,
      ]
    );

    return updated;
  }

  async delete(clientId: string): Promise<void> {
    await this.adapter.execute('DELETE FROM oauth_clients WHERE client_id = ?', [clientId]);
  }

  async list(options?: { limit?: number; offset?: number }): Promise<ClientData[]> {
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;

    return await this.adapter.query<ClientData>(
      'SELECT * FROM oauth_clients ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
  }
}

/**
 * SessionStore implementation (Durable Object + D1)
 */
export class SessionStore implements ISessionStore {
  constructor(
    private adapter: CloudflareStorageAdapter,
    private env: Env
  ) {}

  async get(sessionId: string): Promise<Session | null> {
    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    // RPC call
    const session = await doStub.getSessionRpc(sessionId);
    return session;
  }

  async create(session: Partial<Session>): Promise<Session> {
    const id = session.id || `session_${crypto.randomUUID()}`;
    const now = Date.now();
    const ttl = session.expires_at ? Math.floor((session.expires_at - now) / 1000) : 86400;

    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    // RPC call
    const result = await doStub.createSessionRpc(id, session.user_id!, ttl, session.data);
    return result as Session;
  }

  async delete(sessionId: string): Promise<void> {
    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    // RPC call
    await doStub.invalidateSessionRpc(sessionId);
  }

  async listByUser(userId: string): Promise<Session[]> {
    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    // RPC call - returns SessionResponse[]
    const sessions: SessionResponse[] = await doStub.listUserSessionsRpc(userId);
    // Convert SessionResponse[] to Session[] (interface adapts field names)
    return sessions.map((s: SessionResponse) => ({
      id: s.id,
      user_id: s.userId,
      expires_at: s.expiresAt,
      created_at: s.createdAt,
      data: s.data,
    })) as Session[];
  }

  async extend(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    const doId = this.env.SESSION_STORE.idFromName(buildDOInstanceName('session'));
    const doStub = this.env.SESSION_STORE.get(doId);

    // RPC call
    const result = await doStub.extendSessionRpc(sessionId, additionalSeconds);
    return result;
  }
}

/**
 * PasskeyStore implementation (D1-based)
 */
export class PasskeyStore implements IPasskeyStore {
  constructor(private adapter: CloudflareStorageAdapter) {}

  async getByCredentialId(credentialId: string): Promise<Passkey | null> {
    const results = await this.adapter.query<Passkey>(
      'SELECT * FROM passkeys WHERE credential_id = ?',
      [credentialId]
    );
    return results[0] || null;
  }

  async listByUser(userId: string): Promise<Passkey[]> {
    return await this.adapter.query<Passkey>(
      'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
  }

  async create(passkey: Partial<Passkey>): Promise<Passkey> {
    const id = crypto.randomUUID();
    const now = Date.now(); // Store in milliseconds

    const newPasskey: Passkey = {
      id,
      user_id: passkey.user_id!,
      credential_id: passkey.credential_id!,
      public_key: passkey.public_key!,
      counter: passkey.counter || 0,
      transports: passkey.transports,
      device_name: passkey.device_name,
      created_at: now,
      last_used_at: passkey.last_used_at,
    };

    await this.adapter.execute(
      `INSERT INTO passkeys (
        id, user_id, credential_id, public_key, counter, transports,
        device_name, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newPasskey.id,
        newPasskey.user_id,
        newPasskey.credential_id,
        newPasskey.public_key,
        newPasskey.counter,
        newPasskey.transports ? JSON.stringify(newPasskey.transports) : null,
        newPasskey.device_name,
        newPasskey.created_at,
        newPasskey.last_used_at,
      ]
    );

    return newPasskey;
  }

  async updateCounter(passkeyId: string, counter: number): Promise<Passkey> {
    const now = Date.now(); // Store in milliseconds
    const MAX_RETRIES = 3;

    // Retry loop for Compare-and-Swap (CAS) to handle concurrent updates
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // 1. Read current counter value
      const currentResults = await this.adapter.query<Passkey>(
        'SELECT * FROM passkeys WHERE id = ?',
        [passkeyId]
      );

      if (!currentResults[0]) {
        throw new Error(`Passkey not found: ${passkeyId}`);
      }

      const currentPasskey = currentResults[0];
      const currentCounter = currentPasskey.counter;

      // 2. Validate that new counter is greater than current (WebAuthn requirement)
      if (counter <= currentCounter) {
        throw new Error(
          `Counter rollback detected: new counter ${counter} <= current counter ${currentCounter}. Possible cloned authenticator.`
        );
      }

      // 3. Conditional UPDATE (Compare-and-Swap)
      // Only update if counter hasn't changed since we read it
      const result = await this.adapter.execute(
        'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?',
        [counter, now, passkeyId, currentCounter]
      );

      // 4. Check if update succeeded (affected rows > 0)
      if (result.meta && result.meta.changes && result.meta.changes > 0) {
        // Success! Return updated passkey
        return {
          ...currentPasskey,
          counter,
          last_used_at: now,
        };
      }

      // Update failed - another request modified the counter
      // Retry the operation
      log.warn('Passkey counter CAS conflict', {
        passkeyId,
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
      });

      // Small delay before retry to reduce contention
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }

    // Max retries exceeded
    throw new Error(
      `Failed to update passkey counter after ${MAX_RETRIES} attempts due to concurrent modifications`
    );
  }

  async delete(passkeyId: string): Promise<void> {
    await this.adapter.execute('DELETE FROM passkeys WHERE id = ?', [passkeyId]);
  }
}

/**
 * Factory function to create CloudflareStorageAdapter with stores
 */
export function createStorageAdapter(env: Env): {
  adapter: CloudflareStorageAdapter;
  userStore: IUserStore;
  clientStore: IClientStore;
  sessionStore: ISessionStore;
  passkeyStore: IPasskeyStore;
  // RBAC stores (Phase 1)
  organizationStore: IOrganizationStore;
  roleStore: IRoleStore;
  roleAssignmentStore: IRoleAssignmentStore;
  relationshipStore: IRelationshipStore;
} {
  const adapter = new CloudflareStorageAdapter(env);

  return {
    adapter,
    userStore: new UserStore(adapter),
    clientStore: new ClientStore(adapter),
    sessionStore: new SessionStore(adapter, env),
    passkeyStore: new PasskeyStore(adapter),
    // RBAC stores (Phase 1)
    organizationStore: new OrganizationStore(adapter),
    roleStore: new RoleStore(adapter),
    roleAssignmentStore: new RoleAssignmentStore(adapter),
    relationshipStore: new RelationshipStore(adapter),
  };
}
