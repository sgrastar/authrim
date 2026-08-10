/**
 * SessionStore Durable Object
 *
 * Manages active user sessions with Durable Object storage as the sole authority.
 * Provides instant session invalidation and ITP-compatible session management.
 *
 * Storage Architecture (v2):
 * - Individual key storage: `session:${sessionId}` for each session
 * - O(1) reads/writes per session operation
 * - Sharding support: Multiple DO instances distribute load
 *
 * Storage pattern:
 * 1. Active sessions stored in-memory for sub-millisecond access (hot)
 * 2. Durable Object storage survives actor eviction and restart
 * 3. Sessions are validated against the per-user SessionRevocationStore
 * 4. Expired sessions are cleaned up periodically
 *
 * Security Features:
 * - Instant session revocation (security requirement)
 * - Automatic expiration handling
 * - Multi-device session management
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import type { ActorContext } from '../actor';
import { CloudflareActorContext } from '../actor';
import { createLogger } from '../utils/logger';
import {
  getSessionRevocationStore,
  SESSION_REVOCATION_AUTHORITY,
} from '../services/session-revocation-store';

const log = createLogger().module('DO-SESSION-STORE');

/**
 * Session data interface
 */
export interface Session {
  id: string;
  tenantId?: string;
  userId: string;
  accountId: string;
  expiresAt: number;
  createdAt: number;
  revocationAuthority: typeof SESSION_REVOCATION_AUTHORITY;
  revocationBoundAtMs: number;
  data?: SessionData;
}

/**
 * Additional session metadata
 */
export interface SessionData {
  amr?: string[]; // Authentication Methods References
  acr?: string; // Authentication Context Class Reference
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
  /** ISO 3166-1 alpha-2 country captured from trusted edge metadata, when available */
  countryCode?: string;

  // Anonymous authentication (architecture-decisions.md §17)
  /** Whether this session belongs to an anonymous user */
  is_anonymous?: boolean;
  /** Whether the anonymous user can upgrade to registered */
  upgrade_eligible?: boolean;
  /** Device ID hash for anonymous sessions (for re-identification) */
  device_id_hash?: string;

  [key: string]: unknown;
}

/**
 * Session creation request
 */
export interface CreateSessionRequest {
  sessionId: string; // Required: Sharded session ID from session-helper
  tenantId: string;
  userId: string;
  ttl: number; // Time to live in seconds
  data?: SessionData;
}

/**
 * Session response (without sensitive data)
 */
export interface SessionResponse {
  id: string;
  tenantId?: string;
  userId: string;
  accountId: string;
  expiresAt: number;
  createdAt: number;
  data?: SessionData; // Include session data for OIDC conformance (authTime etc.)
}

/**
 * Storage key prefix for sessions
 */
const SESSION_KEY_PREFIX = 'session:';
const SESSION_STORE_TENANT_CONTEXT_KEY = 'meta:tenant-context';
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * SessionStore Durable Object
 *
 * Provides distributed session storage with strong consistency guarantees.
 * Uses individual key storage for O(1) operations.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., getSessionRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 */
