/**
 * Cloudflare Storage Adapter
 *
 * Implements the unified storage adapter interface for Cloudflare Workers.
 * Integrates D1, KV, and Durable Objects with intelligent routing logic.
 *
 * Routing Strategy:
 * - session:* → SessionStore Durable Object (region-sharded hot path + cold persistence adapter)
 * - client:* → D1 database + KV cache (read-through cache pattern)
 * - user:* → D1 database
 * - authcode:* → AuthorizationCodeStore Durable Object (one-time use guarantee)
 * - refreshtoken:* → Deprecated low-level shim (use refresh token helpers instead)
 * - Other keys → KV storage (fallback)
 */

import type { DatabaseAdapter, ExecuteResult } from '../../db/adapter';
import {
  CanonicalRuntimeUserStore,
  type CanonicalRuntimeUserProjection,
} from '../../repositories/identity';
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
import { createLogger } from '../../utils/logger';
import {
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  isRegionShardedSessionId,
} from '../../utils/session-helper';
import { storeRefreshToken } from '../../utils/refresh-token-store';

const log = createLogger().module('CloudflareStorageAdapter');

function isUniqueConstraintError(error: unknown): boolean {
  return String(error).includes('UNIQUE constraint');
}

type SessionStoreRpcStub = {
  getSessionRpc(sessionId: string): Promise<Session | null>;
  createSessionRpc(
    sessionId: string,
    userId: string,
    ttl: number,
    data: Record<string, unknown> | undefined,
    tenantId: string
  ): Promise<Session>;
  invalidateSessionRpc(sessionId: string): Promise<boolean>;
  extendSessionRpc(sessionId: string, additionalSeconds: number): Promise<Session | null>;
};

function toExecuteResult(result: D1Result): ExecuteResult {
  return {
    rowsAffected: result.meta?.changes ?? 0,
    lastInsertRowid: result.meta?.last_row_id,
    success: result.success,
    durationMs: result.meta?.duration,
  };
}

function toNumberTimestamp(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return value;
  }
  if (!value) {
    return Date.now();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseAddress(value: string | null): User['address'] {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as User['address'])
      : undefined;
  } catch {
    return undefined;
  }
}

function toRuntimeUser(projection: CanonicalRuntimeUserProjection): User {
  return {
    id: projection.id,
    email: projection.email ?? '',
    email_verified: projection.email_verified === 1,
    password_hash: projection.password_hash ?? undefined,
    name: projection.name ?? undefined,
    family_name: projection.family_name ?? undefined,
    given_name: projection.given_name ?? undefined,
    middle_name: projection.middle_name ?? undefined,
    nickname: projection.nickname ?? undefined,
    preferred_username: projection.preferred_username ?? undefined,
    profile: projection.profile ?? undefined,
    picture: projection.picture ?? undefined,
    website: projection.website ?? undefined,
    gender: projection.gender ?? undefined,
    birthdate: projection.birthdate ?? undefined,
    zoneinfo: projection.zoneinfo ?? undefined,
    locale: projection.locale ?? undefined,
    phone_number: projection.phone_number ?? undefined,
    phone_number_verified: projection.phone_number_verified === 1,
    address: parseAddress(projection.address_json),
    created_at: toNumberTimestamp(projection.created_at),
    updated_at: toNumberTimestamp(projection.updated_at),
    last_login_at: projection.last_login_at ?? undefined,
    is_active: projection.active === 1,
  };
}

/**
 * CloudflareStorageAdapter
 *
 * Unified storage adapter for Cloudflare Workers that routes operations
 * to the appropriate backend (D1, KV, or Durable Objects).
 */
export class CloudflareStorageAdapter implements IStorageAdapter {
  private readonly configuredTenantId: string;

