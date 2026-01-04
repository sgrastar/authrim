/**
 * Backchannel Logout Sender Service
 *
 * Handles the generation and sending of Logout Tokens to RPs
 * for OIDC Back-Channel Logout 1.0.
 *
 * Features:
 * - Logout Token generation (JWT signed with RS256)
 * - HTTP POST to RP's backchannel_logout_uri
 * - Retry logic with exponential backoff
 * - Duplicate prevention via KV locks
 * - Failure recording for admin visibility
 *
 * Design Notes:
 * - Uses waitUntil() for non-blocking sends in the main logout flow
 * - Failed attempts can be queued for later retry
 * - `aud` is always a single string (not array) per design review
 *
 * @packageDocumentation
 */

import { SignJWT } from 'jose';
import type { CryptoKey } from 'jose';
import type {
  LogoutTokenClaims,
  BackchannelLogoutConfig,
  LogoutSendResult,
  LogoutPendingLock,
} from '../types/logout';
import type { SessionClientWithDetails } from '../repositories/core/session-client';
import { createLogger } from '../utils/logger';

const log = createLogger().module('BACKCHANNEL-LOGOUT');

/**
 * Parameters for creating a Logout Token
 */
export interface CreateLogoutTokenParams {
  /** Issuer URL */
  issuer: string;
  /** Client ID (audience) */
  clientId: string;
  /** User ID (subject) - optional based on config */
  userId?: string;
  /** Session ID - optional based on config */
  sessionId?: string;
  /** Token expiration in seconds */
  expirationSeconds: number;
  /** Whether to include sub claim */
  includeSub: boolean;
  /** Whether to include sid claim */
  includeSid: boolean;
}

/**
 * Create a Logout Token JWT
 *
 * Generates a JWT according to OIDC Back-Channel Logout 1.0 Section 2.4.
 *
 * @param params - Token creation parameters
 * @param privateKey - RSA private key for signing
 * @param kid - Key ID
 * @returns Signed JWT string
 */
export async function createLogoutToken(
  params: CreateLogoutTokenParams,
  privateKey: CryptoKey,
  kid: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();

  // Build claims according to spec
  const claims: LogoutTokenClaims = {
    iss: params.issuer,
    aud: params.clientId, // Always single string, not array
    iat: now,
    exp: now + params.expirationSeconds,
    jti,
    events: {
      'http://schemas.openid.net/event/backchannel-logout': {},
    },
  };

  // Add optional claims based on config
  // At least one of sub or sid MUST be present
  if (params.includeSub && params.userId) {
    claims.sub = params.userId;
  }
  if (params.includeSid && params.sessionId) {
    claims.sid = params.sessionId;
  }

  // Validate: at least one of sub or sid must be present
  if (!claims.sub && !claims.sid) {
    throw new Error('Logout token must contain either sub or sid claim');
  }

  // Sign the token (RS256 only, 'none' is not allowed)
  const token = await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .sign(privateKey);

  return token;
}

/**
 * Parameters for sending a backchannel logout
 */
export interface SendBackchannelLogoutParams {
  /** The Logout Token JWT */
  logoutToken: string;
  /** Target RP's backchannel logout URI */
  backchannelLogoutUri: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Send a Logout Token to an RP
 *
 * Makes an HTTP POST request to the RP's backchannel_logout_uri.
 *
 * @param params - Send parameters
 * @returns Result of the send attempt
 */
export async function sendLogoutToken(
  params: SendBackchannelLogoutParams
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const startTime = Date.now();

  try {
    const response = await fetch(params.backchannelLogoutUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-store',
      },
      body: `logout_token=${encodeURIComponent(params.logoutToken)}`,
      signal: AbortSignal.timeout(params.timeoutMs),
    });

    const duration_ms = Date.now() - startTime;

    // 200 OK or 204 No Content = success
    if (response.status === 200 || response.status === 204) {
      return { success: true, statusCode: response.status };
    }

    // 400 Bad Request = RP rejected the token (do not retry)
    if (response.status === 400) {
      const errorBody = await response.text().catch(() => '');
      return {
        success: false,
        statusCode: response.status,
        error: `rejected_by_rp: ${errorBody}`,
      };
    }

    // Other errors may be transient (can retry)
    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    log.error('Request error in sendLogoutToken', {}, error as Error);
    return {
      success: false,
      // SECURITY: Do not expose network error details
      error: 'Request failed',
    };
  }
}

