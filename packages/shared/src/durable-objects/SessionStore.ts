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

/**
 * Session data interface
 */
export interface Session {
  id: string;
  userId: string;
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
  [key: string]: unknown;
}

/**
 * Session creation request
 */
export interface CreateSessionRequest {
  sessionId: string; // Required: Sharded session ID from session-helper
  userId: string;
  ttl: number; // Time to live in seconds
  data?: SessionData;
}

/**
 * Session response (without sensitive data)
 */
export interface SessionResponse {
  id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  data?: SessionData; // Include session data for OIDC conformance (authTime etc.)
}

/**
 * Storage key prefix for sessions
 */
const SESSION_KEY_PREFIX = 'session:';

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
  private cleanupInterval: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

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
    data?: SessionData
  ): Promise<Session> {
    return this.createSession(sessionId, userId, ttl, data);
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
   * RPC: Get status/health check
   */
  async getStatusRpc(): Promise<{
    status: string;
    sessions: number;
    cached: number;
    timestamp: number;
  }> {
    const storedSessions = await this.ctx.storage.list<Session>({
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
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    // Clean memory cache
    for (const [sessionId, session] of this.sessionCache.entries()) {
      if (session.expiresAt <= now) {
        this.sessionCache.delete(sessionId);
        // Delete from Durable Storage
        await this.ctx.storage.delete(this.buildSessionKey(sessionId));
        cleaned++;
      }
    }

    // Also scan storage for expired sessions not in cache
    const storedSessions = await this.ctx.storage.list<Session>({
      prefix: SESSION_KEY_PREFIX,
    });

    for (const [key, session] of storedSessions) {
      if (session.expiresAt <= now) {
        await this.ctx.storage.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`SessionStore: Cleaned up ${cleaned} expired sessions`);
    }
  }

  /**
   * Check if session is expired
   */
  private isExpired(session: Session): boolean {
    return session.expiresAt <= Date.now();
  }

  /**
   * Load session from D1 database (cold storage)
   */
  private async loadFromD1(sessionId: string): Promise<Session | null> {
    if (!this.env.DB) {
      return null;
    }

    try {
      const result = await this.env.DB.prepare(
        'SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = ? AND expires_at > ?'
      )
        .bind(sessionId, Math.floor(Date.now() / 1000))
        .first();

      if (!result) {
        return null;
      }

      return {
        id: result.id as string,
        userId: result.user_id as string,
        expiresAt: (result.expires_at as number) * 1000, // Convert to milliseconds
        createdAt: (result.created_at as number) * 1000,
      };
    } catch (error) {
      console.error('SessionStore: D1 load error:', error);
      return null;
    }
  }

  /**
   * Save session to D1 database (persistent storage)
   * Uses retry logic with exponential backoff for reliability
   */
  private async saveToD1(session: Session): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    await retryD1Operation(
      async () => {
        await this.env.DB.prepare(
          'INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
        )
          .bind(
            session.id,
            session.userId,
            Math.floor(session.expiresAt / 1000), // Convert to seconds
            Math.floor(session.createdAt / 1000)
          )
          .run();
      },
      'SessionStore.saveToD1',
      { maxRetries: 3 }
    );
  }

  /**
   * Delete session from D1 database
   * Uses retry logic with exponential backoff for reliability
   */
  private async deleteFromD1(sessionId: string): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    await retryD1Operation(
      async () => {
        await this.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      },
      'SessionStore.deleteFromD1',
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
      if (!this.isExpired(session)) {
        return session;
      }
      // Cleanup expired session
      this.sessionCache.delete(sessionId);
      await this.ctx.storage.delete(this.buildSessionKey(sessionId));
      return null;
    }

    // 2. Check Durable Storage
    const storedSession = await this.ctx.storage.get<Session>(this.buildSessionKey(sessionId));
    if (storedSession) {
      if (!this.isExpired(storedSession)) {
        // Promote to cache
        this.sessionCache.set(sessionId, storedSession);
        return storedSession;
      }
      // Cleanup expired session
      await this.ctx.storage.delete(this.buildSessionKey(sessionId));
      return null;
    }

    // 3. Check D1 (cold) with timeout
    try {
      const d1Session = await Promise.race([
        this.loadFromD1(sessionId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);

      if (d1Session && !this.isExpired(d1Session)) {
        // Promote to cache and storage
        this.sessionCache.set(sessionId, d1Session);
        await this.ctx.storage.put(this.buildSessionKey(sessionId), d1Session);
        return d1Session;
      }
    } catch (error) {
      console.error('SessionStore: D1 fallback error:', error);
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
    data?: SessionData
  ): Promise<Session> {
    const session: Session = {
      id: sessionId,
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Store in memory cache (hot)
    this.sessionCache.set(sessionId, session);

    // 2. Persist to Durable Storage (individual key - O(1))
    await this.ctx.storage.put(this.buildSessionKey(sessionId), session);

    // 3. Persist to D1 (backup & audit) - async, don't wait
    this.saveToD1(session).catch((error) => {
      console.error('SessionStore: Failed to save to D1:', error);
    });

    return session;
  }

  /**
   * Invalidate session immediately
   */
  async invalidateSession(sessionId: string): Promise<boolean> {
    // 1. Remove from memory cache
    const hadSession = this.sessionCache.has(sessionId);
    this.sessionCache.delete(sessionId);

    // 2. Delete from Durable Storage (individual key - O(1))
    const storageKey = this.buildSessionKey(sessionId);
    const storedSession = await this.ctx.storage.get<Session>(storageKey);
    const hadStoredSession = storedSession !== undefined;
    await this.ctx.storage.delete(storageKey);

    // 3. Delete from D1 - MUST await to prevent race condition
    // Without await, getSession could still find the session in D1
    // before the deletion completes, causing prompt=none to succeed
    // when it should fail with login_required (OIDC RP-Initiated Logout)
    try {
      await this.deleteFromD1(sessionId);
    } catch (error) {
      console.error('SessionStore: Failed to delete from D1:', error);
      // Continue even if D1 deletion fails - memory and Durable Storage are authoritative
    }

    return hadSession || hadStoredSession;
  }

  /**
   * Batch invalidate multiple sessions
   * Optimized for admin operations (e.g., delete all user sessions)
   */
  async invalidateSessionsBatch(
    sessionIds: string[]
  ): Promise<{ deleted: number; failed: string[] }> {
    const deleted: string[] = [];
    const failed: string[] = [];

    // Process each session
    for (const sessionId of sessionIds) {
      // Check if session exists
      const hadSession = this.sessionCache.has(sessionId);
      const storageKey = this.buildSessionKey(sessionId);
      const storedSession = await this.ctx.storage.get<Session>(storageKey);
      const hadStoredSession = storedSession !== undefined;

      if (hadSession || hadStoredSession) {
        // 1. Remove from memory cache
        this.sessionCache.delete(sessionId);

        // 2. Delete from Durable Storage
        await this.ctx.storage.delete(storageKey);

        deleted.push(sessionId);
      } else {
        failed.push(sessionId);
      }
    }

    // 3. Delete from D1 in batch - MUST await to prevent race condition
    if (deleted.length > 0 && this.env.DB) {
      try {
        await this.batchDeleteFromD1(deleted);
      } catch (error) {
        console.error('SessionStore: Failed to batch delete from D1:', error);
        // Continue even if D1 deletion fails - memory and Durable Storage are authoritative
      }
    }

    return {
      deleted: deleted.length,
      failed,
    };
  }

  /**
   * Batch delete sessions from D1
   * Uses a single SQL statement with IN clause for efficiency
   */
  private async batchDeleteFromD1(sessionIds: string[]): Promise<void> {
    if (!this.env.DB || sessionIds.length === 0) {
      return;
    }

    // Create placeholders for SQL IN clause
    const placeholders = sessionIds.map(() => '?').join(',');
    const query = `DELETE FROM sessions WHERE id IN (${placeholders})`;

    await retryD1Operation(
      async () => {
        await this.env.DB.prepare(query)
          .bind(...sessionIds)
          .run();
      },
      'SessionStore.batchDeleteFromD1',
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
    const storedSessions = await this.ctx.storage.list<Session>({
      prefix: SESSION_KEY_PREFIX,
    });

    for (const [, session] of storedSessions) {
      if (session.userId === userId && session.expiresAt > now) {
        sessions.push({
          id: session.id,
          userId: session.userId,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt,
        });
      }
    }

    // 2. Get from D1 (cold) - optional, for audit/completeness
    if (this.env.DB) {
      try {
        const result = await this.env.DB.prepare(
          'SELECT id, user_id, expires_at, created_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC'
        )
          .bind(userId, Math.floor(now / 1000))
          .all();

        if (result.results) {
          const existingIds = new Set(sessions.map((s) => s.id));
          for (const row of result.results) {
            // Only add if not already in storage
            if (!existingIds.has(row.id as string)) {
              sessions.push({
                id: row.id as string,
                userId: row.user_id as string,
                expiresAt: (row.expires_at as number) * 1000,
                createdAt: (row.created_at as number) * 1000,
              });
            }
          }
        }
      } catch (error) {
        console.error('SessionStore: D1 list error:', error);
      }
    }

    return sessions;
  }

  /**
   * Extend session expiration (Active TTL)
   */
  async extendSession(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Extend expiration
    session.expiresAt += additionalSeconds * 1000;

    // Update in memory cache
    this.sessionCache.set(sessionId, session);

    // Persist to Durable Storage
    await this.ctx.storage.put(this.buildSessionKey(sessionId), session);

    // Update in D1 - async
    this.saveToD1(session).catch((error) => {
      console.error('SessionStore: Failed to extend session in D1:', error);
    });

    return session;
  }

  /**
   * Sanitize session data for HTTP response (remove sensitive data)
   * Note: data field is included for OIDC conformance (authTime consistency)
   */
  private sanitizeSession(session: Session): SessionResponse {
    return {
      id: session.id,
      userId: session.userId,
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

        if (!body.sessionId || !body.userId || !body.ttl) {
          return new Response(
            JSON.stringify({ error: 'Missing required fields: sessionId, userId, ttl' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const session = await this.createSession(body.sessionId, body.userId, body.ttl, body.data);

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
        const storedSessions = await this.ctx.storage.list<Session>({
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
      console.error('SessionStore error:', error);
      return new Response(
        JSON.stringify({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }
}
