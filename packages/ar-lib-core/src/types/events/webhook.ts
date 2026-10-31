import type { AccountWebhookField } from '../../services/account-webhook-fields';
/**
 * Webhook Types
 *
 * Defines types for webhook configuration, registration, and delivery.
 * Based on the existing logout-webhook-sender.ts patterns.
 *
 * Security considerations:
 * - Secrets are stored encrypted (AES-256-GCM)
 * - HMAC-SHA256 signature for payload verification
 * - Timestamp header for replay prevention
 *
 * @packageDocumentation
 */

// =============================================================================
// Retry Policy
// =============================================================================

/**
 * Webhook retry policy configuration.
 *
 * Uses exponential backoff for failed deliveries.
 */
export interface WebhookRetryPolicy {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Backoff multiplier (delay *= multiplier each retry) */
  backoffMultiplier: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
}

/**
 * Default webhook retry policy.
 */
export const DEFAULT_WEBHOOK_RETRY_POLICY: WebhookRetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 60000,
};

// =============================================================================
// Webhook Configuration
// =============================================================================

/**
 * Webhook configuration for event delivery.
 *
 * SECURITY: The secret is stored encrypted. Use SecretDecryptor
 * to decrypt before signing payloads.
 */
export interface WebhookConfig {
  /** Unique webhook ID */
  id: string;
  /** Tenant ID for multi-tenancy */
  tenantId: string;
  /** Display name for the webhook */
  name: string;
  /** Webhook URL (HTTPS required in production) */
  url: string;
  /**
   * Event types to subscribe to.
   * Supports wildcards: `auth.*`, `*.created`, `*`
   */
  events: string[];
  /** Opt-in event-time account fields; tenant scope only. */
  payloadFields?: AccountWebhookField[];
  /** Account events only: an empty list accepts both registration states. */
  registrationStates?: Array<'guest' | 'registered'>;
  /**
   * HMAC-SHA256 signing secret (encrypted).
   * Use SecretDecryptor to decrypt before signing.
   */
  secretEncrypted?: string;
  /** Custom HTTP headers to include in requests */
  headers?: Record<string, string>;
  /** Retry policy for failed deliveries */
  retryPolicy: WebhookRetryPolicy;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Whether the webhook is active */
  active: boolean;
  /** ISO 8601 timestamp of creation */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
  /** ISO 8601 timestamp of last successful delivery */
  lastSuccessAt?: string;
  /** ISO 8601 timestamp of last failed delivery */
  lastFailureAt?: string;
}

/**
 * Function to decrypt webhook secrets.
 *
 * SECURITY: This function should use the tenant's encryption key
 * to decrypt the AES-256-GCM encrypted secret.
 *
 * @example
 * ```typescript
 * const decryptor: SecretDecryptor = async (encrypted) => {
 *   return await decryptAES(encrypted, encryptionKey);
 * };
 * ```
 */
export type SecretDecryptor = (encryptedSecret: string) => Promise<string>;

// =============================================================================
// Webhook Registry
// =============================================================================

/**
 * Input for creating a new webhook.
 */
export interface CreateWebhookInput {
  /** Display name */
  name: string;
  /** Webhook URL */
  url: string;
  /** Event types to subscribe to */
  events: string[];
  /** Opt-in event-time account fields; tenant scope only. */
  payloadFields?: AccountWebhookField[];
  /** Account events only: an empty list accepts both registration states. */
  registrationStates?: Array<'guest' | 'registered'>;
  /** Plaintext secret (will be encrypted before storage) */
  secret?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Custom retry policy (uses default if not provided) */
  retryPolicy?: Partial<WebhookRetryPolicy>;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * Input for updating an existing webhook.
 */
export interface UpdateWebhookInput {
  /** Display name */
  name?: string;
  /** Webhook URL */
  url?: string;
  /** Event types to subscribe to */
  events?: string[];
  payloadFields?: AccountWebhookField[];
  /** Account events only: an empty list accepts both registration states. */
  registrationStates?: Array<'guest' | 'registered'>;
  /** New secret (will be encrypted before storage) */
  secret?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Custom retry policy */
  retryPolicy?: Partial<WebhookRetryPolicy>;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Whether the webhook is active */
  active?: boolean;
}

/**
 * Webhook registry interface for CRUD operations.
 *
 * All operations are scoped to a tenant for multi-tenancy.
 *
 * @example
 * ```typescript
 * const registry = createWebhookRegistry({ db, kv });
 *
 * // Register a new webhook
 * const id = await registry.register('tenant_default', {
 *   name: 'My Webhook',
 *   url: 'https://example.com/webhook',
 *   events: ['auth.*'],
 *   secret: 'my-secret',
 * });
 *
 * // List webhooks for an event type
 * const webhooks = await registry.findByEventType('tenant_default', 'auth.login.succeeded');
 * ```
 */
export interface WebhookRegistry {
  /**
   * Register a new webhook.
   *
   * @param tenantId - Tenant ID
   * @param input - Webhook configuration
   * @returns Generated webhook ID
   */
  register(tenantId: string, input: CreateWebhookInput): Promise<string>;

