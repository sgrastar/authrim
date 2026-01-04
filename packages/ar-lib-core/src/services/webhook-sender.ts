/**
 * Webhook Sender Service
 *
 * Common utilities for sending webhooks with:
 * - HMAC-SHA256 signature generation and verification
 * - Timing-safe comparison for security
 * - Exponential backoff retry logic
 * - KV-based deduplication and failure tracking
 * - Concurrent send with batching
 *
 * Security features:
 * - HMAC-SHA256 prevents payload tampering
 * - Timing-safe comparison prevents timing attacks
 * - Timestamp header enables replay prevention
 * - Error details are not exposed externally
 *
 * @packageDocumentation
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { createLogger } from '../utils/logger';

const log = createLogger().module('WEBHOOK-SENDER');

// =============================================================================
// Types
// =============================================================================

/**
 * Retry configuration for webhook delivery
 */
export interface WebhookRetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Backoff multiplier (e.g., 2 for doubling) */
  backoffMultiplier: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: WebhookRetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 60000,
};

/**
 * Parameters for sending a webhook
 */
export interface SendWebhookParams {
  /** Webhook URL */
  url: string;
  /** JSON payload string */
  payload: string;
  /** HMAC-SHA256 signature (hex) */
  signature: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Optional webhook ID for tracking */
  webhookId?: string;
  /** Optional custom headers */
  customHeaders?: Record<string, string>;
}

/**
 * Result of a webhook send attempt
 */
export interface WebhookSendResult {
  /** Whether the send was successful */
  success: boolean;
  /** HTTP status code (if available) */
  statusCode?: number;
  /** Error message (if failed) */
  error?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Delivery ID (for tracking) */
  deliveryId?: string;
}

// =============================================================================
// Signature Functions
// =============================================================================

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 *
 * Uses Web Crypto API for secure signature generation.
 *
 * @param payload - JSON payload string to sign
 * @param secret - Webhook secret (decrypted)
 * @returns Hex-encoded signature
 *
 * @example
 * ```typescript
 * const payload = JSON.stringify({ event: 'user.created', userId: '123' });
 * const signature = await generateWebhookSignature(payload, 'my-secret');
 * // signature = "a1b2c3d4..."
 * ```
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
 * Verify HMAC-SHA256 signature.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param payload - JSON payload string that was signed
 * @param signature - Hex-encoded signature to verify
 * @param secret - Webhook secret
 * @returns Whether the signature is valid
 *
 * @example
 * ```typescript
 * const isValid = await verifyWebhookSignature(payload, receivedSignature, secret);
 * if (!isValid) {
 *   throw new Error('Invalid webhook signature');
 * }
 * ```
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
 * Timing-safe string comparison.
 *
 * SECURITY: Prevents timing attacks by:
 * - Not returning early on length mismatch
 * - Always comparing all characters
 * - Using XOR comparison for constant-time execution
 *
 * @param a - First string
 * @param b - Second string
 * @returns Whether the strings are equal
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // Track length mismatch without early return
  const lengthMismatch = a.length !== b.length ? 1 : 0;

  // Compare using the longer length to ensure constant-time execution
  const maxLength = Math.max(a.length, b.length);
  let result = lengthMismatch;

  for (let i = 0; i < maxLength; i++) {
    // Use 0 as fallback for out-of-bounds access
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  return result === 0;
}

// =============================================================================
// Send Functions
// =============================================================================

/**
 * Send a webhook notification.
 *
 * Includes standard Authrim headers:
 * - X-Authrim-Signature-256: HMAC-SHA256 signature (sha256=...)
 * - X-Authrim-Timestamp: Unix timestamp (seconds)
 * - X-Authrim-Delivery: Unique delivery ID
 *
 * @param params - Send parameters
 * @returns Result of the send attempt
 *
 * @example
 * ```typescript
 * const result = await sendWebhook({
 *   url: 'https://example.com/webhook',
 *   payload: JSON.stringify(event),
 *   signature: await generateWebhookSignature(payload, secret),
 *   timeoutMs: 30000,
 * });
 * ```
 */
