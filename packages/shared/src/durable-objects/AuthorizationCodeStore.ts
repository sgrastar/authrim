/**
 * AuthorizationCodeStore Durable Object
 *
 * Manages one-time authorization codes with strong consistency guarantees.
 * Provides replay attack prevention and PKCE support.
 *
 * Security Features:
 * - One-time use guarantee (CRITICAL for OAuth 2.0 security)
 * - Short TTL (60 seconds per OAuth 2.0 Security BCP)
 * - Atomic consume operation (Durable Object guarantees)
 * - PKCE validation (code_challenge/code_verifier)
 * - Replay attack detection and token revocation
 *
 * OAuth 2.0 Security Best Current Practice (BCP) Compliance:
 * - RFC 6749: Authorization Code Grant
 * - RFC 7636: Proof Key for Code Exchange (PKCE)
 * - OAuth 2.0 Security BCP: Draft 16
 */

import type { Env } from '../types/env';

/**
 * Authorization code metadata
 */
export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  nonce?: string;
  state?: string;
  used: boolean;
  expiresAt: number;
  createdAt: number;
}

/**
 * Store code request
 */
export interface StoreCodeRequest {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  nonce?: string;
  state?: string;
}

/**
 * Consume code request
 */
export interface ConsumeCodeRequest {
  code: string;
  clientId: string;
  codeVerifier?: string;
}

/**
 * Consume code response
 */
export interface ConsumeCodeResponse {
  userId: string;
  scope: string;
  redirectUri: string;
  nonce?: string;
  state?: string;
}

/**
 * AuthorizationCodeStore Durable Object
 *
 * Provides distributed authorization code storage with one-time use guarantee.
 */
export class AuthorizationCodeStore {
  private state: DurableObjectState;
  private env: Env;
  private codes: Map<string, AuthorizationCode> = new Map();
  private cleanupInterval: number | null = null;

