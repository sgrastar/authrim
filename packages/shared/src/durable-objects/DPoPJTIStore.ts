/**
 * DPoPJTIStore Durable Object
 *
 * Manages DPoP JTI (JWT ID) replay protection with atomic operations.
 * Solves issue #12: DPoP JTI Replay Protection race condition.
 *
 * DPoP (Demonstrating Proof-of-Possession) Requirements:
 * - Each DPoP proof JWT MUST have a unique jti (JWT ID)
 * - jti MUST NOT be reused (replay protection)
 * - jti should be tracked for a reasonable time window
 *
 * Security Features:
 * - Atomic check-and-store operation
 * - Prevents parallel replay attacks
 * - TTL enforcement (e.g., 1 hour)
 * - Automatic cleanup of expired JTIs
 *
 * Benefits over KV-based JTI tracking:
 * - ✅ No race conditions on concurrent requests with same JTI
 * - ✅ Perfect replay protection (100% accuracy)
 * - ✅ Immediate consistency (no eventual consistency issues)
 * - ✅ DPoP specification compliance
 */

import type { Env } from '../types/env';

/**
 * DPoP JTI record
 */
export interface DPoPJTIRecord {
  jti: string;
  client_id?: string; // Optional: bind JTI to client
  iat: number; // Issued at timestamp (from DPoP proof)
  createdAt: number; // When this record was created
  expiresAt: number; // When this record expires
}

/**
 * Check and store JTI request
 */
export interface CheckAndStoreJTIRequest {
  jti: string;
  client_id?: string;
  iat: number; // DPoP proof iat claim
  ttl: number; // Time to live in seconds (typically 3600 = 1 hour)
}

/**
 * Persistent state stored in Durable Storage
 */
interface DPoPJTIStoreState {
  jtis: Record<string, DPoPJTIRecord>;
  lastCleanup: number;
}

/**
 * DPoPJTIStore Durable Object
 *
 * Provides atomic JTI replay protection for DPoP.
 */
export class DPoPJTIStore {
  private state: DurableObjectState;
  private env: Env;
  private jtis: Map<string, DPoPJTIRecord> = new Map();
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_ENTRIES = 50000; // Cleanup trigger threshold

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
      const stored = await this.state.storage.get<DPoPJTIStoreState>('state');

      if (stored) {
        this.jtis = new Map(Object.entries(stored.jtis));
        console.log(`DPoPJTIStore: Restored ${this.jtis.size} JTIs from Durable Storage`);
      }
    } catch (error) {
      console.error('DPoPJTIStore: Failed to initialize from Durable Storage:', error);
    }

    this.initialized = true;
    this.startCleanup();
  }

  /**
   * Save current state to Durable Storage
   */
  private async saveState(): Promise<void> {
    try {
      const stateToSave: DPoPJTIStoreState = {
        jtis: Object.fromEntries(this.jtis),
        lastCleanup: Date.now(),
      };

      await this.state.storage.put('state', stateToSave);
    } catch (error) {
      console.error('DPoPJTIStore: Failed to save to Durable Storage:', error);
    }
  }

  /**
   * Start periodic cleanup of expired JTIs
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        void this.cleanupExpiredJTIs();
      }, this.CLEANUP_INTERVAL) as unknown as number;
    }
  }

  /**
   * Cleanup expired JTIs
   */
  private async cleanupExpiredJTIs(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    for (const [jti, record] of this.jtis.entries()) {
      if (record.expiresAt <= now) {
        this.jtis.delete(jti);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`DPoPJTIStore: Cleaned up ${cleaned} expired JTIs`);
      await this.saveState();
    }
  }

  /**
   * Check if JTI exists (replay detection)
   */
  async checkJTI(jti: string): Promise<DPoPJTIRecord | null> {
    await this.initializeState();

    const record = this.jtis.get(jti);
    if (!record) {
      return null;
    }

    // Check if expired
    if (record.expiresAt <= Date.now()) {
      this.jtis.delete(jti);
      await this.saveState();
      return null;
    }

    return record;
  }

  /**
   * Atomically check and store JTI
   *
   * CRITICAL: This operation is atomic within the DO
   * - Checks if JTI already exists
   * - If exists: throws error (replay detected)
   * - If not exists: stores JTI
   *
   * This is the solution to issue #12: DPoP JTI race condition.
   * Parallel requests with the same JTI will be serialized,
   * ensuring only the first one succeeds.
   */
  async checkAndStoreJTI(request: CheckAndStoreJTIRequest): Promise<void> {
    await this.initializeState();

    // Check if JTI already exists (ATOMIC CHECK)
    const existing = await this.checkJTI(request.jti);
    if (existing) {
      throw new Error('DPoP replay detected: JTI already used');
    }

    // Store new JTI (ATOMIC STORE)
    const now = Date.now();
    const record: DPoPJTIRecord = {
      jti: request.jti,
      client_id: request.client_id,
      iat: request.iat,
      createdAt: now,
      expiresAt: now + request.ttl * 1000,
    };

    this.jtis.set(request.jti, record);
    await this.saveState();

    // Trigger cleanup if too many entries
    if (this.jtis.size > this.MAX_ENTRIES) {
      void this.cleanupExpiredJTIs();
    }
  }

  /**
   * Delete a JTI (for cleanup or testing)
   */
  async deleteJTI(jti: string): Promise<boolean> {
    await this.initializeState();

    const had = this.jtis.has(jti);
    this.jtis.delete(jti);

    if (had) {
      await this.saveState();
    }

    return had;
  }

  /**
   * Handle HTTP requests to the DPoPJTIStore Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /check - Check if JTI exists
      if (path === '/check' && request.method === 'POST') {
        const body = (await request.json()) as { jti: string };

        if (!body.jti) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing jti',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const record = await this.checkJTI(body.jti);

        if (record) {
          return new Response(
            JSON.stringify({
              exists: true,
              record: {
                iat: record.iat,
                createdAt: record.createdAt,
                expiresAt: record.expiresAt,
              },
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response(
          JSON.stringify({ exists: false }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // POST /check-and-store - Atomic check and store
      if (path === '/check-and-store' && request.method === 'POST') {
        const body = (await request.json()) as Partial<CheckAndStoreJTIRequest>;

        if (!body.jti || !body.iat || !body.ttl) {
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
          await this.checkAndStoreJTI(body as CheckAndStoreJTIRequest);

          return new Response(
            JSON.stringify({ success: true }),
            {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return new Response(
            JSON.stringify({
              error: 'replay_detected',
              error_description: message,
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      }

      // DELETE /jti/:jti - Delete JTI
      if (path.startsWith('/jti/') && request.method === 'DELETE') {
        const jti = decodeURIComponent(path.substring(5)); // Remove '/jti/'
        const deleted = await this.deleteJTI(jti);

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

        for (const record of this.jtis.values()) {
          if (record.expiresAt > now) {
            activeCount++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            jtis: {
              total: this.jtis.size,
              active: activeCount,
              expired: this.jtis.size - activeCount,
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
      console.error('DPoPJTIStore error:', error);
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