export async function sendWebhook(params: SendWebhookParams): Promise<WebhookSendResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const deliveryId = crypto.randomUUID();

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Authrim-Signature-256': `sha256=${params.signature}`,
      'X-Authrim-Timestamp': timestamp.toString(),
      'X-Authrim-Delivery': deliveryId,
      'Cache-Control': 'no-store',
      'User-Agent': 'Authrim-Webhook/1.0',
      ...params.customHeaders,
    };

    const response = await fetch(params.url, {
      method: 'POST',
      headers,
      body: params.payload,
      signal: AbortSignal.timeout(params.timeoutMs),
    });

    // 200-299 = success
    if (response.ok) {
      return {
        success: true,
        statusCode: response.status,
        deliveryId,
      };
    }

    // 400 Bad Request = receiver rejected (do not retry)
    if (response.status === 400) {
      const errorBody = await response.text().catch(() => '');
      return {
        success: false,
        statusCode: response.status,
        error: `rejected_by_receiver: ${errorBody.slice(0, 200)}`,
        retryable: false,
        deliveryId,
      };
    }

    // Other errors may be transient
    const retryable = isRetryableError(response.status);
    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}`,
      retryable,
      deliveryId,
    };
  } catch (error) {
    // SECURITY: Do not expose network error details
    log.error('Request error', { url: params.url }, error as Error);
    return {
      success: false,
      error: 'Request failed',
      retryable: true, // Network errors are usually transient
      deliveryId,
    };
  }
}

// =============================================================================
// Retry Logic
// =============================================================================

/**
 * Determine if an HTTP status code indicates a retryable error.
 *
 * @param statusCode - HTTP status code
 * @returns Whether the error is retryable
 */
export function isRetryableError(statusCode?: number): boolean {
  if (!statusCode) {
    return true; // Network errors are retryable
  }

  // 400 is never retryable (receiver rejected)
  if (statusCode === 400) {
    return false;
  }

  // 5xx errors are retryable
  if (statusCode >= 500) {
    return true;
  }

  // 429 Too Many Requests is retryable
  if (statusCode === 429) {
    return true;
  }

  return false;
}

/**
 * Calculate retry delay with exponential backoff.
 *
 * delay = initialDelay * (multiplier ^ attempt)
 * capped at maxDelay
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 *
 * @example
 * ```typescript
 * // With default config (initial=1000, multiplier=2, max=60000):
 * calculateRetryDelay(0, config); // 1000ms
 * calculateRetryDelay(1, config); // 2000ms
 * calculateRetryDelay(2, config); // 4000ms
 * calculateRetryDelay(10, config); // 60000ms (capped)
 * ```
 */
export function calculateRetryDelay(attempt: number, config: WebhookRetryConfig): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(delay, config.maxDelayMs);
}

// =============================================================================
// KV Helpers
// =============================================================================

/**
 * Generic KV helper functions for webhook state management.
 *
 * Provides:
 * - Pending locks for deduplication
 * - Failure recording for admin visibility
 */
export const GenericWebhookKVHelpers = {
  /**
   * Generate KV key for pending webhook lock.
   *
   * @param prefix - KV prefix for this webhook type
   * @param identifier - Unique identifier for the webhook
   */
  getPendingKey(prefix: string, identifier: string): string {
    return `${prefix}pending:${identifier}`;
  },

  /**
   * Generate KV key for failure record.
   *
   * @param prefix - KV prefix for this webhook type
   * @param identifier - Unique identifier for the webhook
   */
  getFailureKey(prefix: string, identifier: string): string {
    return `${prefix}failures:${identifier}`;
  },

  /**
   * Check if a webhook is already pending.
   *
   * @param kv - KV namespace
   * @param prefix - KV prefix
   * @param identifier - Unique identifier
   * @returns Whether the webhook is pending
   */
  async isPending(kv: KVNamespace, prefix: string, identifier: string): Promise<boolean> {
    const key = this.getPendingKey(prefix, identifier);
    const value = await kv.get(key);
    return value !== null;
  },

  /**
   * Set pending lock.
   *
   * @param kv - KV namespace
   * @param prefix - KV prefix
   * @param identifier - Unique identifier
   * @param attempt - Current attempt number
   * @param ttlSeconds - Lock TTL in seconds
   */
  async setPending(
    kv: KVNamespace,
    prefix: string,
    identifier: string,
    attempt: number,
    ttlSeconds: number = 300
  ): Promise<void> {
    const key = this.getPendingKey(prefix, identifier);
    const lock = {
      attempt,
      enqueuedAt: Date.now(),
    };
    await kv.put(key, JSON.stringify(lock), { expirationTtl: ttlSeconds });
  },

  /**
   * Clear pending lock.
   *
   * @param kv - KV namespace
   * @param prefix - KV prefix
   * @param identifier - Unique identifier
   */
  async clearPending(kv: KVNamespace, prefix: string, identifier: string): Promise<void> {
    const key = this.getPendingKey(prefix, identifier);
    await kv.delete(key);
  },

  /**
   * Record webhook failure.
   *
   * @param kv - KV namespace
   * @param prefix - KV prefix
   * @param identifier - Unique identifier
   * @param failure - Failure details
   * @param ttlSeconds - Record TTL in seconds
   */
  async recordFailure(
    kv: KVNamespace,
    prefix: string,
    identifier: string,
    failure: {
      statusCode?: number;
      error: string;
      webhookId?: string;
    },
    ttlSeconds: number = 7 * 24 * 60 * 60 // 7 days
  ): Promise<void> {
    const key = this.getFailureKey(prefix, identifier);
    const record = {
      ...failure,
      timestamp: Date.now(),
    };
    await kv.put(key, JSON.stringify(record), { expirationTtl: ttlSeconds });
  },

  /**
   * Get failure record.
   *
   * @param kv - KV namespace
   * @param prefix - KV prefix
   * @param identifier - Unique identifier
   * @returns Failure record or null
   */
  async getFailure(
    kv: KVNamespace,
    prefix: string,
    identifier: string
  ): Promise<{
    timestamp: number;
    statusCode?: number;
    error: string;
    webhookId?: string;
  } | null> {
    const key = this.getFailureKey(prefix, identifier);
    const value = await kv.get(key);
    if (!value) {
      return null;
    }
    return JSON.parse(value);
  },

  /**
   * Clear failure record.
   *
   * @param kv - KV namespace
   * @param prefix - KV prefix
   * @param identifier - Unique identifier
   */
  async clearFailure(kv: KVNamespace, prefix: string, identifier: string): Promise<void> {
    const key = this.getFailureKey(prefix, identifier);
    await kv.delete(key);
  },

  /**
   * List all identifiers with failure records.
   *
   * @param kv - KV namespace
   * @param prefix - KV prefix
   * @param limit - Maximum number of results
   * @returns List of identifiers
   */
  async listFailures(kv: KVNamespace, prefix: string, limit: number = 100): Promise<string[]> {
    const failurePrefix = `${prefix}failures:`;
    const list = await kv.list({ prefix: failurePrefix, limit });
    return list.keys.map((k) => k.name.replace(failurePrefix, ''));
  },
};

// =============================================================================
// Batch Sender
// =============================================================================

/**
 * Configuration for a webhook to send
 */
export interface WebhookToSend {
  /** Webhook URL */
  url: string;
  /** Webhook secret (decrypted) */
  secret: string;
  /** Payload data to send */
  payload: Record<string, unknown>;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Optional webhook ID for tracking */
  webhookId?: string;
  /** Optional custom headers */
  customHeaders?: Record<string, string>;
}

/**
 * Result of batch webhook sending
 */
export interface BatchWebhookResult {
  /** Webhook ID or URL */
  identifier: string;
  /** Send result */
  result: WebhookSendResult;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Send webhooks to multiple endpoints with concurrency control.
 *
 * Processes webhooks in batches to avoid overwhelming the system.
 *
 * @param webhooks - List of webhooks to send
 * @param maxConcurrent - Maximum concurrent requests (default: 10)
 * @returns Results for each webhook
 *
 * @example
 * ```typescript
 * const results = await sendWebhookBatch([
 *   { url: 'https://a.com/webhook', secret: 'secret-a', payload: event },
 *   { url: 'https://b.com/webhook', secret: 'secret-b', payload: event },
 * ]);
 * ```
 */
export async function sendWebhookBatch(
  webhooks: WebhookToSend[],
  maxConcurrent: number = 10
): Promise<BatchWebhookResult[]> {
  const results: BatchWebhookResult[] = [];

  // Process in batches
  for (let i = 0; i < webhooks.length; i += maxConcurrent) {
    const batch = webhooks.slice(i, i + maxConcurrent);

    const batchResults = await Promise.all(
      batch.map(async (webhook): Promise<BatchWebhookResult> => {
        const startTime = Date.now();
        const identifier = webhook.webhookId ?? webhook.url;

        try {
          const payloadString = JSON.stringify(webhook.payload);
          const signature = await generateWebhookSignature(payloadString, webhook.secret);

          const result = await sendWebhook({
            url: webhook.url,
            payload: payloadString,
            signature,
            timeoutMs: webhook.timeoutMs ?? 30000,
            webhookId: webhook.webhookId,
            customHeaders: webhook.customHeaders,
          });

          return {
            identifier,
            result,
            durationMs: Date.now() - startTime,
          };
        } catch (error) {
          log.error('Batch send error', { identifier }, error as Error);
          return {
            identifier,
            result: {
              success: false,
              error: 'Internal error',
              retryable: false,
            },
            durationMs: Date.now() - startTime,
          };
        }
      })
    );

    results.push(...batchResults);
  }

  return results;
}
