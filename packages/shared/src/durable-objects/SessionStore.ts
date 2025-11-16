/**
 * SessionStore Durable Object
 *
 * Manages active user sessions with in-memory hot data and D1 database fallback.
 * Provides instant session invalidation and ITP-compatible session management.
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
 * Persistent state stored in Durable Storage
 */
interface SessionStoreState {
  sessions: Record<string, Session>; // Serializable format (Map cannot be serialized directly)
  lastCleanup: number;
}

/**
 * Session creation request
 */
export interface CreateSessionRequest {
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
}

/**
 * SessionStore Durable Object
 *
 * Provides distributed session storage with strong consistency guarantees.
 */
export class SessionStore {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<string, Session> = new Map();
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // State will be initialized on first request
    // This avoids blocking the constructor
  }

  /**
   * Initialize state from Durable Storage
   * Must be called before any session operations
   */
  private async initializeState(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const stored = await this.state.storage.get<SessionStoreState>('state');

      if (stored) {
        // Restore sessions from Durable Storage
        this.sessions = new Map(Object.entries(stored.sessions));
        console.log(`SessionStore: Restored ${this.sessions.size} sessions from Durable Storage`);
      }
    } catch (error) {
      console.error('SessionStore: Failed to initialize from Durable Storage:', error);
      // Continue with empty state
    }

    this.initialized = true;

    // Start periodic cleanup after initialization
    this.startCleanup();
  }

  /**
   * Save current state to Durable Storage
   * Converts Map to serializable object
   */
  private async saveState(): Promise<void> {
    try {
      const stateToSave: SessionStoreState = {
        sessions: Object.fromEntries(this.sessions),
        lastCleanup: Date.now(),
      };

      await this.state.storage.put('state', stateToSave);
    } catch (error) {
      console.error('SessionStore: Failed to save to Durable Storage:', error);
      // Don't throw - we don't want to break the session operation
      // But this should be monitored/alerted in production
    }
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

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`SessionStore: Cleaned up ${cleaned} expired sessions`);
      // Persist cleanup to Durable Storage
      await this.saveState();
    }
  }

  /**
   * Check if session is expired
   */
  private isExpired(session: Session): boolean {
    return session.expiresAt <= Date.now();
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `session_${crypto.randomUUID()}`;
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
   * Get session by ID (memory → D1 fallback)
   */
  async getSession(sessionId: string): Promise<Session | null> {
    await this.initializeState();

    // 1. Check in-memory (hot)
    let session = this.sessions.get(sessionId);
    if (session) {
      if (!this.isExpired(session)) {
        return session;
      }
      // Cleanup expired session
      this.sessions.delete(sessionId);
      return null;
    }

    // 2. Check D1 (cold) with timeout
    try {
      const d1Session = await Promise.race([
        this.loadFromD1(sessionId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);

      if (d1Session && !this.isExpired(d1Session)) {
        // Promote to hot storage
        this.sessions.set(sessionId, d1Session);
        return d1Session;
      }
    } catch (error) {
      console.error('SessionStore: D1 fallback error:', error);
    }

    return null;
  }

  /**
   * Create new session
   */
  async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
    await this.initializeState();

    const session: Session = {
      id: this.generateSessionId(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Store in memory (hot)
    this.sessions.set(session.id, session);

    // 2. Persist to Durable Storage (for DO restart resilience)
    await this.saveState();

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
    await this.initializeState();

    // 1. Remove from memory
    const hadSession = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    // 2. Persist to Durable Storage
    if (hadSession) {
      await this.saveState();
    }

    // 3. Mark as deleted in D1 - async, don't wait
    this.deleteFromD1(sessionId).catch((error) => {
      console.error('SessionStore: Failed to delete from D1:', error);
    });

    return hadSession;
  }

  /**
   * Batch invalidate multiple sessions
   * Optimized for admin operations (e.g., delete all user sessions)
   */
  async invalidateSessionsBatch(sessionIds: string[]): Promise<{ deleted: number; failed: string[] }> {
    await this.initializeState();

    const deleted: string[] = [];
    const failed: string[] = [];

    // 1. Remove from memory
    for (const sessionId of sessionIds) {
      if (this.sessions.has(sessionId)) {
        this.sessions.delete(sessionId);
        deleted.push(sessionId);
      } else {
        failed.push(sessionId);
      }
    }

    // 2. Persist to Durable Storage (single write for all deletions)
    if (deleted.length > 0) {
      await this.saveState();
    }

    // 3. Delete from D1 in batch - async, don't wait
    if (deleted.length > 0 && this.env.DB) {
      this.batchDeleteFromD1(deleted).catch((error) => {
        console.error('SessionStore: Failed to batch delete from D1:', error);
      });
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
        await this.env.DB.prepare(query).bind(...sessionIds).run();
      },
      'SessionStore.batchDeleteFromD1',
      { maxRetries: 3 }
    );
  }

  /**
   * List all active sessions for a user
   */
  async listUserSessions(userId: string): Promise<SessionResponse[]> {
    await this.initializeState();

    const sessions: SessionResponse[] = [];
    const now = Date.now();

    // 1. Get from in-memory (hot)
    for (const session of this.sessions.values()) {
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
          for (const row of result.results) {
            // Only add if not already in memory
            if (!this.sessions.has(row.id as string)) {
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
    await this.initializeState();

    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Extend expiration
    session.expiresAt += additionalSeconds * 1000;

    // Update in memory
    this.sessions.set(sessionId, session);

    // Persist to Durable Storage
    await this.saveState();

    // Update in D1 - async
    this.saveToD1(session).catch((error) => {
      console.error('SessionStore: Failed to extend session in D1:', error);
    });

    return session;
  }

  /**
   * Sanitize session data for HTTP response (remove sensitive data)
   */
  private sanitizeSession(session: Session): SessionResponse {
    return {
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
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

        if (!body.userId || !body.ttl) {
          return new Response(JSON.stringify({ error: 'Missing required fields: userId, ttl' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const session = await this.createSession(body.userId, body.ttl, body.data);

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
        return new Response(
          JSON.stringify({
            status: 'ok',
            sessions: this.sessions.size,
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
