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
import { readResponseTextPreview, safeFetch } from '../utils/url-security';

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
 * A response body preview (up to `maxBytes`), or '' when it does not arrive within `timeoutMs`;
 * the body is cancelled either way, so a stalled one does not keep its connection open.
 */
async function readPreviewWithin(
  response: Response,
  maxBytes: number,
  timeoutMs: number
): Promise<string> {
  if (!response.body) {
    return readResponseTextPreview(response, maxBytes).catch(() => '');
  }
  const reader = response.body.getReader();
  const deadline = Date.now() + timeoutMs;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      });
      const result = await Promise.race([reader.read(), timedOut]).finally(() =>
        clearTimeout(timer)
      );
      if (result === null) return '';
      if (result.done) break;
      if (!result.value) continue;
      const chunk = result.value.subarray(0, maxBytes - total);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  } finally {
    reader.cancel().catch(() => {});
  }
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
    const response = await safeFetch(params.backchannelLogoutUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-store',
      },
      body: `logout_token=${encodeURIComponent(params.logoutToken)}`,
      requireHttps: true,
      timeoutMs: params.timeoutMs,
      maxResponseSize: 64 * 1024,
    });

    const duration_ms = Date.now() - startTime;

    // 200 OK or 204 No Content = success
    if (response.status === 200 || response.status === 204) {
      return { success: true, statusCode: response.status };
    }

    // 400 Bad Request = RP rejected the token (do not retry)
    if (response.status === 400) {
      // The body is only a hint for admins: read it within what is left of the request timeout
      // (at most a second), so a body that never ends cannot hold the send past its timeout.
      const errorBody = await readPreviewWithin(
        response,
        1024,
        Math.min(1000, Math.max(0, params.timeoutMs - (Date.now() - startTime)))
      );
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

  /**
   * Wait for the retries sendToAll started (results it gave with `retryScheduled`), and for the
   * records and alerts of final failures, and give the retries' final outcome. Call it once all
   * sends are made, within the same background work.
   */
  settle(): Promise<LogoutSendResult[]>;
}

type RetryScheduler = (
  clientId: string,
  sessionId: string,
  attempt: number,
  issuer: string
) => Promise<void>;

/** How the orchestrator retries within the request that started the logout. */
export interface BackchannelRetryOptions {
  /**
   * The time by which retries must have ended, from when the orchestrator is created: shared by
   * every client and session it sends to (default 25 s, so they end within the time the platform
   * keeps work running after the response). A retry starts only if its wait and its request
   * timeout fit; first attempts are always made.
   */
  retryBudgetMs?: number;
  /**
   * When the work sending these notifications began (default: when the orchestrator is created):
   * the retry budget counts from it, so that preparing the sends (keys, settings) uses it too.
   */
  startedAt?: number;
  /** Called when a client still fails after its retries and `on_final_failure` is 'alert'. */
  onAlert?: (details: {
    clientId: string;
    sessionId: string;
    userId: string;
    attempts: number;
    error: string;
  }) => Promise<void>;
  /** Waits between attempts (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The longest wait for one store operation (pending lock, failure record) or the alert: one
   * that has not finished by then is no longer waited for, so a stalled store cannot hold back
   * the notifications (default 3 s).
   */
  storeTimeoutMs?: number;
}

const DEFAULT_RETRY_BUDGET_MS = 25_000;
const DEFAULT_STORE_TIMEOUT_MS = 3_000;

/**
 * Wait for an operation at most `ms`: its result, or `fallback` when it fails or has not finished
 * in time (it may still finish later; nothing waits for it).
 */
