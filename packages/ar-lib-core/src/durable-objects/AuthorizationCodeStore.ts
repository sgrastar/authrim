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
import type { ActorContext } from '../actor';
import { CloudflareActorContext } from '../actor';
import { createLogger, type Logger } from '../utils/logger';

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
  authorizationDetails?: string; // RFC 9396 authorization_details (JSON string)
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
  authorizationDetails?: string; // RFC 9396 authorization_details (JSON string)
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
  authorizationDetails?: string; // RFC 9396: Rich Authorization Requests (JSON string)
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
  private actorCtx: ActorContext;
  private readonly log: Logger = createLogger().module('AuthorizationCodeStore');

  // User code counter for O(1) DDoS protection check (instead of O(n) scan)
  // Maps userId to count of active (non-expired) codes
  private userCodeCounts: Map<string, number> = new Map();

  // Configuration (loaded from KV > env > default in initializeState)
  private CODE_TTL: number; // Default: 60 seconds per OAuth 2.0 Security BCP
  private CLEANUP_INTERVAL_MS: number; // Default: 30 seconds
  private MAX_CODES_PER_USER: number; // DDoS protection

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.actorCtx = new CloudflareActorContext(ctx);

    // Create config manager for KV > env > default priority
    this.configManager = createOAuthConfigManager(env);

    // Set initial values from environment (will be updated in initializeState with KV values)
    // Default: 60 seconds per OAuth 2.0 Security BCP, but can be increased for load testing
    const codeTtlEnv = env.AUTH_CODE_EXPIRY;
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

    // Block all requests until initialization completes
    // This ensures the DO is in a consistent state before processing any requests
    // Critical for one-time code consumption guarantee
    this.actorCtx.blockConcurrencyWhile(async () => {
      await this.initializeStateBlocking();
    });
  }

  /**
   * Initialize state from Durable Storage and load configuration from KV
   * Called by blockConcurrencyWhile() in constructor
   *
   * Configuration Priority: KV > Environment variable > Default value
   */
  private async initializeStateBlocking(): Promise<void> {
    // Load configuration from KV (with env/default fallback)
    try {
      this.CODE_TTL = await this.configManager.getAuthCodeTTL();
      this.MAX_CODES_PER_USER = await this.configManager.getMaxCodesPerUser();
      this.log.info('Loaded config from KV', {
        codeTTL: this.CODE_TTL,
        maxCodesPerUser: this.MAX_CODES_PER_USER,
      });
    } catch (error) {
      this.log.warn('Failed to load config from KV, using env/default values', {}, error as Error);
      // Keep constructor-initialized values (from env)
    }

    try {
      // Load all codes from individual key storage (code:*)
      const storedCodes = await this.actorCtx.storage.list<AuthorizationCode>({
        prefix: CODE_KEY_PREFIX,
      });

      const now = Date.now();
      for (const [key, authCode] of storedCodes) {
        // Extract code from key (remove prefix)
        const code = key.substring(CODE_KEY_PREFIX.length);
        this.codes.set(code, authCode);

        // Rebuild userCodeCounts from restored codes (only count non-expired codes)
        if (authCode.expiresAt > now) {
          this.incrementUserCodeCount(authCode.userId);
        }
      }

      if (this.codes.size > 0) {
        this.log.info('Restored authorization codes from Durable Storage', {
          count: this.codes.size,
        });
      }
    } catch (error) {
      this.log.error('Failed to initialize from Durable Storage', {}, error as Error);
      // Continue with empty state
    }

    this.initialized = true;

    // Start periodic cleanup after initialization
    this.startCleanup();
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

    this.log.info('Config reloaded', {
      codeTTL: { previous: previousTTL, current: this.CODE_TTL },
      maxCodesPerUser: { previous: previousMaxCodes, current: this.MAX_CODES_PER_USER },
    });

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
   * Ensure state is initialized
   * Called by public methods for backward compatibility
   *
   * Note: With blockConcurrencyWhile() in constructor, this is now a no-op guard.
   * The actual initialization happens in initializeStateBlocking() during construction.
   */
  private async initializeState(): Promise<void> {
    // Guard - initialization already completed by blockConcurrencyWhile()
    if (this.initialized) {
      return;
    }

    // This should not happen with blockConcurrencyWhile(), but as a safety fallback:
    this.log.warn('initializeState called but not initialized - this should not happen');
    await this.initializeStateBlocking();
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
        // Decrement user code counter for O(1) DDoS protection
        this.decrementUserCodeCount(authCode.userId);
      }
    }

    // Batch delete from Durable Storage - O(k) where k = expired codes
    if (expiredCodes.length > 0) {
      const deleteKeys = expiredCodes.map((c) => this.buildCodeKey(c));
      await this.actorCtx.storage.deleteMany(deleteKeys);
      this.log.info('Cleaned up expired codes', { count: expiredCodes.length });
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
    base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');

    return base64;
  }

  /**
   * Count codes for a user (DDoS protection) - O(1) operation
   * Uses userCodeCounts Map for constant-time lookup instead of O(n) scan
   */
  private countUserCodes(userId: string): number {
    return this.userCodeCounts.get(userId) || 0;
  }

  /**
   * Increment user code count when storing a new code
   */
  private incrementUserCodeCount(userId: string): void {
    const current = this.userCodeCounts.get(userId) || 0;
    this.userCodeCounts.set(userId, current + 1);
  }

  /**
   * Decrement user code count when a code is deleted or expired
   */
  private decrementUserCodeCount(userId: string): void {
    const current = this.userCodeCounts.get(userId) || 0;
    if (current > 1) {
      this.userCodeCounts.set(userId, current - 1);
    } else {
      // Remove entry when count reaches 0 to prevent memory leak
      this.userCodeCounts.delete(userId);
    }
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
      authorizationDetails: request.authorizationDetails, // RFC 9396 authorization_details
      used: false,
      expiresAt: now + this.CODE_TTL * 1000,
      createdAt: now,
    };

    // Store in memory
    this.codes.set(request.code, authCode);

    // Increment user code counter for O(1) DDoS protection
    this.incrementUserCodeCount(request.userId);

    // Persist to Durable Storage - O(1) individual key
    await this.actorCtx.storage.put(this.buildCodeKey(request.code), authCode);

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
      const fromStorage = await this.actorCtx.storage.get<AuthorizationCode>(
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
      await this.actorCtx.storage.delete(this.buildCodeKey(request.code));
      throw new Error('invalid_grant: Authorization code expired');
    }

    // CRITICAL: Check if already used (replay attack detection)
    if (stored.used) {
      this.log.error('SECURITY: Replay attack detected', {
        code: request.code.substring(0, 8) + '...',
        userId: stored.userId,
      });

      // OAuth 2.0 Security BCP (RFC 6749 Section 4.1.2):
      // "If an authorization code is used more than once, the authorization server
      //  MUST deny the request and SHOULD revoke (when possible) all tokens
      //  previously issued based on that authorization code."
      //
      // Return replayAttack field with token JTIs for the caller to revoke
      // This allows the token endpoint to revoke tokens before returning the error
      if (stored.issuedAccessTokenJti || stored.issuedRefreshTokenJti) {
        this.log.error('SECURITY: Tokens to revoke', {
          accessTokenJti: stored.issuedAccessTokenJti,
          refreshTokenJti: stored.issuedRefreshTokenJti,
        });
      }

      // Return response with replayAttack field containing JTIs to revoke
      // The caller is responsible for revoking these tokens and returning an error
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
        sid: stored.sid,
        authorizationDetails: stored.authorizationDetails,
        replayAttack: {
          accessTokenJti: stored.issuedAccessTokenJti,
          refreshTokenJti: stored.issuedRefreshTokenJti,
        },
      };
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
    await this.actorCtx.storage.put(this.buildCodeKey(request.code), stored);

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
      authorizationDetails: stored.authorizationDetails, // RFC 9396 authorization_details
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
    const authCode = this.codes.get(code);
    if (!authCode) {
      return false;
    }
    this.codes.delete(code);
    // Decrement user code counter for O(1) DDoS protection
    this.decrementUserCodeCount(authCode.userId);
    // Delete from Durable Storage - O(1) individual key
    await this.actorCtx.storage.delete(this.buildCodeKey(code));
    return true;
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
      this.log.warn('Cannot register tokens for unknown code', {
        code: code.substring(0, 8) + '...',
      });
      return false;
    }

    stored.issuedAccessTokenJti = accessTokenJti;
    if (refreshTokenJti) {
      stored.issuedRefreshTokenJti = refreshTokenJti;
    }
    this.codes.set(code, stored);

    // Persist to Durable Storage - O(1) individual key
    await this.actorCtx.storage.put(this.buildCodeKey(code), stored);

    this.log.info('Registered token JTIs for code', { code: code.substring(0, 8) + '...' });
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

          // RFC 6749 Section 4.1.2: If replay attack detected, return error
          // The replayAttack field contains JTIs for caller to revoke tokens
          // HTTP handler returns error; RPC callers handle revocation themselves
          if (result.replayAttack) {
            this.log.warn('Replay attack detected, returning error', {
              accessTokenJti: result.replayAttack.accessTokenJti,
              refreshTokenJti: result.replayAttack.refreshTokenJti,
            });
            return new Response(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'Authorization code has already been used',
                // Note: replayAttack field is included for RPC callers that need to revoke tokens
                // HTTP callers typically don't have access to TokenRevocationStore
                _replayAttack: result.replayAttack,
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          this.log.warn('consumeCode error', {}, error as Error);
          const message = error instanceof Error ? error.message : 'Unknown error';

          // SECURITY: Use generic error descriptions to prevent information leakage
          // Only use structured error messages that don't expose internal details
          let errorDescription = 'Authorization code is invalid or expired';

          // Only expose safe, predefined error messages
          if (message.includes('already consumed') || message.includes('replay')) {
            errorDescription = 'Authorization code has already been used';
          } else if (message.includes('expired')) {
            errorDescription = 'Authorization code has expired';
          } else if (message.includes('PKCE') || message.includes('code_verifier')) {
            errorDescription = 'PKCE verification failed';
          } else if (message.includes('client_id') || message.includes('client mismatch')) {
            errorDescription = 'Invalid client';
          }

          return new Response(
            JSON.stringify({
              error: 'invalid_grant',
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

          this.log.info('Config reloaded via fetch', {
            codeTTL: { previous: previousTTL, current: this.CODE_TTL },
            maxCodesPerUser: { previous: previousMaxCodes, current: this.MAX_CODES_PER_USER },
          });

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
          this.log.error('Failed to reload config', {}, error as Error);
          return new Response(
            JSON.stringify({
              status: 'error',
              // SECURITY: Do not expose internal error details
              message: 'Failed to reload configuration',
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
}
