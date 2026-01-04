/**
 * Logout Webhook Sender Service
 *
 * Handles the generation and sending of simple logout webhook notifications.
 * This is an alternative to OIDC Back-Channel Logout for clients that don't
 * support the full OIDC spec.
 *
 * Features:
 * - Simple JSON payload (no JWT)
 * - HMAC-SHA256 signature for verification
 * - Timestamp header for replay prevention
 * - Retry logic with exponential backoff
 * - Duplicate prevention via KV locks
 * - Failure recording for admin visibility
 *
 * Security:
 * - Webhook secrets are encrypted at rest (AES-256-GCM)
 * - HMAC-SHA256 signature prevents payload tampering
 * - Timestamp allows receivers to reject old requests
 * - SSRF protection on webhook URIs (validated at registration)
 *
 * @packageDocumentation
 */

import type {
  LogoutWebhookConfig,
  LogoutWebhookPayload,
  LogoutWebhookSendResult,
  SessionClientWithWebhook,
  LogoutRetryConfig,
} from '../types/logout';
import { LOGOUT_WEBHOOK_KV_PREFIXES, DEFAULT_LOGOUT_WEBHOOK_CONFIG } from '../types/logout';

// Re-export common webhook utilities from webhook-sender
import {
  generateWebhookSignature as generateSig,
  verifyWebhookSignature as verifySig,
  sendWebhook,
  isRetryableError,
  calculateRetryDelay,
  type WebhookRetryConfig,
} from './webhook-sender';
import { createLogger } from '../utils/logger';

const log = createLogger().module('LOGOUT-WEBHOOK');

/**
 * Parameters for creating a webhook payload
 */
export interface CreateWebhookPayloadParams {
  /** Issuer URL */
  issuer: string;
  /** Client ID */
  clientId: string;
  /** User ID (subject) - optional based on config */
  userId?: string;
  /** Session ID - optional based on config */
  sessionId?: string;
  /** Whether to include sub claim */
  includeSub: boolean;
  /** Whether to include sid claim */
  includeSid: boolean;
}

/**
 * Create a logout webhook payload
 *
 * @param params - Payload creation parameters
 * @returns Webhook payload
 */
