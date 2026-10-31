import type { WebhookConfigWithScope } from '../../services/webhook-registry';
/**
 * Event Dispatcher Types
 *
 * Defines the core event dispatcher interface for publishing events
 * to webhooks, internal handlers, and audit logs.
 *
 * Based on existing patterns:
 * - logout-webhook-sender.ts (HMAC signature, KV locks, exponential backoff)
 * - permission-change-notifier.ts (multi-channel delivery, Promise.all)
 *
 * @packageDocumentation
 */

import type { EventMetadata, UnifiedEvent } from './unified-event';

// =============================================================================
// Publish Payload
// =============================================================================

/**
 * Payload for publishing an event.
 *
 * This is the input to the dispatcher - the dispatcher will
 * generate the event ID and timestamp automatically.
 *
 * @typeParam T - The event data payload type
 *
 * @example
 * ```typescript
 * const payload: EventPublishPayload<{ userId: string }> = {
 *   type: 'auth.login.succeeded',  // 3-segment format
 *   tenantId: 'tenant_default',
 *   data: { userId: 'user_123' },
 *   metadata: {
 *     actor: { type: 'user', id: 'user_123' },
 *   },
 * };
 * ```
 */
export interface EventPublishPayload<T = Record<string, unknown>> {
  /** Event type in `{domain}.{subject}.{action}` format (past tense) */
  type: string;
  /** Tenant ID for multi-tenancy */
  tenantId: string;
  /** Event-specific data payload */
  data: T;
  /** Optional event metadata */
  metadata?: Partial<EventMetadata>;
}

// =============================================================================
// Publish Options
// =============================================================================

/**
 * Options for event publishing.
 *
 * Controls how the event is processed and delivered.
 */
export interface EventPublishOptions {
  /** Trusted durable account producer only. PII is materialized per authorized destination. */
  accountWebhookData?: (webhook: WebhookConfigWithScope) => Promise<Record<string, unknown>>;

  /** Trusted durable outbox envelope. The outbox owns leasing/retries; bypass KV deduplication. */
  durableEvent?: { id: string; occurredAt: number };

  /**
   * Process synchronously (wait for all handlers).
   * Default: false (async processing)
   */
  sync?: boolean;

  /**
   * Skip webhook delivery.
   * Useful for internal-only events.
   */
  skipWebhooks?: boolean;

  /**
   * Skip audit log recording.
   * Use with caution - some events require audit logging.
   */
  skipAuditLog?: boolean;

  /**
   * Skip internal event handlers.
   * Useful for replay scenarios.
   */
  skipInternalHandlers?: boolean;

  /**
   * Custom deduplication key.
   * If provided, used instead of event ID for idempotency checks.
   */
  deduplicationKey?: string;

  /**
   * Timeout in milliseconds for the entire publish operation.
   * Default: 30000 (30 seconds)
   */
  timeoutMs?: number;

  /**
   * TTL for deduplication key in seconds.
   * Default: 3600 (1 hour)
   */
  deduplicationTtlSeconds?: number;
}

// =============================================================================
// Delivery Results
// =============================================================================

/**
 * Summary of webhook delivery results.
 */
export interface WebhookDeliverySummary {
  /** Number of webhooks successfully delivered */
  sent: number;
  /** Number of webhooks that failed */
  failed: number;
  /** Number of webhooks skipped (inactive, filtered, etc.) */
  skipped: number;
}

/**
 * Summary of internal handler execution results.
 */
export interface HandlerExecutionSummary {
  /** Number of handlers executed successfully */
  executed: number;
  /** Number of handlers that failed */
  failed: number;
  /** Number of handlers skipped */
  skipped: number;
}

/**
 * Delivery summary for all channels.
 */
export interface DeliverySummary {
  /** Webhook delivery results */
  webhooks: WebhookDeliverySummary;
  /** Internal handler execution results */
  handlers: HandlerExecutionSummary;
  /** Whether audit log was recorded */
  auditLog: boolean;
}

/**
 * Delivery target types.
 */
export type DeliveryTarget = 'webhook' | 'handler' | 'auditLog';

/**
 * Error details for failed deliveries.
 */
export interface EventDeliveryError {
  /** Target that failed */
  target: DeliveryTarget;
  /** Name/ID of the target (webhook ID, handler name, etc.) */
  name: string;
  /** Error message */
  error: string;
  /** Whether the error is retryable */
  retryable: boolean;
  /** HTTP status code (for webhooks) */
  statusCode?: number;
}

