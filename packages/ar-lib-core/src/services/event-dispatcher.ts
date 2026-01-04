/**
 * Event Dispatcher Service
 *
 * Core event publishing service that integrates:
 * - Before Hooks (validation/denial/annotation)
 * - Internal event handlers
 * - Webhook delivery
 * - After Hooks (side effects)
 * - Audit logging
 *
 * Features:
 * - KV-based deduplication
 * - Multi-channel parallel delivery
 * - Before Hook timeout = deny (security-first)
 * - Graceful error handling (individual failures don't block others)
 *
 * @packageDocumentation
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../db/adapter';
import type {
  EventDispatcher as IEventDispatcher,
  EventPublishPayload,
  EventPublishOptions,
  EventPublishResult,
  DeliverySummary,
  EventDeliveryError,
} from '../types/events/dispatcher';
import type { UnifiedEvent } from '../types/events/unified-event';
import type { SecretDecryptor } from '../types/events/webhook';
import type { EventHandlerContext } from '../types/events/handler';
import type { EventHandlerRegistryImpl } from './event-handler-registry';
import type { EventHookRegistryImpl } from './event-hook-registry';
import type { WebhookRegistryImpl, WebhookConfigWithScope } from './webhook-registry';
import { executeBeforeHooks } from './event-hook-registry';
import { generateWebhookSignature, sendWebhook } from './webhook-sender';
import { createLogger } from '../utils/logger';

const log = createLogger().module('EVENT-DISPATCHER');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for EventDispatcher.
 */
export interface EventDispatcherConfig {
  /** Database adapter for audit logging */
  adapter: DatabaseAdapter;
  /** KV namespace for deduplication */
  kv: KVNamespace;
  /** Webhook registry for finding webhooks */
  webhookRegistry: WebhookRegistryImpl;
  /** Event handler registry for internal handlers */
  handlerRegistry: EventHandlerRegistryImpl;
  /** Event hook registry for before/after hooks */
  hookRegistry: EventHookRegistryImpl;
  /** Function to decrypt webhook secrets */
  decryptSecret: SecretDecryptor;
  /** Options */
  options?: EventDispatcherOptions;
}

/**
 * EventDispatcher options.
 */
export interface EventDispatcherOptions {
  /** Timeout for entire publish operation (ms) */
  publishTimeoutMs?: number;
  /** TTL for deduplication keys (seconds) */
  deduplicationTtlSeconds?: number;
  /** Maximum concurrent webhook sends */
  maxConcurrentWebhooks?: number;
  /** Maximum payload size (bytes) - security */
  maxPayloadSize?: number;
  /** Enable audit logging */
  enableAuditLog?: boolean;
  /** Environment (for logging) */
  environment?: string;
}

/**
 * Execution context passed to handlers and hooks.
 */
interface ExecutionContext extends EventHandlerContext {
  /** Generated event */
  event: UnifiedEvent;
  /** Before Hook annotations */
  annotations: Record<string, unknown>;
}

// =============================================================================
// Constants
// =============================================================================

/** Default publish timeout (30 seconds) */
const DEFAULT_PUBLISH_TIMEOUT_MS = 30000;

/** Default deduplication TTL (1 hour) */
const DEFAULT_DEDUP_TTL_SECONDS = 3600;

/** Default max concurrent webhooks */
const DEFAULT_MAX_CONCURRENT_WEBHOOKS = 10;

/** Default max payload size (256KB) */
const DEFAULT_MAX_PAYLOAD_SIZE = 256 * 1024;

/** KV prefix for deduplication */
const DEDUP_PREFIX = 'event:dedup:';

// =============================================================================
// Event Dispatcher Implementation
// =============================================================================

/**
 * Event Dispatcher implementation.
 *
 * Orchestrates event publishing across multiple channels:
 * 1. Deduplication check
 * 2. Before Hook execution (validation)
 * 3. Parallel delivery to handlers, webhooks
 * 4. Audit log recording
 * 5. After Hook execution
 *
 * @example
 * ```typescript
 * const dispatcher = createEventDispatcher({
 *   adapter,
 *   kv,
 *   webhookRegistry,
 *   handlerRegistry,
 *   hookRegistry,
 *   decryptSecret,
 * });
 *
 * const result = await dispatcher.publish({
 *   type: 'auth.login.succeeded',
 *   tenantId: 'tenant_default',
 *   data: { userId: 'user_123', method: 'passkey' },
 *   metadata: {
 *     actor: { type: 'user', id: 'user_123' },
 *   },
 * });
 * ```
 */
