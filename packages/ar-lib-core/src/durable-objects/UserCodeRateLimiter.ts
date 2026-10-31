/**
 * UserCodeRateLimiter Durable Object
 *
 * Protects against brute force attacks on device flow user codes
 *
 * What it does, exactly:
 * - A failure window starts with an IP's first recorded failure and lasts one hour. Failures
 *   inside it are counted; a failure after it starts a new window at 1.
 * - The IP is blocked while it has 5 failures in the current window (`MAX_ATTEMPTS_PER_HOUR`),
 *   and the 5th failure also sets a block that lasts one hour from that failure. A failure
 *   recorded beyond the 5th (the reservation below keeps that from happening) doubles the block
 *   each time, to at most 24 hours.
 * - A guess is first RESERVED (`/reserve`): in one step, in memory, the limiter checks that
 *   `failures in the window + guesses in flight < 5` and not blocked, and holds a reservation for
 *   30 seconds. Parallel requests therefore cannot all pass a check before the first failure is
 *   recorded: at most the remaining budget gets to read the code store. The reservation is then
 *   settled by `/record-failure` with its id (it becomes a failure) or `/release` (it is dropped,
 *   not counted). A reservation nobody settles expires by itself, which costs one slot for at
 *   most 30 seconds. Reservations are kept in memory only: if the object restarts they are gone,
 *   which at worst lets the guesses that were in flight through.
 * - A settle says whether the reservation was still live (`expired: false`) or had lapsed or was
 *   unknown (`expired: true`: it ran out, or the object restarted). The caller discloses the result
 *   of a lookup only for a live reservation: a lapsed slot may already be spent by others, so its
 *   answer would be a guess the budget did not pay for. A lapsed or unknown reservation is ALWAYS
 *   settled as exactly one failure, whichever way it is settled (`/record-failure` or `/release`)
 *   and whatever the lookup found: a lapse must not be a free guess, and the effect on the budget
 *   (the count, a block and its duration) must not depend on whether a code was found, or it would
 *   tell a stalled request what it looked up.
 * - A settle counts once. Settled ids are remembered for 10 minutes (at most 10 000, oldest first)
 *   with their IP and outcome: the same id again is ignored and returns the first outcome (record
 *   twice counts once, release then record counts nothing), and an id from another IP is ignored.
 * - The routes are `/reserve`, `/record-failure` and `/release` (both with the reservation id), and
 *   `/reset`, which clears an IP's failures; nothing in the code base calls `/reset` (a successful
 *   approval must not buy new guesses).
 * - Records of IPs whose block and window are over are cleaned up by an alarm.
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import { createLogger, type Logger } from '../utils/logger';

interface FailedAttempt {
  ip: string;
  failureCount: number;
  firstFailureAt: number;
  lastFailureAt: number;
  blockedUntil?: number;
}

interface PersistedRateLimiterState {
  attempts: FailedAttempt[];
}

export class UserCodeRateLimiter {
  private state: DurableObjectState;
  private env: Env;
  private attempts: Map<string, FailedAttempt> = new Map();
  private initialized = false;
  private readonly log: Logger = createLogger().module('UserCodeRateLimiter');

  // Rate limiting configuration
  private static readonly MAX_ATTEMPTS_PER_HOUR = 5;
  private static readonly BLOCK_DURATION_MS = 60 * 60 * 1000; // 1 hour
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  /** How long a guess is held in flight before nobody having settled it frees the slot. */
  static readonly RESERVATION_TTL_MS = 30 * 1000;

  /** Guesses in flight: reservation id -> the IP and when the reservation lapses. */
  private reservations: Map<string, { ip: string; expiresAt: number }> = new Map();

  /** How long a settled reservation id is remembered, so a repeated settle is not counted again. */
  static readonly SETTLED_TTL_MS = 10 * 60 * 1000;
  static readonly MAX_SETTLED = 10_000;
  private settled: Map<
    string,
    { ip: string; outcome: 'failure' | 'released'; expired: boolean; expiresAt: number }
  > = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Schedule cleanup alarm
    void this.state.storage.setAlarm(Date.now() + UserCodeRateLimiter.CLEANUP_INTERVAL_MS);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const stored = await this.state.storage.get<PersistedRateLimiterState>('state');
    if (stored) {
      this.attempts = new Map(stored.attempts.map((attempt) => [attempt.ip, attempt]));
    }
    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', { attempts: [...this.attempts.values()] });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      await this.initialize();

      // Reserve one guess (see the header): allowed with a reservation id, or blocked
      if (path === '/reserve' && request.method === 'POST') {
        const { ip } = await request.json<{ ip: string }>();
        const decision = this.reserve(ip);
        return new Response(JSON.stringify(decision), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Drop a reservation without counting it
      if (path === '/release' && request.method === 'POST') {
        const { ip, reservation_id } = await request.json<{
          ip?: string;
          reservation_id?: string;
        }>();
        const result =
          typeof reservation_id === 'string' && typeof ip === 'string'
            ? await this.settleReservation(reservation_id, ip, 'released')
            : { ignored: true };
        return new Response(JSON.stringify({ success: true, ...result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Settle a reservation as a failed guess: the failure takes its place and counts once
      if (path === '/record-failure' && request.method === 'POST') {
        const { ip, reservation_id } = await request.json<{
          ip?: string;
          reservation_id?: string;
        }>();
        if (typeof ip !== 'string' || typeof reservation_id !== 'string') {
          return new Response(JSON.stringify({ error: 'invalid_request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const result = await this.settleReservation(reservation_id, ip, 'failure');

        return new Response(JSON.stringify({ success: true, ...result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Reset attempts (after successful verification)
      if (path === '/reset' && request.method === 'POST') {
        const { ip } = await request.json<{ ip: string }>();
        if (this.attempts.delete(ip)) {
          await this.persist();
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      // Log full error for debugging but don't expose to client
      this.log.error('Request handling error', {}, error as Error);
      // SECURITY: Do not expose internal error details in response
      return new Response(
        JSON.stringify({
          error: 'server_error',
          error_description: 'Internal server error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }

  /** Whether an IP is blocked: inside a block, or with 5 failures in the current window. */
  private isBlockedAt(attempt: FailedAttempt | undefined, now: number): boolean {
    if (!attempt) {
      return false;
    }

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

  /** Drop the reservations that lapsed, and return how many are still held for an IP. */
  private liveReservationsOf(ip: string, now: number): { count: number; earliestExpiry: number } {
    let count = 0;
    let earliestExpiry = Infinity;
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) {
        this.reservations.delete(id);
      } else if (reservation.ip === ip) {
        count += 1;
        earliestExpiry = Math.min(earliestExpiry, reservation.expiresAt);
      }
    }
    return { count, earliestExpiry };
  }

  /** Remember a settled reservation id, dropping what is old or beyond the bound. */
  private rememberSettled(
    id: string,
    ip: string,
    outcome: 'failure' | 'released',
    expired: boolean,
    now: number
  ): void {
    for (const [key, entry] of this.settled) {
      if (entry.expiresAt > now) break; // insertion order is expiry order
      this.settled.delete(key);
    }
    while (this.settled.size >= UserCodeRateLimiter.MAX_SETTLED) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
    this.settled.set(id, {
      ip,
      outcome,
      expired,
      expiresAt: now + UserCodeRateLimiter.SETTLED_TTL_MS,
    });
  }

  /**
   * Settle a reservation: once, for the IP that holds it.
   * - the same id again: ignored, with the first outcome;
   * - another IP's id: ignored (its reservation is not consumed);
   * - live: the slot is freed (and a failure counted for `failure`);
   * - lapsed or unknown (it ran out, or the object restarted): reported `expired`, and counted as
   *   one failure whether it is settled as a `failure` or as `released`: a legitimate settle must
   *   not be dropped, a lapse must not be a free guess, and what the lookup found must not show in
   *   the budget.
   * Everything up to the remembering is synchronous, so two settles of one id cannot both count.
   */
  private async settleReservation(
    id: string,
    ip: string,
    outcome: 'failure' | 'released'
  ): Promise<{ settled?: true; expired?: boolean; outcome?: string; ignored?: true }> {
    const now = Date.now();
    const previous = this.settled.get(id);
    if (previous && previous.expiresAt > now) {
      return previous.ip === ip
        ? { settled: true, expired: previous.expired, outcome: previous.outcome }
        : { ignored: true };
    }
    const live = this.reservations.get(id);
    if (live && live.ip !== ip) {
      return { ignored: true };
    }
    this.reservations.delete(id);
    const expired = !live || live.expiresAt <= now;
    this.rememberSettled(id, ip, outcome, expired, now);
    if (outcome === 'failure' || expired) await this.recordFailure(ip);
    return { settled: true, expired, outcome };
  }

  /**
   * Decide and hold one guess in a single synchronous step (no await between the decision and the
   * reservation, so two requests cannot both see the last free slot).
   */
  private reserve(ip: string): {
    blocked: boolean;
    retry_after?: number;
    reservation_id?: string;
  } {
    const now = Date.now();
    const attempt = this.attempts.get(ip);
    if (this.isBlockedAt(attempt, now)) {
      return { blocked: true, retry_after: this.getRetryAfter(ip) };
    }
    const hourAgo = now - 60 * 60 * 1000;
    const failures = attempt && attempt.firstFailureAt > hourAgo ? attempt.failureCount : 0;
    const inFlight = this.liveReservationsOf(ip, now);
    if (failures + inFlight.count >= UserCodeRateLimiter.MAX_ATTEMPTS_PER_HOUR) {
      // Not blocked yet, but the budget is spoken for by guesses in flight: try again when the
      // earliest of them has settled or lapsed
      return {
        blocked: true,
        retry_after: Math.max(1, Math.ceil((inFlight.earliestExpiry - now) / 1000)),
      };
    }
    const reservationId = crypto.randomUUID();
    this.reservations.set(reservationId, {
      ip,
      expiresAt: now + UserCodeRateLimiter.RESERVATION_TTL_MS,
    });
    return { blocked: false, reservation_id: reservationId };
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

        this.log.warn('Blocking IP due to failed attempts', {
          ip,
          blockDurationSeconds: Math.round(blockDuration / 1000),
          failedAttempts: newCount,
        });
      }

      this.attempts.set(ip, attempt);
    }

    await this.persist();
  }

  /**
   * Cleanup expired rate limit records
   */
  async alarm(): Promise<void> {
    await this.initialize();
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    let cleaned = 0;

    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) this.reservations.delete(id);
    }
    for (const [id, entry] of this.settled) {
      if (entry.expiresAt <= now) this.settled.delete(id);
    }

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
      this.log.info('Cleaned up expired rate limit records', { count: cleaned });
      await this.persist();
    }

    // Schedule next cleanup
    await this.state.storage.setAlarm(Date.now() + UserCodeRateLimiter.CLEANUP_INTERVAL_MS);
  }
}
