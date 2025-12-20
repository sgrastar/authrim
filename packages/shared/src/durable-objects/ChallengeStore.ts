/**
 * ChallengeStore Durable Object
 *
 * Manages one-time challenges for Passkey and Email Code authentication
 * with atomic consume operations to prevent replay attacks.
 *
 * Storage Architecture (v2):
 * - Individual key storage: `challenge:${id}` for each challenge
 * - O(1) reads/writes per challenge operation
 * - Sharding support: Multiple DO instances distribute load
 *
 * Security Features:
 * - Atomic consume (check + delete in single operation)
 * - TTL enforcement
 * - Challenge type validation
 * - Prevents parallel replay attacks
 *
 * Challenge Types:
 * - passkey_registration: WebAuthn registration challenge
 * - passkey_authentication: WebAuthn authentication challenge
 * - email_code: Email-based OTP verification code
 * - session_token: ITP-bypass session token (single-use)
 * - reauth: Re-authentication confirmation challenge (prompt=login, max_age)
 * - login: Login flow challenge (session-less authentication)
 * - consent: OAuth consent flow challenge
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., storeChallengeRpc, consumeChallengeRpc)
 * - fetch() handler is maintained for backward compatibility
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';

/**
 * Challenge types
 */
export type ChallengeType =
  | 'passkey_registration'
  | 'passkey_authentication'
  | 'email_code'
  | 'session_token'
  | 'reauth'
  | 'login'
  | 'consent'
  | 'did_authentication' // DID-based authentication
  | 'did_registration'; // DID linking to existing account

/**
 * Challenge metadata
 */
export interface Challenge {
  id: string;
  type: ChallengeType;
  userId: string;
  challenge: string; // The actual challenge/token value
  email?: string; // For magic link
  redirectUri?: string; // For magic link
  metadata?: Record<string, unknown>; // Additional type-specific data
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

/**
 * Store challenge request
 */
export interface StoreChallengeRequest {
  id: string; // Unique challenge ID (e.g., userId for passkey, token for magic link)
  type: ChallengeType;
  userId: string;
  challenge: string;
  ttl: number; // Time to live in seconds
  email?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Consume challenge request
 */
export interface ConsumeChallengeRequest {
  id: string;
  type: ChallengeType;
  challenge?: string; // Optional: If provided, must match stored challenge
}

/**
 * Consume challenge response
 */
export interface ConsumeChallengeResponse {
  challenge: string; // The actual challenge value
  userId: string;
  email?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Storage key prefix for challenges
 */
const CHALLENGE_KEY_PREFIX = 'challenge:';

/**
 * ChallengeStore Durable Object
 *
 * Provides atomic one-time challenge management for authentication flows.
 * Uses individual key storage for O(1) operations.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., storeChallengeRpc, consumeChallengeRpc)
 * - fetch() handler is maintained for backward compatibility
 */
export class ChallengeStore extends DurableObject<Env> {
  private challengeCache: Map<string, Challenge> = new Map();
  private cleanupInterval: number | null = null;

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Build storage key for a challenge
   */
  private buildChallengeKey(id: string): string {
    return `${CHALLENGE_KEY_PREFIX}${id}`;
  }

  // ==========================================
  // RPC Methods (public, with 'Rpc' suffix)
  // ==========================================

  /**
   * RPC: Store a new challenge
   */
  async storeChallengeRpc(request: StoreChallengeRequest): Promise<{ success: boolean }> {
    await this.storeChallenge(request);
    return { success: true };
  }

  /**
   * RPC: Consume a challenge (atomic check + delete)
   * SECURITY CRITICAL: Prevents replay attacks through atomic operation
   */
  async consumeChallengeRpc(request: ConsumeChallengeRequest): Promise<ConsumeChallengeResponse> {
    return this.consumeChallenge(request);
  }

  /**
   * RPC: Delete a challenge
   */
  async deleteChallengeRpc(id: string): Promise<{ deleted: boolean }> {
    const deleted = await this.deleteChallenge(id);
    return { deleted };
  }

  /**
   * RPC: Get challenge info (without consuming)
   */
  async getChallengeRpc(id: string): Promise<Challenge | null> {
    return this.getChallenge(id);
  }