  constructor(
    private env: Env,
    tenantId: string
  ) {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) {
      throw new Error('CloudflareStorageAdapter requires tenantId');
    }
    this.configuredTenantId = normalizedTenantId;
  }

  getConfiguredTenantId(): string {
    return this.configuredTenantId;
  }

  private getLegacySessionStoreStub(): SessionStoreRpcStub {
    const doId = this.env.SESSION_STORE.idFromName(
      buildDOInstanceName('session', this.getConfiguredTenantId())
    );
    return this.env.SESSION_STORE.get(doId) as unknown as SessionStoreRpcStub;
  }

  getExistingSessionStoreStub(sessionId: string): SessionStoreRpcStub {
    if (isRegionShardedSessionId(sessionId)) {
      return getSessionStoreBySessionId(this.env, sessionId, this.getConfiguredTenantId())
        .stub as unknown as SessionStoreRpcStub;
    }

    return this.getLegacySessionStoreStub();
  }

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
    const doStub = this.getExistingSessionStoreStub(sessionId);

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
    const doStub = this.getExistingSessionStoreStub(sessionId);

    await doStub.createSessionRpc(
      sessionId,
      sessionData.user_id,
      ttl || 86400, // Default: 24 hours
      sessionData.data,
      this.getConfiguredTenantId()
    );
  }

  /**
   * Delete from SessionStore Durable Object (RPC)
   */
  private async deleteFromSessionStore(key: string): Promise<void> {
    const sessionId = key.substring(8); // Remove 'session:' prefix
    const doStub = this.getExistingSessionStoreStub(sessionId);

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
    const updateResult = await this.env.DB.prepare('UPDATE kv_store SET data = ? WHERE key = ?')
      .bind(value, key)
      .run();
    if ((updateResult.meta?.changes ?? 0) > 0) {
      return;
    }

    try {
      await this.env.DB.prepare('INSERT INTO kv_store (key, data) VALUES (?, ?)')
        .bind(key, value)
        .run();
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      await this.env.DB.prepare('UPDATE kv_store SET data = ? WHERE key = ?')
        .bind(value, key)
        .run();
    }
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
    const doId = this.env.AUTH_CODE_STORE.idFromName(
      buildDOInstanceName('auth-code', this.getConfiguredTenantId())
    );
    const doStub = this.env.AUTH_CODE_STORE.get(doId);

    const exists = await doStub.hasCodeRpc(code);
    return exists ? JSON.stringify({ exists: true }) : null;
  }

  /**
   * Set to AuthCodeStore Durable Object (RPC)
   */
  private async setToAuthCodeStore(key: string, value: string, _ttl?: number): Promise<void> {
    const codeData = JSON.parse(value);
    const tenantId = this.getConfiguredTenantId();
    if (
      typeof codeData === 'object' &&
      codeData !== null &&
      'tenantId' in codeData &&
      codeData.tenantId !== tenantId
    ) {
      throw new Error('Auth code tenant mismatch');
    }
    const doId = this.env.AUTH_CODE_STORE.idFromName(buildDOInstanceName('auth-code', tenantId));
    const doStub = this.env.AUTH_CODE_STORE.get(doId);

    await doStub.storeCodeRpc({ ...codeData, tenantId });
  }

  /**
   * Delete from AuthCodeStore Durable Object (RPC)
   */
  private async deleteFromAuthCodeStore(key: string): Promise<void> {
    const code = key.substring(9); // Remove 'authcode:' prefix
    const doId = this.env.AUTH_CODE_STORE.idFromName(
      buildDOInstanceName('auth-code', this.getConfiguredTenantId())
    );
    const doStub = this.env.AUTH_CODE_STORE.get(doId);

    await doStub.deleteCodeRpc(code);
  }

  /**
   * Get from RefreshTokenRotator Durable Object (RPC)
   *
   * @deprecated Refresh token reads require userId/version/clientId/jti.
   * Legacy key-based access does not carry enough routing metadata for V3 sharding.
   */
  private async getFromRefreshTokenRotator(key: string): Promise<string | null> {
    throw new Error(
      `getFromRefreshTokenRotator called with ${key} - refresh token reads require userId/version/clientId/jti. ` +
        'Use getRefreshToken() from @authrim/ar-lib-core/utils/refresh-token-store instead.'
    );
  }

  /**
   * Set to RefreshTokenRotator Durable Object (RPC)
   *
   * V3: Supports sharding via storeRefreshToken() when the payload contains
   * RefreshTokenData fields (`jti`, `client_id`, `sub`, `scope`, `iat`, `exp`).
   */
  private async setToRefreshTokenRotator(key: string, value: string, ttl?: number): Promise<void> {
    const refreshTokenData = JSON.parse(value) as {
      jti?: string;
      client_id?: string;
      sub?: string;
      scope?: string;
      iat?: number;
      exp?: number;
    };

    if (
      !refreshTokenData.jti ||
      !refreshTokenData.client_id ||
      !refreshTokenData.sub ||
      typeof refreshTokenData.iat !== 'number' ||
      typeof refreshTokenData.exp !== 'number'
    ) {
      throw new Error(
        `setToRefreshTokenRotator called with ${key} - payload must include jti, client_id, sub, iat, exp. ` +
          'Use storeRefreshToken() compatible RefreshTokenData payloads.'
      );
    }

    if (ttl !== undefined) {
      log.debug(
        'setToRefreshTokenRotator ignores explicit TTL and uses configured refresh token expiry',
        {
          key,
        }
      );
    }

    await storeRefreshToken(
      this.env,
      refreshTokenData.jti,
      {
        jti: refreshTokenData.jti,
        client_id: refreshTokenData.client_id,
        sub: refreshTokenData.sub,
        scope: refreshTokenData.scope || '',
        iat: refreshTokenData.iat,
        exp: refreshTokenData.exp,
      },
      this.configuredTenantId
    );
  }

  /**
   * Delete from RefreshTokenRotator Durable Object (RPC)
   *
   * @deprecated Refresh token deletes require JTI and client_id.
   * Legacy key-based access does not carry enough routing metadata for V3 sharding.
   */
  private async deleteFromRefreshTokenRotator(key: string): Promise<void> {
    throw new Error(
      `deleteFromRefreshTokenRotator called with ${key} - refresh token deletes require jti + client_id. ` +
        'Use deleteRefreshToken() from @authrim/ar-lib-core/utils/refresh-token-store instead.'
    );
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

export class UserStore implements IUserStore {
  constructor(private adapter: CloudflareStorageAdapter) {}

  private createCoreAdapter(): DatabaseAdapter {
    const adapter = {
      query: <T>(sql: string, params?: unknown[]) => this.adapter.query<T>(sql, params),
      queryOne: async <T>(sql: string, params?: unknown[]) => {
        const rows = await this.adapter.query<T>(sql, params);
        return rows[0] ?? null;
      },
      execute: async (sql: string, params?: unknown[]) =>
        toExecuteResult(await this.adapter.execute(sql, params)),
      transaction: async <T>(fn: (tx: DatabaseAdapter) => Promise<T>) =>
        fn(this.createCoreAdapter()),
    };
    return adapter as unknown as DatabaseAdapter;
  }

  private createPiiAdapter(): DatabaseAdapter {
    const adapter = {
      query: <T>(sql: string, params?: unknown[]) => this.adapter.queryPII<T>(sql, params ?? []),
      queryOne: async <T>(sql: string, params?: unknown[]) => {
        const rows = await this.adapter.queryPII<T>(sql, params ?? []);
        return rows[0] ?? null;
      },
      execute: async (sql: string, params?: unknown[]) =>
        toExecuteResult(await this.adapter.executePII(sql, params ?? [])),
    };
    return adapter as unknown as DatabaseAdapter;
  }

  private createCanonicalStore(): CanonicalRuntimeUserStore {
    return new CanonicalRuntimeUserStore({
      coreAdapter: this.createCoreAdapter(),
      piiAdapter: this.createPiiAdapter(),
      tenantId: this.adapter.getConfiguredTenantId(),
    });
  }

  async get(userId: string): Promise<User | null> {
    const projection = await this.createCanonicalStore().findById(userId);
    return projection ? toRuntimeUser(projection) : null;
  }

  async getByEmail(
    email: string,
    _tenantId = this.adapter.getConfiguredTenantId()
  ): Promise<User | null> {
    const projection = await this.createCanonicalStore().findByEmail(email);
    return projection ? toRuntimeUser(projection) : null;
  }

  async create(
    user: Partial<User> & { tenant_id?: string; pii_partition?: string }
  ): Promise<User> {
    const id = crypto.randomUUID();
    await this.createCanonicalStore().syncUser({
      userId: id,
      email: user.email ?? null,
      name: user.name ?? null,
      active: user.is_active ?? true,
      emailVerified: user.email_verified ?? false,
      phoneNumberVerified: user.phone_number_verified ?? false,
      userType: 'end_user',
      passwordHash: user.password_hash ?? null,
      piiFields: {
        email: user.email !== undefined && user.email !== null,
        name: user.name !== undefined && user.name !== null,
        given_name: user.given_name !== undefined && user.given_name !== null,
        family_name: user.family_name !== undefined && user.family_name !== null,
        middle_name: user.middle_name !== undefined && user.middle_name !== null,
        nickname: user.nickname !== undefined && user.nickname !== null,
        preferred_username:
          user.preferred_username !== undefined && user.preferred_username !== null,
        profile: user.profile !== undefined && user.profile !== null,
        picture: user.picture !== undefined && user.picture !== null,
        website: user.website !== undefined && user.website !== null,
        gender: user.gender !== undefined && user.gender !== null,
        birthdate: user.birthdate !== undefined && user.birthdate !== null,
        zoneinfo: user.zoneinfo !== undefined && user.zoneinfo !== null,
        locale: user.locale !== undefined && user.locale !== null,
        phone_number: user.phone_number !== undefined && user.phone_number !== null,
      },
      sensitiveValues: {
        email: user.email ?? undefined,
        name: user.name ?? undefined,
        given_name: user.given_name ?? undefined,
        family_name: user.family_name ?? undefined,
        middle_name: user.middle_name ?? undefined,
        nickname: user.nickname ?? undefined,
        preferred_username: user.preferred_username ?? undefined,
        profile: user.profile ?? undefined,
        picture: user.picture ?? undefined,
        website: user.website ?? undefined,
        gender: user.gender ?? undefined,
        birthdate: user.birthdate ?? undefined,
        zoneinfo: user.zoneinfo ?? undefined,
        locale: user.locale ?? undefined,
        phone_number: user.phone_number ?? undefined,
      },
      addressJson: user.address ? JSON.stringify(user.address) : undefined,
      metadata: {
        ...(user.mfa_enabled !== undefined ? { mfa_enabled: user.mfa_enabled } : {}),
        ...(user.mfa_secret !== undefined ? { mfa_secret: user.mfa_secret } : {}),
        ...(user.is_locked !== undefined ? { is_locked: user.is_locked } : {}),
        ...(user.locked_until !== undefined ? { locked_until: user.locked_until } : {}),
        ...(user.failed_login_attempts !== undefined
          ? { failed_login_attempts: user.failed_login_attempts }
          : {}),
      },
    });
    const created = await this.get(id);
    if (!created) {
      throw new Error(`Failed to create canonical runtime user: ${id}`);
    }
    return created;
  }

  async update(userId: string, updates: Partial<User>): Promise<User> {
    const existing = await this.get(userId);
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    await this.createCanonicalStore().syncUser({
      userId,
      email: updates.email ?? existing.email,
      name: updates.name ?? existing.name ?? null,
      active: updates.is_active ?? existing.is_active,
      emailVerified: updates.email_verified ?? existing.email_verified,
      phoneNumberVerified: updates.phone_number_verified ?? existing.phone_number_verified,
      userType: 'end_user',
      passwordHash: updates.password_hash ?? existing.password_hash ?? null,
      piiFields: {
        email: updates.email !== undefined,
        name: updates.name !== undefined,
        given_name: updates.given_name !== undefined,
        family_name: updates.family_name !== undefined,
        middle_name: updates.middle_name !== undefined,
        nickname: updates.nickname !== undefined,
        preferred_username: updates.preferred_username !== undefined,
        profile: updates.profile !== undefined,
        picture: updates.picture !== undefined,
        website: updates.website !== undefined,
        gender: updates.gender !== undefined,
        birthdate: updates.birthdate !== undefined,
        zoneinfo: updates.zoneinfo !== undefined,
        locale: updates.locale !== undefined,
        phone_number: updates.phone_number !== undefined,
      },
      sensitiveValues: {
        ...(updates.email !== undefined ? { email: updates.email } : {}),
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.given_name !== undefined ? { given_name: updates.given_name } : {}),
        ...(updates.family_name !== undefined ? { family_name: updates.family_name } : {}),
        ...(updates.middle_name !== undefined ? { middle_name: updates.middle_name } : {}),
        ...(updates.nickname !== undefined ? { nickname: updates.nickname } : {}),
        ...(updates.preferred_username !== undefined
          ? { preferred_username: updates.preferred_username }
          : {}),
        ...(updates.profile !== undefined ? { profile: updates.profile } : {}),
        ...(updates.picture !== undefined ? { picture: updates.picture } : {}),
        ...(updates.website !== undefined ? { website: updates.website } : {}),
        ...(updates.gender !== undefined ? { gender: updates.gender } : {}),
        ...(updates.birthdate !== undefined ? { birthdate: updates.birthdate } : {}),
        ...(updates.zoneinfo !== undefined ? { zoneinfo: updates.zoneinfo } : {}),
        ...(updates.locale !== undefined ? { locale: updates.locale } : {}),
        ...(updates.phone_number !== undefined ? { phone_number: updates.phone_number } : {}),
      },
      addressJson: updates.address !== undefined ? JSON.stringify(updates.address) : undefined,
      metadata: {
        ...(updates.mfa_enabled !== undefined ? { mfa_enabled: updates.mfa_enabled } : {}),
        ...(updates.mfa_secret !== undefined ? { mfa_secret: updates.mfa_secret } : {}),
        ...(updates.is_locked !== undefined ? { is_locked: updates.is_locked } : {}),
        ...(updates.locked_until !== undefined ? { locked_until: updates.locked_until } : {}),
        ...(updates.failed_login_attempts !== undefined
          ? { failed_login_attempts: updates.failed_login_attempts }
          : {}),
      },
    });
    const updated = await this.get(userId);
    if (!updated) {
      throw new Error(`Failed to update canonical runtime user: ${userId}`);
    }
    return updated;
  }

  async delete(userId: string): Promise<void> {
    await this.createCanonicalStore().deleteUser(userId);
  }
}

