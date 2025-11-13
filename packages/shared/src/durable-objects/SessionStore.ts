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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  private startCleanup(): void {
    // Cleanup every 5 minutes
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(
        () => {
          this.cleanupExpiredSessions();
        },
        5 * 60 * 1000
      ) as unknown as number;
    }
  }

  /**
   * Cleanup expired sessions from memory
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
   */
  private async saveToD1(session: Session): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    try {
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
    } catch (error) {
      console.error('SessionStore: D1 save error:', error);
      // Don't throw - session is still in memory
    }
  }

  /**
   * Delete session from D1 database
   */
  private async deleteFromD1(sessionId: string): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    try {
      await this.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    } catch (error) {
      console.error('SessionStore: D1 delete error:', error);
    }
  }

  /**
   * Get session by ID (memory → D1 fallback)
   */
  async getSession(sessionId: string): Promise<Session | null> {
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
    const session: Session = {
      id: this.generateSessionId(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Store in memory (hot)
    this.sessions.set(session.id, session);

    // 2. Persist to D1 (backup & audit) - async, don't wait
    this.saveToD1(session).catch((error) => {
      console.error('SessionStore: Failed to save to D1:', error);
    });

    return session;
  }

  /**
   * Invalidate session immediately
   */
  async invalidateSession(sessionId: string): Promise<boolean> {
    // 1. Remove from memory
    const hadSession = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    // 2. Mark as deleted in D1 - async, don't wait
    this.deleteFromD1(sessionId).catch((error) => {
      console.error('SessionStore: Failed to delete from D1:', error);
    });

    return hadSession;
  }

  /**
   * List all active sessions for a user
   */
  async listUserSessions(userId: string): Promise<SessionResponse[]> {
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
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Extend expiration
    session.expiresAt += additionalSeconds * 1000;

    // Update in memory
    this.sessions.set(sessionId, session);

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
        const body = (await request.json()) as CreateSessionRequest;

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
        const body = (await request.json()) as { seconds: number };

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