  /**
   * RPC: Get status/health check
   */
  async getStatusRpc(): Promise<{
    status: string;
    challenges: { total: number; active: number; consumed: number };
    timestamp: number;
  }> {
    const now = Date.now();

    // Count challenges from storage
    const storedChallenges = await this.ctx.storage.list<Challenge>({
      prefix: CHALLENGE_KEY_PREFIX,
    });

    let activeCount = 0;
    for (const [, challenge] of storedChallenges) {
      if (!challenge.consumed && challenge.expiresAt > now) {
        activeCount++;
      }
    }

    return {
      status: 'ok',
      challenges: {
        total: storedChallenges.size,
        active: activeCount,
        consumed: storedChallenges.size - activeCount,
      },
      timestamp: now,
    };
  }

  // ==========================================
  // Internal Methods
  // ==========================================

  /**
   * Check if challenge is expired
   */
  private isExpired(challenge: Challenge): boolean {
    return challenge.expiresAt <= Date.now();
  }

  /**
   * Start periodic cleanup of expired challenges
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        void this.cleanupExpiredChallenges();
      }, this.CLEANUP_INTERVAL) as unknown as number;
    }
  }

  /**
   * Cleanup expired challenges from memory cache and Durable Storage
   */
  private async cleanupExpiredChallenges(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    // Clean memory cache
    for (const [id, challenge] of this.challengeCache.entries()) {
      if (challenge.expiresAt <= now || challenge.consumed) {
        this.challengeCache.delete(id);
        // Delete from Durable Storage
        await this.ctx.storage.delete(this.buildChallengeKey(id));
        cleaned++;
      }
    }

    // Also scan storage for expired challenges not in cache
    const storedChallenges = await this.ctx.storage.list<Challenge>({
      prefix: CHALLENGE_KEY_PREFIX,
    });

    for (const [key, challenge] of storedChallenges) {
      if (challenge.expiresAt <= now || challenge.consumed) {
        await this.ctx.storage.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`ChallengeStore: Cleaned up ${cleaned} expired/consumed challenges`);
    }
  }

  /**
   * Store a new challenge
   */
  async storeChallenge(request: StoreChallengeRequest): Promise<void> {
    const now = Date.now();
    const challenge: Challenge = {
      id: request.id,
      type: request.type,
      userId: request.userId,
      challenge: request.challenge,
      email: request.email,
      redirectUri: request.redirectUri,
      metadata: request.metadata,
      createdAt: now,
      expiresAt: now + request.ttl * 1000,
      consumed: false,
    };

    // 1. Store in memory cache (hot)
    this.challengeCache.set(request.id, challenge);

    // 2. Persist to Durable Storage (individual key - O(1))
    await this.ctx.storage.put(this.buildChallengeKey(request.id), challenge);
  }

  /**
   * Consume a challenge (atomic check + delete)
   *
   * CRITICAL: This operation is atomic within the DO
   * - Checks if challenge exists
   * - Marks as consumed
   * - Returns challenge value and data
   *
   * Parallel requests will fail because first request marks as consumed.
   *
   * If challenge parameter is provided, it must match the stored value.
   */
  async consumeChallenge(request: ConsumeChallengeRequest): Promise<ConsumeChallengeResponse> {
    // 1. Check in-memory cache (hot)
    let challenge = this.challengeCache.get(request.id);

    // 2. If not in cache, check Durable Storage
    if (!challenge) {
      const storedChallenge = await this.ctx.storage.get<Challenge>(
        this.buildChallengeKey(request.id)
      );
      if (storedChallenge) {
        challenge = storedChallenge;
        // Promote to cache
        this.challengeCache.set(request.id, challenge);
      }
    }

    // Challenge not found
    if (!challenge) {
      throw new Error('Challenge not found or already consumed');
    }

    // Type mismatch
    if (challenge.type !== request.type) {
      throw new Error('Challenge type mismatch');
    }

    // Already consumed
    if (challenge.consumed) {
      throw new Error('Challenge already consumed');
    }

    // Expired
    if (this.isExpired(challenge)) {
      // Cleanup expired challenge
      this.challengeCache.delete(request.id);
      await this.ctx.storage.delete(this.buildChallengeKey(request.id));
      throw new Error('Challenge expired');
    }

    // Challenge value mismatch (if provided)
    if (request.challenge && challenge.challenge !== request.challenge) {
      throw new Error('Challenge value mismatch');
    }

    // ATOMIC: Mark as consumed (prevents parallel replay)
    challenge.consumed = true;
    this.challengeCache.set(request.id, challenge);
    await this.ctx.storage.put(this.buildChallengeKey(request.id), challenge);

    // Return challenge value and data
    return {
      challenge: challenge.challenge,
      userId: challenge.userId,
      email: challenge.email,
      redirectUri: challenge.redirectUri,
      metadata: challenge.metadata,
    };
  }