/**
 * ClientStore implementation (D1 + KV cache)
 */
export class ClientStore implements IClientStore {
  constructor(private adapter: CloudflareStorageAdapter) {}

  async get(clientId: string): Promise<ClientData | null> {
    const tenantId = this.adapter.getConfiguredTenantId();
    const results = await this.adapter.query<ClientData>(
      'SELECT * FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
      [tenantId, clientId]
    );
    return results[0] || null;
  }

  async create(client: Partial<ClientData>): Promise<ClientData> {
    const now = Date.now(); // Store in milliseconds
    const tenantId =
      typeof client.tenant_id === 'string'
        ? client.tenant_id
        : this.adapter.getConfiguredTenantId();

    const newClient: ClientData = {
      tenant_id: tenantId,
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
        tenant_id, client_id, client_secret_hash, client_name, redirect_uris, grant_types,
        response_types, scope, subject_type, sector_identifier_uri,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
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
    const tenantId = this.adapter.getConfiguredTenantId();
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
      WHERE tenant_id = ? AND client_id = ?`,
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
        tenantId,
        clientId,
      ]
    );

    return updated;
  }

  async delete(clientId: string): Promise<void> {
    const tenantId = this.adapter.getConfiguredTenantId();
    await this.adapter.execute('DELETE FROM oauth_clients WHERE tenant_id = ? AND client_id = ?', [
      tenantId,
      clientId,
    ]);
  }

  async list(options?: { limit?: number; offset?: number }): Promise<ClientData[]> {
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;

    return await this.adapter.query<ClientData>(
      'SELECT * FROM oauth_clients WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [this.adapter.getConfiguredTenantId(), limit, offset]
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
    const doStub = this.adapter.getExistingSessionStoreStub(sessionId);

    // RPC call
    const session = await doStub.getSessionRpc(sessionId);
    return session;
  }

  async create(session: Partial<Session>): Promise<Session> {
    const now = Date.now();
    const ttl = session.expires_at ? Math.floor((session.expires_at - now) / 1000) : 86400;
    const resolved = session.id
      ? {
          stub: this.adapter.getExistingSessionStoreStub(session.id),
          sessionId: session.id,
        }
      : await getSessionStoreForNewSession(this.env, this.adapter.getConfiguredTenantId());

    // RPC call
    const result = await resolved.stub.createSessionRpc(
      resolved.sessionId,
      session.user_id!,
      ttl,
      session.data,
      this.adapter.getConfiguredTenantId()
    );
    return result as Session;
  }

  async delete(sessionId: string): Promise<void> {
    const doStub = this.adapter.getExistingSessionStoreStub(sessionId);

    // RPC call
    await doStub.invalidateSessionRpc(sessionId);
  }

  async listByUser(userId: string): Promise<Session[]> {
    throw new Error(
      `SessionStore.listByUser(${userId}) is not supported for region-sharded sessions ` +
        'without a user-session index.'
    );
  }

  async extend(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    const doStub = this.adapter.getExistingSessionStoreStub(sessionId);

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
      'SELECT * FROM passkeys WHERE tenant_id = ? AND credential_id = ?',
      [this.adapter.getConfiguredTenantId(), credentialId]
    );
    return results[0] || null;
  }

  async listByUser(userId: string): Promise<Passkey[]> {
    return await this.adapter.query<Passkey>(
      'SELECT * FROM passkeys WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC',
      [this.adapter.getConfiguredTenantId(), userId]
    );
  }

  async create(passkey: Partial<Passkey>): Promise<Passkey> {
    const id = crypto.randomUUID();
    const now = Date.now(); // Store in milliseconds
    const tenantId =
      typeof passkey.tenant_id === 'string'
        ? passkey.tenant_id
        : this.adapter.getConfiguredTenantId();

    const newPasskey: Passkey = {
      id,
      tenant_id: tenantId,
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
        id, tenant_id, user_id, credential_id, public_key, counter, transports,
        device_name, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newPasskey.id,
        tenantId,
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
    const tenantId = this.adapter.getConfiguredTenantId();

    // Retry loop for Compare-and-Swap (CAS) to handle concurrent updates
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // 1. Read current counter value
      const currentResults = await this.adapter.query<Passkey>(
        'SELECT * FROM passkeys WHERE tenant_id = ? AND id = ?',
        [tenantId, passkeyId]
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
        'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE tenant_id = ? AND id = ? AND counter = ?',
        [counter, now, tenantId, passkeyId, currentCounter]
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
    await this.adapter.execute('DELETE FROM passkeys WHERE tenant_id = ? AND id = ?', [
      this.adapter.getConfiguredTenantId(),
      passkeyId,
    ]);
  }
}

/**
 * Factory function to create CloudflareStorageAdapter with stores
 */
export function createStorageAdapter(
  env: Env,
  tenantId: string
): {
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
  const adapter = new CloudflareStorageAdapter(env, tenantId);

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
