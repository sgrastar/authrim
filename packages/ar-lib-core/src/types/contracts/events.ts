/**
 * Contract Event Types
 *
 * Types for contract-related events and webhooks.
 * Enables external system integration and real-time notifications.
 */

import type { FieldChange } from './change-log';

// =============================================================================
// Event Types
// =============================================================================

/**
 * Contract event types.
 */
export type ContractEventType =
  // Contract lifecycle events
  | 'contract.created'
  | 'contract.updated'
  | 'contract.activated'
  | 'contract.deprecated'
  | 'contract.archived'
  | 'contract.rolled_back'
  | 'contract.deleted'
  // Policy events
  | 'policy.resolved'
  | 'policy.validation_failed'
  // Cache events
  | 'cache.invalidated'
  | 'cache.warmed';

// =============================================================================
// Event Structure
// =============================================================================

/**
 * Base contract event.
 */
export interface ContractEvent {
  /** Unique event ID */
  id: string;
  /** Event type */
  type: ContractEventType;
  /** When the event occurred (ISO 8601) */
  timestamp: string;
  /** Tenant ID */
  tenantId: string;
  /** Event data */
  data: ContractEventData;
  /** Event metadata */
  metadata?: ContractEventMetadata;
  /** Event version (for schema evolution) */
  version: string;
}

/**
 * Event data payload.
 */
export interface ContractEventData {
  /** Contract type */
  contractType: 'tenant' | 'client';
  /** Contract ID */
  contractId: string;
  /** Contract version */
  version: number;
  /** Previous version (for updates) */
  previousVersion?: number;
  /** Field changes (for updates) */
  changes?: FieldChange[];
  /** Status change details */
  statusChange?: {
    from: string;
    to: string;
  };
  /** Additional data specific to event type */
  extra?: Record<string, unknown>;
}

/**
 * Event metadata.
 */
export interface ContractEventMetadata {
  /** Actor who triggered the event */
  actor?: {
    type: 'user' | 'service' | 'system';
    id: string;
    email?: string;
  };
  /** Request ID for correlation */
  requestId?: string;
  /** Source of the event */
  source?: string;
  /** Custom tags */
  tags?: string[];
}

// =============================================================================
// Webhook Configuration
// =============================================================================

/**
 * Webhook configuration for contract events.
 */
export interface ContractWebhook {
  /** Webhook ID */
  id: string;
  /** Webhook name (for display) */
  name: string;
  /** Webhook URL */
  url: string;
  /** Event types to subscribe to */
  events: ContractEventType[];
  /** Webhook secret for signature verification */
  secret?: string;
  /** Whether webhook is active */
  active: boolean;
  /** Retry policy */
  retryPolicy: WebhookRetryPolicy;
  /** Custom headers to include */
  headers?: Record<string, string>;
  /** Created timestamp (ISO 8601) */
  createdAt: string;
  /** Last updated timestamp (ISO 8601) */
  updatedAt: string;
  /** Last successful delivery */
  lastSuccessAt?: string;
  /** Last failure */
  lastFailureAt?: string;
}

/**
 * Webhook retry policy.
 */
export interface WebhookRetryPolicy {
  /** Maximum number of retries */
  maxRetries: number;
  /** Initial backoff delay in milliseconds */
  backoffMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Maximum backoff delay in milliseconds */
  maxBackoffMs: number;
}

/**
 * Default webhook retry policy.
 */
export const DEFAULT_WEBHOOK_RETRY_POLICY: WebhookRetryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60000,
};

// =============================================================================
// Webhook Delivery
// =============================================================================

/**
 * Webhook delivery attempt record.
 */
export interface WebhookDelivery {
  /** Delivery ID */
  id: string;
  /** Webhook ID */
  webhookId: string;
  /** Event ID */
  eventId: string;
  /** Event type */
  eventType: ContractEventType;
  /** Delivery status */
  status: WebhookDeliveryStatus;
  /** Attempt number (1-based) */
  attemptNumber: number;
  /** Request timestamp (ISO 8601) */
  requestedAt: string;
  /** Response timestamp (ISO 8601) */
  respondedAt?: string;
  /** HTTP status code */
  statusCode?: number;
  /** Response body (truncated) */
  responseBody?: string;
  /** Error message (if failed) */
  error?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Next retry time (if pending) */
  nextRetryAt?: string;
}

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

// =============================================================================
// Webhook Management
// =============================================================================

/**
 * Request to create a webhook.
 */
export interface CreateWebhookRequest {
  /** Webhook name */
  name: string;
  /** Webhook URL */
  url: string;
  /** Event types to subscribe to */
  events: ContractEventType[];
  /** Custom headers */
  headers?: Record<string, string>;
  /** Custom retry policy */
  retryPolicy?: Partial<WebhookRetryPolicy>;
}

/**
 * Request to update a webhook.
 */
export interface UpdateWebhookRequest {
  /** Webhook name */
  name?: string;
  /** Webhook URL */
  url?: string;
  /** Event types to subscribe to */
  events?: ContractEventType[];
  /** Whether webhook is active */
  active?: boolean;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Custom retry policy */
  retryPolicy?: Partial<WebhookRetryPolicy>;
}

/**
 * Webhook statistics.
 */
export interface WebhookStats {
  /** Webhook ID */
  webhookId: string;
  /** Time period */
  period: {
    start: string;
    end: string;
  };
  /** Total deliveries */
  totalDeliveries: number;
  /** Successful deliveries */
  successCount: number;
  /** Failed deliveries */
  failureCount: number;
  /** Success rate */
  successRate: number;
  /** Average response time (ms) */
  avgResponseTimeMs: number;
  /** Deliveries by event type */
  byEventType: Record<ContractEventType, number>;
}

// =============================================================================
// Event Subscription
// =============================================================================

/**
 * Event subscription for internal consumers.
 */
export interface EventSubscription {
  /** Subscription ID */
  id: string;
  /** Subscriber name */
  subscriber: string;
  /** Event types to receive */
  events: ContractEventType[];
  /** Filter by tenant */
  tenantFilter?: string[];
  /** Filter by contract type */
  contractTypeFilter?: ('tenant' | 'client')[];
  /** Active status */
  active: boolean;
}

/**
 * Event handler function type.
 */
export type EventHandler = (event: ContractEvent) => Promise<void>;

// =============================================================================
// Event Publishing
// =============================================================================

/**
 * Event publishing result.
 */
export interface EventPublishResult {
  /** Event ID */
  eventId: string;
  /** Whether publishing succeeded */
  success: boolean;
  /** Number of webhooks notified */
  webhooksNotified: number;
  /** Number of internal subscribers notified */
  subscribersNotified: number;
  /** Errors (if any) */
  errors?: string[];
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a contract event.
 */
export function createContractEvent(
  type: ContractEventType,
  tenantId: string,
  data: ContractEventData,
  metadata?: ContractEventMetadata
): Omit<ContractEvent, 'id'> {
  return {
    type,
    timestamp: new Date().toISOString(),
    tenantId,
    data,
    metadata,
    version: '1.0',
  };
}

/**
 * Check if an event type is a contract lifecycle event.
 */
export function isLifecycleEvent(type: ContractEventType): boolean {
  return type.startsWith('contract.');
}

/**
 * Check if an event type is a policy event.
 */
export function isPolicyEvent(type: ContractEventType): boolean {
  return type.startsWith('policy.');
}

/**
 * Check if an event type is a cache event.
 */
export function isCacheEvent(type: ContractEventType): boolean {
  return type.startsWith('cache.');
}
