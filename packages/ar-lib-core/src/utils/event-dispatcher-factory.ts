/**
 * Event Dispatcher Factory
 *
 * Provides factory functions to create EventDispatcher instances from
 * various contexts (Hono, Workers, etc.).
 *
 * This simplifies event publishing by hiding the complexity of dependency
 * injection and configuration.
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type {
  EventPublishPayload,
  EventPublishOptions,
  EventPublishResult,
} from '../types/events/dispatcher';
import { ensureDatabaseAdapter, type DatabaseSource } from '../db';
import { EventDispatcherImpl, type EventDispatcherConfig } from '../services/event-dispatcher';
import { EventHandlerRegistryImpl } from '../services/event-handler-registry';
import { EventHookRegistryImpl } from '../services/event-hook-registry';
import { createWebhookRegistry } from '../services/webhook-registry';
import { resolveAuthCorePersistenceAdapterFromEnv } from '../services/auth-core-persistence-context';
import { resolveOptionalCoreAdapterFromHono } from '../context';
import { createAuditLog } from './audit-log';
import { decryptValue } from './pii-encryption';

// =============================================================================
// Types
// =============================================================================

/**
 * Simplified event publisher interface for use in handlers.
 */
export interface SimpleEventPublisher {
  /**
   * Publish an event.
   *
   * @param payload - Event payload
   * @param options - Publish options
   * @returns Publish result
   */
  publish<T = unknown>(
    payload: EventPublishPayload<T>,
    options?: EventPublishOptions
  ): Promise<EventPublishResult>;
}

/**
 * Factory options for creating event publisher.
 */
export interface EventPublisherFactoryOptions {
  /** Custom KV namespace for settings/deduplication */
  settingsKv?: KVNamespace;
  /** Custom database source */
  adapter?: DatabaseSource;
  /** Environment (for logging) */
  environment?: string;
  /** Enable webhook delivery */
  enableWebhooks?: boolean;
  /** Enable internal handlers */
  enableHandlers?: boolean;
  /** Enable audit logging */
  enableAuditLog?: boolean;
}

function extractAuditResourceType(eventType: string): string {
  const parts = eventType.split('.');
  return parts[0] || 'unknown';
}

function buildRuntimeAuditLogWriter(env: Env) {
  return async (event: {
    type: string;
    tenantId: string;
    data: Record<string, unknown>;
    metadata?: { actor?: { id?: string } };
  }) => {
    const resourceId =
      (typeof event.data.clientId === 'string' && event.data.clientId) ||
      (typeof event.data.userId === 'string' && event.data.userId) ||
      'event';

    await createAuditLog(env, {
      tenantId: event.tenantId,
      userId: event.metadata?.actor?.id ?? 'system',
      action: event.type,
      resource: extractAuditResourceType(event.type),
      resourceId,
      ipAddress: 'system',
      userAgent: 'event-dispatcher',
      metadata: JSON.stringify(event.data),
      severity: 'info',
    });
  };
}

// =============================================================================
// Global Registries (singleton pattern for handlers and hooks)
// =============================================================================

// Global event handler registry - shared across requests
let globalHandlerRegistry: EventHandlerRegistryImpl | null = null;

// Global hook registry - shared across requests
let globalHookRegistry: EventHookRegistryImpl | null = null;

/**
 * Get or create the global handler registry.
 */
export function getGlobalHandlerRegistry(): EventHandlerRegistryImpl {
  if (!globalHandlerRegistry) {
    globalHandlerRegistry = new EventHandlerRegistryImpl();
  }
  return globalHandlerRegistry;
}

/**
 * Get or create the global hook registry.
 */
