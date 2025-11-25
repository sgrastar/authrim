/**
 * UserCodeRateLimiter Durable Object
 *
 * Protects against brute force attacks on device flow user codes
 *
 * Security Features:
 * - Track failed verification attempts per IP address
 * - Exponential backoff after repeated failures
 * - Automatic cleanup of old records
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types/env';

interface FailedAttempt {
  ip: string;
  failureCount: number;
  firstFailureAt: number;
  lastFailureAt: number;
  blockedUntil?: number;
}

export class UserCodeRateLimiter {
  private state: DurableObjectState;
  private env: Env;
  private attempts: Map<string, FailedAttempt> = new Map();

  // Rate limiting configuration
  private static readonly MAX_ATTEMPTS_PER_HOUR = 5;
  private static readonly BLOCK_DURATION_MS = 60 * 60 * 1000; // 1 hour
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Schedule cleanup alarm
    this.state.storage.setAlarm(Date.now() + UserCodeRateLimiter.CLEANUP_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Check if IP is rate limited
      if (path === '/check' && request.method === 'POST') {
        const { ip } = (await request.json()) as { ip: string };
        const isBlocked = await this.isRateLimited(ip);

        return new Response(
          JSON.stringify({
            blocked: isBlocked,
            ...(isBlocked && { retry_after: this.getRetryAfter(ip) }),
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Record failed attempt
      if (path === '/record-failure' && request.method === 'POST') {
        const { ip } = (await request.json()) as { ip: string };
        await this.recordFailure(ip);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Reset attempts (after successful verification)
      if (path === '/reset' && request.method === 'POST') {
        const { ip } = (await request.json()) as { ip: string };
        this.attempts.delete(ip);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('UserCodeRateLimiter error:', error);
      return new Response(
        JSON.stringify({
          error: 'internal_error',
          error_description: error instanceof Error ? error.message : 'Unknown error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }

  /**
   * Check if an IP address is currently rate limited
   */
  private async isRateLimited(ip: string): Promise<boolean> {
    const attempt = this.attempts.get(ip);

    if (!attempt) {
      return false;
    }

    const now = Date.now();

    // Check if currently blocked
    if (attempt.blockedUntil && now < attempt.blockedUntil) {
      return true;
    }

    // Check if failure count exceeds threshold within the time window
    const hourAgo = now - 60 * 60 * 1000;
    if (
      attempt.firstFailureAt > hourAgo &&
      attempt.failureCount >= UserCodeRateLimiter.MAX_ATTEMPTS_PER_HOUR
    ) {
      return true;
    }

    return false;
  }

  /**
   * Get retry-after seconds for a blocked IP
   */
  private getRetryAfter(ip: string): number {
    const attempt = this.attempts.get(ip);
    if (!attempt || !attempt.blockedUntil) {
      return 0;
    }

    const now = Date.now();
    const retryAfterMs = attempt.blockedUntil - now;
    return Math.ceil(retryAfterMs / 1000);
  }

  /**
   * Record a failed verification attempt
   */
  private async recordFailure(ip: string): Promise<void> {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const existing = this.attempts.get(ip);

    if (!existing || existing.firstFailureAt < hourAgo) {
      // First failure or outside time window - start fresh
      this.attempts.set(ip, {
        ip,
        failureCount: 1,
        firstFailureAt: now,
        lastFailureAt: now,
      });
    } else {
      // Increment failure count
      const newCount = existing.failureCount + 1;
      const attempt: FailedAttempt = {
        ...existing,
        failureCount: newCount,
        lastFailureAt: now,
      };

      // Apply exponential backoff if threshold exceeded
      if (newCount >= UserCodeRateLimiter.MAX_ATTEMPTS_PER_HOUR) {
        const blockMultiplier = Math.pow(2, newCount - UserCodeRateLimiter.MAX_ATTEMPTS_PER_HOUR);
        const blockDuration = Math.min(
          UserCodeRateLimiter.BLOCK_DURATION_MS * blockMultiplier,
          24 * 60 * 60 * 1000 // Max 24 hours
        );
        attempt.blockedUntil = now + blockDuration;

        console.log(
          `[RATE_LIMIT] Blocking IP ${ip} for ${blockDuration / 1000}s after ${newCount} failed attempts`
        );
      }

      this.attempts.set(ip, attempt);
    }
  }

  /**
   * Cleanup expired rate limit records
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    let cleaned = 0;

    for (const [ip, attempt] of this.attempts.entries()) {
      // Remove if:
      // 1. Block has expired AND last failure was over an hour ago
      // 2. OR first failure was over an hour ago and not currently blocked
      const blockExpired = !attempt.blockedUntil || now >= attempt.blockedUntil;
      const oldFailure = attempt.lastFailureAt < hourAgo;

      if (blockExpired && oldFailure) {
        this.attempts.delete(ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[RATE_LIMIT] Cleaned up ${cleaned} expired rate limit records`);
    }

    // Schedule next cleanup
    await this.state.storage.setAlarm(Date.now() + UserCodeRateLimiter.CLEANUP_INTERVAL_MS);
  }
}
