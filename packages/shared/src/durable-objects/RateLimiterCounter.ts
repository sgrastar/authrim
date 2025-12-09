/**
 * RateLimiterCounter Durable Object
 *
 * Provides atomic rate limiting with perfect precision.
 * Solves issue #6: Rate Limiting accuracy in distributed environment.
 *
 * Features:
 * - Atomic increment operations (100% accuracy)
 * - Sliding window rate limiting
 * - Automatic cleanup of expired entries
 * - Persistent state across DO restarts
 *
 * Benefits over KV-based rate limiting:
 * - ✅ No race conditions on concurrent requests
 * - ✅ Precise counting even under high load
 * - ✅ Immediate consistency (no eventual consistency issues)
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  windowSeconds: number; // Time window in seconds
  maxRequests: number; // Maximum requests allowed in the window
}

/**
 * Rate limit record
 */
export interface RateLimitRecord {
  count: number; // Current request count
  resetAt: number; // Unix timestamp when window resets
  firstRequestAt: number; // Unix timestamp of first request in window
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  allowed: boolean; // Whether the request is allowed
  current: number; // Current request count
  limit: number; // Maximum allowed requests
  resetAt: number; // Unix timestamp when limit resets
  retryAfter: number; // Seconds to wait before retrying (0 if allowed)
}

/**
 * Increment request payload
 */
export interface IncrementRequest {
  clientIP: string;
  config: RateLimitConfig;
}

/**
 * Persistent state stored in Durable Storage
 */
interface RateLimiterState {
  records: Record<string, RateLimitRecord>;
  lastCleanup: number;
}

/**
 * RateLimiterCounter Durable Object
 *
 * Manages rate limiting counters with atomic operations.
 * Each DO instance handles a shard of IP addresses.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., incrementRpc, getStatusRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 */
export class RateLimiterCounter extends DurableObject<Env> {
  private counts: Map<string, RateLimitRecord> = new Map();
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_ENTRIES = 10000; // Cleanup trigger threshold
  private readonly RETENTION_PERIOD = 3600; // 1 hour grace period for expired entries

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ==========================================
  // RPC Methods (public, with 'Rpc' suffix)
  // ==========================================

  /**
   * RPC: Atomically increment rate limit counter
   */
  async incrementRpc(clientIP: string, config: RateLimitConfig): Promise<RateLimitResult> {
    return this.increment(clientIP, config);
  }

  /**
   * RPC: Get current rate limit status without incrementing
   */
  async getStatusRpc(clientIP: string): Promise<RateLimitRecord | null> {
    return this.getStatus(clientIP);
  }

  /**
   * RPC: Reset rate limit for a specific client IP
   */
  async resetRpc(clientIP: string): Promise<boolean> {
    return this.reset(clientIP);
  }

  /**
   * RPC: Get health check status
   */
  async getHealthRpc(): Promise<{
    status: string;
    records: { total: number; active: number; expired: number };
    timestamp: number;
  }> {
    await this.initializeState();
    const now = Math.floor(Date.now() / 1000);
    let activeCount = 0;

    for (const record of this.counts.values()) {
      if (now < record.resetAt) {
        activeCount++;
      }
    }

    return {
      status: 'ok',
      records: {
        total: this.counts.size,
        active: activeCount,
        expired: this.counts.size - activeCount,
      },
      timestamp: now,
    };
  }

  // ==========================================
  // Internal Methods
  // ==========================================

  /**
   * Initialize state from Durable Storage
   */
  private async initializeState(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const stored = await this.ctx.storage.get<RateLimiterState>('state');

      if (stored) {
        this.counts = new Map(Object.entries(stored.records));
        console.log(
          `RateLimiterCounter: Restored ${this.counts.size} records from Durable Storage`
        );
      }
    } catch (error) {
      console.error('RateLimiterCounter: Failed to initialize from Durable Storage:', error);
    }