async function bounded<T>(
  operation: Promise<T>,
  ms: number,
  fallback: T,
  what: string,
  clientId: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`Backchannel logout: ${what} did not finish in time`, { clientId });
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([
      operation.catch((error: unknown) => {
        log.warn(`Backchannel logout: ${what} failed`, {
          clientId,
          error: error instanceof Error ? error.message : 'unknown',
        });
        return fallback;
      }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LogoutParams = {
  issuer: string;
  userId: string;
  sessionId: string;
  privateKey: CryptoKey;
  kid: string;
};

/** Sign a new logout token for a client and send it. */
async function sendOnce(
  client: SessionClientWithDetails,
  params: LogoutParams,
  config: BackchannelLogoutConfig
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const logoutToken = await createLogoutToken(
    {
      issuer: params.issuer,
      clientId: client.client_id,
      userId: config.include_sub_claim ? params.userId : undefined,
      sessionId:
        config.include_sid_claim || client.backchannel_logout_session_required
          ? client.oidc_sid
          : undefined,
      expirationSeconds: config.logout_token_exp_seconds,
      includeSub: config.include_sub_claim,
      includeSid: config.include_sid_claim || client.backchannel_logout_session_required,
    },
    params.privateKey,
    params.kid
  );
  return sendLogoutToken({
    logoutToken,
    backchannelLogoutUri: client.backchannel_logout_uri!,
    timeoutMs: config.request_timeout_ms,
  });
}

/** A client's final failure, as sendToAll and settle() report it. */
function failureResult(
  client: SessionClientWithDetails,
  sendResult: { statusCode?: number; error?: string },
  startTime: number
): LogoutSendResult {
  return {
    clientId: client.client_id,
    success: false,
    method: 'backchannel',
    statusCode: sendResult.statusCode,
    error: sendResult.error,
    retryScheduled: false,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Record a client's final failure for the admin list, and raise an alert when `on_final_failure`
 * is 'alert': started together, each waited for at most the store timeout, and never throwing
 * (a stalled or failing store must hold back neither the alert nor other notifications).
 */
async function recordFinalFailure(
  kv: KVNamespace,
  client: SessionClientWithDetails,
  params: LogoutParams,
  config: BackchannelLogoutConfig,
  sendResult: { statusCode?: number; error?: string },
  attempts: number,
  options: BackchannelRetryOptions
): Promise<void> {
  const ms = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  const record = bounded(
    LogoutKVHelpers.recordFailure(kv, client.client_id, {
      statusCode: sendResult.statusCode,
      error: sendResult.error || 'Unknown error',
    }),
    ms,
    undefined,
    'failure record',
    client.client_id
  );
  let alert: Promise<void> = Promise.resolve();
  if (config.on_final_failure === 'alert') {
    log.error('Backchannel logout final failure', {
      clientId: client.client_id,
      sessionId: params.sessionId,
      attempts,
      alert: true,
    });
    if (options.onAlert) {
      alert = bounded(
        Promise.resolve().then(() =>
          options.onAlert!({
            clientId: client.client_id,
            sessionId: params.sessionId,
            userId: params.userId,
            attempts,
            error: `Backchannel logout failed after ${attempts} attempts`,
          })
        ),
        ms,
        undefined,
        'failure alert',
        client.client_id
      );
    }
  }
  await Promise.all([record, alert]);
}

/**
 * Whether a retry after `delay` ms can end by the deadline: its wait, its whole request timeout,
 * and the clean-up after it (the store operations and alert, run together, each waited for at
 * most `storeTimeoutMs`).
 */
function retryFits(
  delay: number,
  config: BackchannelLogoutConfig,
  deadline: number,
  storeTimeoutMs: number
): boolean {
  return Date.now() + delay + config.request_timeout_ms + storeTimeoutMs <= deadline;
}

/**
 * Retry a client whose first attempt failed with a retryable error (any but a 400 rejection),
 * with exponential backoff (`config.retry`) up to `max_attempts` retries, each only if it and the
 * clean-up after it can end before the deadline (checked again right before sending). Each
 * attempt carries a new logout token. Afterwards, together: the pending lock set before is
 * released, and a failure is recorded and alerted (or a past one cleared on success).
 */
async function retryClient(
  kv: KVNamespace,
  client: SessionClientWithDetails,
  params: LogoutParams,
  config: BackchannelLogoutConfig,
  firstFailure: { statusCode?: number; error?: string },
  startTime: number,
  deadline: number,
  options: BackchannelRetryOptions
): Promise<LogoutSendResult> {
  const sleep = options.sleep ?? defaultSleep;
  const storeTimeoutMs = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  const maxRetries = Math.max(0, Math.floor(config.retry.max_attempts));
  let last: { success?: boolean; statusCode?: number; error?: string } = firstFailure;
  let attempts = 1;
  try {
    for (let retry = 0; retry < maxRetries; retry++) {
      const delay = calculateRetryDelay(retry, config.retry);
      if (!retryFits(delay, config, deadline, storeTimeoutMs)) break;
      await sleep(delay);
      // The wait may have run late: send only if the request and clean-up still fit.
      if (!retryFits(0, config, deadline, storeTimeoutMs)) break;
      last = await sendOnce(client, params, config);
      attempts++;
      if (last.success || !isRetryableError(last.statusCode, last.error)) break;
    }
  } catch (error) {
    log.error('Client logout retry error', { clientId: client.client_id }, error as Error);
    // SECURITY: Do not expose internal error details
    last = { error: 'Logout delivery failed' };
  }

  // The clean-up waits no longer than the deadline leaves (what it has not finished by then may
  // still finish; nothing waits for it).
  const cleanupMs = Math.min(storeTimeoutMs, Math.max(0, deadline - Date.now()));
  const release = bounded(
    LogoutKVHelpers.clearPending(kv, params.sessionId, client.client_id),
    cleanupMs,
    undefined,
    'pending lock release',
    client.client_id
  );
  if (last.success) {
    // As a queued retry does: the client no longer has a failure to show. A store that cannot
    // be written does not turn the delivery into a failure.
    await Promise.all([
      release,
      bounded(
        LogoutKVHelpers.clearFailure(kv, client.client_id),
        cleanupMs,
        undefined,
        'failure clean-up',
        client.client_id
      ),
    ]);
    return {
      clientId: client.client_id,
      success: true,
      method: 'backchannel',
      statusCode: last.statusCode,
      duration_ms: Date.now() - startTime,
    };
  }
  await Promise.all([
    release,
    recordFinalFailure(kv, client, params, config, last, attempts, {
      ...options,
      storeTimeoutMs: cleanupMs,
    }),
  ]);
  return failureResult(client, last, startTime);
}

/**
 * Create a backchannel logout orchestrator
 *
 * sendToAll makes the first attempt for every client. A retryable failure is handed to the
 * external scheduler (`onRetryNeeded`) when there is one; otherwise it is retried in the
 * background of this orchestrator (so retries never hold back first attempts to other clients or
 * sessions), and settle() waits for those retries and gives their outcome.
 *
 * @param kv - KV namespace for state management
 * @param onRetryNeeded - Callback when a retry is needed (e.g., to enqueue)
 */
export function createBackchannelLogoutOrchestrator(
  kv: KVNamespace,
  onRetryNeeded?: RetryScheduler,
  options: BackchannelRetryOptions = {}
): BackchannelLogoutOrchestrator {
  // One retry budget for everything this orchestrator sends (one logout).
  const deadline =
    (options.startedAt ?? Date.now()) + (options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS);
  const retries: Promise<LogoutSendResult>[] = [];
  /** Final failure records and alerts, kept off the first sends; settle() waits for them. */
  const effects: Promise<void>[] = [];
  const storeTimeoutMs = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  /** How long a store operation may be waited for now: never past the deadline. */
  const storeWaitMs = () => Math.min(storeTimeoutMs, Math.max(0, deadline - Date.now()));

  /** A final failure: its record and alert run behind the sends; the result is given now. */
  function finalFailure(
    client: SessionClientWithDetails,
    params: LogoutParams,
    config: BackchannelLogoutConfig,
    sendResult: { statusCode?: number; error?: string },
    startTime: number
  ): LogoutSendResult {
    effects.push(
      recordFinalFailure(kv, client, params, config, sendResult, 1, {
        ...options,
        storeTimeoutMs: storeWaitMs(),
      })
    );
    return failureResult(client, sendResult, startTime);
  }

  async function sendFirst(
    client: SessionClientWithDetails,
    params: LogoutParams,
    config: BackchannelLogoutConfig
  ): Promise<LogoutSendResult> {
    const startTime = Date.now();
    try {
      const sendResult = await sendOnce(client, params, config);
      if (sendResult.success) {
        return {
          clientId: client.client_id,
          success: true,
          method: 'backchannel',
          statusCode: sendResult.statusCode,
          duration_ms: Date.now() - startTime,
        };
      }
      const retryable = isRetryableError(sendResult.statusCode, sendResult.error);
      if (retryable && onRetryNeeded) {
        // Set pending lock and schedule retry
        await bounded(
          LogoutKVHelpers.setPending(kv, params.sessionId, client.client_id, 1),
          storeWaitMs(),
          undefined,
          'pending lock',
          client.client_id
        );
        await onRetryNeeded(client.client_id, params.sessionId, 1, params.issuer);
        return {
          clientId: client.client_id,
          success: false,
          method: 'backchannel',
          statusCode: sendResult.statusCode,
          error: sendResult.error,
          retryScheduled: true,
          duration_ms: Date.now() - startTime,
        };
      }
      const firstDelay = calculateRetryDelay(0, config.retry);
      // Retrying first writes the pending lock (waited for at most storeTimeoutMs): it is part
      // of the time the retry needs.
      if (
        retryable &&
        config.retry.max_attempts >= 1 &&
        retryFits(firstDelay + storeTimeoutMs, config, deadline, storeTimeoutMs)
      ) {
        // Another logout of this session must not send to this client meanwhile. A lock that
        // cannot be written does not stop the retry (a repeated notification is harmless).
        await bounded(
          LogoutKVHelpers.setPending(
            kv,
            params.sessionId,
            client.client_id,
            1,
            Math.max(60, Math.ceil((deadline - Date.now()) / 1000) + 60)
          ),
          storeWaitMs(),
          undefined,
          'pending lock',
          client.client_id
        );
        retries.push(
          retryClient(kv, client, params, config, sendResult, startTime, deadline, options)
        );
        return {
          clientId: client.client_id,
          success: false,
          method: 'backchannel',
          statusCode: sendResult.statusCode,
          error: sendResult.error,
          retryScheduled: true,
          duration_ms: Date.now() - startTime,
        };
      }
      return finalFailure(client, params, config, sendResult, startTime);
    } catch (error) {
      log.error('Client logout error', { clientId: client.client_id }, error as Error);
      // SECURITY: Do not expose internal error details
      return finalFailure(client, params, config, { error: 'Logout delivery failed' }, startTime);
    }
  }

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
            // Skip if no backchannel URI
            if (!client.backchannel_logout_uri) {
              return {
                clientId: client.client_id,
                success: true,
                method: 'backchannel',
              };
            }

            // Check if already pending. A lock that cannot be read does not stop the send (a
            // repeated notification is harmless; a missing one leaves the client signed in),
            // nor the other clients.
            const isPending = await bounded(
              LogoutKVHelpers.isPending(kv, params.sessionId, client.client_id),
              storeWaitMs(),
              false,
              'pending lock check',
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

            return sendFirst(client, params, config);
          })
        );

        results.push(...batchResults);
      }

      return results;
    },

    async settle() {
      const settled: LogoutSendResult[] = [];
      // Retries and failure records started while waiting are waited for too.
      while (retries.length > 0 || effects.length > 0) {
        settled.push(...(await Promise.all(retries.splice(0))));
        await Promise.all(effects.splice(0));
      }
      return settled;
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
  /**
   * Optional callback for alerting when max retries are exceeded.
   * Use this to integrate with external alerting systems (e.g., Slack, PagerDuty, email).
   *
   * @example
   * ```typescript
   * onAlert: async (details) => {
   *   await sendToSlack(`Backchannel logout failed for client ${details.clientId}`);
   * }
   * ```
   */
  onAlert?: (details: {
    clientId: string;
    sessionId: string;
    userId: string;
    attempts: number;
    error: string;
  }) => Promise<void>;
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
      // Log error for observability
      log.error('Backchannel logout final failure', {
        clientId: params.clientId,
        sessionId: params.sessionId,
        userId: params.userId,
        attempts: params.attempt,
      });

      // Call external alerting callback if provided
      if (params.onAlert) {
        try {
          await params.onAlert({
            clientId: params.clientId,
            sessionId: params.sessionId,
            userId: params.userId,
            attempts: params.attempt,
            error: `Backchannel logout failed after ${params.attempt} attempts`,
          });
        } catch (alertError) {
          log.warn('Failed to send backchannel logout alert', {
            error: alertError instanceof Error ? alertError.message : String(alertError),
          });
        }
      }
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