export class EventDispatcherImpl implements IEventDispatcher {
  private readonly adapter: DatabaseAdapter;
  private readonly kv: KVNamespace;
  private readonly webhookRegistry: WebhookRegistryImpl;
  private readonly handlerRegistry: EventHandlerRegistryImpl;
  private readonly hookRegistry: EventHookRegistryImpl;
  private readonly decryptSecret: SecretDecryptor;
  private readonly options: Required<EventDispatcherOptions>;

  constructor(config: EventDispatcherConfig) {
    this.adapter = config.adapter;
    this.kv = config.kv;
    this.webhookRegistry = config.webhookRegistry;
    this.handlerRegistry = config.handlerRegistry;
    this.hookRegistry = config.hookRegistry;
    this.decryptSecret = config.decryptSecret;

    // Apply defaults
    this.options = {
      publishTimeoutMs: config.options?.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
      deduplicationTtlSeconds: config.options?.deduplicationTtlSeconds ?? DEFAULT_DEDUP_TTL_SECONDS,
      maxConcurrentWebhooks:
        config.options?.maxConcurrentWebhooks ?? DEFAULT_MAX_CONCURRENT_WEBHOOKS,
      maxPayloadSize: config.options?.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE,
      enableAuditLog: config.options?.enableAuditLog ?? true,
      environment: config.options?.environment ?? 'production',
    };
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Publish a single event.
   */
  async publish<T = Record<string, unknown>>(
    payload: EventPublishPayload<T>,
    options?: EventPublishOptions
  ): Promise<EventPublishResult> {
    const eventId = `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    const timestamp = Date.now();
    const errors: EventDeliveryError[] = [];

    // Initialize delivery summary
    const delivery: DeliverySummary = {
      webhooks: { sent: 0, failed: 0, skipped: 0 },
      handlers: { executed: 0, failed: 0, skipped: 0 },
      auditLog: false,
    };

    try {
      // 1. Validate payload size (security)
      const payloadSize = JSON.stringify(payload.data).length;
      if (payloadSize > this.options.maxPayloadSize) {
        return {
          eventId,
          success: false,
          timestamp,
          delivery,
          errors: [
            {
              target: 'handler',
              name: 'validation',
              error: `Payload too large: ${payloadSize} bytes (max ${this.options.maxPayloadSize})`,
              retryable: false,
            },
          ],
        };
      }

      // 2. Deduplication check
      const dedupKey = this.getDedupKey(payload.tenantId, options?.deduplicationKey ?? eventId);

      const isDuplicate = await this.checkDeduplication(dedupKey);
      if (isDuplicate) {
        return {
          eventId,
          success: true,
          timestamp,
          delivery,
          deduplicated: true,
        };
      }

      // 3. Create UnifiedEvent
      const event: UnifiedEvent = {
        id: eventId,
        type: payload.type,
        version: '1.0',
        timestamp: new Date(timestamp).toISOString(),
        tenantId: payload.tenantId,
        data: payload.data as Record<string, unknown>,
        metadata: {
          ...payload.metadata,
        },
      };

      // 4. Execute Before Hooks
      const beforeHooks = this.hookRegistry.getBeforeHooks(event.type);
      const context: EventHandlerContext = {
        env: {},
        tenantId: payload.tenantId,
      };

      const hookResult = await executeBeforeHooks(beforeHooks, event, context);

      // If denied by hook, return early
      if (!hookResult.continue) {
        return {
          eventId,
          success: false,
          timestamp,
          delivery,
          errors: [
            {
              target: 'handler',
              name:
                hookResult.hookResults?.[hookResult.hookResults.length - 1]?.hookId ?? 'unknown',
              error: hookResult.denyReason ?? 'Denied by hook',
              retryable: false,
            },
          ],
        };
      }

      // Merge annotations
      const execContext: ExecutionContext = {
        ...context,
        event,
        annotations: hookResult.annotations ?? {},
      };

      // 5. Set deduplication lock before processing
      await this.setDeduplication(
        dedupKey,
        options?.deduplicationTtlSeconds ?? this.options.deduplicationTtlSeconds
      );

      // 6. Parallel delivery to handlers and webhooks
      const [handlerResults, webhookResults] = await Promise.all([
        // Internal handlers
        options?.skipInternalHandlers
          ? { executed: 0, failed: 0, skipped: 0 }
          : this.executeHandlers(event, execContext, errors),

        // Webhook delivery
        options?.skipWebhooks
          ? { sent: 0, failed: 0, skipped: 0 }
          : this.deliverWebhooks(event, execContext, errors),
      ]);

      delivery.handlers = handlerResults;
      delivery.webhooks = webhookResults;

      // 7. Audit log (non-blocking)
      if (!options?.skipAuditLog && this.options.enableAuditLog) {
        try {
          await this.recordAuditLog(event, execContext);
          delivery.auditLog = true;
        } catch (error) {
          log.error('Audit log error', { eventId }, error as Error);
          // Non-blocking - don't add to errors
        }
      }

      // 8. Build result
      const success = errors.length === 0;
      const publishResult: EventPublishResult = {
        eventId,
        success,
        timestamp,
        delivery,
        errors: errors.length > 0 ? errors : undefined,
      };

      // 9. Execute After Hooks (fire-and-forget for async hooks)
      this.executeAfterHooks(event, execContext, publishResult).catch((error) => {
        log.error('After hook error', { eventId }, error as Error);
      });

      // 10. Return result
      return publishResult;
    } catch (error) {
      log.error('Publish error', { eventId }, error as Error);
      return {
        eventId,
        success: false,
        timestamp,
        delivery,
        errors: [
          {
            target: 'handler',
            name: 'dispatcher',
            error: error instanceof Error ? error.message : 'Unknown error',
            retryable: true,
          },
        ],
      };
    }
  }

  /**
   * Publish multiple events in a batch.
   */
  async publishBatch<T = Record<string, unknown>>(
    events: EventPublishPayload<T>[],
    options?: EventPublishOptions
  ): Promise<EventPublishResult[]> {
    // Process events concurrently
    return Promise.all(events.map((event) => this.publish(event, options)));
  }

  // ===========================================================================
  // Private Methods - Deduplication
  // ===========================================================================

  /**
   * Generate deduplication key with tenant isolation.
   */
  private getDedupKey(tenantId: string, key: string): string {
    return `${DEDUP_PREFIX}${tenantId}:${key}`;
  }

  /**
   * Check if event is duplicate.
   */
  private async checkDeduplication(key: string): Promise<boolean> {
    try {
      const value = await this.kv.get(key);
      return value !== null;
    } catch {
      // On error, allow processing (fail-open for dedup)
      return false;
    }
  }

  /**
   * Set deduplication lock.
   */
  private async setDeduplication(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.kv.put(key, Date.now().toString(), { expirationTtl: ttlSeconds });
    } catch (error) {
      log.error('Dedup set error', { key }, error as Error);
      // Non-fatal - continue processing
    }
  }

  // ===========================================================================
  // Private Methods - Handler Execution
  // ===========================================================================

  /**
   * Execute internal event handlers.
   */
  private async executeHandlers(
    event: UnifiedEvent,
    context: ExecutionContext,
    errors: EventDeliveryError[]
  ): Promise<{ executed: number; failed: number; skipped: number }> {
    const handlers = this.handlerRegistry.getHandlers(event.type);
    let executed = 0;
    let failed = 0;
    const skipped = 0;

    for (const handler of handlers) {
      try {
        await this.executeWithTimeout(handler.handler(event, context), handler.timeoutMs ?? 10000);
        executed++;
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : 'Handler failed';
        log.error('Handler failed', { handlerId: handler.id }, error as Error);

        // Only add to errors if handler doesn't just log
        if (handler.onError !== 'log') {
          errors.push({
            target: 'handler',
            name: handler.id,
            error: errorMessage,
            retryable: handler.onError === 'throw', // 'throw' indicates we want to propagate the error
          });
        }
      }
    }

    return { executed, failed, skipped };
  }

  // ===========================================================================
  // Private Methods - Webhook Delivery
  // ===========================================================================

  /**
   * Deliver event to webhooks.
   */
  private async deliverWebhooks(
    event: UnifiedEvent,
    context: ExecutionContext,
    errors: EventDeliveryError[]
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    // Find matching webhooks (tenant + optional client)
    const clientId = event.metadata?.actor?.type === 'client' ? event.metadata.actor.id : undefined;
    const webhooks = await this.webhookRegistry.findByEventType(
      event.tenantId,
      event.type,
      clientId
    );

    if (webhooks.length === 0) {
      return { sent: 0, failed: 0, skipped: 0 };
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    // Process in batches for concurrency control
    for (let i = 0; i < webhooks.length; i += this.options.maxConcurrentWebhooks) {
      const batch = webhooks.slice(i, i + this.options.maxConcurrentWebhooks);

      const results = await Promise.all(batch.map((webhook) => this.sendToWebhook(event, webhook)));

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const webhook = batch[j];

        if (result.success) {
          sent++;
          // Record success asynchronously
          this.webhookRegistry.recordSuccess(webhook.id, webhook.tenantId).catch(() => {});
        } else if (result.skipped) {
          skipped++;
        } else {
          failed++;
          // Record failure asynchronously
          this.webhookRegistry.recordFailure(webhook.id, webhook.tenantId).catch(() => {});

          errors.push({
            target: 'webhook',
            name: webhook.id,
            error: result.error ?? 'Webhook delivery failed',
            retryable: result.retryable ?? true,
            statusCode: result.statusCode,
          });
        }
      }
    }

    return { sent, failed, skipped };
  }

  /**
   * Send event to a single webhook.
   */
  private async sendToWebhook(
    event: UnifiedEvent,
    webhook: WebhookConfigWithScope
  ): Promise<{
    success: boolean;
    skipped?: boolean;
    error?: string;
    retryable?: boolean;
    statusCode?: number;
  }> {
    try {
      // Skip if no secret (can't sign)
      if (!webhook.secretEncrypted) {
        return { success: false, skipped: true };
      }

      // Decrypt secret
      const secret = await this.decryptSecret(webhook.secretEncrypted);

      // Build payload
      const payload = JSON.stringify({
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        tenantId: event.tenantId,
        data: event.data,
      });

      // Generate signature
      const signature = await generateWebhookSignature(payload, secret);

      // Send webhook
      const result = await sendWebhook({
        url: webhook.url,
        payload,
        signature,
        timeoutMs: webhook.timeoutMs,
        webhookId: webhook.id,
        customHeaders: webhook.headers,
      });

      return {
        success: result.success,
        error: result.error,
        retryable: result.retryable,
        statusCode: result.statusCode,
      };
    } catch (error) {
      log.error('Webhook error', { webhookId: webhook.id }, error as Error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: true,
      };
    }
  }

  // ===========================================================================
  // Private Methods - Hooks
  // ===========================================================================

  /**
   * Execute After Hooks.
   */
  private async executeAfterHooks(
    event: UnifiedEvent,
    context: ExecutionContext,
    result: EventPublishResult
  ): Promise<void> {
    const afterHooks = this.hookRegistry.getAfterHooks(event.type);

    // Separate sync and async hooks
    const syncHooks = afterHooks.filter((h) => !h.async);
    const asyncHooks = afterHooks.filter((h) => h.async);

    // Execute sync hooks sequentially
    for (const hook of syncHooks) {
      try {
        await this.executeWithTimeout(
          hook.handler(event, result, context),
          hook.timeoutMs ?? 30000
        );
      } catch (error) {
        log.error('After hook failed', { hookId: hook.id }, error as Error);
        if (!hook.continueOnError) {
          throw error;
        }
      }
    }

    // Fire async hooks without waiting
    for (const hook of asyncHooks) {
      hook.handler(event, result, context).catch((error) => {
        log.error('Async after hook failed', { hookId: hook.id }, error as Error);
      });
    }
  }

  // ===========================================================================
  // Private Methods - Audit Log
  // ===========================================================================

  /**
   * Record audit log entry.
   */
  private async recordAuditLog(event: UnifiedEvent, _context: ExecutionContext): Promise<void> {
    // Basic audit log insert
    // Production should use a dedicated audit log service
    await this.adapter.execute(
      `INSERT INTO audit_logs (id, tenant_id, event_type, event_id, actor_type, actor_id, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `al_${crypto.randomUUID().replace(/-/g, '')}`,
        event.tenantId,
        event.type,
        event.id,
        event.metadata?.actor?.type ?? null,
        event.metadata?.actor?.id ?? null,
        event.timestamp,
        JSON.stringify(event.data),
      ]
    );
  }