  /**
   * Delete a challenge (for cleanup or cancellation)
   *
   * Optimized: No read-before-delete pattern.
   * storage.delete() is idempotent and works safely on non-existent keys.
   */
  async deleteChallenge(id: string): Promise<boolean> {
    // 1. Remove from memory cache
    const hadInCache = this.challengeCache.has(id);
    this.challengeCache.delete(id);

    // 2. Delete from Durable Storage (individual key - O(1))
    // No need to check existence first - delete() is idempotent
    await this.ctx.storage.delete(this.buildChallengeKey(id));

    return hadInCache;
  }

  /**
   * Get challenge info (without consuming)
   * Used for validation before consumption
   */
  async getChallenge(id: string): Promise<Challenge | null> {
    // 1. Check in-memory cache (hot)
    let challenge = this.challengeCache.get(id);

    // 2. If not in cache, check Durable Storage
    if (!challenge) {
      const storedChallenge = await this.ctx.storage.get<Challenge>(this.buildChallengeKey(id));
      if (storedChallenge) {
        challenge = storedChallenge;
        // Promote to cache
        this.challengeCache.set(id, challenge);
      }
    }

    if (!challenge) {
      return null;
    }

    // Check expiration
    if (this.isExpired(challenge)) {
      // Cleanup expired challenge
      this.challengeCache.delete(id);
      await this.ctx.storage.delete(this.buildChallengeKey(id));
      return null;
    }

    return challenge;
  }

  /**
   * Handle HTTP requests to the ChallengeStore Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /challenge - Store new challenge
      if (path === '/challenge' && request.method === 'POST') {
        const body = (await request.json()) as Partial<StoreChallengeRequest>;

        if (!body.id || !body.type || !body.userId || !body.challenge || !body.ttl) {
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

        await this.storeChallenge(body as StoreChallengeRequest);

        return new Response(JSON.stringify({ success: true }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /challenge/consume - Consume challenge (atomic)
      if (path === '/challenge/consume' && request.method === 'POST') {
        const body = (await request.json()) as Partial<ConsumeChallengeRequest>;

        // Note: challenge field is optional - it's only validated if provided
        if (!body.id || !body.type) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields: id and type',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        try {
          const result = await this.consumeChallenge(body as ConsumeChallengeRequest);

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return new Response(
            JSON.stringify({
              error: 'invalid_challenge',
              error_description: message,
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      }

      // DELETE /challenge/:id - Delete challenge
      if (path.startsWith('/challenge/') && request.method === 'DELETE') {
        const id = path.substring(11); // Remove '/challenge/'
        const deleted = await this.deleteChallenge(id);

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

      // GET /challenge/:id - Get challenge info
      if (path.startsWith('/challenge/') && request.method === 'GET') {
        const id = path.substring(11);
        const challenge = await this.getChallenge(id);

        if (!challenge) {
          return new Response(JSON.stringify({ error: 'Challenge not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Return challenge info including metadata (needed for consent flow)
        // Note: The actual challenge value is not exposed for security
        return new Response(
          JSON.stringify({
            id: challenge.id,
            type: challenge.type,
            userId: challenge.userId,
            metadata: challenge.metadata, // Include metadata for consent flow
            createdAt: challenge.createdAt,
            expiresAt: challenge.expiresAt,
            consumed: challenge.consumed,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /status - Health check
      if (path === '/status' && request.method === 'GET') {
        const status = await this.getStatusRpc();

        return new Response(JSON.stringify(status), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('ChallengeStore error:', error);
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
