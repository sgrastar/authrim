/**
 * SessionStore Durable Object
 *
 * Manages active user sessions with in-memory hot data and D1 database fallback.
 * Provides instant session invalidation and ITP-compatible session management.
 *
 * Storage Architecture (v2):
 * - Individual key storage: `session:${sessionId}` for each session
 * - O(1) reads/writes per session operation
 * - Sharding support: Multiple DO instances distribute load
 *
 * Hot/Cold Pattern:
 * 1. Active sessions stored in-memory for sub-millisecond access (hot)
 * 2. Cold sessions loaded from D1 database on demand
 * 3. Sessions promoted to hot storage on access
 * 4. Expired sessions cleaned up periodically
 *
 * Security Features:
 * - Instant session revocation (security requirement)
 * - Automatic expiration handling
 * - Multi-device session management
 * - Audit trail via D1 storage
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { retryD1Operation } from '../utils/d1-retry';
import type { ActorContext } from '../actor';
import { CloudflareActorContext } from '../actor';
import { createLogger } from '../utils/logger';
import {
  AUTH_CORE_PERSISTENCE_CONTEXT_KEY,
  resolveAuthCorePersistenceContextFromEnv,
  resolveAuthCorePersistenceSourceFromContext,
  type AuthCorePersistenceContext,
} from '../services/auth-core-persistence-context';
import {
  createSessionPersistenceAdapter,
  type SessionPersistenceAdapter,
} from '../services/session-persistence';
import {
  resolveAccountCoreDataContext,
  resolveSessionAccountCoreDataContext,
} from '../services/runtime-data-context';

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
const SESSION_ROUTE_KEY_PREFIX = 'session-route:';
const SAFE_ROUTE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

interface SessionRouteHint {
  tenantId: string;
  accountId: string;
  expiresAt: number;
}

/**
 * Storage key prefix for tombstones (deleted session markers)
 * Used to prevent D1 fallback from returning stale sessions after deletion
 */
const TOMBSTONE_KEY_PREFIX = 'tombstone:';

/**
 * Tombstone TTL in milliseconds (24 hours)
 * After this period, tombstones are automatically cleaned up
 */
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_STORE_TENANT_CONTEXT_KEY = 'session-store:tenant-context';
const USER_SESSION_REVOCATION_CACHE_TTL_MS = 1000;

/**
 * Tombstone data interface
 */
