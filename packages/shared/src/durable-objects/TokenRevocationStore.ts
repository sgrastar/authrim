/**
 * TokenRevocationStore Durable Object
 *
 * Manages revoked access token JTIs with atomic operations.
 * Replaces KV-based REVOKED_TOKENS namespace with strong consistency.
 *
 * Token Revocation Requirements:
 * - Store revoked access token JTIs
 * - Check if token is revoked (introspection, userinfo)
 * - TTL enforcement (tokens auto-expire, no need to keep them forever)
 * - Automatic cleanup of expired tokens
 *
 * Benefits over KV-based revocation:
 * - ✅ Strong consistency (no eventual consistency issues)
 * - ✅ Atomic operations (no race conditions)
 * - ✅ Automatic cleanup of expired entries
 * - ✅ Better performance (in-memory + persistent storage)
 */

import type { Env } from '../types/env';

/**
 * Revoked token record
 */
export interface RevokedTokenRecord {
  jti: string;
  revokedAt: number; // When the token was revoked
  expiresAt: number; // When the token would have expired naturally
  reason?: string; // Optional revocation reason
}

/**
 * Revoke token request
 */
export interface RevokeTokenRequest {
  jti: string;
  ttl: number; // Time to live in seconds (original token expiration time)
  reason?: string;
}

/**
 * Persistent state stored in Durable Storage
 */
interface TokenRevocationStoreState {
  revokedTokens: Record<string, RevokedTokenRecord>;
  lastCleanup: number;
}

/**
 * TokenRevocationStore Durable Object
 *
 * Provides atomic token revocation operations.
 */
export class TokenRevocationStore {
  private state: DurableObjectState;
  private env: Env;
  private revokedTokens: Map<string, RevokedTokenRecord> = new Map();
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_ENTRIES = 100000; // Cleanup trigger threshold

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

    try {
      const stored = await this.state.storage.get<TokenRevocationStoreState>('state');

      if (stored) {
        this.revokedTokens = new Map(Object.entries(stored.revokedTokens));
        console.log(
          `TokenRevocationStore: Restored ${this.revokedTokens.size} revoked tokens from Durable Storage`
        );
      }
    } catch (error) {
      console.error('TokenRevocationStore: Failed to initialize from Durable Storage:', error);
    }

    this.initialized = true;
    this.startCleanup();
  }

  /**
   * Save current state to Durable Storage
   */
  private async saveState(): Promise<void> {
    try {
      const stateToSave: TokenRevocationStoreState = {
        revokedTokens: Object.fromEntries(this.revokedTokens),
        lastCleanup: Date.now(),
      };

      await this.state.storage.put('state', stateToSave);
    } catch (error) {
      console.error('TokenRevocationStore: Failed to save to Durable Storage:', error);
    }
  }

  /**
   * Start periodic cleanup of expired revoked tokens
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        void this.cleanupExpiredTokens();
      }, this.CLEANUP_INTERVAL) as unknown as number;
    }
  }

  /**
   * Cleanup expired revoked tokens
   */
  private async cleanupExpiredTokens(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    for (const [jti, record] of this.revokedTokens.entries()) {
      if (record.expiresAt <= now) {
        this.revokedTokens.delete(jti);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`TokenRevocationStore: Cleaned up ${cleaned} expired tokens`);
      await this.saveState();
    }
  }

  /**
   * Check if token is revoked
   */
  async isRevoked(jti: string): Promise<RevokedTokenRecord | null> {
    await this.initializeState();

    const record = this.revokedTokens.get(jti);
    if (!record) {
      return null;
    }

    // Check if expired (token expired naturally, can remove from revocation list)
    if (record.expiresAt <= Date.now()) {
      this.revokedTokens.delete(jti);
      await this.saveState();
      return null;
    }

    return record;
  }

  /**
   * Revoke a token
   */
  async revokeToken(request: RevokeTokenRequest): Promise<void> {
    await this.initializeState();

    const now = Date.now();
    const record: RevokedTokenRecord = {
      jti: request.jti,
      revokedAt: now,
      expiresAt: now + request.ttl * 1000,
      reason: request.reason,
    };

    this.revokedTokens.set(request.jti, record);
    await this.saveState();

    // Trigger cleanup if too many entries
    if (this.revokedTokens.size > this.MAX_ENTRIES) {
      void this.cleanupExpiredTokens();
    }
  }

  /**
   * Bulk revoke tokens (used for authorization code reuse attack)
   */
  async bulkRevokeTokens(jtis: string[], ttl: number, reason: string): Promise<void> {
    await this.initializeState();

    const now = Date.now();
    let revoked = 0;

    for (const jti of jtis) {
      const record: RevokedTokenRecord = {
        jti,
        revokedAt: now,
        expiresAt: now + ttl * 1000,
        reason,
      };

      this.revokedTokens.set(jti, record);
      revoked++;
    }

    if (revoked > 0) {
      console.log(`TokenRevocationStore: Bulk revoked ${revoked} tokens`);
      await this.saveState();

      // Trigger cleanup if too many entries
      if (this.revokedTokens.size > this.MAX_ENTRIES) {
        void this.cleanupExpiredTokens();
      }
    }
  }

  /**
   * Delete a revoked token record (for cleanup or testing)
   */
  async deleteToken(jti: string): Promise<boolean> {
    await this.initializeState();

    const had = this.revokedTokens.has(jti);
    this.revokedTokens.delete(jti);

    if (had) {
      await this.saveState();
    }

    return had;
  }

  /**
   * Handle HTTP requests to the TokenRevocationStore Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /check?jti=xxx - Check if token is revoked
      if (path === '/check' && request.method === 'GET') {
        const jti = url.searchParams.get('jti');

        if (!jti) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing jti parameter',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const record = await this.isRevoked(jti);

        if (record) {
          return new Response(
            JSON.stringify({
              revoked: true,
              revokedAt: record.revokedAt,
              expiresAt: record.expiresAt,
              reason: record.reason,
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response(JSON.stringify({ revoked: false }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /revoke - Revoke a token
      if (path === '/revoke' && request.method === 'POST') {
        const body = (await request.json()) as Partial<RevokeTokenRequest>;

        if (!body.jti || !body.ttl) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields (jti, ttl)',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        await this.revokeToken(body as RevokeTokenRequest);

        return new Response(JSON.stringify({ success: true }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /bulk-revoke - Bulk revoke tokens
      if (path === '/bulk-revoke' && request.method === 'POST') {
        const body = (await request.json()) as {
          jtis: string[];
          ttl: number;
          reason: string;
        };

        if (!body.jtis || !Array.isArray(body.jtis) || !body.ttl) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields (jtis, ttl)',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        await this.bulkRevokeTokens(body.jtis, body.ttl, body.reason || 'Bulk revocation');

        return new Response(
          JSON.stringify({
            success: true,
            revoked: body.jtis.length,
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // DELETE /token/:jti - Delete revoked token record
      if (path.startsWith('/token/') && request.method === 'DELETE') {
        const jti = decodeURIComponent(path.substring(7)); // Remove '/token/'
        const deleted = await this.deleteToken(jti);

        return new Response(
          JSON.stringify({
            success: true,
            deleted,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /health - Health check
      if (path === '/health' && request.method === 'GET') {
        const now = Date.now();
        let activeCount = 0;

        for (const record of this.revokedTokens.values()) {
          if (record.expiresAt > now) {
            activeCount++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            revokedTokens: {
              total: this.revokedTokens.size,
              active: activeCount,
              expired: this.revokedTokens.size - activeCount,
            },
            timestamp: now,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('TokenRevocationStore error:', error);
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