export function createWebhookPayload(params: CreateWebhookPayloadParams): LogoutWebhookPayload {
  const payload: LogoutWebhookPayload = {
    event: 'user.logout',
    iat: Math.floor(Date.now() / 1000),
    client_id: params.clientId,
    issuer: params.issuer,
  };

  if (params.includeSub && params.userId) {
    payload.sub = params.userId;
  }

  if (params.includeSid && params.sessionId) {
    payload.sid = params.sessionId;
  }

  return payload;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload
 *
 * Re-exported from webhook-sender for backwards compatibility.
 *
 * @param payload - JSON payload to sign
 * @param secret - Webhook secret (decrypted)
 * @returns Hex-encoded signature
 */
export const generateWebhookSignature = generateSig;

/**
 * Verify HMAC-SHA256 signature (for testing/documentation)
 *
 * Re-exported from webhook-sender for backwards compatibility.
 *
 * @param payload - JSON payload that was signed
 * @param signature - Hex-encoded signature to verify
 * @param secret - Webhook secret
 * @returns Whether the signature is valid
 */
export const verifyWebhookSignature = verifySig;

/**
 * Parameters for sending a webhook
 */
export interface SendWebhookParams {
  /** Webhook URI */
  webhookUri: string;
  /** JSON payload string */
  payload: string;
  /** HMAC-SHA256 signature (hex) */
  signature: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Send a logout webhook notification
 *
 * Uses the common sendWebhook function from webhook-sender.
 *
 * @param params - Send parameters
 * @returns Result of the send attempt
 */
export async function sendLogoutWebhook(
  params: SendWebhookParams
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const result = await sendWebhook({
    url: params.webhookUri,
    payload: params.payload,
    signature: params.signature,
    timeoutMs: params.timeoutMs,
  });

  return {
    success: result.success,
    statusCode: result.statusCode,
    error: result.error,
  };
}

/**
 * Determine if an error is retryable
 *
 * Uses the common isRetryableError function from webhook-sender.
 */
export function isWebhookRetryableError(statusCode?: number, error?: string): boolean {
  // rejected_by_receiver is never retryable (check first)
  if (error?.startsWith('rejected_by_receiver')) {
    return false;
  }

  // 400 is never retryable (receiver rejected)
  if (statusCode === 400) {
    return false;
  }

  // Check via common function for other status codes
  if (isRetryableError(statusCode)) {
    return true;
  }

  // Network/timeout errors (no status code) are retryable
  if (error && !statusCode) {
    return true;
  }

  return false;
}

/**
 * Calculate retry delay with exponential backoff
 *
 * Uses the common calculateRetryDelay function from webhook-sender.
 */
export function calculateWebhookRetryDelay(attempt: number, config: LogoutRetryConfig): number {
  const webhookConfig: WebhookRetryConfig = {
    maxAttempts: config.max_attempts,
    initialDelayMs: config.initial_delay_ms,
    backoffMultiplier: config.backoff_multiplier,
    maxDelayMs: config.max_delay_ms,
  };
  return calculateRetryDelay(attempt, webhookConfig);
}

/**
 * KV helper functions for webhook state management
 */
export const WebhookKVHelpers = {
  /**
   * Generate KV key for pending webhook lock
   */
  getPendingKey(sessionId: string, clientId: string): string {
    return `${LOGOUT_WEBHOOK_KV_PREFIXES.PENDING_LOCK}${sessionId}:${clientId}`;
  },

  /**
   * Generate KV key for failure record
   */
  getFailureKey(clientId: string): string {
    return `${LOGOUT_WEBHOOK_KV_PREFIXES.FAILURE_RECORD}${clientId}`;
  },

  /**
   * Check if webhook is already pending for this session-client
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
    const lock = {
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
   * Record webhook failure
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
      method: 'webhook',
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
    method: string;
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
   * List all clients with webhook failure records
   */
  async listFailures(kv: KVNamespace, limit: number = 100): Promise<string[]> {
    const prefix = LOGOUT_WEBHOOK_KV_PREFIXES.FAILURE_RECORD;
    const list = await kv.list({ prefix, limit });
    return list.keys.map((k) => k.name.replace(prefix, ''));
  },
};

/**
 * Orchestrator for sending logout webhooks to multiple clients
 */
export interface LogoutWebhookOrchestrator {
  /**
   * Send webhook notifications to all clients for a session
   *
   * @param clients - List of clients to notify
   * @param params - Common parameters for all webhooks
   * @param config - Webhook configuration
   * @param decryptSecret - Function to decrypt webhook secrets
   * @returns Results for each client
   */
  sendToAll(
    clients: SessionClientWithWebhook[],
    params: {
      issuer: string;
      userId: string;
      sessionId: string;
    },
    config: LogoutWebhookConfig,
    decryptSecret: (encrypted: string) => Promise<string>
  ): Promise<LogoutWebhookSendResult[]>;
}

/**
 * Create a logout webhook orchestrator
 *
 * @param kv - KV namespace for state management
 */
export function createLogoutWebhookOrchestrator(kv: KVNamespace): LogoutWebhookOrchestrator {
  return {
    async sendToAll(clients, params, config, decryptSecret) {
      const results: LogoutWebhookSendResult[] = [];

      // Process clients in parallel (with reasonable concurrency)
      const MAX_CONCURRENT = 10;
      const batches: SessionClientWithWebhook[][] = [];
      for (let i = 0; i < clients.length; i += MAX_CONCURRENT) {
        batches.push(clients.slice(i, i + MAX_CONCURRENT));
      }

      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(async (client): Promise<LogoutWebhookSendResult> => {
            const startTime = Date.now();

            // Skip if no webhook URI or secret
            if (!client.logout_webhook_uri || !client.logout_webhook_secret_encrypted) {
              return {
                clientId: client.client_id,
                success: true,
                method: 'webhook',
              };
            }

            // Check if already pending (deduplication)
            const isPending = await WebhookKVHelpers.isPending(
              kv,
              params.sessionId,
              client.client_id
            );
            if (isPending) {
              return {
                clientId: client.client_id,
                success: false,
                method: 'webhook',
                error: 'already_pending',
              };
            }

            // Set pending lock BEFORE processing to minimize race window
            // This is "optimistic locking" - we claim the lock first, then process
            // If two requests race, worst case is duplicate sends (receivers should be idempotent)
            await WebhookKVHelpers.setPending(kv, params.sessionId, client.client_id, 0, 60);

            try {
              // Decrypt the webhook secret
              const secret = await decryptSecret(client.logout_webhook_secret_encrypted);

              // Create payload
              const payload = createWebhookPayload({
                issuer: params.issuer,
                clientId: client.client_id,
                userId: config.include_sub_claim ? params.userId : undefined,
                sessionId: config.include_sid_claim ? params.sessionId : undefined,
                includeSub: config.include_sub_claim,
                includeSid: config.include_sid_claim,
              });

              const payloadString = JSON.stringify(payload);

              // Generate signature
              const signature = await generateWebhookSignature(payloadString, secret);

              // Send the webhook
              const sendResult = await sendLogoutWebhook({
                webhookUri: client.logout_webhook_uri,
                payload: payloadString,
                signature,
                timeoutMs: config.request_timeout_ms,
              });

              const duration_ms = Date.now() - startTime;

              if (sendResult.success) {
                // Clear pending lock on success
                await WebhookKVHelpers.clearPending(kv, params.sessionId, client.client_id);
                return {
                  clientId: client.client_id,
                  success: true,
                  method: 'webhook',
                  statusCode: sendResult.statusCode,
                  duration_ms,
                };
              }

              // Handle failure
              const retryable = isWebhookRetryableError(sendResult.statusCode, sendResult.error);

              if (retryable) {
                // Update pending lock for retry (extend TTL, increment attempt)
                await WebhookKVHelpers.setPending(kv, params.sessionId, client.client_id, 1, 300);
              } else {
                // Clear pending lock on non-retryable failure
                await WebhookKVHelpers.clearPending(kv, params.sessionId, client.client_id);
              }

              // Record failure for admin visibility
              await WebhookKVHelpers.recordFailure(kv, client.client_id, {
                statusCode: sendResult.statusCode,
                error: sendResult.error || 'Unknown error',
              });

              return {
                clientId: client.client_id,
                success: false,
                method: 'webhook',
                statusCode: sendResult.statusCode,
                error: sendResult.error,
                retryScheduled: retryable,
                duration_ms,
              };
            } catch (error) {
              const duration_ms = Date.now() - startTime;
              log.error('Client webhook error', { clientId: client.client_id }, error as Error);

              // Clear pending lock on unexpected error (fail-safe)
              await WebhookKVHelpers.clearPending(kv, params.sessionId, client.client_id);

              // Record failure with generic message
              await WebhookKVHelpers.recordFailure(kv, client.client_id, {
                // SECURITY: Do not expose internal error details
                error: 'Webhook delivery failed',
              });

              return {
                clientId: client.client_id,
                success: false,
                method: 'webhook',
                // SECURITY: Do not expose internal error details
                error: 'Webhook delivery failed',
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
 * Get Logout Webhook Configuration
 *
 * Priority: KV → defaults
 *
 * @param env - Environment with KV binding
 * @param settingsKV - KV namespace for settings
 * @returns LogoutWebhookConfig
 */
export async function getLogoutWebhookConfig(
  settingsKV: KVNamespace | undefined
): Promise<LogoutWebhookConfig> {
  if (settingsKV) {
    try {
      const kvConfig = await settingsKV.get('settings:logout_webhook');
      if (kvConfig) {
        const parsed = JSON.parse(kvConfig);
        return {
          ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
          ...parsed,
          retry: {
            ...DEFAULT_LOGOUT_WEBHOOK_CONFIG.retry,
            ...(parsed.retry || {}),
          },
        };
      }
    } catch {
      // Ignore KV errors, use defaults
    }
  }

  return DEFAULT_LOGOUT_WEBHOOK_CONFIG;
}