// =============================================================================
// Publish Result
// =============================================================================

/**
 * Result of publishing an event.
 *
 * Contains the generated event ID, delivery summary, and any errors.
 *
 * @example
 * ```typescript
 * const result = await dispatcher.publish(payload);
 * if (result.success) {
 *   console.log(`Event ${result.eventId} published`);
 *   console.log(`Webhooks: ${result.delivery.webhooks.sent} sent`);
 * } else {
 *   console.error(`Failed:`, result.errors);
 * }
 * ```
 */
export interface EventPublishResult {
  /** Generated event ID */
  eventId: string;
  /** Whether the publish was successful overall */
  success: boolean;
  /** Unix timestamp (milliseconds) when published */
  timestamp: number;
  /** Delivery summary for all channels */
  delivery: DeliverySummary;
  /** Error details (if any) */
  errors?: EventDeliveryError[];
  /** Whether the event was a duplicate (already processed) */
  deduplicated?: boolean;
}

// =============================================================================
// Event Dispatcher Interface
// =============================================================================

/**
 * Event Dispatcher Interface.
 *
 * Main interface for publishing events to the system.
 * Handles routing to webhooks, internal handlers, and audit logs.
 *
 * @example
 * ```typescript
 * const dispatcher = createEventDispatcher(config);
 *
 * // Publish a single event
 * const result = await dispatcher.publish({
 *   type: 'auth.login.succeeded',
 *   tenantId: 'tenant_default',
 *   data: { userId: 'user_123' },
 * });
 *
 * // Publish multiple events
 * const results = await dispatcher.publishBatch([
 *   { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
 *   { type: 'session.user.created', tenantId: 'tenant_default', data: {} },
 * ]);
 * ```
 */
export interface EventDispatcher {
  /**
   * Publish a single event.
   *
   * @typeParam T - The event data payload type
   * @param event - Event payload to publish
   * @param options - Publishing options
   * @returns Publish result with delivery summary
   */
  publish<T = Record<string, unknown>>(
    event: EventPublishPayload<T>,
    options?: EventPublishOptions
  ): Promise<EventPublishResult>;

  /**
   * Publish multiple events in a batch.
   *
   * Events are processed concurrently for performance.
   * Each event gets its own result in the returned array.
   *
   * @typeParam T - The event data payload type
   * @param events - Array of event payloads to publish
   * @param options - Publishing options (applied to all events)
   * @returns Array of publish results (same order as input)
   */
  publishBatch<T = Record<string, unknown>>(
    events: EventPublishPayload<T>[],
    options?: EventPublishOptions
  ): Promise<EventPublishResult[]>;
}

// =============================================================================
// Factory Types
// =============================================================================

/**
 * Configuration for creating an EventDispatcher.
 */
export interface EventDispatcherConfig {
  /** Default tenant ID (can be overridden per event) */
  tenantId?: string;
  /** Default publish options */
  defaults?: Partial<EventPublishOptions>;
}

/**
 * Factory interface for creating EventDispatcher instances.
 */
export interface EventDispatcherFactory {
  /**
   * Create an EventDispatcher instance.
   *
   * @param config - Dispatcher configuration
   * @returns Configured EventDispatcher
   */
  create(config: EventDispatcherConfig): EventDispatcher;
}

// =============================================================================
// Typed Event Helpers
// =============================================================================

/**
 * Helper type for creating strongly-typed event payloads.
 *
 * @typeParam Type - Event type literal
 * @typeParam Data - Event data type
 *
 * @example
 * ```typescript
 * type LoginSucceeded = TypedEventPayload<
 *   'auth.login.succeeded',
 *   { userId: string; method: string }
 * >;
 *
 * const event: LoginSucceeded = {
 *   type: 'auth.login.succeeded',
 *   tenantId: 'default',
 *   data: { userId: 'user_123', method: 'passkey' },
 * };
 * ```
 */
export type TypedEventPayload<Type extends string, Data extends Record<string, unknown>> = {
  type: Type;
  tenantId: string;
  data: Data;
  metadata?: Partial<EventMetadata>;
};

/**
 * Helper type for creating strongly-typed unified events.
 */
export type TypedUnifiedEvent<
  Type extends string,
  Data extends Record<string, unknown>,
> = UnifiedEvent<Data> & { type: Type };