/**
 * Determine if an error is retryable
 *
 * 400 Bad Request means the RP rejected the token - don't retry.
 * Other errors (5xx, network errors) are potentially retryable.
 */
export function isRetryableError(statusCode?: number, error?: string): boolean {
  // 400 is never retryable (RP rejected the token)
  if (statusCode === 400) {
    return false;
  }

  // 5xx errors are retryable
  if (statusCode && statusCode >= 500) {
    return true;
  }

  // Network/timeout errors are retryable
  if (error && !error.startsWith('rejected_by_rp')) {
    return true;
  }

  return false;
}

/**
 * Calculate retry delay with exponential backoff
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  attempt: number,
  config: { initial_delay_ms: number; max_delay_ms: number; backoff_multiplier: number }
): number {
  const delay = config.initial_delay_ms * Math.pow(config.backoff_multiplier, attempt);
  return Math.min(delay, config.max_delay_ms);
}

/**
 * KV helper functions for logout state management
 */
export const LogoutKVHelpers = {
  /**
   * Generate KV key for pending logout lock
   */
  getPendingKey(sessionId: string, clientId: string): string {
    return `logout:pending:${sessionId}:${clientId}`;
  },

  /**
   * Generate KV key for JTI cache (replay prevention)
   */
  getJtiKey(jti: string): string {
    return `bcl_jti:${jti}`;
  },

  /**
   * Generate KV key for failure record
   */
  getFailureKey(clientId: string): string {
    return `logout:failures:${clientId}`;
  },

  /**
   * Check if logout is already pending for this session-client
   */
  async isPending(kv: KVNamespace, sessionId: string, clientId: string): Promise<boolean> {
    const key = this.getPendingKey(sessionId, clientId);
    const value = await kv.get(key);
    return value !== null;
  },

  /**
   * Set pending lock
   */
  async setPending(
    kv: KVNamespace,
    sessionId: string,
    clientId: string,
    attempt: number,
    ttlSeconds: number = 300
  ): Promise<void> {
    const key = this.getPendingKey(sessionId, clientId);
    const lock: LogoutPendingLock = {
      attempt,
      enqueuedAt: Date.now(),
    };
    await kv.put(key, JSON.stringify(lock), { expirationTtl: ttlSeconds });
  },

  /**
   * Clear pending lock
   */
  async clearPending(kv: KVNamespace, sessionId: string, clientId: string): Promise<void> {
    const key = this.getPendingKey(sessionId, clientId);
    await kv.delete(key);
  },

  /**
   * Record logout failure
   */
  async recordFailure(
    kv: KVNamespace,
    clientId: string,
    failure: {
      statusCode?: number;
      error: string;
      errorDetail?: string;
    },
    ttlSeconds: number = 7 * 24 * 60 * 60 // 7 days
  ): Promise<void> {
    const key = this.getFailureKey(clientId);
    const record = {
      ...failure,
      timestamp: Date.now(),
    };
    await kv.put(key, JSON.stringify(record), { expirationTtl: ttlSeconds });
  },

  /**
   * Get failure record for a client
   */
  async getFailure(
    kv: KVNamespace,
    clientId: string
  ): Promise<{
    timestamp: number;
    statusCode?: number;
    error: string;
    errorDetail?: string;
  } | null> {
    const key = this.getFailureKey(clientId);
    const value = await kv.get(key);
    if (!value) {
      return null;
    }
    return JSON.parse(value);
  },

  /**
   * Clear failure record for a client
   */
  async clearFailure(kv: KVNamespace, clientId: string): Promise<void> {
    const key = this.getFailureKey(clientId);
    await kv.delete(key);
  },

  /**
   * List all clients with failure records
   * Note: This requires KV list operation which has limitations
   */
  async listFailures(kv: KVNamespace, limit: number = 100): Promise<string[]> {
    const prefix = 'logout:failures:';
    const list = await kv.list({ prefix, limit });
    return list.keys.map((k) => k.name.replace(prefix, ''));
  },
};

/**
 * Orchestrator for sending backchannel logouts to multiple clients
 */