  /**
   * Update an existing webhook.
   *
   * @param tenantId - Tenant ID
   * @param id - Webhook ID
   * @param input - Fields to update
   */
  update(tenantId: string, id: string, input: UpdateWebhookInput): Promise<void>;

  /**
   * Remove a webhook.
   *
   * @param tenantId - Tenant ID
   * @param id - Webhook ID
   */
  remove(tenantId: string, id: string): Promise<void>;

  /**
   * Get a webhook by ID.
   *
   * @param tenantId - Tenant ID
   * @param id - Webhook ID
   * @returns Webhook config or null if not found
   */
  get(tenantId: string, id: string): Promise<WebhookConfig | null>;

  /**
   * List all webhooks for a tenant.
   *
   * @param tenantId - Tenant ID
   * @param options - Filter options
   * @returns List of webhook configs
   */
  list(tenantId: string, options?: { activeOnly?: boolean }): Promise<WebhookConfig[]>;

  /**
   * Find webhooks that match an event type.
   *
   * @param tenantId - Tenant ID
   * @param eventType - Event type to match
   * @returns List of matching webhook configs
   */
  findByEventType(tenantId: string, eventType: string): Promise<WebhookConfig[]>;
}

// =============================================================================
// Webhook Delivery
// =============================================================================

/**
 * Webhook delivery status.
 */
export type WebhookDeliveryStatus =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'retrying'
  | 'exhausted';

/**
 * Webhook delivery attempt record.
 */
export interface WebhookDeliveryAttempt {
  /** Delivery ID */
  id: string;
  /** Webhook ID */
  webhookId: string;
  /** Event ID */
  eventId: string;
  /** Event type */
  eventType: string;
  /** Delivery status */
  status: WebhookDeliveryStatus;
  /** Attempt number (1-based) */
  attemptNumber: number;
  /** ISO 8601 timestamp of request */
  requestedAt: string;
  /** ISO 8601 timestamp of response */
  respondedAt?: string;
  /** HTTP status code */
  statusCode?: number;
  /** Response body (truncated) */
  responseBody?: string;
  /** Error message */
  error?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** ISO 8601 timestamp of next retry (if retrying) */
  nextRetryAt?: string;
}

/**
 * Webhook statistics for monitoring.
 */
export interface WebhookStats {
  /** Webhook ID */
  webhookId: string;
  /** Time period */
  period: {
    start: string;
    end: string;
  };
  /** Total delivery attempts */
  totalDeliveries: number;
  /** Successful deliveries */
  successCount: number;
  /** Failed deliveries */
  failureCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average response time in milliseconds */
  avgResponseTimeMs: number;
  /** Deliveries by event type */
  byEventType: Record<string, number>;
}

// =============================================================================
// Webhook Sender Types
// =============================================================================

/**
 * Webhook payload signature header format.
 *
 * Uses HMAC-SHA256 with hex encoding.
 */
export interface WebhookSignature {
  /** Algorithm identifier */
  algorithm: 'sha256';
  /** Hex-encoded HMAC signature */
  signature: string;
  /** Unix timestamp (seconds) */
  timestamp: number;
}

/**
 * Result of a webhook send operation.
 */
export interface WebhookSendResult {
  /** Webhook ID */
  webhookId: string;
  /** Whether the send was successful */
  success: boolean;
  /** HTTP status code */
  statusCode?: number;
  /** Error message */
  error?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Whether the error is retryable */
  retryable?: boolean;
}

/**
 * Interface for sending webhooks.
 */
export interface WebhookSender {
  /**
   * Send a webhook for an event.
   *
   * @param webhook - Webhook configuration
   * @param event - Event to send
   * @param decryptSecret - Function to decrypt the webhook secret
   * @returns Send result
   */
  send(
    webhook: WebhookConfig,
    event: { id: string; type: string; data: unknown },
    decryptSecret: SecretDecryptor
  ): Promise<WebhookSendResult>;

  /**
   * Send webhooks to multiple endpoints.
   *
   * @param webhooks - List of webhook configurations
   * @param event - Event to send
   * @param decryptSecret - Function to decrypt webhook secrets
   * @returns Array of send results
   */
  sendAll(
    webhooks: WebhookConfig[],
    event: { id: string; type: string; data: unknown },
    decryptSecret: SecretDecryptor
  ): Promise<WebhookSendResult[]>;
}
