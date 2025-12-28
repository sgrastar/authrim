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
 * @param payload - JSON payload to sign
 * @param secret - Webhook secret (decrypted)
 * @returns Base64-encoded signature
 */
export async function generateWebhookSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const data = encoder.encode(payload);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  const signatureArray = new Uint8Array(signature);

  // Convert to hex string
  return Array.from(signatureArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify HMAC-SHA256 signature (for testing/documentation)
 *
 * @param payload - JSON payload that was signed
 * @param signature - Hex-encoded signature to verify
 * @param secret - Webhook secret
 * @returns Whether the signature is valid
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expectedSignature = await generateWebhookSignature(payload, secret);
  return timingSafeEqual(signature, expectedSignature);
}

/**
 * Timing-safe string comparison
 *
 * SECURITY: Avoids early return on length mismatch to prevent timing attacks.
 * Always performs comparison on the longer length to maintain constant time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Track length mismatch without early return
  const lengthMismatch = a.length !== b.length ? 1 : 0;

  // Compare using the longer length to ensure constant-time execution
  const maxLength = Math.max(a.length, b.length);
  let result = lengthMismatch;

  for (let i = 0; i < maxLength; i++) {
    // Use 0 as fallback for out-of-bounds access (safe because we track length mismatch)
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  return result === 0;
}

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
 * @param params - Send parameters
 * @returns Result of the send attempt
 */
export async function sendLogoutWebhook(
  params: SendWebhookParams
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const deliveryId = crypto.randomUUID();

  try {
    const response = await fetch(params.webhookUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Authrim-Signature-256': `sha256=${params.signature}`,
        'X-Authrim-Timestamp': timestamp.toString(),
        'X-Authrim-Delivery': deliveryId,
        'Cache-Control': 'no-store',
        'User-Agent': 'Authrim-Webhook/1.0',
      },
      body: params.payload,
      signal: AbortSignal.timeout(params.timeoutMs),
    });

    // 200-299 = success
    if (response.ok) {
      return { success: true, statusCode: response.status };
    }

    // 400 Bad Request = receiver rejected the webhook (do not retry)
    if (response.status === 400) {
      const errorBody = await response.text().catch(() => '');
      return {
        success: false,
        statusCode: response.status,
        error: `rejected_by_receiver: ${errorBody.slice(0, 200)}`,
      };
    }

    // Other errors may be transient (can retry)
    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    // SECURITY: Do not expose network error details
    console.error('[sendLogoutWebhook] Request error:', error);
    return {
      success: false,
      error: 'Request failed',
    };
  }
}

/**
 * Determine if an error is retryable
 */
export function isWebhookRetryableError(statusCode?: number, error?: string): boolean {
  // 400 is never retryable (receiver rejected)
  if (statusCode === 400) {
    return false;
  }

  // 5xx errors are retryable
  if (statusCode && statusCode >= 500) {
    return true;
  }

  // Network/timeout errors are retryable
  if (error && !error.startsWith('rejected_by_receiver')) {
    return true;
  }

  return false;
}

/**
 * Calculate retry delay with exponential backoff
 */
export function calculateWebhookRetryDelay(attempt: number, config: LogoutRetryConfig): number {
  const delay = config.initial_delay_ms * Math.pow(config.backoff_multiplier, attempt);
  return Math.min(delay, config.max_delay_ms);
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
              console.error('[LogoutWebhook] Client webhook error:', error);

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