export interface BackchannelLogoutOrchestrator {
  /**
   * Send logout notifications to all clients for a session
   *
   * @param clients - List of clients to notify
   * @param params - Common parameters for all logouts
   * @param config - Backchannel logout configuration
   * @returns Results for each client
   */
  sendToAll(
    clients: SessionClientWithDetails[],
    params: {
      issuer: string;
      userId: string;
      sessionId: string;
      privateKey: CryptoKey;
      kid: string;
    },
    config: BackchannelLogoutConfig
  ): Promise<LogoutSendResult[]>;
}

/**
 * Create a backchannel logout orchestrator
 *
 * @param kv - KV namespace for state management
 * @param onRetryNeeded - Callback when a retry is needed (e.g., to enqueue)
 */
export function createBackchannelLogoutOrchestrator(
  kv: KVNamespace,
  onRetryNeeded?: (
    clientId: string,
    sessionId: string,
    attempt: number,
    issuer: string
  ) => Promise<void>
): BackchannelLogoutOrchestrator {
  return {
    async sendToAll(clients, params, config) {
      const results: LogoutSendResult[] = [];

      // Process clients in parallel (with reasonable concurrency)
      const MAX_CONCURRENT = 10;
      const batches = [];
      for (let i = 0; i < clients.length; i += MAX_CONCURRENT) {
        batches.push(clients.slice(i, i + MAX_CONCURRENT));
      }

      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(async (client): Promise<LogoutSendResult> => {
            const startTime = Date.now();

            // Skip if no backchannel URI
            if (!client.backchannel_logout_uri) {
              return {
                clientId: client.client_id,
                success: true,
                method: 'backchannel',
              };
            }

            // Check if already pending
            const isPending = await LogoutKVHelpers.isPending(
              kv,
              params.sessionId,
              client.client_id
            );
            if (isPending) {
              return {
                clientId: client.client_id,
                success: false,
                method: 'backchannel',
                error: 'already_pending',
              };
            }

            try {
              // Generate Logout Token
              const logoutToken = await createLogoutToken(
                {
                  issuer: params.issuer,
                  clientId: client.client_id,
                  userId: config.include_sub_claim ? params.userId : undefined,
                  sessionId:
                    config.include_sid_claim || client.backchannel_logout_session_required
                      ? params.sessionId
                      : undefined,
                  expirationSeconds: config.logout_token_exp_seconds,
                  includeSub: config.include_sub_claim,
                  includeSid:
                    config.include_sid_claim || client.backchannel_logout_session_required,
                },
                params.privateKey,
                params.kid
              );

              // Send the token
              const sendResult = await sendLogoutToken({
                logoutToken,
                backchannelLogoutUri: client.backchannel_logout_uri,
                timeoutMs: config.request_timeout_ms,
              });

              const duration_ms = Date.now() - startTime;

              if (sendResult.success) {
                return {
                  clientId: client.client_id,
                  success: true,
                  method: 'backchannel',
                  statusCode: sendResult.statusCode,
                  duration_ms,
                };
              }

              // Handle failure
              const retryable = isRetryableError(sendResult.statusCode, sendResult.error);

              if (retryable && onRetryNeeded) {
                // Set pending lock and schedule retry
                await LogoutKVHelpers.setPending(kv, params.sessionId, client.client_id, 1);
                await onRetryNeeded(client.client_id, params.sessionId, 1, params.issuer);
              } else {
                // Record failure for admin visibility
                await LogoutKVHelpers.recordFailure(kv, client.client_id, {
                  statusCode: sendResult.statusCode,
                  error: sendResult.error || 'Unknown error',
                });
              }

              return {
                clientId: client.client_id,
                success: false,
                method: 'backchannel',
                statusCode: sendResult.statusCode,
                error: sendResult.error,
                retryScheduled: retryable,
                duration_ms,
              };
            } catch (error) {
              const duration_ms = Date.now() - startTime;
              log.error('Client logout error', { clientId: client.client_id }, error as Error);

              // Record failure with generic message
              await LogoutKVHelpers.recordFailure(kv, client.client_id, {
                // SECURITY: Do not expose internal error details
                error: 'Logout delivery failed',
              });

              return {
                clientId: client.client_id,
                success: false,
                method: 'backchannel',
                // SECURITY: Do not expose internal error details
                error: 'Logout delivery failed',
                duration_ms,
              };
            }
          })
        );

        results.push(...batchResults);
      }

      return results;
    },
  };
}

/**
 * Process a retry attempt from the queue
 */