  // Configuration
  private readonly CODE_TTL = 60; // 60 seconds per OAuth 2.0 Security BCP
  private readonly CLEANUP_INTERVAL = 30 * 1000; // 30 seconds
  private readonly MAX_CODES_PER_USER = 5; // DDoS protection

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of expired codes
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredCodes();
      }, this.CLEANUP_INTERVAL) as unknown as number;
    }
  }

  /**
   * Cleanup expired codes from memory
   */
  private cleanupExpiredCodes(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [code, authCode] of this.codes.entries()) {
      if (authCode.expiresAt <= now) {
        this.codes.delete(code);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`AuthCodeStore: Cleaned up ${cleaned} expired codes`);
    }
  }

  /**
   * Check if code is expired
   */
  private isExpired(authCode: AuthorizationCode): boolean {
    return authCode.expiresAt <= Date.now();
  }

  /**
   * Generate code challenge from verifier (for PKCE validation)
   */
  private async generateCodeChallenge(
    verifier: string,
    method: 'S256' | 'plain' = 'S256'
  ): Promise<string> {
    if (method === 'plain') {
      return verifier;
    }

    // S256: base64url(sha256(verifier))
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);

    // Convert to base64url
    let base64 = btoa(String.fromCharCode(...hashArray));
    base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return base64;
  }

  /**
   * Count codes for a user (DDoS protection)
   */
  private countUserCodes(userId: string): number {
    let count = 0;
    const now = Date.now();

    for (const authCode of this.codes.values()) {
      if (authCode.userId === userId && authCode.expiresAt > now) {
        count++;
      }
    }

    return count;
  }

  /**
   * Store authorization code
   */
  async storeCode(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }> {
    // DDoS protection: Limit codes per user
    const userCodeCount = this.countUserCodes(request.userId);
    if (userCodeCount >= this.MAX_CODES_PER_USER) {
      throw new Error('Too many authorization codes for this user');
    }

    const now = Date.now();
    const authCode: AuthorizationCode = {
      code: request.code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      userId: request.userId,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      nonce: request.nonce,
      state: request.state,
      used: false,
      expiresAt: now + this.CODE_TTL * 1000,
      createdAt: now,
    };

    this.codes.set(request.code, authCode);

    return {
      success: true,
      expiresAt: authCode.expiresAt,
    };
  }

  /**
   * Consume authorization code (one-time use, atomic operation)
   */
  async consumeCode(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    const stored = this.codes.get(request.code);

    if (!stored) {
      throw new Error('invalid_grant: Authorization code not found or expired');
    }

    // Check expiration
    if (this.isExpired(stored)) {
      this.codes.delete(request.code);
      throw new Error('invalid_grant: Authorization code expired');
    }

    // CRITICAL: Check if already used (replay attack detection)
    if (stored.used) {
      console.warn(
        `SECURITY: Replay attack detected! Code ${request.code} already used by user ${stored.userId}`
      );

      // OAuth 2.0 Security BCP: Revoke all tokens for this authorization attempt
      // This prevents attackers from using stolen authorization codes
      // Note: Token revocation should be handled by the caller (Token Worker)
      // Here we just mark the replay attack

      throw new Error('invalid_grant: Authorization code already used (replay attack detected)');
    }

    // Validate client ID
    if (stored.clientId !== request.clientId) {
      throw new Error('invalid_grant: Client ID mismatch');
    }

    // Validate PKCE (if code_challenge was provided)
    if (stored.codeChallenge) {
      if (!request.codeVerifier) {
        throw new Error('invalid_grant: code_verifier required for PKCE');
      }

      const challenge = await this.generateCodeChallenge(
        request.codeVerifier,
        stored.codeChallengeMethod || 'S256'
      );

      if (challenge !== stored.codeChallenge) {
        throw new Error('invalid_grant: Invalid code_verifier (PKCE validation failed)');
      }
    }

    // Mark as used ATOMICALLY
    // Durable Objects guarantee strong consistency, so this is atomic
    stored.used = true;
    this.codes.set(request.code, stored);

    // Return authorization data
    return {
      userId: stored.userId,
      scope: stored.scope,
      redirectUri: stored.redirectUri,
      nonce: stored.nonce,
      state: stored.state,
    };
  }

  /**
   * Check if code exists (for testing/debugging)
   */
  async hasCode(code: string): Promise<boolean> {
    const stored = this.codes.get(code);
    return stored !== undefined && !this.isExpired(stored);
  }

  /**
   * Delete code manually (cleanup)
   */
  async deleteCode(code: string): Promise<boolean> {
    return this.codes.delete(code);
  }

  /**
   * Handle HTTP requests to the AuthorizationCodeStore Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /code - Store authorization code
      if (path === '/code' && request.method === 'POST') {
        const body = await request.json();

        // Validate required fields
        if (!body.code || !body.clientId || !body.redirectUri || !body.userId || !body.scope) {
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

        const result = await this.storeCode(body);

        return new Response(JSON.stringify(result), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /code/consume - Consume authorization code
      if (path === '/code/consume' && request.method === 'POST') {
        const body = await request.json();

        // Validate required fields
        if (!body.code || !body.clientId) {
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
          const result = await this.consumeCode(body);

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';

          // Extract OAuth 2.0 error code
          let errorCode = 'invalid_grant';
          let errorDescription = message;

          if (message.startsWith('invalid_grant:')) {
            errorDescription = message.substring(14).trim();
          }

          return new Response(
            JSON.stringify({
              error: errorCode,
              error_description: errorDescription,
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      }

      // GET /code/:code/exists - Check if code exists (testing/debugging)
      if (path.startsWith('/code/') && path.endsWith('/exists') && request.method === 'GET') {
        const code = path.substring(6, path.length - 7); // Remove '/code/' and '/exists'
        const exists = await this.hasCode(code);

        return new Response(JSON.stringify({ exists }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // DELETE /code/:code - Delete code manually
      if (path.startsWith('/code/') && request.method === 'DELETE') {
        const code = path.substring(6); // Remove '/code/'
        const deleted = await this.deleteCode(code);

        return new Response(
          JSON.stringify({
            success: true,
            deleted: deleted ? code : null,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /status - Health check and stats
      if (path === '/status' && request.method === 'GET') {
        const now = Date.now();
        let activeCodes = 0;

        for (const authCode of this.codes.values()) {
          if (authCode.expiresAt > now) {
            activeCodes++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            codes: {
              total: this.codes.size,
              active: activeCodes,
              expired: this.codes.size - activeCodes,
            },
            config: {
              ttl: this.CODE_TTL,
              maxCodesPerUser: this.MAX_CODES_PER_USER,
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
      console.error('AuthCodeStore error:', error);
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