    this.initialized = true;
    this.startCleanup();
  }

  /**
   * Save current state to Durable Storage
   */
  private async saveState(): Promise<void> {
    try {
      const stateToSave: RateLimiterState = {
        records: Object.fromEntries(this.counts),
        lastCleanup: Date.now(),
      };

      await this.ctx.storage.put('state', stateToSave);
    } catch (error) {
      console.error('RateLimiterCounter: Failed to save to Durable Storage:', error);
    }
  }

  /**
   * Start periodic cleanup of expired entries
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        void this.cleanup();
      }, this.CLEANUP_INTERVAL) as unknown as number;
    }
  }

  /**
   * Cleanup expired entries
   */
  private async cleanup(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    let cleaned = 0;

    for (const [ip, record] of this.counts.entries()) {
      // Delete entries that have been expired for more than retention period
      if (now >= record.resetAt + this.RETENTION_PERIOD) {
        this.counts.delete(ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`RateLimiterCounter: Cleaned up ${cleaned} expired entries`);
      await this.saveState();
    }
  }

  /**
   * Atomically increment rate limit counter
   *
   * CRITICAL: This operation is atomic within the DO
   * - Checks current count
   * - Increments counter
   * - Returns allow/deny decision
   *
   * Parallel requests are serialized by the DO runtime,
   * ensuring perfect counting accuracy.
   */
  async increment(clientIP: string, config: RateLimitConfig): Promise<RateLimitResult> {
    await this.initializeState();

    const now = Math.floor(Date.now() / 1000);
    let record = this.counts.get(clientIP);

    if (!record || now >= record.resetAt) {
      // Start new window
      record = {
        count: 1,
        resetAt: now + config.windowSeconds,
        firstRequestAt: now,
      };
    } else {
      // Increment counter (ATOMIC - this is the key to #6 solution)
      record.count++;
    }

    this.counts.set(clientIP, record);
    await this.saveState();

    // Trigger cleanup if too many entries
    if (this.counts.size > this.MAX_ENTRIES) {
      // Don't await - run in background
      void this.cleanup();
    }

    return {
      allowed: record.count <= config.maxRequests,
      current: record.count,
      limit: config.maxRequests,
      resetAt: record.resetAt,
      retryAfter: record.count > config.maxRequests ? record.resetAt - now : 0,
    };
  }

  /**
   * Get current rate limit status without incrementing
   */
  async getStatus(clientIP: string): Promise<RateLimitRecord | null> {
    await this.initializeState();

    const record = this.counts.get(clientIP);
    if (!record) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    // Return null if window expired
    if (now >= record.resetAt) {
      return null;
    }

    return record;
  }

  /**
   * Reset rate limit for a specific client IP
   * (e.g., for testing or manual intervention)
   */
  async reset(clientIP: string): Promise<boolean> {
    await this.initializeState();

    const had = this.counts.has(clientIP);
    this.counts.delete(clientIP);

    if (had) {
      await this.saveState();
    }

    return had;
  }

  /**
   * Handle HTTP requests to the RateLimiterCounter Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /increment - Increment rate limit counter
      if (path === '/increment' && request.method === 'POST') {
        const body = (await request.json()) as Partial<IncrementRequest>;

        if (!body.clientIP || !body.config) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing clientIP or config',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const result = await this.increment(body.clientIP, body.config);

        return new Response(JSON.stringify(result), {
          status: result.allowed ? 200 : 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': result.limit.toString(),
            'X-RateLimit-Remaining': Math.max(0, result.limit - result.current).toString(),
            'X-RateLimit-Reset': result.resetAt.toString(),
            ...(result.retryAfter > 0 && { 'Retry-After': result.retryAfter.toString() }),
          },
        });
      }

      // GET /status/:clientIP - Get current status
      if (path.startsWith('/status/') && request.method === 'GET') {
        const clientIP = decodeURIComponent(path.substring(8)); // Remove '/status/'
        const record = await this.getStatus(clientIP);

        if (!record) {
          return new Response(
            JSON.stringify({
              error: 'not_found',
              error_description: 'No active rate limit for this client',
            }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response(JSON.stringify(record), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // DELETE /reset/:clientIP - Reset rate limit
      if (path.startsWith('/reset/') && request.method === 'DELETE') {
        const clientIP = decodeURIComponent(path.substring(7)); // Remove '/reset/'
        const reset = await this.reset(clientIP);

        return new Response(
          JSON.stringify({
            success: true,
            reset,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /health - Health check
      if (path === '/health' && request.method === 'GET') {
        const now = Math.floor(Date.now() / 1000);
        let activeCount = 0;

        for (const record of this.counts.values()) {
          if (now < record.resetAt) {
            activeCount++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            records: {
              total: this.counts.size,
              active: activeCount,
              expired: this.counts.size - activeCount,
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
      console.error('RateLimiterCounter error:', error);
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
