/**
 * ChallengeStore Durable Object
 *
 * Manages one-time challenges for Passkey and Email Code authentication
 * with atomic consume operations to prevent replay attacks.
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
 */

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
  | 'consent';

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
 * Persistent state stored in Durable Storage
 */
interface ChallengeStoreState {
  challenges: Record<string, Challenge>;
  lastCleanup: number;
}

/**
 * ChallengeStore Durable Object
 *
 * Provides atomic one-time challenge management for authentication flows.
 */
export class ChallengeStore {
  private state: DurableObjectState;
  private env: Env;
  private challenges: Map<string, Challenge> = new Map();
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

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
      const stored = await this.state.storage.get<ChallengeStoreState>('state');

      if (stored) {
        this.challenges = new Map(Object.entries(stored.challenges));
        console.log(`ChallengeStore: Restored ${this.challenges.size} challenges from Durable Storage`);
      }
    } catch (error) {
      console.error('ChallengeStore: Failed to initialize from Durable Storage:', error);
    }

    this.initialized = true;
    this.startCleanup();
  }

  /**
   * Save current state to Durable Storage
   */
  private async saveState(): Promise<void> {
    try {
      const stateToSave: ChallengeStoreState = {
        challenges: Object.fromEntries(this.challenges),
        lastCleanup: Date.now(),
      };

      await this.state.storage.put('state', stateToSave);
    } catch (error) {
      console.error('ChallengeStore: Failed to save to Durable Storage:', error);
    }
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
   * Cleanup expired challenges
   */
  private async cleanupExpiredChallenges(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, challenge] of this.challenges.entries()) {
      if (challenge.expiresAt <= now || challenge.consumed) {
        this.challenges.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`ChallengeStore: Cleaned up ${cleaned} expired/consumed challenges`);
      await this.saveState();
    }
  }

  /**
   * Store a new challenge
   */
  async storeChallenge(request: StoreChallengeRequest): Promise<void> {
    await this.initializeState();

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

    this.challenges.set(request.id, challenge);
    await this.saveState();
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
    await this.initializeState();

    const challenge = this.challenges.get(request.id);

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
    if (challenge.expiresAt <= Date.now()) {
      this.challenges.delete(request.id);
      await this.saveState();
      throw new Error('Challenge expired');
    }

    // Challenge value mismatch (if provided)
    if (request.challenge && challenge.challenge !== request.challenge) {
      throw new Error('Challenge value mismatch');
    }

    // ATOMIC: Mark as consumed (prevents parallel replay)
    challenge.consumed = true;
    this.challenges.set(request.id, challenge);
    await this.saveState();

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
   */
  async deleteChallenge(id: string): Promise<boolean> {
    await this.initializeState();

    const had = this.challenges.has(id);
    this.challenges.delete(id);

    if (had) {
      await this.saveState();
    }

    return had;
  }

  /**
   * Get challenge info (without consuming)
   * Used for validation before consumption
   */
  async getChallenge(id: string): Promise<Challenge | null> {
    await this.initializeState();
    return this.challenges.get(id) || null;
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

        return new Response(
          JSON.stringify({ success: true }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }
        );
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
          return new Response(
            JSON.stringify({ error: 'Challenge not found' }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // Don't expose the actual challenge value
        return new Response(
          JSON.stringify({
            id: challenge.id,
            type: challenge.type,
            userId: challenge.userId,
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
        const now = Date.now();
        let activeCount = 0;

        for (const challenge of this.challenges.values()) {
          if (!challenge.consumed && challenge.expiresAt > now) {
            activeCount++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            challenges: {
              total: this.challenges.size,
              active: activeCount,
              consumed: this.challenges.size - activeCount,
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
