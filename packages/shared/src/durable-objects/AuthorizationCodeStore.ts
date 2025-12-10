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
 *
 * Configuration Priority:
 * - KV (AUTHRIM_CONFIG namespace) > Environment variable > Default value
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { createOAuthConfigManager, type OAuthConfigManager } from '../utils/oauth-config';

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
  claims?: string; // OIDC claims parameter (JSON string)
  authTime?: number; // OIDC auth_time (authentication timestamp)
  acr?: string; // OIDC acr (Authentication Context Class Reference)
  cHash?: string; // OIDC c_hash for hybrid flows (RFC 3.3.2.11)
  dpopJkt?: string; // DPoP JWK thumbprint (RFC 9449) - binds code to DPoP key
  sid?: string; // OIDC Session Management: Session ID for RP-Initiated Logout
  used: boolean;
  expiresAt: number;
  createdAt: number;
  // Token JTIs for replay attack revocation (RFC 6749 Section 4.1.2)
  issuedAccessTokenJti?: string;
  issuedRefreshTokenJti?: string;
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
  claims?: string;
  authTime?: number;
  acr?: string;
  cHash?: string; // OIDC c_hash for hybrid flows
  dpopJkt?: string; // DPoP JWK thumbprint (RFC 9449)
  sid?: string; // OIDC Session Management: Session ID for RP-Initiated Logout
}

/**
 * Consume code request
 */
export interface ConsumeCodeRequest {
  code: string;
  clientId: string;
  codeVerifier?: string;
  // Optional: Register issued token JTIs in the same atomic operation (DO hop optimization)
  accessTokenJti?: string;
  refreshTokenJti?: string;
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
  claims?: string;
  authTime?: number;
  acr?: string;
  cHash?: string; // OIDC c_hash for hybrid flows
  dpopJkt?: string; // DPoP JWK thumbprint (RFC 9449)
  sid?: string; // OIDC Session Management: Session ID for RP-Initiated Logout
  // Present when replay attack is detected - contains JTIs to revoke
  replayAttack?: {
    accessTokenJti?: string;
    refreshTokenJti?: string;
  };
}

/**
 * Storage key prefix for individual authorization codes
 * Each code is stored as: `code:${code}` -> AuthorizationCode
 * This enables O(1) read/write operations instead of O(n) full state serialization
 */
const CODE_KEY_PREFIX = 'code:';

/**
 * AuthorizationCodeStore Durable Object
 *
 * Provides distributed authorization code storage with one-time use guarantee.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., storeCodeRpc, consumeCodeRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 *
 * SECURITY NOTE:
 * This DO handles security-critical operations including:
 * - Replay attack detection
 * - One-time code consumption (consume-once guarantee)
 * - PKCE validation
 * - Nonce binding
 * Worker callers should implement fetch fallback for RPC failures.
 */
export class AuthorizationCodeStore extends DurableObject<Env> {
  private codes: Map<string, AuthorizationCode> = new Map();
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;
  private configManager: OAuthConfigManager;

  // Configuration (loaded from KV > env > default in initializeState)
  private CODE_TTL: number; // Default: 60 seconds per OAuth 2.0 Security BCP
  private CLEANUP_INTERVAL_MS: number; // Default: 30 seconds
  private MAX_CODES_PER_USER: number; // DDoS protection

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Create config manager for KV > env > default priority
    this.configManager = createOAuthConfigManager(env);

    // Set initial values from environment (will be updated in initializeState with KV values)
    // Default: 60 seconds per OAuth 2.0 Security BCP, but can be increased for load testing
    const codeTtlEnv = env.AUTH_CODE_TTL;
    this.CODE_TTL = codeTtlEnv && !isNaN(Number(codeTtlEnv)) ? Number(codeTtlEnv) : 60;

    // Configure CLEANUP_INTERVAL_MS from environment variable (in seconds, converted to ms)
    // Default: 30 seconds, but can be increased for load testing with many seeds
    const cleanupIntervalEnv = env.AUTH_CODE_CLEANUP_INTERVAL;
    this.CLEANUP_INTERVAL_MS =
      cleanupIntervalEnv && !isNaN(Number(cleanupIntervalEnv))
        ? Number(cleanupIntervalEnv) * 1000
        : 30 * 1000;

    // Configure MAX_CODES_PER_USER from environment variable
    // Default: 100, but can be increased for load testing
    const maxCodesEnv = env.MAX_CODES_PER_USER;
    this.MAX_CODES_PER_USER =
      maxCodesEnv && !isNaN(Number(maxCodesEnv)) ? Number(maxCodesEnv) : 100;