interface Tombstone {
  deletedAt: number;
  expiresAt: number;
}

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
  private userSessionRevocationCache: Map<
    string,
    { revokedAfterMs: number | null; checkedAtMs: number }
  > = new Map();
  private cleanupInterval: number | null = null;
  private actorCtx: ActorContext;
  private sessionPersistence: SessionPersistenceAdapter | null = null;
  private persistenceContext: AuthCorePersistenceContext | null = null;
  private tenantId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.actorCtx = new CloudflareActorContext(ctx);

    // Start periodic cleanup
    this.startCleanup();
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

  private buildSessionRouteKey(sessionId: string): string {
    return `${SESSION_ROUTE_KEY_PREFIX}${sessionId}`;
  }

  private routeForSession(session: Session): SessionRouteHint {
    const tenantId = this.requireTenantId(session.tenantId, 'Session route');
    const expectedAccountId = `account:${session.userId}`;
    if (
      !SAFE_ROUTE_ID.test(tenantId) ||
      !SAFE_ROUTE_ID.test(expectedAccountId) ||
      session.accountId !== expectedAccountId ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt < 1
    ) {
      throw new Error('session_identity_invalid');
    }
    return {
      tenantId,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
    };
  }

  private async getSessionRoute(sessionId: string): Promise<SessionRouteHint | null> {
    const route = await this.actorCtx.storage.get<SessionRouteHint>(
      this.buildSessionRouteKey(sessionId)
    );
    if (!route) return null;
    if (
      !SAFE_ROUTE_ID.test(route.tenantId ?? '') ||
      !SAFE_ROUTE_ID.test(route.accountId ?? '') ||
      !route.accountId.startsWith('account:') ||
      !Number.isSafeInteger(route.expiresAt) ||
      route.expiresAt < 1
    ) {
      throw new Error('session_route_hint_invalid');
    }
    return route;
  }

  /**
   * Build storage key for a tombstone
   */
  private buildTombstoneKey(sessionId: string): string {
    return `${TOMBSTONE_KEY_PREFIX}${sessionId}`;
  }

  /**
   * Create a tombstone for a deleted session
   * Tombstones prevent D1 fallback from returning stale sessions after deletion
   * This is critical for OIDC RP-Initiated Logout security
   */
  private async createTombstone(
    sessionId: string,
    route: SessionRouteHint | null = null
  ): Promise<void> {
    const now = Date.now();
    const tombstone: Tombstone = {
      deletedAt: now,
      expiresAt: Math.max(now + TOMBSTONE_TTL_MS, route?.expiresAt ?? 0),
    };
    await this.actorCtx.storage.put(this.buildTombstoneKey(sessionId), tombstone);
    log.debug('Created tombstone for session', { sessionId });
  }

  /**
   * Create tombstones for multiple deleted sessions (batch)
   */
  private async createTombstonesBatch(
    sessionIds: string[],
    routes: ReadonlyMap<string, SessionRouteHint | null>
  ): Promise<void> {
    if (sessionIds.length === 0) return;

    const now = Date.now();
    // Create tombstones individually (actor abstraction doesn't support batch put)
    for (const sessionId of sessionIds) {
      const expiresAt = Math.max(now + TOMBSTONE_TTL_MS, routes.get(sessionId)?.expiresAt ?? 0);
      await this.actorCtx.storage.put(this.buildTombstoneKey(sessionId), {
        deletedAt: now,
        expiresAt,
      } as Tombstone);
    }
    log.debug('Created tombstones', { count: sessionIds.length });
  }

  /**
   * Check if a tombstone exists for a session
   * Returns true if the session has been deleted and should not be loaded from D1
   */
  private async hasTombstone(sessionId: string): Promise<boolean> {
    const tombstone = await this.actorCtx.storage.get<Tombstone>(this.buildTombstoneKey(sessionId));
    if (!tombstone) {
      return false;
    }
    // Tombstone exists and is not expired
    if (tombstone.expiresAt > Date.now()) {
      return true;
    }
    // Tombstone expired, clean it up
    await this.actorCtx.storage.delete(this.buildTombstoneKey(sessionId));
    return false;
  }

  /**
   * Cleanup expired tombstones
   */
  private async cleanupTombstones(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    const tombstones = await this.actorCtx.storage.list<Tombstone>({
      prefix: TOMBSTONE_KEY_PREFIX,
    });

    const keysToDelete: string[] = [];
    for (const [key, tombstone] of tombstones) {
      if (tombstone.expiresAt <= now) {
        keysToDelete.push(key);
        cleaned++;
      }
    }

    if (keysToDelete.length > 0) {
      await this.actorCtx.storage.deleteMany(keysToDelete);
    }

    return cleaned;
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  private startCleanup(): void {
    // Cleanup every 5 minutes
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(
        () => {
          void this.cleanupExpiredSessions();
        },
        5 * 60 * 1000
      ) as unknown as number;
    }
  }

  /**
   * Cleanup expired sessions from memory and Durable Storage
   * Also cleans up expired tombstones
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    let cleanedSessions = 0;

    // Clean memory cache
    for (const [sessionId, session] of this.sessionCache.entries()) {
      if (session.expiresAt <= now) {
        this.sessionCache.delete(sessionId);
        // Delete from Durable Storage
        await this.actorCtx.storage.deleteMany([
          this.buildSessionKey(sessionId),
          this.buildSessionRouteKey(sessionId),
        ]);
        cleanedSessions++;
      }
    }

    // Also scan storage for expired sessions not in cache
    const storedSessions = await this.actorCtx.storage.list<Session>({
      prefix: SESSION_KEY_PREFIX,
    });

    for (const [key, session] of storedSessions) {
      if (session.expiresAt <= now) {
        await this.actorCtx.storage.deleteMany([key, this.buildSessionRouteKey(session.id)]);
        cleanedSessions++;
      }
    }

    const storedRoutes = await this.actorCtx.storage.list<SessionRouteHint>({
      prefix: SESSION_ROUTE_KEY_PREFIX,
    });
    const expiredRouteKeys = Array.from(storedRoutes.entries())
      .filter(([, route]) => route.expiresAt <= now)
      .map(([key]) => key);
    if (expiredRouteKeys.length > 0) {
      await this.actorCtx.storage.deleteMany(expiredRouteKeys);
    }

    // Clean expired tombstones
    const cleanedTombstones = await this.cleanupTombstones();

    if (cleanedSessions > 0 || cleanedTombstones > 0) {
      log.info('Cleaned up expired sessions and tombstones', {
        sessions: cleanedSessions,
        tombstones: cleanedTombstones,
      });
    }
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
    this.sessionPersistence = null;
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

  /**
   * Load session from cold persistence
   * Checks for tombstones first to prevent returning deleted sessions
   * This is critical for OIDC RP-Initiated Logout security
   */
  private async loadFromPersistence(sessionId: string): Promise<Session | null> {
    // Check for tombstone first - if exists, session was deleted
    // This prevents cold persistence from returning stale sessions after logout
    if (await this.hasTombstone(sessionId)) {
      log.debug('Tombstone found for session, skipping persistence load', { sessionId });
      return null;
    }

    const route = await this.getSessionRoute(sessionId);
    const persistence = await this.persistenceForRoute(route);
    if (!persistence) {
      return null;
    }

    try {
      const result = await persistence.loadSession(sessionId, Date.now());
      if (
        result &&
        route &&
        (result.tenantId !== route.tenantId || result.accountId !== route.accountId)
      ) {
        throw new Error('session_persistence_route_mismatch');
      }
      return result;
    } catch (error) {
      log.error('Persistence load error', { sessionId }, error as Error);
      return null;
    }
  }

  private async getUserSessionsRevokedAfter(session: Session): Promise<number | null> {
    const now = Date.now();
    const userId = session.userId;
    const cached = this.userSessionRevocationCache.get(userId);
    if (cached && now - cached.checkedAtMs < USER_SESSION_REVOCATION_CACHE_TTL_MS) {
      return cached.revokedAfterMs;
    }

    const context = await this.ensurePersistenceContext();
    if (
      context.transientAuth?.sessionColdPersistence !== 'disabled' &&
      context.storageProfileId === 'builtin:storage:tenant-d1'
    ) {
      const route = this.routeForSession(session);
      const resolved = await resolveSessionAccountCoreDataContext(this.env, {
        tenantId: route.tenantId,
        accountId: route.accountId,
        userId,
        nowMs: now,
      });
      if (resolved.tenantId !== route.tenantId || resolved.accountId !== route.accountId) {
        throw new Error('session_account_route_mismatch');
      }
      this.userSessionRevocationCache.set(userId, {
        revokedAfterMs: resolved.revokedAfterMs,
        checkedAtMs: now,
      });
      return resolved.revokedAfterMs;
    }

    const persistence = await this.persistenceForRoute(this.routeForSession(session));
    if (!persistence) {
      return null;
    }

    try {
      const revokedAfterMs = await persistence.getUserSessionsRevokedAfter(userId);
      this.userSessionRevocationCache.set(userId, { revokedAfterMs, checkedAtMs: now });
      return revokedAfterMs;
    } catch (error) {
      log.error('Session revocation epoch lookup error', { userId }, error as Error);
      throw new Error('session_revocation_epoch_unavailable');
    }
  }

  private async isRevokedByUserEpoch(session: Session): Promise<boolean> {
    const revokedAfterMs = await this.getUserSessionsRevokedAfter(session);
    return revokedAfterMs !== null && session.createdAt <= revokedAfterMs;
  }

  private async dropRevokedSession(session: Session): Promise<void> {
    this.sessionCache.delete(session.id);
    const route = this.routeForSession(session);
    await this.actorCtx.storage.deleteMany([
      this.buildSessionKey(session.id),
      this.buildSessionRouteKey(session.id),
    ]);
    await this.createTombstone(session.id, route);
  }

  private waitUntilPersistence(
    operation: Promise<void>,
    message: string,
    metadata: Record<string, unknown>
  ): void {
    this.ctx.waitUntil(
      operation.catch((error) => {
        log.error(message, metadata, error as Error);
      })
    );
  }

  private async persistSessionAndRoute(session: Session): Promise<void> {
    const route = this.routeForSession(session);
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(this.buildSessionRouteKey(session.id), route);
      await transaction.put(this.buildSessionKey(session.id), session);
    });
  }

  /**
   * Save session to cold persistence
   * Uses retry logic with exponential backoff for reliability
   */
  private async saveToPersistence(session: Session): Promise<void> {
    const persistence = await this.persistenceForRoute(this.routeForSession(session));
    if (!persistence) {
      return;
    }

    await retryD1Operation(
      () =>
        persistence.saveSession({
          id: session.id,
          tenantId: session.tenantId,
          userId: session.userId,
          accountId: session.accountId,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt,
        }),
      'SessionStore.saveToPersistence',
      { maxRetries: 3 }
    );
  }

  /**
   * Delete session from cold persistence
   * Uses retry logic with exponential backoff for reliability
   */
  private async deleteFromPersistence(
    sessionId: string,
    route: SessionRouteHint | null
  ): Promise<void> {
    const persistence = await this.persistenceForRoute(route);
    if (!persistence) {
      return;
    }

    await retryD1Operation(
      () => persistence.deleteSession(sessionId),
      'SessionStore.deleteFromPersistence',
      { maxRetries: 3 }
    );
  }

  /**
   * Get session by ID (cache → storage → D1 fallback)
   */
  async getSession(sessionId: string): Promise<Session | null> {
    // 1. Check in-memory cache (hot)
    let session = this.sessionCache.get(sessionId);
    if (session) {
      if (await this.isRevokedByUserEpoch(session)) {
        await this.dropRevokedSession(session);
        return null;
      }
      if (!this.isExpired(session)) {
        return session;
      }
      // Cleanup expired session
      this.sessionCache.delete(sessionId);
      await this.actorCtx.storage.deleteMany([
        this.buildSessionKey(sessionId),
        this.buildSessionRouteKey(sessionId),
      ]);
      return null;
    }

    // 2. Check Durable Storage
    const storedSession = await this.actorCtx.storage.get<Session>(this.buildSessionKey(sessionId));
    if (storedSession) {
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
      await this.actorCtx.storage.deleteMany([
        this.buildSessionKey(sessionId),
        this.buildSessionRouteKey(sessionId),
      ]);
      return null;
    }

    // 3. Check cold persistence with timeout
    try {
      const persistedSession = await Promise.race([
        this.loadFromPersistence(sessionId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);

      if (persistedSession && !this.isExpired(persistedSession)) {
        if (await this.isRevokedByUserEpoch(persistedSession)) {
          await this.dropRevokedSession(persistedSession);
          return null;
        }
        // Promote to cache and storage
        this.sessionCache.set(sessionId, persistedSession);
        await this.actorCtx.storage.put(this.buildSessionKey(sessionId), persistedSession);
        return persistedSession;
      }
    } catch (error) {
      log.error('Persistence fallback error', { sessionId }, error as Error);
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

    const session: Session = {
      id: sessionId,
      tenantId: resolvedTenantId,
      userId,
      accountId: `account:${userId}`,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Commit the route and session together so neither can expose partial state.
    await this.persistSessionAndRoute(session);

    // 3. Promote only a durably stored session to the hot cache.
    this.sessionCache.set(sessionId, session);

    // 4. Persist to cold storage (backup & audit) without shortening the DO event lifetime.
    this.waitUntilPersistence(this.saveToPersistence(session), 'Failed to save to persistence', {
      sessionId,
    });

    return session;
  }

  /**
   * Invalidate session immediately
   *
   * Optimized: No read-before-delete pattern.
   * storage.delete() is idempotent and works safely on non-existent keys.
   *
   * Security: Creates tombstone if D1 deletion fails to prevent stale sessions
   * from being loaded via D1 fallback (OIDC RP-Initiated Logout protection)
   */
  async invalidateSession(sessionId: string): Promise<boolean> {
    let route: SessionRouteHint | null = null;
    let routeReadFailed = false;
    try {
      route = await this.getSessionRoute(sessionId);
    } catch {
      routeReadFailed = true;
    }

    // 1. Remove from memory cache
    const hadSession = this.sessionCache.has(sessionId);
    this.sessionCache.delete(sessionId);

    // 2. Delete from Durable Storage (individual key - O(1))
    // No need to check existence first - delete() is idempotent
    const storageKey = this.buildSessionKey(sessionId);
    await this.actorCtx.storage.delete(storageKey);

    // 3. Delete from cold persistence - MUST await to prevent race condition
    // Without await, getSession could still find the session in cold persistence
    // before the deletion completes, causing prompt=none to succeed
    // when it should fail with login_required (OIDC RP-Initiated Logout)
    let persistenceDeleteFailed = false;
    try {
      if (routeReadFailed) throw new Error('session_route_hint_invalid');
      await this.deleteFromPersistence(sessionId, route);
      await this.actorCtx.storage.delete(this.buildSessionRouteKey(sessionId));
    } catch (error) {
      log.error('Failed to delete from persistence', { sessionId }, error as Error);
      persistenceDeleteFailed = true;
    }

    // 4. Create tombstone if persistence deletion failed
    // This prevents cold persistence fallback from returning stale sessions
    // Critical for OIDC RP-Initiated Logout security
    if (persistenceDeleteFailed) {
      try {
        await this.createTombstone(sessionId, route);
      } catch (tombstoneError) {
        log.error(
          'CRITICAL - Failed to create tombstone for session',
          { sessionId },
          tombstoneError as Error
        );
        // This is a critical error - session may be resurrected via persistence fallback
        // In production, this should trigger an alert
      }
    }

    // Return based on cache only - sufficient for logging/debugging purposes
    return hadSession;
  }

  /**
   * Batch invalidate multiple sessions
   * Optimized for admin operations (e.g., delete all user sessions)
   *
   * Optimized: No read-before-delete pattern. Uses batch delete for efficiency.
   * Uses chunking to prevent timeout on large batches.
   *
   * Security: Creates tombstones if D1 deletion fails to prevent stale sessions
   * from being loaded via D1 fallback (OIDC RP-Initiated Logout protection)
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
      const routes = new Map<string, SessionRouteHint | null>();

      // Process each session in chunk - remove from cache and collect storage keys
      for (const sessionId of chunk) {
        try {
          routes.set(sessionId, await this.getSessionRoute(sessionId));
        } catch {
          routes.set(sessionId, null);
        }
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
      } catch (error) {
        log.error('Failed to delete chunk', { chunkIndex: i }, error as Error);
        failed.push(...chunk);
        continue;
      }

      // Delete from cold persistence in batch - MUST await to prevent race condition
      if (chunk.length > 0) {
        try {
          await this.batchDeleteFromPersistence(chunk, routes);
          await this.actorCtx.storage.deleteMany(
            chunk.map((sessionId) => this.buildSessionRouteKey(sessionId))
          );
        } catch (error) {
          log.error(
            'Failed to batch delete from persistence',
            { count: chunk.length },
            error as Error
          );
          try {
            await this.createTombstonesBatch(chunk, routes);
          } catch (tombstoneError) {
            log.error(
              'CRITICAL - Failed to create tombstones',
              { count: chunk.length },
              tombstoneError as Error
            );
          }
        }
      }
    }

    return {
      deleted,
      failed,
    };
  }

  /**
   * Batch delete sessions from cold persistence
   * Uses a single SQL statement with IN clause for efficiency
   */
  private async batchDeleteFromPersistence(
    sessionIds: string[],
    routes: ReadonlyMap<string, SessionRouteHint | null>
  ): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    const context = await this.ensurePersistenceContext();
    if (context.transientAuth?.sessionColdPersistence === 'disabled') return;
    if (context.storageProfileId === 'builtin:storage:tenant-d1') {
      for (const sessionId of sessionIds) {
        const route = routes.get(sessionId) ?? null;
        const persistence = await this.persistenceForRoute(route);
        if (!persistence) continue;
        await retryD1Operation(
          () => persistence.deleteSession(sessionId),
          'SessionStore.deleteAccountSessionFromPersistence',
          { maxRetries: 3 }
        );
      }
      return;
    }

    const persistence = await this.persistenceForRoute(null);
    if (!persistence) {
      return;
    }

    await retryD1Operation(
      () => persistence.batchDeleteSessions(sessionIds),
      'SessionStore.batchDeleteFromPersistence',
      { maxRetries: 3 }
    );
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
      if (session.userId === userId && session.expiresAt > now) {
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

    // 2. Get from cold persistence - optional, for audit/completeness
    const tenantId = await this.ensureTenantContext();
    const persistence = await this.persistenceForRoute(
      tenantId
        ? {
            tenantId,
            accountId: `account:${userId}`,
            expiresAt: now + 1,
          }
        : null
    );
    if (persistence) {
      try {
        const result = await persistence.listUserSessions(userId, now);
        const existingIds = new Set(sessions.map((s) => s.id));
        for (const row of result) {
          if (!existingIds.has(row.id)) {
            sessions.push({
              id: row.id,
              tenantId: row.tenantId,
              userId: row.userId,
              accountId: row.accountId,
              expiresAt: row.expiresAt,
              createdAt: row.createdAt,
            });
          }
        }
      } catch (error) {
        log.error('Persistence list error', { userId }, error as Error);
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
    await this.persistSessionAndRoute(session);
    this.sessionCache.set(sessionId, session);

    // Update in cold persistence - async
    this.waitUntilPersistence(
      this.saveToPersistence(session),
      'Failed to extend session in persistence',
      { sessionId }
    );

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
   * NOTE: D1 does not store full session data, only basic fields
   */
  async updateSessionUserId(sessionId: string, newUserId: string): Promise<Session | null> {
    const current = await this.getSession(sessionId);
    if (!current) {
      return null;
    }

    const oldUserId = current.userId;
    const session = {
      ...current,
      userId: newUserId,
      accountId: `account:${newUserId}`,
    };
    await this.persistSessionAndRoute(session);
    this.sessionCache.set(sessionId, session);

    // Upsert into the new account route. Any old mirror is inert because cold loads verify
    // the route account and it expires with the original session TTL.
    this.waitUntilPersistence(
      this.saveToPersistence(session),
      'Failed to update user_id in persistence',
      { sessionId, newUserId }
    );

    log.info('Updated session user', { sessionId, oldUserId, newUserId });

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

  private async ensurePersistenceContext(): Promise<AuthCorePersistenceContext> {
    if (this.persistenceContext) {
      return this.persistenceContext;
    }

    const stored = await this.actorCtx.storage.get<AuthCorePersistenceContext>(
      AUTH_CORE_PERSISTENCE_CONTEXT_KEY
    );
    if (stored) {
      this.persistenceContext = stored;
      return stored;
    }

    const resolved = await resolveAuthCorePersistenceContextFromEnv(this.env);
    await this.actorCtx.storage.put(AUTH_CORE_PERSISTENCE_CONTEXT_KEY, resolved);
    this.persistenceContext = resolved;
    return resolved;
  }

  private async persistenceForRoute(
    route: SessionRouteHint | null
  ): Promise<SessionPersistenceAdapter | null> {
    const context = await this.ensurePersistenceContext();
    if (context.transientAuth?.sessionColdPersistence === 'disabled') return null;
    if (context.storageProfileId !== 'builtin:storage:tenant-d1') {
      return this.ensureSessionPersistence();
    }
    if (!route) throw new Error('session_account_route_required');
    const actorTenantId = await this.ensureTenantContext();
    if (!actorTenantId || actorTenantId !== route.tenantId) {
      throw new Error('session_route_tenant_mismatch');
    }
    const account = await resolveAccountCoreDataContext(this.env, {
      tenantId: route.tenantId,
      accountId: route.accountId,
    });
    if (account.tenantId !== route.tenantId || account.accountId !== route.accountId) {
      throw new Error('session_account_route_mismatch');
    }
    return createSessionPersistenceAdapter(account.coreDb, 'session-store-account', route.tenantId);
  }

  private async initializeSessionPersistence(): Promise<SessionPersistenceAdapter | null> {
    const context = await this.ensurePersistenceContext();
    if (context.transientAuth?.sessionColdPersistence === 'disabled') {
      return null;
    }

    const source = resolveAuthCorePersistenceSourceFromContext(this.env, context);
    const tenantId = await this.ensureTenantContext();
    if (!tenantId) {
      throw new Error('Session persistence requires tenant context');
    }
    return createSessionPersistenceAdapter(source, 'session-store', tenantId);
  }

  private async ensureSessionPersistence(): Promise<SessionPersistenceAdapter | null> {
    if (this.sessionPersistence) {
      return this.sessionPersistence;
    }

    this.sessionPersistence = await this.initializeSessionPersistence();
    return this.sessionPersistence;
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