  // ===========================================================================
  // Private Methods - Utilities
  // ===========================================================================

  /**
   * Execute a promise with timeout.
   */
  private async executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Operation timed out')), timeoutMs);
      }),
    ]);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an EventDispatcher instance.
 *
 * @param config - Dispatcher configuration
 * @returns EventDispatcher instance
 *
 * @example
 * ```typescript
 * const dispatcher = createEventDispatcher({
 *   adapter: createDatabaseAdapter(env.CORE_DB),
 *   kv: env.EVENT_KV,
 *   webhookRegistry: createWebhookRegistry({ adapter }),
 *   handlerRegistry: createEventHandlerRegistry(),
 *   hookRegistry: createEventHookRegistry(),
 *   decryptSecret: async (encrypted) => decrypt(encrypted, key),
 * });
 *
 * // Publish an event
 * const result = await dispatcher.publish({
 *   type: 'auth.login.succeeded',
 *   tenantId: 'tenant_default',
 *   data: {
 *     userId: 'user_123',
 *     method: 'passkey',
 *   },
 * });
 *
 * console.log(`Event ${result.eventId} published`);
 * console.log(`Webhooks: ${result.delivery.webhooks.sent} sent`);
 * ```
 */
export function createEventDispatcher(config: EventDispatcherConfig): EventDispatcherImpl {
  return new EventDispatcherImpl(config);
}