export class SessionStore extends DurableObject<Env> {
  private sessionCache: Map<string, Session> = new Map();
  private actorCtx: ActorContext;
  private tenantId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.actorCtx = new CloudflareActorContext(ctx);

    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + SESSION_CLEANUP_INTERVAL_MS);
      }
    });
  }

  // ==========================================
  // RPC Methods (public, with 'Rpc' suffix)
  // ==========================================

  /**
   * RPC: Get session by ID
   */
  async getSessionRpc(sessionId: string): Promise<Session | null> {
    return this.getSession(sessionId);
  }

  /**
   * RPC: Create new session
   */
  async createSessionRpc(
    sessionId: string,
    userId: string,
    ttl: number,
    data: SessionData | undefined,
    tenantId: string
  ): Promise<Session> {
    return this.createSession(sessionId, userId, ttl, data, tenantId);
  }

  /**
   * RPC: Invalidate session immediately
   */
  async invalidateSessionRpc(sessionId: string): Promise<boolean> {
    return this.invalidateSession(sessionId);
  }

  /**
   * RPC: Batch invalidate multiple sessions
   */
  async invalidateSessionsBatchRpc(
    sessionIds: string[]
  ): Promise<{ deleted: number; failed: string[] }> {
    return this.invalidateSessionsBatch(sessionIds);
  }

  /**
   * RPC: List all active sessions for a user
   */
  async listUserSessionsRpc(userId: string): Promise<SessionResponse[]> {
    return this.listUserSessions(userId);
  }

  /**
   * RPC: Extend session expiration
   */
  async extendSessionRpc(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    return this.extendSession(sessionId, additionalSeconds);
  }

  /**
   * RPC: Update session data (merge with existing data)
   * Used for updating session metadata without changing userId or expiration
   */
  async updateSessionDataRpc(
    sessionId: string,
    dataUpdates: Partial<SessionData>
  ): Promise<Session | null> {
    return this.updateSessionData(sessionId, dataUpdates);
  }

  /**
   * RPC: Update session user ID
   * Used when anonymous user sub changes during upgrade (preserve_sub=false)
   */
  async updateSessionUserIdRpc(sessionId: string, newUserId: string): Promise<Session | null> {
    return this.updateSessionUserId(sessionId, newUserId);
  }

  /**
   * RPC: Get status/health check
   */
  async getStatusRpc(): Promise<{
    status: string;
    sessions: number;
    cached: number;
    timestamp: number;
  }> {
    const storedSessions = await this.actorCtx.storage.list<Session>({
      prefix: SESSION_KEY_PREFIX,
    });

    return {
      status: 'ok',
      sessions: storedSessions.size,
      cached: this.sessionCache.size,
      timestamp: Date.now(),
    };
  }

  // ==========================================
  // Internal Methods (private)
  // ==========================================

  /**
   * Build storage key for a session
   */
  private buildSessionKey(sessionId: string): string {
    return `${SESSION_KEY_PREFIX}${sessionId}`;
  }

  /**
   * Cleanup expired sessions from memory and Durable Storage
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    let cleanedSessions = 0;

    // Clean memory cache
    for (const [sessionId, session] of this.sessionCache.entries()) {
      if (session.expiresAt <= now) {
        this.sessionCache.delete(sessionId);
        // Delete from Durable Storage
        await this.actorCtx.storage.delete(this.buildSessionKey(sessionId));
        cleanedSessions++;
      }
    }

    // Also scan storage for expired sessions not in cache
    const storedSessions = await this.actorCtx.storage.list<Session>({
      prefix: SESSION_KEY_PREFIX,
    });

    for (const [key, session] of storedSessions) {
      if (session.expiresAt <= now) {
        await this.actorCtx.storage.delete(key);
        cleanedSessions++;
      }
    }

    if (cleanedSessions > 0) {
      log.info('Cleaned up expired sessions', { sessions: cleanedSessions });
    }
  }

  async alarm(): Promise<void> {
    await this.cleanupExpiredSessions();
    await this.ctx.storage.setAlarm(Date.now() + SESSION_CLEANUP_INTERVAL_MS);
  }

  /**
   * Check if session is expired
   */
  private isExpired(session: Session): boolean {
    return session.expiresAt <= Date.now();
  }

  private requireTenantId(tenantId: string | undefined, context: string): string {
    const normalized = tenantId?.trim();
    if (!normalized) {
      throw new Error(`${context} requires tenantId`);
    }
    return normalized;
  }

  private async setTenantContext(tenantId: string): Promise<void> {
    const normalizedTenantId = this.requireTenantId(tenantId, 'SessionStore tenant context');
    const currentTenantId = await this.ensureTenantContext();
    if (currentTenantId && currentTenantId !== normalizedTenantId) {
      throw new Error('SessionStore tenant context mismatch');
    }
    if (this.tenantId === normalizedTenantId) {
      return;
    }
    this.tenantId = normalizedTenantId;
    await this.actorCtx.storage.put(SESSION_STORE_TENANT_CONTEXT_KEY, normalizedTenantId);
  }

  private async ensureTenantContext(): Promise<string | undefined> {
    if (this.tenantId) {
      return this.tenantId;
    }

    const stored = await this.actorCtx.storage.get<string>(SESSION_STORE_TENANT_CONTEXT_KEY);
    if (stored) {
      this.tenantId = stored;
      return stored;
    }

    return undefined;
  }

  private async isRevokedByUserEpoch(session: Session): Promise<boolean> {
    const tenantId = this.requireTenantId(session.tenantId, 'Session revocation validation');
    if (session.accountId !== `account:${session.userId}`) {
      throw new Error('session_revocation_binding_invalid');
    }
    if (
      session.revocationAuthority !== SESSION_REVOCATION_AUTHORITY ||
      !Number.isSafeInteger(session.revocationBoundAtMs) ||
      session.revocationBoundAtMs < 1
    ) {
      throw new Error('session_revocation_binding_invalid');
    }

    let state: { revokedAfterMs: number | null; lifecycle: string | null };
    try {
      state = await getSessionRevocationStore(
        this.env,
        tenantId,
        session.userId
      ).getSessionValidationStateRpc(tenantId, session.userId, session.accountId);
    } catch (error) {
      log.error('Session revocation store lookup error', {}, error as Error);
      throw new Error('session_revocation_store_unavailable');
    }

    if (state.lifecycle !== null && state.lifecycle !== 'active') return true;
    return state.revokedAfterMs !== null && session.revocationBoundAtMs <= state.revokedAfterMs;
  }

  private async dropRevokedSession(session: Session): Promise<void> {
    this.sessionCache.delete(session.id);
    await this.actorCtx.storage.delete(this.buildSessionKey(session.id));
  }

  private async persistSession(session: Session): Promise<void> {
    await this.actorCtx.storage.put(this.buildSessionKey(session.id), session);
  }

  private unregisterSessionIndex(session: Session): void {
    const tenantId = this.requireTenantId(session.tenantId, 'Session index removal');
    this.ctx.waitUntil(
      getSessionRevocationStore(this.env, tenantId, session.userId)
        .unregisterSessionRpc(tenantId, session.userId, session.accountId, session.id)
        .catch((error) => {
          log.warn('Failed to remove asynchronous session index entry', {
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        })
    );
  }

  private async validateStoredSessionBinding(sessionId: string, session: Session): Promise<void> {
    const tenantId = await this.ensureTenantContext();
    if (!tenantId || session.id !== sessionId || session.tenantId !== tenantId) {
      throw new Error('session_storage_binding_invalid');
    }
  }

  /**
   * Get session by ID (cache → Durable Object storage)
   */
  async getSession(sessionId: string): Promise<Session | null> {
    // 1. Check in-memory cache (hot)
    let session = this.sessionCache.get(sessionId);
    if (session) {
      await this.validateStoredSessionBinding(sessionId, session);
      if (await this.isRevokedByUserEpoch(session)) {
        await this.dropRevokedSession(session);
        return null;
      }
      if (!this.isExpired(session)) {
        return session;
      }
      // Cleanup expired session
      this.sessionCache.delete(sessionId);
      await this.actorCtx.storage.delete(this.buildSessionKey(sessionId));
      return null;
    }

    // 2. Check Durable Storage
    const storedSession = await this.actorCtx.storage.get<Session>(this.buildSessionKey(sessionId));
    if (storedSession) {
      await this.validateStoredSessionBinding(sessionId, storedSession);
      if (await this.isRevokedByUserEpoch(storedSession)) {
        await this.dropRevokedSession(storedSession);
        return null;
      }
      if (!this.isExpired(storedSession)) {
        // Promote to cache
        this.sessionCache.set(sessionId, storedSession);
        return storedSession;
      }
      // Cleanup expired session
      await this.actorCtx.storage.delete(this.buildSessionKey(sessionId));
      return null;
    }

    return null;
  }

  /**
   * Create new session
   * Session ID must be provided by the caller (generated via session-helper)
   */
  async createSession(
    sessionId: string,
    userId: string,
    ttl: number,
    data: SessionData | undefined,
    tenantId: string
  ): Promise<Session> {
    const resolvedTenantId = this.requireTenantId(tenantId, 'Session creation');
    await this.setTenantContext(resolvedTenantId);

    const accountId = `account:${userId}`;
    const createdAt = Date.now();
    const expiresAt = createdAt + ttl * 1000;
    const revocationStore = getSessionRevocationStore(this.env, resolvedTenantId, userId);
    const registration = await revocationStore.registerSessionRpc(
      resolvedTenantId,
      userId,
      accountId,
      createdAt,
      sessionId,
      expiresAt,
      {
        ipAddress: data?.ipAddress,
        userAgent: data?.userAgent,
      }
    );
    const session: Session = {
      id: sessionId,
      tenantId: resolvedTenantId,
      userId,
      accountId,
      expiresAt,
      createdAt,
      revocationAuthority: SESSION_REVOCATION_AUTHORITY,
      revocationBoundAtMs: registration.revocationBoundAtMs,
      data,
    };

    // Promote only after the authoritative actor storage write succeeds. If that write fails,
    // compensate the cross-DO index registration so a nonexistent session is not listed.
    try {
      await this.persistSession(session);
    } catch (error) {
      try {
        await revocationStore.unregisterSessionRpc(resolvedTenantId, userId, accountId, sessionId);
      } catch (cleanupError) {
        log.warn('Failed to compensate session index registration', {
          error: cleanupError instanceof Error ? cleanupError.message : 'unknown_error',
        });
      }
      throw new Error('session_storage_write_failed', { cause: error });
    }
    this.sessionCache.set(sessionId, session);

    return session;
  }

  /**
   * Invalidate session immediately
   *
   * Durable Object storage is authoritative, so deletion cannot be undone by a D1 fallback.
   */
  async invalidateSession(sessionId: string): Promise<boolean> {
    const storageKey = this.buildSessionKey(sessionId);
    const session =
      this.sessionCache.get(sessionId) ?? (await this.actorCtx.storage.get<Session>(storageKey));
    const hadSession = Boolean(session);
    this.sessionCache.delete(sessionId);
    await this.actorCtx.storage.delete(storageKey);
    if (session) this.unregisterSessionIndex(session);
    return hadSession;
  }

  /**
   * Batch invalidate multiple sessions
   * Optimized for admin operations (e.g., delete all user sessions)
   *
   * Uses chunking to keep each storage operation bounded.
   */
  async invalidateSessionsBatch(
    sessionIds: string[]
  ): Promise<{ deleted: number; failed: string[] }> {
    const MAX_BATCH_SIZE = 1000;
    const failed: string[] = [];
    let deleted = 0;

    // Process in chunks to prevent timeout on large batches
    for (let i = 0; i < sessionIds.length; i += MAX_BATCH_SIZE) {
      const chunk = sessionIds.slice(i, i + MAX_BATCH_SIZE);
      const storageKeysToDelete: string[] = [];
      const sessionsToUnregister: Session[] = [];

      // Process each session in chunk - remove from cache and collect storage keys
      for (const sessionId of chunk) {
        const stored =
          this.sessionCache.get(sessionId) ??
          (await this.actorCtx.storage.get<Session>(this.buildSessionKey(sessionId)));
        if (stored) sessionsToUnregister.push(stored);
        // Remove from memory cache
        this.sessionCache.delete(sessionId);
        // Collect storage keys for batch delete
        storageKeysToDelete.push(this.buildSessionKey(sessionId));
      }

      // Batch delete from Durable Storage - delete() is idempotent
      try {
        if (storageKeysToDelete.length > 0) {
          await this.actorCtx.storage.deleteMany(storageKeysToDelete);
        }
        deleted += chunk.length;
        for (const session of sessionsToUnregister) this.unregisterSessionIndex(session);
      } catch (error) {
        log.error('Failed to delete chunk', { chunkIndex: i }, error as Error);
        failed.push(...chunk);
        continue;
      }
    }

    return {
      deleted,
      failed,
    };
  }

  /**
   * List all active sessions for a user
   * Note: In sharded mode, this only returns sessions in this shard
   */
  async listUserSessions(userId: string): Promise<SessionResponse[]> {
    const sessions: SessionResponse[] = [];
    const now = Date.now();

    // 1. Get from Durable Storage (individual keys)
    const storedSessions = await this.actorCtx.storage.list<Session>({
      prefix: SESSION_KEY_PREFIX,
    });

    for (const [, session] of storedSessions) {
      await this.validateStoredSessionBinding(session.id, session);
      if (
        session.userId === userId &&
        session.expiresAt > now &&
        !(await this.isRevokedByUserEpoch(session))
      ) {
        sessions.push({
          id: session.id,
          tenantId: session.tenantId,
          userId: session.userId,
          accountId: session.accountId,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt,
        });
      }
    }

    return sessions;
  }

  /**
   * Extend session expiration (Active TTL)
   */
  async extendSession(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    const current = await this.getSession(sessionId);
    if (!current) {
      return null;
    }

    const session = {
      ...current,
      expiresAt: current.expiresAt + additionalSeconds * 1000,
    };
    const tenantId = this.requireTenantId(current.tenantId, 'Session extension');
    let indexUpdated: boolean;
    try {
      indexUpdated = await getSessionRevocationStore(
        this.env,
        tenantId,
        current.userId
      ).updateSessionExpirationRpc(
        tenantId,
        current.userId,
        current.accountId,
        current.id,
        session.expiresAt
      );
    } catch (error) {
      log.error('Session index expiration update failed', {}, error as Error);
      throw new Error('session_revocation_store_unavailable');
    }
    if (!indexUpdated) throw new Error('session_revocation_index_missing');
    await this.persistSession(session);
    this.sessionCache.set(sessionId, session);

    return session;
  }

  /**
   * Update session data (merge with existing data)
   * Used for updating session metadata without changing userId or expiration
   */
  async updateSessionData(
    sessionId: string,
    dataUpdates: Partial<SessionData>
  ): Promise<Session | null> {
    const current = await this.getSession(sessionId);
    if (!current) {
      return null;
    }

    const session = {
      ...current,
      data: {
        ...current.data,
        ...dataUpdates,
      },
    };
    await this.actorCtx.storage.put(this.buildSessionKey(sessionId), session);
    this.sessionCache.set(sessionId, session);

    return session;
  }

  /**
   * Update session user ID
   * Used when anonymous user sub changes during upgrade (preserve_sub=false)
   */
  async updateSessionUserId(sessionId: string, newUserId: string): Promise<Session | null> {
    const current = await this.getSession(sessionId);
    if (!current) {
      return null;
    }

    const accountId = `account:${newUserId}`;
    const tenantId = this.requireTenantId(current.tenantId, 'Session user update');
    const registeredAt = Date.now();
    const revocationStore = getSessionRevocationStore(this.env, tenantId, newUserId);
    const registration = await revocationStore.registerSessionRpc(
      tenantId,
      newUserId,
      accountId,
      registeredAt,
      sessionId,
      current.expiresAt,
      {
        ipAddress: current.data?.ipAddress,
        userAgent: current.data?.userAgent,
      }
    );
    const session = {
      ...current,
      userId: newUserId,
      accountId,
      revocationAuthority: SESSION_REVOCATION_AUTHORITY,
      revocationBoundAtMs: registration.revocationBoundAtMs,
    };
    try {
      await this.persistSession(session);
    } catch (error) {
      try {
        await revocationStore.unregisterSessionRpc(tenantId, newUserId, accountId, sessionId);
      } catch (cleanupError) {
        log.warn('Failed to compensate updated session index registration', {
          error: cleanupError instanceof Error ? cleanupError.message : 'unknown_error',
        });
      }
      throw new Error('session_storage_write_failed', { cause: error });
    }
    this.sessionCache.set(sessionId, session);
    this.unregisterSessionIndex(current);

    log.info('Updated session user binding');

    return session;
  }

  /**
   * Sanitize session data for HTTP response (remove sensitive data)
   * Note: data field is included for OIDC conformance (authTime consistency)
   */
  private sanitizeSession(session: Session): SessionResponse {
    return {
      id: session.id,
      tenantId: session.tenantId,
      userId: session.userId,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      data: session.data, // Include data for OIDC conformance (prompt=none authTime consistency)
    };
  }

  /**
   * Handle HTTP requests to the SessionStore Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /session/:id - Get session by ID
      if (path.startsWith('/session/') && request.method === 'GET') {
        const sessionId = path.substring(9); // Remove '/session/'
        const session = await this.getSession(sessionId);

        if (!session) {
          return new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(this.sanitizeSession(session)), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /session - Create new session
      if (path === '/session' && request.method === 'POST') {
        const body = (await request.json()) as Partial<CreateSessionRequest>;

        if (!body.sessionId || !body.userId || !body.ttl || !body.tenantId) {
          return new Response(
            JSON.stringify({ error: 'Missing required fields: sessionId, userId, ttl, tenantId' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const session = await this.createSession(
          body.sessionId,
          body.userId,
          body.ttl,
          body.data,
          body.tenantId
        );

        return new Response(JSON.stringify(this.sanitizeSession(session)), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // DELETE /session/:id - Invalidate session
      if (path.startsWith('/session/') && request.method === 'DELETE') {
        const sessionId = path.substring(9);
        const deleted = await this.invalidateSession(sessionId);

        return new Response(
          JSON.stringify({
            success: true,
            deleted: deleted ? sessionId : null,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // POST /sessions/batch-delete - Batch invalidate multiple sessions
      if (path === '/sessions/batch-delete' && request.method === 'POST') {
        const body = (await request.json()) as { sessionIds?: string[] };

        if (!body.sessionIds || !Array.isArray(body.sessionIds)) {
          return new Response(
            JSON.stringify({ error: 'Missing required field: sessionIds (array)' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const result = await this.invalidateSessionsBatch(body.sessionIds);

        return new Response(
          JSON.stringify({
            success: true,
            deleted: result.deleted,
            failed: result.failed.length,
            failedIds: result.failed,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /sessions/user/:userId - List all sessions for user
      if (path.startsWith('/sessions/user/') && request.method === 'GET') {
        const userId = path.substring(15); // Remove '/sessions/user/'
        const sessions = await this.listUserSessions(userId);

        return new Response(JSON.stringify({ sessions }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /session/:id/extend - Extend session expiration
      if (path.match(/^\/session\/[^/]+\/extend$/) && request.method === 'POST') {
        const sessionId = path.split('/')[2];
        const body = (await request.json()) as { seconds?: number };

        if (!body.seconds || body.seconds <= 0) {
          return new Response(JSON.stringify({ error: 'Invalid seconds value' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const session = await this.extendSession(sessionId, body.seconds);

        if (!session) {
          return new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(this.sanitizeSession(session)), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /status - Health check and stats
      if (path === '/status' && request.method === 'GET') {
        // Count sessions in storage
        const storedSessions = await this.actorCtx.storage.list<Session>({
          prefix: SESSION_KEY_PREFIX,
        });

        return new Response(
          JSON.stringify({
            status: 'ok',
            sessions: storedSessions.size,
            cached: this.sessionCache.size,
            timestamp: Date.now(),
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      log.error('Request error', {}, error as Error);
      return new Response(
        JSON.stringify({
          error: 'Internal Server Error',
          // SECURITY: Do not expose internal error details in response
          message: 'An error occurred while processing the session',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }
}