export interface ProcessRetryParams {
  clientId: string;
  sessionId: string;
  userId: string;
  issuer: string;
  attempt: number;
  privateKey: CryptoKey;
  kid: string;
  config: BackchannelLogoutConfig;
  kv: KVNamespace;
  backchannelLogoutUri: string;
  onRetryNeeded?: (
    clientId: string,
    sessionId: string,
    attempt: number,
    issuer: string
  ) => Promise<void>;
}

/**
 * Process a single retry attempt
 */
export async function processRetry(params: ProcessRetryParams): Promise<LogoutSendResult> {
  const startTime = Date.now();

  // Check if max retries exceeded
  if (params.attempt > params.config.retry.max_attempts) {
    // Final failure
    if (params.config.on_final_failure === 'alert') {
      // TODO: Implement alerting mechanism
      log.error('Backchannel logout final failure', {
        clientId: params.clientId,
        attempts: params.attempt,
      });
    }

    // Clear pending lock
    await LogoutKVHelpers.clearPending(params.kv, params.sessionId, params.clientId);

    // Record final failure
    await LogoutKVHelpers.recordFailure(params.kv, params.clientId, {
      error: 'max_retries_exceeded',
      errorDetail: `Failed after ${params.attempt} attempts`,
    });

    return {
      clientId: params.clientId,
      success: false,
      method: 'backchannel',
      error: 'max_retries_exceeded',
    };
  }

  try {
    // Generate new Logout Token for this attempt
    const logoutToken = await createLogoutToken(
      {
        issuer: params.issuer,
        clientId: params.clientId,
        userId: params.config.include_sub_claim ? params.userId : undefined,
        sessionId: params.config.include_sid_claim ? params.sessionId : undefined,
        expirationSeconds: params.config.logout_token_exp_seconds,
        includeSub: params.config.include_sub_claim,
        includeSid: params.config.include_sid_claim,
      },
      params.privateKey,
      params.kid
    );

    // Send the token
    const sendResult = await sendLogoutToken({
      logoutToken,
      backchannelLogoutUri: params.backchannelLogoutUri,
      timeoutMs: params.config.request_timeout_ms,
    });

    const duration_ms = Date.now() - startTime;

    if (sendResult.success) {
      // Success - clear pending lock
      await LogoutKVHelpers.clearPending(params.kv, params.sessionId, params.clientId);
      await LogoutKVHelpers.clearFailure(params.kv, params.clientId);

      return {
        clientId: params.clientId,
        success: true,
        method: 'backchannel',
        statusCode: sendResult.statusCode,
        duration_ms,
      };
    }

    // Handle failure
    const retryable = isRetryableError(sendResult.statusCode, sendResult.error);

    if (retryable && params.onRetryNeeded && params.attempt < params.config.retry.max_attempts) {
      // Schedule next retry
      await LogoutKVHelpers.setPending(
        params.kv,
        params.sessionId,
        params.clientId,
        params.attempt + 1
      );
      await params.onRetryNeeded(
        params.clientId,
        params.sessionId,
        params.attempt + 1,
        params.issuer
      );

      return {
        clientId: params.clientId,
        success: false,
        method: 'backchannel',
        statusCode: sendResult.statusCode,
        error: sendResult.error,
        retryScheduled: true,
        duration_ms,
      };
    }

    // Non-retryable or max retries reached
    await LogoutKVHelpers.clearPending(params.kv, params.sessionId, params.clientId);
    await LogoutKVHelpers.recordFailure(params.kv, params.clientId, {
      statusCode: sendResult.statusCode,
      error: sendResult.error || 'Unknown error',
    });

    return {
      clientId: params.clientId,
      success: false,
      method: 'backchannel',
      statusCode: sendResult.statusCode,
      error: sendResult.error,
      duration_ms,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    log.error(
      'Retry error',
      { clientId: params.clientId, attempt: params.attempt },
      error as Error
    );

    // Record failure with generic message
    await LogoutKVHelpers.recordFailure(params.kv, params.clientId, {
      // SECURITY: Do not expose internal error details
      error: 'Logout retry failed',
    });

    return {
      clientId: params.clientId,
      success: false,
      method: 'backchannel',
      // SECURITY: Do not expose internal error details
      error: 'Logout retry failed',
      duration_ms,
    };
  }
}