    // State and config will be fully initialized on first request (async)
  }

  // ==========================================
  // RPC Methods (public, with 'Rpc' suffix)
  // ==========================================

  /**
   * RPC: Store authorization code
   */
  async storeCodeRpc(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }> {
    return this.storeCode(request);
  }

  /**
   * RPC: Consume authorization code (one-time use, atomic operation)
   * SECURITY CRITICAL: This method handles replay attack detection and PKCE validation
   */
  async consumeCodeRpc(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    return this.consumeCode(request);
  }

  /**
   * RPC: Check if code exists
   */
  async hasCodeRpc(code: string): Promise<boolean> {
    return this.hasCode(code);
  }

  /**
   * RPC: Delete code manually
   */
  async deleteCodeRpc(code: string): Promise<boolean> {
    return this.deleteCode(code);
  }

  /**
   * RPC: Register issued token JTIs for replay attack revocation
   */
  async registerIssuedTokensRpc(
    code: string,
    accessTokenJti: string,
    refreshTokenJti?: string
  ): Promise<boolean> {
    return this.registerIssuedTokens(code, accessTokenJti, refreshTokenJti);
  }

  /**
   * RPC: Get status/health check
   */
  async getStatusRpc(): Promise<{
    status: string;
    codes: { total: number; active: number; expired: number };
    config: { ttl: number; maxCodesPerUser: number };
    timestamp: number;
  }> {
    await this.initializeState();
    const now = Date.now();
    let activeCodes = 0;

    for (const authCode of this.codes.values()) {
      if (authCode.expiresAt > now) {
        activeCodes++;
      }
    }

    return {
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
    };
  }

  /**
   * RPC: Force reload configuration from KV
   */
  async reloadConfigRpc(): Promise<{
    status: string;
    message?: string;
    config?: {
      previous: { ttl: number; maxCodesPerUser: number };
      current: { ttl: number; maxCodesPerUser: number };
    };
  }> {
    const previousTTL = this.CODE_TTL;
    const previousMaxCodes = this.MAX_CODES_PER_USER;

    // Clear configManager cache to force fresh KV read
    this.configManager.clearCache();

    // Reload configuration from KV
    this.CODE_TTL = await this.configManager.getAuthCodeTTL();
    this.MAX_CODES_PER_USER = await this.configManager.getMaxCodesPerUser();

    console.log(
      `AuthCodeStore: Config reloaded - CODE_TTL: ${previousTTL}s → ${this.CODE_TTL}s, ` +
        `MAX_CODES_PER_USER: ${previousMaxCodes} → ${this.MAX_CODES_PER_USER}`
    );

    return {
      status: 'ok',
      message: 'Configuration reloaded',
      config: {
        previous: { ttl: previousTTL, maxCodesPerUser: previousMaxCodes },
        current: { ttl: this.CODE_TTL, maxCodesPerUser: this.MAX_CODES_PER_USER },
      },
    };
  }

  // ==========================================
  // Internal Methods
  // ==========================================

  /**
   * Initialize state from Durable Storage and load configuration from KV
   * Must be called before any code operations
   *
   * Configuration Priority: KV > Environment variable > Default value
   *
   * Storage Architecture (v2):
   * - Individual key storage: `code:${code}` for each authorization code
   * - O(1) reads/writes per code operation
   * - list() only called once at DO startup, not on every request
   */
  private async initializeState(): Promise<void> {
    // CRITICAL: Guard to prevent repeated list() calls
    if (this.initialized) {
      return;
    }

    // Load configuration from KV (with env/default fallback)
    try {
      this.CODE_TTL = await this.configManager.getAuthCodeTTL();
      this.MAX_CODES_PER_USER = await this.configManager.getMaxCodesPerUser();
      console.log(
        `AuthCodeStore: Loaded config from KV - CODE_TTL: ${this.CODE_TTL}s, MAX_CODES_PER_USER: ${this.MAX_CODES_PER_USER}`
      );
    } catch (error) {
      console.warn(
        'AuthCodeStore: Failed to load config from KV, using env/default values:',
        error
      );
      // Keep constructor-initialized values (from env)
    }

    try {
      // Load all codes from individual key storage (code:*)
      const storedCodes = await this.ctx.storage.list<AuthorizationCode>({
        prefix: CODE_KEY_PREFIX,
      });

      for (const [key, authCode] of storedCodes) {
        // Extract code from key (remove prefix)
        const code = key.substring(CODE_KEY_PREFIX.length);
        this.codes.set(code, authCode);
      }

      if (this.codes.size > 0) {
        console.log(
          `AuthCodeStore: Restored ${this.codes.size} authorization codes from Durable Storage`
        );
      }
    } catch (error) {
      console.error('AuthCodeStore: Failed to initialize from Durable Storage:', error);
      // Continue with empty state
    }

    this.initialized = true;

    // Start periodic cleanup after initialization
    this.startCleanup();
  }

  /**
   * Build storage key for a code
   */
  private buildCodeKey(code: string): string {
    return `${CODE_KEY_PREFIX}${code}`;
  }

  /**
   * Start periodic cleanup of expired codes
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredCodes();
      }, this.CLEANUP_INTERVAL_MS) as unknown as number;
    }
  }

  /**
   * Cleanup expired codes from memory and Durable Storage
   * Uses batch delete for efficiency
   */
  private async cleanupExpiredCodes(): Promise<void> {
    const now = Date.now();
    const expiredCodes: string[] = [];

    for (const [code, authCode] of this.codes.entries()) {
      if (authCode.expiresAt <= now) {
        this.codes.delete(code);
        expiredCodes.push(code);
      }
    }

    // Batch delete from Durable Storage - O(k) where k = expired codes
    if (expiredCodes.length > 0) {
      const deleteKeys = expiredCodes.map((c) => this.buildCodeKey(c));
      await this.ctx.storage.delete(deleteKeys);
      console.log(`AuthCodeStore: Cleaned up ${expiredCodes.length} expired codes`);
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
   * O(1) operation - stores individual key
   */
  async storeCode(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }> {
    await this.initializeState();

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
      claims: request.claims,
      authTime: request.authTime,
      acr: request.acr,
      cHash: request.cHash,
      dpopJkt: request.dpopJkt,
      sid: request.sid, // OIDC Session Management: Session ID for RP-Initiated Logout
      used: false,
      expiresAt: now + this.CODE_TTL * 1000,
      createdAt: now,
    };

    // Store in memory
    this.codes.set(request.code, authCode);

    // Persist to Durable Storage - O(1) individual key
    await this.ctx.storage.put(this.buildCodeKey(request.code), authCode);

    return {
      success: true,
      expiresAt: authCode.expiresAt,
    };
  }

  /**
   * Consume authorization code (one-time use, atomic operation)
   *
   * Security: MUST read code to check `used` flag for replay attack detection.
   * Durable Objects' single-threaded execution model provides atomic guarantees.
   *
   * Optimization: Lazy-load + fallback get pattern
   * - First check memory cache (this.codes)
   * - If not found, try storage.get() as fallback
   */
  async consumeCode(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    await this.initializeState();

    // Lazy-load + fallback get: Check memory first, then storage
    let stored = this.codes.get(request.code);

    if (!stored) {
      // Fallback: Try to load from storage (handles edge case where code was stored
      // but DO restarted before initializeState saw it)
      const fromStorage = await this.ctx.storage.get<AuthorizationCode>(
        this.buildCodeKey(request.code)
      );
      if (fromStorage) {
        stored = fromStorage;
        // Promote to memory cache
        this.codes.set(request.code, stored);
      }
    }

    if (!stored) {
      throw new Error('invalid_grant: Authorization code not found or expired');
    }

    // Check expiration
    if (this.isExpired(stored)) {
      this.codes.delete(request.code);
      await this.ctx.storage.delete(this.buildCodeKey(request.code));
      throw new Error('invalid_grant: Authorization code expired');
    }

    // CRITICAL: Check if already used (replay attack detection)
    if (stored.used) {
      console.warn(
        `SECURITY: Replay attack detected! Code ${request.code} already used by user ${stored.userId}`
      );

      // OAuth 2.0 Security BCP (RFC 6749 Section 4.1.2):
      // "If an authorization code is used more than once, the authorization server
      //  MUST deny the request and SHOULD revoke (when possible) all tokens
      //  previously issued based on that authorization code."
      //
      // Log the JTIs for revocation (to be handled by the caller or a background job)
      if (stored.issuedAccessTokenJti || stored.issuedRefreshTokenJti) {
        console.warn(
          `SECURITY: Tokens to revoke - AccessToken JTI: ${stored.issuedAccessTokenJti}, RefreshToken JTI: ${stored.issuedRefreshTokenJti}`
        );
      }

      // Throw error to deny the request per RFC 6749
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

    // Register issued token JTIs in the same atomic operation (DO hop optimization)
    // This allows replay attack detection and token revocation without a separate DO call
    if (request.accessTokenJti) {
      stored.issuedAccessTokenJti = request.accessTokenJti;
    }
    if (request.refreshTokenJti) {
      stored.issuedRefreshTokenJti = request.refreshTokenJti;
    }

    this.codes.set(request.code, stored);

    // Persist to Durable Storage - O(1) individual key
    await this.ctx.storage.put(this.buildCodeKey(request.code), stored);

    // Return authorization data
    return {
      userId: stored.userId,
      scope: stored.scope,
      redirectUri: stored.redirectUri,
      nonce: stored.nonce,
      state: stored.state,
      claims: stored.claims,
      authTime: stored.authTime,
      acr: stored.acr,
      cHash: stored.cHash,
      dpopJkt: stored.dpopJkt,
      sid: stored.sid, // OIDC Session Management: Session ID for RP-Initiated Logout
    };
  }

  /**
   * Check if code exists (for testing/debugging)
   */
  async hasCode(code: string): Promise<boolean> {
    await this.initializeState();
    const stored = this.codes.get(code);
    return stored !== undefined && !this.isExpired(stored);
  }

  /**
   * Delete code manually (cleanup)
   * O(1) operation - deletes individual key
   */
  async deleteCode(code: string): Promise<boolean> {
    await this.initializeState();
    const deleted = this.codes.delete(code);
    if (deleted) {
      // Delete from Durable Storage - O(1) individual key
      await this.ctx.storage.delete(this.buildCodeKey(code));
    }
    return deleted;
  }

  /**
   * Register issued token JTIs for replay attack revocation
   * Called after tokens are issued for an authorization code
   * O(1) operation - updates individual key
   */
  async registerIssuedTokens(
    code: string,
    accessTokenJti: string,
    refreshTokenJti?: string
  ): Promise<boolean> {
    await this.initializeState();
    const stored = this.codes.get(code);
    if (!stored) {
      console.warn(`AuthCodeStore: Cannot register tokens for unknown code ${code}`);
      return false;
    }

    stored.issuedAccessTokenJti = accessTokenJti;
    if (refreshTokenJti) {
      stored.issuedRefreshTokenJti = refreshTokenJti;
    }
    this.codes.set(code, stored);

    // Persist to Durable Storage - O(1) individual key
    await this.ctx.storage.put(this.buildCodeKey(code), stored);

    console.log(`AuthCodeStore: Registered token JTIs for code ${code.substring(0, 8)}...`);
    return true;
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
        const body = (await request.json()) as Partial<StoreCodeRequest>;

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

        const result = await this.storeCode(body as StoreCodeRequest);

        return new Response(JSON.stringify(result), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /code/consume - Consume authorization code
      if (path === '/code/consume' && request.method === 'POST') {
        const body = (await request.json()) as Partial<ConsumeCodeRequest>;

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
          const result = await this.consumeCode(body as ConsumeCodeRequest);

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

      // POST /code/:code/tokens - Register issued token JTIs for replay attack revocation
      if (path.startsWith('/code/') && path.endsWith('/tokens') && request.method === 'POST') {
        const code = path.substring(6, path.length - 7); // Remove '/code/' and '/tokens'
        const body = (await request.json()) as {
          accessTokenJti?: string;
          refreshTokenJti?: string;
        };

        if (!body.accessTokenJti) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'accessTokenJti is required',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const success = await this.registerIssuedTokens(
          code,
          body.accessTokenJti,
          body.refreshTokenJti
        );

        return new Response(JSON.stringify({ success }), {
          status: success ? 200 : 404,
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
        await this.initializeState();

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

      // POST /reload-config - Force reload configuration from KV
      // Used for updating TTL and other settings without restarting the DO
      if (path === '/reload-config' && request.method === 'POST') {
        const previousTTL = this.CODE_TTL;
        const previousMaxCodes = this.MAX_CODES_PER_USER;

        try {
          // Clear configManager cache to force fresh KV read
          this.configManager.clearCache();

          // Reload configuration from KV
          this.CODE_TTL = await this.configManager.getAuthCodeTTL();
          this.MAX_CODES_PER_USER = await this.configManager.getMaxCodesPerUser();

          console.log(
            `AuthCodeStore: Config reloaded - CODE_TTL: ${previousTTL}s → ${this.CODE_TTL}s, ` +
              `MAX_CODES_PER_USER: ${previousMaxCodes} → ${this.MAX_CODES_PER_USER}`
          );

          return new Response(
            JSON.stringify({
              status: 'ok',
              message: 'Configuration reloaded',
              config: {
                previous: { ttl: previousTTL, maxCodesPerUser: previousMaxCodes },
                current: { ttl: this.CODE_TTL, maxCodesPerUser: this.MAX_CODES_PER_USER },
              },
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        } catch (error) {
          console.error('AuthCodeStore: Failed to reload config:', error);
          return new Response(
            JSON.stringify({
              status: 'error',
              message: error instanceof Error ? error.message : 'Failed to reload config',
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
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