export function getGlobalHookRegistry(): EventHookRegistryImpl {
  if (!globalHookRegistry) {
    globalHookRegistry = new EventHookRegistryImpl();
  }
  return globalHookRegistry;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an EventDispatcher from Hono context.
 *
 * This is the recommended way to create an EventDispatcher in request handlers.
 *
 * @example
 * ```typescript
 * import { createEventDispatcherFromContext } from '@authrim/ar-lib-core';
 *
 * export async function loginHandler(c: Context<{ Bindings: Env }>) {
 *   const dispatcher = await createEventDispatcherFromContext(c);
 *
 *   // ... login logic ...
 *
 *   await dispatcher.publish({
 *     type: 'auth.login.succeeded',
 *     tenantId,
 *     data: { userId, method: 'password' },
 *   });
 * }
 * ```
 *
 * @param c - Hono context
 * @param options - Factory options
 * @returns EventDispatcher instance
 */
export async function createEventDispatcherFromContext(
  c: Context<{ Bindings: Env }>,
  options?: EventPublisherFactoryOptions
): Promise<SimpleEventPublisher> {
  const env = c.env;
  const settingsKv = options?.settingsKv ?? env.SETTINGS;
  const adapter = options?.adapter
    ? ensureDatabaseAdapter(options.adapter, 'event-dispatcher')
    : resolveOptionalCoreAdapterFromHono(c, 'event-dispatcher');
  if (!adapter) {
    throw new Error('Core database is required for EventDispatcher');
  }
  const environment = options?.environment ?? env.ENVIRONMENT ?? 'production';

  // SETTINGS KV is required for event deduplication
  if (!settingsKv) {
    throw new Error(
      'SETTINGS KV namespace is required for EventDispatcher. Configure env.SETTINGS.'
    );
  }

  // Create webhook registry with PII decryption
  const webhookRegistry = createWebhookRegistry({
    adapter,
    encryptSecret: async (plaintext) => {
      // For registration, we encrypt the secret
      // Using simple base64 encoding as placeholder
      // Real implementation should use env.PII_ENCRYPTION_KEY
      return Buffer.from(plaintext).toString('base64');
    },
    allowLocalhostHttp: environment === 'development',
  });

  // Create secret decryptor for webhook sending
  const decryptSecret = async (encrypted: string): Promise<string> => {
    try {
      // Try to decrypt using PII encryption
      const piiKey = env.PII_ENCRYPTION_KEY;
      if (piiKey) {
        const result = await decryptValue(encrypted, piiKey);
        return result.decrypted ?? encrypted;
      }
      // Fallback: base64 decode
      return Buffer.from(encrypted, 'base64').toString('utf-8');
    } catch {
      // Fallback: return as-is (might be plaintext in dev)
      return encrypted;
    }
  };

  // Build config
  const config: EventDispatcherConfig = {
    adapter,
    kv: settingsKv,
    webhookRegistry,
    handlerRegistry: getGlobalHandlerRegistry(),
    hookRegistry: getGlobalHookRegistry(),
    decryptSecret,
    auditLogWriter: buildRuntimeAuditLogWriter(c.env),
    options: {
      environment,
      enableAuditLog: options?.enableAuditLog ?? true,
    },
  };

  // Create dispatcher
  const dispatcher = new EventDispatcherImpl(config);

  return dispatcher;
}

/**
 * Create an EventDispatcher from environment bindings.
 *
 * Use this when you don't have a Hono context (e.g., in Durable Objects).
 *
 * @param env - Environment bindings
 * @param options - Factory options
 * @returns EventDispatcher instance
 */
export async function createEventDispatcherFromEnv(
  env: Env,
  options?: EventPublisherFactoryOptions
): Promise<SimpleEventPublisher> {
  const settingsKv = options?.settingsKv ?? env.SETTINGS;
  const adapter = options?.adapter
    ? ensureDatabaseAdapter(options.adapter, 'event-dispatcher')
    : await resolveAuthCorePersistenceAdapterFromEnv(env, 'event-dispatcher');
  const environment = options?.environment ?? env.ENVIRONMENT ?? 'production';

  // SETTINGS KV is required for event deduplication
  if (!settingsKv) {
    throw new Error(
      'SETTINGS KV namespace is required for EventDispatcher. Configure env.SETTINGS.'
    );
  }

  // Create webhook registry
  const webhookRegistry = createWebhookRegistry({
    adapter,
    encryptSecret: async (plaintext) => {
      return Buffer.from(plaintext).toString('base64');
    },
    allowLocalhostHttp: environment === 'development',
  });

  // Create secret decryptor
  const decryptSecret = async (encrypted: string): Promise<string> => {
    try {
      const piiKey = env.PII_ENCRYPTION_KEY;
      if (piiKey) {
        const result = await decryptValue(encrypted, piiKey);
        return result.decrypted ?? encrypted;
      }
      return Buffer.from(encrypted, 'base64').toString('utf-8');
    } catch {
      return encrypted;
    }
  };

  // Build config
  const config: EventDispatcherConfig = {
    adapter,
    kv: settingsKv,
    webhookRegistry,
    handlerRegistry: getGlobalHandlerRegistry(),
    hookRegistry: getGlobalHookRegistry(),
    decryptSecret,
    auditLogWriter: buildRuntimeAuditLogWriter(env),
    options: {
      environment,
      enableAuditLog: options?.enableAuditLog ?? true,
    },
  };

  return new EventDispatcherImpl(config);
}

/**
 * Quick publish helper - creates dispatcher and publishes in one call.
 *
 * Use this for simple one-off events. For multiple events in one request,
 * prefer creating a dispatcher once and reusing it.
 *
 * @example
 * ```typescript
 * import { publishEvent } from '@authrim/ar-lib-core';
 *
 * await publishEvent(c, {
 *   type: 'auth.login.succeeded',
 *   tenantId: 'tenant-a',
 *   data: { userId: 'user123' },
 * });
 * ```
 *
 * @param c - Hono context
 * @param payload - Event payload
 * @param options - Publish options
 * @returns Publish result
 */
export async function publishEvent<T = unknown>(
  c: Context<{ Bindings: Env }>,
  payload: EventPublishPayload<T>,
  options?: EventPublishOptions
): Promise<EventPublishResult> {
  const dispatcher = await createEventDispatcherFromContext(c);
  return dispatcher.publish(payload, options);
}
